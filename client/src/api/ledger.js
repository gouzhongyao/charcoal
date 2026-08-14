import { download, query, request } from '@/api/http';

const get = (url, params = {}) => request({ url, params: query(params) });
const upload = (url, file) => { const data = new FormData(); data.append('file', file); return request({ method: 'post', url, data }); };
const exportFile = (url, params, fallbackName) => download({ url, params: query({ ...params, format: 'xlsx' }) }, fallbackName);
const template = (name, label) => download({ url: `/templates/${name}.xlsx` }, `${label}导入模板.xlsx`);
/** 下载指定基础台账青岚园区示例，文件内容和权限由服务端 manifest 最终约束。 */
const demoParkExample = (artifactKey, label) => download({ url: `/templates/demo-park/${artifactKey}.xlsx` }, `青岚园区示例-${label}.xlsx`);

export const ledgerApi = {
  units: {
    list: (params) => get('/organization/units', params), stats: () => get('/organization/units/stats'), create: (data) => request({ method: 'post', url: '/organization/units', data }), update: (id, data) => request({ method: 'put', url: `/organization/units/${id}`, data }), deactivate: (id) => request({ method: 'delete', url: `/organization/units/${id}` }), import: (file) => upload('/organization/units/import', file), export: (params) => exportFile('/organization/units/export', params, '用能单元导出.xlsx'), template: () => template('organization-units', '用能单元'), demoRoot: () => demoParkExample('01-organization-root', '用能单元根级'), demoDepartments: () => demoParkExample('02-organization-departments', '用能单元部门与车间'), demoProcessEquipment: () => demoParkExample('03-organization-process-equipment', '用能单元工序与设备')
  },
  meters: {
    list: (params) => get('/meters', params), stats: () => get('/meters/stats'), create: (data) => request({ method: 'post', url: '/meters', data }), update: (id, data) => request({ method: 'put', url: `/meters/${id}`, data }), deactivate: (id) => request({ method: 'delete', url: `/meters/${id}` }), import: (file) => upload('/meters/import', file), export: (params) => exportFile('/meters/export', params, '计量器具导出.xlsx'), template: () => template('meters', '计量器具'), demo: () => demoParkExample('04-meters', '计量器具')
  },
  readings: {
    list: (params) => get('/meter-readings', params), stats: (params) => get('/meter-readings/stats', params), create: (data) => request({ method: 'post', url: '/meter-readings', data }), update: (id, data) => request({ method: 'put', url: `/meter-readings/${id}`, data }), void: (id) => request({ method: 'delete', url: `/meter-readings/${id}` }), import: (file) => upload('/meter-readings/import', file), export: (params) => exportFile('/meter-readings/export', params, '计量抄表导出.xlsx'), template: () => template('meter-readings', '计量抄表'), demo: () => demoParkExample('08-meter-readings-2026-08', '2026-08抄表演示'), generationPreview: (params) => get('/meter-readings/energy-record-generation/preview', params), generationPreviewExport: (params) => exportFile('/meter-readings/energy-record-generation/preview/export', params, '抄表生成能耗记录预演.xlsx'), generationExecute: (data) => request({ method: 'post', url: '/meter-readings/energy-record-generation/execute', data })
  },
  generation: {
    list: (params) => get('/generation/records', params), stats: (params) => get('/generation/stats', params), monthly: (params) => get('/generation/statistics/monthly', params), create: (data) => request({ method: 'post', url: '/generation/records', data }), update: (id, data) => request({ method: 'put', url: `/generation/records/${id}`, data }), void: (id, data = { voidReason: '页面作废' }) => request({ method: 'delete', url: `/generation/records/${id}`, data }), previewImport: (file) => upload('/generation/records/import/preview', file), executeImport: (data) => request({ method: 'post', url: '/generation/records/import/execute', data }), export: (params) => exportFile('/generation/records/export', params, '发电自用记录导出.xlsx'), template: () => template('generation-records', '发电自用记录'), demo: () => demoParkExample('09-generation-records', '发电自用')
  },
  productionUnits: {
    list: (params) => get('/production/units', params), stats: (params) => get('/production/stats', params), create: (data) => request({ method: 'post', url: '/production/units', data }), update: (id, data) => request({ method: 'put', url: `/production/units/${id}`, data }), deactivate: (id) => request({ method: 'delete', url: `/production/units/${id}` }), previewImport: (file) => upload('/production/units/import/preview', file), executeImport: (data) => request({ method: 'post', url: '/production/units/import/execute', data }), export: (params) => exportFile('/production/units/export', params, '产能单元导出.xlsx'), template: () => template('production-units', '产能单元'), demo: () => demoParkExample('05-production-units', '产能单元')
  },
  productionOutputs: {
    list: (params) => get('/production/outputs', params), stats: (params) => get('/production/stats', params), intensity: (params) => get('/production/statistics/unit-energy-intensity', params), create: (data) => request({ method: 'post', url: '/production/outputs', data }), update: (id, data) => request({ method: 'put', url: `/production/outputs/${id}`, data }), void: (id) => request({ method: 'delete', url: `/production/outputs/${id}` }), previewImport: (file) => upload('/production/outputs/import/preview', file), executeImport: (data) => request({ method: 'post', url: '/production/outputs/import/execute', data }), export: (params) => exportFile('/production/outputs/export', params, '月度产量导出.xlsx'), template: () => template('production-outputs', '月度产量'), demo: () => demoParkExample('06-production-outputs', '月度产量')
  },
  energyTypes: () => get('/energy-types')
};
