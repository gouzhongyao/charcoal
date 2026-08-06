import axios from 'axios';
import { ElMessage } from 'element-plus';
import { applyTrustedAuthorization, normalizeApiBase, resolveApiBase } from '@/utils/apiBase';
import { useAppStore } from '@/stores/app';

const http = axios.create({ timeout: 20000 });
http.interceptors.request.use((config) => {
  const requestedBase = useAppStore().apiBase || localStorage.getItem('charcoal.apiBase') || resolveApiBase();
  const baseURL = normalizeApiBase(requestedBase);
  config.baseURL = baseURL;
  applyTrustedAuthorization(config, baseURL, localStorage.getItem('charcoal.token'));
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
  if (status === 401) { localStorage.removeItem('charcoal.token'); window.dispatchEvent(new CustomEvent('charcoal:unauthenticated')); }
  if (status === 403) ElMessage.warning(apiError?.message || '当前账号没有操作权限。');
  return Promise.reject(error);
});

export function query(params = {}) { return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined)); }
export async function request(config) { const response = await http(config); return response.data; }
export function filenameFromDisposition(value = '') {
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded); } catch { return encoded; } }
  return value.match(/filename="?([^";]+)"?/i)?.[1] || '';
}
export async function download(config, fallbackName = '下载文件') {
  const response = await http({ ...config, responseType: 'blob' });
  const fileName = filenameFromDisposition(response.headers['content-disposition']) || fallbackName;
  const url = URL.createObjectURL(response.data); const link = document.createElement('a');
  link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
export default http;
