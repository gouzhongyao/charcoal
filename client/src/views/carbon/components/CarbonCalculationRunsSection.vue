<template>
  <section class="module-section" aria-labelledby="calculation-runs-title">
    <header class="module-heading">
      <div>
        <h2 id="calculation-runs-title">独立核算运行</h2>
        <p>每次创建都追加一条 completed 运行和冻结结果，不覆盖历史；计算只读取指定 UTC 区间内正重叠的 active 独立碳活动。</p>
      </div>
      <el-button v-if="props.canCalculate" type="primary" @click="openCreateDialog">创建核算运行</el-button>
    </header>

    <el-alert
      title="创建运行只接受严格 UTC 秒精度 YYYY-MM-DDTHH:mm:ssZ（.000Z 可无损规范化）。这里输入的是 UTC，不是来源墙钟；禁止把 YYYY-MM-DDTHH:mm 墙钟字符串直接追加 Z。"
      type="warning"
      show-icon
      :closable="false"
      class="section-alert"
    />
    <el-alert v-if="pageError" :title="pageError" type="error" show-icon :closable="false" class="section-alert" />
    <el-alert v-if="filterValidationError" :title="filterValidationError" type="error" show-icon :closable="false" class="section-alert" />

    <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="独立核算运行历史筛选">
      <el-form-item label="运行 UTC 开始"><StrictUtcDateTimeInput :key="`run-filter-start-${filterInputGeneration}`" v-model="draftFilters.startUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleFilterValidityChange('startUtc', valid)" /></el-form-item>
      <el-form-item label="运行 UTC 结束"><StrictUtcDateTimeInput :key="`run-filter-end-${filterInputGeneration}`" v-model="draftFilters.endUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleFilterValidityChange('endUtc', valid)" /></el-form-item>
      <el-form-item><el-button type="primary" :loading="loading" :disabled="!areFiltersValid" @click="applyFilters">查询</el-button><el-button @click="resetFilters">重置</el-button></el-form-item>
    </el-form>

    <article class="page-card">
      <header class="table-heading"><strong>运行历史</strong><span>共 {{ pagination.total || 0 }} 条</span></header>
      <PageState v-if="pageError && !rows.length" :error="pageError" @retry="loadRuns" />
      <PageState v-else-if="!rows.length && !loading" description="暂无独立碳核算运行；创建运行后将在此保留追加式历史。" />
      <template v-else>
        <el-table v-loading="loading" :data="rows" row-key="runCode" border empty-text="暂无独立核算运行">
          <el-table-column prop="runCode" label="运行编码" min-width="250" fixed="left" show-overflow-tooltip />
          <el-table-column label="UTC 期间" min-width="250"><template #default="scope">{{ formatStrictUtcDateTimeDisplay(scope.row.startUtc) }}<br />至 {{ formatStrictUtcDateTimeDisplay(scope.row.endUtc) }}</template></el-table-column>
          <el-table-column prop="calculationMethod" label="方法" min-width="130" />
          <el-table-column label="活动 / 结果" width="120"><template #default="scope">{{ scope.row.activityCount }} / {{ scope.row.resultCount }}</template></el-table-column>
          <el-table-column label="已计算 / 缺因子" width="140"><template #default="scope">{{ scope.row.calculatedCount }} / {{ scope.row.factorMissingCount }}</template></el-table-column>
          <el-table-column label="按单位总量" min-width="200"><template #default="scope">{{ formatCarbonTotalsByUnit(scope.row.emissionTotals?.totals || []) }}</template></el-table-column>
          <el-table-column label="完成时间（UTC）" min-width="190"><template #default="scope">{{ formatStrictUtcDateTimeDisplay(scope.row.completedAt) }}</template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">详情</el-button><el-button link type="success" @click="selectRun(scope.row)">查看结果</el-button></template>
          </el-table-column>
        </el-table>
        <div class="pagination-wrap">
          <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="pagination.total || 0" :page-sizes="[10,20,50,100]" layout="total, sizes, prev, pager, next, jumper" @current-change="loadRuns" @size-change="handlePageSizeChange" />
        </div>
      </template>
    </article>

    <el-dialog v-model="createDialogVisible" title="创建独立碳核算运行" width="min(640px, 94vw)" destroy-on-close>
      <el-alert title="只输入严格 UTC 秒精度。系统不会把来源墙钟、浏览器本地时间或 offset 自动猜测为 UTC；如需从来源墙钟换算，请在导入时提供 IANA 来源时区并以服务端转换结果为准。" type="warning" show-icon :closable="false" class="dialog-alert" />
      <el-form label-position="top">
        <el-form-item label="开始 UTC（含）"><StrictUtcDateTimeInput :key="`run-create-start-${createInputGeneration}`" v-model="createForm.startUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleCreateValidityChange('startUtc', valid)" /></el-form-item>
        <el-form-item label="结束 UTC（不含）"><StrictUtcDateTimeInput :key="`run-create-end-${createInputGeneration}`" v-model="createForm.endUtc" placeholder="YYYY-MM-DDTHH:mm:ssZ" @validity-change="(valid) => handleCreateValidityChange('endUtc', valid)" /></el-form-item>
      </el-form>
      <el-alert v-if="createError" :title="createError" type="error" show-icon :closable="false" class="dialog-alert" />
      <template #footer><el-button @click="createDialogVisible = false">取消</el-button><el-button type="primary" :loading="createLoading" :disabled="!areCreateInputsValid" @click="createRun">创建运行</el-button></template>
    </el-dialog>

    <el-drawer :model-value="detailVisible" title="独立碳核算运行详情" size="min(700px, 94vw)" @update:model-value="updateDetailVisible" @closed="invalidateDetailRequest">
      <PageState v-if="detailLoading" loading />
      <el-descriptions v-else-if="detailRun" :column="1" border>
        <el-descriptions-item label="运行编码">{{ detailRun.runCode }}</el-descriptions-item>
        <el-descriptions-item label="来源类型">{{ detailRun.sourceType }}</el-descriptions-item>
        <el-descriptions-item label="状态 / 方法">{{ detailRun.status }} / {{ detailRun.calculationMethod }}</el-descriptions-item>
        <el-descriptions-item label="UTC 期间">{{ formatStrictUtcDateTimeDisplay(detailRun.startUtc) }} 至 {{ formatStrictUtcDateTimeDisplay(detailRun.endUtc) }}</el-descriptions-item>
        <el-descriptions-item label="活动 / 结果">{{ detailRun.activityCount }} / {{ detailRun.resultCount }}</el-descriptions-item>
        <el-descriptions-item label="已计算 / 缺因子">{{ detailRun.calculatedCount }} / {{ detailRun.factorMissingCount }}</el-descriptions-item>
        <el-descriptions-item label="按排放单位总量">{{ formatCarbonTotalsByUnit(detailRun.emissionTotals?.totals || []) }}</el-descriptions-item>
        <el-descriptions-item label="快照版本">{{ detailRun.snapshotSchemaVersion }}</el-descriptions-item>
        <el-descriptions-item label="活动快照摘要"><span class="digest-text">{{ detailRun.activitySnapshotDigest }}</span></el-descriptions-item>
        <el-descriptions-item label="操作者">{{ actorLabel(detailRun.actorSnapshot) }}</el-descriptions-item>
        <el-descriptions-item label="开始 / 完成">{{ formatStrictUtcDateTimeDisplay(detailRun.startedAt) }} / {{ formatStrictUtcDateTimeDisplay(detailRun.completedAt) }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatStrictUtcDateTimeDisplay(detailRun.createdAt) }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import PageState from '@/components/PageState.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import {
  createCarbonCalculationRun,
  getCarbonCalculationRun,
  getCarbonCalculationRuns
} from '@/api/carbonAccounting';
import {
  buildCarbonCalculationRunPayload,
  formatCarbonTotalsByUnit
} from '@/utils/carbonSourceManagement';
import { areStrictUtcInputsValid } from '@/utils/dateTimeFields';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';

// 组件属性模块：页面壳按精确权限决定是否允许创建运行。
const props = defineProps({ canCalculate: { type: Boolean, default: false } });
// 组件事件模块：运行创建或选择后通知统一结果板块切换 runCode。
const emit = defineEmits(['run-selected', 'run-created']);

// 空运行筛选：严格 UTC 字符串不使用 Date 对象。
const emptyFilters = () => ({ startUtc: null, endUtc: null });
// 草稿筛选：点击查询后才应用。
const draftFilters = reactive(emptyFilters());
// 已应用筛选：运行列表请求使用冻结副本。
const appliedFilters = ref(emptyFilters());
// 运行历史当前页行。
const rows = ref([]);
// 运行分页元数据。
const pagination = ref({ page: 1, pageSize: 20, total: 0 });
// 当前运行历史页。
const page = ref(1);
// 运行历史页大小。
const pageSize = ref(20);
// 运行历史加载状态。
const loading = ref(false);
// 运行历史错误。
const pageError = ref('');
// 创建运行对话框状态。
const createDialogVisible = ref(false);
// 创建运行表单：只包含后端允许的 startUtc/endUtc。
const createForm = reactive({ startUtc: null, endUtc: null });
// 创建运行加载状态。
const createLoading = ref(false);
// 创建运行表单错误。
const createError = ref('');
// 运行详情抽屉状态。
const detailVisible = ref(false);
// 运行详情加载状态。
const detailLoading = ref(false);
// 当前运行详情。
const detailRun = ref(null);
// 列表 UTC 筛选合法性：任一非法输入均阻止查询旧模型。
const filterValidity = reactive({ startUtc: true, endUtc: true });
// 列表 UTC 筛选错误：持续显示中文阻断说明。
const filterValidationError = ref('');
// 列表 UTC 输入重置世代：确保重置可清除内部非法文本。
const filterInputGeneration = ref(0);
// 创建 UTC 输入合法性：任一非法输入均阻止创建运行。
const createValidity = reactive({ startUtc: true, endUtc: true });
// 创建 UTC 输入重置世代：每次打开对话框使用干净输入状态。
const createInputGeneration = ref(0);
// 运行列表请求世代：逆序响应只允许最新请求提交。
let runsRequestGeneration = 0;
// 运行详情请求世代：快速切换或关闭后旧详情不得提交。
let detailRequestGeneration = 0;
// 列表筛选整体合法性：按钮与方法共享同一判断。
const areFiltersValid = computed(() => areStrictUtcInputsValid(filterValidity));
// 创建表单整体合法性：按钮与方法共享同一判断。
const areCreateInputsValid = computed(() => areStrictUtcInputsValid(createValidity));

// 方法模块：错误投影、运行历史、创建、详情与结果联动。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 按当前已应用严格 UTC 区间加载运行历史，仅最新请求可提交。 */
async function loadRuns() {
  runsRequestGeneration = nextRequestGeneration(runsRequestGeneration);
  const requestGeneration = runsRequestGeneration;
  loading.value = true;
  pageError.value = '';
  try {
    // 查询参数：空值由共享 query 移除，页码和页大小显式提交。
    const response = await getCarbonCalculationRuns({ ...appliedFilters.value, page: page.value, pageSize: pageSize.value });
    if (!isLatestRequestGeneration(requestGeneration, runsRequestGeneration)) return;
    rows.value = Array.isArray(response.data) ? response.data : [];
    pagination.value = response.meta?.pagination || { page: page.value, pageSize: pageSize.value, total: rows.value.length };
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, runsRequestGeneration)) return;
    rows.value = [];
    pageError.value = errorMessage(error, '独立碳核算运行历史加载失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, runsRequestGeneration)) loading.value = false;
  }
}

/** 更新运行历史 UTC 筛选字段合法性并投影中文阻断提示。 */
function handleFilterValidityChange(fieldName, valid) {
  filterValidity[fieldName] = valid === true;
  filterValidationError.value = areStrictUtcInputsValid(filterValidity)
    ? ''
    : '运行历史 UTC 筛选无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
}

/** 应用运行筛选并回到第一页；非法输入不得提交父级旧值。 */
function applyFilters() {
  if (!areFiltersValid.value) {
    filterValidationError.value = '运行历史 UTC 筛选无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
    return;
  }
  appliedFilters.value = { ...draftFilters };
  page.value = 1;
  loadRuns();
}

/** 清空运行筛选并重新加载，同时重建严格 UTC 输入状态。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  Object.assign(filterValidity, { startUtc: true, endUtc: true });
  filterValidationError.value = '';
  filterInputGeneration.value += 1;
  appliedFilters.value = emptyFilters();
  page.value = 1;
  loadRuns();
}

/** 分页大小变化时回到第一页。 */
function handlePageSizeChange() {
  page.value = 1;
  loadRuns();
}

/** 打开创建运行对话框并清空旧错误和非法输入状态。 */
function openCreateDialog() {
  Object.assign(createForm, { startUtc: null, endUtc: null });
  Object.assign(createValidity, { startUtc: true, endUtc: true });
  createInputGeneration.value += 1;
  createError.value = '';
  createDialogVisible.value = true;
}

/** 更新创建运行 UTC 字段合法性，并持续显示中文阻断原因。 */
function handleCreateValidityChange(fieldName, valid) {
  createValidity[fieldName] = valid === true;
  createError.value = areStrictUtcInputsValid(createValidity)
    ? ''
    : '创建运行的 UTC 输入无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正。';
}

/** 校验并提交仅含两字段的严格 UTC 创建载荷。 */
async function createRun() {
  if (!areCreateInputsValid.value) {
    createError.value = '创建运行的 UTC 输入无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正。';
    return;
  }
  // 载荷结果：纯函数同时负责 .000Z 规范化和明确中文错误。
  const payloadResult = buildCarbonCalculationRunPayload(createForm);
  if (!payloadResult.valid) {
    createError.value = payloadResult.message;
    return;
  }
  createLoading.value = true;
  createError.value = '';
  try {
    const response = await createCarbonCalculationRun(payloadResult.payload);
    // 新运行：服务端同步返回 completed 运行及冻结统计。
    const createdRun = response.data;
    createDialogVisible.value = false;
    ElMessage.success(`独立碳核算运行已完成：已计算 ${createdRun.calculatedCount} 条，缺因子 ${createdRun.factorMissingCount} 条。`);
    page.value = 1;
    await loadRuns();
    emit('run-created', createdRun);
    emit('run-selected', createdRun.runCode);
  } catch (error) {
    createError.value = errorMessage(error, '独立碳核算运行创建失败。');
  } finally {
    createLoading.value = false;
  }
}

/** 同步运行详情抽屉可见性；开始关闭时立即使在途请求失效。 */
function updateDetailVisible(value) {
  detailVisible.value = Boolean(value);
  if (!detailVisible.value) invalidateDetailRequest();
}

/** 使当前运行详情请求失效并清空旧详情。 */
function invalidateDetailRequest() {
  detailRequestGeneration = nextRequestGeneration(detailRequestGeneration);
  detailLoading.value = false;
  detailRun.value = null;
}

/** 读取最新冻结运行详情并打开抽屉，仅最新点击可提交。 */
async function openDetail(row) {
  detailRequestGeneration = nextRequestGeneration(detailRequestGeneration);
  const requestGeneration = detailRequestGeneration;
  detailVisible.value = true;
  detailLoading.value = true;
  detailRun.value = null;
  try {
    const response = await getCarbonCalculationRun(row.runCode);
    if (!isLatestRequestGeneration(requestGeneration, detailRequestGeneration) || !detailVisible.value) return;
    detailRun.value = response.data;
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, detailRequestGeneration)) return;
    ElMessage.error(errorMessage(error, '独立碳核算运行详情加载失败。'));
    detailVisible.value = false;
  } finally {
    if (isLatestRequestGeneration(requestGeneration, detailRequestGeneration)) detailLoading.value = false;
  }
}

/** 通知页面壳记录一次新的结果查看意图；同一运行连续点击也必须触发。 */
function selectRun(row) {
  emit('run-selected', row.runCode);
}

/** 投影公开 actor 快照，IP 不在前端 DTO 中展示。 */
function actorLabel(actorSnapshot) {
  const actor = actorSnapshot?.actor || {};
  return actor.displayName || actor.username || (actor.userId ? `用户 ${actor.userId}` : '系统');
}

onMounted(loadRuns);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.module-heading h2{margin:0 0 6px;color:#123b79;font-size:18px}.module-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.section-alert{margin-bottom:0}.filter-form{padding:16px 16px 0;background:#fff;border:1px solid #dce9fb;border-radius:12px}.filter-form :deep(.strict-utc-date-time-input){width:230px}.page-card{padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05);min-width:0}.table-heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading span{color:var(--el-text-color-secondary)}.pagination-wrap{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}.dialog-alert{margin-bottom:14px}.digest-text{word-break:break-all}@media (max-width:720px){.filter-form :deep(.strict-utc-date-time-input){width:100%}}
</style>
