import { download, request, requestWithHeaders } from '@/api/http';

const DEMO_CONTEXT_STORAGE_PREFIX = 'charcoal.demoContext.v1';

/** 生成只包含 artifact/handler 的 sessionStorage key，不允许 token 进入 URL 或 localStorage。 */
function contextStorageKey(artifactKey, handlerKey) {
  return `${DEMO_CONTEXT_STORAGE_PREFIX}:${String(artifactKey || '').trim()}:${String(handlerKey || '').trim()}`;
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

/** 读取当前标签页临时 context；格式异常时立即清理。 */
export function readDemoContext(artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const key = contextStorageKey(artifactKey, handlerKey);
  try {
    const value = JSON.parse(contextStorage?.getItem(key) || 'null');
    if (!value || value.artifactKey !== artifactKey || value.handlerKey !== handlerKey
      || !/^[A-Za-z0-9_-]{43}$/.test(value.token || '')) {
      contextStorage?.removeItem(key);
      return null;
    }
    return value;
  } catch {
    try { contextStorage?.removeItem(key); } catch { /* sessionStorage 可能不可用 */ }
    return null;
  }
}

/** 将下载响应返回的 context 暂存在 sessionStorage。 */
export function storeDemoContext(metadata, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const artifactKey = String(metadata?.artifactKey || '').trim();
  const handlerKey = String(metadata?.handlerKey || '').trim();
  const token = String(metadata?.contextToken || metadata?.token || '').trim();
  if (!contextStorage || !artifactKey || !handlerKey || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = {
    datasetId: String(metadata.datasetId || ''),
    runId: String(metadata.runId || ''),
    artifactKey,
    handlerKey,
    manifestVersion: String(metadata.manifestVersion || ''),
    manifestDigest: String(metadata.manifestDigest || ''),
    artifactSha256: String(metadata.artifactSha256 || '').trim().toLowerCase(),
    token
  };
  if (!/^[a-f0-9]{64}$/.test(value.artifactSha256)) return null;
  try {
    contextStorage.setItem(contextStorageKey(artifactKey, handlerKey), JSON.stringify(value));
    return value;
  } catch {
    return null;
  }
}

/** 清理指定 context 或全部演示 context。 */
export function clearDemoContexts(artifactKey = null, handlerKey = null, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  if (!contextStorage) return;
  try {
    if (artifactKey && handlerKey) {
      contextStorage.removeItem(contextStorageKey(artifactKey, handlerKey));
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

/** 为显式 demo-aware API 请求构造共享 Axios config 字段。 */
export function demoContextRequestConfig(artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  return context ? {
    demoContext: { artifactKey, handlerKey, token: context.token }
  } : {};
}

/** 下载托管青岚 artifact，并只在服务端返回完整 context 时保存到当前标签页。 */
export async function downloadManagedDemoArtifact(config, fallbackName, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const result = await download(config, fallbackName);
  const metadata = result.demo;
  if (!metadata
    || !metadata.artifactKey
    || !metadata.handlerKey
    || !/^[A-Za-z0-9_-]{43}$/.test(metadata.contextToken || '')
    || !/^[a-f0-9]{64}$/.test(metadata.artifactSha256 || '')) {
    throw new Error('服务端未返回完整的托管演示 context。');
  }
  return { ...result, demoContextStored: Boolean(storeDemoContext(metadata, contextStorage)) };
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

/** 预演托管 artifact；只有原下载文件摘要匹配时附加 context，否则成功后清理并走正式导入。 */
export async function previewManagedDemoImport(config, artifactKey, handlerKey, file, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  const fileSha256 = context ? await sha256Blob(file) : null;
  const useManagedContext = Boolean(context && fileSha256 === context.artifactSha256);
  const contextConfig = useManagedContext
    ? demoContextRequestConfig(artifactKey, handlerKey, contextStorage)
    : {};
  const result = await request({ ...config, ...contextConfig });
  if (context && !useManagedContext) clearDemoContexts(artifactKey, handlerKey, contextStorage);
  return result;
}

/** 执行托管导入；仅在服务端成功后清理已经消费的一次性 context。 */
export async function executeManagedDemoImport(config, artifactKey, handlerKey, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const contextConfig = demoContextRequestConfig(artifactKey, handlerKey, contextStorage);
  const result = await request({ ...config, ...contextConfig });
  if (contextConfig.demoContext) clearDemoContexts(artifactKey, handlerKey, contextStorage);
  return result;
}

/** 获取演示运行期状态。 */
export function getDemoStatus() {
  return request({ url: '/system/demo-data/status', method: 'get' });
}

/** 获取按当前用户领域权限过滤的 catalog 和 active run。 */
export function getDemoCatalog() {
  return request({ url: '/system/demo-data/catalog', method: 'get' });
}

/** 创建或复用 active run。 */
export function ensureDemoRun() {
  return request({ url: '/system/demo-data/run', method: 'post' });
}

/** 通过受控 multipart 文件预检重新关联 context；旧 token 仅进入唯一请求头。 */
export async function reassociateDemoContext(artifactKey, handlerKey, file, storage) {
  const contextStorage = resolveDemoContextStorage(storage);
  const context = readDemoContext(artifactKey, handlerKey, contextStorage);
  if (!context) throw new Error('当前标签页没有可重新关联的演示 context。');
  if (!(file instanceof Blob)) throw new Error('重新关联必须选择当前修改后的文件。');
  const formData = new FormData();
  formData.append('file', file, file.name || 'demo-import-file');
  const response = await requestWithHeaders({
    url: `/system/demo-data/contexts/reassociate/${encodeURIComponent(artifactKey)}/${encodeURIComponent(handlerKey)}`,
    method: 'post',
    data: formData,
    demoContext: {
      artifactKey,
      handlerKey,
      token: context.token
    }
  });
  const replacementToken = String(response.headers?.['x-demo-context'] || '');
  const result = response.data?.data;
  const replacement = storeDemoContext({
    ...context,
    ...result,
    artifactSha256: result?.artifactFileSha256 || context.artifactSha256,
    contextToken: replacementToken
  }, contextStorage);
  if (!replacement) {
    clearDemoContexts(artifactKey, handlerKey, contextStorage);
    throw new Error('服务端未返回有效的替换演示 context。');
  }
  return result;
}

export { DEMO_CONTEXT_STORAGE_PREFIX };
