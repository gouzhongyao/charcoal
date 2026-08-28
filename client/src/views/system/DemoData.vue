<template>
  <ManagementPage class="demo-data-page" title="系统演示数据管理">
    <template #title-extra>
      <HelpIcon label="查看演示数据治理说明" content="标准模板和演示目录均来自服务端。演示文件、标签页 context、导入 ownership 与清理只服务于当前 run；页面不会复制 registry，也不会在进入页面时自动创建 run。" />
    </template>
    <template #actions>
      <el-button v-if="canSeeStatusRefresh" :loading="statusLoading" :disabled="!canRefreshStatus" @click="loadInitialState">刷新状态</el-button>
      <el-button v-if="canSeeToggle" :loading="toggleLoading" :disabled="!canToggle" :type="runtime.enabled ? 'warning' : 'primary'" @click="changeRuntime(!runtime.enabled)">{{ runtime.enabled ? '关闭演示运行期' : '开启演示运行期' }}</el-button>
    </template>

    <el-alert v-if="pageError" type="error" :closable="false" show-icon :title="pageError" />
    <el-alert v-else-if="capability('toggle') && !allowedAction('toggle')" type="info" :closable="false" show-icon title="当前账号缺少演示运行期开关权限，页面仅展示只读状态。" />
    <section class="status-grid" aria-label="演示运行期状态">
      <StatCard label="服务状态" :value="runtime.available ? '可用' : '不可用'" :note="runtime.changeReason || '服务端未返回运行期状态'" />
      <StatCard label="运行期开关" :value="runtime.enabled ? '已开启' : '已关闭'" :note="`epoch ${displayValue(runtime.runtimeEpoch)}`" />
      <StatCard label="运行期 revision" :value="displayValue(runtime.revision)" :note="formatDateTime(runtime.updatedAt)" />
      <StatCard label="能力状态" :value="`${enabledCapabilityCount} / ${capabilityCount}`" note="仅服务端明确为 true 的能力可操作" />
    </section>

    <article class="page-card">
      <header class="section-heading">
        <div><h2>服务端能力</h2><p>能力缺失或接口不可用时保持关闭，不以固定确认文本推断功能已启用。</p></div>
      </header>
      <div class="capability-grid">
        <span v-for="item in capabilityRows" :key="item.key"><StatusTag :status="item.enabled ? 'active' : 'inactive'" :label="`${item.label}：${item.enabled ? '可用' : '不可用'}`" /></span>
        <span v-if="!capabilityRows.length" class="muted">服务端未返回能力声明。</span>
      </div>
    </article>

    <article class="page-card">
      <header class="section-heading">
        <div><h2>标准模板目录</h2><p>目录来自 <code>/api/templates</code>，业务页仍保留各自正式模板和导入能力。</p></div>
        <span>共 {{ standardTemplates.length }} 项</span>
      </header>
      <PageState v-if="templateLoading" loading description="正在读取标准模板目录" />
      <PageState v-else-if="templateError" :error="templateError" @retry="loadTemplateCatalog" />
      <PageState v-else-if="!standardTemplates.length" description="服务端当前没有发布标准模板目录。" />
      <div v-else class="table-scroll" role="region" aria-label="标准模板目录横向滚动区域">
        <el-table :data="standardTemplates" stripe flexible scrollbar-always-on :scrollbar-tabindex="0" aria-label="标准模板目录">
          <el-table-column prop="name" label="模板" min-width="180" />
          <el-table-column prop="type" label="模板类型" min-width="180" />
          <el-table-column label="适用模块" min-width="210"><template #default="{ row }">{{ listText(row.appliesTo) }}</template></el-table-column>
          <el-table-column prop="recommendedFormat" label="推荐格式" width="100" />
          <el-table-column prop="description" label="用途" min-width="320" show-overflow-tooltip />
          <el-table-column label="下载" width="170" fixed="right"><template #default="{ row }"><el-button link type="primary" :loading="templateDownloadKey === `${row.type}:xlsx`" :disabled="!row.route" @click="downloadStandardTemplate(row, 'xlsx')">XLSX</el-button><el-button link :loading="templateDownloadKey === `${row.type}:csv`" :disabled="!row.csvRoute" @click="downloadStandardTemplate(row, 'csv')">CSV</el-button></template></el-table-column>
        </el-table>
      </div>
    </article>

    <article class="page-card catalog-card">
      <header class="section-heading">
        <div><h2>服务端演示 catalog</h2><p>catalog 读取与 active run 准备是两个独立动作；进入页面不会自动创建 run。</p></div>
        <div class="section-actions">
          <el-button v-if="canSeeLoadCatalog" type="primary" :loading="catalogLoading" :disabled="!canLoadCatalog" @click="loadCatalog">{{ catalog ? '刷新演示目录' : '加载演示目录' }}</el-button>
          <el-button v-if="canSeePrepareRun" :loading="runLoading" :disabled="!canPrepareRun" @click="prepareRun">{{ hasActiveRun ? '刷新 active run' : '准备 active run' }}</el-button>
        </div>
      </header>
      <el-alert v-if="!runtime.enabled" type="info" :closable="false" show-icon title="演示运行期当前关闭。请先显式开启，再加载 catalog 或准备 active run。" />
      <el-alert v-else-if="!capability('catalog')" type="warning" :closable="false" show-icon title="服务端未启用 catalog 能力，页面保持关闭。" />
      <el-alert v-else-if="!allowedAction('catalog')" type="warning" :closable="false" show-icon title="当前账号缺少演示 catalog 权限，已隐藏目录读取操作。" />
      <el-alert v-if="runtime.enabled && capability('activeRun') && !allowedAction('run')" type="info" :closable="false" show-icon title="当前账号缺少 active run 准备权限，已隐藏 run 操作。" />
      <el-alert v-else-if="runtime.enabled && !capability('activeRun')" type="warning" :closable="false" show-icon title="服务端未启用 active run 能力，页面不会创建 run。" />
      <el-alert v-if="runError" type="error" :closable="false" show-icon :title="runError" />
      <PageState v-if="catalogError" :error="catalogError" @retry="loadCatalog" />
      <template v-if="catalog">
        <dl class="definition-grid">
          <div><dt>dataset</dt><dd>{{ displayValue(catalog.datasetId) }}</dd></div>
          <div><dt>manifest</dt><dd>{{ displayValue(catalog.manifestVersion) }}</dd></div>
          <div><dt>manifest digest</dt><dd class="digest-text">{{ displayValue(catalog.manifestDigest) }}</dd></div>
          <div><dt>active run</dt><dd>{{ displayValue(activeRunProjection.runId || activeRunProjection.id) }}</dd></div>
          <div><dt>run 状态</dt><dd>{{ displayValue(activeRunProjection.status) }}</dd></div>
          <div><dt>manifest 状态</dt><dd>{{ displayValue(activeRunCompatibility?.manifestCompatible === false || activeRunProjection.manifestCompatible === false ? '不兼容' : activeRunCompatibility?.code || activeRunProjection.conflictCode || '一致或未知') }}</dd></div>
          <div><dt>来源时区</dt><dd>{{ displayValue(catalog.sourceTimeZone) }}</dd></div>
        </dl>
        <div class="table-scroll" role="region" aria-label="演示 catalog 横向滚动区域">
          <el-table :data="artifacts" stripe flexible scrollbar-always-on :scrollbar-tabindex="0" aria-label="演示 catalog">
            <el-table-column prop="order" label="顺序" width="70" />
            <el-table-column prop="name" label="演示数据" min-width="170" />
            <el-table-column prop="artifactKey" label="artifact" min-width="220" />
            <el-table-column prop="handlerKey" label="handler" min-width="210" />
            <el-table-column label="格式" width="110"><template #default="{ row }">{{ listText(row.formats) }}</template></el-table-column>
            <el-table-column label="依赖" min-width="220"><template #default="{ row }">{{ listText(row.dependencies, '无') }}</template></el-table-column>
            <el-table-column prop="targetPage" label="目标模块" min-width="190" />
            <el-table-column prop="postAction" label="后置动作" min-width="260" show-overflow-tooltip />
            <el-table-column label="操作" min-width="300" fixed="right"><template #default="{ row }"><el-button v-if="canSeeCatalogActions" link type="primary" :loading="artifactDownloadKey === row.artifactKey && artifactDownloadMode === 'navigate'" :disabled="!canDownloadArtifact(row) || !targetRoute(row) || Boolean(artifactDownloadKey)" @click="downloadArtifactAndNavigate(row)">下载并前往</el-button><el-button v-if="canSeeCatalogActions" link :loading="artifactDownloadKey === row.artifactKey && artifactDownloadMode === 'download'" :disabled="!canDownloadArtifact(row) || Boolean(artifactDownloadKey)" @click="downloadArtifactOnly(row)">仅下载</el-button><el-button v-if="canNavigateArtifact" link :disabled="!targetRoute(row) || Boolean(artifactDownloadKey)" @click="navigateToArtifact(row)">前往模块</el-button></template></el-table-column>
          </el-table>
        </div>
      </template>
      <PageState v-else-if="!catalogLoading && !catalogError" description="尚未加载演示目录；进入页面不会自动创建 run。" />
    </article>

    <article class="page-card">
      <header class="section-heading"><div><h2>ownership 进度</h2><p>只读汇总来自当前 active run 的服务端响应；ownership 登记和清理能力分别按 capability 与 allowedAction 判断。</p></div><el-button v-if="canLoadOwnership" :loading="ownershipLoading" @click="loadOwnership">刷新进度</el-button></header>
      <el-alert v-if="!capability('ownershipSummary')" type="warning" :closable="false" show-icon title="服务端未启用 ownership 汇总能力，无法读取当前 run 归属进度；清理保持关闭。" />
      <el-alert v-else-if="!allowedAction('ownershipSummary')" type="info" :closable="false" show-icon title="当前账号缺少 ownership 汇总权限，已隐藏读取操作。" />
      <el-alert v-else-if="!capability('ownershipRegistration')" type="info" :closable="false" show-icon title="当前仅可读取只读 ownership 汇总；ownership 登记未启用，预演可能返回 blocked，不能据此证明数据归属。" />
      <PageState v-if="ownershipError" :error="ownershipError" @retry="loadOwnership" />
      <template v-if="ownership">
        <section class="status-grid ownership-grid">
          <StatCard label="ownership 总数" :value="String(summaryNumber(ownership, ['totalCount']))" note="服务端 ownership 汇总" />
          <StatCard label="active ownership" :value="String(summaryNumber(ownership, ['activeCount']))" note="当前仍有效的归属" />
          <StatCard label="已清理 ownership" :value="String(summaryNumber(ownership, ['cleanedCount']))" note="服务端清理汇总" />
          <StatCard label="清理候选" :value="String(summaryNumber(ownership, ['cleanupCandidateCount']))" note="当前 run 可评估候选" />
          <StatCard label="清理 blocker" :value="String(summaryNumber(ownership, ['cleanupBlockerCount']))" note="存在 blocker 时 cleanup 不可执行" />
          <StatCard label="blocker 明细" :value="String(summaryNumber(ownership, ['blockers']))" note="服务端 blocker 明细数量" />
        </section>
        <details class="raw-details"><summary>查看服务端 ownership 详细响应</summary><pre>{{ formattedJson(ownership) }}</pre></details>
      </template>
      <PageState v-else-if="!ownershipLoading && capability('ownershipSummary') && allowedAction('ownershipSummary')" description="准备 active run 后可读取当前 run ownership 进度。" />
    </article>

    <article class="page-card cleanup-card">
      <header class="section-heading"><div><h2>精确清理当前 run</h2><p>清理预演可以在缺少 ownership 登记时返回 blocked；执行仍必须满足 registration、execute 授权和最新可执行预演。</p></div><el-button v-if="canPreviewCleanup" type="danger" :loading="cleanupPreviewLoading" @click="previewCleanup">生成清理预演</el-button></header>
      <el-alert v-if="!capability('cleanupPreview')" type="warning" :closable="false" show-icon title="服务端未启用 cleanup preview 能力，页面保持 fail-closed。" />
      <el-alert v-else-if="!allowedAction('cleanupPreview')" type="info" :closable="false" show-icon title="当前账号缺少 cleanup preview 权限，已隐藏预演操作。" />
      <el-alert v-if="capability('cleanupPreview') && allowedAction('cleanupPreview') && !capability('ownershipRegistration')" type="info" :closable="false" show-icon title="ownership 登记能力未启用；仍可生成 blocked 清理预演并查看服务端 blocker。" />
      <el-alert v-if="capability('cleanupExecute') && !allowedAction('cleanupExecute')" type="info" :closable="false" show-icon title="当前账号缺少 cleanup execute 权限，已隐藏执行操作。" />
      <el-alert v-if="cleanupError" type="error" :closable="false" show-icon :title="cleanupError" />
      <el-alert v-if="capability('cleanupRunStatus') && !allowedAction('readCleanupRunStatus')" type="info" :closable="false" show-icon title="当前账号缺少 cleanup 状态查询权限，已隐藏查询操作。" />
      <el-form v-if="canSeeCleanupStatus" label-position="top" class="cleanup-status-query-form" @submit.prevent="queryCleanupStatus">
        <el-form-item label="cleanup run ID">
          <el-input v-model="cleanupRunIdInput" clearable placeholder="可粘贴其他客户端提供的 cleanupRunId" />
        </el-form-item>
        <el-button type="primary" :loading="cleanupStatusLoading" :disabled="!canQueryCleanupStatus" @click="queryCleanupStatus">查询清理状态</el-button>
      </el-form>
      <template v-if="cleanupPreview">
        <dl class="definition-grid">
          <div><dt>cleanup run</dt><dd>{{ displayValue(cleanupPreview.cleanupRunId || cleanupPreview.id) }}</dd></div>
          <div><dt>预演状态</dt><dd>{{ displayValue(cleanupPreview.status) }}</dd></div>
          <div><dt>候选</dt><dd>{{ summaryNumber(cleanupPreview, ['candidateCount', 'candidates']) }}</dd></div>
          <div><dt>blocker</dt><dd>{{ summaryNumber(cleanupPreview, ['blockerCount', 'blockers']) }}</dd></div>
          <div><dt>registry watermark</dt><dd class="digest-text">{{ displayValue(cleanupPreview.registryWatermark) }}</dd></div>
          <div><dt>runtime revision</dt><dd>{{ displayValue(cleanupPreview.runtimeRevision) }}</dd></div>
          <div><dt>过期时间</dt><dd>{{ formatDateTime(cleanupPreview.previewExpiresAt) }}</dd></div>
          <div class="definition-grid__wide"><dt>preview digest</dt><dd class="digest-text">{{ displayValue(cleanupPreview.previewDigest) }}</dd></div>
        </dl>
        <el-alert :type="cleanupPreview.executable ? 'warning' : 'error'" :closable="false" show-icon :title="cleanupPreview.executable ? '预演可执行；请核对候选和 blocker 后逐字确认。' : '预演不可执行；请先处理服务端 blocker。'" />
        <ul v-if="cleanupBlockers.length" class="blocker-list" aria-label="清理预演 blocker">
          <li v-for="blocker in cleanupBlockers" :key="`${blocker.code || 'blocker'}:${blocker.message || blocker.reason || ''}`"><strong>{{ displayValue(blocker.code) }}</strong>：{{ displayValue(blocker.message || blocker.reason) }}</li>
        </ul>
        <el-form label-position="top" class="cleanup-confirm-form"><el-form-item v-if="canSeeCleanupExecute" :label="`请输入固定确认文本：${cleanupExpectedConfirmation}`"><el-input v-model="cleanupConfirmation" autocomplete="off" /></el-form-item><el-button v-if="canSeeCleanupExecute" type="danger" :loading="cleanupExecuteLoading" :disabled="!canExecuteCleanup" @click="executeCleanup">确认清理当前 run</el-button></el-form>
        <details class="raw-details"><summary>查看清理预演详细响应</summary><pre>{{ formattedJson(cleanupPreview) }}</pre></details>
      </template>
      <template v-if="cleanupResult"><el-alert :type="cleanupResultAlert.type" :closable="false" show-icon :title="cleanupResultAlert.title" /><details class="raw-details" open><summary>清理结果</summary><pre>{{ formattedJson(cleanupResult) }}</pre></details></template>
    </article>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import HelpIcon from '@/components/HelpIcon.vue';
import ManagementPage from '@/components/ManagementPage.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import {
  clearDemoContexts,
  clearDemoContextIfTokenMatches,
  downloadDemoCatalogArtifact,
  downloadDemoStandardTemplate,
  executeDemoCleanup,
  getDemoCatalog,
  getDemoCleanupRun,
  prepareDemoRun,
  getDemoOwnershipSummary,
  getDemoStatus,
  getDemoTemplateCatalog,
  previewDemoCleanup,
  toggleDemoRuntime
} from '@/api/demoData';
import { isExpectedNamedRoute, resolveTrustedRegisteredRoute } from '@/utils/navigationRoutes';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';

/** 同标签页路由器，禁止通过新标签页丢失 sessionStorage context。 */
const router = useRouter();
/** 服务端运行期状态。 */
const runtime = ref({ available: false, enabled: false, runtimeEpoch: null, revision: null });
/** 服务端能力声明，只表示功能可用性，不代表当前用户授权。 */
const capabilities = ref({});
/** 服务端按真实 RBAC 投影的当前用户允许动作。 */
const allowedActions = ref({});
/** 服务端固定确认文本，仅用于展示且不推断能力或授权。 */
const confirmationTexts = ref({});
/** 标准模板目录。 */
const standardTemplates = ref([]);
/** 显式加载后的演示 catalog。 */
const catalog = ref(null);
/** status 只读投影或显式 POST run 成功返回的 active run。 */
const activeRun = ref(null);
/** status 返回的 active run manifest/lifecycle 只读兼容性投影。 */
const activeRunCompatibility = ref(null);
/** 当前 run ownership 汇总。 */
const ownership = ref(null);
/** 当前清理预演。 */
const cleanupPreview = ref(null);
/** 当前清理执行或状态结果。 */
const cleanupResult = ref(null);
/** 独立 cleanup run 状态查询输入，运行期关闭或预演状态清空后仍保留。 */
const cleanupRunIdInput = ref('');
/** 用户逐字输入的清理确认文本。 */
const cleanupConfirmation = ref('');
/** 当前 cleanup 预演对应的稳定执行幂等请求标识，失败重试必须复用。 */
const cleanupExecuteRequestId = ref('');
/** 页面级错误。 */
const pageError = ref('');
/** 标准模板目录错误。 */
const templateError = ref('');
/** 演示 catalog 错误。 */
const catalogError = ref('');
/** active run 显式准备错误。 */
const runError = ref('');
/** ownership 错误。 */
const ownershipError = ref('');
/** cleanup 错误。 */
const cleanupError = ref('');
/** 初始状态加载标记。 */
const statusLoading = ref(false);
/** 模板目录加载标记。 */
const templateLoading = ref(false);
/** 运行期开关提交标记。 */
const toggleLoading = ref(false);
/** catalog 加载标记。 */
const catalogLoading = ref(false);
/** active run 显式准备标记。 */
const runLoading = ref(false);
/** ownership 加载标记。 */
const ownershipLoading = ref(false);
/** cleanup 预演提交标记。 */
const cleanupPreviewLoading = ref(false);
/** cleanup 执行提交标记。 */
const cleanupExecuteLoading = ref(false);
/** cleanup 状态加载标记。 */
const cleanupStatusLoading = ref(false);
/** 当前标准模板下载键。 */
const templateDownloadKey = ref('');
/** 当前演示 artifact 下载键。 */
const artifactDownloadKey = ref('');
/** 当前演示 artifact 下载动作，用于区分仅下载与下载并前往的加载状态。 */
const artifactDownloadMode = ref('');

/** 能力中文标签。 */
const capabilityLabels = Object.freeze({ status: '状态读取', toggle: '运行期开关', catalog: '演示目录', activeRun: 'active run', download: 'artifact 下载', contextIssue: 'context 签发', contextReassociate: 'context 重新关联', centralPreviewExecuteContext: '集中 preview/execute context', ownershipSummary: 'ownership 汇总', ownershipRegistration: 'ownership 登记', cleanupPreview: 'cleanup 预演', cleanupExecute: 'cleanup 执行', cleanupRunStatus: 'cleanup 状态' });
/** allowedActions 字段兼容表；仅服务端明确 true 才视为已授权。 */
const allowedActionKeys = Object.freeze({
  status: ['status', 'readStatus'],
  toggle: ['toggleRuntime', 'toggle'],
  catalog: ['loadCatalog', 'catalog', 'readCatalog'],
  run: ['prepareRun', 'run', 'activeRun'],
  download: ['downloadArtifacts', 'download', 'downloadArtifact'],
  reassociateContext: ['reassociateContext'],
  ownershipSummary: ['readOwnershipSummary', 'ownershipSummary'],
  cleanupPreview: ['previewCleanup', 'cleanupPreview'],
  cleanupExecute: ['executeCleanup', 'cleanupExecute'],
  readCleanupRunStatus: ['readCleanupRunStatus']
});
/** 能力展示行。 */
const capabilityRows = computed(() => Object.entries(capabilities.value).map(([key, enabled]) => ({ key, label: capabilityLabels[key] || key, enabled: enabled === true })));
/** 服务端能力总数。 */
const capabilityCount = computed(() => capabilityRows.value.length);
/** 服务端已启用能力数量。 */
const enabledCapabilityCount = computed(() => capabilityRows.value.filter((item) => item.enabled).length);
/** active run 的安全展示投影，真实状态只来自 status 或显式 POST run。 */
const activeRunProjection = computed(() => activeRun.value || {});
/** 当前是否存在可用 active run 身份。 */
const hasActiveRun = computed(() => Boolean(activeRunProjection.value.runId || activeRunProjection.value.id));
/** 当前 run 是否被服务端只读兼容性投影明确标记为不可写。 */
const activeRunManifestBlocked = computed(() => hasActiveRun.value && (
  activeRunCompatibility.value?.writeEligible === false
  || activeRunCompatibility.value?.manifestCompatible === false
  || activeRunProjection.value.manifestCompatible === false
  || Boolean(activeRunProjection.value.conflictCode)
));
/** 按服务端顺序展示 artifact。 */
const artifacts = computed(() => [...(catalog.value?.artifacts || [])].sort((left, right) => Number(left.order || 0) - Number(right.order || 0)));
/** 当前 cleanup 预演返回的 blocker 明细。 */
const cleanupBlockers = computed(() => {
  const directBlockers = cleanupPreview.value?.blockers;
  if (Array.isArray(directBlockers)) return directBlockers;
  const summaryBlockers = cleanupPreview.value?.summary?.blockers;
  return Array.isArray(summaryBlockers) ? summaryBlockers : [];
});
/** 清理结果状态提示，按服务端真实状态区分失败、过期、执行中和 blocker。 */
const cleanupResultAlert = computed(() => {
  const result = cleanupResult.value || {};
  const status = String(result.status || '').trim().toLowerCase();
  const directBlockers = result.blockers;
  const summaryBlockers = result.summary?.blockers;
  const blockerCount = Number(result.blockerCount ?? result.summary?.blockerCount);
  const hasBlockers = result.blocked === true
    || (Array.isArray(directBlockers) && directBlockers.length > 0)
    || (Array.isArray(summaryBlockers) && summaryBlockers.length > 0)
    || (Number.isFinite(blockerCount) && blockerCount > 0);
  if (['cleaned', 'completed', 'succeeded'].includes(status)) {
    return { type: 'success', title: '服务端确认清理已完成；页面已刷新运行期状态。' };
  }
  if (status === 'noop') {
    return { type: 'success', title: '服务端确认当前清理已无操作；没有需要删除的数据。' };
  }
  if (status === 'failed') {
    return { type: 'error', title: '服务端返回清理失败状态；未确认清理完成，请查看失败原因。' };
  }
  if (status === 'expired') {
    return { type: 'warning', title: '服务端返回预演已过期状态；未执行清理，请重新生成预演。' };
  }
  if (status === 'executing') {
    return { type: 'info', title: '服务端返回清理执行中状态；请稍后重新查询。' };
  }
  if (status === 'blocked' || hasBlockers) {
    return { type: 'warning', title: '服务端返回 blocked 结果；未执行清理，请查看 blocker 明细。' };
  }
  if (result.executable === true || status === 'executable' || status === 'previewed') {
    return { type: 'warning', title: '服务端返回可执行状态；仍需使用最新预演和授权完成确认。' };
  }
  return { type: 'info', title: '服务端已返回清理状态；请核对详细响应。' };
});
/** 当前账号是否看到状态刷新操作。 */
const canSeeStatusRefresh = computed(() => capability('status') && runtime.value.available);
/** 当前账号是否可刷新状态。 */
const canRefreshStatus = computed(() => canSeeStatusRefresh.value && !statusLoading.value);
/** 当前账号是否看到运行期开关操作。 */
const canSeeToggle = computed(() => capability('toggle') && allowedAction('toggle') && runtime.value.available);
/** 当前账号是否可操作运行期开关。 */
const canToggle = computed(() => canSeeToggle.value && !toggleLoading.value);
/** 当前账号是否看到 catalog 读取操作。 */
const canSeeLoadCatalog = computed(() => runtime.value.available && capability('catalog') && allowedAction('catalog'));
/** 是否允许显式加载 catalog。 */
const canLoadCatalog = computed(() => canSeeLoadCatalog.value && runtime.value.enabled && !catalogLoading.value);
/** 当前账号是否看到 active run 准备操作。 */
const canSeePrepareRun = computed(() => runtime.value.available && capability('activeRun') && allowedAction('run'));
/** 是否允许显式准备 active run。 */
const canPrepareRun = computed(() => canSeePrepareRun.value && runtime.value.enabled && !runLoading.value);
/** 是否展示 catalog 中的下载操作。 */
const canSeeCatalogActions = computed(() => capability('download') && allowedAction('download') && runtime.value.available && runtime.value.enabled);
/** 是否允许进入 catalog 声明的当前账号可信路由。 */
const canNavigateArtifact = computed(() => capability('catalog') && allowedAction('catalog') && runtime.value.available && runtime.value.enabled);
/** 是否存在可供 ownership 查询的当前 run。 */
const canLoadOwnership = computed(() => Boolean(capability('ownershipSummary') && allowedAction('ownershipSummary') && runtime.value.available && runtime.value.enabled && hasActiveRun.value && !ownershipLoading.value));
/** 是否允许请求 cleanup 预演；不依赖 ownershipRegistration 或 cleanupExecute。 */
const canPreviewCleanup = computed(() => Boolean(capability('cleanupPreview')
  && allowedAction('cleanupPreview')
  && runtime.value.available
  && runtime.value.enabled
  && hasActiveRun.value
  && !activeRunManifestBlocked.value
  && !cleanupPreviewLoading.value
  && !cleanupExecuteLoading.value));
/** 是否展示 cleanup execute 表单。 */
const canSeeCleanupExecute = computed(() => capability('ownershipRegistration') && capability('cleanupExecute') && allowedAction('cleanupExecute') && runtime.value.available && runtime.value.enabled);
/** 是否展示 cleanup run 只读状态查询；只依赖服务端状态查询能力和当前用户授权。 */
const canSeeCleanupStatus = computed(() => capability('cleanupRunStatus') && allowedAction('readCleanupRunStatus'));
/** 是否允许按独立 cleanup run ID 查询状态，不依赖 runtime enabled 或当前 cleanup 预演。 */
const canQueryCleanupStatus = computed(() => Boolean(canSeeCleanupStatus.value
  && cleanupRunIdInput.value.trim()
  && !cleanupStatusLoading.value));
/** 当前预演使用的固定确认文本，优先采用预演响应并允许状态合同作为显示回退。 */
const cleanupExpectedConfirmation = computed(() => String(cleanupPreview.value?.confirmationText || confirmationTexts.value?.cleanup || '').trim());
/** 是否允许执行 cleanup，包含 capability、真实授权、运行态、可执行预演和防重复提交约束。 */
const canExecuteCleanup = computed(() => Boolean(canSeeCleanupExecute.value
  && runtime.value.enabled
  && hasActiveRun.value
  && !activeRunManifestBlocked.value
  && cleanupPreview.value?.executable === true
  && cleanupPreview.value?.previewDigest
  && (cleanupPreview.value?.cleanupRunId || cleanupPreview.value?.id)
  && cleanupExecuteRequestId.value
  && cleanupExpectedConfirmation.value
  && cleanupConfirmation.value === cleanupExpectedConfirmation.value
  && !cleanupExecuteLoading.value
  && !cleanupPreviewLoading.value));

/** 安全捕获异步请求。 */
async function safeRequest(task) { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } }
/** 提取统一 API 错误文本。 */
function errorText(result) { return result?.error?.apiError?.message || result?.error?.message || '接口请求失败。'; }
/** 提取统一 API 错误代码，便于明确展示 manifest 等冲突。 */
function errorCode(result) { return String(result?.error?.apiError?.code || '').trim(); }
/** 判断服务端是否明确启用指定能力。 */
function capability(key) { return capabilities.value?.[key] === true; }
/** 判断 status 是否按真实 RBAC 明确允许指定动作，未知字段一律关闭。 */
function allowedAction(key) {
  const keys = allowedActionKeys[key] || [key];
  return keys.some((actionKey) => allowedActions.value?.[actionKey] === true);
}
/** 格式化空值。 */
function displayValue(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
/** 格式化日期时间。 */
function formatDateTime(value) { return formatStrictUtcDateTimeDisplay(value); }
/** 格式化数组文本。 */
function listText(value, emptyText = '—') { return Array.isArray(value) && value.length ? value.join('、') : emptyText; }
/** 格式化服务端详细 JSON。 */
function formattedJson(value) { return JSON.stringify(value, null, 2); }
/** 从多种冻结合同字段中读取数值或数组长度。 */
function summaryNumber(source, keys) { for (const key of keys) { const value = source?.[key]; if (Array.isArray(value)) return value.length; const number = Number(value); if (Number.isFinite(number)) return number; } return 0; }
/** 生成 cleanup 幂等请求标识。 */
function createClientRequestId() { if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID(); return `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
/** 按 capability、allowedAction、运行态和 catalog 生命周期判断 artifact 下载是否可用。 */
function canDownloadArtifact(artifact) {
  const lifecycle = String(artifact?.downloadLifecycle || '').trim();
  if (!capability('download')) return false;
  if (!canSeeCatalogActions.value || !runtime.value.enabled) return false;
  if (lifecycle === 'stateless-formal-import') return true;
  if (!hasActiveRun.value || activeRunManifestBlocked.value) return false;
  return lifecycle === 'managed-context-auto-runtime' && capability('contextIssue');
}
/** 从服务端 artifact 中读取 targetRoute，并要求当前账号已注册真实页面路由。 */
function targetRouteContract(artifact) {
  return resolveTrustedRegisteredRoute(artifact?.targetRoute, router.getRoutes());
}
/** 返回可安全导航的服务端目标路由；合同异常时返回空值并保持按钮禁用。 */
function targetRoute(artifact) {
  const contract = targetRouteContract(artifact);
  return contract.ok ? contract.path : '';
}
/** 将 artifact 合同异常转换为具体的用户可读问题。 */
function targetRouteError(artifact, contract = targetRouteContract(artifact)) {
  const artifactKey = String(artifact?.artifactKey || 'unknown-artifact');
  if (contract.code === 'invalid-target-route') return `artifact ${artifactKey} 合同无效：服务端未声明合法 targetRoute。`;
  return `artifact ${artifactKey} 合同无效：targetRoute 未注册为当前账号可用的真实页面。`;
}
/** 应用服务端 status 响应，并只接受 status 的 activeRun 只读投影。 */
function applyStatus(response) {
  const data = response?.data || {};
  runtime.value = data.runtime || { available: false, enabled: false, runtimeEpoch: null, revision: null };
  capabilities.value = data.capabilities && typeof data.capabilities === 'object' ? data.capabilities : {};
  allowedActions.value = data.allowedActions && typeof data.allowedActions === 'object' ? data.allowedActions : {};
  confirmationTexts.value = data.confirmationTexts && typeof data.confirmationTexts === 'object' ? data.confirmationTexts : {};
  activeRun.value = data.activeRun && typeof data.activeRun === 'object' ? data.activeRun : null;
  activeRunCompatibility.value = data.activeRunCompatibility && typeof data.activeRunCompatibility === 'object'
    ? data.activeRunCompatibility : null;
}
/** 应用显式 POST run 成功结果，不从 catalog 推断 active run。 */
function applyRun(response) {
  const data = response?.data;
  const nextRun = data?.activeRun || data?.run || data;
  activeRun.value = nextRun && typeof nextRun === 'object' && (nextRun.runId || nextRun.id) ? nextRun : null;
  const compatibility = data?.activeRunCompatibility || data?.compatibility || nextRun?.compatibility;
  activeRunCompatibility.value = compatibility && typeof compatibility === 'object'
    ? compatibility : (activeRun.value ? { manifestCompatible: true, writeEligible: true } : null);
}
/** 加载状态和模板目录；不请求 catalog 或准备 active run。 */
async function loadInitialState() {
  statusLoading.value = true;
  pageError.value = '';
  const result = await safeRequest(getDemoStatus);
  statusLoading.value = false;
  if (result.ok) {
    applyStatus(result.value);
  } else {
    runtime.value = { available: false, enabled: false, runtimeEpoch: null, revision: null };
    capabilities.value = {};
    allowedActions.value = {};
    activeRun.value = null;
    activeRunCompatibility.value = null;
    pageError.value = `演示运行期状态读取失败：${errorText(result)}`;
  }
  await loadTemplateCatalog();
}
/** 加载服务端标准模板目录。 */
async function loadTemplateCatalog() { templateLoading.value = true; templateError.value = ''; const result = await safeRequest(getDemoTemplateCatalog); templateLoading.value = false; if (result.ok) standardTemplates.value = Array.isArray(result.value?.data) ? result.value.data : []; else { standardTemplates.value = []; templateError.value = errorText(result); } }
/** 显式切换演示运行期。 */
async function changeRuntime(enabled) {
  if (!canToggle.value) return;
  try {
    await ElMessageBox.confirm(`${enabled ? '开启' : '关闭'}演示运行期？关闭会使旧 context 按服务端 epoch/revision 规则失效。`, `确认${enabled ? '开启' : '关闭'}`, { type: 'warning', confirmButtonText: `确认${enabled ? '开启' : '关闭'}`, cancelButtonText: '取消' });
  } catch { return; }
  toggleLoading.value = true;
  const result = await safeRequest(() => toggleDemoRuntime(enabled));
  toggleLoading.value = false;
  if (!result.ok) { ElMessage.error(`演示运行期切换失败：${errorText(result)}`); return; }
  const statusResult = await safeRequest(getDemoStatus);
  if (statusResult.ok) applyStatus(statusResult.value);
  else {
    applyStatus(result.value);
    pageError.value = `运行期已切换，但最新权限状态读取失败：${errorText(statusResult)}`;
  }
  if (!enabled) {
    catalog.value = null;
    activeRun.value = null;
    activeRunCompatibility.value = null;
    ownership.value = null;
    cleanupPreview.value = null;
    cleanupResult.value = null;
    cleanupConfirmation.value = '';
    cleanupExecuteRequestId.value = '';
    clearDemoContexts();
  }
  ElMessage.success(`演示运行期已${enabled ? '开启' : '关闭'}。`);
}
/** 显式读取服务端演示 catalog；catalog 成功不创建或推断 active run。 */
async function loadCatalog() {
  if (!canLoadCatalog.value) return;
  catalogLoading.value = true;
  catalogError.value = '';
  const result = await safeRequest(getDemoCatalog);
  catalogLoading.value = false;
  if (!result.ok) {
    catalogError.value = errorText(result);
    return;
  }
  catalog.value = result.value?.data || null;
}
/** 显式 POST 准备 active run；409 manifest 冲突时保留已加载 catalog。 */
async function prepareRun() {
  if (!canPrepareRun.value) return;
  runLoading.value = true;
  runError.value = '';
  const result = await safeRequest(prepareDemoRun);
  runLoading.value = false;
  if (!result.ok) {
    const code = errorCode(result);
    runError.value = code ? `active run 准备失败（${code}）：${errorText(result)}` : `active run 准备失败：${errorText(result)}`;
    return;
  }
  applyRun(result.value);
  if (!hasActiveRun.value) {
    runError.value = '服务端未返回有效 active run，页面保持 fail-closed。';
    return;
  }
  ownership.value = null;
  cleanupPreview.value = null;
  cleanupResult.value = null;
  cleanupConfirmation.value = '';
  cleanupExecuteRequestId.value = '';
  if (canLoadOwnership.value) await loadOwnership();
}
/** 下载服务端标准模板目录项。 */
async function downloadStandardTemplate(template, format) { const key = `${template.type}:${format}`; templateDownloadKey.value = key; const result = await safeRequest(() => downloadDemoStandardTemplate(template, format)); templateDownloadKey.value = ''; if (!result.ok) ElMessage.error(`标准模板下载失败：${errorText(result)}`); }
/** 按服务端生命周期执行 artifact 正式下载；仅下载不依赖 targetRoute 合同。 */
async function downloadArtifact(artifact, mode = 'download') {
  if (!artifact?.artifactKey || artifactDownloadKey.value || !canDownloadArtifact(artifact)) return { ok: false, skipped: true };
  const format = artifact.formats?.includes('xlsx') ? 'xlsx' : artifact.formats?.[0];
  if (!format) {
    ElMessage.error('服务端未提供可用的 artifact 格式。');
    return { ok: false, skipped: true };
  }
  artifactDownloadKey.value = artifact.artifactKey;
  artifactDownloadMode.value = mode;
  try {
    const result = await safeRequest(() => downloadDemoCatalogArtifact(artifact, format));
    if (!result.ok) ElMessage.error(`演示 artifact 下载失败：${errorText(result)}`);
    return result;
  } finally {
    artifactDownloadKey.value = '';
    artifactDownloadMode.value = '';
  }
}
/** 仅下载演示 artifact，不要求 targetRoute 存在或已注册；托管 context 按生命周期正常保存。 */
async function downloadArtifactOnly(artifact) {
  await downloadArtifact(artifact, 'download');
}
/** 仅清理本次新签发且仍在当前标签页的 context，不恢复已覆盖或已消费的旧 context。 */
function clearFailedNavigationContext(artifact, result) {
  if (!artifact?.handlerKey || !result?.value?.demoContextStored) return;
  const metadata = result.value.demo;
  const artifactKey = String(metadata?.artifactKey || '').trim();
  const handlerKey = String(metadata?.handlerKey || '').trim();
  const issuedToken = String(metadata?.contextToken || '').trim();
  if (artifactKey !== artifact.artifactKey || handlerKey !== artifact.handlerKey || !issuedToken) return;
  clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken);
}
/** 下载演示 artifact 并在当前标签页导航到服务端声明且已注册的可信页面。 */
async function downloadArtifactAndNavigate(artifact) {
  if (!artifact?.artifactKey || artifactDownloadKey.value || !canDownloadArtifact(artifact)) return;
  const contract = targetRouteContract(artifact);
  if (!contract.ok) {
    ElMessage.error(targetRouteError(artifact, contract));
    return;
  }
  const result = await downloadArtifact(artifact, 'navigate');
  if (!result.ok) return;
  const currentContract = targetRouteContract(artifact);
  if (!currentContract.ok) {
    clearFailedNavigationContext(artifact, result);
    ElMessage.error(`${targetRouteError(artifact, currentContract)} 下载已完成，但导航前合同已失效。`);
    return;
  }
  try {
    const navigationFailure = await router.push(currentContract.location);
    const reachedExpectedRoute = router.currentRoute.value.name === currentContract.location.name;
    if (navigationFailure || !reachedExpectedRoute) {
      clearFailedNavigationContext(artifact, result);
      ElMessage.error(`artifact ${artifact.artifactKey} 导航失败：当前目标页面拒绝、取消或重定向了导航。`);
    }
  } catch (error) {
    clearFailedNavigationContext(artifact, result);
    ElMessage.error(`artifact ${artifact.artifactKey} 导航失败：${error?.message || '当前目标页面不可用。'}`);
  }
}
/** 在当前标签页进入 artifact 目标模块，合同异常或授权缺失时保持关闭。 */
async function navigateToArtifact(artifact) {
  if (!canNavigateArtifact.value) return;
  const contract = targetRouteContract(artifact);
  if (!contract.ok) {
    ElMessage.error(targetRouteError(artifact, contract));
    return;
  }
  try {
    const navigationFailure = await router.push(contract.location);
    if (navigationFailure || !isExpectedNamedRoute(router.currentRoute.value, contract.location)) {
      ElMessage.error(`artifact ${artifact?.artifactKey || 'unknown-artifact'} 导航失败：当前目标页面拒绝、取消或重定向了导航。`);
    }
  } catch (error) {
    ElMessage.error(`artifact ${artifact?.artifactKey || 'unknown-artifact'} 导航失败：${error?.message || '当前目标页面不可用。'}`);
  }
}
/** 加载当前 run ownership 汇总。 */
async function loadOwnership() {
  const runId = activeRunProjection.value.runId || activeRunProjection.value.id;
  if (!canLoadOwnership.value || !runId) return;
  ownershipLoading.value = true;
  ownershipError.value = '';
  const result = await safeRequest(() => getDemoOwnershipSummary(runId));
  ownershipLoading.value = false;
  if (result.ok) ownership.value = result.value?.data || {};
  else { ownership.value = null; ownershipError.value = errorText(result); }
}
/** 创建只针对当前 run 的 cleanup 预演；blocked 响应也作为有效结果展示。 */
async function previewCleanup() {
  const runId = activeRunProjection.value.runId || activeRunProjection.value.id;
  if (!canPreviewCleanup.value || !runId) return;
  cleanupPreviewLoading.value = true;
  cleanupError.value = '';
  cleanupResult.value = null;
  cleanupPreview.value = null;
  cleanupConfirmation.value = '';
  const clientRequestId = createClientRequestId();
  cleanupExecuteRequestId.value = clientRequestId;
  const result = await safeRequest(() => previewDemoCleanup(runId, clientRequestId));
  cleanupPreviewLoading.value = false;
  if (!result.ok) {
    cleanupExecuteRequestId.value = '';
    cleanupError.value = errorText(result);
    return;
  }
  cleanupPreview.value = result.value?.data || {};
  cleanupRunIdInput.value = String(cleanupPreview.value.cleanupRunId || cleanupPreview.value.id || '').trim();
}
/** 执行当前 cleanup 预演，提交期间防止重复请求。 */
async function executeCleanup() {
  if (!canExecuteCleanup.value) return;
  const preview = cleanupPreview.value;
  const cleanupRunId = String(preview.cleanupRunId || preview.id || '').trim();
  const clientRequestId = cleanupExecuteRequestId.value;
  const confirmationText = cleanupExpectedConfirmation.value;
  try {
    await ElMessageBox.confirm('只清理当前演示 run 的 ownership 数据。请再次确认已经核对候选、blocker、digest、watermark 和过期时间。', '确认精确清理', { type: 'error', confirmButtonText: '执行当前 run 清理', cancelButtonText: '取消' });
  } catch { return; }
  if (!canExecuteCleanup.value || cleanupExecuteLoading.value || clientRequestId !== cleanupExecuteRequestId.value) return;
  cleanupExecuteLoading.value = true;
  cleanupError.value = '';
  const result = await safeRequest(() => executeDemoCleanup({ cleanupRunId, clientRequestId, previewDigest: preview.previewDigest, confirmationText }));
  cleanupExecuteLoading.value = false;
  if (!result.ok) { cleanupError.value = errorText(result); return; }
  cleanupResult.value = result.value?.data || {};
  clearDemoContexts();
  catalog.value = null;
  activeRun.value = null;
  ownership.value = null;
  cleanupPreview.value = null;
  cleanupConfirmation.value = '';
  cleanupExecuteRequestId.value = '';
  await loadInitialState();
}
/** 查询指定 cleanup run 的服务端状态，blocked/executable 均按服务端结果展示。 */
async function loadCleanupStatus(cleanupRunId) {
  const normalizedCleanupRunId = String(cleanupRunId || '').trim();
  if (!canSeeCleanupStatus.value || !normalizedCleanupRunId || cleanupStatusLoading.value) return;
  cleanupRunIdInput.value = normalizedCleanupRunId;
  cleanupStatusLoading.value = true;
  cleanupError.value = '';
  const result = await safeRequest(() => getDemoCleanupRun(normalizedCleanupRunId));
  cleanupStatusLoading.value = false;
  if (result.ok) cleanupResult.value = result.value?.data || {};
  else cleanupError.value = errorText(result);
}
/** 查询输入框中的 cleanup run ID，独立于当前预演和运行期开关。 */
async function queryCleanupStatus() {
  if (!canQueryCleanupStatus.value) return;
  await loadCleanupStatus(cleanupRunIdInput.value);
}

/** 页面挂载只读取无副作用状态和标准模板目录。 */
onMounted(loadInitialState);
</script>

<style scoped>
.demo-data-page{width:100%;min-width:0;max-width:100%}.status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.ownership-grid{margin-top:14px}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.section-heading h2{margin:0;color:#123b79;font-size:17px}.section-heading p{margin:6px 0 0;color:#6d809e;font-size:13px;line-height:1.65}.section-heading>span{color:#6d809e;font-size:12px}.section-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}.capability-grid{display:flex;flex-wrap:wrap;gap:10px}.definition-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 16px}.definition-grid>div{min-width:0;padding:12px;border:1px solid #dce9fb;border-radius:10px;background:#f7fbff}.definition-grid dt{color:#6d809e;font-size:12px}.definition-grid dd{margin:5px 0 0;color:#183153;font-size:13px;line-height:1.5;word-break:break-word}.definition-grid__wide{grid-column:1/-1}.digest-text{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.table-scroll{width:100%;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain}.table-scroll :deep(.el-table){width:100%;min-width:0}.table-scroll :deep(.el-table__body-wrapper){min-width:0}.table-scroll :deep(.el-scrollbar){--el-scrollbar-opacity:.62;--el-scrollbar-bg-color:#5b7394;--el-scrollbar-hover-opacity:.9;--el-scrollbar-hover-bg-color:#1769e0}.table-scroll :deep(.el-scrollbar__bar.is-horizontal){height:8px;left:4px;right:4px}.table-scroll :deep(.el-scrollbar__wrap:focus-visible){outline:2px solid #1769e0;outline-offset:-2px}.blocker-list{margin:12px 0 0;padding:12px 12px 12px 32px;color:#8a2c16;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px}.blocker-list li+li{margin-top:8px}.raw-details{margin-top:14px;color:#516170}.raw-details summary{cursor:pointer;color:#1769e0}.raw-details pre{max-height:340px;margin:10px 0 0;padding:12px;color:#dbeafe;background:#071a31;border-radius:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}.cleanup-confirm-form{margin-top:16px}.catalog-card code{color:#1769e0}@media(max-width:1080px){.status-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.definition-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.status-grid,.definition-grid{grid-template-columns:1fr}.section-heading{flex-direction:column}.section-actions{justify-content:flex-start}.definition-grid__wide{grid-column:auto}}
</style>
