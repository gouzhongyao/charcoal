import { download, request, requestWithHeaders } from '@/api/http';

const DEMO_CONTEXT_STORAGE_PREFIX = 'charcoal.demoContext.v2';

/** 规范化演示 context 身份字段，避免同一 storage key 出现多种字符串表示。 */
function normalizeContextIdentity(value) {
  return String(value || '').trim();
}

/** 将 context 身份字段编码为无歧义的 storage key 片段。 */
function encodeContextStoragePart(value) {
  return encodeURIComponent(normalizeContextIdentity(value));
}

/** 生成 artifact/handler 一一映射的 sessionStorage key，不允许 token 进入 URL 或 localStorage。 */
function contextStorageKey(artifactKey, handlerKey) {
  return `${DEMO_CONTEXT_STORAGE_PREFIX}:${encodeContextStoragePart(artifactKey)}:${encodeContextStoragePart(handlerKey)}`;
}

/** 受控获取当前标签页 storage；浏览器策略拒绝访问时返回空值。 */
function resolveDemoContextStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

/** 读取当前标签页临时 context；旧版碰撞或身份不匹配时关闭读取且不误删其他组合。 */
export function readDemoContext(artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const normalizedArtifactKey = normalizeContextIdentity(artifactKey);
  const normalizedHandlerKey = normalizeContextIdentity(handlerKey);
  if (!contextStorage || !normalizedArtifactKey || !normalizedHandlerKey) return null;
  const key = contextStorageKey(normalizedArtifactKey, normalizedHandlerKey);
  try {
    const value = JSON.parse(contextStorage.getItem(key) || 'null');
    if (!value || value.artifactKey !== normalizedArtifactKey || value.handlerKey !== normalizedHandlerKey) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.token || '')) {
      contextStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** 将服务端 context metadata 投影为可保存的标准值；字段不完整时关闭写入。 */
function buildDemoContextValue(metadata) {
  const artifactKey = normalizeContextIdentity(metadata?.artifactKey);
  const handlerKey = normalizeContextIdentity(metadata?.handlerKey);
  const token = String(metadata?.contextToken || metadata?.token || '').trim();
  if (!artifactKey || !handlerKey || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = {
    datasetId: String(metadata?.datasetId || ''),
    runId: String(metadata?.runId || ''),
    artifactKey,
    handlerKey,
    manifestVersion: String(metadata?.manifestVersion || ''),
    manifestDigest: String(metadata?.manifestDigest || ''),
    artifactSha256: String(metadata?.artifactSha256 || '').trim().toLowerCase(),
    token
  };
  return /^[a-f0-9]{64}$/.test(value.artifactSha256) ? value : null;
}

/** 将下载响应返回的 context 暂存在 sessionStorage。 */
export function storeDemoContext(metadata, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const value = buildDemoContextValue(metadata);
  if (!contextStorage || !value) return null;
  try {
    contextStorage.setItem(contextStorageKey(value.artifactKey, value.handlerKey), JSON.stringify(value));
    return value;
  } catch {
    return null;
  }
}

/** 仅当异步请求发出前的 token 仍在当前标签页时替换 context，拒绝覆盖后来签发值。 */
function replaceDemoContextIfStateMatches(artifactKey, handlerKey, expectedContext, metadata, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const normalizedArtifactKey = normalizeContextIdentity(artifactKey);
  const normalizedHandlerKey = normalizeContextIdentity(handlerKey);
  const expectedToken = String(expectedContext?.token || '').trim() || null;
  const value = buildDemoContextValue(metadata);
  if (!contextStorage || !normalizedArtifactKey || !normalizedHandlerKey) {
    return { ok: false, reason: 'storage-unavailable' };
  }
  if (!value || value.artifactKey !== normalizedArtifactKey || value.handlerKey !== normalizedHandlerKey) {
    return { ok: false, reason: 'invalid-context' };
  }
  const currentContext = readDemoContext(normalizedArtifactKey, normalizedHandlerKey, contextStorage);
  const currentToken = currentContext?.token || null;
  if (currentToken !== expectedToken) return { ok: false, reason: 'token-changed' };
  try {
    contextStorage.setItem(contextStorageKey(normalizedArtifactKey, normalizedHandlerKey), JSON.stringify(value));
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'storage-unavailable' };
  }
}

/** 清理指定 context 或全部演示 context。 */
export function clearDemoContexts(artifactKey = null, handlerKey = null, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  if (!contextStorage) return;
  const hasArtifact = artifactKey !== null && artifactKey !== undefined;
  const hasHandler = handlerKey !== null && handlerKey !== undefined;
  try {
    if (hasArtifact || hasHandler) {
      const normalizedArtifactKey = normalizeContextIdentity(artifactKey);
      const normalizedHandlerKey = normalizeContextIdentity(handlerKey);
      if (!normalizedArtifactKey || !normalizedHandlerKey) return;
      contextStorage.removeItem(contextStorageKey(normalizedArtifactKey, normalizedHandlerKey));
      return;
    }
    const keys = [];
    for (let index = 0; index < contextStorage.length; index += 1) {
      const key = contextStorage.key(index);
      if (key?.startsWith(`${DEMO_CONTEXT_STORAGE_PREFIX}:`)) keys.push(key);
    }
    keys.forEach((key) => contextStorage.removeItem(key));
  } catch {
    // sessionStorage 可能被浏览器策略禁用；正式无 context 导入仍可继续。
  }
}

/** 仅当当前标签页仍保存指定签发 token 时清理该 context；token 已变化时保持不动。 */
export function clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken, storage) {
  const token = String(issuedToken || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const contextStorage = resolveDemoContextStorage(storage);
  const currentContext = readDemoContext(artifactKey, handlerKey, contextStorage);
  if (currentContext?.token !== token) return false;
  clearDemoContexts(artifactKey, handlerKey, contextStorage);
  return true;
}

/** 为显式 demo-aware API 请求构造共享 Axios config 字段。 */
export function demoContextRequestConfig(artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  return context ? {
    demoContext: { artifactKey, handlerKey, token: context.token }
  } : {};
}

/** 下载托管天坤集团 artifact，并严格绑定请求身份后按状态 CAS 保存 context。 */
export async function downloadManagedDemoArtifact(config, fallbackName, storage, expectedIdentity) {
  const contextStorage = resolveDemoContextStorage(storage);
  const expectedArtifactKey = normalizeContextIdentity(expectedIdentity?.artifactKey);
  const expectedHandlerKey = normalizeContextIdentity(expectedIdentity?.handlerKey);
  if (!expectedArtifactKey || !expectedHandlerKey) {
    throw new Error('托管演示下载缺少预期的 artifactKey 或 handlerKey。');
  }
  const previousContext = readDemoContext(expectedArtifactKey, expectedHandlerKey, contextStorage);
  const result = await download(config, fallbackName);
  const metadata = result?.demo;
  const responseArtifactKey = normalizeContextIdentity(metadata?.artifactKey);
  const responseHandlerKey = normalizeContextIdentity(metadata?.handlerKey);
  if (!metadata
    || !/^[A-Za-z0-9_-]{43}$/.test(metadata.contextToken || '')
    || !/^[a-f0-9]{64}$/.test(metadata.artifactSha256 || '')) {
    throw new Error('服务端未返回完整的托管演示 context。');
  }
  if (responseArtifactKey !== expectedArtifactKey || responseHandlerKey !== expectedHandlerKey) {
    throw new Error(`托管演示下载响应身份不匹配：预期 ${expectedArtifactKey}/${expectedHandlerKey}。`);
  }
  const replacement = replaceDemoContextIfStateMatches(
    expectedArtifactKey,
    expectedHandlerKey,
    previousContext,
    metadata,
    contextStorage
  );
  return { ...result, demoContextStored: replacement.ok };
}

/** 计算浏览器文件 SHA-256；能力拒绝或异常时返回空值并安全降级为正式导入。 */
async function sha256Blob(file) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (typeof Blob === 'undefined' || !(file instanceof Blob) || !subtle) return null;
    const fileBuffer = await file.arrayBuffer();
    const digest = await subtle.digest('SHA-256', fileBuffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** 从请求发出前捕获的 context 快照构造 demo-aware 请求字段，不在 await 后重新读取。 */
function contextRequestConfigFromSnapshot(context) {
  return context ? {
    demoContext: {
      artifactKey: context.artifactKey,
      handlerKey: context.handlerKey,
      token: context.token
    }
  } : {};
}

/** 预演托管 artifact；摘要 await 后仅在捕获 token 仍为当前值时携带或清理 context。 */
export async function previewManagedDemoImport(config, artifactKey, handlerKey, file, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  const issuedToken = context?.token || '';
  const fileSha256 = context ? await sha256Blob(file) : null;
  const currentContext = context
    ? readDemoContext(artifactKey, handlerKey, contextStorage)
    : null;
  const contextUnchanged = Boolean(context && currentContext?.token === issuedToken);
  const useManagedContext = Boolean(
    contextUnchanged && fileSha256 === context.artifactSha256
  );
  const contextConfig = useManagedContext ? contextRequestConfigFromSnapshot(context) : {};
  const result = await request({ ...config, ...contextConfig });
  if (context && !useManagedContext) {
    clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken, contextStorage);
  }
  return result;
}

/** 执行托管导入；仅在服务端成功后条件清理请求发出前捕获的一次性 context。 */
export async function executeManagedDemoImport(config, artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  const issuedToken = context?.token || '';
  const contextConfig = contextRequestConfigFromSnapshot(context);
  const result = await request({ ...config, ...contextConfig });
  if (context) clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken, contextStorage);
  return result;
}

/** 获取演示运行期状态。 */
export function getDemoStatus() {
  return request({ url: '/system/demo-data/status', method: 'get' });
}

/** 切换演示运行期；服务端权限和维护态仍是最终边界。 */
export function toggleDemoRuntime(enabled) {
  return request({ url: '/system/demo-data/toggle', method: 'post', data: { enabled } });
}

/** 获取标准模板目录；目录事实源来自服务端模板服务。 */
export function getDemoTemplateCatalog() {
  return request({ url: '/templates', method: 'get' });
}

/** 将服务端目录中的 /api 路径转换为共享 Axios base 下的站内请求路径。 */
export function normalizeDemoApiPath(value) {
  const path = String(value || '').trim();
  if (!path || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) return '';
  if (path === '/api') return '/';
  if (path.startsWith('/api/')) return path.slice(4);
  return path.startsWith('/') ? path : '';
}

/** 下载服务端模板目录中的标准模板，不在页面复制模板注册表。 */
export function downloadDemoStandardTemplate(template, format = 'xlsx') {
  const requestedRoute = format === 'csv' ? template?.csvRoute : template?.route;
  const route = normalizeDemoApiPath(requestedRoute);
  if (!route) throw new Error('服务端未提供可用的标准模板下载地址。');
  const fallbackName = `${String(template?.name || template?.type || '标准模板')}.${format === 'csv' ? 'csv' : 'xlsx'}`;
  return download({ url: route }, fallbackName);
}

/** 按服务端 catalog 声明的生命周期下载 artifact，未知生命周期保持关闭。 */
export function downloadDemoCatalogArtifact(artifact, format = 'xlsx', storage) {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  const route = normalizeDemoApiPath(artifact?.downloads?.[safeFormat]);
  const lifecycle = String(artifact?.downloadLifecycle || '').trim();
  if (!route) throw new Error('服务端未提供可用的 artifact 下载地址。');
  const fallbackName = `${String(artifact?.name || artifact?.artifactKey || '演示数据')}.${safeFormat}`;
  if (lifecycle === 'stateless-formal-import') return download({ url: route }, fallbackName);
  if (lifecycle === 'managed-context-auto-runtime') {
    return downloadManagedDemoArtifact({ url: route }, fallbackName, storage, {
      artifactKey: artifact?.artifactKey,
      handlerKey: artifact?.handlerKey
    });
  }
  throw new Error('服务端未声明受支持的 artifact 下载生命周期。');
}

/** 获取按当前用户领域权限过滤的 catalog 和 active run。 */
export function getDemoCatalog() {
  return request({ url: '/system/demo-data/catalog', method: 'get' });
}

/** 显式创建或复用 active run；catalog 读取不会隐式调用此接口。 */
export function prepareDemoRun() {
  return request({ url: '/system/demo-data/run', method: 'post' });
}

/** 兼容既有调用方的显式 run 准备别名。 */
export const ensureDemoRun = prepareDemoRun;

/** 读取指定演示 run 的 ownership 汇总。 */
export function getDemoOwnershipSummary(runId) {
  if (!runId) throw new Error('读取 ownership 汇总必须提供 runId。');
  return request({ url: `/system/demo-data/runs/${encodeURIComponent(runId)}/ownership-summary`, method: 'get' });
}

/** 生成当前演示 run 的清理预演摘要。 */
export function previewDemoCleanup(runId, clientRequestId) {
  if (!runId || !clientRequestId) throw new Error('清理预演必须提供 runId 和 clientRequestId。');
  return request({
    url: '/system/demo-data/cleanup/preview',
    method: 'post',
    data: { runId, clientRequestId }
  });
}

/** 执行已确认且未过期的演示清理预演。 */
export function executeDemoCleanup(payload = {}) {
  const { cleanupRunId, clientRequestId, previewDigest, confirmationText } = payload;
  if (!cleanupRunId || !clientRequestId || !previewDigest || !confirmationText) {
    throw new Error('清理执行必须提供预演、幂等请求、摘要和固定确认文本。');
  }
  return request({
    url: '/system/demo-data/cleanup/execute',
    method: 'post',
    data: { cleanupRunId, clientRequestId, previewDigest, confirmationText }
  });
}

/** 查询清理运行状态和结果。 */
export function getDemoCleanupRun(cleanupRunId) {
  if (!cleanupRunId) throw new Error('读取清理运行状态必须提供 cleanupRunId。');
  return request({ url: `/system/demo-data/cleanup-runs/${encodeURIComponent(cleanupRunId)}`, method: 'get' });
}

/** 通过受控 multipart 文件预检重新关联 context；失败清理和成功替换均使用请求前 token 做 CAS。 */
export async function reassociateDemoContext(artifactKey, handlerKey, file, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  if (!context) throw new Error('当前标签页没有可重新关联的演示 context。');
  if (!(file instanceof Blob)) throw new Error('重新关联必须选择当前修改后的文件。');
  const issuedToken = context.token;
  const formData = new FormData();
  formData.append('file', file, file.name || 'demo-import-file');
  let response;
  try {
    response = await requestWithHeaders({
      url: `/system/demo-data/contexts/reassociate/${encodeURIComponent(artifactKey)}/${encodeURIComponent(handlerKey)}`,
      method: 'post',
      data: formData,
      demoContext: {
        artifactKey,
        handlerKey,
        token: issuedToken
      }
    });
  } catch (error) {
    clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken, contextStorage);
    throw error;
  }
  const replacementToken = String(response?.headers?.['x-demo-context'] || '');
  const result = response?.data?.data;
  const replacement = replaceDemoContextIfStateMatches(artifactKey, handlerKey, context, {
    ...context,
    ...result,
    artifactSha256: result?.artifactFileSha256 || context.artifactSha256,
    contextToken: replacementToken
  }, contextStorage);
  if (!replacement.ok && replacement.reason !== 'token-changed') {
    clearDemoContextIfTokenMatches(artifactKey, handlerKey, issuedToken, contextStorage);
    throw new Error('服务端未返回有效的替换演示 context。');
  }
  return result;
}

export { DEMO_CONTEXT_STORAGE_PREFIX };
