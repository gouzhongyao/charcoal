import { download, query, request } from '@/api/http';
import {
  downloadManagedDemoArtifact,
  executeManagedDemoImport,
  previewManagedDemoImport
} from '@/api/demoData';

/** 能效平衡 API 基础路径。 */
const BASE_URL = '/energy-balances';
/** 能效平衡受控导入 API 基础路径。 */
const IMPORT_BASE_URL = '/energy-balance-imports';
/** 能效平衡双批次天坤集团 artifact 与 handler 契约。 */
const ENERGY_BALANCE_DEMO_IMPORT = Object.freeze({
  artifactKey: '25-energy-balance-configs',
  handlerKey: 'energy-balance-bundle-import'
});

/** 执行带空参数过滤的 GET 请求。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 读取稳定能效平衡领域契约。 */
export const getEnergyBalanceContract = () => get(`${BASE_URL}/contract`);
/** 分页读取平衡边界。 */
export const getEnergyBalanceBoundaries = (params = {}) => get(`${BASE_URL}/boundaries`, params);
/** 读取单个平衡边界详情。 */
export const getEnergyBalanceBoundary = (boundaryId) => get(`${BASE_URL}/boundaries/${boundaryId}`);
/** 创建平衡边界。 */
export const createEnergyBalanceBoundary = (payload) => request({ method: 'post', url: `${BASE_URL}/boundaries`, data: payload });
/** 更新平衡边界。 */
export const updateEnergyBalanceBoundary = (boundaryId, payload) => request({ method: 'put', url: `${BASE_URL}/boundaries/${boundaryId}`, data: payload });
/** 启用或停用平衡边界。 */
export const updateEnergyBalanceBoundaryStatus = (boundaryId, status) => request({ method: 'patch', url: `${BASE_URL}/boundaries/${boundaryId}/status`, data: { status } });
/** 分页读取边界下的九角色项目。 */
export const getEnergyBalanceItems = (boundaryId, params = {}) => get(`${BASE_URL}/boundaries/${boundaryId}/items`, params);
/** 创建边界下的平衡项目。 */
export const createEnergyBalanceItem = (boundaryId, payload) => request({ method: 'post', url: `${BASE_URL}/boundaries/${boundaryId}/items`, data: payload });
/** 更新边界下的平衡项目。 */
export const updateEnergyBalanceItem = (boundaryId, itemId, payload) => request({ method: 'put', url: `${BASE_URL}/boundaries/${boundaryId}/items/${itemId}`, data: payload });
/** 启用或停用平衡项目。 */
export const updateEnergyBalanceItemStatus = (boundaryId, itemId, status) => request({ method: 'patch', url: `${BASE_URL}/boundaries/${boundaryId}/items/${itemId}/status`, data: { status } });
/** 按完整统计期计算并固化同一次运行的快照。 */
export const calculateEnergyBalanceSnapshots = (boundaryId, payload) => request({ method: 'post', url: `${BASE_URL}/boundaries/${boundaryId}/snapshots/calculate`, data: payload });
/** 分页读取平衡快照分面，保留旧调用契约。 */
export const getEnergyBalanceSnapshots = (params = {}) => get(`${BASE_URL}/snapshots`, params);
/** 按 calculationRunId 分页读取轻量运行摘要；完整分面由运行详情接口获取。 */
export const getEnergyBalanceSnapshotRuns = (params = {}) => get(`${BASE_URL}/snapshots`, { ...params, view: 'runs' });
/** 按运行编号读取完整分面。 */
export const getEnergyBalanceSnapshotRun = (calculationRunId) => get(`${BASE_URL}/snapshots/runs/${encodeURIComponent(calculationRunId)}`);
/** 读取快照、同 calculationRunId 分面、综合折标和建议。 */
export const getEnergyBalanceSnapshot = (snapshotId) => get(`${BASE_URL}/snapshots/${snapshotId}`);
/** 分页读取确定性优化建议。 */
export const getEnergyBalanceSuggestions = (params = {}) => get(`${BASE_URL}/suggestions`, params);
/** 人工接受、拒绝或解决建议。 */
export const updateEnergyBalanceSuggestionStatus = (suggestionId, payload) => request({ method: 'patch', url: `${BASE_URL}/suggestions/${suggestionId}/status`, data: payload });

/** 下载平衡边界与九角色项目空白 XLSX 模板。 */
export function downloadEnergyBalanceImportTemplate() {
  return download({ url: '/templates/energy-balance-configs.xlsx' }, '能效平衡配置导入模板.xlsx');
}

/** 下载天坤集团平衡边界与九角色项目 XLSX 示例并保存托管 context。 */
export function downloadEnergyBalanceDemoParkExample() {
  return downloadManagedDemoArtifact(
    { url: '/templates/demo-park/25-energy-balance-configs.xlsx' },
    '天坤集团示例-平衡边界与九角色项目.xlsx',
    undefined,
    ENERGY_BALANCE_DEMO_IMPORT
  );
}

/** 上传 XLSX 文件并创建平衡双批次预演。 */
export function previewEnergyBalanceBundleImport(file) {
  const data = new FormData();
  data.append('file', file);
  return previewManagedDemoImport(
    { method: 'post', url: `${IMPORT_BASE_URL}/bundle/preview`, data },
    ENERGY_BALANCE_DEMO_IMPORT.artifactKey,
    ENERGY_BALANCE_DEMO_IMPORT.handlerKey,
    file
  );
}

/** 使用最小批次确认正文执行平衡双批次导入，并在成功后清理一次性 context。 */
export function executeEnergyBalanceBundleImport(payload) {
  return executeManagedDemoImport(
    { method: 'post', url: `${IMPORT_BASE_URL}/bundle/execute`, data: payload },
    ENERGY_BALANCE_DEMO_IMPORT.artifactKey,
    ENERGY_BALANCE_DEMO_IMPORT.handlerKey
  );
}
