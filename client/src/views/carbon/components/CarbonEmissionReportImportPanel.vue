<template>
  <el-dialog
    :model-value="modelValue"
    title="碳排放报告固定 Excel v1 受控导入"
    width="min(1040px, 96vw)"
    destroy-on-close
    @update:model-value="updateVisible"
    @closed="resetImportState"
  >
    <el-alert
      title="仅支持固定 XLSX v1，五张工作表必须依次为：报告信息、组织与核算边界、报告项目、汇总、证据说明。禁止使用含 / 的非法工作表名，也不得增加、删除或重排工作表。"
      type="info"
      show-icon
      :closable="false"
      class="panel-alert"
    />
    <div class="panel-actions">
      <el-button :loading="templateLoading" @click="handleDownloadTemplate">下载固定 XLSX v1 模板</el-button>
    </div>
    <el-upload
      ref="uploadRef"
      :auto-upload="false"
      :limit="1"
      accept=".xlsx"
      drag
      :on-change="handleFileChange"
      :on-remove="handleFileRemove"
      :on-exceed="handleFileExceed"
      :disabled="previewLoading || executeLoading"
    >
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖入碳排放报告 XLSX，或<em>点击选择</em></div>
      <template #tip>
        <div class="el-upload__tip">预演会保存原文件和统一批次审计，但不会写报告五表，也不会反写碳活动、核算运行、核算结果、旧碳排或碳因子。</div>
      </template>
    </el-upload>
    <div class="panel-actions">
      <el-button type="primary" :disabled="!selectedFile" :loading="previewLoading" @click="handlePreview">开始预演</el-button>
      <el-button
        v-if="canImportExecute"
        type="success"
        :disabled="!canExecutePreview"
        :loading="executeLoading"
        @click="confirmExecute"
      >执行导入</el-button>
    </div>
    <el-alert
      title="执行边界：服务端会重读当前原文件、重算候选与见证、检查 stale，并在 BEGIN IMMEDIATE 锁内再次校验；随后以 carbon-emission-report-import 原因创建写前备份，在同一事务中原子写入报告五表和审计。重复报告编码直接阻断，不覆盖、不 skip。"
      type="warning"
      show-icon
      :closable="false"
      class="panel-alert execution-boundary-alert"
    />
    <el-alert v-if="importError" :title="importError" type="error" show-icon :closable="false" class="panel-alert" />

    <template v-if="previewResult">
      <section class="summary-grid" aria-label="碳排放报告导入预演汇总">
        <div class="summary-item"><span>报告数</span><strong>{{ previewSummary.totalRows }}</strong></div>
        <div class="summary-item success"><span>可导入</span><strong>{{ previewSummary.wouldImport }}</strong></div>
        <div class="summary-item warning"><span>跳过</span><strong>{{ previewSummary.skipped }}</strong></div>
        <div class="summary-item danger"><span>阻断</span><strong>{{ previewSummary.blocked }}</strong></div>
        <div class="summary-item warning"><span>警告</span><strong>{{ previewSummary.warnings }}</strong></div>
        <div class="summary-item danger"><span>错误</span><strong>{{ previewSummary.errors }}</strong></div>
      </section>
      <p class="preview-boundary-note">本次汇总只代表当前服务端预演。页面只保留展示所需的报告标识、计数、问题与批次编号，不展示或提交服务端内部安全链；执行前仍须输入固定确认文本“{{ confirmText }}”。</p>
      <el-alert
        v-for="notice in previewResult.notices"
        :key="notice"
        :title="notice"
        type="warning"
        show-icon
        :closable="false"
        class="panel-alert"
      />
      <el-table :data="previewResult.items" max-height="380" border empty-text="预演没有报告候选">
        <el-table-column prop="rowNumber" label="报告信息行" width="110" />
        <el-table-column prop="reportCode" label="报告编码" min-width="160" />
        <el-table-column prop="reportName" label="报告名称" min-width="190" />
        <el-table-column label="五部分行数" min-width="260">
          <template #default="scope">
            边界 {{ scope.row.counts.boundaries }} / 项目 {{ scope.row.counts.items }} /
            汇总 {{ scope.row.counts.summaries }} / 证据 {{ scope.row.counts.evidence }}
          </template>
        </el-table-column>
        <el-table-column label="预演结果" width="100">
          <template #default="scope"><el-tag :type="previewStatusType(scope.row.status)">{{ previewStatusLabel(scope.row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="问题与警告" min-width="360">
          <template #default="scope">
            <div v-if="scope.row.issues.length" class="issue-list">
              <span v-for="issue in scope.row.issues" :key="`${scope.row.rowNumber}-${issue.fieldName}-${issue.code}`">
                {{ issue.fieldName || '工作簿' }}：{{ issue.message }}<small v-if="issue.code">（{{ issue.code }}）</small>
              </span>
            </div>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        v-if="previewSummary.wouldImport === 0"
        title="当前预演没有可导入报告，执行按钮保持禁用。请修正工作表、表头、公式、资源限制、跨表引用、汇总或重复报告编码问题后重新预演。"
        type="warning"
        show-icon
        :closable="false"
        class="panel-alert empty-preview-alert"
      />
    </template>

    <template #footer><el-button @click="updateVisible(false)">关闭</el-button></template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import {
  downloadCarbonEmissionReportTemplate,
  executeCarbonEmissionReportImport,
  previewCarbonEmissionReportImport
} from '@/api/carbonEmissionReports';
import {
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  buildCarbonEmissionReportExecuteFailureState,
  buildCarbonEmissionReportImportExecutePayload,
  canExecuteCarbonEmissionReportImport,
  isCarbonEmissionReportPreviewStaleError,
  isCarbonEmissionReportXlsxFile,
  normalizeCarbonEmissionReportImportSummary,
  projectCarbonEmissionReportPreview,
  runLatestCarbonEmissionReportRequest
} from '@/utils/carbonEmissionReportManagement';
import { hasPermi } from '@/utils/permission';
import { nextRequestGeneration } from '@/utils/requestGeneration';

// 组件属性模块：父组件控制对话框可见性。
const props = defineProps({ modelValue: { type: Boolean, default: false } });
// 组件事件模块：关闭状态和导入完成通知由父组件处理。
const emit = defineEmits(['update:modelValue', 'imported']);

// 上传组件引用：关闭或拒绝错误扩展名时清理文件列表。
const uploadRef = ref(null);
// 当前原始 XLSX 文件：重新选择同一文件也会形成新的预演意图。
const selectedFile = ref(null);
// 安全预演投影：不保留候选、签名、摘要见证或内部审计字段。
const previewResult = ref(null);
// 模板下载加载状态：仅最新下载请求可提交消息和 finally。
const templateLoading = ref(false);
// 预演加载状态：文件变化、关闭或新请求都会使旧 finally 失效。
const previewLoading = ref(false);
// 执行加载状态：关闭、切板块或新执行意图都会使旧结果失效。
const executeLoading = ref(false);
// 导入区域错误：展示共享 HTTP 层恢复的服务端中文错误。
const importError = ref('');
// 当前预演所属世代：execute 只能使用与当前文件世代一致的服务端批次。
const committedPreviewGeneration = ref(0);
// 模板下载请求世代：关闭对话框后旧下载响应不再更新页面状态。
let templateRequestGeneration = 0;
// 预演请求世代：换文件、移除、关闭和新预演都会使旧响应、错误与 finally 失效。
let previewRequestGeneration = 0;
// 执行请求世代：关闭或重新执行后旧响应、错误与 finally 不得提交。
let executeRequestGeneration = 0;

// 固定确认文本：页面和最小 execute 载荷使用同一冻结常量。
const confirmText = CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT;
// 导入执行权限：前端只控制按钮可见性，服务端仍是最终授权边界。
const canImportExecute = computed(() => hasPermi('carbon:emission-reports:import:execute'));
// 预演汇总：缺省字段稳定显示真实零。
const previewSummary = computed(() => normalizeCarbonEmissionReportImportSummary(previewResult.value?.summary));
// 执行可用性：必须有当前文件世代、执行权限和唯一可导入原子报告。
const canExecutePreview = computed(() => (
  canImportExecute.value
  && committedPreviewGeneration.value === previewRequestGeneration
  && selectedFile.value !== null
  && canExecuteCarbonEmissionReportImport(previewResult.value)
));

// 方法模块：错误投影、请求失效、文件、模板、预演和执行。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 使当前模板下载请求失效并清除 loading。 */
function invalidateTemplateRequest() {
  templateRequestGeneration = nextRequestGeneration(templateRequestGeneration);
  templateLoading.value = false;
}

/** 使当前预演世代失效并清空所有可执行状态。 */
function invalidatePreviewState(clearError = true) {
  previewRequestGeneration = nextRequestGeneration(previewRequestGeneration);
  committedPreviewGeneration.value = 0;
  previewLoading.value = false;
  previewResult.value = null;
  if (clearError) importError.value = '';
}

/** 使当前执行世代失效并清除 loading。 */
function invalidateExecuteRequest() {
  executeRequestGeneration = nextRequestGeneration(executeRequestGeneration);
  executeLoading.value = false;
}

/** 应用 execute 非取消失败的 fail-closed 状态，并保留稳定错误提示。 */
function applyExecuteFailureState(message) {
  const failureState = buildCarbonEmissionReportExecuteFailureState(message);
  invalidatePreviewState(false);
  previewResult.value = failureState.previewResult;
  committedPreviewGeneration.value = failureState.committedPreviewGeneration;
  importError.value = failureState.importError;
}

/** 关闭或切板块时同时废弃模板、预演和执行请求。 */
function invalidateAllRequests() {
  invalidateTemplateRequest();
  invalidatePreviewState();
  invalidateExecuteRequest();
}

/** 更新父组件控制的对话框可见性；开始关闭时立即使全部在途请求失效。 */
function updateVisible(value) {
  const nextVisible = Boolean(value);
  if (!nextVisible) invalidateAllRequests();
  emit('update:modelValue', nextVisible);
}

/** 关闭后清空文件、预演和错误，避免误用旧批次。 */
function resetImportState() {
  invalidateAllRequests();
  selectedFile.value = null;
  uploadRef.value?.clearFiles?.();
}

/** 保存用户当前选择的原始 XLSX 文件并废弃旧预演。 */
function handleFileChange(uploadFile) {
  invalidatePreviewState();
  invalidateExecuteRequest();
  const rawFile = uploadFile?.raw || null;
  if (!isCarbonEmissionReportXlsxFile(rawFile)) {
    selectedFile.value = null;
    importError.value = '碳排放报告仅接受 .xlsx 文件，请重新选择固定 Excel v1 工作簿。';
    uploadRef.value?.clearFiles?.();
    return;
  }
  selectedFile.value = rawFile;
}

/** 同一文件或第二个文件再次选择时替换旧文件，并形成新的预演意图。 */
function handleFileExceed(files) {
  const rawFile = Array.isArray(files) ? files[0] : null;
  invalidatePreviewState();
  invalidateExecuteRequest();
  selectedFile.value = null;
  uploadRef.value?.clearFiles?.();
  if (!isCarbonEmissionReportXlsxFile(rawFile)) {
    importError.value = '碳排放报告仅接受 .xlsx 文件，请重新选择固定 Excel v1 工作簿。';
    return;
  }
  selectedFile.value = rawFile;
  uploadRef.value?.handleStart?.(rawFile);
}

/** 移除当前文件并废弃对应预演与执行意图。 */
function handleFileRemove() {
  invalidatePreviewState();
  invalidateExecuteRequest();
  selectedFile.value = null;
}

/** 下载权限保护的固定五工作表 XLSX v1 模板。 */
async function handleDownloadTemplate() {
  templateRequestGeneration = nextRequestGeneration(templateRequestGeneration);
  const requestGeneration = templateRequestGeneration;
  templateLoading.value = true;
  await runLatestCarbonEmissionReportRequest({
    requestGeneration,
    getCurrentGeneration: () => templateRequestGeneration,
    isActive: () => props.modelValue,
    request: downloadCarbonEmissionReportTemplate,
    onSuccess: () => ElMessage.success('碳排放报告固定模板下载已触发。'),
    onError: (error) => ElMessage.error(errorMessage(error, '碳排放报告模板下载失败。')),
    onFinally: () => { templateLoading.value = false; }
  });
}

/** 上传当前原文件并显示安全预演投影，仅当前文件最新世代可提交。 */
async function handlePreview() {
  const previewFile = selectedFile.value;
  if (!previewFile || !isCarbonEmissionReportXlsxFile(previewFile)) return;
  previewRequestGeneration = nextRequestGeneration(previewRequestGeneration);
  const requestGeneration = previewRequestGeneration;
  previewLoading.value = true;
  committedPreviewGeneration.value = 0;
  importError.value = '';
  previewResult.value = null;
  await runLatestCarbonEmissionReportRequest({
    requestGeneration,
    getCurrentGeneration: () => previewRequestGeneration,
    isActive: () => props.modelValue,
    canCommit: () => selectedFile.value === previewFile,
    request: () => previewCarbonEmissionReportImport(previewFile),
    onSuccess: (response) => {
      previewResult.value = projectCarbonEmissionReportPreview(response.data || {});
      committedPreviewGeneration.value = requestGeneration;
      ElMessage.success('碳排放报告导入预演已完成。');
    },
    onError: (error) => {
      previewResult.value = null;
      committedPreviewGeneration.value = 0;
      importError.value = errorMessage(error, '碳排放报告导入预演失败。');
    },
    onFinally: () => { previewLoading.value = false; }
  });
}

/** 要求用户输入固定确认文本后，仅提交当前世代的四字段最小载荷。 */
async function confirmExecute() {
  if (!canExecutePreview.value) return;
  // 执行快照：确认框打开期间文件、预演或对话框状态变化时必须拒绝旧批次。
  const executePreview = previewResult.value;
  const executePreviewGeneration = committedPreviewGeneration.value;
  try {
    await ElMessageBox.prompt(
      `将导入报告“${executePreview.items[0]?.reportCode || '未命名'}”。服务端会重读文件、重算见证、检查 stale、创建写前备份，并在同一事务中写入五部分报告事实。请输入固定确认文本：${confirmText}`,
      '执行碳排放报告导入',
      {
        confirmButtonText: '确认执行',
        cancelButtonText: '取消',
        inputPlaceholder: confirmText,
        inputValidator: (value) => value === confirmText ? true : `请输入“${confirmText}”。`,
        type: 'warning'
      }
    );
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    throw error;
  }
  if (!canExecutePreview.value
    || previewResult.value !== executePreview
    || committedPreviewGeneration.value !== executePreviewGeneration) {
    importError.value = '预演已因文件、板块或对话框状态变化失效，请重新预演后再执行。';
    return;
  }

  executeRequestGeneration = nextRequestGeneration(executeRequestGeneration);
  const requestGeneration = executeRequestGeneration;
  executeLoading.value = true;
  importError.value = '';
  await runLatestCarbonEmissionReportRequest({
    requestGeneration,
    getCurrentGeneration: () => executeRequestGeneration,
    isActive: () => props.modelValue,
    canCommit: () => previewResult.value === executePreview,
    request: () => executeCarbonEmissionReportImport(
      buildCarbonEmissionReportImportExecutePayload(executePreview)
    ),
    onSuccess: (response) => {
      ElMessage.success(`碳排放报告导入完成，新增 ${Number(response.data?.imported || 0)} 份。`);
      updateVisible(false);
      emit('imported', {
        imported: Number(response.data?.imported || 0),
        importedIds: Array.isArray(response.data?.importedIds) ? [...response.data.importedIds] : []
      });
    },
    onError: (error) => {
      const failureMessage = isCarbonEmissionReportPreviewStaleError(error)
        ? '碳排放报告预演已失效，请重新预演后再执行。'
        : errorMessage(error, '碳排放报告导入执行失败，报告事实未写入或已回滚。');
      applyExecuteFailureState(failureMessage);
    },
    onFinally: () => { executeLoading.value = false; }
  });
}

/** 返回预演状态中文名称。 */
function previewStatusLabel(status) {
  return { wouldImport: '可导入', skipped: '跳过', blocked: '阻断' }[status] || '未知';
}

/** 返回预演状态标签类型。 */
function previewStatusType(status) {
  return { wouldImport: 'success', skipped: 'warning', blocked: 'danger' }[status] || 'info';
}

// 可见性监听模块：父组件直接切板块或关闭对话框时也必须立即废弃在途请求。
watch(() => props.modelValue, (visible) => {
  if (!visible) invalidateAllRequests();
});

// 组件卸载模块：立即废弃模板、预演和执行世代，禁止旧请求回填已销毁对话框。
onBeforeUnmount(invalidateAllRequests);
</script>

<style scoped>
.panel-alert{margin-bottom:14px}.panel-actions{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.execution-boundary-alert{border-width:2px}.preview-boundary-note{margin:0 0 14px;padding:10px 12px;color:var(--el-color-warning-dark-2);background:var(--el-color-warning-light-9);border-radius:8px;line-height:1.6}.summary-grid{display:grid;grid-template-columns:repeat(6,minmax(90px,1fr));gap:10px;margin:16px 0}.summary-item{display:grid;gap:4px;padding:12px;background:var(--el-fill-color-light);border:1px solid var(--el-border-color);border-radius:8px}.summary-item span{color:var(--el-text-color-secondary);font-size:12px}.summary-item strong{font-size:20px}.summary-item.success strong{color:var(--el-color-success)}.summary-item.warning strong{color:var(--el-color-warning)}.summary-item.danger strong{color:var(--el-color-danger)}.issue-list{display:grid;gap:6px}.issue-list small{color:var(--el-text-color-secondary)}.empty-preview-alert{margin-top:14px}@media (max-width:760px){.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
