import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_IMPORT_TYPE,
  CARBON_EMISSION_REPORT_INTERNAL_FIELDS,
  CARBON_EMISSION_REPORT_SECTION_NAMES,
  CARBON_EMISSION_REPORT_TEMPLATE_ID,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
  buildCarbonEmissionReportExecuteFailureState,
  buildCarbonEmissionReportFilters,
  buildCarbonEmissionReportImportExecutePayload,
  canExecuteCarbonEmissionReportImport,
  createCarbonEmissionReportViewIntent,
  formatCarbonEmissionReportNumber,
  getCarbonEmissionReportExportedRowCount,
  isCarbonEmissionReportPreviewStaleError,
  isCarbonEmissionReportXlsxFile,
  normalizeCarbonEmissionReportDate,
  projectCarbonEmissionReportDetail,
  projectCarbonEmissionReportListRow,
  projectCarbonEmissionReportPagination,
  projectCarbonEmissionReportPermissions,
  projectCarbonEmissionReportPreview,
  runLatestCarbonEmissionReportRequest
} from '../utils/carbonEmissionReportManagement.js';

/** 创建可手动完成或拒绝的 Promise，验证真实异步竞态顺序。 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 深拷贝公共预演，便于逐项构造 fail-closed 反例。 */
function clonePreview(preview) {
  return JSON.parse(JSON.stringify(preview));
}

// 固定 N6 模板、导入类型、确认文本和五部分合法名称不得漂移。
assert.equal(CARBON_EMISSION_REPORT_TEMPLATE_ID, 'carbon-emission-report');
assert.equal(CARBON_EMISSION_REPORT_TEMPLATE_VERSION, '1.0');
assert.equal(CARBON_EMISSION_REPORT_IMPORT_TYPE, 'carbon_emission_report');
assert.equal(CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT, '确认导入碳排放报告');
assert.deepEqual(CARBON_EMISSION_REPORT_SECTION_NAMES, ['报告信息', '组织与核算边界', '报告项目', '汇总', '证据说明']);
assert.equal(CARBON_EMISSION_REPORT_SECTION_NAMES.includes('组织/核算边界'), false);

// 四项权限完全独立，旧 carbon:view 和其他碳权限不得扩张 N6。
const noReportPermissions = projectCarbonEmissionReportPermissions((permission) => permission === 'carbon:view');
assert.deepEqual(noReportPermissions, { canView: false, canImportPreview: false, canImportExecute: false, canExport: false });
const exactReportPermissions = projectCarbonEmissionReportPermissions((permission) => new Set([
  'carbon:emission-reports:view',
  'carbon:emission-reports:import:preview',
  'carbon:emission-reports:import:execute',
  'carbon:emission-reports:export'
]).has(permission));
assert.deepEqual(exactReportPermissions, { canView: true, canImportPreview: true, canImportExecute: true, canExport: true });
assert.deepEqual(projectCarbonEmissionReportPermissions(null), { canView: false, canImportPreview: false, canImportExecute: false, canExport: false });

// 报告期间按自然日严格验证，不经 Date.parse 或浏览器本地时区推断。
assert.equal(normalizeCarbonEmissionReportDate('2028-02-29'), '2028-02-29');
assert.equal(normalizeCarbonEmissionReportDate(''), '');
assert.throws(() => normalizeCarbonEmissionReportDate('2027-02-29'), /有效的公历日期/);
assert.throws(() => normalizeCarbonEmissionReportDate('2028-2-09'), /YYYY-MM-DD/);
assert.throws(() => normalizeCarbonEmissionReportDate('2028-02-29T00:00:00Z'), /YYYY-MM-DD/);

// 筛选只发送白名单字段，日期区间、范围、批次 ID 和分页必须安全。
assert.deepEqual(buildCarbonEmissionReportFilters({
  keyword: '  园区  ',
  reportCode: ' RPT-001 ',
  organization: ' 总部 ',
  periodStart: '2028-01-01',
  periodEnd: '2028-12-31',
  scope: 'scope_2',
  category: ' 外购电 ',
  sourceBatchId: 18,
  ignored: '不得发送'
}, { page: 2, pageSize: 50 }), {
  keyword: '园区', reportCode: 'RPT-001', organization: '总部', periodStart: '2028-01-01', periodEnd: '2028-12-31',
  scope: 'scope_2', category: '外购电', sourceBatchId: 18, page: 2, pageSize: 50
});
assert.throws(() => buildCarbonEmissionReportFilters({ periodStart: '2028-12-31', periodEnd: '2028-01-01' }), /开始日期不晚于结束日期/);
assert.throws(() => buildCarbonEmissionReportFilters({ scope: 'scope_all' }), /固定合同/);
assert.throws(() => buildCarbonEmissionReportFilters({ sourceBatchId: 0 }), /正安全整数/);
assert.throws(() => buildCarbonEmissionReportFilters({}, { page: 1, pageSize: 201 }), /不能超过 200/);
assert.throws(() => buildCarbonEmissionReportFilters({}, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 }), /偏移量/);

// 列表与分页投影主动丢弃文件哈希、签名、路径和其他内部安全链字段。
const reportHeader = {
  id: 7,
  reportCode: 'RPT-2028-001',
  reportName: '2028 年度碳排放报告',
  reportOrganization: '天坤集团',
  periodStart: '2028-01-01',
  periodEnd: '2028-12-31',
  templateId: 'carbon-emission-report',
  templateVersion: '1.0',
  note: null,
  sourceBatchId: 18,
  sourceRowNumber: 2,
  createdBy: 1,
  createdByName: '管理员',
  createdAt: '2028-12-31T10:00:00Z',
  sourceOriginalFilename: '年度报告.xlsx',
  sourceBatchStatus: 'completed',
  itemCount: 1,
  summaryCount: 1,
  evidenceCount: 1,
  storedFilename: 'internal.xlsx',
  sourceFileSha256: 'secret-sha',
  previewSignature: 'secret-signature',
  auditContext: { path: 'D:/private' }
};
const projectedListRow = projectCarbonEmissionReportListRow(reportHeader);
assert.equal(projectedListRow.reportCode, 'RPT-2028-001');
for (const fieldName of CARBON_EMISSION_REPORT_INTERNAL_FIELDS) assert.equal(Object.hasOwn(projectedListRow, fieldName), false);
assert.deepEqual(projectCarbonEmissionReportPagination({ page: 1, pageSize: 20, total: 1, totalPages: 1 }), { page: 1, pageSize: 20, total: 1, totalPages: 1 });
assert.throws(() => projectCarbonEmissionReportPagination({ page: 0, pageSize: 20, total: 0, totalPages: 0 }), /分页 page/);

// 五部分详情必须结构完整，活动量、因子和排放量保持 number，内部字段递归消失。
const projectedDetail = projectCarbonEmissionReportDetail({
  report: reportHeader,
  boundaries: [{ id: 1, boundaryType: 'organization', boundaryName: '园区', boundaryDescription: '全部厂区', sourceRowNumber: 2, fileSha256: 'secret' }],
  items: [{ id: 2, itemCode: 'ITEM-001', emissionScope: 'scope_2', category: '外购电', emissionSource: '电力', activityValue: 120.5, activityUnit: 'MWh', factorValue: 0.5, factorUnit: 'tCO2e/MWh', emissionValue: 60.25, co2eUnit: 'tCO2e', evidenceCode: 'EV-001', note: null, sourceRowNumber: 2, witness: 'secret' }],
  summaries: [{ id: 3, summaryCode: 'SUM-001', summaryDimension: 'total', summaryValue: '全部', emissionValue: 60.25, co2eUnit: 'tCO2e', note: null, sourceRowNumber: 2, candidateRows: [] }],
  evidence: [{ id: 4, evidenceCode: 'EV-001', evidenceName: '电费单', evidenceType: '账单', evidenceDescription: '年度账单', note: null, sourceRowNumber: 2, storedFilename: 'secret.xlsx' }]
});
assert.equal(typeof projectedDetail.items[0].activityValue, 'number');
assert.equal(typeof projectedDetail.items[0].factorValue, 'number');
assert.equal(typeof projectedDetail.items[0].emissionValue, 'number');
assert.equal(typeof projectedDetail.summaries[0].emissionValue, 'number');
const projectedDetailJson = JSON.stringify(projectedDetail);
for (const fieldName of CARBON_EMISSION_REPORT_INTERNAL_FIELDS) assert.equal(projectedDetailJson.includes(fieldName), false);
assert.throws(() => projectCarbonEmissionReportDetail({ report: reportHeader, boundaries: [], items: [], summaries: [] }), /五部分详情/);
assert.throws(() => projectCarbonEmissionReportDetail({ report: reportHeader, boundaries: [], items: [{ ...projectedDetail.items[0], activityValue: '120.5' }], summaries: [], evidence: [] }), /活动量 必须是有限数值/);
assert.equal(formatCarbonEmissionReportNumber(0), '0');
assert.equal(formatCarbonEmissionReportNumber(null), '—');

// 预演只保留安全展示投影，execute 只提交四字段，空预演不可执行。
const securePreview = {
  batchId: 18,
  templateType: 'carbon-emission-report',
  templateVersion: '1.0',
  confirmText: '服务端返回的其他文本不得采用',
  summary: { totalRows: 1, wouldImport: 1, skipped: 0, blocked: 0, warnings: 0, errors: 0 },
  notices: ['只写预演审计'],
  items: [{ candidateRowId: 'secret-id', rowNumber: 2, reportCode: 'RPT-001', reportName: '年度报告', status: 'wouldImport', counts: { boundaries: 1, items: 1, summaries: 1, evidence: 1 }, issues: [] }],
  candidateRows: [{ secret: true }],
  candidateRowIds: ['secret-id'],
  previewSignature: 'secret',
  previewAuditDigest: 'secret',
  previewAudit: { secret: true },
  witness: 'secret',
  auditContext: { path: 'secret' },
  executeResult: { secret: true },
  auditBatch: { secret: true }
};
const projectedPreview = projectCarbonEmissionReportPreview(securePreview);
assert.equal(projectedPreview.confirmText, CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT);
assert.equal(projectedPreview.items[0].reportCode, 'RPT-001');
assert.equal(Object.hasOwn(projectedPreview.items[0], 'candidateRowId'), false);
for (const fieldName of CARBON_EMISSION_REPORT_INTERNAL_FIELDS) assert.equal(JSON.stringify(projectedPreview).includes(fieldName), false);
assert.equal(canExecuteCarbonEmissionReportImport(projectedPreview), true);
const invalidExecutablePreviews = [
  { name: '批次字符串', mutate: (preview) => { preview.batchId = '18'; } },
  { name: '负数汇总', mutate: (preview) => { preview.summary.warnings = -1; } },
  { name: '小数汇总', mutate: (preview) => { preview.summary.totalRows = 1.5; } },
  { name: '超安全整数汇总', mutate: (preview) => { preview.summary.errors = Number.MAX_SAFE_INTEGER + 1; } },
  { name: '字符串数字汇总', mutate: (preview) => { preview.summary.totalRows = '1'; } },
  { name: '缺失汇总字段', mutate: (preview) => { delete preview.summary.warnings; } },
  { name: '可导入数不是一', mutate: (preview) => { preview.summary.wouldImport = 0; } },
  { name: '存在阻断', mutate: (preview) => { preview.summary.blocked = 1; } },
  { name: '不存在唯一项目', mutate: (preview) => { preview.items = []; preview.summary.totalRows = 0; preview.summary.wouldImport = 0; } },
  { name: '项目状态不可导入', mutate: (preview) => { preview.items[0].status = 'blocked'; preview.summary.wouldImport = 0; preview.summary.blocked = 1; } },
  { name: '总行数不一致', mutate: (preview) => { preview.summary.totalRows = 2; } },
  { name: '跳过数不一致', mutate: (preview) => { preview.summary.skipped = 1; } },
  { name: '警告数不一致', mutate: (preview) => { preview.summary.warnings = 1; } },
  { name: '错误数不一致', mutate: (preview) => { preview.summary.errors = 1; } }
];
invalidExecutablePreviews.forEach(({ name, mutate }) => {
  const invalidPreview = clonePreview(projectedPreview);
  mutate(invalidPreview);
  assert.equal(canExecuteCarbonEmissionReportImport(invalidPreview), false, `${name} 必须 fail-closed。`);
});
const stringSummaryPreview = clonePreview(securePreview);
stringSummaryPreview.summary.totalRows = '1';
assert.throws(() => projectCarbonEmissionReportPreview(stringSummaryPreview), /非负安全整数 number/);
assert.deepEqual(buildCarbonEmissionReportImportExecutePayload(projectedPreview), {
  batchId: 18,
  confirmText: '确认导入碳排放报告',
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
assert.deepEqual(Object.keys(buildCarbonEmissionReportImportExecutePayload(projectedPreview)).sort(), ['acknowledgeSkippedRisks', 'batchId', 'confirmText', 'requireBackup']);

// deferred Promise 行为测试：旧成功、旧错误、旧 finally、卸载切换和重复同文件均不得污染最新意图。
let activeRequestGeneration = 1;
let requestLoading = true;
let committedValue = '';
let committedError = '';
const oldSuccessDeferred = createDeferred();
const oldSuccessRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 1,
  getCurrentGeneration: () => activeRequestGeneration,
  isActive: () => true,
  request: () => oldSuccessDeferred.promise,
  onSuccess: (value) => { committedValue = value; },
  onError: (error) => { committedError = error.message; },
  onFinally: () => { requestLoading = false; }
});
activeRequestGeneration = 2;
requestLoading = true;
const latestSuccessDeferred = createDeferred();
const latestSuccessRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 2,
  getCurrentGeneration: () => activeRequestGeneration,
  isActive: () => true,
  request: () => latestSuccessDeferred.promise,
  onSuccess: (value) => { committedValue = value; },
  onError: (error) => { committedError = error.message; },
  onFinally: () => { requestLoading = false; }
});
oldSuccessDeferred.resolve('旧成功');
assert.equal((await oldSuccessRun).status, 'ignored');
assert.equal(committedValue, '');
assert.equal(requestLoading, true, '旧 finally 不得清理当前请求 loading。');
latestSuccessDeferred.resolve('最新成功');
assert.equal((await latestSuccessRun).status, 'succeeded');
assert.equal(committedValue, '最新成功');
assert.equal(requestLoading, false);

activeRequestGeneration = 3;
committedError = '当前错误';
const oldErrorDeferred = createDeferred();
const oldErrorRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 3,
  getCurrentGeneration: () => activeRequestGeneration,
  isActive: () => true,
  request: () => oldErrorDeferred.promise,
  onError: (error) => { committedError = error.message; },
  onFinally: () => { requestLoading = false; }
});
activeRequestGeneration = 4;
committedValue = '当前页面结果';
oldErrorDeferred.reject(new Error('旧错误'));
assert.equal((await oldErrorRun).status, 'ignored');
assert.equal(committedError, '当前错误', '旧错误不得覆盖当前页面错误。');
assert.equal(committedValue, '当前页面结果');

activeRequestGeneration = 5;
let panelActive = true;
const inactiveDeferred = createDeferred();
const inactiveRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 5,
  getCurrentGeneration: () => activeRequestGeneration,
  isActive: () => panelActive,
  request: () => inactiveDeferred.promise,
  onSuccess: (value) => { committedValue = value; }
});
panelActive = false;
activeRequestGeneration = 6;
inactiveDeferred.resolve('卸载后成功');
assert.equal((await inactiveRun).status, 'ignored');
assert.notEqual(committedValue, '卸载后成功');

const repeatedFile = { name: 'same.xlsx' };
activeRequestGeneration = 7;
const firstSameFileDeferred = createDeferred();
const firstSameFileRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 7,
  getCurrentGeneration: () => activeRequestGeneration,
  canCommit: () => repeatedFile.name === 'same.xlsx',
  request: () => firstSameFileDeferred.promise,
  onSuccess: (value) => { committedValue = value; }
});
activeRequestGeneration = 8;
const secondSameFileDeferred = createDeferred();
const secondSameFileRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 8,
  getCurrentGeneration: () => activeRequestGeneration,
  canCommit: () => repeatedFile.name === 'same.xlsx',
  request: () => secondSameFileDeferred.promise,
  onSuccess: (value) => { committedValue = value; }
});
secondSameFileDeferred.resolve('同文件新意图');
assert.equal((await secondSameFileRun).status, 'succeeded');
firstSameFileDeferred.resolve('同文件旧意图');
assert.equal((await firstSameFileRun).status, 'ignored');
assert.equal(committedValue, '同文件新意图');

// 当前世代 execute 非取消失败必须清空预演、提交世代和可执行状态，同时保留稳定错误。
activeRequestGeneration = 9;
const executeFailureDeferred = createDeferred();
const executeState = {
  previewResult: projectedPreview,
  committedPreviewGeneration: 9,
  canExecute: true,
  importError: ''
};
const executeFailureRun = runLatestCarbonEmissionReportRequest({
  requestGeneration: 9,
  getCurrentGeneration: () => activeRequestGeneration,
  isActive: () => true,
  request: () => executeFailureDeferred.promise,
  onError: (error) => Object.assign(
    executeState,
    buildCarbonEmissionReportExecuteFailureState(error.message)
  )
});
executeFailureDeferred.reject(new Error('服务端执行失败'));
assert.equal((await executeFailureRun).status, 'failed');
assert.deepEqual(executeState, {
  previewResult: null,
  committedPreviewGeneration: 0,
  canExecute: false,
  importError: '服务端执行失败'
});

// stale、XLSX、重复查看意图和导出行数响应头使用冻结合同。
assert.equal(isCarbonEmissionReportPreviewStaleError({ response: { status: 409 }, apiError: { code: 'CARBON_EMISSION_REPORT_PREVIEW_STALE', details: { requiresNewPreview: true } } }), true);
assert.equal(isCarbonEmissionReportPreviewStaleError({ response: { status: 409 }, apiError: { code: 'CARBON_EMISSION_REPORT_PREVIEW_STALE', details: { requiresNewPreview: false } } }), false);
assert.equal(isCarbonEmissionReportXlsxFile({ name: '报告.XLSX' }), true);
for (const name of ['报告.xls', '报告.csv', '报告.xlsx.exe', '']) assert.equal(isCarbonEmissionReportXlsxFile({ name }), false);
const firstIntent = createCarbonEmissionReportViewIntent('report', 7, 0);
const repeatedIntent = createCarbonEmissionReportViewIntent('report', 7, firstIntent.intent);
assert.equal(firstIntent.targetId, repeatedIntent.targetId);
assert.notEqual(firstIntent.intent, repeatedIntent.intent);
assert.deepEqual(createCarbonEmissionReportViewIntent('batch', 18, repeatedIntent.intent).targetType, 'batch');
assert.equal(getCarbonEmissionReportExportedRowCount({ headers: { 'x-exported-row-count': '5' } }), 5);
assert.equal(getCarbonEmissionReportExportedRowCount({ headers: new Map([['x-exported-row-count', '6']]) }), 6);
assert.equal(getCarbonEmissionReportExportedRowCount({ headers: { 'x-exported-row-count': '-1' } }), null);
assert.equal(getCarbonEmissionReportExportedRowCount({ headers: {} }), null);

// API 和 SFC 静态合同：共享 HTTP、固定路由、可编辑自然日、请求世代、五部分详情和卸载失效必须存在。
const apiSource = readFileSync(new URL('../api/carbonEmissionReports.js', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../views/carbon/CarbonManagement.vue', import.meta.url), 'utf8');
const sectionSource = readFileSync(new URL('../views/carbon/components/CarbonEmissionReportsSection.vue', import.meta.url), 'utf8');
const importPanelSource = readFileSync(new URL('../views/carbon/components/CarbonEmissionReportImportPanel.vue', import.meta.url), 'utf8');
const httpSource = readFileSync(new URL('../api/http.js', import.meta.url), 'utf8');
const utilitySource = readFileSync(new URL('../utils/carbonEmissionReportManagement.js', import.meta.url), 'utf8');
assert.match(apiSource, /import \{ download, query, request \} from '@\/api\/http'/);
for (const endpoint of ['/carbon/emission-reports', '/batches/', '/imports/preview', '/imports/execute', '/export', '/templates/carbon-emission-report.xlsx']) assert.ok(apiSource.includes(endpoint), `N6 API 缺少 ${endpoint}`);
assert.match(httpSource, /parseJsonErrorBlob/);
assert.match(httpSource, /return \{ fileName, headers: response\.headers, demo \}/);
assert.match(pageSource, /CarbonEmissionReportsSection/);
assert.match(pageSource, /canEmissionReportView/);
assert.match(pageSource, /name="emission-reports"/);
assert.match(pageSource, /:active="activeTab === 'emission-reports'"/);
assert.match(pageSource, /projectCarbonEmissionReportPermissions/);
assert.match(pageSource, /requiresEnergyTypes/);
assert.match(sectionSource, /PageState/);
assert.match(sectionSource, /!canImportPreview && !canImportExecute && !canExport/);
assert.match(sectionSource, /carbon:emission-reports:import:execute/);
assert.match(sectionSource, /loading/i);
assert.match(sectionSource, /pageError/);
assert.match(sectionSource, /pagination/);
assert.match(sectionSource, /组织与核算边界/);
for (const sectionName of CARBON_EMISSION_REPORT_SECTION_NAMES) assert.ok(sectionSource.includes(sectionName));
for (const fieldName of ['draftFilters.periodStart', 'draftFilters.periodEnd']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(sectionSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="date")(?=[^>]*value-format="YYYY-MM-DD")(?=[^>]*format="YYYY-MM-DD")(?=[^>]*:editable="true")[^>]*>`));
}
for (const generationName of ['listRequestGeneration', 'reportDetailRequestGeneration', 'batchTraceRequestGeneration', 'exportRequestGeneration']) assert.match(sectionSource, new RegExp(generationName));
assert.match(sectionSource, /isLatestRequestGeneration/);
assert.match(sectionSource, /createCarbonEmissionReportViewIntent/);
assert.match(sectionSource, /watch\(\(\) => props\.active/);
assert.match(sectionSource, /onBeforeUnmount\(invalidateSectionRequests\)/);
assert.match(sectionSource, /X-Exported-Row-Count/);
assert.match(importPanelSource, /accept="\.xlsx"/);
assert.match(importPanelSource, /:on-exceed="handleFileExceed"/);
assert.match(importPanelSource, /uploadRef\.value\?\.handleStart\?\.\(rawFile\)/);
assert.match(importPanelSource, /CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT/);
assert.match(utilitySource, /确认导入碳排放报告/);
assert.match(utilitySource, /CARBON_EMISSION_REPORT_PREVIEW_STALE/);
assert.match(importPanelSource, /isCarbonEmissionReportPreviewStaleError/);
assert.match(importPanelSource, /applyExecuteFailureState\(failureMessage\)/);
assert.match(importPanelSource, /invalidatePreviewState\(false\)/);
assert.match(importPanelSource, /runLatestCarbonEmissionReportRequest/);
assert.match(importPanelSource, /onBeforeUnmount\(invalidateAllRequests\)/);
assert.doesNotMatch(importPanelSource.split('</template>')[0], /candidateRowId|candidateRows|candidateRowIds|previewSignature|previewAuditDigest|previewAudit|auditContext|executeResult|auditBatch|storedFilename|fileSha256/);
assert.doesNotMatch(sectionSource.split('</template>')[0], /storedFilename|fileSha256|sourceFileSha256|candidateRowId|candidateRows|candidateRowIds|previewSignature|previewAuditDigest|previewAudit|auditContext|executeResult|auditBatch/);

console.log('carbonEmissionReports.test.mjs passed');
