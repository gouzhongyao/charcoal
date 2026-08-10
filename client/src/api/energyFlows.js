import { query, request } from '@/api/http';
import { collectEnergyFlowPaginatedRows } from '@/utils/energyFlow';

// 能流模型与分析 API 根路径。
const ENERGY_FLOW_BASE_URL = '/energy-flows';
// 能流导入 API 根路径。
const ENERGY_FLOW_IMPORT_BASE_URL = '/energy-flow-imports';

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

// 能流导入预演与执行 API 模块。
export const previewEnergyFlowNodeImport = (file) => request({ method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/nodes/preview`, data: fileForm(file) });
export const executeEnergyFlowNodeImport = (payload) => request({ method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/nodes/execute`, data: payload });
export const previewEnergyFlowBundleImport = (file) => request({ method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/bundle/preview`, data: fileForm(file) });
export const executeEnergyFlowBundleImport = (payload) => request({ method: 'post', url: `${ENERGY_FLOW_IMPORT_BASE_URL}/bundle/execute`, data: payload });
