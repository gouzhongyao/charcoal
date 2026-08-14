import { request, requestWithHeaders } from '@/api/http';

const DEMO_CONTEXT_STORAGE_PREFIX = 'charcoal.demoContext.v1';

/** 生成只包含 artifact/handler 的 sessionStorage key，不允许 token 进入 URL 或 localStorage。 */
function contextStorageKey(artifactKey, handlerKey) {
  return `${DEMO_CONTEXT_STORAGE_PREFIX}:${String(artifactKey || '').trim()}:${String(handlerKey || '').trim()}`;
}

/** 读取当前标签页临时 context；格式异常时立即清理。 */
export function readDemoContext(artifactKey, handlerKey, storage = globalThis.sessionStorage) {
  const key = contextStorageKey(artifactKey, handlerKey);
  try {
    const value = JSON.parse(storage?.getItem(key) || 'null');
    if (!value || value.artifactKey !== artifactKey || value.handlerKey !== handlerKey
      || !/^[A-Za-z0-9_-]{43}$/.test(value.token || '')) {
      storage?.removeItem(key);
      return null;
    }
    return value;
  } catch {
    try { storage?.removeItem(key); } catch { /* sessionStorage 可能不可用 */ }
    return null;
  }
}

/** 将下载响应返回的 context 暂存在 sessionStorage。 */
export function storeDemoContext(metadata, storage = globalThis.sessionStorage) {
  const artifactKey = String(metadata?.artifactKey || '').trim();
  const handlerKey = String(metadata?.handlerKey || '').trim();
  const token = String(metadata?.contextToken || metadata?.token || '').trim();
  if (!artifactKey || !handlerKey || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = {
    datasetId: String(metadata.datasetId || ''),
    runId: String(metadata.runId || ''),
    artifactKey,
    handlerKey,
    manifestVersion: String(metadata.manifestVersion || ''),
    manifestDigest: String(metadata.manifestDigest || ''),
    artifactSha256: String(metadata.artifactSha256 || ''),
    token
  };
  storage?.setItem(contextStorageKey(artifactKey, handlerKey), JSON.stringify(value));
  return value;
}

/** 清理指定 context 或全部演示 context。 */
export function clearDemoContexts(artifactKey = null, handlerKey = null, storage = globalThis.sessionStorage) {
  if (!storage) return;
  if (artifactKey && handlerKey) {
    storage.removeItem(contextStorageKey(artifactKey, handlerKey));
    return;
  }
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${DEMO_CONTEXT_STORAGE_PREFIX}:`)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}

/** 为显式 demo-aware API 请求构造共享 Axios config 字段。 */
export function demoContextRequestConfig(artifactKey, handlerKey, storage = globalThis.sessionStorage) {
  const context = readDemoContext(artifactKey, handlerKey, storage);
  return context ? {
    demoContext: { artifactKey, handlerKey, token: context.token }
  } : {};
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
export async function reassociateDemoContext(artifactKey, handlerKey, file, storage = globalThis.sessionStorage) {
  const context = readDemoContext(artifactKey, handlerKey, storage);
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
  }, storage);
  if (!replacement) {
    clearDemoContexts(artifactKey, handlerKey, storage);
    throw new Error('服务端未返回有效的替换演示 context。');
  }
  return result;
}

export { DEMO_CONTEXT_STORAGE_PREFIX };
