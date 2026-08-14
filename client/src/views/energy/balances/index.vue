<template>
  <ManagementPage title="能效平衡与优化" data-component-identifier="energy/balances/index">
    <template #title-extra>
      <HelpIcon
        label="查看能效平衡边界"
        content="平衡项目必须显式配置九类角色和来源。发电记录只有显式映射后才参与平衡；本地规则建议只供人工复核，不自动控制设备，也不自动修改预算、能耗或碳排台账。"
      />
    </template>

    <PageState
      v-if="!canView"
      description="当前账号没有查看能效平衡的权限。请联系管理员授予 energy:balance:view 权限；服务端仍会最终鉴权。"
    />

    <template v-else>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="本页面只读取显式来源并固化计算快照；建议采用本地确定性规则且必须人工复核，不会下发控制指令、改变设备状态或改写预算/台账。"
      />
      <el-alert
        v-if="contractError"
        type="warning"
        :closable="false"
        show-icon
        :title="`领域契约读取失败：${contractError}；页面已使用内置稳定标签，但写入仍以服务端校验为准。`"
      />

      <el-tabs v-model="activeTab" class="balance-tabs">
        <el-tab-pane label="边界与九角色项目" name="boundaries">
          <article v-if="canImportPreview" class="page-card balance-import-panel">
            <header class="section-heading">
              <div>
                <h2>平衡边界与九角色项目导入</h2>
                <small>仅接受包含“平衡边界”和“九角色项目”的 XLSX；模板不使用数据库自增 ID。</small>
              </div>
              <el-space wrap>
                <el-button @click="downloadEnergyBalanceImportTemplate">下载空白模板</el-button>
                <el-button @click="downloadEnergyBalanceDemoParkExample">下载青岚示例</el-button>
              </el-space>
            </header>
            <el-alert
              type="warning"
              :closable="false"
              show-icon
              title="导入不会自动执行平衡计算、不会自动生成优化建议，也不会修改能耗记录、发电记录、预算或碳排记录。"
            />
            <div class="balance-import-actions">
              <input ref="balanceImportFileInput" class="file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="selectBalanceImportFile">
              <el-button @click="chooseBalanceImportFile">选择 XLSX</el-button>
              <span class="muted-text">{{ balanceImportFile?.name || '尚未选择文件' }}</span>
              <el-button type="primary" :loading="balanceImportPreviewLoading" :disabled="!balanceImportFile" @click="previewBalanceImport">预演</el-button>
              <el-button v-if="canImportExecute" type="success" :disabled="!balanceImportExecutable" @click="openBalanceImportExecute">确认执行</el-button>
            </div>
            <el-alert v-if="balanceImportError" type="error" :closable="false" show-icon :title="balanceImportError" />
            <template v-if="balanceImportPreview">
              <dl class="definition-grid balance-import-summary">
                <div><dt>边界批次</dt><dd>#{{ balanceImportPreview.boundaryBatchId }}</dd></div>
                <div><dt>项目批次</dt><dd>#{{ balanceImportPreview.itemBatchId }}</dd></div>
                <div><dt>候选写入</dt><dd>{{ formatInteger(balanceImportPreview.summary?.wouldImport || 0) }}</dd></div>
                <div><dt>阻断</dt><dd>{{ formatInteger(balanceImportPreview.summary?.blocked || 0) }}</dd></div>
                <div><dt>跳过</dt><dd>{{ formatInteger(balanceImportPreview.summary?.skipped || 0) }}</dd></div>
                <div><dt>上传组</dt><dd class="digest-text">{{ balanceImportPreview.uploadGroupId }}</dd></div>
              </dl>
              <el-collapse>
                <el-collapse-item title="平衡边界预演明细" name="boundary-import-preview">
                  <el-table :data="balanceImportPreview.boundaryPreview?.items || []" size="small" max-height="280">
                    <el-table-column prop="sourceRowNumber" label="Excel 行" width="90" />
                    <el-table-column prop="status" label="结果" width="110" />
                    <el-table-column label="问题" min-width="360"><template #default="{ row }">{{ importIssueSummary(row.issues) }}</template></el-table-column>
                  </el-table>
                </el-collapse-item>
                <el-collapse-item title="九角色项目预演明细" name="item-import-preview">
                  <el-table :data="balanceImportPreview.itemPreview?.items || []" size="small" max-height="320">
                    <el-table-column prop="sourceRowNumber" label="Excel 行" width="90" />
                    <el-table-column prop="status" label="结果" width="110" />
                    <el-table-column label="问题" min-width="360"><template #default="{ row }">{{ importIssueSummary(row.issues) }}</template></el-table-column>
                  </el-table>
                </el-collapse-item>
              </el-collapse>
            </template>
          </article>

          <ManagementToolbar :loading="boundaryLoading" @search="applyBoundaryFilters" @reset="resetBoundaryFilters">
            <el-form-item label="组织单元">
              <el-select v-model="boundaryDraftFilters.organizationUnitId" clearable filterable placeholder="全部组织单元">
                <el-option v-for="unit in organizationUnits" :key="unit.id" :label="organizationLabel(unit)" :value="unit.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="boundaryDraftFilters.status" clearable placeholder="全部状态">
                <el-option label="启用" value="active" />
                <el-option label="停用" value="inactive" />
              </el-select>
            </el-form-item>
            <el-form-item label="字符搜索">
              <el-input v-model.trim="boundaryDraftFilters.keyword" clearable placeholder="边界编码或名称" />
            </el-form-item>
            <template #actions>
              <el-button v-if="canManage" type="primary" @click="openBoundaryCreate">新增平衡边界</el-button>
            </template>
          </ManagementToolbar>

          <el-alert v-if="boundaryError" type="error" :closable="false" show-icon :title="boundaryError" />
          <article class="page-card">
            <header class="section-heading">
              <div><h2>平衡边界列表</h2><small>停用优先，不物理删除；来源、版本、有效期和来源时区均保留追溯。</small></div>
              <span>共 {{ formatInteger(boundaryPagination.total) }} 条</span>
            </header>
            <PageState v-if="boundaryError && !boundaries.length" :error="boundaryError" @retry="loadBoundaries" />
            <PageState v-else-if="!boundaries.length && !boundaryLoading" description="暂无平衡边界；有管理权限时可新增首条边界。" />
            <template v-else>
              <div class="table-scroll">
                <el-table :data="boundaries" v-loading="boundaryLoading" stripe min-width="1120">
                  <el-table-column prop="boundaryCode" label="边界编码" min-width="130" show-overflow-tooltip />
                  <el-table-column prop="boundaryName" label="边界名称" min-width="150" show-overflow-tooltip />
                  <el-table-column label="组织单元" min-width="145"><template #default="{ row }">{{ row.organizationUnitName || '整体边界' }}</template></el-table-column>
                  <el-table-column prop="source" label="定义来源" min-width="150" show-overflow-tooltip />
                  <el-table-column prop="version" label="版本" width="105" />
                  <el-table-column prop="sourceTimeZone" label="来源时区" min-width="145" />
                  <el-table-column label="发电边界" width="115"><template #default="{ row }"><el-tag :type="row.generationBoundaryConfirmed ? 'success' : 'warning'" size="small">{{ row.generationBoundaryConfirmed ? '已人工确认' : '未确认' }}</el-tag></template></el-table-column>
                  <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
                  <el-table-column label="操作" min-width="250" fixed="right">
                    <template #default="{ row }">
                      <el-button link type="primary" @click="openBoundaryDetail(row)">项目与详情</el-button>
                      <el-button v-if="canManage" link type="primary" @click="openBoundaryEdit(row)">编辑</el-button>
                      <el-button v-if="canCalculate" link type="success" :disabled="row.status !== 'active'" @click="openCalculation(row)">计算快照</el-button>
                      <el-button v-if="canManage" link :type="row.status === 'active' ? 'warning' : 'success'" @click="confirmBoundaryStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
              <div class="pagination"><el-pagination v-model:current-page="boundaryPage" v-model:page-size="boundaryPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20, 50, 100]" :total="boundaryPagination.total || 0" @current-change="loadBoundaries" @size-change="changeBoundaryPageSize" /></div>
            </template>
          </article>
        </el-tab-pane>

        <el-tab-pane label="计算快照" name="snapshots">
          <ManagementToolbar :loading="snapshotLoading" @search="applySnapshotFilters" @reset="resetSnapshotFilters">
            <el-form-item label="平衡边界">
              <el-select v-model="snapshotDraftFilters.boundaryId" clearable filterable placeholder="全部边界">
                <el-option v-for="row in boundaries" :key="row.id" :label="`${row.boundaryName}（${row.boundaryCode}）`" :value="row.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="能源类型">
              <el-select v-model="snapshotDraftFilters.energyTypeId" clearable placeholder="全部能源类型">
                <el-option v-for="item in energyTypes" :key="item.id" :label="`${item.name}（${item.code}）`" :value="item.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="确认状态">
              <el-select v-model="snapshotDraftFilters.confirmationStatus" clearable placeholder="全部状态">
                <el-option v-for="status in suggestionStatuses" :key="status" :label="suggestionStatusLabel(status)" :value="status" />
              </el-select>
            </el-form-item>
            <el-form-item label="计算运行编号"><el-input v-model.trim="snapshotDraftFilters.calculationRunId" clearable placeholder="calculationRunId" /></el-form-item>
            <el-form-item label="内容指纹"><el-input v-model.trim="snapshotDraftFilters.sourceDataDigest" clearable placeholder="仅审计筛选，不作为分组键" /></el-form-item>
          </ManagementToolbar>

          <el-alert v-if="snapshotError" type="error" :closable="false" show-icon :title="snapshotError" />
          <article class="page-card">
            <header class="section-heading">
              <div><h2>快照运行列表</h2><small>严格按 calculationRunId 展示同一次运行；sourceDataDigest 只是内容指纹，绝不用于合并不同运行。</small></div>
              <span>当前查询共 {{ formatInteger(snapshotPagination.total) }} 次计算运行</span>
            </header>
            <PageState v-if="snapshotError && !snapshotRuns.length" :error="snapshotError" @retry="loadSnapshots" />
            <PageState v-else-if="!snapshotRuns.length && !snapshotLoading" description="暂无平衡快照；请从启用边界执行完整自然月计算。" />
            <template v-else>
              <div class="table-scroll">
                <el-table :data="snapshotRuns" v-loading="snapshotLoading" stripe>
                  <el-table-column prop="calculationRunId" label="计算运行编号" min-width="285" show-overflow-tooltip />
                  <el-table-column label="边界" min-width="150"><template #default="{ row }">{{ row.boundaryName || '—' }}</template></el-table-column>
                  <el-table-column label="统计期" min-width="230"><template #default="{ row }">{{ formatRange(row.dataRange) }}</template></el-table-column>
                  <el-table-column label="来源时区" min-width="145"><template #default="{ row }">{{ row.dataRange?.sourceTimeZone || '—' }}</template></el-table-column>
                  <el-table-column label="原单位分面" width="110"><template #default="{ row }">{{ row.facetCount }}</template></el-table-column>
                  <el-table-column label="质量状态" min-width="140"><template #default="{ row }"><el-tag :type="runAvailable(row) ? 'success' : 'warning'" size="small">{{ runAvailable(row) ? '可计算' : '含不可计算分面' }}</el-tag></template></el-table-column>
                  <el-table-column label="内容指纹" min-width="170"><template #default="{ row }"><span class="digest-text">{{ shortDigest(row.sourceDataDigest) }}</span><el-tag v-if="row.digestIntegrityWarning" type="danger" size="small">同运行指纹异常</el-tag></template></el-table-column>
                  <el-table-column label="操作" width="115" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openSnapshotRunDetail(row)">查看同次运行</el-button></template></el-table-column>
                </el-table>
              </div>
              <div class="pagination"><el-pagination v-model:current-page="snapshotPage" :page-size="snapshotPageSize" layout="total, prev, pager, next" :total="snapshotPagination.total || 0" @current-change="loadSnapshots" /></div>
            </template>
          </article>
        </el-tab-pane>

        <el-tab-pane label="优化建议" name="suggestions">
          <ManagementToolbar :loading="suggestionLoading" @search="applySuggestionFilters" @reset="resetSuggestionFilters">
            <el-form-item label="平衡边界"><el-select v-model="suggestionDraftFilters.boundaryId" clearable filterable placeholder="全部边界"><el-option v-for="row in boundaries" :key="row.id" :label="`${row.boundaryName}（${row.boundaryCode}）`" :value="row.id" /></el-select></el-form-item>
            <el-form-item label="计算运行编号"><el-input v-model.trim="suggestionDraftFilters.calculationRunId" clearable placeholder="calculationRunId" /></el-form-item>
            <el-form-item label="人工状态"><el-select v-model="suggestionDraftFilters.manualStatus" clearable placeholder="全部状态"><el-option v-for="status in suggestionStatuses" :key="status" :label="suggestionStatusLabel(status)" :value="status" /></el-select></el-form-item>
            <el-form-item label="优先级"><el-select v-model="suggestionDraftFilters.priority" clearable placeholder="全部优先级"><el-option label="高" value="high" /><el-option label="中" value="medium" /><el-option label="低" value="low" /></el-select></el-form-item>
          </ManagementToolbar>

          <el-alert v-if="suggestionError" type="error" :closable="false" show-icon :title="suggestionError" />
          <article class="page-card">
            <header class="section-heading">
              <div><h2>本地确定性建议</h2><small>展示规则编码、版本、阈值、证据和优先级；没有证据的预计节能量不会展示。</small></div>
              <span>共 {{ formatInteger(suggestionPagination.total) }} 条</span>
            </header>
            <PageState v-if="suggestionError && !suggestions.length" :error="suggestionError" @retry="loadSuggestions" />
            <PageState v-else-if="!suggestions.length && !suggestionLoading" description="当前筛选下暂无确定性优化建议。" />
            <template v-else>
              <div class="table-scroll">
                <el-table :data="suggestions" v-loading="suggestionLoading" stripe>
                  <el-table-column type="expand">
                    <template #default="{ row }">
                      <div class="suggestion-detail">
                        <dl class="definition-grid">
                          <div><dt>规则编码</dt><dd>{{ row.ruleCode }}</dd></div>
                          <div><dt>规则版本</dt><dd>{{ row.ruleVersion || '—' }}</dd></div>
                          <div><dt>公式版本</dt><dd>{{ row.formulaVersion || '—' }}</dd></div>
                          <div><dt>阈值</dt><dd>{{ thresholdSummary(row.threshold) }}</dd></div>
                          <div><dt>预计节能量</dt><dd>{{ savingDisclosure(row) }}</dd></div>
                          <div><dt>自动化边界</dt><dd>非 AI、无控制指令、不会修改设备/预算/台账、必须人工复核</dd></div>
                        </dl>
                        <h3>事实证据</h3>
                        <PageState v-if="!row.evidence?.length" description="该建议没有可展示证据，因此页面不展示预计节能量。" />
                        <el-table v-else :data="row.evidence" size="small">
                          <el-table-column label="运行 / 快照" min-width="210"><template #default="{ row: evidence }">{{ evidence.calculationRunId || '—' }} / #{{ evidence.snapshotId || '—' }}</template></el-table-column>
                          <el-table-column label="能源 / 单位" min-width="130"><template #default="{ row: evidence }">{{ evidence.energyTypeCode || '—' }} / {{ evidence.originalUnit || '—' }}</template></el-table-column>
                          <el-table-column label="实际值" min-width="100"><template #default="{ row: evidence }">{{ formatNumber(evidence.actualValue) }}</template></el-table-column>
                          <el-table-column label="覆盖率" min-width="100"><template #default="{ row: evidence }">{{ formatPercent(evidence.completenessRate) }}</template></el-table-column>
                          <el-table-column label="数据范围" min-width="230"><template #default="{ row: evidence }">{{ evidence.startUtc || '—' }} 至 {{ evidence.endUtc || '—' }}</template></el-table-column>
                        </el-table>
                      </div>
                    </template>
                  </el-table-column>
                  <el-table-column prop="title" label="建议" min-width="180" show-overflow-tooltip />
                  <el-table-column prop="content" label="建议内容" min-width="280" show-overflow-tooltip />
                  <el-table-column label="规则" min-width="190"><template #default="{ row }">{{ row.ruleCode }}<br><span class="muted-text">{{ row.ruleVersion || '—' }}</span></template></el-table-column>
                  <el-table-column label="优先级" width="90"><template #default="{ row }"><el-tag :type="priorityType(row.priority)" size="small">{{ priorityLabel(row.priority) }}</el-tag></template></el-table-column>
                  <el-table-column label="人工状态" width="105"><template #default="{ row }"><el-tag :type="suggestionStatusType(row.manualStatus)" size="small">{{ suggestionStatusLabel(row.manualStatus) }}</el-tag></template></el-table-column>
                  <el-table-column label="操作" min-width="180" fixed="right">
                    <template #default="{ row }">
                      <template v-if="canReviewSuggestions">
                        <el-button v-for="target in reviewTargets(row.manualStatus)" :key="target" link :type="target === 'accepted' ? 'success' : target === 'rejected' ? 'danger' : 'primary'" @click="openSuggestionReview(row, target)">{{ reviewActionLabel(target) }}</el-button>
                        <span v-if="!reviewTargets(row.manualStatus).length" class="muted-text">终态，只读</span>
                      </template>
                      <span v-else class="muted-text">无复核权限</span>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
              <div class="pagination"><el-pagination v-model:current-page="suggestionPage" v-model:page-size="suggestionPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20, 50, 100]" :total="suggestionPagination.total || 0" @current-change="loadSuggestions" @size-change="changeSuggestionPageSize" /></div>
            </template>
          </article>
        </el-tab-pane>
      </el-tabs>

      <ManagementDrawer v-model="boundaryDrawerOpen" :title="boundaryEditingId ? '编辑平衡边界' : '新增平衡边界'" :loading="boundarySaving" :confirm-disabled="boundarySaving" @save="saveBoundary">
        <el-alert v-if="boundaryFormError" type="error" :closable="false" show-icon :title="boundaryFormError" class="drawer-alert" />
        <el-form ref="boundaryFormRef" :model="boundaryForm" :rules="boundaryRules" label-position="top">
          <el-form-item label="边界编码" prop="boundaryCode"><el-input v-model.trim="boundaryForm.boundaryCode" maxlength="100" show-word-limit /></el-form-item>
          <el-form-item label="边界名称" prop="boundaryName"><el-input v-model.trim="boundaryForm.boundaryName" maxlength="200" show-word-limit /></el-form-item>
          <el-form-item label="组织单元"><el-select v-model="boundaryForm.organizationUnitId" clearable filterable class="full-control" placeholder="留空表示整体边界"><el-option v-for="unit in activeOrganizationUnits" :key="unit.id" :label="organizationLabel(unit)" :value="unit.id" /></el-select></el-form-item>
          <el-form-item label="定义来源" prop="source"><HelpIcon label="查看定义来源说明" content="填写边界定义依据、文件或人工维护来源，不能用系统推测代替显式边界。" /><el-input v-model.trim="boundaryForm.source" maxlength="200" /></el-form-item>
          <el-form-item label="文号"><el-input v-model.trim="boundaryForm.documentNo" maxlength="200" /></el-form-item>
          <el-form-item label="版本" prop="version"><el-input v-model.trim="boundaryForm.version" maxlength="100" placeholder="如 balance-boundary:v1" /></el-form-item>
          <el-form-item label="有效期开始（严格 UTC）" prop="effectiveStartUtc"><StrictUtcDateTimeInput v-model="boundaryForm.effectiveStartUtc" placeholder="2026-01-01T00:00:00Z" /></el-form-item>
          <el-form-item label="有效期结束（严格 UTC）" prop="effectiveEndUtc"><StrictUtcDateTimeInput v-model="boundaryForm.effectiveEndUtc" placeholder="2027-01-01T00:00:00Z" /></el-form-item>
          <el-form-item label="来源时区" prop="sourceTimeZone"><HelpIcon label="查看来源时区说明" content="选择 IANA 时区，如 Asia/Shanghai。月度能耗和发电来源按该时区校验完整自然月。" /><IanaTimeZoneSelect v-model="boundaryForm.sourceTimeZone" placeholder="请选择或搜索来源时区" /></el-form-item>
          <el-form-item><el-checkbox v-model="boundaryForm.generationBoundaryConfirmed">已人工确认发电边界和防重复计入口径</el-checkbox></el-form-item>
        </el-form>
      </ManagementDrawer>

      <el-drawer v-model="boundaryDetailOpen" title="平衡边界详情与九角色项目" size="78%" destroy-on-close>
        <PageState v-if="boundaryDetailLoading" loading />
        <PageState v-else-if="boundaryDetailError" :error="boundaryDetailError" @retry="reloadBoundaryDetail" />
        <template v-else-if="boundaryDetail">
          <dl class="definition-grid detail-grid">
            <div><dt>边界</dt><dd>{{ boundaryDetail.boundaryName }}（{{ boundaryDetail.boundaryCode }}）</dd></div>
            <div><dt>组织范围</dt><dd>{{ boundaryDetail.organizationUnitName || '整体边界' }}</dd></div>
            <div><dt>来源 / 文号</dt><dd>{{ boundaryDetail.source }} / {{ boundaryDetail.documentNo || '无文号' }}</dd></div>
            <div><dt>版本 / 时区</dt><dd>{{ boundaryDetail.version }} / {{ boundaryDetail.sourceTimeZone }}</dd></div>
            <div><dt>有效期</dt><dd>{{ boundaryDetail.effectiveStartUtc }} 至 {{ boundaryDetail.effectiveEndUtc }}</dd></div>
            <div><dt>发电边界</dt><dd>{{ boundaryDetail.generationBoundaryConfirmed ? '已人工确认' : '未确认；发电分面将冻结' }}</dd></div>
          </dl>
          <el-alert type="warning" :closable="false" show-icon title="发电记录不会自动抵扣能耗。generation 来源只能显式映射 self_generation 的 self_use_value_kwh，或 output 的 grid_export_value_kwh，并要求防重复计入键。" />
          <header class="section-heading item-heading"><div><h2>九角色项目</h2><small>项目来源必须显式指向记录 ID、来源标识或人工值。</small></div><el-button v-if="canManage" type="primary" @click="openItemCreate">新增平衡项目</el-button></header>
          <ManagementToolbar :loading="itemLoading" @search="applyItemFilters" @reset="resetItemFilters">
            <el-form-item label="角色"><el-select v-model="itemDraftFilters.role" clearable placeholder="全部九角色"><el-option v-for="role in roleDefinitions" :key="role.value" :label="role.label" :value="role.value" /></el-select></el-form-item>
            <el-form-item label="状态"><el-select v-model="itemDraftFilters.status" clearable placeholder="全部状态"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
          </ManagementToolbar>
          <el-alert v-if="itemError" type="error" :closable="false" show-icon :title="itemError" />
          <PageState v-if="!balanceItems.length && !itemLoading" description="该边界暂无平衡项目；至少维护一条启用项目后才能计算。" />
          <div v-else class="table-scroll">
            <el-table :data="balanceItems" v-loading="itemLoading" stripe>
              <el-table-column prop="itemCode" label="项目编码" min-width="120" />
              <el-table-column prop="itemName" label="项目名称" min-width="150" />
              <el-table-column label="角色" min-width="145"><template #default="{ row }">{{ roleLabel(row.role) }}</template></el-table-column>
              <el-table-column label="能源 / 原单位" min-width="135"><template #default="{ row }">{{ row.energyType?.name || row.energyType?.code }} / {{ row.originalUnit }}</template></el-table-column>
              <el-table-column label="显式来源" min-width="250"><template #default="{ row }"><strong>{{ sourceTypeLabel(row.sourceType) }}</strong><br><span class="muted-text">{{ sourceMappingSummary(row.sourceMapping) }}</span></template></el-table-column>
              <el-table-column label="防重复计入键" min-width="150"><template #default="{ row }">{{ row.generationAntiDoubleCountKey || '—' }}</template></el-table-column>
              <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
              <el-table-column label="操作" min-width="145" fixed="right"><template #default="{ row }"><el-button v-if="canManage" link type="primary" @click="openItemEdit(row)">编辑</el-button><el-button v-if="canManage" link :type="row.status === 'active' ? 'warning' : 'success'" @click="confirmItemStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
            </el-table>
          </div>
          <div class="pagination"><el-pagination v-model:current-page="itemPage" v-model:page-size="itemPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[50, 100, 200]" :total="itemPagination.total || 0" @current-change="loadItems" @size-change="changeItemPageSize" /></div>
        </template>
      </el-drawer>

      <el-dialog v-model="itemDialogOpen" :title="itemEditingId ? '编辑平衡项目' : '新增平衡项目'" width="min(720px, 94vw)" destroy-on-close>
        <el-alert v-if="itemFormError" type="error" :closable="false" show-icon :title="itemFormError" class="drawer-alert" />
        <el-alert v-if="!activeEnergyTypes.length" type="warning" :closable="false" show-icon title="暂无 active 能源类型，请先维护能源类型字典。" class="drawer-alert" />
        <el-form ref="itemFormRef" :model="itemForm" :rules="itemRules" label-position="top">
          <div class="form-grid"><el-form-item label="项目编码" prop="itemCode"><el-input v-model.trim="itemForm.itemCode" maxlength="100" /></el-form-item><el-form-item label="项目名称" prop="itemName"><el-input v-model.trim="itemForm.itemName" maxlength="200" /></el-form-item></div>
          <div class="form-grid"><el-form-item label="来源类型" prop="sourceType"><el-select v-model="itemForm.sourceType" class="full-control" @change="handleItemSourceTypeChange"><el-option v-for="source in sourceTypeDefinitions" :key="source.value" :label="source.label" :value="source.value" /></el-select></el-form-item><el-form-item label="九角色" prop="role"><el-select v-model="itemForm.role" class="full-control"><el-option v-for="role in availableRoleDefinitions" :key="role.value" :label="role.label" :value="role.value" /></el-select></el-form-item></div>
          <div class="form-grid"><el-form-item label="能源类型" prop="energyTypeId"><el-select v-model="itemForm.energyTypeId" filterable class="full-control"><el-option v-for="item in activeEnergyTypes" :key="item.id" :label="`${item.name}（${item.code}）`" :value="item.id" /></el-select></el-form-item><el-form-item label="原单位" prop="originalUnit"><el-input v-model.trim="itemForm.originalUnit" maxlength="50" placeholder="须与能源类型兼容" /></el-form-item></div>
          <el-form-item label="来源说明" prop="sourceMappingReference"><HelpIcon label="查看来源说明" content="填写可审计的来源文件、台账、边或人工依据。技术记录 ID 不替代业务来源说明。" /><el-input v-model.trim="itemForm.sourceMappingReference" maxlength="300" /></el-form-item>
          <el-form-item v-if="itemForm.sourceType !== 'explicit_balance_value'" label="来源记录 ID"><el-input v-model.trim="itemForm.sourceRecordIds" placeholder="逗号分隔正整数，如 12, 15, 18" /></el-form-item>
          <el-form-item v-if="itemForm.sourceType === 'timeseries'" label="时序来源标识（可替代记录 ID）"><el-input v-model.trim="itemForm.timeseriesSourceReference" placeholder="source_reference" /></el-form-item>
          <el-form-item v-if="itemForm.sourceType === 'explicit_balance_value'" label="默认显式值"><el-input-number v-model="itemForm.explicitValue" :min="0" :precision="4" class="full-control" /></el-form-item>
          <template v-if="itemForm.sourceType === 'generation'">
            <el-alert type="info" :closable="false" show-icon :title="itemForm.role === 'self_generation' ? '将只读取 self_use_value_kwh（自用量）。' : '将只读取 grid_export_value_kwh（上网量）。'" class="drawer-alert" />
            <el-form-item label="发电防重复计入键" prop="generationAntiDoubleCountKey"><el-input v-model.trim="itemForm.generationAntiDoubleCountKey" maxlength="200" placeholder="同边界内必须唯一" /></el-form-item>
          </template>
        </el-form>
        <template #footer><el-button @click="itemDialogOpen=false">取消</el-button><el-button type="primary" :loading="itemSaving" :disabled="!activeEnergyTypes.length" @click="saveItem">保存</el-button></template>
      </el-dialog>

      <ManagementDrawer v-model="calculationDrawerOpen" title="计算并固化平衡快照" confirm-label="确认计算" :loading="calculationLoading" :confirm-disabled="!calculationWindow.valid || calculationLoading || !calculationItems.length" @save="calculateSnapshots">
        <el-alert v-if="calculationError" type="error" :closable="false" show-icon :title="calculationError" class="drawer-alert" />
        <el-alert type="warning" :closable="false" show-icon title="计算会固化同一 calculationRunId 下的原单位分面、kgce/tce 综合结果和确定性建议；不会改写预算、能耗台账或控制设备。" class="drawer-alert" />
        <el-form label-position="top">
          <el-form-item label="平衡边界"><el-input :model-value="calculationBoundaryLabel" disabled /></el-form-item>
          <el-form-item label="来源时区"><el-input :model-value="calculationBoundary?.sourceTimeZone || '—'" disabled /></el-form-item>
          <el-form-item label="完整自然月统计期"><el-date-picker v-model="calculationForm.monthRange" type="monthrange" value-format="YYYY-MM" format="YYYY-MM" :editable="true" unlink-panels start-placeholder="开始月份" end-placeholder="结束月份" class="full-control" /></el-form-item>
          <el-alert :type="calculationWindow.valid ? 'success' : 'warning'" :closable="false" show-icon :title="calculationWindow.valid ? `将提交 UTC 左闭右开窗口：${calculationWindow.startUtc} 至 ${calculationWindow.endUtc}` : calculationWindow.message" class="drawer-alert" />
          <template v-if="calculationExplicitItems.length">
            <h3 class="drawer-subtitle">人工显式值覆盖</h3>
            <p class="muted-text">仅 explicit_balance_value 项目可在本次运行覆盖默认值；留空时使用项目来源映射中的默认值。</p>
            <el-form-item v-for="item in calculationExplicitItems" :key="item.id" :label="`${item.itemName}（${roleLabel(item.role)}，${item.originalUnit}）`"><el-input-number v-model="calculationForm.explicitValues[item.id]" :min="0" :precision="4" class="full-control" /></el-form-item>
          </template>
        </el-form>
      </ManagementDrawer>

      <el-drawer v-model="snapshotDetailOpen" title="同一次平衡计算详情" size="88%" destroy-on-close>
        <PageState v-if="snapshotDetailLoading" loading />
        <PageState v-else-if="snapshotDetailError" :error="snapshotDetailError" @retry="reloadSnapshotDetail" />
        <template v-else-if="snapshotDetail">
          <el-alert type="info" :closable="false" show-icon :title="`本详情严格归属 calculationRunId：${snapshotDetail.calculationRunId}。内容指纹 ${shortDigest(snapshotDetail.sourceDataDigest)} 仅用于审计。`" />
          <div class="snapshot-selector"><span>选择原单位分面</span><el-select v-model="selectedSnapshotId" @change="selectSnapshotFacet"><el-option v-for="facet in snapshotDetail.calculationGroup?.facets || []" :key="facet.id" :label="`${facet.energyType?.name || facet.energyType?.code} / ${facet.originalUnit}（#${facet.id}）`" :value="facet.id" /></el-select></div>
          <section class="stat-grid" aria-label="当前原单位分面指标">
            <StatCard label="输入 / 输出" :value="`${formatNumber(snapshotDetail.inputTotalOriginal)} / ${formatNumber(snapshotDetail.outputTotalOriginal)} ${snapshotDetail.originalUnit}`" note="原单位分面，不跨单位相加" />
            <StatCard label="储能变化" :value="`${formatNumber(snapshotDetail.storageChangeOriginal)} ${snapshotDetail.originalUnit}`" note="库存增加减库存减少" />
            <StatCard label="不可解释差额" :value="`${formatNumber(snapshotDetail.unexplainedOriginal)} ${snapshotDetail.originalUnit}`" note="不会自动认定为损耗" />
            <StatCard label="覆盖率" :value="formatPercent(snapshotDetail.completenessRate)" note="来源统计期覆盖" />
            <StatCard label="不平衡率" :value="formatPercent(snapshotDetail.imbalanceRate)" note="不可计算时显示 —" />
            <StatCard label="利用率" :value="formatPercent(snapshotDetail.utilizationRate)" note="有冻结原因时不计算" />
            <StatCard label="损耗率" :value="formatPercent(snapshotDetail.lossRate)" note="仅使用已知损耗角色" />
            <StatCard label="质量状态" :value="snapshotDetail.calculationStatus === 'available' ? '可计算' : '已冻结'" :note="snapshotDetail.reasonCodes?.length ? '请查看不可计算原因' : '无冻结原因'" />
          </section>

          <article class="page-card chart-panel">
            <header class="section-heading"><div><h2>原单位 / 折标平衡发散图</h2><small>单轴对比并提供同源表格；不使用双轴。</small></div><el-radio-group v-model="facetUnitMode" size="small"><el-radio-button label="original">原单位</el-radio-button><el-radio-button label="kgce">kgce</el-radio-button><el-radio-button label="tce">tce</el-radio-button></el-radio-group></header>
            <BalanceDivergingChart :rows="facetChartRows" />
            <el-alert v-if="snapshotDetail.reasonCodes?.length" type="warning" :closable="false" show-icon class="reason-alert"><template #title><strong>不可计算原因：</strong><span v-for="code in snapshotDetail.reasonCodes" :key="code" class="reason-chip">{{ reasonLabel(code) }}（{{ code }}）</span></template></el-alert>
          </article>

          <article class="page-card chart-panel">
            <header class="section-heading"><div><h2>同次运行综合 kgce / tce</h2><small>综合结果由同一 calculationRunId 的全部快照项目重建，不按 digest 混合。</small></div><el-radio-group v-model="comprehensiveUnitMode" size="small"><el-radio-button label="kgce">kgce</el-radio-button><el-radio-button label="tce">tce</el-radio-button></el-radio-group></header>
            <BalanceDivergingChart :rows="comprehensiveChartRows" />
            <dl class="definition-grid rate-grid"><div><dt>综合不平衡率</dt><dd>{{ formatPercent(comprehensiveResult.imbalanceRate) }}</dd></div><div><dt>综合利用率</dt><dd>{{ formatPercent(comprehensiveResult.utilizationRate) }}</dd></div><div><dt>综合损耗率</dt><dd>{{ formatPercent(comprehensiveResult.lossRate) }}</dd></div><div><dt>综合覆盖率</dt><dd>{{ formatPercent(comprehensiveResult.completenessRate) }}</dd></div></dl>
            <el-alert v-if="comprehensiveResult.reasonCodes?.length" type="warning" :closable="false" show-icon class="reason-alert"><template #title><strong>综合折标不可计算：</strong><span v-for="code in comprehensiveResult.reasonCodes" :key="code" class="reason-chip">{{ reasonLabel(code) }}（{{ code }}）</span></template></el-alert>
          </article>

          <article class="page-card">
            <header class="section-heading"><div><h2>当前分面项目追溯</h2><small>保留角色、原值、折标值、实际系数版本、来源快照和原因码。</small></div></header>
            <div class="table-scroll"><el-table :data="snapshotDetail.items || []" stripe><el-table-column prop="itemCode" label="项目编码" min-width="120" /><el-table-column prop="itemName" label="项目名称" min-width="150" /><el-table-column label="角色" min-width="140"><template #default="{ row }">{{ roleLabel(row.role) }}</template></el-table-column><el-table-column label="原值" min-width="125"><template #default="{ row }">{{ formatNumber(row.originalValue) }} {{ row.originalUnit }}</template></el-table-column><el-table-column label="折标" min-width="145"><template #default="{ row }">{{ formatNumber(row.kgceValue) }} kgce / {{ formatNumber(row.tceValue) }} tce</template></el-table-column><el-table-column label="实际系数" min-width="150"><template #default="{ row }">{{ row.actualFactorValue ?? '—' }} / {{ row.actualFactorVersion || '—' }}</template></el-table-column><el-table-column label="显式来源快照" min-width="260"><template #default="{ row }">{{ sourceMappingSummary(row.sourceMapping) }}</template></el-table-column><el-table-column label="原因" min-width="220"><template #default="{ row }">{{ row.reasonCodes?.length ? row.reasonCodes.map(reasonLabel).join('；') : '无' }}</template></el-table-column></el-table></div>
          </article>
        </template>
      </el-drawer>

      <el-dialog v-model="balanceImportExecuteOpen" title="执行平衡配置导入" width="min(620px, 94vw)" destroy-on-close>
        <el-alert type="warning" :closable="false" show-icon title="执行前服务端会重读原 XLSX、按当前数据库重新解析来源并复核 stale；任一边界或项目失败都会整体回滚。" />
        <el-form label-position="top" class="balance-import-confirm-form">
          <el-form-item :label="`请输入固定确认文本：${ENERGY_BALANCE_IMPORT_CONFIRM_TEXT}`">
            <el-input v-model="balanceImportConfirmText" autocomplete="off" />
          </el-form-item>
        </el-form>
        <el-alert v-if="balanceImportExecuteError" type="error" :closable="false" show-icon :title="balanceImportExecuteError" />
        <template #footer>
          <el-button @click="balanceImportExecuteOpen=false">取消</el-button>
          <el-button type="primary" :loading="balanceImportExecuteLoading" :disabled="balanceImportConfirmText !== ENERGY_BALANCE_IMPORT_CONFIRM_TEXT || !balanceImportExecutable" @click="executeBalanceImport">创建备份并原子导入</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="suggestionReviewOpen" :title="reviewActionLabel(suggestionReviewForm.targetStatus)" width="min(540px, 92vw)" destroy-on-close>
        <el-alert type="info" :closable="false" show-icon :title="`仅更新建议人工状态，不触发自动执行。当前：${suggestionStatusLabel(suggestionReviewRow?.manualStatus)}；目标：${suggestionStatusLabel(suggestionReviewForm.targetStatus)}。`" class="drawer-alert" />
        <el-form label-position="top"><el-form-item :label="reviewNoteRequired ? '复核备注（必填）' : '复核备注（可选）'"><el-input v-model="suggestionReviewForm.reviewNote" type="textarea" :rows="4" maxlength="1000" show-word-limit /></el-form-item></el-form>
        <el-alert v-if="suggestionReviewError" type="error" :closable="false" show-icon :title="suggestionReviewError" />
        <template #footer><el-button @click="suggestionReviewOpen=false">取消</el-button><el-button type="primary" :loading="suggestionReviewLoading" @click="submitSuggestionReview">确认人工复核</el-button></template>
      </el-dialog>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
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
import BalanceDivergingChart from './BalanceDivergingChart.vue';
import { getEnergyTypes } from '@/api/energy';
import { ledgerApi } from '@/api/ledger';
import {
  calculateEnergyBalanceSnapshots,
  createEnergyBalanceBoundary,
  createEnergyBalanceItem,
  downloadEnergyBalanceDemoParkExample,
  downloadEnergyBalanceImportTemplate,
  executeEnergyBalanceBundleImport,
  getEnergyBalanceBoundaries,
  getEnergyBalanceBoundary,
  getEnergyBalanceContract,
  getEnergyBalanceItems,
  getEnergyBalanceSnapshot,
  getEnergyBalanceSnapshotRun,
  getEnergyBalanceSnapshotRuns,
  getEnergyBalanceSuggestions,
  previewEnergyBalanceBundleImport,
  updateEnergyBalanceBoundary,
  updateEnergyBalanceBoundaryStatus,
  updateEnergyBalanceItem,
  updateEnergyBalanceItemStatus,
  updateEnergyBalanceSuggestionStatus
} from '@/api/energyBalances';
import {
  BALANCE_ROLE_DEFINITIONS,
  BALANCE_SOURCE_TYPE_DEFINITIONS,
  ENERGY_BALANCE_IMPORT_CONFIRM_TEXT,
  ENERGY_BALANCE_PERMISSIONS,
  SUGGESTION_STATUS_LABELS,
  balanceReasonLabel,
  balanceRoleLabel,
  balanceSourceMappingSummary,
  balanceSourceTypeLabel,
  buildBalanceChartRows,
  buildBalanceItemPayload,
  buildBoundaryFilters,
  buildEnergyBalanceBundleExecutePayload,
  canExecuteEnergyBalanceBundleImport,
  buildFullMonthCalculationWindow,
  buildItemFilters,
  buildSnapshotFilters,
  buildSuggestionFilters,
  createLatestEnergyBalanceRequestGuard,
  formatEnergyBalanceRequestError,
  freezeEnergyBalanceRequestSnapshot,
  loadAllEnergyBalanceItems,
  normalizeEnergyBalanceBoundaryUtcFields,
  suggestionReviewTargets,
  validateSuggestionReview
} from '@/utils/energyBalanceManagement';
import { parseStrictUtcDateTime } from '@/utils/dateTimeFields';
import { isIanaTimeZone } from '@/utils/ianaTimeZones';
import { hasPermi } from '@/utils/permission';

/** 动态路由待接入的稳定组件标识。 */
const COMPONENT_IDENTIFIER = 'energy/balances/index';
/** 页面当前业务标签页。 */
const activeTab = ref('boundaries');
/** 捕获异步请求并保持页面局部错误可见。 */
const safeRequest = async (task) => { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } };

/** 前端按钮可见性权限，服务端仍是最终授权边界。 */
const canView = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.view));
const canManage = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.manage));
const canCalculate = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.calculate));
const canReviewSuggestions = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.suggestionReview));
const canImportPreview = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.importPreview));
const canImportExecute = computed(() => hasPermi(ENERGY_BALANCE_PERMISSIONS.importExecute));

/** 服务端契约、能源类型与组织字典状态。 */
const contract = ref(null);
const contractError = ref('');
const energyTypes = ref([]);
const organizationUnits = ref([]);
/** 九角色定义优先使用服务端角色白名单并复用稳定中文标签。 */
const roleDefinitions = computed(() => {
  const allowedRoles = contract.value?.roles || BALANCE_ROLE_DEFINITIONS.map((item) => item.value);
  return allowedRoles.map((role) => BALANCE_ROLE_DEFINITIONS.find((item) => item.value === role) || { value: role, label: role });
});
/** 来源类型定义优先使用服务端来源白名单。 */
const sourceTypeDefinitions = computed(() => {
  const allowedSources = contract.value?.sourceTypes || BALANCE_SOURCE_TYPE_DEFINITIONS.map((item) => item.value);
  return allowedSources.map((sourceType) => BALANCE_SOURCE_TYPE_DEFINITIONS.find((item) => item.value === sourceType) || { value: sourceType, label: sourceType });
});
/** 仅允许选择 active 能源类型。 */
const activeEnergyTypes = computed(() => energyTypes.value.filter((item) => Number(item.isActive ?? item.active) === 1 || item.isActive === true || item.active === true));
/** 仅允许选择 active 组织单元。 */
const activeOrganizationUnits = computed(() => organizationUnits.value.filter((item) => item.status === 'active'));
/** 建议状态列表。 */
const suggestionStatuses = Object.freeze(['unconfirmed', 'accepted', 'rejected', 'resolved']);

/** 边界列表筛选、分页和加载状态。 */
const emptyBoundaryFilters = () => ({ organizationUnitId: '', status: '', keyword: '' });
const boundaryDraftFilters = ref(emptyBoundaryFilters());
const boundaryAppliedFilters = ref(emptyBoundaryFilters());
const boundaries = ref([]);
const boundaryPage = ref(1);
const boundaryPageSize = ref(20);
const boundaryPagination = ref({ total: 0 });
const boundaryLoading = ref(false);
const boundaryError = ref('');

/** 平衡双批次导入状态模块。 */
const balanceImportFileInput = ref(null);
const balanceImportFile = ref(null);
const balanceImportPreview = ref(null);
const balanceImportPreviewLoading = ref(false);
const balanceImportError = ref('');
const balanceImportExecuteOpen = ref(false);
const balanceImportConfirmText = ref('');
const balanceImportExecuteLoading = ref(false);
const balanceImportExecuteError = ref('');
/** 只有当前有效服务端预演且具备执行权限时才允许进入 execute。 */
const balanceImportExecutable = computed(() => canImportExecute.value
  && canExecuteEnergyBalanceBundleImport(balanceImportPreview.value));

/** 边界新增修改抽屉状态。 */
const emptyBoundaryForm = () => ({ boundaryCode: '', boundaryName: '', organizationUnitId: null, source: '', documentNo: '', version: 'energy-balance-boundary:v1', effectiveStartUtc: '', effectiveEndUtc: '', sourceTimeZone: '', generationBoundaryConfirmed: false });
const boundaryDrawerOpen = ref(false);
const boundaryEditingId = ref(null);
const boundaryForm = ref(emptyBoundaryForm());
const boundaryFormRef = ref();
const boundarySaving = ref(false);
const boundaryFormError = ref('');
/** 边界 UTC 回显诊断：非法原文仅保留在错误文本，不进入可提交表单字段。 */
const boundaryUtcDiagnostic = ref('');
/** 校验边界严格 UTC 字段，拒绝隐藏的非零毫秒或非法日历日期。 */
const strictBoundaryUtcRule = (label) => ({
  validator: (_rule, value, callback) => {
    if (value === '' || value === null || value === undefined) return callback();
    const result = parseStrictUtcDateTime(value);
    return result.valid ? callback() : callback(new Error(`${label}：${result.message}`));
  },
  trigger: ['change', 'blur']
});
/** 校验边界来源时区同时符合 IANA 形态并可由当前 Intl 运行时识别。 */
const boundaryIanaTimeZoneRule = {
  validator: (_rule, value, callback) => isIanaTimeZone(String(value || '').trim())
    ? callback()
    : callback(new Error('请选择当前运行时可识别的 IANA 来源时区。')),
  trigger: ['change', 'blur']
};
/** 边界表单基础必填规则。 */
const boundaryRules = {
  boundaryCode: [{ required: true, message: '请填写边界编码。', trigger: 'blur' }],
  boundaryName: [{ required: true, message: '请填写边界名称。', trigger: 'blur' }],
  source: [{ required: true, message: '请填写边界定义来源。', trigger: 'blur' }],
  version: [{ required: true, message: '请填写边界版本。', trigger: 'blur' }],
  effectiveStartUtc: [{ required: true, message: '请填写边界有效期开始 UTC。', trigger: ['change', 'blur'] }, strictBoundaryUtcRule('边界有效期开始 UTC')],
  effectiveEndUtc: [{ required: true, message: '请填写边界有效期结束 UTC。', trigger: ['change', 'blur'] }, strictBoundaryUtcRule('边界有效期结束 UTC')],
  sourceTimeZone: [{ required: true, message: '请选择来源时区。', trigger: ['change', 'blur'] }, boundaryIanaTimeZoneRule]
};

/** 边界详情和项目列表状态。 */
const boundaryDetailOpen = ref(false);
const boundaryDetailLoading = ref(false);
const boundaryDetailError = ref('');
const boundaryDetail = ref(null);
const boundaryDetailRequestedId = ref(null);
const balanceItems = ref([]);
/** 边界详情和项目分页分别只接受最后一次请求。 */
const boundaryDetailRequestGuard = createLatestEnergyBalanceRequestGuard();
const itemListRequestGuard = createLatestEnergyBalanceRequestGuard();
const emptyItemFilters = () => ({ status: '', role: '' });
const itemDraftFilters = ref(emptyItemFilters());
const itemAppliedFilters = ref(emptyItemFilters());
const itemPage = ref(1);
const itemPageSize = ref(50);
const itemPagination = ref({ total: 0 });
const itemLoading = ref(false);
const itemError = ref('');

/** 平衡项目新增修改对话框状态。 */
const emptyItemForm = () => ({ itemCode: '', itemName: '', role: 'input', energyTypeId: '', originalUnit: '', sourceType: 'explicit_balance_value', sourceMappingReference: '', sourceRecordIds: '', timeseriesSourceReference: '', explicitValue: undefined, generationAntiDoubleCountKey: '' });
const itemDialogOpen = ref(false);
const itemEditingId = ref(null);
const itemForm = ref(emptyItemForm());
const itemFormRef = ref();
const itemSaving = ref(false);
const itemFormError = ref('');
/** 项目表单基础必填规则。 */
const itemRules = {
  itemCode: [{ required: true, message: '请填写项目编码。', trigger: 'blur' }],
  itemName: [{ required: true, message: '请填写项目名称。', trigger: 'blur' }],
  sourceType: [{ required: true, message: '请选择显式来源类型。', trigger: 'change' }],
  role: [{ required: true, message: '请选择九角色。', trigger: 'change' }],
  energyTypeId: [{ required: true, message: '请选择 active 能源类型。', trigger: 'change' }],
  originalUnit: [{ required: true, message: '请填写原单位。', trigger: 'blur' }],
  sourceMappingReference: [{ required: true, message: '请填写可追溯的来源说明。', trigger: 'blur' }],
  generationAntiDoubleCountKey: [{ required: true, message: 'generation 来源必须填写防重复计入键。', trigger: 'blur' }]
};
/** generation 来源只允许自发自用输入或输出角色。 */
const availableRoleDefinitions = computed(() => itemForm.value.sourceType === 'generation'
  ? roleDefinitions.value.filter((item) => ['self_generation', 'output'].includes(item.value))
  : roleDefinitions.value);

/** 快照列表筛选、run 级分页和完整分面状态。 */
const emptySnapshotFilters = () => ({ boundaryId: '', energyTypeId: '', confirmationStatus: '', calculationRunId: '', sourceDataDigest: '' });
const snapshotDraftFilters = ref(emptySnapshotFilters());
const snapshotAppliedFilters = ref(emptySnapshotFilters());
const snapshotRuns = ref([]);
const snapshotPage = ref(1);
const snapshotPageSize = 20;
const snapshotPagination = ref({ total: 0 });
const snapshotLoading = ref(false);
const snapshotError = ref('');
/** run 级列表只接受最后一次筛选请求。 */
const snapshotListRequestGuard = createLatestEnergyBalanceRequestGuard();

/** 快照计算抽屉和完整自然月输入状态。 */
const calculationDrawerOpen = ref(false);
const calculationBoundary = ref(null);
const calculationItems = ref([]);
const calculationForm = reactive({ monthRange: [], explicitValues: {} });
const calculationLoading = ref(false);
const calculationError = ref('');
const calculationRequestSnapshot = ref(null);
const calculationResultSnapshot = ref(null);
/** 计算抽屉项目加载与计算提交分别只接受最后一次响应。 */
const calculationItemsRequestGuard = createLatestEnergyBalanceRequestGuard();
const calculationSubmitRequestGuard = createLatestEnergyBalanceRequestGuard();
/** 当前完整自然月换算结果。 */
const calculationWindow = computed(() => buildFullMonthCalculationWindow(calculationForm.monthRange, calculationBoundary.value?.sourceTimeZone));
/** 当前计算边界标签。 */
const calculationBoundaryLabel = computed(() => calculationBoundary.value ? `${calculationBoundary.value.boundaryName}（${calculationBoundary.value.boundaryCode}）` : '—');
/** 当前计算中允许人工覆盖的显式值项目。 */
const calculationExplicitItems = computed(() => calculationItems.value.filter((item) => item.sourceType === 'explicit_balance_value' && item.status === 'active'));

/** 快照详情、分面和图表状态。 */
const snapshotDetailOpen = ref(false);
const snapshotDetailLoading = ref(false);
const snapshotDetailError = ref('');
const snapshotDetail = ref(null);
const selectedSnapshotId = ref(null);
const facetUnitMode = ref('original');
const comprehensiveUnitMode = ref('kgce');
/** 快照详情只接受当前选中分面的最后一次响应。 */
const snapshotDetailRequestGuard = createLatestEnergyBalanceRequestGuard();
/** 当前原单位分面结果，并将已固化 kgce 等价换算为 tce 展示值。 */
const facetBalanceResult = computed(() => {
  const facet = snapshotDetail.value || {};
  const toTce = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value) / 1000
    : null;
  return {
    ...facet,
    inputTotalTce: facet.inputTotalTce ?? toTce(facet.inputTotalKgce),
    outputTotalTce: facet.outputTotalTce ?? toTce(facet.outputTotalKgce),
    storageChangeTce: facet.storageChangeTce ?? toTce(facet.storageChangeKgce),
    unexplainedTce: facet.unexplainedTce ?? toTce(facet.unexplainedKgce)
  };
});
/** 当前原单位分面图形与等价表格共享行。 */
const facetChartRows = computed(() => buildBalanceChartRows(facetBalanceResult.value, facetUnitMode.value));
/** 当前运行综合折标结果，并从已固化 kgce 储能变化等价换算 tce 展示值。 */
const comprehensiveResult = computed(() => {
  const comprehensive = snapshotDetail.value?.calculationGroup?.comprehensive || {};
  const kgceStorageValue = comprehensive.storageChangeKgce;
  const storageChangeTce = comprehensive.storageChangeTce ?? (
    kgceStorageValue !== null && kgceStorageValue !== undefined && Number.isFinite(Number(kgceStorageValue))
      ? Number(kgceStorageValue) / 1000
      : null
  );
  return { ...comprehensive, storageChangeTce };
});
/** 综合 kgce/tce 图形与等价表格共享行。 */
const comprehensiveChartRows = computed(() => buildBalanceChartRows(comprehensiveResult.value, comprehensiveUnitMode.value));

/** 建议列表筛选、分页和加载状态。 */
const emptySuggestionFilters = () => ({ boundaryId: '', calculationRunId: '', manualStatus: '', priority: '' });
const suggestionDraftFilters = ref(emptySuggestionFilters());
const suggestionAppliedFilters = ref(emptySuggestionFilters());
const suggestions = ref([]);
const suggestionPage = ref(1);
const suggestionPageSize = ref(20);
const suggestionPagination = ref({ total: 0 });
const suggestionLoading = ref(false);
const suggestionError = ref('');

/** 建议人工复核对话框状态。 */
const suggestionReviewOpen = ref(false);
const suggestionReviewRow = ref(null);
const suggestionReviewForm = reactive({ targetStatus: '', reviewNote: '' });
const suggestionReviewLoading = ref(false);
const suggestionReviewError = ref('');
/** 拒绝和解决必须填写复核备注。 */
const reviewNoteRequired = computed(() => ['rejected', 'resolved'].includes(suggestionReviewForm.targetStatus));

/** 格式化有限业务数值，不将空值伪装为零。 */
function formatNumber(value, digits = 3) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value)); }
/** 格式化整数。 */
function formatInteger(value) { return formatNumber(value, 0); }
/** 格式化比例。 */
function formatPercent(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${formatNumber(Number(value) * 100, 1)}%`; }
/** 格式化统计期。 */
function formatRange(dataRange) { return dataRange ? `${dataRange.startUtc} 至 ${dataRange.endUtc}` : '—'; }
/** 返回摘要的短展示，完整摘要仍可通过筛选和接口追溯。 */
function shortDigest(value) { return value ? `${String(value).slice(0, 12)}…${String(value).slice(-6)}` : '—'; }
/** 返回组织选项标签。 */
function organizationLabel(unit) { return `${unit.unitName || unit.name || '未命名'}（${unit.unitCode || unit.code || unit.id}）`; }
/** 返回角色标签。 */
function roleLabel(role) { return balanceRoleLabel(role); }
/** 返回来源类型标签。 */
function sourceTypeLabel(sourceType) { return balanceSourceTypeLabel(sourceType); }
/** 返回显式来源追溯摘要。 */
function sourceMappingSummary(mapping) { return balanceSourceMappingSummary(mapping); }
/** 返回冻结原因说明。 */
function reasonLabel(code) { return balanceReasonLabel(code); }
/** 判断一次完整运行是否全部可计算。 */
function runAvailable(run) { return run.calculationStatus === 'available'; }
/** 返回建议状态标签。 */
function suggestionStatusLabel(status) { return SUGGESTION_STATUS_LABELS[status] || status || '未知'; }
/** 返回建议状态标签类型。 */
function suggestionStatusType(status) { return ({ unconfirmed: 'warning', accepted: 'success', rejected: 'danger', resolved: 'primary' })[status] || 'info'; }
/** 返回建议优先级标签。 */
function priorityLabel(priority) { return ({ high: '高', medium: '中', low: '低' })[priority] || priority || '—'; }
/** 返回建议优先级标签类型。 */
function priorityType(priority) { return ({ high: 'danger', medium: 'warning', low: 'info' })[priority] || 'info'; }
/** 返回规则阈值摘要。 */
function thresholdSummary(threshold) { return threshold ? `${threshold.metricCode || '指标'} ${threshold.operator || ''} ${threshold.value ?? '—'} ${threshold.unit || ''}` : '—'; }
/** 只在有事实证据且服务端给出数值时展示预计节能量。 */
function savingDisclosure(row) { return row.estimatedSaving !== null && row.estimatedSaving !== undefined && row.evidence?.length ? `${formatNumber(row.estimatedSaving)} ${row.estimatedSavingUnit || ''}` : '未生成（无充分证据不估算）'; }
/** 返回当前建议人工流转目标。 */
function reviewTargets(status) { return suggestionReviewTargets(status); }
/** 返回建议复核动作标签。 */
function reviewActionLabel(status) { return ({ accepted: '接受建议', rejected: '拒绝建议', resolved: '标记解决' })[status] || '人工复核'; }

/** 加载稳定契约及前置字典。 */
async function loadDependencies() {
  const [contractResult, energyResult, organizationResult] = await Promise.all([
    safeRequest(getEnergyBalanceContract),
    safeRequest(getEnergyTypes),
    safeRequest(() => ledgerApi.units.list({ page: 1, pageSize: 100 }))
  ]);
  if (contractResult.ok) { contract.value = contractResult.value.data || null; contractError.value = ''; } else contractError.value = formatEnergyBalanceRequestError(contractResult.error);
  if (energyResult.ok) energyTypes.value = energyResult.value.data || [];
  if (organizationResult.ok) organizationUnits.value = organizationResult.value.data || [];
}

/** 加载边界列表。 */
async function loadBoundaries() {
  boundaryLoading.value = true;
  const result = await safeRequest(() => getEnergyBalanceBoundaries(buildBoundaryFilters(boundaryAppliedFilters.value, { page: boundaryPage.value, pageSize: boundaryPageSize.value })));
  boundaryLoading.value = false;
  if (result.ok) { boundaries.value = result.value.data || []; boundaryPagination.value = result.value.meta?.pagination || {}; boundaryError.value = ''; }
  else { boundaries.value = []; boundaryError.value = formatEnergyBalanceRequestError(result.error); }
}
/** 触发隐藏文件输入选择。 */
function chooseBalanceImportFile() {
  balanceImportFileInput.value?.click();
}
/** 绑定最新 XLSX，并使旧 preview 立即失效。 */
function selectBalanceImportFile(event) {
  const file = event?.target?.files?.[0] || null;
  balanceImportFile.value = file;
  balanceImportPreview.value = null;
  balanceImportError.value = '';
  balanceImportExecuteOpen.value = false;
  balanceImportConfirmText.value = '';
}
/** 格式化导入行问题。 */
function importIssueSummary(issues = []) {
  return Array.isArray(issues) && issues.length
    ? issues.map((issue) => `${issue.message}${issue.code ? `（${issue.code}）` : ''}`).join('；')
    : '无';
}
/** 上传当前 XLSX 并保存最新服务端受控预演。 */
async function previewBalanceImport() {
  if (!balanceImportFile.value) return;
  balanceImportPreviewLoading.value = true;
  balanceImportError.value = '';
  balanceImportPreview.value = null;
  const selectedFile = balanceImportFile.value;
  const result = await safeRequest(() => previewEnergyBalanceBundleImport(selectedFile));
  balanceImportPreviewLoading.value = false;
  if (balanceImportFile.value !== selectedFile) return;
  if (!result.ok) {
    balanceImportError.value = formatEnergyBalanceRequestError(result.error, '平衡配置导入预演失败。');
    return;
  }
  balanceImportPreview.value = result.value.data || null;
  if (!canExecuteEnergyBalanceBundleImport(balanceImportPreview.value)) {
    balanceImportError.value = '预演存在阻断、没有可写候选或服务端见证不完整，不能执行导入。';
  }
}
/** 打开固定中文确认对话框。 */
function openBalanceImportExecute() {
  if (!balanceImportExecutable.value) return;
  balanceImportConfirmText.value = '';
  balanceImportExecuteError.value = '';
  balanceImportExecuteOpen.value = true;
}
/** 提交最小 execute 正文，成功后只刷新边界列表。 */
async function executeBalanceImport() {
  if (!balanceImportExecutable.value || balanceImportConfirmText.value !== ENERGY_BALANCE_IMPORT_CONFIRM_TEXT) return;
  const previewSnapshot = balanceImportPreview.value;
  balanceImportExecuteLoading.value = true;
  balanceImportExecuteError.value = '';
  const payload = buildEnergyBalanceBundleExecutePayload(previewSnapshot, balanceImportConfirmText.value);
  const result = await safeRequest(() => executeEnergyBalanceBundleImport(payload));
  balanceImportExecuteLoading.value = false;
  if (!result.ok) {
    balanceImportExecuteError.value = formatEnergyBalanceRequestError(result.error, '平衡配置导入执行失败。');
    return;
  }
  balanceImportExecuteOpen.value = false;
  balanceImportPreview.value = null;
  balanceImportFile.value = null;
  balanceImportConfirmText.value = '';
  if (balanceImportFileInput.value) balanceImportFileInput.value.value = '';
  ElMessage.success(`已原子导入 ${formatInteger(result.value.data?.imported || 0)} 条平衡配置；未自动计算或生成建议。`);
  await loadBoundaries();
}
/** 应用边界筛选。 */
function applyBoundaryFilters() { boundaryAppliedFilters.value = { ...boundaryDraftFilters.value }; boundaryPage.value = 1; loadBoundaries(); }
/** 重置边界筛选。 */
function resetBoundaryFilters() { boundaryDraftFilters.value = emptyBoundaryFilters(); boundaryAppliedFilters.value = emptyBoundaryFilters(); boundaryPage.value = 1; loadBoundaries(); }
/** 边界页大小变化后回到第一页。 */
function changeBoundaryPageSize() { boundaryPage.value = 1; loadBoundaries(); }
/** 打开新增边界抽屉。 */
function openBoundaryCreate() { boundaryEditingId.value = null; boundaryForm.value = emptyBoundaryForm(); boundaryUtcDiagnostic.value = ''; boundaryFormError.value = ''; boundaryDrawerOpen.value = true; }
/** 打开编辑边界抽屉，并将零毫秒规范为可见秒精度，非零毫秒显示明确错误。 */
function openBoundaryEdit(row) {
  boundaryEditingId.value = row.id;
  const normalization = normalizeEnergyBalanceBoundaryUtcFields({
    boundaryCode: row.boundaryCode,
    boundaryName: row.boundaryName,
    organizationUnitId: row.organizationUnitId,
    source: row.source,
    documentNo: row.documentNo || '',
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    sourceTimeZone: row.sourceTimeZone,
    generationBoundaryConfirmed: Boolean(row.generationBoundaryConfirmed)
  });
  boundaryForm.value = normalization.value;
  boundaryUtcDiagnostic.value = normalization.message;
  boundaryFormError.value = boundaryUtcDiagnostic.value;
  boundaryDrawerOpen.value = true;
}
/** 保存边界并在调用 API 前再次阻断非法或非零毫秒 UTC。 */
async function saveBoundary() {
  const valid = await boundaryFormRef.value?.validate().catch(() => false);
  const utcNormalization = normalizeEnergyBalanceBoundaryUtcFields(boundaryForm.value);
  if (!utcNormalization.valid) { boundaryFormError.value = boundaryUtcDiagnostic.value || utcNormalization.message; return; }
  if (!valid) return;
  if (!isIanaTimeZone(utcNormalization.value.sourceTimeZone)) { boundaryFormError.value = '请选择当前运行时可识别的 IANA 来源时区。'; return; }
  boundaryUtcDiagnostic.value = '';
  boundaryForm.value = utcNormalization.value;
  if (Date.parse(boundaryForm.value.effectiveStartUtc) >= Date.parse(boundaryForm.value.effectiveEndUtc)) { boundaryFormError.value = '有效期开始必须早于结束。'; return; }
  boundarySaving.value = true; boundaryFormError.value = '';
  const payload = { ...boundaryForm.value, organizationUnitId: boundaryForm.value.organizationUnitId || null, documentNo: boundaryForm.value.documentNo || null };
  const result = await safeRequest(() => boundaryEditingId.value ? updateEnergyBalanceBoundary(boundaryEditingId.value, payload) : createEnergyBalanceBoundary(payload));
  boundarySaving.value = false;
  if (!result.ok) { boundaryFormError.value = formatEnergyBalanceRequestError(result.error); return; }
  boundaryDrawerOpen.value = false; ElMessage.success(boundaryEditingId.value ? '平衡边界已更新并完成审计。' : '平衡边界已创建并完成审计。'); await loadBoundaries();
}
/** 二次确认后启停边界。 */
async function confirmBoundaryStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active'; const action = status === 'inactive' ? '停用' : '启用';
  try { await ElMessageBox.confirm(`${action}“${row.boundaryName}”？${status === 'inactive' ? '停用不会删除历史快照，但将禁止新的快照计算。' : '启用后仍须有启用项目和有效来源才能计算。'}`, `确认${action}`, { type: status === 'inactive' ? 'warning' : 'info', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }); } catch { return; }
  const result = await safeRequest(() => updateEnergyBalanceBoundaryStatus(row.id, status));
  if (!result.ok) { ElMessage.error(formatEnergyBalanceRequestError(result.error)); return; }
  ElMessage.success(`平衡边界已${action}。`); await loadBoundaries();
}

/** 打开边界详情并以边界 ID 快照保护快速切换。 */
async function openBoundaryDetail(row) {
  boundaryDetailOpen.value = true;
  boundaryDetailRequestedId.value = row.id;
  boundaryDetailLoading.value = true;
  boundaryDetailError.value = '';
  boundaryDetail.value = null;
  balanceItems.value = [];
  itemAppliedFilters.value = emptyItemFilters();
  itemDraftFilters.value = emptyItemFilters();
  itemPage.value = 1;
  itemListRequestGuard.invalidate();
  const request = boundaryDetailRequestGuard.begin({ boundaryId: row.id });
  const result = await safeRequest(() => getEnergyBalanceBoundary(request.snapshot.boundaryId));
  if (!boundaryDetailRequestGuard.isLatest(request)
    || boundaryDetailRequestedId.value !== request.snapshot.boundaryId
    || !boundaryDetailOpen.value) return;
  boundaryDetailLoading.value = false;
  if (!result.ok) {
    boundaryDetailError.value = formatEnergyBalanceRequestError(result.error);
    return;
  }
  boundaryDetail.value = result.value.data || row;
  await loadItems();
}
/** 重新加载当前选择的边界详情。 */
function reloadBoundaryDetail() {
  if (boundaryDetailRequestedId.value) openBoundaryDetail({ id: boundaryDetailRequestedId.value });
}
/** 加载当前边界项目并丢弃旧边界或旧分页响应。 */
async function loadItems() {
  if (!boundaryDetail.value?.id) return;
  const request = itemListRequestGuard.begin({
    boundaryId: boundaryDetail.value.id,
    filters: itemAppliedFilters.value,
    page: itemPage.value,
    pageSize: itemPageSize.value
  });
  itemLoading.value = true;
  const result = await safeRequest(() => getEnergyBalanceItems(
    request.snapshot.boundaryId,
    buildItemFilters(request.snapshot.filters, request.snapshot)
  ));
  if (!itemListRequestGuard.isLatest(request)
    || boundaryDetail.value?.id !== request.snapshot.boundaryId) return;
  itemLoading.value = false;
  if (result.ok) { balanceItems.value = result.value.data || []; itemPagination.value = result.value.meta?.pagination || {}; itemError.value = ''; }
  else { balanceItems.value = []; itemError.value = formatEnergyBalanceRequestError(result.error); }
}
/** 应用项目筛选。 */
function applyItemFilters() { itemAppliedFilters.value = { ...itemDraftFilters.value }; itemPage.value = 1; loadItems(); }
/** 重置项目筛选。 */
function resetItemFilters() { itemDraftFilters.value = emptyItemFilters(); itemAppliedFilters.value = emptyItemFilters(); itemPage.value = 1; loadItems(); }
/** 项目页大小变化后回到第一页。 */
function changeItemPageSize() { itemPage.value = 1; loadItems(); }
/** 打开新增项目对话框。 */
function openItemCreate() { itemEditingId.value = null; itemForm.value = emptyItemForm(); itemFormError.value = ''; itemDialogOpen.value = true; }
/** 打开编辑项目对话框并还原来源映射。 */
function openItemEdit(row) { const mapping = row.sourceMapping || {}; itemEditingId.value = row.id; itemForm.value = { itemCode: row.itemCode, itemName: row.itemName, role: row.role, energyTypeId: row.energyType?.id, originalUnit: row.originalUnit, sourceType: row.sourceType, sourceMappingReference: mapping.reference || '', sourceRecordIds: Array.isArray(mapping.recordIds) ? mapping.recordIds.join(', ') : '', timeseriesSourceReference: mapping.sourceReference || '', explicitValue: mapping.value, generationAntiDoubleCountKey: row.generationAntiDoubleCountKey || '' }; itemFormError.value = ''; itemDialogOpen.value = true; }
/** 来源切换时保持 generation 的允许角色边界。 */
function handleItemSourceTypeChange(sourceType) { if (sourceType === 'generation' && !['self_generation', 'output'].includes(itemForm.value.role)) itemForm.value.role = 'self_generation'; if (sourceType !== 'generation') itemForm.value.generationAntiDoubleCountKey = ''; }
/** 保存项目并在前端给出来源缺失的明确提示。 */
async function saveItem() {
  const valid = await itemFormRef.value?.validate().catch(() => false); if (!valid) return;
  if (itemForm.value.sourceType === 'generation' && !['self_generation', 'output'].includes(itemForm.value.role)) { itemFormError.value = '发电来源只能选择“自发自用输入”或“外送 / 输出”角色。'; return; }
  if (!['timeseries', 'explicit_balance_value'].includes(itemForm.value.sourceType) && !String(itemForm.value.sourceRecordIds || '').trim()) { itemFormError.value = '月度、发电和显式能流边来源必须填写来源记录 ID。'; return; }
  if (itemForm.value.sourceType === 'timeseries' && !String(itemForm.value.sourceRecordIds || '').trim() && !String(itemForm.value.timeseriesSourceReference || '').trim()) { itemFormError.value = '时序来源必须填写记录 ID 或 source_reference。'; return; }
  itemSaving.value = true; itemFormError.value = ''; const payload = buildBalanceItemPayload(itemForm.value);
  const result = await safeRequest(() => itemEditingId.value ? updateEnergyBalanceItem(boundaryDetail.value.id, itemEditingId.value, payload) : createEnergyBalanceItem(boundaryDetail.value.id, payload));
  itemSaving.value = false;
  if (!result.ok) { itemFormError.value = formatEnergyBalanceRequestError(result.error); return; }
  itemDialogOpen.value = false; ElMessage.success(itemEditingId.value ? '平衡项目已更新并完成审计。' : '平衡项目已创建并完成审计。'); await loadItems();
}
/** 二次确认后启停平衡项目。 */
async function confirmItemStatus(row) {
  const status = row.status === 'active' ? 'inactive' : 'active'; const action = status === 'inactive' ? '停用' : '启用';
  try { await ElMessageBox.confirm(`${action}“${row.itemName}”？停用不会删除项目或历史快照；后续计算只读取启用项目。`, `确认${action}`, { type: status === 'inactive' ? 'warning' : 'info', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }); } catch { return; }
  const result = await safeRequest(() => updateEnergyBalanceItemStatus(boundaryDetail.value.id, row.id, status));
  if (!result.ok) { ElMessage.error(formatEnergyBalanceRequestError(result.error)); return; }
  ElMessage.success(`平衡项目已${action}。`); await loadItems();
}

/** 打开计算抽屉并按既有分页契约读取全部启用项目。 */
async function openCalculation(row) {
  calculationSubmitRequestGuard.invalidate();
  calculationBoundary.value = row;
  calculationForm.monthRange = [];
  calculationForm.explicitValues = {};
  calculationItems.value = [];
  calculationRequestSnapshot.value = null;
  calculationResultSnapshot.value = null;
  calculationError.value = '';
  calculationDrawerOpen.value = true;
  calculationLoading.value = true;
  const request = calculationItemsRequestGuard.begin({ boundaryId: row.id });
  const result = await safeRequest(() => loadAllEnergyBalanceItems(
    ({ page, pageSize }) => getEnergyBalanceItems(request.snapshot.boundaryId, {
      status: 'active',
      page,
      pageSize
    })
  ));
  if (!calculationItemsRequestGuard.isLatest(request)
    || calculationBoundary.value?.id !== request.snapshot.boundaryId
    || !calculationDrawerOpen.value) return;
  calculationLoading.value = false;
  if (!result.ok) { calculationError.value = formatEnergyBalanceRequestError(result.error); return; }
  calculationItems.value = result.value;
  if (!calculationItems.value.length) {
    calculationError.value = formatEnergyBalanceRequestError({
      apiError: { code: 'MISSING_ACTIVE_BALANCE_ITEMS', message: '边界下没有启用的平衡项目。' }
    });
    return;
  }
  calculationItems.value.filter((item) => item.sourceType === 'explicit_balance_value').forEach((item) => {
    if (item.sourceMapping?.value !== undefined) calculationForm.explicitValues[item.id] = Number(item.sourceMapping.value);
  });
}
/** 提交冻结的完整自然月输入，并将返回的 calculationRunId 固化到结果快照。 */
async function calculateSnapshots() {
  if (!calculationWindow.value.valid || !calculationBoundary.value?.id) return;
  const explicitValues = Object.fromEntries(Object.entries(calculationForm.explicitValues)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined));
  const request = calculationSubmitRequestGuard.begin({
    boundaryId: calculationBoundary.value.id,
    startUtc: calculationWindow.value.startUtc,
    endUtc: calculationWindow.value.endUtc,
    explicitValues
  });
  calculationRequestSnapshot.value = request.snapshot;
  calculationLoading.value = true;
  calculationError.value = '';
  const result = await safeRequest(() => calculateEnergyBalanceSnapshots(
    request.snapshot.boundaryId,
    {
      startUtc: request.snapshot.startUtc,
      endUtc: request.snapshot.endUtc,
      explicitValues: request.snapshot.explicitValues
    }
  ));
  if (!calculationSubmitRequestGuard.isLatest(request)) return;
  calculationLoading.value = false;
  if (!result.ok) { calculationError.value = formatEnergyBalanceRequestError(result.error); return; }
  const calculation = result.value.data || {};
  calculationResultSnapshot.value = freezeEnergyBalanceRequestSnapshot({
    ...request.snapshot,
    calculationRunId: calculation.calculationRunId
  });
  calculationDrawerOpen.value = false;
  ElMessage.success(`平衡快照已固化；运行编号 ${calculationResultSnapshot.value.calculationRunId}。`);
  activeTab.value = 'snapshots';
  snapshotDraftFilters.value = { ...emptySnapshotFilters(), calculationRunId: calculationResultSnapshot.value.calculationRunId };
  snapshotAppliedFilters.value = { ...snapshotDraftFilters.value };
  snapshotPage.value = 1;
  suggestionDraftFilters.value = { ...emptySuggestionFilters(), calculationRunId: calculationResultSnapshot.value.calculationRunId };
  suggestionAppliedFilters.value = { ...suggestionDraftFilters.value };
  suggestionPage.value = 1;
  await Promise.all([loadSnapshots(), loadSuggestions()]);
  const firstFacet = calculation.originalFacets?.[0];
  if (firstFacet?.snapshotId) await openSnapshotDetail({ id: firstFacet.snapshotId });
}

/** 按 calculationRunId 加载轻量运行摘要，完整分面只在打开详情时按需读取。 */
async function loadSnapshots() {
  const request = snapshotListRequestGuard.begin({
    filters: snapshotAppliedFilters.value,
    page: snapshotPage.value,
    pageSize: snapshotPageSize
  });
  snapshotLoading.value = true;
  const result = await safeRequest(() => getEnergyBalanceSnapshotRuns(
    buildSnapshotFilters(request.snapshot.filters, request.snapshot)
  ));
  if (!snapshotListRequestGuard.isLatest(request)) return;
  snapshotLoading.value = false;
  if (result.ok) { snapshotRuns.value = result.value.data || []; snapshotPagination.value = result.value.meta?.pagination || {}; snapshotError.value = ''; }
  else { snapshotRuns.value = []; snapshotError.value = formatEnergyBalanceRequestError(result.error); }
}
/** 应用快照筛选。 */
function applySnapshotFilters() { snapshotAppliedFilters.value = { ...snapshotDraftFilters.value }; snapshotPage.value = 1; loadSnapshots(); }
/** 重置快照筛选。 */
function resetSnapshotFilters() { snapshotDraftFilters.value = emptySnapshotFilters(); snapshotAppliedFilters.value = emptySnapshotFilters(); snapshotPage.value = 1; loadSnapshots(); }
/** 从轻量运行摘要打开详情，先按运行读取完整分面，再读取代表分面的追溯数据。 */
async function openSnapshotRunDetail(run) {
  snapshotDetailOpen.value = true;
  snapshotDetailLoading.value = true;
  snapshotDetailError.value = '';
  snapshotDetail.value = null;
  selectedSnapshotId.value = run.representativeSnapshotId || null;
  const request = snapshotDetailRequestGuard.begin({
    calculationRunId: run.calculationRunId,
    representativeSnapshotId: run.representativeSnapshotId
  });
  const runResult = await safeRequest(() => getEnergyBalanceSnapshotRun(
    request.snapshot.calculationRunId
  ));
  if (!snapshotDetailRequestGuard.isLatest(request) || !snapshotDetailOpen.value) return;
  if (!runResult.ok) {
    snapshotDetailLoading.value = false;
    snapshotDetailError.value = formatEnergyBalanceRequestError(runResult.error);
    return;
  }
  const runDetail = runResult.value.data || null;
  const snapshotId = runDetail?.representativeSnapshotId || runDetail?.snapshots?.[0]?.id;
  if (!snapshotId) {
    snapshotDetailLoading.value = false;
    snapshotDetailError.value = '该计算运行没有可读取的快照分面。';
    return;
  }
  selectedSnapshotId.value = snapshotId;
  const detailResult = await safeRequest(() => getEnergyBalanceSnapshot(snapshotId));
  if (!snapshotDetailRequestGuard.isLatest(request)
    || selectedSnapshotId.value !== snapshotId
    || !snapshotDetailOpen.value) return;
  snapshotDetailLoading.value = false;
  if (detailResult.ok) {
    snapshotDetail.value = detailResult.value.data || null;
    selectedSnapshotId.value = snapshotDetail.value?.id || snapshotId;
  } else {
    snapshotDetailError.value = formatEnergyBalanceRequestError(detailResult.error);
  }
}

/** 打开已知快照详情并立即冻结当前选择。 */
async function openSnapshotDetail(snapshot) {
  snapshotDetailOpen.value = true;
  selectedSnapshotId.value = snapshot.id;
  snapshotDetail.value = null;
  await loadSnapshotDetail(snapshot.id);
}
/** 加载快照详情，旧分面响应不得覆盖当前选择。 */
async function loadSnapshotDetail(snapshotId) {
  selectedSnapshotId.value = snapshotId;
  snapshotDetailLoading.value = true;
  snapshotDetailError.value = '';
  const request = snapshotDetailRequestGuard.begin({ snapshotId });
  const result = await safeRequest(() => getEnergyBalanceSnapshot(request.snapshot.snapshotId));
  if (!snapshotDetailRequestGuard.isLatest(request)
    || selectedSnapshotId.value !== request.snapshot.snapshotId
    || !snapshotDetailOpen.value) return;
  snapshotDetailLoading.value = false;
  if (result.ok) {
    snapshotDetail.value = result.value.data || null;
    selectedSnapshotId.value = snapshotDetail.value?.id || request.snapshot.snapshotId;
  } else {
    snapshotDetail.value = null;
    snapshotDetailError.value = formatEnergyBalanceRequestError(result.error);
  }
}
/** 重新加载当前快照详情。 */
function reloadSnapshotDetail() { if (selectedSnapshotId.value) loadSnapshotDetail(selectedSnapshotId.value); }
/** 切换同一次运行中的原单位分面。 */
function selectSnapshotFacet(snapshotId) { loadSnapshotDetail(snapshotId); }

/** 加载建议列表。 */
async function loadSuggestions() {
  suggestionLoading.value = true;
  const result = await safeRequest(() => getEnergyBalanceSuggestions(buildSuggestionFilters(suggestionAppliedFilters.value, { page: suggestionPage.value, pageSize: suggestionPageSize.value })));
  suggestionLoading.value = false;
  if (result.ok) { suggestions.value = result.value.data || []; suggestionPagination.value = result.value.meta?.pagination || {}; suggestionError.value = ''; }
  else { suggestions.value = []; suggestionError.value = formatEnergyBalanceRequestError(result.error); }
}
/** 应用建议筛选。 */
function applySuggestionFilters() { suggestionAppliedFilters.value = { ...suggestionDraftFilters.value }; suggestionPage.value = 1; loadSuggestions(); }
/** 重置建议筛选。 */
function resetSuggestionFilters() { suggestionDraftFilters.value = emptySuggestionFilters(); suggestionAppliedFilters.value = emptySuggestionFilters(); suggestionPage.value = 1; loadSuggestions(); }
/** 建议页大小变化后回到第一页。 */
function changeSuggestionPageSize() { suggestionPage.value = 1; loadSuggestions(); }
/** 打开建议人工复核对话框。 */
function openSuggestionReview(row, targetStatus) { suggestionReviewRow.value = row; suggestionReviewForm.targetStatus = targetStatus; suggestionReviewForm.reviewNote = ''; suggestionReviewError.value = ''; suggestionReviewOpen.value = true; }
/** 提交建议人工状态，拒绝和解决备注由前后端双重校验。 */
async function submitSuggestionReview() {
  const validation = validateSuggestionReview(suggestionReviewRow.value?.manualStatus, suggestionReviewForm.targetStatus, suggestionReviewForm.reviewNote);
  if (!validation.valid) { suggestionReviewError.value = validation.message; return; }
  suggestionReviewLoading.value = true; suggestionReviewError.value = '';
  const result = await safeRequest(() => updateEnergyBalanceSuggestionStatus(suggestionReviewRow.value.id, validation.payload));
  suggestionReviewLoading.value = false;
  if (!result.ok) { suggestionReviewError.value = formatEnergyBalanceRequestError(result.error); return; }
  suggestionReviewOpen.value = false; ElMessage.success('建议人工状态已更新并完成审计；未触发任何自动执行。'); await loadSuggestions(); if (snapshotDetailOpen.value && selectedSnapshotId.value) await loadSnapshotDetail(selectedSnapshotId.value);
}

/** 页面加载时读取当前账号有权限查看的领域数据。 */
onMounted(async () => {
  void COMPONENT_IDENTIFIER;
  if (!canView.value) return;
  await loadDependencies();
  await Promise.all([loadBoundaries(), loadSnapshots(), loadSuggestions()]);
});
</script>

<style scoped>
.balance-tabs{min-width:0}.page-card{min-width:0}.balance-import-panel{display:grid;gap:14px;margin-bottom:16px}.balance-import-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.balance-import-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.balance-import-confirm-form{margin-top:14px}.file-input{display:none}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.section-heading h2{margin:0;color:#123b79;font-size:17px}.section-heading small,.section-heading>span{color:#7385a2;font-size:12px}.table-scroll{max-width:100%;overflow-x:auto}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.drawer-alert{margin-bottom:12px}.full-control{width:100%}.definition-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0}.definition-grid>div{padding:10px 12px;background:#f6f9fd;border:1px solid #dfe8f3;border-radius:8px}.definition-grid dt{color:#7385a2;font-size:12px}.definition-grid dd{margin:5px 0 0;color:#183153;line-height:1.6;word-break:break-word}.detail-grid{margin-bottom:14px}.item-heading{margin-top:18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.muted-text{color:#7385a2;font-size:12px;line-height:1.6}.digest-text{margin-right:6px;color:#516170;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.suggestion-detail{display:grid;gap:12px;padding:12px 24px}.suggestion-detail h3{margin:0;color:#123b79;font-size:15px}.snapshot-selector{display:flex;align-items:center;gap:12px;margin:14px 0}.snapshot-selector>span{color:#516170;font-size:13px}.snapshot-selector .el-select{width:min(420px,100%)}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.chart-panel{margin-bottom:16px}.reason-alert{margin-top:12px}.reason-chip{display:inline-block;margin-left:8px}.rate-grid{margin-top:12px;grid-template-columns:repeat(4,minmax(0,1fr))}.drawer-subtitle{margin:16px 0 4px;color:#123b79;font-size:15px}@media (max-width:1100px){.definition-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.rate-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:700px){.section-heading,.snapshot-selector{align-items:flex-start;flex-direction:column}.definition-grid,.form-grid,.stat-grid,.rate-grid{grid-template-columns:1fr}.snapshot-selector .el-select{width:100%}}
</style>
