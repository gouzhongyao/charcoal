import { download, query, request } from '@/api/http';
import { buildImportOriginalFileFallbackName } from '@/utils/specialModules';

/** 数据导入领域 GET 请求，统一过滤空查询参数。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 读取服务端发布的导入字段、文件和重复策略契约。 */
export const getImportContract = () => get('/imports/contract');
/** 分页读取导入批次审计记录。 */
export const getImportBatches = (params = {}) => get('/imports/batches', params);
/** 读取单个批次详情和审计摘要。 */
export const getImportBatchDetail = (batchId) => get(`/imports/batches/${encodeURIComponent(batchId)}`);
/** 分页读取批次错误及 warning 明细。 */
export const getImportBatchErrors = (batchId, params = {}) => get(`/imports/batches/${encodeURIComponent(batchId)}/errors`, params);

/** 上传能耗表格，fieldMapping 以 JSON 字符串遵循服务端 multipart 契约。 */
export function createImportBatch(file, fieldMapping = {}) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('duplicateStrategy', 'skip');
  formData.append('fieldMapping', JSON.stringify(fieldMapping));
  return request({ method: 'post', url: '/imports/batches', data: formData });
}

/** 删除接口仅供允许通用删除的批次调用，领域限制仍由服务端最终判定。 */
export const deleteImportBatch = (batchId) => request({ method: 'delete', url: `/imports/batches/${encodeURIComponent(batchId)}` });

/** 使用响应头中的文件名下载受控目录中的批次原件，响应头缺失时按文件类型补齐中文兜底扩展名。 */
export function downloadImportBatchFile(batchId) {
  return download(
    { url: `/imports/batches/${encodeURIComponent(batchId)}/download` },
    (response) => buildImportOriginalFileFallbackName(batchId, response.headers?.['content-type'])
  );
}

/** 下载服务端生成的模板，不在浏览器端构造模板文件。 */
export function downloadImportTemplate(templateType = 'energy-records', extension = 'xlsx') {
  const safeExtension = extension === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `/templates/${encodeURIComponent(templateType)}.${safeExtension}` }, `能耗数据导入模板.${safeExtension}`);
}
