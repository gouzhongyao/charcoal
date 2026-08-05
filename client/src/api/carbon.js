import { download, query, request } from '@/api/http';

const FACTORS_URL = '/carbon/factors';
const EMISSIONS_URL = '/carbon/emissions';

/** 统一读取碳核算接口，并移除空筛选参数。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 获取碳因子列表。 */
export const getCarbonFactors = (params = {}) => get(FACTORS_URL, params);
/** 获取单条碳因子详情。 */
export const getCarbonFactor = (factorId) => get(`${FACTORS_URL}/${factorId}`);
/** 新增碳因子。 */
export const createCarbonFactor = (payload) => request({ method: 'post', url: FACTORS_URL, data: payload });
/** 编辑碳因子。 */
export const updateCarbonFactor = (factorId, payload) => request({ method: 'put', url: `${FACTORS_URL}/${factorId}`, data: payload });
/** 启用或停用碳因子；服务端没有物理删除接口。 */
export const updateCarbonFactorStatus = (factorId, status) => request({ method: 'patch', url: `${FACTORS_URL}/${factorId}/status`, data: { status } });

/** 导出当前筛选命中的碳因子。 */
export function exportCarbonFactors(params = {}, format = 'xlsx') {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `${FACTORS_URL}/export`, params: query({ ...params, format: safeFormat }) }, `碳因子导出.${safeFormat}`);
}

/** 下载受权限保护的碳因子导入模板。 */
export function downloadCarbonFactorTemplate(format = 'xlsx') {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `/templates/carbon-factors.${safeFormat}` }, `碳因子导入模板.${safeFormat}`);
}

/** 上传文件并创建碳因子导入预演。 */
export function previewCarbonFactorImport(file) {
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${FACTORS_URL}/import/preview`, data });
}

/** 以服务端签名的预演候选执行碳因子导入。 */
export const executeCarbonFactorImport = (payload) => request({ method: 'post', url: `${FACTORS_URL}/import/execute`, data: payload });

/** 获取只读碳排放结果列表。 */
export const getCarbonEmissions = (params = {}) => get(EMISSIONS_URL, params);
/** 获取当前筛选条件下的碳排放统计。 */
export const getCarbonEmissionStats = (params = {}) => get(`${EMISSIONS_URL}/stats`, params);
/** 按指定维度获取碳排放统计明细。 */
export const getCarbonEmissionStatistics = (params = {}, groupBy = 'month') => get(`${EMISSIONS_URL}/statistics`, { ...params, groupBy });
/** 导出当前筛选命中的只读碳排放结果。 */
export function exportCarbonEmissions(params = {}, format = 'xlsx') {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `${EMISSIONS_URL}/export`, params: query({ ...params, format: safeFormat }) }, `碳排放结果导出.${safeFormat}`);
}
/** 触发服务端碳排放计算，页面不写入计算结果。 */
export const calculateCarbonEmissions = (payload) => request({ method: 'post', url: `${EMISSIONS_URL}/calculate`, data: payload });
/** 获取当前筛选条件下缺失碳因子的只读提示。 */
export const getMissingCarbonFactors = (params = {}) => get(`${EMISSIONS_URL}/missing-factors`, params);
