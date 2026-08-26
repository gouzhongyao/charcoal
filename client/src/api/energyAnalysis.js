import { download, query, request } from '@/api/http';
import {
  downloadManagedDemoArtifact,
  executeManagedDemoImport,
  previewManagedDemoImport
} from '@/api/demoData';

// 能源消费分析统一 API 根路径。
const ANALYSIS_ROOT = '/energy-analysis';
// 受控导入统一 API 根路径。
const IMPORT_ROOT = '/energy-analysis/imports';
// 六类中央 context artifact 与真实导入 handler 的唯一前端映射。
const ANALYSIS_DEMO_IMPORTS = Object.freeze({
  'shift-definitions': Object.freeze({ artifactKey: '13-shift-definitions', handlerKey: 'shift-definitions-import' }),
  'shift-schedules': Object.freeze({ artifactKey: '14-shift-schedules', handlerKey: 'shift-schedules-import' }),
  timeseries: Object.freeze({ artifactKey: '15-energy-timeseries', handlerKey: 'energy-timeseries-import' }),
  'device-states': Object.freeze({ artifactKey: '16-device-states', handlerKey: 'device-states-import' }),
  'tou-schemes': Object.freeze({ artifactKey: '17-tou-schemes', handlerKey: 'tou-schemes-import' }),
  'strategy-rules': Object.freeze({ artifactKey: '18-strategy-rules', handlerKey: 'strategy-rules-import' })
});

/** 严格读取能源分析 demo 导入契约，禁止调用方猜测 handler。 */
function analysisDemoImport(type) {
  const contract = ANALYSIS_DEMO_IMPORTS[type];
  if (!contract) throw new Error('不支持的能源分析演示导入类型。');
  return contract;
}

/** 按 artifact key 读取能源分析 demo 导入契约。 */
function analysisDemoArtifact(artifactKey) {
  const contract = Object.values(ANALYSIS_DEMO_IMPORTS).find((item) => item.artifactKey === artifactKey);
  if (!contract) throw new Error('不支持的能源分析演示 artifact。');
  return contract;
}

/** 发起只读 GET 请求。 */
const get = (url, params = {}) => request({ url, params: query(params) });
/** 发起 JSON POST 请求。 */
const post = (url, data = {}) => request({ method: 'post', url, data });
/** 发起 JSON PATCH 请求。 */
const patch = (url, data = {}) => request({ method: 'patch', url, data });

/** 查询负荷摘要。 */
export const getEnergyLoadSummary = (params) => get(`${ANALYSIS_ROOT}/consumption/load-summary`, params);
/** 查询月度消费量及同环比。 */
export const getMonthlyConsumptionAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/monthly-analysis`, params);
/** 查询固定 UTC 网格负荷曲线。 */
export const getEnergyLoadCurve = (params) => get(`${ANALYSIS_ROOT}/consumption/load-curve`, params);
/** 查询峰平谷消费分析。 */
export const getTimeOfUseAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/time-of-use`, params);
/** 查询班次消费分析。 */
export const getShiftConsumptionAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/shifts`, params);
/** 查询显式设备状态消费分析。 */
export const getDeviceStateConsumptionAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/device-states`, params);
/** 查询精确组织高峰贡献。 */
export const getPeakContributionAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/peak-contribution`, params);
/** 查询消费量与单位产量强度。 */
export const getEnergyIntensityAnalysis = (params) => get(`${ANALYSIS_ROOT}/consumption/intensity`, params);

/** 预演本地确定性策略。 */
export const evaluateEnergyStrategies = (data) => post(`${ANALYSIS_ROOT}/strategies/evaluate`, data);
/** 正式运行本地确定性策略。 */
export const runEnergyStrategies = (data) => post(`${ANALYSIS_ROOT}/strategies/runs`, data);
/** 更新策略命中的人工状态。 */
export const reviewEnergyStrategyHit = (hitId, data) => patch(`${ANALYSIS_ROOT}/strategies/hits/${hitId}/manual-status`, data);

/** 查询排班定义及历史版本。 */
export const listShiftDefinitions = (params) => get(`${ANALYSIS_ROOT}/config/shifts`, params);
/** 创建首个排班定义版本。 */
export const createShiftDefinition = (data) => post(`${ANALYSIS_ROOT}/config/shifts`, data);
/** 创建排班定义新版本。 */
export const createShiftDefinitionVersion = (id, data) => post(`${ANALYSIS_ROOT}/config/shifts/${id}/versions`, data);
/** 启用或停用排班版本。 */
export const setShiftDefinitionStatus = (id, status) => patch(`${ANALYSIS_ROOT}/config/shifts/${id}/status`, { status });

/** 查询 TOU 方案及历史版本。 */
export const listTouSchemes = (params) => get(`${ANALYSIS_ROOT}/config/tou-schemes`, params);
/** 创建首个 TOU 方案版本。 */
export const createTouScheme = (data) => post(`${ANALYSIS_ROOT}/config/tou-schemes`, data);
/** 创建 TOU 方案新版本。 */
export const createTouSchemeVersion = (id, data) => post(`${ANALYSIS_ROOT}/config/tou-schemes/${id}/versions`, data);
/** 启用或停用 TOU 方案版本。 */
export const setTouSchemeStatus = (id, status) => patch(`${ANALYSIS_ROOT}/config/tou-schemes/${id}/status`, { status });

/** 查询策略规则及历史版本。 */
export const listStrategyRules = (params) => get(`${ANALYSIS_ROOT}/config/strategy-rules`, params);
/** 创建首个策略规则版本。 */
export const createStrategyRule = (data) => post(`${ANALYSIS_ROOT}/config/strategy-rules`, data);
/** 创建策略规则新版本。 */
export const createStrategyRuleVersion = (id, data) => post(`${ANALYSIS_ROOT}/config/strategy-rules/${id}/versions`, data);
/** 启用或停用策略规则版本。 */
export const setStrategyRuleStatus = (id, status) => patch(`${ANALYSIS_ROOT}/config/strategy-rules/${id}/status`, { status });

/** 下载服务端生成的能源分析空白模板。 */
export function downloadEnergyAnalysisImportTemplate(templateType, extension = 'xlsx') {
  const safeExtension = extension === 'csv' ? 'csv' : 'xlsx';
  return download(
    { url: `/templates/${encodeURIComponent(templateType)}.${safeExtension}` },
    `能源分析导入模板.${safeExtension}`
  );
}

/** 下载受领域权限保护的青岚园区能源分析示例并保存托管 context。 */
export function downloadEnergyAnalysisDemoArtifact(artifactKey, extension = 'xlsx') {
  const safeExtension = extension === 'csv' ? 'csv' : 'xlsx';
  analysisDemoArtifact(artifactKey);
  return downloadManagedDemoArtifact(
    { url: `/templates/demo-park/${encodeURIComponent(artifactKey)}.${safeExtension}` },
    `青岚园区能源分析示例.${safeExtension}`
  );
}

/** 上传文件并创建服务端受控预演批次；原始下载文件匹配时附加托管 context。 */
export function previewEnergyAnalysisImport(type, file) {
  const data = new FormData();
  data.append('file', file);
  const contract = analysisDemoImport(type);
  return previewManagedDemoImport(
    { method: 'post', url: `${IMPORT_ROOT}/${type}/preview`, data },
    contract.artifactKey,
    contract.handlerKey,
    file
  );
}

/** 使用完整服务端见证执行受控导入，并在成功后清理一次性 context。 */
export function executeEnergyAnalysisImport(type, data) {
  const contract = analysisDemoImport(type);
  return executeManagedDemoImport(
    { method: 'post', url: `${IMPORT_ROOT}/${type}/execute`, data },
    contract.artifactKey,
    contract.handlerKey
  );
}
