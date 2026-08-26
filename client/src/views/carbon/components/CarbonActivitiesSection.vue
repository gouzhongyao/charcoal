<template>
  <section class="module-section" aria-labelledby="carbon-activities-title">
    <header class="module-heading">
      <div>
        <h2 id="carbon-activities-title">独立碳活动事实</h2>
        <p>活动事实独立于旧 <code>energy_records</code>；来源墙钟与来源时区原样追溯，对应 UTC 由服务端在导入时严格转换。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImportPreview" type="warning" @click="importDialogVisible = true">模板与导入预演</el-button>
        <el-dropdown v-if="canExport" @command="handleExport">
          <el-button :loading="exportLoading">导出活动<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu><el-dropdown-item command="xlsx">导出 XLSX</el-dropdown-item><el-dropdown-item command="csv">导出 CSV</el-dropdown-item></el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <el-alert
      title="来源墙钟格式固定为 YYYY-MM-DDTHH:mm；它不是 UTC，禁止直接追加 Z。来源时区必须是有效 IANA 时区，DST gap/fold 会被服务端阻断。"
      type="info"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert v-if="pageError" :title="pageError" type="error" show-icon :closable="false" class="section-alert" />
    <el-alert v-if="filterValidationError" :title="filterValidationError" type="error" show-icon :closable="false" class="section-alert" />

    <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="独立碳活动筛选">
      <el-form-item label="关键词"><el-input v-model="draftFilters.keyword" clearable placeholder="活动编码、类别、组织或能源" @keyup.enter="applyFilters" /></el-form-item>
      <el-form-item label="排放范围">
        <el-select v-model="draftFilters.scope" clearable placeholder="全部范围" style="width:140px">
          <el-option v-for="option in scopeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="draftFilters.status" clearable placeholder="全部状态" style="width:140px">
          <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="能源类型">
        <el-select v-model="draftFilters.energyTypeId" clearable filterable placeholder="全部能源类型" style="width:190px">
          <el-option v-for="item in props.energyTypes" :key="item.id" :label="`${item.name}（${item.code}）`" :value="item.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="用能单元 ID"><el-input-number v-model="draftFilters.organizationUnitId" :min="1" :precision="0" controls-position="right" /></el-form-item>
      <el-form-item label="来源批次 ID"><el-input-number v-model="draftFilters.sourceBatchId" :min="1" :precision="0" controls-position="right" /></el-form-item>
      <el-form-item label="UTC 开始"><StrictUtcDateTimeInput :key="`activities-start-${filterInputGeneration}`" v-model="draftFilters.startUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleFilterValidityChange('startUtc', valid)" /></el-form-item>
      <el-form-item label="UTC 结束"><StrictUtcDateTimeInput :key="`activities-end-${filterInputGeneration}`" v-model="draftFilters.endUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleFilterValidityChange('endUtc', valid)" /></el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" :disabled="!areFiltersValid" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </el-form-item>
    </el-form>

    <article class="page-card">
      <header class="table-heading"><strong>活动列表</strong><span>共 {{ pagination.total || 0 }} 条</span></header>
      <PageState v-if="pageError && !rows.length" :error="pageError" @retry="loadActivities" />
      <PageState v-else-if="!rows.length && !loading" description="暂无独立碳活动；可下载固定模板并完成预演与执行。" />
      <template v-else>
        <el-table v-loading="loading" :data="rows" row-key="id" border empty-text="暂无独立碳活动">
          <el-table-column prop="activityCode" label="活动记录编码" min-width="160" fixed="left" />
          <el-table-column label="范围 / 类别" min-width="180"><template #default="scope">{{ carbonActivityScopeLabel(scope.row.emissionScope) }} / {{ scope.row.activityCategory }}</template></el-table-column>
          <el-table-column label="用能单元" min-width="180"><template #default="scope">{{ scope.row.organizationUnitName }}（{{ scope.row.organizationUnitCode }}）</template></el-table-column>
          <el-table-column label="能源与活动值" min-width="190"><template #default="scope">{{ scope.row.energyTypeName }}：{{ formatNumber(scope.row.activityValue) }} {{ scope.row.activityUnit }}</template></el-table-column>
          <el-table-column label="来源墙钟" min-width="230"><template #default="scope">{{ formatSourceWallClock(scope.row.startWallClock) }} 至 {{ formatSourceWallClock(scope.row.endWallClock) }}<br /><small>{{ scope.row.sourceTimezone }}</small></template></el-table-column>
          <el-table-column label="对应 UTC" min-width="230"><template #default="scope">{{ scope.row.startUtc }}<br />至 {{ scope.row.endUtc }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="activityStatusType(scope.row.status)">{{ carbonActivityStatusLabel(scope.row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openDetail(scope.row)">详情</el-button>
              <el-button v-if="canVoid && scope.row.status === 'active'" link type="danger" @click="handleVoid(scope.row)">作废</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="pagination.total || 0"
            :page-sizes="[10,20,50,100]"
            layout="total, sizes, prev, pager, next, jumper"
            @current-change="loadActivities"
            @size-change="handlePageSizeChange"
          />
        </div>
      </template>
    </article>

    <el-drawer :model-value="detailVisible" title="独立碳活动详情与追溯" size="min(680px, 94vw)" @update:model-value="updateDetailVisible" @closed="invalidateDetailRequest">
      <PageState v-if="detailLoading" loading />
      <el-descriptions v-else-if="detailActivity" :column="1" border>
        <el-descriptions-item label="活动 ID">{{ detailActivity.id }}</el-descriptions-item>
        <el-descriptions-item label="来源类型">{{ detailActivity.sourceType }}</el-descriptions-item>
        <el-descriptions-item label="活动记录编码">{{ detailActivity.activityCode }}</el-descriptions-item>
        <el-descriptions-item label="排放范围">{{ carbonActivityScopeLabel(detailActivity.emissionScope) }}</el-descriptions-item>
        <el-descriptions-item label="活动类别">{{ detailActivity.activityCategory }}</el-descriptions-item>
        <el-descriptions-item label="用能单元">{{ detailActivity.organizationUnitName }}（{{ detailActivity.organizationUnitCode }}）</el-descriptions-item>
        <el-descriptions-item label="能源类型">{{ detailActivity.energyTypeName }}（{{ detailActivity.energyTypeCode }}）</el-descriptions-item>
        <el-descriptions-item label="来源墙钟">{{ formatSourceWallClock(detailActivity.startWallClock) }} 至 {{ formatSourceWallClock(detailActivity.endWallClock) }}</el-descriptions-item>
        <el-descriptions-item label="来源时区">{{ detailActivity.sourceTimezone }}</el-descriptions-item>
        <el-descriptions-item label="对应 UTC">{{ detailActivity.startUtc }} 至 {{ detailActivity.endUtc }}</el-descriptions-item>
        <el-descriptions-item label="活动数据">{{ formatNumber(detailActivity.activityValue) }} {{ detailActivity.activityUnit }}</el-descriptions-item>
        <el-descriptions-item label="因子地区">{{ detailActivity.factorRegion }}</el-descriptions-item>
        <el-descriptions-item label="来源标识">{{ detailActivity.sourceReference || '—' }}</el-descriptions-item>
        <el-descriptions-item label="证据引用">{{ detailActivity.evidenceReference || '—' }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ detailActivity.note || '—' }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ carbonActivityStatusLabel(detailActivity.status) }}</el-descriptions-item>
        <el-descriptions-item label="替代前序">{{ traceLabel(detailActivity.supersedesActivityId, detailActivity.supersedesActivityCode) }}</el-descriptions-item>
        <el-descriptions-item label="替代后继">{{ traceLabel(detailActivity.supersededByActivityId, detailActivity.supersededByActivityCode) }}</el-descriptions-item>
        <el-descriptions-item label="来源批次 / 行">{{ detailActivity.sourceBatchId || '—' }} / {{ detailActivity.sourceRowNumber || '—' }}</el-descriptions-item>
        <el-descriptions-item label="作废原因">{{ detailActivity.voidReason || '—' }}</el-descriptions-item>
        <el-descriptions-item label="作废审计">{{ detailActivity.voidedAt || '—' }} / {{ detailActivity.voidedByName || detailActivity.voidedBy || '—' }}</el-descriptions-item>
        <el-descriptions-item label="创建审计">{{ detailActivity.createdAt }} / {{ detailActivity.createdByName || detailActivity.createdBy || '—' }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ detailActivity.updatedAt }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>

    <CarbonActivityImportPanel v-model="importDialogVisible" @imported="handleImported" />
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import PageState from '@/components/PageState.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import {
  exportCarbonActivities,
  getCarbonActivities,
  getCarbonActivity,
  voidCarbonActivity
} from '@/api/carbonActivities';
import {
  CARBON_ACTIVITY_SCOPE_OPTIONS,
  CARBON_ACTIVITY_STATUS_OPTIONS,
  buildCarbonActivityFilters,
  buildCarbonActivityVoidPayload,
  carbonActivityScopeLabel,
  carbonActivityStatusLabel,
  formatSourceWallClock
} from '@/utils/carbonActivityManagement';
import { hasPermi } from '@/utils/permission';
import { areStrictUtcInputsValid } from '@/utils/dateTimeFields';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';
import CarbonActivityImportPanel from './CarbonActivityImportPanel.vue';

// 组件属性模块：能源类型字典由页面壳统一读取，避免每个板块重复请求。
const props = defineProps({ energyTypes: { type: Array, default: () => [] } });
// 组件事件模块：活动变化通知页面壳，使运行和结果板块可由用户按需刷新。
const emit = defineEmits(['activities-changed']);

// 筛选选项：与服务端活动范围和状态白名单一致。
const scopeOptions = CARBON_ACTIVITY_SCOPE_OPTIONS;
const statusOptions = CARBON_ACTIVITY_STATUS_OPTIONS;
// 空筛选工厂：严格 UTC 字段不使用 Date 对象或本地时区。
const emptyFilters = () => ({ keyword: '', scope: '', status: '', energyTypeId: null, organizationUnitId: null, sourceBatchId: null, startUtc: null, endUtc: null });
// 草稿筛选：只有点击查询后才冻结为已应用筛选。
const draftFilters = reactive(emptyFilters());
// 已应用筛选：列表和导出共用，避免导出未查询的草稿条件。
const appliedFilters = ref(emptyFilters());
// 活动分页行：服务端只返回当前页。
const rows = ref([]);
// 活动分页元数据：保留服务端 total。
const pagination = ref({ page: 1, pageSize: 20, total: 0 });
// 当前页：分页变化后显式加载。
const page = ref(1);
// 当前页大小：服务端最大允许 500，页面开放常用范围。
const pageSize = ref(20);
// 列表加载状态：控制表格和查询按钮。
const loading = ref(false);
// 列表错误：显示服务端真实中文错误。
const pageError = ref('');
// 导出加载状态：CSV/XLSX 共用。
const exportLoading = ref(false);
// 详情抽屉状态：只读展示完整追溯。
const detailVisible = ref(false);
// 详情加载状态：防止打开空白抽屉。
const detailLoading = ref(false);
// 当前详情：作废后会用服务端返回的新状态更新。
const detailActivity = ref(null);
// 导入对话框状态：由独立导入组件承载固定 XLSX v1 流程。
const importDialogVisible = ref(false);
// UTC 筛选合法性：任一键盘输入非法时阻止查询旧模型。
const filterValidity = reactive({ startUtc: true, endUtc: true });
// UTC 筛选错误：在筛选区持续显示明确中文原因。
const filterValidationError = ref('');
// UTC 输入重置世代：父模型未变化时也通过重新挂载清除组件内部非法文本。
const filterInputGeneration = ref(0);
// 活动列表请求世代：只允许最新筛选或分页请求提交。
let activitiesRequestGeneration = 0;
// 活动详情请求世代：快速点击或关闭抽屉后旧详情不得恢复。
let detailRequestGeneration = 0;
// 筛选整体合法性：查询按钮与提交方法使用同一纯逻辑合同。
const areFiltersValid = computed(() => areStrictUtcInputsValid(filterValidity));

// 精确权限：前端只控制可见性，服务端仍逐接口鉴权。
const canImportPreview = computed(() => hasPermi('carbon:activities:import:preview'));
const canVoid = computed(() => hasPermi('carbon:activities:import:execute'));
const canExport = computed(() => hasPermi('carbon:activities:export'));

// 方法模块：列表、筛选、详情、作废、导出和导入后刷新。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 格式化有限活动数值，活动事实的真实零必须显示为 0。 */
function formatNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '—';
}

/** 返回活动状态标签类型。 */
function activityStatusType(status) {
  return ({ active: 'success', superseded: 'info', void: 'danger' })[status] || 'info';
}

/** 返回替代链节点的稳定可读文本。 */
function traceLabel(activityId, activityCode) {
  if (!activityId) return '—';
  return `${activityCode || '未命名'}（ID ${activityId}）`;
}

/** 按当前已应用筛选加载活动分页，仅最新请求可提交行、错误和 loading。 */
async function loadActivities() {
  activitiesRequestGeneration = nextRequestGeneration(activitiesRequestGeneration);
  const requestGeneration = activitiesRequestGeneration;
  loading.value = true;
  pageError.value = '';
  try {
    const response = await getCarbonActivities(buildCarbonActivityFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value }));
    if (!isLatestRequestGeneration(requestGeneration, activitiesRequestGeneration)) return;
    rows.value = Array.isArray(response.data) ? response.data : [];
    pagination.value = response.meta?.pagination || { page: page.value, pageSize: pageSize.value, total: rows.value.length };
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, activitiesRequestGeneration)) return;
    rows.value = [];
    pageError.value = errorMessage(error, '独立碳活动列表加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, activitiesRequestGeneration)) loading.value = false;
  }
}

/** 更新某个严格 UTC 筛选字段的合法性并投影中文阻断提示。 */
function handleFilterValidityChange(fieldName, valid) {
  filterValidity[fieldName] = valid === true;
  filterValidationError.value = areStrictUtcInputsValid(filterValidity)
    ? ''
    : 'UTC 筛选输入无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
}

/** 应用草稿筛选并回到第一页；非法 UTC 状态不得提交父级保留的旧值。 */
function applyFilters() {
  if (!areFiltersValid.value) {
    filterValidationError.value = 'UTC 筛选输入无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
    return;
  }
  appliedFilters.value = { ...draftFilters, keyword: draftFilters.keyword.trim() };
  page.value = 1;
  loadActivities();
}

/** 清空草稿和已应用筛选后重新加载，同时清除 UTC 组件内部非法文本。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  Object.assign(filterValidity, { startUtc: true, endUtc: true });
  filterValidationError.value = '';
  filterInputGeneration.value += 1;
  appliedFilters.value = emptyFilters();
  page.value = 1;
  loadActivities();
}

/** 分页大小变化时回到第一页。 */
function handlePageSizeChange() {
  page.value = 1;
  loadActivities();
}

/** 同步详情抽屉可见性；开始关闭时立即使在途详情请求失效。 */
function updateDetailVisible(value) {
  detailVisible.value = Boolean(value);
  if (!detailVisible.value) invalidateDetailRequest();
}

/** 使当前详情请求失效；关闭抽屉后旧响应不得重新打开或恢复内容。 */
function invalidateDetailRequest() {
  detailRequestGeneration = nextRequestGeneration(detailRequestGeneration);
  detailLoading.value = false;
  detailActivity.value = null;
}

/** 读取最新详情并打开追溯抽屉，仅最新点击可提交。 */
async function openDetail(row) {
  detailRequestGeneration = nextRequestGeneration(detailRequestGeneration);
  const requestGeneration = detailRequestGeneration;
  detailVisible.value = true;
  detailLoading.value = true;
  detailActivity.value = null;
  try {
    const response = await getCarbonActivity(row.id);
    if (!isLatestRequestGeneration(requestGeneration, detailRequestGeneration) || !detailVisible.value) return;
    detailActivity.value = response.data;
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, detailRequestGeneration)) return;
    ElMessage.error(errorMessage(error, '独立碳活动详情加载失败。'));
    detailVisible.value = false;
  } finally {
    if (isLatestRequestGeneration(requestGeneration, detailRequestGeneration)) detailLoading.value = false;
  }
}

/** 读取最新详情、收集作废原因并提交 expectedUpdatedAt 乐观锁。 */
async function handleVoid(row) {
  let latestActivity;
  try {
    const response = await getCarbonActivity(row.id);
    latestActivity = response.data;
  } catch (error) {
    ElMessage.error(errorMessage(error, '作废前读取活动最新状态失败。'));
    return;
  }
  try {
    // 提示结果：Element Plus 只用于收集原因，服务端继续校验状态和乐观锁。
    const promptResult = await ElMessageBox.prompt(
      `确认作废独立碳活动“${latestActivity.activityCode}”吗？作废保留历史追溯且不可通过页面恢复。`,
      '作废独立碳活动',
      { confirmButtonText: '确认作废', cancelButtonText: '取消', inputPlaceholder: '请输入作废原因', inputValidator: (value) => String(value || '').trim() ? true : '作废原因不能为空。', type: 'warning' }
    );
    const response = await voidCarbonActivity(latestActivity.id, buildCarbonActivityVoidPayload(promptResult.value, latestActivity));
    detailActivity.value = response.data;
    ElMessage.success('独立碳活动已作废并保留追溯。');
    await loadActivities();
    emit('activities-changed');
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorMessage(error, '独立碳活动作废失败。'));
  }
}

/** 按已应用筛选导出活动 CSV 或 XLSX。 */
async function handleExport(format) {
  exportLoading.value = true;
  try {
    await exportCarbonActivities(buildCarbonActivityFilters(appliedFilters.value), format);
    ElMessage.success(`独立碳活动 ${String(format).toUpperCase()} 导出已触发。`);
  } catch (error) {
    ElMessage.error(errorMessage(error, '独立碳活动导出失败。'));
  } finally {
    exportLoading.value = false;
  }
}

/** 导入完成后刷新活动列表并通知页面壳。 */
async function handleImported() {
  page.value = 1;
  await loadActivities();
  emit('activities-changed');
}

onMounted(loadActivities);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.module-heading h2{margin:0 0 6px;color:#123b79;font-size:18px}.module-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.heading-actions{display:flex;flex-wrap:wrap;gap:8px}.section-alert{margin-bottom:0}.filter-form{padding:16px 16px 0;background:#fff;border:1px solid #dce9fb;border-radius:12px}.filter-form :deep(.strict-utc-date-time-input){width:230px}.page-card{padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05);min-width:0}.table-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading span{color:var(--el-text-color-secondary)}.pagination-wrap{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}small{color:var(--el-text-color-secondary)}code{padding:1px 4px;background:var(--el-fill-color-light);border-radius:4px}@media (max-width:720px){.module-heading,.heading-actions{width:100%}.filter-form :deep(.strict-utc-date-time-input){width:100%}}
</style>
