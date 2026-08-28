import axios from 'axios';
import { ElMessage } from 'element-plus';
import { applyTrustedAuthorization, applyTrustedDemoContext, normalizeApiBase, resolveApiBase } from '@/utils/apiBase';
import { useAppStore } from '@/stores/app';

const http = axios.create({ timeout: 20000 });

// Blob 错误解析模块：下载接口也必须保留服务端 JSON 错误合同，不读取或泄露非 JSON 文件正文。

/** 判断响应类型是否明确声明为 JSON。 */
function isJsonContentType(value = '') {
  return typeof value === 'string' && /(?:^|\/)json(?:;|$)|\+json(?:;|$)/i.test(value);
}

/**
 * 尝试解析下载失败返回的 JSON Blob；非 JSON 或解析失败时原样返回 Blob。
 * @param {unknown} data Axios 响应正文。
 * @param {Record<string, unknown>} headers Axios 响应头。
 * @returns {Promise<unknown>} JSON 对象或原响应正文。
 */
export async function parseJsonErrorBlob(data, headers = {}) {
  const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
  if (!isBlob) return data;

  // 内容类型：优先使用 Blob 自身类型，同时兼容 Axios 标准化后的响应头。
  const contentType = data.type || headers?.['content-type'] || headers?.get?.('content-type') || '';
  if (!isJsonContentType(contentType)) return data;

  try {
    // JSON 文本仅用于结构化错误解析，解析失败时不投影正文到 message。
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return data;
  }
}

http.interceptors.request.use((config) => {
  const requestedBase = useAppStore().apiBase || localStorage.getItem('charcoal.apiBase') || resolveApiBase();
  const baseURL = normalizeApiBase(requestedBase);
  config.baseURL = baseURL;
  applyTrustedAuthorization(config, baseURL, localStorage.getItem('charcoal.token'));
  applyTrustedDemoContext(config, baseURL);
  return config;
});
http.interceptors.response.use((response) => {
  const body = response.data;
  if (body && body.success === false) return Promise.reject(Object.assign(new Error(body.error?.message || '请求失败'), { response, apiError: body.error }));
  return response;
}, async (error) => {
  const status = error.response?.status;
  if (error.response) {
    // 下载请求声明 responseType=blob 后，错误 JSON 也会成为 Blob；先恢复统一响应合同。
    error.response.data = await parseJsonErrorBlob(error.response.data, error.response.headers);
  }
  // 服务端错误投影：完整保留 code、message 和 details，供页面按真实合同展示。
  const apiError = error.response?.data?.error;
  if (apiError && typeof apiError === 'object') error.apiError = apiError;
  error.message = apiError?.message || error.message || '网络请求失败。';
  if (status === 401) {
    localStorage.removeItem('charcoal.token');
    try {
      const keys = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('charcoal.demoContext.v2:')) keys.push(key);
      }
      keys.forEach((key) => sessionStorage.removeItem(key));
    } catch { /* sessionStorage 可能不可用 */ }
    window.dispatchEvent(new CustomEvent('charcoal:unauthenticated'));
  }
  if (status === 403) ElMessage.warning(apiError?.message || '当前账号没有操作权限。');
  return Promise.reject(error);
});

export function query(params = {}) { return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined)); }
export async function request(config) { const response = await http(config); return response.data; }
/** 返回响应正文和响应头，供只通过 header 轮换敏感上下文的受控请求使用。 */
export async function requestWithHeaders(config) {
  const response = await http(config);
  return { data: response.data, headers: response.headers };
}
export function filenameFromDisposition(value = '') {
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded); } catch {} }
  return value.match(/filename="?([^";]+)"?/i)?.[1] || '';
}
export async function download(config, fallbackName = '下载文件') {
  const response = await http({ ...config, responseType: 'blob' });
  const resolvedFallbackName = typeof fallbackName === 'function' ? fallbackName(response) : fallbackName;
  const fileName = filenameFromDisposition(response.headers['content-disposition']) || resolvedFallbackName || '下载文件';
  const url = URL.createObjectURL(response.data); const link = document.createElement('a');
  link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  const demo = response.headers['x-demo-context'] ? {
    datasetId: response.headers['x-demo-dataset-id'] || '',
    runId: response.headers['x-demo-run-id'] || '',
    artifactKey: response.headers['x-demo-artifact-key'] || '',
    handlerKey: response.headers['x-demo-handler-key'] || '',
    manifestVersion: response.headers['x-demo-manifest-version'] || '',
    manifestDigest: response.headers['x-demo-manifest-digest'] || '',
    artifactSha256: response.headers['x-demo-artifact-sha256'] || '',
    contextToken: response.headers['x-demo-context'] || ''
  } : null;
  return { fileName, headers: response.headers, demo };
}
export default http;
