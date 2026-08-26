<template>
  <section class="module-section" aria-labelledby="carbon-emission-reports-title">
    <header class="module-heading">
      <div>
        <h2 id="carbon-emission-reports-title">碳排放报告</h2>
        <p>独立维护五部分结构化报告事实；导入、查询和导出不会反写碳活动、核算运行、核算结果、旧碳排或碳因子。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImportPreview" type="warning" @click="importDialogVisible = true">模板与导入预演</el-button>
      </div>
    </header>

    <el-alert
      v-if="!canImportPreview && !canImportExecute && !canExport"
      title="当前账号只有碳排放报告查看权限；模板预演、执行导入和 XLSX 导出均由各自精确权限独立控制。"
      type="info"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert
      title="固定 Excel v1 仅接受 .xlsx，五张工作表按顺序为“报告信息、组织与核算边界、报告项目、汇总、证据说明”。同一报告编码重复导入直接阻断，不覆盖、不 skip。"
      type="info"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert v-if="filterValidationError" :title="filterValidationError" type="error" show-icon :closable="false" class="section-alert" />

    <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="碳排放报告筛选">
      <el-form-item label="关键词"><el-input v-model="draftFilters.keyword" clearable placeholder="报告编码、名称、组织或备注" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="报告编码"><el-input v-model="draftFilters.reportCode" clearable placeholder="精确编码" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="报告组织"><el-input v-model="draftFilters.organization" clearable placeholder="组织关键词" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="期间开始">
        <el-date-picker v-model="draftFilters.periodStart" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" clearable :editable="true" placeholder="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="期间结束">
        <el-date-picker v-model="draftFilters.periodEnd" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" clearable :editable="true" placeholder="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="排放范围">
        <el-select v-model="draftFilters.scope" clearable placeholder="全部范围" style="width:140px">
          <el-option v-for="option in scopeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="类别"><el-input v-model="draftFilters.category" clearable placeholder="精确类别" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="来源批次 ID"><el-input-number v-model="draftFilters.sourceBatchId" :min="1" :precision="0" controls-position="right" /></el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </el-form-item>
    </el-form>

    <article class="page-card">
      <header class="table-heading"><strong>报告列表</strong><span>共 {{ pagination.total }} 份</span></header>
      <PageState v-if="loading && !rows.length" loading />
      <PageState v-else-if="pageError && !rows.length" :error="pageError" @retry="loadReports" />
      <PageState v-else-if="!rows.length" description="暂无碳排放报告；具备预演权限时可下载固定模板并完成受控导入。" />
      <template v-else>
        <el-alert v-if="pageError" :title="pageError" type="error" show-icon :closable="false" class="table-error" />
        <el-table v-loading="loading" :data="rows" row-key="id" border empty-text="暂无碳排放报告">
          <el-table-column prop="reportCode" label="报告编码" min-width="170" fixed="left" />
          <el-table-column prop="reportName" label="报告名称" min-width="220" show-overflow-tooltip />
          <el-table-column prop="reportOrganization" label="报告组织" min-width="190" show-overflow-tooltip />
          <el-table-column label="报告期间" min-width="210"><template #default="scope">{{ scope.row.periodStart }} 至 {{ scope.row.periodEnd }}</template></el-table-column>
          <el-table-column label="结构数量" min-width="190"><template #default="scope">项目 {{ scope.row.itemCount }} / 汇总 {{ scope.row.summaryCount }} / 证据 {{ scope.row.evidenceCount }}</template></el-table-column>
          <el-table-column label="来源批次" min-width="150"><template #default="scope">#{{ scope.row.sourceBatchId }}<br /><small>{{ scope.row.sourceBatchStatus || '—' }}</small></template></el-table-column>
          <el-table-column prop="createdAt" label="创建时间" min-width="190" />
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openReportDetail(scope.row)">五部分详情</el-button>
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
      size="min(1120px, 96vw)"
      @update:model-value="updateDetailVisible"
      @closed="invalidateDetailDrawer"
    >
      <PageState v-if="detailLoading" loading />
      <PageState v-else-if="detailError" :error="detailError" @retry="retryDetail" />
      <template v-else-if="detail">
        <el-alert
          v-if="detailMode === 'batch'"
          :title="`当前详情按来源批次 #${detail.report.sourceBatchId} 追溯，返回报告 ID ${detail.report.id}。`"
          type="info"
          show-icon
          :closable="false"
          class="detail-alert"
        />
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
          <el-collapse-item title="2. 组织与核算边界" name="boundaries">
            <el-table :data="detail.boundaries" row-key="id" border max-height="360" empty-text="暂无边界">
              <el-table-column label="边界类型" width="130"><template #default="scope">{{ carbonEmissionReportBoundaryLabel(scope.row.boundaryType) }}</template></el-table-column>
              <el-table-column prop="boundaryName" label="边界名称" min-width="220" />
              <el-table-column prop="boundaryDescription" label="边界说明" min-width="360" />
              <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
            </el-table>
          </el-collapse-item>
          <el-collapse-item :title="`3. 报告项目（${detail.items.length}）`" name="items">
            <div class="wide-table">
              <el-table :data="detail.items" row-key="id" border max-height="520" empty-text="暂无报告项目">
                <el-table-column prop="itemCode" label="项目编码" min-width="150" fixed="left" />
                <el-table-column label="排放范围" width="110"><template #default="scope">{{ carbonEmissionReportScopeLabel(scope.row.emissionScope) }}</template></el-table-column>
                <el-table-column prop="category" label="类别" min-width="150" />
                <el-table-column prop="emissionSource" label="排放源或能源类型" min-width="190" />
                <el-table-column label="活动量" min-width="150"><template #default="scope">{{ formatCarbonEmissionReportNumber(scope.row.activityValue) }} {{ scope.row.activityUnit }}</template></el-table-column>
                <el-table-column label="排放因子" min-width="180"><template #default="scope">{{ formatCarbonEmissionReportNumber(scope.row.factorValue) }} {{ scope.row.factorUnit }}</template></el-table-column>
                <el-table-column label="排放量" min-width="160"><template #default="scope">{{ formatCarbonEmissionReportNumber(scope.row.emissionValue) }} {{ scope.row.co2eUnit }}</template></el-table-column>
                <el-table-column prop="evidenceCode" label="证据编号" min-width="140" />
                <el-table-column prop="note" label="备注" min-width="180"><template #default="scope">{{ scope.row.note || '—' }}</template></el-table-column>
                <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
              </el-table>
            </div>
          </el-collapse-item>
          <el-collapse-item :title="`4. 汇总（${detail.summaries.length}）`" name="summaries">
            <el-table :data="detail.summaries" row-key="id" border max-height="420" empty-text="暂无汇总">
              <el-table-column prop="summaryCode" label="汇总编码" min-width="150" />
              <el-table-column label="汇总维度" width="120"><template #default="scope">{{ carbonEmissionReportSummaryLabel(scope.row.summaryDimension) }}</template></el-table-column>
              <el-table-column prop="summaryValue" label="汇总值" min-width="170" />
              <el-table-column label="排放量" min-width="180"><template #default="scope">{{ formatCarbonEmissionReportNumber(scope.row.emissionValue) }} {{ scope.row.co2eUnit }}</template></el-table-column>
              <el-table-column prop="note" label="备注" min-width="200"><template #default="scope">{{ scope.row.note || '—' }}</template></el-table-column>
              <el-table-column prop="sourceRowNumber" label="来源行" width="90" />
            </el-table>
          </el-collapse-item>
          <el-collapse-item :title="`5. 证据说明（${detail.evidence.length}）`" name="evidence">
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

    <CarbonEmissionReportImportPanel v-model="importDialogVisible" @imported="handleImported" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import PageState from '@/components/PageState.vue';
import {
  exportCarbonEmissionReport,
  getCarbonEmissionReport,
  getCarbonEmissionReportByBatch,
  getCarbonEmissionReports
} from '@/api/carbonEmissionReports';
import {
  CARBON_EMISSION_REPORT_SCOPE_OPTIONS,
  buildCarbonEmissionReportFilters,
  carbonEmissionReportBoundaryLabel,
  carbonEmissionReportScopeLabel,
  carbonEmissionReportSummaryLabel,
  createCarbonEmissionReportViewIntent,
  formatCarbonEmissionReportNumber,
  getCarbonEmissionReportExportedRowCount,
  projectCarbonEmissionReportDetail,
  projectCarbonEmissionReportListRow,
  projectCarbonEmissionReportPagination
} from '@/utils/carbonEmissionReportManagement';
import { hasPermi } from '@/utils/permission';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';
import CarbonEmissionReportImportPanel from './CarbonEmissionReportImportPanel.vue';

// 组件属性模块：页面壳传入当前页签状态，切板块时立即废弃在途请求。
const props = defineProps({ active: { type: Boolean, default: false } });

// 固定排放范围选项：与服务端筛选白名单一致。
const scopeOptions = CARBON_EMISSION_REPORT_SCOPE_OPTIONS;
// 空筛选工厂：报告期间保留 YYYY-MM-DD 自然日字符串，不推断时区。
const emptyFilters = () => ({ keyword: '', reportCode: '', organization: '', periodStart: '', periodEnd: '', scope: '', category: '', sourceBatchId: null });
// 草稿筛选：只有点击查询并通过日期校验后才冻结为已应用筛选。
const draftFilters = reactive(emptyFilters());
// 已应用筛选：列表刷新使用同一快照，避免输入过程触发隐式查询。
const appliedFilters = ref(emptyFilters());
// 报告分页行：每行已经过公开字段白名单投影。
const rows = ref([]);
// 服务端安全分页：total 和 totalPages 必须为非负安全整数。
const pagination = ref({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
// 当前报告页码：分页变化后显式加载。
const page = ref(1);
// 当前报告页大小：页面最大值与服务端 200 上限一致。
const pageSize = ref(20);
// 列表加载状态：只允许最新请求提交。
const loading = ref(false);
// 列表错误：失败时清空旧行，避免把上一筛选结果当作当前结果。
const pageError = ref('');
// 筛选校验错误：日期格式、日历和安全分页失败时不发送请求。
const filterValidationError = ref('');
// 导入对话框状态：切换板块时强制关闭并使其内部请求失效。
const importDialogVisible = ref(false);
// 详情抽屉状态：报告 ID 和批次追溯共享一次展示，但请求世代彼此独立。
const detailVisible = ref(false);
// 当前详情模式：report 表示按报告 ID，batch 表示按来源批次追溯。
const detailMode = ref('report');
// 当前详情请求目标：重复选择同一目标仍通过 intent 形成新查看意图。
const detailTargetId = ref(null);
// 当前详情安全投影：只包含五部分公开字段。
const detail = ref(null);
// 详情加载状态：报告请求和批次请求均只允许各自最新世代提交。
const detailLoading = ref(false);
// 详情错误：失败时详情保持空，禁止继续展示旧报告。
const detailError = ref('');
// 详情默认展开五部分：方便审核时连续核对完整结构。
const detailActiveSections = ref(['report', 'boundaries', 'items', 'summaries', 'evidence']);
// 当前导出中的报告 ID：仅用于对应行 loading。
const exportingReportId = ref(null);
// 当前重复查看意图编号：同一报告或批次连续点击也必须递增。
let viewIntentGeneration = 0;
// 报告列表请求世代：筛选、分页、导入刷新、板块切换和卸载都会使旧请求失效。
let listRequestGeneration = 0;
// 报告 ID 详情请求世代：快速点击、切换为批次追溯或关闭抽屉后旧响应不得回填。
let reportDetailRequestGeneration = 0;
// 批次追溯请求世代：快速点击、切换为报告详情或关闭抽屉后旧响应不得回填。
let batchTraceRequestGeneration = 0;
// 导出请求世代：旧错误和旧 finally 不得覆盖当前导出状态。
let exportRequestGeneration = 0;

// 精确预演权限：只控制模板与预演入口，旧 carbon:view 不兜底。
const canImportPreview = computed(() => hasPermi('carbon:emission-reports:import:preview'));
// 精确执行权限：用于判断账号是否确实只有查看权限，执行按钮仍由导入面板独立控制。
const canImportExecute = computed(() => hasPermi('carbon:emission-reports:import:execute'));
// 精确导出权限：只控制单报告 XLSX 导出按钮，服务端仍独立鉴权。
const canExport = computed(() => hasPermi('carbon:emission-reports:export'));
// 详情抽屉标题：明确区分普通查看与按批次追溯。
const detailDrawerTitle = computed(() => detailMode.value === 'batch' ? '碳排放报告批次追溯' : '碳排放报告五部分详情');

// 方法模块：错误、请求失效、列表、筛选、详情、追溯、导出和导入刷新。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 创建当前页对应的空安全分页。 */
function emptyPagination() {
  return { page: page.value, pageSize: pageSize.value, total: 0, totalPages: 0 };
}

/** 使报告列表请求失效，板块切换或卸载后旧 response/error/finally 均不得提交。 */
function invalidateListRequest() {
  listRequestGeneration = nextRequestGeneration(listRequestGeneration);
  loading.value = false;
}

/** 使报告详情和批次追溯请求全部失效并清空可能误导用户的旧详情。 */
function invalidateDetailDrawer() {
  reportDetailRequestGeneration = nextRequestGeneration(reportDetailRequestGeneration);
  batchTraceRequestGeneration = nextRequestGeneration(batchTraceRequestGeneration);
  detailLoading.value = false;
  detail.value = null;
  detailError.value = '';
}

/** 使导出状态失效，旧错误和旧 finally 不得覆盖当前状态。 */
function invalidateExportRequest() {
  exportRequestGeneration = nextRequestGeneration(exportRequestGeneration);
  exportingReportId.value = null;
}

/** 切板块或卸载时废弃本板块全部在途请求，并关闭传送到 body 的导入对话框。 */
function invalidateSectionRequests() {
  invalidateListRequest();
  invalidateDetailDrawer();
  invalidateExportRequest();
  detailVisible.value = false;
  importDialogVisible.value = false;
}

/** 按当前已应用筛选加载报告分页，仅最新且板块仍活动的请求可提交。 */
async function loadReports() {
  if (!props.active) return;
  listRequestGeneration = nextRequestGeneration(listRequestGeneration);
  const requestGeneration = listRequestGeneration;
  loading.value = true;
  pageError.value = '';
  try {
    const filters = buildCarbonEmissionReportFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value });
    const response = await getCarbonEmissionReports(filters);
    if (!isLatestRequestGeneration(requestGeneration, listRequestGeneration) || !props.active) return;
    rows.value = Array.isArray(response.data) ? response.data.map(projectCarbonEmissionReportListRow) : [];
    pagination.value = projectCarbonEmissionReportPagination(response.meta?.pagination);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, listRequestGeneration) || !props.active) return;
    rows.value = [];
    pagination.value = emptyPagination();
    pageError.value = errorMessage(error, '碳排放报告列表加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, listRequestGeneration)) loading.value = false;
  }
}

/** 校验并应用草稿筛选，报告期间非法时保留输入并明确阻断请求。 */
function applyFilters() {
  try {
    buildCarbonEmissionReportFilters(draftFilters, { page: 1, pageSize: pageSize.value });
  } catch (error) {
    filterValidationError.value = error.message || '碳排放报告筛选无效。';
    return;
  }
  filterValidationError.value = '';
  appliedFilters.value = {
    ...draftFilters,
    keyword: draftFilters.keyword.trim(),
    reportCode: draftFilters.reportCode.trim(),
    organization: draftFilters.organization.trim(),
    category: draftFilters.category.trim()
  };
  page.value = 1;
  loadReports();
}

/** 清空草稿和已应用筛选后回到第一页重新加载。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  appliedFilters.value = emptyFilters();
  filterValidationError.value = '';
  page.value = 1;
  loadReports();
}

/** 分页大小变化时回到第一页，安全页大小由构造器再次校验。 */
function handlePageSizeChange() {
  page.value = 1;
  loadReports();
}

/** 同步详情抽屉可见性；关闭开始时立即使报告和批次请求失效。 */
function updateDetailVisible(value) {
  detailVisible.value = Boolean(value);
  if (!detailVisible.value) invalidateDetailDrawer();
}

/** 为报告详情创建新查看意图并读取五部分结构，同一报告重复点击仍重新请求。 */
async function openReportDetail(row) {
  const intent = createCarbonEmissionReportViewIntent('report', row.id, viewIntentGeneration);
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
    const response = await getCarbonEmissionReport(intent.targetId);
    if (!isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)
      || !props.active
      || !detailVisible.value
      || detailMode.value !== 'report'
      || detailTargetId.value !== intent.targetId) return;
    detail.value = projectCarbonEmissionReportDetail(response.data);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)
      || !props.active
      || detailMode.value !== 'report') return;
    detail.value = null;
    detailError.value = errorMessage(error, '碳排放报告五部分详情加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, reportDetailRequestGeneration)) detailLoading.value = false;
  }
}

/** 为来源批次创建新追溯意图并重新读取五部分结构，同一批次重复点击仍重新请求。 */
async function openBatchTrace(row) {
  const intent = createCarbonEmissionReportViewIntent('batch', row.sourceBatchId, viewIntentGeneration);
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
    const response = await getCarbonEmissionReportByBatch(intent.targetId);
    if (!isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)
      || !props.active
      || !detailVisible.value
      || detailMode.value !== 'batch'
      || detailTargetId.value !== intent.targetId) return;
    detail.value = projectCarbonEmissionReportDetail(response.data);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)
      || !props.active
      || detailMode.value !== 'batch') return;
    detail.value = null;
    detailError.value = errorMessage(error, '碳排放报告批次追溯加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, batchTraceRequestGeneration)) detailLoading.value = false;
  }
}

/** 按当前详情模式重新发起一次新查看意图。 */
function retryDetail() {
  if (detailMode.value === 'batch') {
    openBatchTrace({ sourceBatchId: detailTargetId.value });
    return;
  }
  openReportDetail({ id: detailTargetId.value });
}

/** 导出单份五工作表 XLSX，并展示服务端 X-Exported-Row-Count。 */
async function handleExport(row) {
  exportRequestGeneration = nextRequestGeneration(exportRequestGeneration);
  const requestGeneration = exportRequestGeneration;
  exportingReportId.value = row.id;
  try {
    const result = await exportCarbonEmissionReport(row.id);
    if (!isLatestRequestGeneration(requestGeneration, exportRequestGeneration) || !props.active) return;
    const rowCount = getCarbonEmissionReportExportedRowCount(result);
    ElMessage.success(rowCount === null
      ? '碳排放报告 XLSX 导出已触发。'
      : `碳排放报告 XLSX 导出已触发，共 ${rowCount} 行。`);
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, exportRequestGeneration) || !props.active) return;
    ElMessage.error(errorMessage(error, '碳排放报告 XLSX 导出失败。'));
  } finally {
    if (isLatestRequestGeneration(requestGeneration, exportRequestGeneration)) exportingReportId.value = null;
  }
}

/** 导入完成后回到第一页刷新当前已应用筛选。 */
async function handleImported() {
  page.value = 1;
  await loadReports();
}

// 板块生命周期模块：首次活动时加载，切出后旧请求不得回填，重新进入时按当前筛选刷新。
watch(() => props.active, (active) => {
  if (active) {
    loadReports();
    return;
  }
  invalidateSectionRequests();
}, { immediate: true });

// 组件卸载模块：所有请求世代立即失效，禁止旧 response/error/finally 回填已销毁组件。
onBeforeUnmount(invalidateSectionRequests);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.module-heading h2{margin:0 0 6px;color:#123b79;font-size:18px}.module-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.heading-actions{display:flex;flex-wrap:wrap;gap:8px}.section-alert{margin-bottom:0}.filter-form{padding:16px 16px 0;background:#fff;border:1px solid #dce9fb;border-radius:12px}.filter-form :deep(.el-date-editor){width:160px}.page-card{padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05);min-width:0}.table-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading span,small{color:var(--el-text-color-secondary)}.table-error{margin-bottom:12px}.pagination-wrap{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}.detail-alert{margin-bottom:14px}.detail-collapse{min-width:0}.detail-collapse :deep(.el-collapse-item__header){font-weight:700;color:#123b79}.wide-table{max-width:100%;overflow-x:auto}@media (max-width:720px){.module-heading,.heading-actions{width:100%}.filter-form :deep(.el-form-item),.filter-form :deep(.el-input),.filter-form :deep(.el-select),.filter-form :deep(.el-input-number),.filter-form :deep(.el-date-editor){width:100%}.detail-collapse :deep(.el-descriptions__body){overflow-x:auto}}
</style>
