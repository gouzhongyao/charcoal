import { download, query, request } from '@/api/http';

// 独立碳活动 API 模块：固定模板、受控导入、活动查询、追溯、作废和导出均复用共享 HTTP 客户端。

// 独立碳活动接口根路径：与服务端 carbonActivities 路由保持一致。
const CARBON_ACTIVITY_BASE_URL = '/carbon/activities';
// 独立碳活动固定导入确认文本：只用于页面确认，服务端仍会独立校验。
export const CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT = '确认导入独立碳活动';

/** 查询独立碳活动分页列表。 */
export function getCarbonActivities(params = {}) {
  return request({ url: CARBON_ACTIVITY_BASE_URL, params: query(params) });
}

/** 查询单条独立碳活动详情及替代、作废追溯字段。 */
export function getCarbonActivity(activityId) {
  return request({ url: `${CARBON_ACTIVITY_BASE_URL}/${activityId}` });
}

/** 下载仅支持 XLSX 的固定 Excel v1 独立碳活动模板。 */
export function downloadCarbonActivityTemplate() {
  return download({ url: '/templates/carbon-activities.xlsx' }, '独立碳活动导入模板.xlsx');
}

/** 上传原始 XLSX 文件并创建服务端持久化预演。 */
export function previewCarbonActivityImport(file) {
  // 表单数据：上传字段名固定为 file，不携带客户端候选或见证。
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${CARBON_ACTIVITY_BASE_URL}/imports/preview`, data });
}

/** 使用四字段最小载荷执行独立碳活动受控导入。 */
export function executeCarbonActivityImport(payload) {
  return request({ method: 'post', url: `${CARBON_ACTIVITY_BASE_URL}/imports/execute`, data: payload });
}

/** 通过乐观锁作废 active 独立碳活动，不提供物理删除。 */
export function voidCarbonActivity(activityId, payload) {
  return request({ method: 'post', url: `${CARBON_ACTIVITY_BASE_URL}/${activityId}/void`, data: payload });
}

/** 按活动列表同一已应用筛选导出 CSV 或 XLSX。 */
export function exportCarbonActivities(params = {}, format = 'xlsx') {
  // 安全格式：页面只开放服务端支持的 csv 和 xlsx。
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download(
    { url: `${CARBON_ACTIVITY_BASE_URL}/export`, params: query({ ...params, format: safeFormat }) },
    `独立碳活动导出.${safeFormat}`
  );
}
