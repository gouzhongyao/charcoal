<template>
  <section class="module-section" aria-labelledby="ghg-reports-title">
    <header class="module-heading">
      <div>
        <h2 id="ghg-reports-title">温室气体报告</h2>
        <p>独立维护六部分结构化报告事实；N7 模板、权限、批次、数据和导出均不与 N6 碳排放报告混用。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImportPreview" type="warning" @click="importDialogVisible = true">模板与导入预演</el-button>
      </div>
    </header>

    <el-alert
      v-if="!canImportPreview && !canImportExecute && !canExport"
      title="当前账号只有温室气体报告查看权限；模板预演、执行导入和 XLSX 导出均由各自精确权限独立控制。"
      type="info"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert
      title="固定 Excel v1 仅接受 .xlsx，六张工作表按顺序为“报告信息、组织边界、运行边界、报告项目、汇总、证据说明”。项目必须显式使用 emission 或 removal；排放和清除均非负，净 CO2e 可以为负。"
      type="info"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert v-if="filterValidationError" :title="filterValidationError" type="error" show-icon :closable="false" class="section-alert" />

    <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="温室气体报告筛选">
      <el-form-item label="关键词"><el-input v-model="draftFilters.keyword" clearable placeholder="报告编码、名称、组织或备注" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="报告编码"><el-input v-model="draftFilters.reportCode" clearable placeholder="精确编码" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="报告组织"><el-input v-model="draftFilters.organization" clearable placeholder="组织关键词" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="期间开始"><el-date-picker v-model="draftFilters.periodStart" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" clearable :editable="true" placeholder="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="期间结束"><el-date-picker v-model="draftFilters.periodEnd" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" clearable :editable="true" placeholder="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="记录类型">
        <el-select v-model="draftFilters.recordType" clearable placeholder="全部类型" style="width:130px">
          <el-option v-for="option in recordTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="排放范围">
        <el-select v-model="draftFilters.scope" clearable placeholder="全部范围" style="width:140px">
          <el-option v-for="option in scopeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="类别"><el-input v-model="draftFilters.category" clearable placeholder="精确类别" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="温室气体"><el-input v-model="draftFilters.greenhouseGas" clearable placeholder="如 CO2、CH4" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="来源批次 ID"><el-input-number v-model="draftFilters.sourceBatchId" :min="1" :precision="0" controls-position="right" /></el-form-item>
      <el-form-item><el-button type="primary" :loading="loading" @click="applyFilters">查询</el-button><el-button @click="resetFilters">重置</el-button></el-form-item>
    </el-form>

    <article class="page-card">
      <header class="table-heading"><strong>报告列表</strong><span>共 {{ pagination.total }} 份</span></header>
      <PageState v-if="loading && !rows.length" loading />
      <PageState v-else-if="pageError && !rows.length" :error="pageError" @retry="loadReports" />
      <PageState v-else-if="!rows.length" description="暂无温室气体报告；具备预演权限时可下载固定模板并完成受控导入。" />
      <template v-else>
        <el-alert v-if="pageError" :title="pageError" type="error" show-icon :closable="false" class="table-error" />
        <el-table v-loading="loading" :data="rows" row-key="id" border empty-text="暂无温室气体报告">
          <el-table-column prop="reportCode" label="报告编码" min-width="170" fixed="left" />
          <el-table-column prop="reportName" label="报告名称" min-width="220" show-overflow-tooltip />
          <el-table-column prop="reportOrganization" label="报告组织" min-width="190" show-overflow-tooltip />
          <el-table-column label="报告期间" min-width="210"><template #default="scope">{{ scope.row.periodStart }} 至 {{ scope.row.periodEnd }}</template></el-table-column>
          <el-table-column label="结构数量" min-width="360"><template #default="scope">组织边界 {{ scope.row.organizationBoundaryCount }} / 运行边界 {{ scope.row.operationalBoundaryCount }} / 项目 {{ scope.row.itemCount }} / 汇总 {{ scope.row.summaryCount }} / 证据 {{ scope.row.evidenceCount }}</template></el-table-column>
          <el-table-column label="来源批次" min-width="150"><template #default="scope">#{{ scope.row.sourceBatchId }}<br /><small>{{ scope.row.sourceBatchStatus || '—' }}</small></template></el-table-column>
          <el-table-column prop="createdAt" label="创建时间" min-width="190" />
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openReportDetail(scope.row)">六部分详情</el-button>
              <el-button link @click="openBatchTrace(scope.row)">批次追溯</el-button>
              <el-button v-if="canExport" link type="success" :loading="exportingReportId === scope.row.id" @click="handleExport(scope.row)">导出 XLSX</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="pagination.total"
            :page-sizes="[10,20,50,100,200]"
            layout="total, sizes, prev, pager, next, jumper"
            @current-change="loadReports"
            @size-change="handlePageSizeChange"
          />
        </div>
      </template>
    </article>

    <el-drawer
      :model-value="detailVisible"
      :title="detailDrawerTitle"
      size="min(1200px, 96vw)"
      @update:model-value="updateDetailVisible"
      @closed="invalidateDetailDrawer"
    >
      <PageState v-if="detailLoading" loading />
      <PageState v-else-if="detailError" :error="detailError" @retry="retryDetail" />
      <template v-else-if="detail">
        <el-alert v-if="detailMode === 'batch'" :title="`当前详情按来源批次 #${detail.report.sourceBatchId} 追溯，返回报告 ID ${detail.report.id}。`" type="info" show-icon :closable="false" class="detail-alert" />
        <el-collapse v-model="detailActiveSections" class="detail-collapse">
          <el-collapse-item title="1. 报告信息" name="report">
            <el-descriptions :column="2" border>
              <el-descriptions-item label="报告 ID">{{ detail.report.id }}</el-descriptions-item>
              <el-descriptions-item label="报告编码">{{ detail.report.reportCode }}</el-descriptions-item>
              <el-descriptions-item label="报告名称">{{ detail.report.reportName }}</el-descriptions-item>
              <el-descriptions-item label="报告组织">{{ detail.report.reportOrganization }}</el-descriptions-item>
              <el-descriptions-item label="报告期间">{{ detail.report.periodStart }} 至 {{ detail.report.periodEnd }}</el-descriptions-item>
              <el-descriptions-item label="模板身份">{{ detail.report.templateId }} v{{ detail.report.templateVersion }}</el-descriptions-item>
              <el-descriptions-item label="备注" :span="2">{{ detail.report.note || '—' }}</el-descriptions-item>
              <el-descriptions-item label="来源批次 / 行">#{{ detail.report.sourceBatchId }} / {{ detail.report.sourceRowNumber }}</el-descriptions-item>
              <el-descriptions-item label="原始文件">{{ detail.report.sourceOriginalFilename || '—' }}</el-descriptions-item>
              <el-descriptions-item label="批次状态">{{ detail.report.sourceBatchStatus || '—' }}</el-descriptions-item>
              <el-descriptions-item label="创建审计">{{ detail.report.createdAt }} / {{ detail.report.createdByName || detail.report.createdBy || '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-collapse-item>
          <el-collapse-item :title="`2. 组织边界（${detail.organizationBoundaries.length}）`" name="organizationBoundaries">
            <el-table :data="detail.organizationBoundaries" row-key="id" border max-height="380" empty-text="暂无组织边界">
              <el-table-column prop="boundaryCode" label="边界编码" min-width="140" />
              <el-table-column prop="organizationUnit" label="组织单元" min-width="220" />
              <el-table-column prop="inclusionMethod" label="纳入方法" min-width="160" />
              <el-table-column prop="boundaryDescription" label="边界说明" min-width="360" />
              <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
            </el-table>
          </el-collapse-item>
          <el-collapse-item :title="`3. 运行边界（${detail.operationalBoundaries.length}）`" name="operationalBoundaries">
            <el-table :data="detail.operationalBoundaries" row-key="id" border max-height="380" empty-text="暂无运行边界">
              <el-table-column label="排放范围" width="120"><template #default="scope">{{ ghgReportScopeLabel(scope.row.emissionScope) }}</template></el-table-column>
              <el-table-column prop="category" label="类别" min-width="180" />
              <el-table-column prop="boundaryDescription" label="边界说明" min-width="400" />
              <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
            </el-table>
          </el-collapse-item>
          <el-collapse-item :title="`4. 报告项目（${detail.items.length}）`" name="items">
            <div class="wide-table">
              <el-table :data="detail.items" row-key="id" border max-height="540" empty-text="暂无报告项目">
                <el-table-column prop="itemCode" label="项目编码" min-width="140" fixed="left" />
                <el-table-column label="记录类型" width="100"><template #default="scope"><el-tag :type="scope.row.recordType === 'removal' ? 'success' : 'warning'">{{ ghgReportRecordTypeLabel(scope.row.recordType) }}</el-tag></template></el-table-column>
                <el-table-column label="排放范围" width="110"><template #default="scope">{{ ghgReportScopeLabel(scope.row.emissionScope) }}</template></el-table-column>
                <el-table-column prop="category" label="类别" min-width="150" />
                <el-table-column prop="greenhouseGas" label="温室气体" min-width="120" />
                <el-table-column prop="sourceOrSink" label="排放源或清除汇" min-width="190" />
                <el-table-column label="活动数据" min-width="150"><template #default="scope">{{ formatGhgReportNumber(scope.row.activityValue) }} {{ scope.row.activityUnit }}</template></el-table-column>
                <el-table-column label="气体数量" min-width="140"><template #default="scope">{{ formatGhgReportNumber(scope.row.gasAmount) }}</template></el-table-column>
                <el-table-column label="GWP" min-width="110"><template #default="scope">{{ formatGhgReportNumber(scope.row.gwp) }}</template></el-table-column>
                <el-table-column label="CO2e" min-width="160"><template #default="scope">{{ formatGhgReportNumber(scope.row.co2eValue) }} {{ scope.row.co2eUnit }}</template></el-table-column>
                <el-table-column prop="accountingMethod" label="核算方法" min-width="180" />
                <el-table-column prop="evidenceCode" label="证据编号" min-width="130" />
                <el-table-column prop="note" label="备注" min-width="180"><template #default="scope">{{ scope.row.note || '—' }}</template></el-table-column>
                <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
              </el-table>
            </div>
          </el-collapse-item>
          <el-collapse-item :title="`5. 汇总（${detail.summaries.length}）`" name="summaries">
            <div class="wide-table">
              <el-table :data="detail.summaries" row-key="id" border max-height="440" empty-text="暂无汇总">
                <el-table-column prop="summaryCode" label="汇总编码" min-width="140" />
                <el-table-column label="汇总维度" width="130"><template #default="scope">{{ ghgReportSummaryLabel(scope.row.summaryDimension) }}</template></el-table-column>
                <el-table-column prop="summaryValue" label="汇总值" min-width="170" />
                <el-table-column label="排放 CO2e" min-width="160"><template #default="scope">{{ formatGhgReportNumber(scope.row.emissionCo2e) }} {{ scope.row.co2eUnit }}</template></el-table-column>
                <el-table-column label="清除 CO2e" min-width="160"><template #default="scope">{{ formatGhgReportNumber(scope.row.removalCo2e) }} {{ scope.row.co2eUnit }}</template></el-table-column>
                <el-table-column label="净 CO2e" min-width="160"><template #default="scope">{{ formatGhgReportNumber(scope.row.netCo2e) }} {{ scope.row.co2eUnit }}</template></el-table-column>
                <el-table-column prop="note" label="备注" min-width="190"><template #default="scope">{{ scope.row.note || '—' }}</template></el-table-column>
                <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
              </el-table>
            </div>
          </el-collapse-item>
          <el-collapse-item :title="`6. 证据说明（${detail.evidence.length}）`" name="evidence">
            <el-table :data="detail.evidence" row-key="id" border max-height="420" empty-text="暂无证据说明">
              <el-table-column prop="evidenceCode" label="证据编号" min-width="140" />
              <el-table-column prop="evidenceName" label="证据名称" min-width="180" />
              <el-table-column prop="evidenceType" label="证据类型" min-width="130" />
              <el-table-column prop="evidenceDescription" label="证据说明" min-width="320" />
              <el-table-column prop="note" label="备注" min-width="180"><template #default="scope">{{ scope.row.note || '—' }}</template></el-table-column>
              <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </template>
    </el-drawer>

    <GhgReportImportPanel v-model="importDialogVisible" @imported="handleImported" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import PageState from '@/components/PageState.vue';
import { exportGhgReport, getGhgReport, getGhgReportByBatch, getGhgReports } from '@/api/ghgReports';
import {
  GHG_REPORT_RECORD_TYPE_OPTIONS,
  GHG_REPORT_SCOPE_OPTIONS,
  buildGhgReportFilters,
  createGhgReportViewIntent,
  formatGhgReportNumber,
  getGhgReportExportedRowCount,
  ghgReportRecordTypeLabel,
  ghgReportScopeLabel,
  ghgReportSummaryLabel,
  projectGhgReportDetail,
  projectGhgReportListRow,
  projectGhgReportPagination
} from '@/utils/ghgReportManagement';
import { hasPermi } from '@/utils/permission';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';
import GhgReportImportPanel from './GhgReportImportPanel.vue';

// 组件属性模块：页面壳传入当前页签状态，切板块时立即废弃在途请求。
const props = defineProps({ active: { type: Boolean, default: false } });
// 固定记录类型选项：清除必须显式选择 removal。
const recordTypeOptions = GHG_REPORT_RECORD_TYPE_OPTIONS;
// 固定排放范围选项：与服务端筛选白名单一致。
const scopeOptions = GHG_REPORT_SCOPE_OPTIONS;
// 空筛选工厂：报告期间保留 YYYY-MM-DD 自然日字符串。
const emptyFilters = () => ({ keyword: '', reportCode: '', organization: '', periodStart: '', periodEnd: '', recordType: '', scope: '', category: '', greenhouseGas: '', sourceBatchId: null });
// 草稿筛选：点击查询且通过校验后才冻结为已应用筛选。
const draftFilters = reactive(emptyFilters());
// 已应用筛选：列表刷新使用同一快照。
const appliedFilters = ref(emptyFilters());
// 报告分页行：每行均已通过公共 DTO 白名单投影。
const rows = ref([]);
// 服务端安全分页：所有计数必须是非负安全整数。
const pagination = ref({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
// 当前报告页码：分页变化后显式加载。
const page = ref(1);
// 当前页大小：上限与服务端 200 一致。
const pageSize = ref(20);
// 列表加载状态：仅最新请求可提交。
const loading = ref(false);
// 列表错误：失败时清空旧行，禁止误把上一筛选结果当作当前结果。
const pageError = ref('');
// 筛选校验错误：日期、枚举或安全分页失败时不发请求。
const filterValidationError = ref('');
// 导入对话框状态：切出板块时强制关闭。
const importDialogVisible = ref(false);
// 详情抽屉状态：报告 ID 与批次追溯共享展示容器。
const detailVisible = ref(false);
// 当前详情模式：report 或 batch。
const detailMode = ref('report');
// 当前详情目标：重复查看同一目标仍由 intent 形成新请求。
const detailTargetId = ref(null);
// 六部分安全详情投影。
const detail = ref(null);
// 详情加载状态：报告和批次请求分别使用独立世代。
const detailLoading = ref(false);
// 详情错误：失败时清空旧详情。
const detailError = ref('');
// 六部分默认展开，便于连续核对。
const detailActiveSections = ref(['report', 'organizationBoundaries', 'operationalBoundaries', 'items', 'summaries', 'evidence']);
// 当前导出报告 ID：仅控制对应行 loading。
const exportingReportId = ref(null);
// 重复查看意图编号：同一目标连续点击也递增。
let viewIntentGeneration = 0;
// 列表请求世代：筛选、分页、刷新、切板块和卸载均递增。
let listRequestGeneration = 0;
// 报告详情请求世代：快速点击或关闭后旧响应不得回填。
let reportDetailRequestGeneration = 0;
// 批次追溯请求世代：与报告详情完全独立。
let batchTraceRequestGeneration = 0;
// 导出请求世代：旧错误和旧 finally 不得覆盖新导出状态。
let exportRequestGeneration = 0;

// 精确预演权限：N6 权限不得放行 N7 入口。
const canImportPreview = computed(() => hasPermi('carbon:ghg-reports:import:preview'));
// 精确执行权限：用于判断是否仅有查看权限。
const canImportExecute = computed(() => hasPermi('carbon:ghg-reports:import:execute'));
// 精确导出权限：只控制 N7 单份 XLSX 导出。
const canExport = computed(() => hasPermi('carbon:ghg-reports:export'));
// 抽屉标题：明确普通详情与来源批次追溯。
const detailDrawerTitle = computed(() => detailMode.value === 'batch' ? '温室气体报告批次追溯' : '温室气体报告六部分详情');

// 方法模块：错误、请求失效、列表、筛选、详情、追溯、导出和导入刷新。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 创建当前页对应的空安全分页。 */
function emptyPagination() {
  return { page: page.value, pageSize: pageSize.value, total: 0, totalPages: 0 };
}

/** 使列表请求失效。 */
function invalidateListRequest() {
  listRequestGeneration = nextRequestGeneration(listRequestGeneration);
  loading.value = false;
}

/** 使报告详情和批次追溯请求失效并清空旧详情。 */
function invalidateDetailDrawer() {
  reportDetailRequestGeneration = nextRequestGeneration(reportDetailRequestGeneration);
  batchTraceRequestGeneration = nextRequestGeneration(batchTraceRequestGeneration);
  detailLoading.value = false;
  detail.value = null;
  detailError.value = '';
}

/** 使导出状态失效。 */
function invalidateExportRequest() {
  exportRequestGeneration = nextRequestGeneration(exportRequestGeneration);
  exportingReportId.value = null;
}

/** 切板块或卸载时废弃本板块全部请求并关闭传送到 body 的导入对话框。 */
function invalidateSectionRequests() {
  invalidateListRequest();
  invalidateDetailDrawer();
  invalidateExportRequest();
  detailVisible.value = false;
  importDialogVisible.value = false;
}

/** 按当前已应用筛选加载报告分页，仅最新且板块活动的请求可提交。 */
async function loadReports() {
  if (!props.active) return;
  listRequestGeneration = nextRequestGeneration(listRequestGeneration);
  const requestGeneration = listRequestGeneration;
  loading.value = true;
  pageError.value = '';
  try {
    const filters = buildGhgReportFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value });
    const response = await getGhgReports(filters);
    if (!isLatestRequestGeneration(requestGeneration, listRequestGeneration) || !props.active) return;
    rows.value = Array.isArray(response.data) ? response.data.map(projectGhgReportListRow) : [];
    pagination.value = projectGhgReportPagination(response.meta?.pagination);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, listRequestGeneration) || !props.active) return;
    rows.value = [];
    pagination.value = emptyPagination();
    pageError.value = errorMessage(error, '温室气体报告列表加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, listRequestGeneration)) loading.value = false;
  }
}

/** 校验并应用草稿筛选。 */
function applyFilters() {
  try {
    buildGhgReportFilters(draftFilters, { page: 1, pageSize: pageSize.value });
  } catch (error) {
    filterValidationError.value = error.message || '温室气体报告筛选无效。';
    return;
  }
  filterValidationError.value = '';
  appliedFilters.value = {
    ...draftFilters,
    keyword: draftFilters.keyword.trim(),
    reportCode: draftFilters.reportCode.trim(),
    organization: draftFilters.organization.trim(),
    category: draftFilters.category.trim(),
    greenhouseGas: draftFilters.greenhouseGas.trim()
  };
  page.value = 1;
  loadReports();
}

/** 清空筛选并回到第一页。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  appliedFilters.value = emptyFilters();
  filterValidationError.value = '';
  page.value = 1;
  loadReports();
}

/** 页大小变化时回到第一页。 */
function handlePageSizeChange() {
  page.value = 1;
  loadReports();
}

/** 同步详情抽屉可见性。 */
function updateDetailVisible(value) {
  detailVisible.value = Boolean(value);
  if (!detailVisible.value) invalidateDetailDrawer();
}

/** 创建报告详情新意图并读取六部分结构，同一报告重复点击仍重新请求。 */
async function openReportDetail(row) {
  const intent = createGhgReportViewIntent('report', row.id, viewIntentGeneration);
  viewIntentGeneration = intent.intent;
  detailMode.value = intent.targetType;
  detailTargetId.value = intent.targetId;
  detailVisible.value = true;
  detail.value = null;
  detailError.value = '';
  detailLoading.value = true;
  batchTraceRequestGeneration = nextRequestGeneration(batchTraceRequestGeneration);
  reportDetailRequestGeneration = nextRequestGeneration(reportDetailRequestGeneration);
  const requestGeneration = reportDetailRequestGeneration;
  try {
    const response = await getGhgReport(intent.targetId);
    if (!isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)
      || !props.active
      || !detailVisible.value
      || detailMode.value !== 'report'
      || detailTargetId.value !== intent.targetId) return;
    detail.value = projectGhgReportDetail(response.data);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)
      || !props.active
      || detailMode.value !== 'report') return;
    detail.value = null;
    detailError.value = errorMessage(error, '温室气体报告六部分详情加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)) detailLoading.value = false;
  }
}

/** 创建来源批次追溯新意图，同一批次重复点击仍重新请求。 */
async function openBatchTrace(row) {
  const intent = createGhgReportViewIntent('batch', row.sourceBatchId, viewIntentGeneration);
  viewIntentGeneration = intent.intent;
  detailMode.value = intent.targetType;
  detailTargetId.value = intent.targetId;
  detailVisible.value = true;
  detail.value = null;
  detailError.value = '';
  detailLoading.value = true;
  reportDetailRequestGeneration = nextRequestGeneration(reportDetailRequestGeneration);
  batchTraceRequestGeneration = nextRequestGeneration(batchTraceRequestGeneration);
  const requestGeneration = batchTraceRequestGeneration;
  try {
    const response = await getGhgReportByBatch(intent.targetId);
    if (!isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)
      || !props.active
      || !detailVisible.value
      || detailMode.value !== 'batch'
      || detailTargetId.value !== intent.targetId) return;
    detail.value = projectGhgReportDetail(response.data);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)
      || !props.active
      || detailMode.value !== 'batch') return;
    detail.value = null;
    detailError.value = errorMessage(error, '温室气体报告批次追溯加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)) detailLoading.value = false;
  }
}

/** 按当前详情模式发起一次新的重试意图。 */
function retryDetail() {
  if (detailMode.value === 'batch') {
    openBatchTrace({ sourceBatchId: detailTargetId.value });
    return;
  }
  openReportDetail({ id: detailTargetId.value });
}

/** 导出单份六工作表 XLSX，并显示 X-Exported-Row-Count。 */
async function handleExport(row) {
  exportRequestGeneration = nextRequestGeneration(exportRequestGeneration);
  const requestGeneration = exportRequestGeneration;
  exportingReportId.value = row.id;
  try {
    const result = await exportGhgReport(row.id);
    if (!isLatestRequestGeneration(requestGeneration, exportRequestGeneration) || !props.active) return;
    const rowCount = getGhgReportExportedRowCount(result);
    ElMessage.success(rowCount === null
      ? '温室气体报告 XLSX 导出已触发。'
      : `温室气体报告 XLSX 导出已触发，共 ${rowCount} 行。`);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, exportRequestGeneration) || !props.active) return;
    ElMessage.error(errorMessage(error, '温室气体报告 XLSX 导出失败。'));
  } finally {
    if (isLatestRequestGeneration(requestGeneration, exportRequestGeneration)) exportingReportId.value = null;
  }
}

/** 导入完成后回到第一页刷新当前筛选。 */
async function handleImported() {
  page.value = 1;
  await loadReports();
}

// 板块生命周期模块：首次活动时加载，切出后旧请求不得回填。
watch(() => props.active, (active) => {
  if (active) {
    loadReports();
    return;
  }
  invalidateSectionRequests();
}, { immediate: true });

// 组件卸载模块：所有请求世代立即失效。
onBeforeUnmount(invalidateSectionRequests);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.module-heading h2{margin:0 0 6px;color:#123b79;font-size:18px}.module-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.heading-actions{display:flex;flex-wrap:wrap;gap:8px}.section-alert{margin-bottom:0}.filter-form{padding:16px 16px 0;background:#fff;border:1px solid #dce9fb;border-radius:12px}.filter-form :deep(.el-date-editor){width:160px}.page-card{padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05);min-width:0}.table-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading span,small{color:var(--el-text-color-secondary)}.table-error{margin-bottom:12px}.pagination-wrap{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}.detail-alert{margin-bottom:14px}.detail-collapse{min-width:0}.detail-collapse :deep(.el-collapse-item__header){font-weight:700;color:#123b79}.wide-table{max-width:100%;overflow-x:auto}@media (max-width:720px){.module-heading,.heading-actions{width:100%}.filter-form :deep(.el-form-item),.filter-form :deep(.el-input),.filter-form :deep(.el-select),.filter-form :deep(.el-input-number),.filter-form :deep(.el-date-editor){width:100%}.detail-collapse :deep(.el-descriptions__body){overflow-x:auto}}
</style>
