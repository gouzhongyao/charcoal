import { download, query, request } from '@/api/http';

const BASE_URL = '/energy-budgets';

function get(url, params = {}) {
  return request({ url, params: query(params) });
}

export const getEnergyBudgets = (params = {}) => get(BASE_URL, params);
export const getEnergyBudgetStats = (params = {}) => get(`${BASE_URL}/stats`, params);
export const getEnergyBudgetExecutionComparison = (params = {}) => get(`${BASE_URL}/execution-comparison`, params);
export const getEnergyBudgetContract = () => get(`${BASE_URL}/contract`);
export const createEnergyBudget = (payload) => request({ method: 'post', url: BASE_URL, data: payload });
export const updateEnergyBudget = (id, payload) => request({ method: 'put', url: `${BASE_URL}/${id}`, data: payload });
export const updateEnergyBudgetStatus = (id, status) => request({ method: 'patch', url: `${BASE_URL}/${id}/status`, data: { status } });

export function exportEnergyBudgets(params = {}) {
  return download({ url: `${BASE_URL}/export`, params: query({ ...params, format: 'xlsx' }) }, '用能预算导出.xlsx');
}

export function downloadEnergyBudgetTemplate(format = 'xlsx') {
  const safeFormat = format === 'csv' ? 'csv' : 'xlsx';
  return download({ url: `/templates/energy-budgets.${safeFormat}` }, `用能预算导入模板.${safeFormat}`);
}

export function previewEnergyBudgetImport(file) {
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${BASE_URL}/import/preview`, data });
}

export const executeEnergyBudgetImport = (payload) => request({ method: 'post', url: `${BASE_URL}/import/execute`, data: payload });
