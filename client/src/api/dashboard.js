import { query, request } from '@/api/http';

/** 工作台领域请求统一由可信 HTTP 客户端发送。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 读取工作台摘要，仅包含服务端声明的数据范围。 */
export const getDashboardSummary = () => get('/dashboard/summary');
/** 读取能耗摘要，供工作台单卡降级使用。 */
export const getDashboardEnergySummary = () => get('/energy-records/statistics/summary');
/** 读取能耗月度趋势，工作台只使用单一数值轴。 */
export const getDashboardEnergyTrend = () => get('/energy-records/statistics/monthly-trend');
/** 读取能耗类型结构，用于真实数据的只读概览。 */
export const getDashboardEnergyBreakdown = () => get('/energy-records/statistics/energy-type-breakdown');
/** 读取预算统计；调用方必须先按前端权限决定是否展示该卡。 */
export const getDashboardBudgetStats = () => get('/energy-budgets/stats');
