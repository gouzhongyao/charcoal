import { download, query, request } from '@/api/http';
import {
  downloadManagedDemoArtifact,
  executeManagedDemoImport,
  previewManagedDemoImport
} from '@/api/demoData';
import { collectEnergyFlowPaginatedRows } from '@/utils/energyFlow';

// 能流模型与分析 API 根路径。
const ENERGY_FLOW_BASE_URL = '/energy-flows';
// 能流导入 API 根路径。
const ENERGY_FLOW_IMPORT_BASE_URL = '/energy-flow-imports';
// 能流三类页面导入与中央 demo handler 的固定映射。
const ENERGY_FLOW_DEMO_IMPORTS = Object.freeze({
  model: Object.freeze({ artifactKey: '22-energy-flow-models', handlerKey: 'energy-flow-models-import', routeSegment: 'models' }),
  node: Object.freeze({ artifactKey: '23-energy-flow-nodes', handlerKey: 'energy-flow-nodes-import', routeSegment: 'nodes' }),
  bundle: Object.freeze({ artifactKey: '24-energy-flow-edges', handlerKey: 'energy-flow-bundle-import', routeSegment: 'bundle' })
});

/** 严格读取能流 demo 导入契约。 */
function energyFlowDemoImport(kind) {
  const contract = ENERGY_FLOW_DEMO_IMPORTS[kind];
  if (!contract) throw new Error('不支持的能流演示导入类型。');
  return contract;
}

/** 按 artifact key 读取能流 demo 导入契约。 */
function energyFlowDemoArtifact(artifactKey) {
  const contract = Object.values(ENERGY_FLOW_DEMO_IMPORTS).find((item) => item.artifactKey === artifactKey);
  if (!contract) throw new Error('不支持的能流演示 artifact。');
  return contract;
}

/**
 * 发送能流 GET 请求并清理空查询参数。
 * @param {string} url 请求地址。
 * @param {object} params 查询参数。
 * @returns {Promise<object>} 统一响应。
 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/**
 * 将文件封装为后端约定的单文件表单。
 * @param {File} file 待上传文件。
 * @returns {FormData} 上传表单。
 */
function fileForm(file) {
  const data = new FormData();
  data.append('file', file);
  return data;
}

// 能流模型 API 模块。
export const listEnergyFlowModels = (params = {}) => get(`${ENERGY_FLOW_BASE_URL}/models`, params);
export const getEnergyFlowModel = (modelId) => get(`${ENERGY_FLOW_BASE_URL}/models/${modelId}`);
export const createEnergyFlowModel = (payload) => request({ method: 'post', url: `${ENERGY_FLOW_BASE_URL}/models`, data: payload });
export const updateEnergyFlowModel = (modelId, payload) => request({ method: 'put', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}`, data: payload });
export const updateEnergyFlowModelStatus = (modelId, status) => request({ method: 'patch', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/status`, data: { status } });

// 能流节点 API 模块。
export const listEnergyFlowNodes = (modelId, params = {}) => get(`${ENERGY_FLOW_BASE_URL}/models/${modelId}/nodes`, params);
// 能流节点全量分页读取模块，供维护表和 active 选择器共享完整集合。
export const listAllEnergyFlowNodes = (modelId, params = {}) => collectEnergyFlowPaginatedRows((pageParams) => listEnergyFlowNodes(modelId, pageParams), params);
export const createEnergyFlowNode = (modelId, payload) => request({ method: 'post', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/nodes`, data: payload });
export const updateEnergyFlowNode = (modelId, nodeId, payload) => request({ method: 'put', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/nodes/${nodeId}`, data: payload });
export const updateEnergyFlowNodeStatus = (modelId, nodeId, status) => request({ method: 'patch', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/nodes/${nodeId}/status`, data: { status } });

// 能流边、拓扑和分析 API 模块。
export const listEnergyFlowEdges = (modelId, params = {}) => get(`${ENERGY_FLOW_BASE_URL}/models/${modelId}/edges`, params);
// 能流边全量分页读取模块，避免维护表固定截断在后端单页上限。
export const listAllEnergyFlowEdges = (modelId, params = {}) => collectEnergyFlowPaginatedRows((pageParams) => listEnergyFlowEdges(modelId, pageParams), params);
export const createEnergyFlowEdge = (modelId, payload) => request({ method: 'post', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/edges`, data: payload });
export const updateEnergyFlowEdge = (modelId, edgeId, payload) => request({ method: 'put', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/edges/${edgeId}`, data: payload });
export const updateEnergyFlowEdgeStatus = (modelId, edgeId, status) => request({ method: 'patch', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/edges/${edgeId}/status`, data: { status } });
export const getEnergyFlowTopology = (modelId, params = {}) => get(`${ENERGY_FLOW_BASE_URL}/models/${modelId}/topology`, params);
export const analyzeEnergyFlow = (modelId, payload) => request({ method: 'post', url: `${ENERGY_FLOW_BASE_URL}/models/${modelId}/analysis`, data: payload });

/** 执行指定能流类型的 demo-aware 预演。 */
function previewEnergyFlowImport(kind, file) {
  const contract = energyFlowDemoImport(kind);
  return previewManagedDemoImport(
    { method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/${contract.routeSegment}/preview`, data: fileForm(file) },
    contract.artifactKey,
    contract.handlerKey,
    file
  );
}

/** 执行指定能流类型的 demo-aware 导入并在成功后清理 context。 */
function executeEnergyFlowImport(kind, payload) {
  const contract = energyFlowDemoImport(kind);
  return executeManagedDemoImport(
    { method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/${contract.routeSegment}/execute`, data: payload },
    contract.artifactKey,
    contract.handlerKey
  );
}

// 能流导入预演与执行 API 模块。
export const previewEnergyFlowModelImport = (file) => previewEnergyFlowImport('model', file);
export const executeEnergyFlowModelImport = (payload) => executeEnergyFlowImport('model', payload);
export const previewEnergyFlowNodeImport = (file) => previewEnergyFlowImport('node', file);
export const executeEnergyFlowNodeImport = (payload) => executeEnergyFlowImport('node', payload);
export const previewEnergyFlowBundleImport = (file) => previewEnergyFlowImport('bundle', file);
export const executeEnergyFlowBundleImport = (payload) => executeEnergyFlowImport('bundle', payload);

/** 下载能流冻结空白模板。 */
export function downloadEnergyFlowImportTemplate(templateType, extension = 'xlsx') {
  const safeExtension = extension === 'csv' ? 'csv' : 'xlsx';
  return download(
    { url: `/templates/${encodeURIComponent(templateType)}.${safeExtension}` },
    `能流导入模板.${safeExtension}`
  );
}

/** 下载青岚园区能流示例文件并保存托管 context。 */
export function downloadEnergyFlowDemoArtifact(artifactKey, extension = 'xlsx') {
  const safeExtension = extension === 'csv' ? 'csv' : 'xlsx';
  energyFlowDemoArtifact(artifactKey);
  return downloadManagedDemoArtifact(
    { url: `/templates/demo-park/${encodeURIComponent(artifactKey)}.${safeExtension}` },
    `青岚园区能流示例.${safeExtension}`
  );
}
