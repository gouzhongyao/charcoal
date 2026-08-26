import { download, query, request } from '@/api/http';

// 碳排放报告 API 模块：固定模板、受控导入、列表、五部分详情、批次追溯和 XLSX 导出均复用共享 HTTP 客户端。

// 碳排放报告接口根路径：与服务端 carbonEmissionReports 路由保持一致。
const CARBON_EMISSION_REPORT_BASE_URL = '/carbon/emission-reports';
// 碳排放报告固定导入确认文本：页面必须展示并提交此冻结文本，服务端仍会独立校验。
export const CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT = '确认导入碳排放报告';

/** 查询碳排放报告安全分页列表。 */
export function getCarbonEmissionReports(params = {}) {
  return request({ url: CARBON_EMISSION_REPORT_BASE_URL, params: query(params) });
}

/** 按报告 ID 查询报告信息、边界、项目、汇总和证据五部分详情。 */
export function getCarbonEmissionReport(reportId) {
  return request({ url: `${CARBON_EMISSION_REPORT_BASE_URL}/${encodeURIComponent(reportId)}` });
}

/** 按统一导入批次 ID 重新读取五部分报告事实，用于来源批次追溯。 */
export function getCarbonEmissionReportByBatch(batchId) {
  return request({ url: `${CARBON_EMISSION_REPORT_BASE_URL}/batches/${encodeURIComponent(batchId)}` });
}

/** 下载仅支持 XLSX 的固定碳排放报告 Excel v1 模板。 */
export function downloadCarbonEmissionReportTemplate() {
  return download(
    { url: '/templates/carbon-emission-report.xlsx' },
    '碳排放报告导入模板.xlsx'
  );
}

/** 上传原始 XLSX 文件并创建服务端持久化预演。 */
export function previewCarbonEmissionReportImport(file) {
  // 表单数据：上传字段名固定为 file，不携带客户端候选、签名、摘要或见证。
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${CARBON_EMISSION_REPORT_BASE_URL}/imports/preview`, data });
}

/** 使用四字段最小载荷执行碳排放报告受控导入。 */
export function executeCarbonEmissionReportImport(payload) {
  return request({ method: 'post', url: `${CARBON_EMISSION_REPORT_BASE_URL}/imports/execute`, data: payload });
}

/** 按报告 ID 导出五工作表 XLSX，并返回浏览器可读的导出行数响应头。 */
export function exportCarbonEmissionReport(reportId) {
  return download(
    { url: `${CARBON_EMISSION_REPORT_BASE_URL}/${encodeURIComponent(reportId)}/export` },
    `碳排放报告-${reportId}.xlsx`
  );
}
