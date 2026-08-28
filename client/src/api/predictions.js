import { download, query, request } from '@/api/http';

/** 预测统一管理 API 根路径。 */
const BASE_URL = '/predictions';

/** 发送带查询参数的预测读取请求。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 读取预测管理契约。 */
export const getPredictionManagementContract = () => get(`${BASE_URL}/contract`);
/** 查询预测配置草稿。 */
export const getPredictionConfigs = (params = {}) => get(`${BASE_URL}/configs`, params);
/** 读取单个预测配置草稿详情。 */
export const getPredictionConfig = (id) => get(`${BASE_URL}/configs/${id}`);
/** 新增预测配置草稿。 */
export const createPredictionConfig = (payload) => request({ method: 'post', url: `${BASE_URL}/configs`, data: payload });
/** 更新未归档预测配置草稿。 */
export const updatePredictionConfig = (id, payload) => request({ method: 'put', url: `${BASE_URL}/configs/${id}`, data: payload });
/** 更新预测配置归档或恢复状态。 */
export const updatePredictionConfigStatus = (id, status) => request({ method: 'patch', url: `${BASE_URL}/configs/${id}/status`, data: { status } });
/** 复制配置为新的 draft 草稿。 */
export const copyPredictionConfig = (id) => request({ method: 'post', url: `${BASE_URL}/configs/${id}/copy` });
/** 从草稿创建服务端预测运行。 */
export const runPredictionConfig = (id) => request({ method: 'post', url: `${BASE_URL}/configs/${id}/runs`, data: {} });

/** 下载受服务端权限保护的预测配置模板。 */
export function downloadPredictionConfigTemplate(format = 'xlsx') {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `/templates/prediction-configs.${safeFormat}` }, `预测配置草稿导入模板.${safeFormat}`);
}

/** 下载预测配置天坤集团示例；下载和导入均不会自动运行预测。 */
export function downloadPredictionConfigDemoParkExample() {
  return download({ url: '/templates/demo-park/12-prediction-configs.xlsx' }, '天坤集团示例-预测配置.xlsx');
}

/** 上传配置文件创建只读导入预演。 */
export function previewPredictionConfigImport(file) {
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${BASE_URL}/configs/import/preview`, data });
}

/** 执行已签名且已确认的配置草稿导入。 */
export const executePredictionConfigImport = (payload) => request({ method: 'post', url: `${BASE_URL}/configs/import/execute`, data: payload });

/** 导出当前筛选命中的预测配置草稿。 */
export function exportPredictionConfigs(params = {}) {
  return download({ url: `${BASE_URL}/configs/export`, params: query({ ...params, format: 'xlsx' }) }, '预测配置草稿导出.xlsx');
}

/** 查询预测运行。 */
export const getPredictionRuns = (params = {}) => get(`${BASE_URL}/runs`, params);
/** 查询单个预测运行及其服务端结果。 */
export const getPredictionRun = (id) => get(`${BASE_URL}/runs/${id}`);
/** 查询当前筛选下的真实运行统计。 */
export const getPredictionRunStats = (params = {}) => get(`${BASE_URL}/runs/stats`, params);
/** 取消允许取消的服务端运行。 */
export const cancelPredictionRun = (id) => request({ method: 'patch', url: `${BASE_URL}/runs/${id}/status`, data: { status: 'cancelled' } });
/** 归档终态服务端运行，结果保持只读。 */
export const archivePredictionRun = (id) => request({ method: 'patch', url: `${BASE_URL}/runs/${id}/status`, data: { status: 'archived' } });

/** 查询服务端生成的只读预测结果。 */
export const getPredictionResults = (params = {}) => get(`${BASE_URL}/results`, params);
/** 查询某次运行的只读预测结果。 */
export const getPredictionRunResults = (id, params = {}) => get(`${BASE_URL}/runs/${id}/results`, params);
/** 导出当前筛选命中的服务端预测结果。 */
export function exportPredictionResults(params = {}) {
  return download({ url: `${BASE_URL}/results/export`, params: query({ ...params, format: 'xlsx' }) }, '预测结果导出.xlsx');
}
