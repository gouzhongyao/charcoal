/** 演示后置动作管理纯逻辑：只消费服务端 registry 安全投影，不复制动作白名单。 */

// 服务端 registry 身份协议的稳定字段；动作、顺序、权限和 artifact 均由服务端投影提供。
const REGISTRY_IDENTITY_ALGORITHM = 'sha256';
const REGISTRY_IDENTITY_CANONICALIZATION = 'json-sorted-keys-v1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REGISTRY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ACTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const IDENTITY_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const CLIENT_REQUEST_ID_PATTERN = /^[\w:.\-/]{1,128}$/;
const STRICT_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WRITABLE_RUN_STATUSES = Object.freeze(['active', 'completed', 'cleanup_pending']);
const ACTION_RUN_STATUSES = Object.freeze(['previewed', 'blocked', 'executing', 'succeeded', 'failed', 'expired']);
const VALID_COMPATIBILITY_STATES = Object.freeze(['active', 'readable']);

// 状态展示字典只描述通用生命周期，不包含任何 actionKey 或动作顺序。
const DEMO_POST_ACTION_STATUS_PRESENTATIONS = Object.freeze({
  previewed: Object.freeze({ status: 'previewed', label: '待执行', type: 'info', known: true, executable: true, polling: false, terminal: false, failClosed: false }),
  blocked: Object.freeze({ status: 'blocked', label: '已阻断', type: 'warning', known: true, executable: false, polling: false, terminal: true, failClosed: true }),
  executing: Object.freeze({ status: 'executing', label: '执行中', type: 'primary', known: true, executable: false, polling: true, terminal: false, failClosed: true }),
  succeeded: Object.freeze({ status: 'succeeded', label: '执行成功', type: 'success', known: true, executable: false, polling: false, terminal: true, failClosed: true }),
  failed: Object.freeze({ status: 'failed', label: '执行失败', type: 'danger', known: true, executable: false, polling: false, terminal: true, failClosed: true }),
  expired: Object.freeze({ status: 'expired', label: '已过期', type: 'info', known: true, executable: false, polling: false, terminal: true, failClosed: true }),
  unknown: Object.freeze({ status: 'unknown', label: '未知状态', type: 'danger', known: false, executable: false, polling: false, terminal: false, failClosed: true })
});

// fallback clientRequestId 的进程内序号只用于极端浏览器兼容场景，不承担安全身份职责。
let fallbackClientRequestSequence = 0;

/** 判断值是否为普通 JSON object。 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** 规范化普通文本，非字符串和空白文本均按缺失处理。 */
function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 规范化 registry identity 输入，兼容直接 identity 或 registry.identity 形状。 */
function resolveRegistryIdentity(value) {
  return isPlainObject(value?.identity) ? value.identity : value;
}

/** 规范化并严格验证服务端 registry identity；异常 identity 返回 null。 */
export function normalizeDemoPostActionRegistryIdentity(value) {
  const identity = resolveRegistryIdentity(value);
  if (!isPlainObject(identity)) return null;
  const version = normalizeText(identity.version);
  const digest = typeof identity.digest === 'string' ? identity.digest.trim() : '';
  const algorithm = normalizeText(identity.algorithm);
  const canonicalization = normalizeText(identity.canonicalization);
  if (!REGISTRY_VERSION_PATTERN.test(version) || !DIGEST_PATTERN.test(digest)
    || algorithm !== REGISTRY_IDENTITY_ALGORITHM
    || canonicalization !== REGISTRY_IDENTITY_CANONICALIZATION) return null;
  return { version, digest, algorithm, canonicalization };
}

/** 公开 registry identity 校验结果，供写入门禁直接使用。 */
export function isValidDemoPostActionRegistryIdentity(value) {
  return normalizeDemoPostActionRegistryIdentity(value) !== null;
}

/** 将 JSON 值递归转换为稳定键顺序结构；循环或异常值返回 null。 */
function normalizeStableValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('非有限数字不可签名。');
    return value;
  }
  if (typeof value !== 'object') throw new Error('非 JSON 值不可签名。');
  if (seen.has(value)) throw new Error('循环 JSON 值不可签名。');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeStableValue(item, seen));
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeStableValue(value[key], seen)]));
  } finally {
    seen.delete(value);
  }
}

/** 生成不依赖属性插入顺序的稳定签名文本；无法证明时返回空字符串。 */
export function stableDemoPostActionSignature(value) {
  try {
    const normalized = normalizeStableValue(value);
    const serialized = JSON.stringify(normalized);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

/** 比较两个 JSON 值的稳定签名；任一值无法签名时 fail-closed。 */
export function areDemoPostActionValuesEqual(left, right) {
  const leftSignature = stableDemoPostActionSignature(left);
  const rightSignature = stableDemoPostActionSignature(right);
  return leftSignature !== '' && leftSignature === rightSignature;
}

/** 生成 registry identity 的规范化稳定签名；identity 异常时返回空字符串。 */
export function getDemoPostActionRegistryIdentitySignature(value) {
  const identity = normalizeDemoPostActionRegistryIdentity(value);
  return identity ? stableDemoPostActionSignature(identity) : '';
}

/** 比较两个 registry identity 的规范化稳定等值。 */
export function areDemoPostActionRegistryIdentitiesEqual(left, right) {
  const leftSignature = getDemoPostActionRegistryIdentitySignature(left);
  const rightSignature = getDemoPostActionRegistryIdentitySignature(right);
  return leftSignature !== '' && leftSignature === rightSignature;
}

/** 规范化 actionKey 文本，不对 actionKey 做客户端白名单猜测。 */
export function normalizeDemoPostActionKey(value) {
  const normalized = normalizeText(value);
  return ACTION_KEY_PATTERN.test(normalized) ? normalized : '';
}

/** 规范化演示 dataset runId 文本。 */
export function normalizeDemoPostActionRunId(value) {
  const normalized = normalizeText(value);
  return IDENTITY_TEXT_PATTERN.test(normalized) ? normalized : '';
}

/** 规范化后置动作 actionRunId 文本。 */
export function normalizeDemoPostActionRunIdIdentity(value) {
  const normalized = normalizeText(value);
  return IDENTITY_TEXT_PATTERN.test(normalized) ? normalized : '';
}

// actionRunId 语义别名用于页面和测试明确区分 dataset runId。
export const normalizeDemoPostActionActionRunId = normalizeDemoPostActionRunIdIdentity;

/** 规范化后置动作生命周期状态并统一大小写。 */
export function normalizeDemoPostActionStatus(value) {
  return normalizeText(value).toLowerCase();
}

/** 规范化服务端 clientRequestId，非法格式返回空字符串。 */
export function normalizeDemoPostActionClientRequestId(value) {
  const normalized = normalizeText(value);
  return CLIENT_REQUEST_ID_PATTERN.test(normalized) ? normalized : '';
}

/** 规范化服务端 SHA-256 digest，非小写 64 位摘要返回空字符串。 */
export function normalizeDemoPostActionDigest(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return DIGEST_PATTERN.test(normalized) ? normalized : '';
}

/** 从 registry 安全投影中按 actionKey 查找定义，不创建本地 action 映射。 */
export function findDemoPostActionDefinition(registry, actionKey) {
  const normalizedKey = normalizeDemoPostActionKey(actionKey);
  const actions = Array.isArray(registry?.actions)
    ? registry.actions
    : (Array.isArray(registry) ? registry : []);
  if (!normalizedKey) return null;
  return actions.find((action) => isPlainObject(action)
    && normalizeDemoPostActionKey(action.actionKey) === normalizedKey) || null;
}

/** 仅接受服务端精确 implementationStatus connected，unknown/not-connected 一律关闭。 */
export function isDemoPostActionConnected(actionDefinition) {
  return isPlainObject(actionDefinition) && actionDefinition.implementationStatus === 'connected';
}

/** 将权限判断结果收敛为明确 true；不调用 hasPermi，也不执行数组 OR。 */
function isExplicitPermissionGranted(value) {
  if (value === true) return true;
  return isPlainObject(value) && value.allowed === true;
}

/** 显式要求系统权限与领域权限同时通过。 */
export function hasDemoPostActionPermissionAnd(systemPermission, domainPermission) {
  return isExplicitPermissionGranted(systemPermission) && isExplicitPermissionGranted(domainPermission);
}

/** 规范化并验证运行期 generation，缺失或异常时返回 null。 */
function normalizeGeneration(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 判断 runtime 是否可用于后置动作预演。 */
export function isDemoPostActionRuntimeReady(runtime) {
  return isPlainObject(runtime)
    && runtime.available === true
    && runtime.enabled === true
    && normalizeGeneration(runtime.runtimeEpoch) !== null
    && normalizeGeneration(runtime.revision) !== null;
}

/** 判断 active run 是否属于后置动作服务端允许的可写生命周期。 */
export function isDemoPostActionRunReady(run) {
  const runId = normalizeDemoPostActionRunId(run?.runId ?? run?.id);
  const status = normalizeDemoPostActionStatus(run?.status);
  return Boolean(runId && WRITABLE_RUN_STATUSES.includes(status));
}

/** 判断 active run compatibility 是否明确证明当前 manifest 可写。 */
export function isDemoPostActionCompatibilityReady(compatibility) {
  const state = normalizeDemoPostActionStatus(compatibility?.state);
  return isPlainObject(compatibility)
    && compatibility.readable === true
    && compatibility.writeEligible === true
    && compatibility.manifestCompatible === true
    && typeof compatibility.active === 'boolean'
    && VALID_COMPATIBILITY_STATES.includes(state);
}

/** 判断 cleaning 或旧版换代阻断状态；无法识别的状态不会被当成清理完成。 */
export function isDemoPostActionCleaning(options = {}) {
  const runStatus = normalizeDemoPostActionStatus(options.activeRunStatus
    ?? options.activeRun?.status ?? options.run?.status);
  const compatibilityState = normalizeDemoPostActionStatus(
    options.compatibility?.state ?? options.activeRunCompatibility?.state
  );
  const compatibilityCode = normalizeText(
    options.compatibility?.code ?? options.activeRunCompatibility?.code
  );
  return options.cleaning === true
    || runStatus === 'cleaning'
    || compatibilityState === 'cleanup-in-progress-blocked'
    || compatibilityState === 'manifest-turnover-blocked'
    || compatibilityCode === 'DEMO_RUN_CLEANUP_IN_PROGRESS';
}

/** 解析组件传入的 action definition，始终以服务端 registry 投影为来源。 */
function resolveActionDefinition(options = {}) {
  if (isPlainObject(options.actionDefinition)) return options.actionDefinition;
  return findDemoPostActionDefinition(options.registry, options.actionKey);
}

/** 判断指定后置动作是否满足预演的 runtime/run/compatibility/权限全部门禁。 */
export function canPreviewDemoPostAction(options = {}) {
  const actionDefinition = resolveActionDefinition(options);
  const activeRun = options.activeRun ?? options.run;
  const compatibility = options.activeRunCompatibility ?? options.compatibility;
  return isDemoPostActionConnected(actionDefinition)
    && hasDemoPostActionPermissionAnd(options.systemPermission, options.domainPermission)
    && isDemoPostActionRuntimeReady(options.runtime)
    && isDemoPostActionRunReady(activeRun)
    && isDemoPostActionCompatibilityReady(compatibility)
    && !isDemoPostActionCleaning({ ...options, activeRun, compatibility })
    && buildDemoPostActionBindingSnapshot({ ...options, activeRun, compatibility }) !== null;
}

/** 返回预演门禁的稳定诊断，不向调用方暴露或猜测 action 私有细节。 */
export function evaluateDemoPostActionPreview(options = {}) {
  const eligible = canPreviewDemoPostAction(options);
  return {
    eligible,
    connected: isDemoPostActionConnected(resolveActionDefinition(options)),
    permissions: hasDemoPostActionPermissionAnd(options.systemPermission, options.domainPermission),
    runtimeReady: isDemoPostActionRuntimeReady(options.runtime),
    runReady: isDemoPostActionRunReady(options.activeRun ?? options.run),
    compatibilityReady: isDemoPostActionCompatibilityReady(options.activeRunCompatibility ?? options.compatibility),
    cleaning: isDemoPostActionCleaning(options),
    bindingReady: buildDemoPostActionBindingSnapshot(options) !== null
  };
}

/** 将 manifest 版本和 digest 从多种只读投影形状收敛为稳定快照。 */
function resolveManifestSnapshot(options = {}) {
  const activeRun = options.activeRun ?? options.run;
  const manifest = options.manifest ?? options.currentManifest ?? {};
  const manifestVersion = normalizeText(
    manifest.version ?? manifest.manifestVersion ?? options.manifestVersion
      ?? activeRun?.manifestVersion
  );
  const manifestDigest = normalizeDemoPostActionDigest(
    manifest.digest ?? manifest.manifestDigest ?? options.manifestDigest
      ?? activeRun?.manifestDigest
  );
  return manifestVersion && manifestDigest ? { manifestVersion, manifestDigest } : null;
}

/** 将 compatibility 安全字段收敛为可绑定的快照，拒绝缺失和未知状态。 */
function normalizeBindingCompatibility(value) {
  if (!isDemoPostActionCompatibilityReady(value)) return null;
  return {
    readable: true,
    writeEligible: true,
    manifestCompatible: true,
    active: value.active,
    state: normalizeDemoPostActionStatus(value.state)
  };
}

/** 读取 registry identity、runtime、run、manifest 和 compatibility 的通用绑定输入。 */
function resolveBindingInputs(options = {}) {
  const registryIdentity = normalizeDemoPostActionRegistryIdentity(
    options.registryIdentity ?? options.registry
  );
  const activeRun = options.activeRun ?? options.run;
  const runId = normalizeDemoPostActionRunId(options.runId ?? activeRun?.runId ?? activeRun?.id);
  const runtimeEpoch = normalizeGeneration(options.runtime?.runtimeEpoch ?? options.runtimeEpoch);
  const runtimeRevision = normalizeGeneration(options.runtime?.revision ?? options.runtimeRevision);
  const manifest = resolveManifestSnapshot(options);
  const compatibility = normalizeBindingCompatibility(
    options.compatibility ?? options.activeRunCompatibility
  );
  if ((isPlainObject(options.runtime) && !isDemoPostActionRuntimeReady(options.runtime))
    || (isPlainObject(activeRun) && !isDemoPostActionRunReady(activeRun))
    || isDemoPostActionCleaning({ ...options, activeRun, compatibility })) return null;
  if (!registryIdentity || !runId || runtimeEpoch === null || runtimeRevision === null
    || !manifest || !compatibility) return null;
  return {
    registryIdentity,
    runId,
    runtimeEpoch,
    runtimeRevision,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.manifestDigest,
    compatibility
  };
}

/** 构造后置动作预演 binding snapshot；任何身份缺失都阻止后续执行。 */
export function buildDemoPostActionBindingSnapshot(options = {}) {
  const inputs = resolveBindingInputs(options);
  if (!inputs) return null;
  const snapshot = {
    registryIdentity: { ...inputs.registryIdentity },
    runId: inputs.runId,
    runtimeEpoch: inputs.runtimeEpoch,
    runtimeRevision: inputs.runtimeRevision,
    manifestVersion: inputs.manifestVersion,
    manifestDigest: inputs.manifestDigest,
    compatibility: { ...inputs.compatibility }
  };
  Object.freeze(snapshot.registryIdentity);
  Object.freeze(snapshot.compatibility);
  return Object.freeze(snapshot);
}

// 预演 binding 语义别名明确该 snapshot 只能由最新预演上下文使用。
export const buildDemoPostActionPreviewBindingSnapshot = buildDemoPostActionBindingSnapshot;

/** 判断当前 runtime/run/manifest/registry/compatibility 是否仍与预演 snapshot 一致。 */
export function isDemoPostActionBindingCurrent(bindingSnapshot, currentEnvironment = {}) {
  if (!isPlainObject(bindingSnapshot)) return false;
  const current = buildDemoPostActionBindingSnapshot(currentEnvironment);
  if (!current) return false;
  const expected = buildDemoPostActionBindingSnapshot(bindingSnapshot);
  if (!expected) return false;
  return areDemoPostActionRegistryIdentitiesEqual(expected.registryIdentity, current.registryIdentity)
    && expected.runId === current.runId
    && expected.runtimeEpoch === current.runtimeEpoch
    && expected.runtimeRevision === current.runtimeRevision
    && expected.manifestVersion === current.manifestVersion
    && expected.manifestDigest === current.manifestDigest
    && areDemoPostActionValuesEqual(expected.compatibility, current.compatibility);
}

/** 规范化动作运行公共身份；状态、digest、幂等标识缺失时返回 null。 */
export function normalizeDemoPostActionRun(value) {
  if (!isPlainObject(value)) return null;
  const actionRunId = normalizeDemoPostActionRunIdIdentity(value.actionRunId);
  const runId = normalizeDemoPostActionRunId(value.runId);
  const actionKey = normalizeDemoPostActionKey(value.actionKey);
  const clientRequestId = normalizeDemoPostActionClientRequestId(value.clientRequestId);
  const previewDigest = normalizeDemoPostActionDigest(value.previewDigest);
  const status = normalizeDemoPostActionStatus(value.status);
  if (!actionRunId || !runId || !actionKey || !clientRequestId || !previewDigest
    || !ACTION_RUN_STATUSES.includes(status)) return null;
  return {
    actionRunId,
    runId,
    actionKey,
    clientRequestId,
    previewDigest,
    status,
    blocker: Object.prototype.hasOwnProperty.call(value, 'blocker') ? value.blocker : undefined,
    previewExpiresAt: value.previewExpiresAt
  };
}

/** 校验动作运行公共身份，可附加期望的 run/action/request 绑定。 */
export function isValidDemoPostActionRunIdentity(value, expected = {}) {
  const normalized = normalizeDemoPostActionRun(value);
  if (!normalized || !isPlainObject(expected)) return false;
  const hasExpectedRunId = expected.runId !== undefined;
  const hasExpectedActionKey = expected.actionKey !== undefined;
  const hasExpectedRequestId = expected.clientRequestId !== undefined;
  const hasExpectedActionRunId = expected.actionRunId !== undefined;
  const expectedRunId = hasExpectedRunId ? normalizeDemoPostActionRunId(expected.runId) : '';
  const expectedActionKey = hasExpectedActionKey ? normalizeDemoPostActionKey(expected.actionKey) : '';
  const expectedRequestId = hasExpectedRequestId
    ? normalizeDemoPostActionClientRequestId(expected.clientRequestId) : '';
  const expectedActionRunId = hasExpectedActionRunId
    ? normalizeDemoPostActionRunIdIdentity(expected.actionRunId) : '';
  if ((hasExpectedRunId && !expectedRunId)
    || (hasExpectedActionKey && !expectedActionKey)
    || (hasExpectedRequestId && !expectedRequestId)
    || (hasExpectedActionRunId && !expectedActionRunId)) return false;
  return (!hasExpectedRunId || normalized.runId === expectedRunId)
    && (!hasExpectedActionKey || normalized.actionKey === expectedActionKey)
    && (!hasExpectedRequestId || normalized.clientRequestId === expectedRequestId)
    && (!hasExpectedActionRunId || normalized.actionRunId === expectedActionRunId);
}

/**
 * 仅当最新可信 actionRun 仍精确为同一 previewed 身份时返回原预演证据。
 * failed、blocked、expired、executing、succeeded、未知 DTO 或身份漂移均 fail-closed。
 */
export function resolveDemoPostActionExecutablePreview(previewValue, latestRunValue) {
  const preview = normalizeDemoPostActionRun(previewValue);
  const latestRun = normalizeDemoPostActionRun(latestRunValue);
  if (!preview || !latestRun
    || preview.status !== 'previewed' || latestRun.status !== 'previewed'
    || preview.blocker !== null || latestRun.blocker !== null) return null;
  if (!isValidDemoPostActionRunIdentity(latestRun, {
    runId: preview.runId,
    actionKey: preview.actionKey,
    clientRequestId: preview.clientRequestId,
    actionRunId: preview.actionRunId
  }) || latestRun.previewDigest !== preview.previewDigest) return null;
  return previewValue;
}

/** 将合法时间输入解析为毫秒；无效时间不得参与执行判断。 */
function parseDemoPostActionTime(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !STRICT_UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

/** 只接受合法且严格晚于 now 的预演有效期。 */
export function isDemoPostActionPreviewUnexpired(previewExpiresAt, now = Date.now()) {
  const expiresAt = parseDemoPostActionTime(previewExpiresAt);
  const nowTimestamp = parseDemoPostActionTime(now);
  return expiresAt !== null && nowTimestamp !== null && expiresAt > nowTimestamp;
}

/** 判断后置动作 preview/execute/status 三类请求是否均处于空闲。 */
export function areDemoPostActionRequestsIdle(options = {}) {
  return options.previewLoading !== true
    && options.executeLoading !== true
    && options.statusLoading !== true;
}

/** 判断 execute 是否满足状态、身份、权限、时效、binding、确认文本和请求空闲门禁。 */
export function canExecuteDemoPostAction(options = {}) {
  const actionRun = normalizeDemoPostActionRun(options.actionRun ?? options.previewRun);
  if (!actionRun || actionRun.status !== 'previewed' || actionRun.blocker !== null) return false;
  if (!isDemoPostActionPreviewUnexpired(actionRun.previewExpiresAt, options.now ?? Date.now())) return false;
  if (!isValidDemoPostActionRunIdentity(actionRun, {
    runId: options.runId,
    actionKey: options.actionKey,
    clientRequestId: options.clientRequestId,
    actionRunId: options.actionRunId
  })) return false;
  const definition = resolveActionDefinition({
    ...options,
    actionKey: actionRun.actionKey
  });
  if (!isDemoPostActionConnected(definition)
    || normalizeDemoPostActionKey(definition.actionKey) !== actionRun.actionKey
    || !hasDemoPostActionPermissionAnd(options.systemPermission, options.domainPermission)) return false;
  if (!isDemoPostActionBindingCurrent(
    options.bindingSnapshot ?? options.binding,
    options.currentEnvironment ?? options.environment ?? options
  )) return false;
  if (typeof definition.confirmationText !== 'string'
    || definition.confirmationText.length === 0
    || options.confirmationText !== definition.confirmationText) return false;
  return areDemoPostActionRequestsIdle(options);
}

/** 返回通用后置动作状态展示信息，未知状态显式显示为 unknown 并保持关闭语义。 */
export function getDemoPostActionStatusPresentation(status) {
  const normalizedStatus = normalizeDemoPostActionStatus(status);
  return DEMO_POST_ACTION_STATUS_PRESENTATIONS[normalizedStatus]
    ? { ...DEMO_POST_ACTION_STATUS_PRESENTATIONS[normalizedStatus] }
    : { ...DEMO_POST_ACTION_STATUS_PRESENTATIONS.unknown };
}

/** 判断请求 generation 是否仍是最新 generation。 */
export function isLatestDemoPostActionGeneration(requestGeneration, latestGeneration) {
  const request = normalizeGeneration(requestGeneration);
  const latest = normalizeGeneration(latestGeneration);
  return request !== null && latest !== null && request === latest;
}

/** 判断 status 结果同时属于最新 generation 和期望 actionRunId。 */
export function isLatestDemoPostActionStatusResult(requestGeneration, latestGeneration, requestActionRunId, expectedActionRunId) {
  const requestId = normalizeDemoPostActionRunIdIdentity(requestActionRunId);
  const expectedId = normalizeDemoPostActionRunIdIdentity(expectedActionRunId);
  return isLatestDemoPostActionGeneration(requestGeneration, latestGeneration)
    && Boolean(requestId && expectedId && requestId === expectedId);
}

/** 兼容对象参数调用的 status 结果守卫，避免旧请求覆盖当前 action run。 */
export function isCurrentDemoPostActionStatusResult(...args) {
  if (args.length === 1 && isPlainObject(args[0])) {
    const options = args[0];
    return isLatestDemoPostActionStatusResult(
      options.requestGeneration,
      options.latestGeneration,
      options.requestActionRunId ?? options.actionRunId,
      options.expectedActionRunId ?? options.currentActionRunId
    );
  }
  return isLatestDemoPostActionStatusResult(...args);
}

/** 生成客户端幂等标识，优先 crypto.randomUUID，失败时仅生成客户端 fallback 标识。 */
export function generateDemoPostActionClientRequestId(randomUUIDFactory = undefined) {
  const cryptoObject = globalThis.crypto;
  const randomUUID = randomUUIDFactory === undefined ? cryptoObject?.randomUUID : randomUUIDFactory;
  if (typeof randomUUID === 'function') {
    try {
      const candidate = normalizeDemoPostActionClientRequestId(randomUUID.call(cryptoObject));
      if (candidate) return candidate;
    } catch {
      // 浏览器能力缺失或调用失败时使用客户端幂等 fallback。
    }
  }
  fallbackClientRequestSequence += 1;
  const nowPart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 12) || 'fallback';
  return `client-${nowPart}-${fallbackClientRequestSequence.toString(36)}-${randomPart}`.slice(0, 128);
}

// 语义别名供页面按“创建”或“生成”习惯调用，实际实现保持单一来源。
export const createDemoPostActionClientRequestId = generateDemoPostActionClientRequestId;
export const generateClientRequestId = generateDemoPostActionClientRequestId;

// 对外暴露通用状态常量副本，调用方不可修改内部映射。
export const DEMO_POST_ACTION_STATUS_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(DEMO_POST_ACTION_STATUS_PRESENTATIONS).map(([status, presentation]) => [status, presentation.label])
));
