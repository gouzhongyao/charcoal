import { download, query, request } from '@/api/http';

// 独立碳核算 API 模块：运行、统一结果、统计和导出均通过共享 HTTP 客户端访问服务端冻结契约。

// 独立碳核算接口根路径：与服务端 carbonAccounting 路由保持一致。
const CARBON_ACCOUNTING_BASE_URL = '/carbon/accounting';

/** 创建一条只读取独立碳活动事实的追加式核算运行。 */
export function createCarbonCalculationRun(payload) {
  return request({ method: 'post', url: `${CARBON_ACCOUNTING_BASE_URL}/runs`, data: payload });
}

/** 查询独立碳核算运行历史。 */
export function getCarbonCalculationRuns(params = {}) {
  return request({ url: `${CARBON_ACCOUNTING_BASE_URL}/runs`, params: query(params) });
}

/** 按稳定运行编码查询运行详情。 */
export function getCarbonCalculationRun(runCode) {
  return request({ url: `${CARBON_ACCOUNTING_BASE_URL}/runs/${encodeURIComponent(runCode)}` });
}

/** 查询单来源结果或 all 双来源分面结果。 */
export function getCarbonAccountingResults(params = {}) {
  return request({ url: `${CARBON_ACCOUNTING_BASE_URL}/results`, params: query(params) });
}

/** 查询单来源统计或 all 双来源分面统计。 */
export function getCarbonAccountingStatistics(params = {}) {
  return request({ url: `${CARBON_ACCOUNTING_BASE_URL}/statistics`, params: query(params) });
}

/** 按显式 sourceType 和当前已应用筛选导出 CSV 或 XLSX。 */
export function exportCarbonAccountingResults(params = {}, format = 'xlsx') {
  // 安全格式：页面只开放服务端支持的 csv 和 xlsx。
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download(
    { url: `${CARBON_ACCOUNTING_BASE_URL}/export`, params: query({ ...params, format: safeFormat }) },
    `碳核算结果导出.${safeFormat}`
  );
}
