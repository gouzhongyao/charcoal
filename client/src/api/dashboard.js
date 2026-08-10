import { query, request } from '@/api/http';

/** 工作台领域请求统一由可信 HTTP 客户端发送。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 读取驾驶舱摘要，可按标准化月份范围筛选年度能源数据。 */
export const getDashboardSummary = (params = {}) => get('/dashboard/summary', params);
/** 读取能耗摘要，供驾驶舱单卡降级使用。 */
export const getDashboardEnergySummary = (params = {}) => get('/energy-records/statistics/summary', params);
/** 读取能耗月度趋势，驾驶舱按能源类型和单位拆分为单一数值轴。 */
export const getDashboardEnergyTrend = (params = {}) => get('/energy-records/statistics/monthly-trend', params);
/** 读取能耗类型结构，调用方必须继续按 normalizedUnit 安全分组。 */
export const getDashboardEnergyBreakdown = (params = {}) => get('/energy-records/statistics/energy-type-breakdown', params);
/** 读取预算统计；保留兼容调用，驾驶舱预警使用领域执行比较接口。 */
export const getDashboardBudgetStats = (params = {}) => get('/energy-budgets/stats', params);
