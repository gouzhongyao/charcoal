import { download, query, request } from '@/api/http';
import {
  downloadManagedDemoArtifact,
  executeManagedDemoImport,
  previewManagedDemoImport
} from '@/api/demoData';

// 能效对标业务接口根路径。
const ENERGY_BENCHMARK_BASE_URL = '/energy-benchmarks';
// 能效对标受控导入接口根路径。
const ENERGY_BENCHMARK_IMPORT_BASE_URL = `${ENERGY_BENCHMARK_BASE_URL}/imports`;

/** 发起带白名单查询参数的 GET 请求。 */
function get(url, params = {}) {
  return request({ url, params: query(params) });
}

/** 可靠读取全部分页；服务端声明 total 时不允许空页静默截断。 */
async function getAllPages(loadPage, params = {}, pageSize = 100) {
  const items = [];
  let page = 1;
  let total = null;
  while (total === null || items.length < total) {
    const response = await loadPage({ ...params, page, pageSize });
    const pageItems = Array.isArray(response?.data) ? response.data : [];
    const responseTotal = response?.meta?.total ?? response?.meta?.pagination?.total;
    if (Number.isSafeInteger(Number(responseTotal)) && Number(responseTotal) >= 0) total = Number(responseTotal);
    if (pageItems.length === 0) {
      if (total !== null && items.length < total) throw new Error(`分页读取在第 ${page} 页提前结束，预期 ${total} 条，实际 ${items.length} 条。`);
      break;
    }
    items.push(...pageItems);
    if (total === null && pageItems.length < pageSize) break;
    page += 1;
  }
  return { success: true, data: items, meta: { total: total ?? items.length, allPagesLoaded: true } };
}

/** 查询对标定义列表。 */
export const getEnergyBenchmarkDefinitions = (params = {}) => get(`${ENERGY_BENCHMARK_BASE_URL}/definitions`, params);
/** 独立读取全部 active 对标定义，不复用管理列表筛选和当前分页。 */
export const getAllActiveEnergyBenchmarkDefinitions = (params = {}) => getAllPages(
  (pageParams) => getEnergyBenchmarkDefinitions(pageParams),
  { ...params, status: 'active' },
  100
);
/** 查询对标定义及目标历史详情。 */
export const getEnergyBenchmarkDefinition = (definitionId) => get(`${ENERGY_BENCHMARK_BASE_URL}/definitions/${definitionId}`);
/** 创建普通对标定义。 */
export const createEnergyBenchmarkDefinition = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/definitions`, data: payload });
/** 调整普通对标定义，服务端保留原记录并创建后继记录。 */
export const updateEnergyBenchmarkDefinition = (definitionId, payload) => request({ method: 'put', url: `${ENERGY_BENCHMARK_BASE_URL}/definitions/${definitionId}`, data: payload });
/** 启用或停用对标定义。 */
export const updateEnergyBenchmarkDefinitionStatus = (definitionId, status) => request({ method: 'patch', url: `${ENERGY_BENCHMARK_BASE_URL}/definitions/${definitionId}/status`, data: { status } });
/** 创建由服务端计算并固化的内部历史基准。 */
export const createEnergyBenchmarkInternalHistory = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/internal-history`, data: payload });

/** 查询对标目标列表。 */
export const getEnergyBenchmarkTargets = (params = {}) => get(`${ENERGY_BENCHMARK_BASE_URL}/targets`, params);
/** 独立读取指定定义的全部 active 目标，不受管理列表分页影响。 */
export const getAllActiveEnergyBenchmarkTargets = (definitionId) => getAllPages(
  (pageParams) => getEnergyBenchmarkTargets(pageParams),
  { definitionId, status: 'active' },
  100
);
/** 查询对标目标及定义详情。 */
export const getEnergyBenchmarkTarget = (targetId) => get(`${ENERGY_BENCHMARK_BASE_URL}/targets/${targetId}`);
/** 创建普通对标目标。 */
export const createEnergyBenchmarkTarget = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/targets`, data: payload });
/** 调整普通目标，服务端保留原记录并创建后继记录。 */
export const updateEnergyBenchmarkTarget = (targetId, payload) => request({ method: 'put', url: `${ENERGY_BENCHMARK_BASE_URL}/targets/${targetId}`, data: payload });
/** 启用或停用对标目标。 */
export const updateEnergyBenchmarkTargetStatus = (targetId, status) => request({ method: 'patch', url: `${ENERGY_BENCHMARK_BASE_URL}/targets/${targetId}/status`, data: { status } });

/** 对单个显式实际值执行能效评价。 */
export const evaluateEnergyBenchmark = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/evaluate`, data: payload });
/** 对显式且兼容的对象执行排名。 */
export const rankEnergyBenchmarks = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/rankings`, data: payload });
/** 以兼容对象为分母计算合格率。 */
export const getEnergyBenchmarkQualificationRate = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/qualification-rate`, data: payload });
/** 获取结构化导出行；该接口返回 JSON，禁止作为 Blob 下载。 */
export const getEnergyBenchmarkExportRows = (payload) => request({ method: 'post', url: `${ENERGY_BENCHMARK_BASE_URL}/export-rows`, data: payload });

/** 三类能效对标导入的空白模板与天坤集团示例映射。 */
const ENERGY_BENCHMARK_IMPORT_DOWNLOADS = Object.freeze({
  'conversion-factors': Object.freeze({ templateType: 'energy-conversion-factors', artifactKey: '19-conversion-factors', handlerKey: 'energy-conversion-factors-import', label: '能源折标系数' }),
  definitions: Object.freeze({ templateType: 'energy-benchmark-definitions', artifactKey: '20-benchmark-definitions', handlerKey: 'energy-benchmark-definitions-import', label: '对标定义' }),
  targets: Object.freeze({ templateType: 'energy-benchmark-targets', artifactKey: '21-benchmark-targets', handlerKey: 'energy-benchmark-targets-import', label: '对标目标' })
});

/** 读取当前导入类型的下载配置，拒绝浏览器端猜测其他类型。 */
function energyBenchmarkImportDownload(importType) {
  const config = ENERGY_BENCHMARK_IMPORT_DOWNLOADS[importType];
  if (!config) throw new Error('不支持的能效对标导入类型。');
  return config;
}

/** 下载当前能效对标导入类型的空白 XLSX 模板。 */
export function downloadEnergyBenchmarkImportTemplate(importType) {
  const config = energyBenchmarkImportDownload(importType);
  return download({ url: `/templates/${config.templateType}.xlsx` }, `${config.label}导入模板.xlsx`);
}

/** 下载当前能效对标导入类型的天坤集团 XLSX 示例并保存托管 context。 */
export function downloadEnergyBenchmarkDemoParkExample(importType) {
  const config = energyBenchmarkImportDownload(importType);
  return downloadManagedDemoArtifact(
    { url: `/templates/demo-park/${config.artifactKey}.xlsx` },
    `天坤集团示例-${config.label}.xlsx`,
    undefined,
    config
  );
}

/** 上传文件并创建指定类型的受控导入预演。 */
export function previewEnergyBenchmarkImport(importType, file) {
  const config = energyBenchmarkImportDownload(importType);
  const data = new FormData();
  data.append('file', file);
  return previewManagedDemoImport(
    { method: 'post', url: `${ENERGY_BENCHMARK_IMPORT_BASE_URL}/${importType}/preview`, data },
    config.artifactKey,
    config.handlerKey,
    file
  );
}

/** 使用服务端持久化预演批次执行指定类型导入，并在成功后清理一次性 context。 */
export function executeEnergyBenchmarkImport(importType, payload) {
  const config = energyBenchmarkImportDownload(importType);
  return executeManagedDemoImport(
    { method: 'post', url: `${ENERGY_BENCHMARK_IMPORT_BASE_URL}/${importType}/execute`, data: payload },
    config.artifactKey,
    config.handlerKey
  );
}

/** 读取全部 active 组织对象，供 organization 范围和实际对象按真实主数据选择。 */
export const getAllActiveEnergyBenchmarkOrganizationUnits = () => getAllPages(
  (pageParams) => get('/organization/units', pageParams),
  { status: 'active' },
  500
);

/** 完整分页读取全部 active 产能单元，禁止只使用第一页主数据。 */
export const getAllActiveEnergyBenchmarkProductionUnits = () => getAllPages(
  (pageParams) => get('/production/units', pageParams),
  { status: 'active' },
  500
);

/** 读取维护态；只向页面投影 bootstrap 的公开状态字段。 */
export const getEnergyBenchmarkBootstrap = () => get('/bootstrap');
