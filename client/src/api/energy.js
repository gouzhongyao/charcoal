import { download, query, request } from '@/api/http';

export const LEDGER_BACKFILL_CONFIRM_TEXT = '确认执行历史能耗台账回填';

function get(url, params = {}) {
  return request({ url, params: query(params) });
}

export async function safeEnergyRequest(task) {
  try {
    return { ok: true, value: await task(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

export const getEnergyTypes = () => get('/energy-types');
export const getEnergySummary = (filters) => get('/energy-records/statistics/summary', filters);
export const getMonthlyTrend = (filters) => get('/energy-records/statistics/monthly-trend', filters);
export const getEnergyTypeBreakdown = (filters) => get('/energy-records/statistics/energy-type-breakdown', filters);
export const getDimensionBreakdown = (filters) => get('/energy-records/statistics/dimension-breakdown', filters);
export const getEnergyRecords = (filters) => get('/energy-records', filters);
export const getLedgerBackfillPreview = (filters) => get('/energy-records/ledger-backfill/preview', filters);

export function exportEnergyRecords(filters = {}, format = 'xlsx') {
  return download({ url: '/energy-records/export', params: query({ ...filters, format }) }, `能耗明细.${format}`);
}

export function exportLedgerBackfillPreview(filters = {}) {
  return download({ url: '/energy-records/ledger-backfill/preview/export', params: query({ ...filters, format: 'xlsx', detailLimit: 500 }) }, 'energy-records-台账回填预演审计预案.xlsx');
}

export function executeLedgerBackfill(payload) {
  return request({ method: 'post', url: '/energy-records/ledger-backfill/execute', data: payload });
}
