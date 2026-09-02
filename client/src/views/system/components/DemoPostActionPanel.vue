<template>
  <article class="page-card post-action-panel">
    <header class="section-heading">
      <div>
        <h2>集中后置动作</h2>
        <p>动作顺序、依赖、权限、确认文本和实现状态均来自服务端 Registry；前端权限只用于体验控制，服务端仍会最终校验认证、RBAC、维护态和操作者身份。</p>
      </div>
      <el-button :loading="registryLoading" @click="loadRegistry">{{ registryValid ? '刷新动作 Registry' : '读取动作 Registry' }}</el-button>
    </header>

    <el-alert v-if="registryError" type="error" :closable="false" show-icon :title="registryError" />
    <el-alert v-else-if="!registryValid" type="warning" :closable="false" show-icon title="动作 Registry 未通过 identity、动作数组或 actionKey 合同校验，所有预演和执行操作保持关闭；已有 actionRun 仍可按服务端返回结果手工查询状态。" />
    <el-alert v-else-if="!registryReady()" type="warning" :closable="false" show-icon title="Registry 中至少一个动作公共投影字段缺失，整个面板已 fail-closed；已有 actionRun 状态查询不受当前运行期影响。" />
    <PageState v-if="registryLoading && !registry.actions.length" loading description="正在读取服务端动作 Registry" />
    <PageState v-else-if="registryValid && !registry.actions.length" description="服务端当前没有发布可用的后置动作。" />

    <template v-else-if="registry.actions.length">
      <el-alert type="info" :closable="false" show-icon title="预演 blocked 是服务端返回的有效结果，不等同于网络失败；执行中状态不会自动轮询，请稍后手工刷新对应 actionRun 状态。" />
      <div class="post-action-grid">
        <article v-for="action in registry.actions" :key="action.actionKey" class="post-action-card">
          <header class="action-heading">
            <div>
              <h3>{{ displayValue(action.displayName) }}</h3>
              <code>{{ displayValue(action.actionKey) }}</code>
            </div>
            <el-tag size="small" :type="statusPresentation(action).type">{{ statusPresentation(action).label }}</el-tag>
          </header>

          <dl class="action-definition-grid">
            <div><dt>实现状态</dt><dd>{{ displayValue(action.implementationStatus) }}</dd></div>
            <div><dt>效果模式</dt><dd>{{ displayValue(action.effectMode) }}</dd></div>
            <div><dt>预演权限</dt><dd>{{ displayValue(action.previewPermission) }}</dd></div>
            <div><dt>执行权限</dt><dd>{{ displayValue(action.executePermission) }}</dd></div>
            <div><dt>resolver 版本</dt><dd>{{ displayValue(action.resolverVersion) }}</dd></div>
            <div><dt>executor 版本</dt><dd>{{ displayValue(action.executorVersion) }}</dd></div>
            <div><dt>预演有效期</dt><dd>{{ previewTtlText(action.previewTtlMs) }}</dd></div>
            <div class="action-definition-grid__wide"><dt>确认文本</dt><dd>{{ displayValue(action.confirmationText) }}</dd></div>
            <div class="action-definition-grid__wide"><dt>依赖</dt><dd>{{ listText(action.dependencies) }}</dd></div>
            <div class="action-definition-grid__wide"><dt>所需数据绑定</dt><dd>{{ listText(action.requiredArtifactBindings) }}</dd></div>
            <div class="action-definition-grid__wide"><dt>输出实体类型</dt><dd>{{ listText(action.outputEntityTypes) }}</dd></div>
          </dl>

          <el-alert v-if="!actionProjectionComplete(action)" type="warning" :closable="false" show-icon title="服务端动作投影字段不完整，当前动作只读禁用。" />
          <el-alert v-else-if="action.implementationStatus !== 'connected'" type="info" :closable="false" show-icon title="当前动作未明确 connected，预演、执行和新增请求均保持关闭。" />
          <el-alert v-else-if="!previewPermissionAllowed(action) || !executePermissionAllowed(action)" type="info" :closable="false" show-icon title="当前账号未同时满足系统后置动作权限与该动作领域权限；服务端仍会执行最终鉴权。" />

          <div class="action-controls">
            <el-button type="primary" :loading="stateFor(action).preview.loading" :disabled="!canPreviewAction(action)" @click="previewAction(action, { forceNew: Boolean(stateFor(action).preview.result) })">
              {{ previewButtonLabel(action) }}
            </el-button>
            <el-button :loading="stateFor(action).status.loading" :disabled="!canQueryStatus(action)" @click="queryActionStatus(action)">刷新 actionRun 状态</el-button>
          </div>
          <p v-if="stateFor(action).preview.error" class="error-line">预演失败：{{ stateFor(action).preview.error }}</p>
          <p v-if="stateFor(action).execute.error" class="error-line">执行失败：{{ stateFor(action).execute.error }}</p>
          <p v-if="stateFor(action).status.error" class="error-line">状态查询失败：{{ stateFor(action).status.error }}</p>

          <template v-if="stateFor(action).preview.result || stateFor(action).execute.result || stateFor(action).status.result">
            <dl class="action-runtime-grid">
              <div><dt>actionRunId</dt><dd class="digest-text">{{ displayValue(stateFor(action).trackedActionRunId) }}</dd></div>
              <div><dt>当前状态</dt><dd>{{ statusPresentation(action).label }}（{{ statusPresentation(action).status }}）</dd></div>
              <div><dt>blocker</dt><dd>{{ blockerText(actionResult(action)) }}</dd></div>
              <div><dt>preview 过期时间</dt><dd>{{ formatUtc(actionResult(action)?.previewExpiresAt) }}</dd></div>
            </dl>

            <el-form v-if="canShowExecute(action)" label-position="top" class="action-confirm-form" @submit.prevent="executeAction(action)">
              <el-form-item :label="`请输入固定确认文本：${displayValue(action.confirmationText)}`">
                <el-input v-model="stateFor(action).confirmationInput" autocomplete="off" :disabled="!canExecuteAction(action)" />
              </el-form-item>
              <el-button type="success" :loading="stateFor(action).execute.loading" :disabled="!canExecuteAction(action)" @click="executeAction(action)">确认执行</el-button>
            </el-form>

            <details class="raw-details">
              <summary>查看服务端公共响应</summary>
              <pre>{{ formattedJson(actionResult(action)) }}</pre>
            </details>
          </template>
          <p v-else class="muted">尚未生成该动作的服务端预演；页面不会自动发起预演、执行或状态请求。</p>
        </article>
      </div>
    </template>
  </article>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { getDemoPostActionRegistry, previewDemoPostAction, executeDemoPostAction, getDemoPostActionRun } from '@/api/demoData';
import PageState from '@/components/PageState.vue';
import { hasPermi } from '@/utils/permission';
import {
  areDemoPostActionRegistryIdentitiesEqual,
  areDemoPostActionRequestsIdle,
  buildDemoPostActionBindingSnapshot,
  canExecuteDemoPostAction,
  canPreviewDemoPostAction,
  generateDemoPostActionClientRequestId,
  getDemoPostActionStatusPresentation,
  isCurrentDemoPostActionStatusResult,
  isDemoPostActionBindingCurrent,
  isLatestDemoPostActionGeneration,
  isValidDemoPostActionRegistryIdentity,
  normalizeDemoPostActionActionRunId,
  normalizeDemoPostActionKey,
  normalizeDemoPostActionRun,
  normalizeDemoPostActionRunId,
  normalizeDemoPostActionStatus,
  resolveDemoPostActionExecutablePreview,
  stableDemoPostActionSignature
} from '@/utils/demoPostActionManagement';

const props = defineProps({
  /** 服务端运行期只读投影；缺失时所有可写动作保持关闭。 */
  runtime: { type: Object, default: () => ({ available: false, enabled: false, runtimeEpoch: null, revision: null }) },
  /** 当前 active run 只读投影；缺失时所有可写动作保持关闭。 */
  activeRun: { type: Object, default: null },
  /** 当前 active run 与 manifest 的兼容性只读投影。 */
  activeRunCompatibility: { type: Object, default: null }
});
const emit = defineEmits(['succeeded']);

/** Registry 默认空投影；保持模板安全并支持保留历史 actionRun 状态。 */
const registry = ref({ identity: null, actions: [] });
/** Registry 是否通过 identity、数组和 actionKey 完整合同校验。 */
const registryValid = ref(false);
/** Registry 请求状态与错误；请求 generation 独立于每个动作。 */
const registryLoading = ref(false);
const registryError = ref('');
const registryRequestGeneration = ref(0);
/** 按服务端 actionKey 动态创建的动作状态，不维护客户端动作白名单。 */
const actionStates = reactive({});

/** 创建单个 action 的三类请求和执行证据状态。 */
function createActionState() {
  return {
    preview: { loading: false, error: '', result: null, generation: 0, clientRequestId: '', bindingSnapshot: null },
    confirmationInput: '',
    execute: { loading: false, error: '', result: null, generation: 0 },
    status: { loading: false, error: '', result: null, generation: 0 },
    runObservation: { result: null, invalidResponse: false },
    trackedActionRunId: '',
    successNotified: ''
  };
}

/** 获取服务端 actionKey 对应的动态状态；异常 key 不创建本地可写状态。 */
function stateFor(action) {
  const actionKey = normalizeDemoPostActionKey(action?.actionKey);
  if (!actionKey) return createActionState();
  if (!actionStates[actionKey]) actionStates[actionKey] = createActionState();
  return actionStates[actionKey];
}

/** 安全捕获 API 请求，网络和 HTTP 失败只落到当前动作错误。 */
async function safeRequest(task) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 提取统一 API 错误文字，不把服务端内部结构提交回去。 */
function errorText(result) {
  return result?.error?.apiError?.message || result?.error?.message || '接口请求失败。';
}

/** 提取请求正文中的 public ActionRun DTO。 */
function responseData(response) {
  return response?.data && typeof response.data === 'object' ? response.data : response;
}

/** 返回严格的普通对象判断，避免数组或异常对象绕过 Registry 合同。 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 判断公共列表是否只包含非空字符串；不解释依赖或数据绑定语义。 */
function isPublicTextList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/** 验证服务端动作安全投影的公共字段；未知实现状态允许只读展示。 */
function actionProjectionComplete(action) {
  return isPlainObject(action)
    && normalizeDemoPostActionKey(action.actionKey) === action.actionKey
    && typeof action.displayName === 'string' && action.displayName.trim() !== ''
    && typeof action.implementationStatus === 'string' && action.implementationStatus.trim() !== ''
    && typeof action.previewPermission === 'string' && action.previewPermission.trim() !== ''
    && typeof action.executePermission === 'string' && action.executePermission.trim() !== ''
    && isPublicTextList(action.dependencies)
    && isPublicTextList(action.requiredArtifactBindings)
    && typeof action.effectMode === 'string' && action.effectMode.trim() !== ''
    && isPublicTextList(action.outputEntityTypes)
    && typeof action.resolverVersion === 'string' && action.resolverVersion.trim() !== ''
    && typeof action.executorVersion === 'string' && action.executorVersion.trim() !== ''
    && Number.isSafeInteger(action.previewTtlMs) && action.previewTtlMs > 0
    && typeof action.confirmationText === 'string' && action.confirmationText.trim() !== '';
}

/** 验证 Registry identity、actions 数组和 actionKey 唯一性，任一异常整体关闭。 */
function validateRegistryPayload(value) {
  if (!isPlainObject(value) || !isValidDemoPostActionRegistryIdentity(value.identity) || !Array.isArray(value.actions)) return null;
  const keys = new Set();
  for (const action of value.actions) {
    const actionKey = normalizeDemoPostActionKey(action?.actionKey);
    if (!actionKey || actionKey !== action.actionKey || keys.has(actionKey)) return null;
    keys.add(actionKey);
  }
  return { identity: { ...value.identity }, actions: value.actions.slice() };
}

/** 读取服务端 Registry；此函数只调用 Registry GET，不触发任何动作请求。 */
async function loadRegistry() {
  registryRequestGeneration.value += 1;
  const requestGeneration = registryRequestGeneration.value;
  registryLoading.value = true;
  registryError.value = '';
  const result = await safeRequest(getDemoPostActionRegistry);
  if (!isLatestDemoPostActionGeneration(requestGeneration, registryRequestGeneration.value)) return;
  registryLoading.value = false;
  if (!result.ok) {
    registryValid.value = false;
    registryError.value = errorText(result);
    return;
  }
  const nextRegistry = validateRegistryPayload(responseData(result.value));
  if (!nextRegistry) {
    registryValid.value = false;
    registryError.value = '服务端 Registry identity、动作数组或 actionKey 合同无效，页面已 fail-closed。';
    return;
  }
  const identityChanged = registryValid.value
    && !areDemoPostActionRegistryIdentitiesEqual(registry.value.identity, nextRegistry.identity);
  registry.value = nextRegistry;
  registryValid.value = true;
  registryError.value = '';
  nextRegistry.actions.forEach((action) => stateFor(action));
  if (identityChanged) invalidatePreviewEvidence('Registry identity 已变化，请重新生成预演。');
}

/** 读取当前 active run 的稳定身份。 */
function currentRunId() {
  return normalizeDemoPostActionRunId(props.activeRun?.runId ?? props.activeRun?.id);
}

/** 返回当前组件环境，供 binding 和 drift 守卫统一使用。 */
function currentEnvironment() {
  return {
    registry: registry.value,
    runtime: props.runtime,
    activeRun: props.activeRun,
    activeRunCompatibility: props.activeRunCompatibility
  };
}

/** 运行期、run、manifest 或 compatibility 变化时失效旧预演证据，但保留状态查询身份和历史结果。 */
function invalidatePreviewEvidence(reason = '当前运行环境已变化，请重新生成预演。') {
  Object.values(actionStates).forEach((state) => {
    state.preview.generation += 1;
    state.preview.result = null;
    state.preview.error = reason;
    state.preview.clientRequestId = '';
    state.preview.bindingSnapshot = null;
    state.runObservation = { result: null, invalidResponse: false };
    state.confirmationInput = '';
  });
}

/** 监听 runtime、active run 和 manifest compatibility 的深层稳定签名，拒绝旧 preview 执行证据。 */
watch(
  () => stableDemoPostActionSignature({ runtime: props.runtime, activeRun: props.activeRun, activeRunCompatibility: props.activeRunCompatibility }),
  (nextSignature, previousSignature) => {
    if (previousSignature !== undefined && nextSignature !== previousSignature) invalidatePreviewEvidence();
  }
);

/** 判断 Registry 当前仍可用于写动作门禁。 */
function registryReady() {
  return registryValid.value
    && isValidDemoPostActionRegistryIdentity(registry.value.identity)
    && Array.isArray(registry.value.actions)
    && registry.value.actions.every(actionProjectionComplete);
}

/** 返回系统后置动作下载权限；前端只用于 UX，服务端仍最终鉴权。 */
function systemPostActionPermissionAllowed() {
  return hasPermi('system:demo:download');
}

/** 返回预演领域权限；空权限编码必须在调用 hasPermi 前 fail-closed。 */
function previewDomainPermissionAllowed(action) {
  if (typeof action?.previewPermission !== 'string' || action.previewPermission.trim() === '') return false;
  return hasPermi(action.previewPermission);
}

/** 预演权限显式执行系统权限与单个领域权限 AND，禁止权限数组 OR。 */
function previewPermissionAllowed(action) {
  if (typeof action?.previewPermission !== 'string' || action.previewPermission.trim() === '') return false;
  return hasPermi('system:demo:download') && hasPermi(action.previewPermission);
}

/** 返回执行领域权限；空权限编码必须在调用 hasPermi 前 fail-closed。 */
function executeDomainPermissionAllowed(action) {
  if (typeof action?.executePermission !== 'string' || action.executePermission.trim() === '') return false;
  return hasPermi(action.executePermission);
}

/** 执行权限显式执行系统权限与单个领域权限 AND，禁止权限数组 OR。 */
function executePermissionAllowed(action) {
  if (typeof action?.executePermission !== 'string' || action.executePermission.trim() === '') return false;
  return hasPermi('system:demo:download') && hasPermi(action.executePermission);
}

/** 判断同一 action 的三类请求是否全部空闲。 */
function actionRequestsIdle(action) {
  const state = stateFor(action);
  return areDemoPostActionRequestsIdle({
    previewLoading: state.preview.loading,
    executeLoading: state.execute.loading,
    statusLoading: state.status.loading
  });
}

/** 构造预演门禁输入；不构造任何领域 payload。 */
function previewOptions(action) {
  return {
    registry: registry.value,
    actionDefinition: action,
    actionKey: action?.actionKey,
    runtime: props.runtime,
    activeRun: props.activeRun,
    activeRunCompatibility: props.activeRunCompatibility,
    systemPermission: systemPostActionPermissionAllowed(),
    domainPermission: previewDomainPermissionAllowed(action),
    currentEnvironment: currentEnvironment()
  };
}

/** 预演只允许完整 Registry、connected、完整运行环境、双权限且同动作请求空闲。 */
function canPreviewAction(action) {
  return registryReady()
    && actionProjectionComplete(action)
    && previewPermissionAllowed(action)
    && canPreviewDemoPostAction(previewOptions(action))
    && actionRequestsIdle(action);
}

/** 返回预演按钮中文标签；网络失败重试会复用原 clientRequestId。 */
function previewButtonLabel(action) {
  const preview = stateFor(action).preview;
  if (preview.result) return '重新预演';
  if (preview.error && preview.clientRequestId) return '重试预演';
  return '生成预演';
}

/** 返回最新可信状态下的 execute 候选；未知或无效观察结果也必须 fail-closed。 */
function executablePreview(action) {
  const state = stateFor(action);
  const preview = state.preview.result;
  if (!preview) return null;
  const hasObservation = state.runObservation.invalidResponse || state.runObservation.result !== null;
  const latestObservation = hasObservation ? state.runObservation.result : preview;
  return resolveDemoPostActionExecutablePreview(preview, latestObservation);
}

/** 执行只使用严格 helper 校验的原始 preview 证据和 Registry 确认文本。 */
function canExecuteAction(action) {
  const state = stateFor(action);
  const preview = executablePreview(action);
  if (!registryReady() || !actionProjectionComplete(action) || !preview || !executePermissionAllowed(action)) return false;
  return canExecuteDemoPostAction({
    actionRun: preview,
    registry: registry.value,
    actionDefinition: action,
    runId: currentRunId(),
    actionKey: action.actionKey,
    clientRequestId: state.preview.clientRequestId,
    actionRunId: normalizeDemoPostActionActionRunId(preview.actionRunId),
    bindingSnapshot: state.preview.bindingSnapshot,
    currentEnvironment: currentEnvironment(),
    systemPermission: systemPostActionPermissionAllowed(),
    domainPermission: executeDomainPermissionAllowed(action),
    confirmationText: state.confirmationInput,
    previewLoading: state.preview.loading,
    executeLoading: state.execute.loading,
    statusLoading: state.status.loading
  });
}

/** 只有当前 Registry、binding 和最新可信状态仍精确为 previewed 时显示确认区。 */
function canShowExecute(action) {
  const state = stateFor(action);
  return Boolean(registryReady()
    && actionProjectionComplete(action)
    && executablePreview(action)
    && isDemoPostActionBindingCurrent(state.preview.bindingSnapshot, currentEnvironment())
    && action.implementationStatus === 'connected');
}

/** 判断状态查询权限；状态查询不依赖 runtime、active run 或 implementationStatus。 */
function canQueryStatus(action) {
  const state = stateFor(action);
  return Boolean(normalizeDemoPostActionActionRunId(state.trackedActionRunId)
    && hasPermi('system:demo:view')
    && !state.status.loading
    && actionRequestsIdle(action));
}

/** 判断预演响应是否仍绑定发起时的 Registry、run、runtime、manifest 和 compatibility。 */
function isCurrentPreviewContext(action, state, capture) {
  return registryReady()
    && isLatestDemoPostActionGeneration(capture.generation, state.preview.generation)
    && areDemoPostActionRegistryIdentitiesEqual(capture.registryIdentity, registry.value.identity)
    && capture.actionKey === action.actionKey
    && capture.runId === currentRunId()
    && isDemoPostActionBindingCurrent(capture.bindingSnapshot, currentEnvironment());
}

/** 预演请求；网络失败保留原 clientRequestId，显式重新预演才生成新幂等标识。 */
async function previewAction(action, options = {}) {
  const state = stateFor(action);
  if (!canPreviewAction(action)) return;
  const previousStatus = normalizeDemoPostActionStatus(state.preview.result?.status);
  const shouldGenerateNewId = options.forceNew === true
    || !state.preview.clientRequestId
    || ['succeeded', 'blocked', 'expired'].includes(previousStatus);
  if (shouldGenerateNewId) state.preview.clientRequestId = generateDemoPostActionClientRequestId();
  const runId = currentRunId();
  const actionKey = normalizeDemoPostActionKey(action.actionKey);
  const registryIdentity = { ...registry.value.identity };
  const bindingSnapshot = buildDemoPostActionBindingSnapshot({ ...currentEnvironment(), actionKey });
  if (!bindingSnapshot) return;
  state.preview.generation += 1;
  const generation = state.preview.generation;
  const clientRequestId = state.preview.clientRequestId;
  state.preview.loading = true;
  state.preview.error = '';
  state.preview.result = null;
  state.preview.bindingSnapshot = null;
  state.runObservation = { result: null, invalidResponse: false };
  state.confirmationInput = '';
  const result = await safeRequest(() => previewDemoPostAction(runId, actionKey, clientRequestId));
  state.preview.loading = false;
  const current = isCurrentPreviewContext(action, state, { generation, actionKey, runId, registryIdentity, bindingSnapshot });
  if (!current) return;
  if (!result.ok) {
    state.preview.error = errorText(result);
    return;
  }
  const publicRun = responseData(result.value);
  const normalizedRun = normalizeDemoPostActionRun(publicRun);
  if (!normalizedRun || !isValidPreviewResponse(normalizedRun, { runId, actionKey, clientRequestId })) {
    state.preview.error = '服务端未返回完整、匹配当前动作的公共预演结果，页面保持关闭。';
    return;
  }
  state.execute.result = null;
  state.execute.error = '';
  state.status.result = null;
  state.status.error = '';
  state.runObservation = { result: publicRun, invalidResponse: false };
  state.preview.result = publicRun;
  state.preview.bindingSnapshot = bindingSnapshot;
  state.trackedActionRunId = normalizedRun.actionRunId;
}

/** 验证预演 DTO 身份；blocked 仍是有效公共结果，不写入错误字段。 */
function isValidPreviewResponse(normalizedRun, expected) {
  return normalizedRun.runId === expected.runId
    && normalizedRun.actionKey === expected.actionKey
    && normalizedRun.clientRequestId === expected.clientRequestId;
}

/** 执行当前预演证据，失败重试复用原 preview clientRequestId、digest 和确认文本。 */
async function executeAction(action) {
  const state = stateFor(action);
  if (!canExecuteAction(action)) return;
  const preview = executablePreview(action);
  const normalizedPreview = normalizeDemoPostActionRun(preview);
  if (!normalizedPreview) return;
  const actionRunId = normalizedPreview.actionRunId;
  const runId = normalizedPreview.runId;
  const previewGeneration = state.preview.generation;
  const executeGeneration = state.execute.generation + 1;
  state.execute.generation = executeGeneration;
  state.execute.loading = true;
  state.execute.error = '';
  state.status.result = null;
  const clientRequestId = normalizedPreview.clientRequestId;
  const previewDigest = normalizedPreview.previewDigest;
  const confirmationText = action.confirmationText;
  const registryIdentity = { ...registry.value.identity };
  const bindingSnapshot = state.preview.bindingSnapshot;
  const result = await safeRequest(() => executeDemoPostAction(actionRunId, { clientRequestId, previewDigest, confirmationText }));
  const current = state.execute.generation === executeGeneration
    && state.trackedActionRunId === actionRunId
    && state.preview.generation === previewGeneration
    && registryReady()
    && areDemoPostActionRegistryIdentitiesEqual(registryIdentity, registry.value.identity)
    && isDemoPostActionBindingCurrent(bindingSnapshot, currentEnvironment());
  if (state.execute.generation === executeGeneration) state.execute.loading = false;
  if (!current) return;
  if (!result.ok) {
    state.execute.error = errorText(result);
    return;
  }
  const publicRun = responseData(result.value);
  const normalizedRun = normalizeDemoPostActionRun(publicRun);
  if (!normalizedRun || !isValidActionRunResponse(normalizedRun, { actionRunId, runId, actionKey: action.actionKey, clientRequestId, previewDigest })) {
    state.execute.result = publicRun;
    state.runObservation = { result: null, invalidResponse: true };
    state.confirmationInput = '';
    state.execute.error = '服务端未返回完整、匹配当前预演证据的公共执行结果，页面保持关闭。';
    return;
  }
  state.execute.result = publicRun;
  state.runObservation = { result: publicRun, invalidResponse: false };
  if (normalizedRun.status !== 'previewed') state.confirmationInput = '';
  notifySucceeded(action, state, publicRun, normalizedRun);
}

/** 验证执行响应只能对应当前 actionRun 和原预演证据。 */
function isValidActionRunResponse(normalizedRun, expected) {
  return normalizedRun.actionRunId === expected.actionRunId
    && normalizedRun.runId === expected.runId
    && normalizedRun.actionKey === expected.actionKey
    && normalizedRun.clientRequestId === expected.clientRequestId
    && normalizedRun.previewDigest === expected.previewDigest;
}

/** 查询已跟踪 actionRun 状态；仅使用 actionRunId，不依赖当前 runtime 或 active run。 */
async function queryActionStatus(action) {
  const state = stateFor(action);
  const actionRunId = normalizeDemoPostActionActionRunId(state.trackedActionRunId);
  if (!canQueryStatus(action) || !actionRunId) return;
  state.status.generation += 1;
  const requestGeneration = state.status.generation;
  const expectedPreview = normalizeDemoPostActionRun(state.preview.result);
  state.status.loading = true;
  state.status.error = '';
  const result = await safeRequest(() => getDemoPostActionRun(actionRunId));
  const current = isCurrentDemoPostActionStatusResult({
    requestGeneration,
    latestGeneration: state.status.generation,
    requestActionRunId: actionRunId,
    expectedActionRunId: state.trackedActionRunId
  });
  if (current) state.status.loading = false;
  if (!current) return;
  if (!result.ok) {
    state.status.error = errorText(result);
    return;
  }
  const publicRun = responseData(result.value);
  const normalizedRun = normalizeDemoPostActionRun(publicRun);
  const statusIdentityMatches = normalizedRun
    && normalizedRun.actionRunId === actionRunId
    && normalizedRun.actionKey === action.actionKey
    && (!expectedPreview || (
      normalizedRun.runId === expectedPreview.runId
      && normalizedRun.clientRequestId === expectedPreview.clientRequestId
      && normalizedRun.previewDigest === expectedPreview.previewDigest
    ));
  state.status.result = publicRun;
  state.runObservation = { result: statusIdentityMatches ? publicRun : null, invalidResponse: !statusIdentityMatches };
  if (!statusIdentityMatches) {
    state.confirmationInput = '';
    state.status.error = '服务端未返回匹配当前 actionRunId 的完整公共状态结果，旧预演执行资格已失效。';
    return;
  }
  if (normalizedRun.status !== 'previewed') state.confirmationInput = '';
  notifySucceeded(action, state, publicRun, normalizedRun);
}

/** 同一 actionRunId 的 succeeded 只向父页通知一次。 */
function notifySucceeded(action, state, result, normalizedRun) {
  if (normalizedRun.status !== 'succeeded' || state.successNotified === normalizedRun.actionRunId) return;
  state.successNotified = normalizedRun.actionRunId;
  emit('succeeded', {
    actionRunId: normalizedRun.actionRunId,
    runId: normalizedRun.runId,
    actionKey: normalizedRun.actionKey,
    result
  });
}

/** 返回当前动作最新可展示的公共结果；不组装或提交结果字段。 */
function actionResult(action) {
  const state = stateFor(action);
  return state.status.result || state.execute.result || state.preview.result || null;
}

/** 返回当前动作的通用生命周期状态，未知状态保持 fail-closed。 */
function statusPresentation(action) {
  const state = stateFor(action);
  const currentStatus = state.status.result?.status || state.execute.result?.status || state.preview.result?.status;
  return getDemoPostActionStatusPresentation(state.runObservation.invalidResponse ? 'unknown' : currentStatus);
}

/** 返回 blocker 的安全可读文本。 */
function blockerText(result) {
  const blocker = result?.blocker;
  if (blocker === null) return '无';
  if (!blocker) return '未返回';
  if (typeof blocker === 'string') return blocker;
  return blocker.message || blocker.code || '服务端已返回 blocker';
}

/** 格式化公共数组字段。 */
function listText(value) {
  return Array.isArray(value) && value.length ? value.join('、') : '无';
}

/** 格式化空值。 */
function displayValue(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

/** 格式化预演有效期。 */
function previewTtlText(value) {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value / 1000)} 秒` : '—';
}

/** 只显示服务端严格 UTC 毫秒时间，异常值不猜测时区。 */
function formatUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return '—';
  return value;
}

/** 以可折叠文本展示服务端公共 DTO。 */
function formattedJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '服务端响应无法展示。';
  }
}

/** 组件挂载只读取服务端 Registry，不自动 preview、execute 或 status。 */
onMounted(loadRegistry);

</script>

<style scoped>
.post-action-panel{width:100%;min-width:0;max-width:100%;margin-top:0}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.section-heading h2{margin:0;color:#123b79;font-size:17px}.section-heading p{margin:6px 0 0;color:#6d809e;font-size:13px;line-height:1.65}.post-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.post-action-card{min-width:0;padding:16px;border:1px solid #dce9fb;border-radius:12px;background:linear-gradient(145deg,#fff 0%,#f7fbff 100%);box-shadow:0 5px 18px rgba(24,74,145,.06)}.action-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.action-heading h3{margin:0;color:#173d78;font-size:16px}.action-heading code{display:block;margin-top:5px;color:#557397;font-size:12px;overflow-wrap:anywhere}.action-definition-grid,.action-runtime-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0}.action-definition-grid>div,.action-runtime-grid>div{min-width:0;padding:9px 10px;border:1px solid #e2ecfa;border-radius:9px;background:#fff}.action-definition-grid__wide{grid-column:1/-1}.action-definition-grid dt,.action-runtime-grid dt{color:#7083a0;font-size:11px}.action-definition-grid dd,.action-runtime-grid dd{margin:4px 0 0;color:#183153;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.digest-text{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.action-controls{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.action-confirm-form{margin-top:15px}.error-line{margin:10px 0 0;color:#b42318;font-size:12px;line-height:1.5}.muted{margin:14px 0 0;color:#7b8da6;font-size:12px;line-height:1.5}.raw-details{margin-top:14px;color:#516170}.raw-details summary{cursor:pointer;color:#1769e0}.raw-details pre{max-height:300px;margin:10px 0 0;padding:12px;color:#dbeafe;background:#071a31;border-radius:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}.post-action-panel>.el-alert{margin-bottom:12px}@media(max-width:900px){.post-action-grid{grid-template-columns:1fr}}@media(max-width:600px){.section-heading{flex-direction:column}.action-definition-grid,.action-runtime-grid{grid-template-columns:1fr}.action-definition-grid__wide{grid-column:auto}.action-controls{flex-direction:column;align-items:stretch}.action-controls .el-button{margin-left:0}}
</style>
