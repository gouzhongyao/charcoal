<template>
  <ManagementPage title="系统与备份恢复">
    <template #title-extra><HelpIcon label="查看备份恢复安全边界" content="备份恢复是高风险本地操作。恢复前服务端会校验备份、创建 pre-restore 备份并进入维护态；页面绝不将失败响应显示为成功，也不展示服务器文件路径。请仅在隔离 SQLite 副本演练恢复。" /></template>
    <PageState v-if="!canView" description="当前账号没有查看系统备份恢复的权限。请联系管理员授予 system:backup:view 权限。" />
    <template v-else>
      <el-alert type="warning" :closable="false" show-icon title="恢复会替换当前本地 SQLite 数据。请先下载可回滚备份，并仅在隔离数据库完成恢复演练；真实业务库恢复需另行授权。" />
      <el-alert v-if="operationError" type="error" :closable="false" show-icon :title="operationError" class="panel-alert" />
      <section class="system-grid">
        <article class="page-card"><header class="chart-heading"><h2>本地运行状态</h2></header><PageState v-if="bootstrapLoading" loading /><el-descriptions v-else-if="bootstrapInfo" :column="1" border><el-descriptions-item label="应用">{{ bootstrapInfo.appName }}</el-descriptions-item><el-descriptions-item label="存储模式">{{ bootstrapInfo.mode }}</el-descriptions-item><el-descriptions-item label="维护状态"><el-tag :type="bootstrapInfo.maintenanceActive ? 'warning' : 'success'">{{ bootstrapInfo.maintenanceActive ? '维护中' : '可用' }}</el-tag><span v-if="bootstrapInfo.maintenanceReason"> {{ bootstrapInfo.maintenanceReason }}</span></el-descriptions-item><el-descriptions-item label="声明能力">{{ bootstrapInfo.capabilities.join('、') || '—' }}</el-descriptions-item></el-descriptions><el-alert v-else type="error" :closable="false" show-icon :title="bootstrapError || '系统信息读取失败。'" /></article>
        <article class="page-card"><header class="chart-heading"><h2>受控备份操作</h2></header><p class="operation-note">创建备份只请求服务端的受控 SQLite 备份接口。维护态、权限和写入边界由服务端最终判定。</p><el-button v-if="canCreate" type="primary" :loading="creating" @click="createBackup">创建当前数据库备份</el-button><el-alert v-else type="info" :closable="false" show-icon title="当前账号没有创建备份的权限。" /></article>
      </section>
      <article class="page-card"><header class="chart-heading"><div><h2>备份列表</h2><span>只显示服务端白名单返回的备份名称、大小和摘要；页面不展示本地目录或数据库路径。</span></div><el-button text :loading="loading" @click="loadBackups">刷新</el-button></header><PageState v-if="listError" :error="listError" @retry="loadBackups" /><template v-else><el-table :data="backups" v-loading="loading" stripe><el-table-column prop="backupName" label="备份文件" min-width="260" show-overflow-tooltip /><el-table-column label="大小" width="110"><template #default="{ row }">{{ fileSize(row.sizeBytes) }}</template></el-table-column><el-table-column label="更新时间" min-width="170"><template #default="{ row }">{{ formatStrictUtcDateTimeDisplay(row.updatedAt) }}</template></el-table-column><el-table-column label="校验摘要" min-width="150"><template #default="{ row }">{{ shortHash(row.sha256) }}</template></el-table-column><el-table-column label="操作" min-width="240" fixed="right"><template #default="{ row }"><el-button v-if="canDownload" link @click="downloadBackup(row)">下载</el-button><el-button v-if="canRestore" link type="warning" :loading="restoringName===row.backupName" @click="openRestore(row)">恢复</el-button><el-button v-if="canDelete" link type="danger" :loading="deletingName===row.backupName" @click="confirmDelete(row)">删除</el-button></template></el-table-column></el-table><el-empty v-if="!backups.length && !loading" description="暂无备份；可在获得权限后创建当前数据库备份。" /></template></article>
      <el-dialog v-model="restoreOpen" title="高风险操作：恢复备份" width="600px" destroy-on-close><el-alert type="error" :closable="false" show-icon title="恢复会替换当前本地 SQLite 数据。服务端将先校验备份并自动创建 pre-restore 备份，但不保证业务语义可自动回滚。" /><p class="restore-name">目标备份：<strong>{{ selectedBackup?.backupName }}</strong></p><el-form label-position="top"><el-form-item :label="`请输入“${RESTORE_CONFIRM_TEXT}”以确认`"><el-input v-model="restoreConfirmText" /></el-form-item></el-form><template #footer><el-button @click="restoreOpen=false">取消</el-button><el-button type="danger" :loading="restoringName===selectedBackup?.backupName" :disabled="restoreConfirmText !== RESTORE_CONFIRM_TEXT" @click="restoreBackup">确认恢复隔离库</el-button></template></el-dialog>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import { createSystemBackup, deleteSystemBackup, downloadSystemBackup, getSystemBackups, getSystemBootstrap, restoreSystemBackup } from '@/api/systemBackups';
import { projectBootstrapInfo } from '@/utils/specialModules';
import { hasPermi } from '@/utils/permission';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';

// 备份恢复页面的安全操作状态。
const RESTORE_CONFIRM_TEXT = '确认恢复隔离库';
const bootstrapInfo = ref(null); const bootstrapLoading = ref(false); const bootstrapError = ref(''); const backups = ref([]); const loading = ref(false); const listError = ref(''); const operationError = ref(''); const creating = ref(false); const restoringName = ref(''); const deletingName = ref(''); const restoreOpen = ref(false); const selectedBackup = ref(null); const restoreConfirmText = ref('');
const safe = async (task) => { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } };
const errorText = (result) => result?.error?.message || '接口请求失败。';
const canView = computed(() => hasPermi('system:backup:view')); const canCreate = computed(() => hasPermi('system:backup:create')); const canDownload = computed(() => hasPermi('system:backup:download')); const canRestore = computed(() => hasPermi('system:backup:restore')); const canDelete = computed(() => hasPermi('system:backup:delete'));

/** 格式化受控备份大小。 */
function fileSize(value) { const bytes = Number(value); if (!Number.isFinite(bytes)) return '—'; return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
/** 截断哈希值用于人工核对，不将其作为完整性认证结果。 */
function shortHash(value) { return value ? `${String(value).slice(0, 16)}…` : '—'; }
/** 读取并白名单投影系统启动信息。 */
async function loadBootstrap() { bootstrapLoading.value = true; const result = await safe(getSystemBootstrap); bootstrapLoading.value = false; if (result.ok) { bootstrapInfo.value = projectBootstrapInfo(result.value.data || {}); bootstrapError.value = ''; } else { bootstrapInfo.value = null; bootstrapError.value = errorText(result); } }
/** 读取服务端备份白名单列表。 */
async function loadBackups() { loading.value = true; listError.value = ''; const result = await safe(getSystemBackups); loading.value = false; if (result.ok) backups.value = result.value.data || []; else { backups.value = []; listError.value = errorText(result); } }
/** 请求服务端创建当前数据库备份。 */
async function createBackup() { creating.value = true; operationError.value = ''; const result = await safe(createSystemBackup); creating.value = false; if (!result.ok) { operationError.value = `备份创建失败：${errorText(result)}`; return; } ElMessage.success(`备份已创建：${result.value.data?.backupName || '请在列表中核对'}。`); await loadBackups(); }
/** 下载指定白名单备份。 */
async function downloadBackup(row) { const result = await safe(() => downloadSystemBackup(row.backupName)); if (!result.ok) operationError.value = `备份下载失败：${errorText(result)}`; }
/** 打开恢复二次确认，不在此处调用服务端。 */
function openRestore(row) { selectedBackup.value = row; restoreConfirmText.value = ''; restoreOpen.value = true; }
/** 执行已二次确认的恢复，并如实呈现服务端结果。 */
async function restoreBackup() { if (!selectedBackup.value || restoreConfirmText.value !== RESTORE_CONFIRM_TEXT) return; restoringName.value = selectedBackup.value.backupName; operationError.value = ''; const result = await safe(() => restoreSystemBackup(selectedBackup.value.backupName)); restoringName.value = ''; if (!result.ok) { operationError.value = `备份恢复失败：${errorText(result)}`; return; } restoreOpen.value = false; ElMessage.success(`恢复完成：来源 ${result.value.data?.restoredFrom?.backupName || selectedBackup.value.backupName}；已自动创建恢复前备份 ${result.value.data?.preRestoreBackup?.backupName || 'pre-restore'}。请刷新并核对数据。`); await Promise.all([loadBootstrap(), loadBackups()]); }
/** 删除单个备份，当前数据库不在前端可选范围内。 */
async function confirmDelete(row) { try { await ElMessageBox.confirm(`删除备份“${row.backupName}”？此操作只删除该备份文件，不影响当前数据库；删除后不能再从该备份恢复。`, '确认删除备份', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }); } catch { return; } deletingName.value = row.backupName; operationError.value = ''; const result = await safe(() => deleteSystemBackup(row.backupName)); deletingName.value = ''; if (!result.ok) { operationError.value = `备份删除失败：${errorText(result)}`; return; } ElMessage.success(`备份已删除：${result.value.data?.deletedBackupName || row.backupName}。`); await loadBackups(); }

onMounted(async () => { if (!canView.value) return; await Promise.all([loadBootstrap(), loadBackups()]); });
</script>

<style scoped>
.system-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:14px}.page-card{margin-top:16px}.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.chart-heading h2{margin:0;color:#123b79;font-size:16px}.chart-heading span,.operation-note{color:#7385a2;font-size:13px;line-height:1.7}.panel-alert{margin-top:12px}.restore-name{margin:16px 0;color:#183153}@media (max-width:900px){.system-grid{grid-template-columns:1fr}}@media (max-width:720px){.chart-heading{align-items:flex-start;flex-direction:column}}
</style>
