import axios from 'axios';
import { ElMessage } from 'element-plus';
import { applyTrustedAuthorization, applyTrustedDemoContext, normalizeApiBase, resolveApiBase } from '@/utils/apiBase';
import { useAppStore } from '@/stores/app';

const http = axios.create({ timeout: 20000 });
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
}, (error) => {
  const status = error.response?.status;
  const apiError = error.response?.data?.error;
  error.message = apiError?.message || error.message || '网络请求失败。';
  if (status === 401) {
    localStorage.removeItem('charcoal.token');
    try {
      const keys = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('charcoal.demoContext.v1:')) keys.push(key);
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
