<template>
  <el-dialog
    :model-value="modelValue"
    title="独立碳活动固定 Excel v1 受控导入"
    width="min(1040px, 96vw)"
    destroy-on-close
    @update:model-value="updateVisible"
    @closed="resetImportState"
  >
    <el-alert
      title="仅支持固定 XLSX v1：一张“独立碳活动”工作表和 15 列精确中文表头。来源墙钟必须为 YYYY-MM-DDTHH:mm，并提供有效 IANA 来源时区；不要在墙钟值后追加 Z。"
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
      :disabled="previewLoading || executeLoading"
    >
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖入独立碳活动 XLSX，或<em>点击选择</em></div>
      <template #tip>
        <div class="el-upload__tip">预演会保存原文件和统一批次审计，但不会写活动事实、计算运行或核算结果。</div>
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
      title="执行边界：服务端会重读当前原文件、重算并核对候选见证与 stale 状态，写入前强制备份；业务写入与审计在同一事务中，任一步失败都会回滚。skip 行不会覆盖、更新或恢复既有事实。"
      type="warning"
      show-icon
      :closable="false"
      class="panel-alert execution-boundary-alert"
    />
    <el-alert v-if="importError" :title="importError" type="error" show-icon :closable="false" class="panel-alert" />

    <template v-if="previewResult">
      <section class="summary-grid" aria-label="独立碳活动导入预演汇总">
        <div class="summary-item"><span>总行数</span><strong>{{ previewSummary.totalRows }}</strong></div>
        <div class="summary-item success"><span>可导入</span><strong>{{ previewSummary.wouldImport }}</strong></div>
        <div class="summary-item warning"><span>跳过</span><strong>{{ previewSummary.skipped }}</strong></div>
        <div class="summary-item danger"><span>阻断</span><strong>{{ previewSummary.blocked }}</strong></div>
        <div class="summary-item warning"><span>警告</span><strong>{{ previewSummary.warnings }}</strong></div>
        <div class="summary-item danger"><span>错误</span><strong>{{ previewSummary.errors }}</strong></div>
      </section>
      <p class="preview-boundary-note">本次汇总仅说明当前预演候选：执行时服务端仍会重读原文件、重算候选见证、检查 stale、创建写前备份并在失败时事务回滚；{{ previewSummary.skipped }} 条 skip 不会自动更新、覆盖或恢复既有活动事实。</p>
      <el-alert
        v-for="notice in previewResult.notices || []"
        :key="notice"
        :title="notice"
        type="warning"
        show-icon
        :closable="false"
        class="panel-alert"
      />
      <el-table :data="previewResult.items || []" max-height="380" border empty-text="预演没有数据行">
        <el-table-column prop="rowNumber" label="行号" width="72" />
        <el-table-column prop="activityCode" label="活动记录编码" min-width="150" />
        <el-table-column prop="emissionScope" label="排放范围" min-width="100" />
        <el-table-column prop="organizationUnitCode" label="用能单元" min-width="120" />
        <el-table-column prop="energyTypeCode" label="能源类型" min-width="110" />
        <el-table-column label="来源墙钟" min-width="210">
          <template #default="scope">{{ formatSourceWallClock(scope.row.startWallClock) }} 至 {{ formatSourceWallClock(scope.row.endWallClock) }}</template>
        </el-table-column>
        <el-table-column label="预演结果" width="100">
          <template #default="scope"><el-tag :type="previewStatusType(scope.row.status)">{{ previewStatusLabel(scope.row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="问题与警告" min-width="300">
          <template #default="scope">
            <div v-if="scope.row.issues?.length" class="issue-list">
              <span v-for="issue in scope.row.issues" :key="`${scope.row.rowNumber}-${issue.code}`">{{ issue.message }}</span>
            </div>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        v-if="previewSummary.wouldImport === 0"
        title="当前预演没有可导入候选，执行按钮保持禁用。请修正阻断项或确认数据库重复记录后重新预演。"
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
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import {
  downloadCarbonActivityTemplate,
  executeCarbonActivityImport,
  previewCarbonActivityImport
} from '@/api/carbonActivities';
import {
  buildCarbonActivityImportExecutePayload,
  canExecuteCarbonActivityImport,
  formatSourceWallClock,
  normalizeCarbonActivityImportSummary
} from '@/utils/carbonActivityManagement';
import { hasPermi } from '@/utils/permission';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';

// 组件属性模块：父组件控制对话框可见性。
const props = defineProps({ modelValue: { type: Boolean, default: false } });
// 组件事件模块：关闭状态和导入完成通知由父组件处理。
const emit = defineEmits(['update:modelValue', 'imported']);

// 文件选择状态：只保留当前原始 XLSX 文件，不信任客户端候选作为 execute 输入。
const uploadRef = ref(null);
// 当前选择文件：移除或重新选择时必须清空旧预演。
const selectedFile = ref(null);
// 服务端预演结果：包含批次、汇总、行级状态和展示用候选。
const previewResult = ref(null);
// 模板下载加载状态：避免重复触发下载。
const templateLoading = ref(false);
// 预演加载状态：用于按钮 loading 和重复提交保护。
const previewLoading = ref(false);
// 执行加载状态：用于按钮 loading 和重复提交保护。
const executeLoading = ref(false);
// 导入区域错误：始终优先展示服务端真实中文消息。
const importError = ref('');
// 预演请求世代：换文件、移除文件或关闭对话框都会使旧响应失效。
let previewRequestGeneration = 0;
// 当前预演所属世代：execute 只能使用与当前文件世代一致的服务端批次。
const committedPreviewGeneration = ref(0);

// 导入执行权限：前端只控制按钮可见性，服务端仍是最终授权边界。
const canImportExecute = computed(() => hasPermi('carbon:activities:import:execute'));
// 预演汇总：缺省字段稳定显示真实零。
const previewSummary = computed(() => normalizeCarbonActivityImportSummary(previewResult.value?.summary));
// 执行可用性：必须有当前文件世代的正批次和至少一条可导入候选。
const canExecutePreview = computed(() => (
  committedPreviewGeneration.value === previewRequestGeneration
  && selectedFile.value !== null
  && canExecuteCarbonActivityImport(previewResult.value)
));

// 方法模块：错误投影、对话框状态、模板、预演和执行。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 使当前预演世代失效并清空所有可执行状态。 */
function invalidatePreviewState() {
  previewRequestGeneration = nextRequestGeneration(previewRequestGeneration);
  committedPreviewGeneration.value = 0;
  previewLoading.value = false;
  previewResult.value = null;
  importError.value = '';
}

/** 更新父组件控制的对话框可见性；开始关闭时立即使在途预演失效。 */
function updateVisible(value) {
  const nextVisible = Boolean(value);
  if (!nextVisible) invalidatePreviewState();
  emit('update:modelValue', nextVisible);
}

/** 关闭后清空文件、预演和错误，避免误用旧批次。 */
function resetImportState() {
  invalidatePreviewState();
  selectedFile.value = null;
  uploadRef.value?.clearFiles?.();
}

/** 保存用户当前选择的原始 XLSX 文件并废弃旧预演。 */
function handleFileChange(uploadFile) {
  invalidatePreviewState();
  selectedFile.value = uploadFile?.raw || null;
}

/** 移除当前文件并废弃对应预演。 */
function handleFileRemove() {
  invalidatePreviewState();
  selectedFile.value = null;
}

/** 下载权限保护的固定 XLSX v1 模板。 */
async function handleDownloadTemplate() {
  templateLoading.value = true;
  try {
    await downloadCarbonActivityTemplate();
    ElMessage.success('独立碳活动固定模板下载已触发。');
  } catch (error) {
    ElMessage.error(errorMessage(error, '独立碳活动模板下载失败。'));
  } finally {
    templateLoading.value = false;
  }
}

/** 上传当前原文件并显示服务端持久化预演，仅当前文件最新世代可提交。 */
async function handlePreview() {
  const previewFile = selectedFile.value;
  if (!previewFile) return;
  previewRequestGeneration = nextRequestGeneration(previewRequestGeneration);
  const requestGeneration = previewRequestGeneration;
  previewLoading.value = true;
  committedPreviewGeneration.value = 0;
  importError.value = '';
  previewResult.value = null;
  try {
    const response = await previewCarbonActivityImport(previewFile);
    if (!isLatestRequestGeneration(requestGeneration, previewRequestGeneration)
      || selectedFile.value !== previewFile
      || !props.modelValue) return;
    previewResult.value = response.data || null;
    committedPreviewGeneration.value = requestGeneration;
    ElMessage.success('独立碳活动导入预演已完成。');
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, previewRequestGeneration)
      || selectedFile.value !== previewFile
      || !props.modelValue) return;
    importError.value = errorMessage(error, '独立碳活动导入预演失败。');
  } finally {
    if (isLatestRequestGeneration(requestGeneration, previewRequestGeneration)) previewLoading.value = false;
  }
}

/** 二次确认后仅提交当前世代的四字段最小载荷执行受控导入。 */
async function confirmExecute() {
  if (!canExecutePreview.value) return;
  // 执行快照：确认框打开期间文件或对话框状态变化时必须拒绝旧批次。
  const executePreview = previewResult.value;
  const executePreviewGeneration = committedPreviewGeneration.value;
  try {
    await ElMessageBox.confirm(
      `将导入 ${previewSummary.value.wouldImport} 条独立碳活动，跳过 ${previewSummary.value.skipped} 条。服务端会重读原文件、重算候选见证、校验 stale，写入前创建备份，并在任一步失败时事务回滚。skip 行不会覆盖或恢复既有事实。是否继续？`,
      '执行独立碳活动导入',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    );
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    throw error;
  }
  if (!canExecutePreview.value
    || previewResult.value !== executePreview
    || committedPreviewGeneration.value !== executePreviewGeneration) {
    importError.value = '预演已因文件或对话框状态变化失效，请重新预演后再执行。';
    return;
  }
  executeLoading.value = true;
  importError.value = '';
  try {
    // 最小载荷：禁止附带 previewSignature、candidateRows、candidateRowIds 或 auditDigest。
    const payload = buildCarbonActivityImportExecutePayload(executePreview);
    const response = await executeCarbonActivityImport(payload);
    ElMessage.success(`独立碳活动导入完成，新增 ${Number(response.data?.imported || 0)} 条。`);
    updateVisible(false);
    emit('imported');
  } catch (error) {
    importError.value = errorMessage(error, '独立碳活动导入执行失败，业务数据未写入或已回滚。');
  } finally {
    executeLoading.value = false;
  }
}

/** 返回预演行状态中文名称。 */
function previewStatusLabel(status) {
  return { wouldImport: '可导入', skipped: '跳过', blocked: '阻断' }[status] || '未知';
}

/** 返回预演行状态标签类型。 */
function previewStatusType(status) {
  return { wouldImport: 'success', skipped: 'warning', blocked: 'danger' }[status] || 'info';
}
</script>

<style scoped>
.panel-alert{margin-bottom:14px}.panel-actions{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.execution-boundary-alert{border-width:2px}.preview-boundary-note{margin:0 0 14px;padding:10px 12px;color:var(--el-color-warning-dark-2);background:var(--el-color-warning-light-9);border-radius:8px;line-height:1.6}.summary-grid{display:grid;grid-template-columns:repeat(6,minmax(90px,1fr));gap:10px;margin:16px 0}.summary-item{display:grid;gap:4px;padding:12px;background:var(--el-fill-color-light);border:1px solid var(--el-border-color);border-radius:8px}.summary-item span{color:var(--el-text-color-secondary);font-size:12px}.summary-item strong{font-size:20px}.summary-item.success strong{color:var(--el-color-success)}.summary-item.warning strong{color:var(--el-color-warning)}.summary-item.danger strong{color:var(--el-color-danger)}.issue-list{display:grid;gap:4px}.empty-preview-alert{margin-top:14px}@media (max-width:760px){.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
