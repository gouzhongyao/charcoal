import { download, query, request } from '@/api/http';

// 温室气体报告 API 模块：固定模板、受控导入、列表、六部分详情、批次追溯和 XLSX 导出均复用共享 HTTP 客户端。

// 温室气体报告接口根路径：与服务端 ghgReports 路由保持一致。
const GHG_REPORT_BASE_URL = '/carbon/ghg-reports';
// 温室气体报告固定导入确认文本：页面必须展示并提交此冻结文本，服务端仍会独立校验。
export const GHG_REPORT_IMPORT_CONFIRM_TEXT = '确认导入温室气体报告';

/** 查询温室气体报告安全分页列表。 */
export function getGhgReports(params = {}) {
  return request({ url: GHG_REPORT_BASE_URL, params: query(params) });
}

/** 按报告 ID 查询报告信息、组织边界、运行边界、报告项目、汇总和证据说明六部分详情。 */
export function getGhgReport(reportId) {
  return request({ url: `${GHG_REPORT_BASE_URL}/${encodeURIComponent(reportId)}` });
}

/** 按统一导入批次 ID 重新读取六部分报告事实，用于来源批次追溯。 */
export function getGhgReportByBatch(batchId) {
  return request({ url: `${GHG_REPORT_BASE_URL}/batches/${encodeURIComponent(batchId)}` });
}

/** 下载仅支持 XLSX 的固定温室气体报告 Excel v1 模板。 */
export function downloadGhgReportTemplate() {
  return download(
    { url: '/templates/ghg-report.xlsx' },
    '温室气体报告导入模板.xlsx'
  );
}

/** 上传原始 XLSX 文件并创建服务端持久化预演。 */
export function previewGhgReportImport(file) {
  // 表单数据：上传字段名固定为 file，不携带客户端候选、签名、摘要或见证。
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${GHG_REPORT_BASE_URL}/imports/preview`, data });
}

/** 使用四字段最小载荷执行温室气体报告受控导入。 */
export function executeGhgReportImport(payload) {
  return request({ method: 'post', url: `${GHG_REPORT_BASE_URL}/imports/execute`, data: payload });
}

/** 按报告 ID 导出六工作表 XLSX，并返回浏览器可读的导出行数响应头。 */
export function exportGhgReport(reportId) {
  return download(
    { url: `${GHG_REPORT_BASE_URL}/${encodeURIComponent(reportId)}/export` },
    `温室气体报告-${reportId}.xlsx`
  );
}
