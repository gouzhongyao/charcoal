<template>
  <ManagementPage title="数据导入">
    <template #title-extra><HelpIcon label="查看导入追溯与删除边界" content="导入保持服务端字段契约、默认 skip 重复策略、批次审计、错误明细和原文件下载。通用删除只尝试处理普通能耗批次；抄表、月度产量和发电等领域批次必须按其专用追溯策略处理。" /></template>
    <PageState v-if="!canView" description="当前账号没有查看数据导入的权限。请联系管理员授予 imports:view 权限。" />
    <template v-else>
      <el-alert v-if="pageError" type="error" :closable="false" show-icon :title="pageError" class="panel-alert" />
      <section class="page-card import-actions">
        <div><h2>能耗数据导入</h2><p>支持 .xlsx、.xls、.csv；上传后立即由服务端校验、标准化并记录批次审计。</p></div>
        <div class="action-row"><el-button v-if="canTemplate" :loading="templateLoading" @click="downloadTemplate">下载模板</el-button><el-button v-if="canDemoExample" :loading="demoExampleLoading" @click="downloadDemoExample">下载青岚园区示例</el-button><el-button v-if="canCreate" type="primary" @click="openUpload">上传能耗表格</el-button><el-alert v-if="!canCreate" type="info" :closable="false" show-icon title="当前账号没有创建导入批次的权限；仍可在获得查看权限时核对既有批次。" /></div>
      </section>

      <article class="page-card">
        <header class="chart-heading"><div><h2>导入批次</h2><span>批次、错误和原文件均以服务端审计记录为准。</span></div></header>
        <el-form inline class="filter-row"><el-form-item label="类型"><el-select v-model="draftFilters.importType" clearable placeholder="全部类型"><el-option v-for="item in importTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="draftFilters.status" clearable placeholder="全部状态"><el-option v-for="status in batchStatuses" :key="status" :label="status" :value="status" /></el-select></el-form-item><el-form-item label="文件类型"><el-select v-model="draftFilters.fileType" clearable placeholder="全部"><el-option label="xlsx" value="xlsx" /><el-option label="xls" value="xls" /><el-option label="csv" value="csv" /></el-select></el-form-item><el-form-item><el-button :loading="loading" type="primary" @click="applyFilters">查询</el-button><el-button @click="resetFilters">重置</el-button></el-form-item></el-form>
        <PageState v-if="listError" :error="listError" @retry="loadBatches" />
        <template v-else><el-table :data="batches" v-loading="loading" stripe><el-table-column prop="id" label="批次" width="80" /><el-table-column prop="importTypeLabel" label="导入类型" min-width="130" /><el-table-column prop="displayFilename" label="原始文件" min-width="185" show-overflow-tooltip /><el-table-column prop="status" label="状态" min-width="150" /><el-table-column label="结果" min-width="170"><template #default="{ row }">成功 {{ number(row.successCount) }} / 失败 {{ number(row.failureCount) }} / 跳过 {{ number(row.skippedCount) }}</template></el-table-column><el-table-column prop="createdAt" label="创建时间" min-width="160" /><el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">详情</el-button><el-button v-if="canDownload" link @click="downloadSource(row)">原文件</el-button><el-tooltip v-if="canDelete && !canDeleteBatch(row)" content="此批次由领域专用生命周期维护，通用导入删除已禁用以保护追溯链路。"><el-button link disabled>不可通用删除</el-button></el-tooltip><el-button v-else-if="canDelete" link type="danger" @click="confirmDelete(row)">删除批次</el-button></template></el-table-column></el-table><div class="pagination"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="pagination.total || 0" @current-change="loadBatches" @size-change="changePageSize" /></div></template>
      </article>

      <el-dialog v-model="uploadOpen" title="上传能耗数据并建立批次" width="760px" destroy-on-close>
        <el-alert type="warning" :closable="false" show-icon title="当前仅启用 skip 重复策略。上传即由服务端执行校验和导入，不存在浏览器端伪预演或绕过领域校验。" />
        <el-upload :auto-upload="false" :limit="1" accept=".xlsx,.xls,.csv" :on-change="selectFile" :on-remove="clearFile"><el-button>选择表格文件</el-button><template #tip><div class="el-upload__tip">支持 {{ supportedFileTypes.join('、') || '.xlsx、.xls、.csv' }}，最大 {{ maxUploadFileSize || '以服务端限制为准' }}。</div></template></el-upload>
        <section class="mapping-section"><h3>字段映射</h3><p>填写源表头名称。留空字段由服务端根据字段别名识别；最终映射、必填校验和单位/月度标准化以服务端结果为准。</p><el-table :data="mappingFields" size="small"><el-table-column label="目标字段" min-width="150"><template #default="{ row }">{{ row.label }}<el-tag v-if="row.required" size="small" type="danger">必填</el-tag></template></el-table-column><el-table-column label="源表头"><template #default="{ row }"><el-input v-model.trim="fieldMapping[row.key]" :placeholder="row.key" /></template></el-table-column></el-table></section>
        <el-alert v-if="uploadError" type="error" :closable="false" show-icon :title="uploadError" />
        <template #footer><el-button @click="uploadOpen=false">取消</el-button><el-button type="primary" :loading="uploading" :disabled="!uploadFile" @click="submitUpload">上传并导入</el-button></template>
      </el-dialog>

      <el-dialog v-model="detailOpen" :title="`批次 #${detail?.id || ''} 详情`" width="920px" destroy-on-close>
        <PageState v-if="detailLoading" loading /><el-alert v-else-if="detailError" type="error" :closable="false" show-icon :title="detailError" /><template v-else-if="detail"><el-descriptions :column="2" border><el-descriptions-item label="导入类型">{{ detail.importTypeLabel }}</el-descriptions-item><el-descriptions-item label="状态">{{ detail.status }}</el-descriptions-item><el-descriptions-item label="原始文件">{{ detail.displayFilename || detail.originalFilename }}</el-descriptions-item><el-descriptions-item label="重复策略">{{ detail.duplicateStrategy || 'skip' }}</el-descriptions-item><el-descriptions-item label="结果">成功 {{ number(detail.counts?.successCount) }} / 失败 {{ number(detail.counts?.failureCount) }} / 跳过 {{ number(detail.counts?.skippedCount) }}</el-descriptions-item><el-descriptions-item label="错误摘要">{{ detail.errorSummary || '无' }}</el-descriptions-item></el-descriptions><h3>错误与 warning 明细</h3><el-table :data="errors" v-loading="errorsLoading" size="small"><el-table-column prop="rowNumber" label="行" width="70" /><el-table-column prop="severity" label="级别" width="90" /><el-table-column prop="fieldName" label="字段" min-width="100" /><el-table-column prop="rawValue" label="原始值" min-width="130" show-overflow-tooltip /><el-table-column prop="errorReason" label="原因" min-width="240" show-overflow-tooltip /></el-table><div class="pagination"><el-pagination v-model:current-page="errorPage" layout="total, prev, pager, next" :total="errorPagination.total || 0" @current-change="loadErrors" /></div></template>
      </el-dialog>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import { createImportBatch, deleteImportBatch, downloadImportBatchFile, downloadImportTemplate, downloadMonthlyEnergyDemoParkExample, getImportBatchDetail, getImportBatchErrors, getImportBatches, getImportContract } from '@/api/imports';
import { buildImportBatchFilters, canUseGenericImportBatchDelete, compactFieldMapping, IMPORT_BATCH_TYPE_OPTIONS } from '@/utils/specialModules';
import { hasPermi } from '@/utils/permission';

// 导入契约、批次和详情状态。
const emptyFilters = () => ({ importType: '', status: '', fileType: '', createdAtStart: '', createdAtEnd: '' });
const contract = ref({}); const draftFilters = ref(emptyFilters()); const appliedFilters = ref(emptyFilters()); const batches = ref([]); const pagination = ref({ total: 0 }); const page = ref(1); const pageSize = ref(20); const loading = ref(false); const listError = ref(''); const pageError = ref(''); const templateLoading = ref(false); const demoExampleLoading = ref(false);
const uploadOpen = ref(false); const uploadFile = ref(null); const fieldMapping = ref({}); const uploading = ref(false); const uploadError = ref('');
const detailOpen = ref(false); const detail = ref(null); const detailLoading = ref(false); const detailError = ref(''); const errors = ref([]); const errorsLoading = ref(false); const errorPage = ref(1); const errorPagination = ref({ total: 0 });
const safe = async (task) => { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } };
const errorText = (result) => result?.error?.message || '接口请求失败。';
const canView = computed(() => hasPermi('imports:view')); const canCreate = computed(() => hasPermi('imports:create')); const canDelete = computed(() => hasPermi('imports:delete')); const canDownload = computed(() => hasPermi('imports:download')); const canTemplate = computed(() => hasPermi('imports:view')); const canDemoExample = computed(() => hasPermi('imports:view'));
const supportedFileTypes = computed(() => contract.value.supportedFileTypes || []); const maxUploadFileSize = computed(() => contract.value.maxUploadFileSize || ''); const batchStatuses = computed(() => contract.value.batchStatuses || []); const importTypes = IMPORT_BATCH_TYPE_OPTIONS; const mappingFields = computed(() => [...(contract.value.requiredFields || []), ...(contract.value.optionalFields || [])]);

/** 格式化导入计数。 */
function number(value) { const input = Number(value); return Number.isFinite(input) ? new Intl.NumberFormat('zh-CN').format(input) : '0'; }
/** 判断批次能否使用通用删除。 */
function canDeleteBatch(row) { return canUseGenericImportBatchDelete(row); }
/** 读取服务端导入契约。 */
async function loadContract() { const result = await safe(getImportContract); if (result.ok) contract.value = result.value.data || {}; else pageError.value = `导入契约读取失败：${errorText(result)}`; }
/** 读取当前筛选下的批次审计列表。 */
async function loadBatches() { loading.value = true; listError.value = ''; const result = await safe(() => getImportBatches(buildImportBatchFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value }))); loading.value = false; if (result.ok) { batches.value = result.value.data || []; pagination.value = result.value.meta?.pagination || {}; } else { batches.value = []; listError.value = errorText(result); } }
/** 应用批次筛选。 */
function applyFilters() { appliedFilters.value = { ...draftFilters.value }; page.value = 1; loadBatches(); }
/** 重置批次筛选。 */
function resetFilters() { draftFilters.value = emptyFilters(); appliedFilters.value = emptyFilters(); page.value = 1; loadBatches(); }
/** 更新分页大小。 */
function changePageSize() { page.value = 1; loadBatches(); }
/** 下载服务端模板。 */
async function downloadTemplate() { templateLoading.value = true; const result = await safe(() => downloadImportTemplate()); templateLoading.value = false; if (!result.ok) ElMessage.error(`模板下载失败：${errorText(result)}`); }
/** 下载月度能耗与预测历史青岚园区示例，不自动创建导入批次。 */
async function downloadDemoExample() { demoExampleLoading.value = true; const result = await safe(downloadMonthlyEnergyDemoParkExample); demoExampleLoading.value = false; if (!result.ok) ElMessage.error(`青岚园区示例下载失败：${errorText(result)}`); }
/** 打开受控上传对话框。 */
function openUpload() { uploadFile.value = null; fieldMapping.value = {}; uploadError.value = ''; uploadOpen.value = true; }
/** 保存用户选择的上传文件。 */
function selectFile(file) { uploadFile.value = file.raw || null; uploadError.value = ''; }
/** 清除用户选择的上传文件。 */
function clearFile() { uploadFile.value = null; }
/** 上传文件并让服务端执行真实导入。 */
async function submitUpload() { if (!uploadFile.value) return; uploading.value = true; uploadError.value = ''; const result = await safe(() => createImportBatch(uploadFile.value, compactFieldMapping(fieldMapping.value))); uploading.value = false; if (!result.ok) { uploadError.value = `导入失败：${errorText(result)}`; return; } uploadOpen.value = false; ElMessage.success(`导入批次已建立：成功 ${number(result.value.data?.successCount)}，失败 ${number(result.value.data?.failureCount)}，跳过 ${number(result.value.data?.skippedCount)}。`); await loadBatches(); }
/** 下载当前批次的受控原文件。 */
async function downloadSource(row) { const result = await safe(() => downloadImportBatchFile(row.id)); if (!result.ok) ElMessage.error(`原文件下载失败：${errorText(result)}`); }
/** 打开批次详情和错误明细。 */
async function openDetail(row) { detailOpen.value = true; detail.value = null; errors.value = []; errorPage.value = 1; detailLoading.value = true; detailError.value = ''; const result = await safe(() => getImportBatchDetail(row.id)); detailLoading.value = false; if (!result.ok) { detailError.value = errorText(result); return; } detail.value = result.value.data || {}; await loadErrors(); }
/** 分页读取当前详情的错误和 warning 明细。 */
async function loadErrors() { if (!detail.value?.id) return; errorsLoading.value = true; const result = await safe(() => getImportBatchErrors(detail.value.id, { page: errorPage.value, pageSize: 50 })); errorsLoading.value = false; if (result.ok) { errors.value = result.value.data || []; errorPagination.value = result.value.meta?.pagination || {}; } else { pageError.value = `错误明细读取失败：${errorText(result)}`; } }
/** 二次确认普通能耗批次删除，不将领域限制伪装成前端成功。 */
async function confirmDelete(row) { try { await ElMessageBox.confirm(`删除普通能耗导入批次“${row.displayFilename || row.originalFilename}”？这会删除该批次能耗记录、错误明细及关联碳排结果；上传原件不由此操作物理删除。`, '确认删除导入批次', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }); } catch { return; } const result = await safe(() => deleteImportBatch(row.id)); if (!result.ok) { ElMessage.error(`批次删除失败：${errorText(result)}`); return; } ElMessage.success('普通能耗导入批次已删除，领域受保护批次仍不允许使用本接口删除。'); await loadBatches(); }

onMounted(async () => { if (!canView.value) return; await Promise.all([loadContract(), loadBatches()]); });
</script>

<style scoped>
.page-card{margin-bottom:16px}.import-actions{display:flex;justify-content:space-between;gap:16px;align-items:center}.import-actions h2,.mapping-section h3,.chart-heading h2{margin:0;color:#123b79;font-size:16px}.import-actions p,.mapping-section p,.chart-heading span{color:#7385a2;font-size:13px;line-height:1.6}.action-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.chart-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.filter-row{margin-bottom:4px}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.mapping-section{margin-top:20px}.panel-alert{margin-bottom:12px}@media (max-width:720px){.import-actions,.chart-heading{align-items:flex-start;flex-direction:column}.filter-row :deep(.el-form-item){margin-right:0}}
</style>
