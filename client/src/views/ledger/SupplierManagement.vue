<template>
  <div class="supplier-page">
    <el-card shadow="never" class="page-card">
      <template #header>
        <div class="page-header">
          <div>
            <h2>供应商管理</h2>
            <p>供应商编码是稳定业务键；联系电话按文本保存，合作状态通过独立操作流转。</p>
          </div>
          <div class="header-actions">
            <el-button v-if="canImportPreview" :loading="templateLoading" @click="handleDownloadTemplate">下载 Excel v1 模板</el-button>
            <el-button v-if="canImportPreview" type="warning" @click="openImportDialog">导入预演</el-button>
            <el-button v-if="canExport" :loading="exportLoading" @click="handleExport">导出</el-button>
            <el-button v-if="canCreate" type="primary" @click="openCreateDialog">新增供应商</el-button>
          </div>
        </div>
      </template>

      <el-alert v-if="pageError" :title="pageError" type="error" show-icon :closable="false" class="page-alert" />

      <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="供应商筛选">
        <el-form-item label="关键词">
          <el-input v-model="draftFilters.keyword" clearable placeholder="编码、名称、联系人或电话" @keyup.enter="applyFilters" />
        </el-form-item>
        <el-form-item label="合作状态">
          <el-select v-model="draftFilters.status" clearable placeholder="全部状态" style="width: 150px">
            <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="applyFilters">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无供应商数据" border>
        <el-table-column prop="supplierCode" label="供应商编码" min-width="150" fixed="left" />
        <el-table-column prop="supplierName" label="供应商名称" min-width="190" />
        <el-table-column prop="address" label="地址" min-width="220" show-overflow-tooltip />
        <el-table-column prop="contactPerson" label="联系人" min-width="120" />
        <el-table-column prop="contactPhone" label="联系电话" min-width="180" />
        <el-table-column label="合作状态" width="105" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.status === 'active' ? 'success' : 'info'">{{ supplierStatusLabel(scope.row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" min-width="180" />
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openDetail(scope.row)">详情</el-button>
            <el-button v-if="canUpdate" link type="primary" @click="openEditDialog(scope.row)">编辑</el-button>
            <el-button
              v-if="canStatus"
              link
              :type="scope.row.status === 'active' ? 'danger' : 'success'"
              @click="handleStatusChange(scope.row)"
            >{{ scope.row.status === 'active' ? '踢出' : '恢复' }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="pagination.total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="loadSuppliers"
          @size-change="handlePageSizeChange"
        />
      </div>
    </el-card>

    <el-dialog v-model="formDialogVisible" :title="editingId ? '编辑供应商' : '新增供应商'" width="min(680px, 94vw)" destroy-on-close>
      <el-form ref="supplierFormRef" :model="supplierForm" :rules="supplierRules" label-width="110px">
        <el-form-item label="供应商编码" prop="supplierCode">
          <el-input v-model="supplierForm.supplierCode" maxlength="64" show-word-limit />
        </el-form-item>
        <el-form-item label="供应商名称" prop="supplierName">
          <el-input v-model="supplierForm.supplierName" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="supplierForm.address" maxlength="500" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="supplierForm.contactPerson" maxlength="100" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="supplierForm.contactPhone" type="text" maxlength="100" placeholder="可保留前导零、+、空格、连字符和分机文本" />
          <div class="field-hint">本字段按文本原样保存，不进行数值转换。</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="supplierForm.remarks" type="textarea" :rows="3" maxlength="1000" show-word-limit />
        </el-form-item>
        <el-form-item v-if="!editingId" label="初始状态">
          <el-radio-group v-model="supplierForm.status">
            <el-radio value="active">合作中</el-radio>
            <el-radio value="inactive">已踢出</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="formSaving" @click="saveSupplier">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="供应商详情" size="min(520px, 92vw)">
      <el-descriptions v-if="detailSupplier" :column="1" border>
        <el-descriptions-item label="供应商编码">{{ detailSupplier.supplierCode }}</el-descriptions-item>
        <el-descriptions-item label="供应商名称">{{ detailSupplier.supplierName }}</el-descriptions-item>
        <el-descriptions-item label="地址">{{ detailSupplier.address || '-' }}</el-descriptions-item>
        <el-descriptions-item label="联系人">{{ detailSupplier.contactPerson || '-' }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ detailSupplier.contactPhone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="合作状态">{{ supplierStatusLabel(detailSupplier.status) }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ detailSupplier.remarks || '-' }}</el-descriptions-item>
        <el-descriptions-item label="来源批次">{{ detailSupplier.sourceBatchId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="来源行号">{{ detailSupplier.sourceRowNumber || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ detailSupplier.createdAt }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ detailSupplier.updatedAt }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>

    <el-dialog v-model="importDialogVisible" title="供应商受控导入" width="min(980px, 96vw)" destroy-on-close>
      <el-alert
        title="只支持固定 Excel v1 模板。预演不写业务数据；库内已有编码会跳过，同文件重复编码会整组阻断。"
        type="info"
        show-icon
        :closable="false"
        class="import-alert"
      />
      <el-upload
        ref="uploadRef"
        :auto-upload="false"
        :limit="1"
        accept=".xlsx"
        drag
        :on-change="handleFileChange"
        :on-remove="handleFileRemove"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖入供应商 Excel，或<em>点击选择</em></div>
        <template #tip><div class="el-upload__tip">联系电话列请保持文本格式；最大文件大小受服务端统一限制。</div></template>
      </el-upload>
      <div class="import-toolbar">
        <el-button type="primary" :disabled="!selectedFile" :loading="previewLoading" @click="handlePreview">开始预演</el-button>
        <el-button
          v-if="canImportExecute"
          type="success"
          :disabled="!canExecutePreview"
          :loading="executeLoading"
          @click="handleExecute"
        >执行导入</el-button>
      </div>
      <el-alert v-if="importError" :title="importError" type="error" show-icon :closable="false" class="import-alert" />
      <template v-if="previewResult">
        <div class="summary-grid" aria-label="供应商导入预演汇总">
          <div class="summary-item"><span>总行数</span><strong>{{ previewSummary.totalRows }}</strong></div>
          <div class="summary-item success"><span>可新增</span><strong>{{ previewSummary.wouldImport }}</strong></div>
          <div class="summary-item warning"><span>跳过</span><strong>{{ previewSummary.skipped }}</strong></div>
          <div class="summary-item danger"><span>阻断</span><strong>{{ previewSummary.blocked }}</strong></div>
          <div class="summary-item warning"><span>警告</span><strong>{{ previewSummary.warnings }}</strong></div>
          <div class="summary-item danger"><span>错误</span><strong>{{ previewSummary.errors }}</strong></div>
        </div>
        <el-alert
          v-for="notice in previewResult.notices || []"
          :key="notice"
          :title="notice"
          type="warning"
          show-icon
          :closable="false"
          class="import-alert"
        />
        <el-table :data="previewResult.items || []" max-height="360" border empty-text="预演没有数据行">
          <el-table-column prop="rowNumber" label="行号" width="75" />
          <el-table-column prop="supplierCode" label="供应商编码" min-width="140" />
          <el-table-column prop="supplierName" label="供应商名称" min-width="180" />
          <el-table-column label="预演结果" width="105">
            <template #default="scope">
              <el-tag :type="previewStatusType(scope.row.status)">{{ previewStatusLabel(scope.row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="问题与警告" min-width="300">
            <template #default="scope">
              <div v-if="scope.row.issues?.length" class="issue-list">
                <span v-for="issue in scope.row.issues" :key="`${scope.row.rowNumber}-${issue.code}`">{{ issue.message }}</span>
              </div>
              <span v-else>-</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="importDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import {
  createSupplier,
  downloadSupplierTemplate,
  executeSupplierImport,
  exportSuppliers,
  getSupplier,
  getSuppliers,
  previewSupplierImport,
  updateSupplier,
  updateSupplierStatus
} from '@/api/suppliers';
import { hasPermi } from '@/utils/permission';
import {
  SUPPLIER_STATUS_OPTIONS,
  buildSupplierCreatePayload,
  buildSupplierUpdatePayload,
  canExecuteSupplierImport,
  normalizeSupplierImportSummary,
  supplierStatusLabel
} from '@/utils/supplierManagement';

// 页面筛选、分页、加载和错误状态集中维护。
const statusOptions = SUPPLIER_STATUS_OPTIONS;
const emptyFilters = () => ({ keyword: '', status: '' });
const draftFilters = reactive(emptyFilters());
const appliedFilters = ref(emptyFilters());
const rows = ref([]);
const pagination = ref({ total: 0 });
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const pageError = ref('');
const templateLoading = ref(false);
const exportLoading = ref(false);

// 前端权限仅控制交互可见性，服务端独立 RBAC 节点仍是最终授权边界。
const canCreate = computed(() => hasPermi('ledger:suppliers:create'));
const canUpdate = computed(() => hasPermi('ledger:suppliers:update'));
const canStatus = computed(() => hasPermi('ledger:suppliers:status'));
const canImportPreview = computed(() => hasPermi('ledger:suppliers:import:preview'));
const canImportExecute = computed(() => hasPermi('ledger:suppliers:import:execute'));
const canExport = computed(() => hasPermi('ledger:suppliers:export'));

// 新增与普通编辑共用表单；编辑载荷由纯函数固定排除合作状态。
const emptySupplierForm = () => ({ supplierCode: '', supplierName: '', address: '', contactPerson: '', contactPhone: '', remarks: '', status: 'active' });
const supplierForm = reactive(emptySupplierForm());
const supplierFormRef = ref(null);
const formDialogVisible = ref(false);
const formSaving = ref(false);
const editingId = ref(null);
const supplierRules = Object.freeze({
  supplierCode: [{ required: true, message: '请输入供应商编码。', trigger: 'blur' }],
  supplierName: [{ required: true, message: '请输入供应商名称。', trigger: 'blur' }]
});

// 详情抽屉只读展示完整来源和审计时间字段。
const detailVisible = ref(false);
const detailSupplier = ref(null);

// 受控导入状态不保存客户端候选作为执行输入，执行仅使用服务端批次 ID。
const importDialogVisible = ref(false);
const uploadRef = ref(null);
const selectedFile = ref(null);
const previewResult = ref(null);
const previewLoading = ref(false);
const executeLoading = ref(false);
const importError = ref('');
const previewSummary = computed(() => normalizeSupplierImportSummary(previewResult.value?.summary));
const canExecutePreview = computed(() => canExecuteSupplierImport(previewResult.value));

/** 返回稳定错误文案。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 按当前已应用筛选加载供应商分页。 */
async function loadSuppliers() {
  loading.value = true;
  pageError.value = '';
  try {
    const response = await getSuppliers({ ...appliedFilters.value, page: page.value, pageSize: pageSize.value });
    rows.value = Array.isArray(response.data) ? response.data : [];
    pagination.value = response.meta?.pagination || { total: rows.value.length };
  } catch (error) {
    pageError.value = errorMessage(error, '供应商列表加载失败。');
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

/** 应用筛选并回到第一页。 */
function applyFilters() {
  appliedFilters.value = { keyword: draftFilters.keyword.trim(), status: draftFilters.status };
  page.value = 1;
  loadSuppliers();
}

/** 清空筛选并重新加载。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  appliedFilters.value = emptyFilters();
  page.value = 1;
  loadSuppliers();
}

/** 调整分页大小并回到第一页。 */
function handlePageSizeChange() {
  page.value = 1;
  loadSuppliers();
}

/** 重置并打开新增供应商表单。 */
function openCreateDialog() {
  editingId.value = null;
  Object.assign(supplierForm, emptySupplierForm());
  formDialogVisible.value = true;
}

/** 将当前行投影到普通编辑表单。 */
function openEditDialog(row) {
  editingId.value = row.id;
  Object.assign(supplierForm, emptySupplierForm(), row);
  formDialogVisible.value = true;
}

/** 校验并保存新增或普通编辑供应商。 */
async function saveSupplier() {
  const valid = await supplierFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  formSaving.value = true;
  try {
    if (editingId.value) {
      await updateSupplier(editingId.value, buildSupplierUpdatePayload(supplierForm));
      ElMessage.success('供应商信息已更新。');
    } else {
      await createSupplier(buildSupplierCreatePayload(supplierForm));
      ElMessage.success('供应商已新增。');
    }
    formDialogVisible.value = false;
    await loadSuppliers();
  } catch (error) {
    ElMessage.error(errorMessage(error, '供应商保存失败。'));
  } finally {
    formSaving.value = false;
  }
}

/** 读取并打开供应商详情。 */
async function openDetail(row) {
  try {
    const response = await getSupplier(row.id);
    detailSupplier.value = response.data;
    detailVisible.value = true;
  } catch (error) {
    ElMessage.error(errorMessage(error, '供应商详情加载失败。'));
  }
}

/** 二次确认后通过专用接口踢出或恢复合作状态。 */
async function handleStatusChange(row) {
  const nextStatus = row.status === 'active' ? 'inactive' : 'active';
  const actionLabel = nextStatus === 'inactive' ? '踢出' : '恢复';
  try {
    await ElMessageBox.confirm(
      `确认${actionLabel}供应商“${row.supplierName}（${row.supplierCode}）”吗？`,
      `${actionLabel}供应商`,
      { confirmButtonText: `确认${actionLabel}`, cancelButtonText: '取消', type: nextStatus === 'inactive' ? 'warning' : 'success' }
    );
    await updateSupplierStatus(row.id, nextStatus);
    ElMessage.success(`供应商已${actionLabel}。`);
    await loadSuppliers();
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(errorMessage(error, `供应商${actionLabel}失败。`));
  }
}

/** 下载权限保护的固定 Excel v1 模板。 */
async function handleDownloadTemplate() {
  templateLoading.value = true;
  try {
    await downloadSupplierTemplate();
    ElMessage.success('供应商模板下载已触发。');
  } catch (error) {
    ElMessage.error(errorMessage(error, '供应商模板下载失败。'));
  } finally {
    templateLoading.value = false;
  }
}

/** 按当前筛选导出供应商台账。 */
async function handleExport() {
  exportLoading.value = true;
  try {
    await exportSuppliers(appliedFilters.value);
    ElMessage.success('供应商导出已触发。');
  } catch (error) {
    ElMessage.error(errorMessage(error, '供应商导出失败。'));
  } finally {
    exportLoading.value = false;
  }
}

/** 打开导入对话框并清空上一次预演状态。 */
function openImportDialog() {
  selectedFile.value = null;
  previewResult.value = null;
  importError.value = '';
  importDialogVisible.value = true;
}

/** 保存用户选择的原始 XLSX 文件。 */
function handleFileChange(uploadFile) {
  selectedFile.value = uploadFile?.raw || null;
  previewResult.value = null;
  importError.value = '';
}

/** 清空已选文件和对应预演。 */
function handleFileRemove() {
  selectedFile.value = null;
  previewResult.value = null;
}

/** 上传原文件并显示服务端重算、签名且持久化的预演。 */
async function handlePreview() {
  if (!selectedFile.value) return;
  previewLoading.value = true;
  importError.value = '';
  previewResult.value = null;
  try {
    const response = await previewSupplierImport(selectedFile.value);
    previewResult.value = response.data;
    ElMessage.success('供应商导入预演已完成。');
  } catch (error) {
    importError.value = errorMessage(error, '供应商导入预演失败。');
  } finally {
    previewLoading.value = false;
  }
}

/** 二次确认后仅凭服务端批次 ID 执行受控导入。 */
async function handleExecute() {
  if (!canExecutePreview.value) return;
  try {
    await ElMessageBox.confirm(
      `将新增 ${previewSummary.value.wouldImport} 条供应商，跳过 ${previewSummary.value.skipped} 条。系统会先创建备份，是否继续？`,
      '执行供应商导入',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    );
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    throw error;
  }
  executeLoading.value = true;
  importError.value = '';
  try {
    const response = await executeSupplierImport(previewResult.value.batchId);
    ElMessage.success(`供应商导入完成，新增 ${Number(response.data?.imported || 0)} 条。`);
    importDialogVisible.value = false;
    await loadSuppliers();
  } catch (error) {
    importError.value = errorMessage(error, '供应商导入执行失败，业务数据未写入或已回滚。');
  } finally {
    executeLoading.value = false;
  }
}

/** 返回预演行结果中文名称。 */
function previewStatusLabel(status) {
  return { wouldImport: '可新增', skipped: '跳过', blocked: '阻断' }[status] || '未知';
}

/** 返回预演行结果标签样式。 */
function previewStatusType(status) {
  return { wouldImport: 'success', skipped: 'warning', blocked: 'danger' }[status] || 'info';
}

onMounted(loadSuppliers);
</script>

<style scoped>
.supplier-page { padding: 20px; }
.page-card { min-width: 0; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; flex-wrap: wrap; }
.page-header h2 { margin: 0 0 8px; font-size: 22px; color: var(--el-text-color-primary); }
.page-header p { margin: 0; color: var(--el-text-color-secondary); line-height: 1.6; }
.header-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.filter-form { margin-bottom: 4px; }
.page-alert, .import-alert { margin-bottom: 16px; }
.pagination-wrap { display: flex; justify-content: flex-end; margin-top: 18px; overflow-x: auto; }
.field-hint { width: 100%; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; margin-top: 4px; }
.import-toolbar { display: flex; gap: 10px; margin: 16px 0; }
.summary-grid { display: grid; grid-template-columns: repeat(6, minmax(100px, 1fr)); gap: 10px; margin: 16px 0; }
.summary-item { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 12px; background: var(--el-fill-color-light); }
.summary-item span { display: block; color: var(--el-text-color-secondary); font-size: 13px; }
.summary-item strong { display: block; margin-top: 6px; font-size: 22px; }
.summary-item.success strong { color: var(--el-color-success); }
.summary-item.warning strong { color: var(--el-color-warning); }
.summary-item.danger strong { color: var(--el-color-danger); }
.issue-list { display: flex; flex-direction: column; gap: 4px; color: var(--el-color-danger); line-height: 1.5; }
@media (max-width: 900px) {
  .supplier-page { padding: 12px; }
  .summary-grid { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
  .header-actions { width: 100%; }
  .header-actions :deep(.el-button) { margin-left: 0; }
}
</style>
