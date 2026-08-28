import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_IMPORT_TYPE,
  GHG_REPORT_INTERNAL_FIELDS,
  GHG_REPORT_SECTION_NAMES,
  GHG_REPORT_TEMPLATE_ID,
  GHG_REPORT_TEMPLATE_VERSION,
  buildGhgReportExecuteFailureState,
  buildGhgReportFilters,
  buildGhgReportImportExecutePayload,
  canExecuteGhgReportImport,
  createGhgReportViewIntent,
  getGhgReportExportedRowCount,
  ghgReportSummaryLabel,
  isGhgReportPreviewStaleError,
  isGhgReportXlsxFile,
  normalizeGhgReportDate,
  projectGhgReportDetail,
  projectGhgReportListRow,
  projectGhgReportPermissions,
  projectGhgReportPreview,
  runLatestGhgReportRequest
} from '../utils/ghgReportManagement.js';

// 测试文件定位模块：静态合同读取真实源码，不依赖构建或浏览器。
const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
/** 读取 client 根目录下的 UTF-8 源码。 */
function readClientSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/** 创建可控 Promise，用于验证真实异步逆序完成。 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 递归断言公共投影未保留任何内部安全链字段。 */
function assertNoInternalFields(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoInternalFields);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nestedValue] of Object.entries(value)) {
    assert.equal(GHG_REPORT_INTERNAL_FIELDS.includes(key), false, `公共 DTO 不得包含 ${key}`);
    assertNoInternalFields(nestedValue);
  }
}

/** 创建合法列表行公共 DTO。 */
function createListRow(overrides = {}) {
  return {
    id: 11,
    reportCode: 'GHG-2025-001',
    reportName: '2025 年温室气体报告',
    reportOrganization: '天坤集团',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    templateId: 'ghg-report',
    templateVersion: '1.0',
    note: null,
    sourceBatchId: 21,
    sourceRowNumber: 2,
    createdBy: 1,
    createdByName: '管理员',
    createdAt: '2026-08-25 10:00:00',
    sourceOriginalFilename: '温室气体报告.xlsx',
    sourceBatchStatus: 'completed',
    organizationBoundaryCount: 1,
    operationalBoundaryCount: 1,
    itemCount: 2,
    summaryCount: 1,
    evidenceCount: 1,
    sourceFileSha256: '禁止投影',
    witness: { forbidden: true },
    ...overrides
  };
}

/** 创建合法唯一 wouldImport 预演公共 DTO。 */
function createPreview(overrides = {}) {
  return {
    batchId: 21,
    templateType: 'ghg-report',
    templateVersion: '1.0',
    summary: { totalRows: 1, wouldImport: 1, skipped: 0, blocked: 0, warnings: 0, errors: 0 },
    notices: [],
    items: [{
      rowNumber: 2,
      reportCode: 'GHG-2025-001',
      reportName: '2025 年温室气体报告',
      status: 'wouldImport',
      counts: { organizationBoundaries: 1, operationalBoundaries: 1, items: 2, summaries: 1, evidence: 1 },
      issues: [],
      candidateRows: [{ forbidden: true }],
      previewSignature: '禁止投影'
    }],
    previewAuditDigest: '禁止投影',
    witness: { forbidden: true },
    ...overrides
  };
}

/** 创建合法六部分详情公共 DTO。 */
function createDetail(overrides = {}) {
  return {
    report: createListRow(),
    organizationBoundaries: [{ id: 31, boundaryCode: 'OB-01', organizationUnit: '天坤集团', inclusionMethod: '运营控制法', boundaryDescription: '全部纳入', sourceRowNumber: 2, witness: '禁止投影' }],
    operationalBoundaries: [{ id: 41, emissionScope: 'scope_1', category: '固定燃烧', boundaryDescription: '锅炉天然气', sourceRowNumber: 2, fileSha256: '禁止投影' }],
    items: [
      { id: 51, itemCode: 'E-01', recordType: 'emission', emissionScope: 'scope_1', category: '固定燃烧', greenhouseGas: 'CO2', sourceOrSink: '天然气锅炉', activityValue: 100, activityUnit: 'm³', gasAmount: 2, gwp: 1, co2eValue: 2, co2eUnit: 'tCO2e', accountingMethod: '活动数据法', evidenceCode: 'EV-01', note: null, sourceRowNumber: 2, candidateRowId: 9 },
      { id: 52, itemCode: 'R-01', recordType: 'removal', emissionScope: 'scope_1', category: '清除', greenhouseGas: 'CO2', sourceOrSink: '林业清除汇', activityValue: 10, activityUnit: 'ha', gasAmount: 3, gwp: 1, co2eValue: 3, co2eUnit: 'tCO2e', accountingMethod: '监测法', evidenceCode: 'EV-02', note: null, sourceRowNumber: 3 }
    ],
    summaries: [{ id: 61, summaryCode: 'TOTAL', summaryDimension: 'total', summaryValue: '全部', emissionCo2e: 2, removalCo2e: 3, netCo2e: -1, co2eUnit: 'tCO2e', note: null, sourceRowNumber: 2, auditContext: '禁止投影' }],
    evidence: [{ id: 71, evidenceCode: 'EV-01', evidenceName: '台账', evidenceType: '台账', evidenceDescription: '原始台账', note: null, sourceRowNumber: 2, storedFilename: '禁止投影' }],
    ...overrides
  };
}

// 固定身份、六部分和 N6/N7 隔离合同。
assert.equal(GHG_REPORT_TEMPLATE_ID, 'ghg-report');
assert.equal(GHG_REPORT_TEMPLATE_VERSION, '1.0');
assert.equal(GHG_REPORT_IMPORT_TYPE, 'ghg_report');
assert.equal(GHG_REPORT_IMPORT_CONFIRM_TEXT, '确认导入温室气体报告');
assert.deepEqual(GHG_REPORT_SECTION_NAMES, ['报告信息', '组织边界', '运行边界', '报告项目', '汇总', '证据说明']);
assert.notEqual(GHG_REPORT_TEMPLATE_ID, 'carbon-emission-report');
assert.notEqual(GHG_REPORT_IMPORT_TYPE, 'carbon_emission_report');

// 四项精确权限不得由 N6 或旧权限兜底。
const permissionSet = new Set(['carbon:ghg-reports:view', 'carbon:ghg-reports:export']);
assert.deepEqual(projectGhgReportPermissions((permission) => permissionSet.has(permission)), {
  canView: true,
  canImportPreview: false,
  canImportExecute: false,
  canExport: true
});
assert.deepEqual(projectGhgReportPermissions((permission) => ['carbon:view', 'carbon:emission-reports:view', 'carbon:emission-reports:export'].includes(permission)), {
  canView: false,
  canImportPreview: false,
  canImportExecute: false,
  canExport: false
});

// 自然日、枚举、分页和安全偏移量。
assert.equal(normalizeGhgReportDate('2024-02-29'), '2024-02-29');
assert.throws(() => normalizeGhgReportDate('2025-02-29'), /有效的公历日期/);
assert.deepEqual(buildGhgReportFilters({ recordType: 'removal', scope: 'scope_2', greenhouseGas: 'CH4' }, { page: 2, pageSize: 20 }), {
  recordType: 'removal', scope: 'scope_2', greenhouseGas: 'CH4', page: 2, pageSize: 20
});
assert.throws(() => buildGhgReportFilters({ recordType: 'carbon_emission_report' }), /记录类型/);
assert.throws(() => buildGhgReportFilters({}, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 }), /分页偏移量/);
assert.throws(() => buildGhgReportFilters({}, { page: 1, pageSize: 201 }), /不能超过 200/);
assert.equal(ghgReportSummaryLabel('gas'), '温室气体', '前端汇总标签必须使用服务端真实 gas 枚举。');
assert.equal(ghgReportSummaryLabel('greenhouse_gas'), 'greenhouse_gas', '废弃别名不得伪装成服务端公共枚举。');

// 列表和六部分详情使用白名单投影，负净 CO2e 合法，内部字段全部丢弃。
const projectedListRow = projectGhgReportListRow(createListRow());
assert.equal(projectedListRow.organizationBoundaryCount, 1);
assert.equal(projectedListRow.operationalBoundaryCount, 1);
assertNoInternalFields(projectedListRow);
const projectedDetail = projectGhgReportDetail(createDetail());
assert.equal(projectedDetail.items[0].recordType, 'emission');
assert.equal(projectedDetail.items[1].recordType, 'removal');
assert.equal(projectedDetail.summaries[0].netCo2e, -1);
assertNoInternalFields(projectedDetail);

// 公共 DTO 数值必须是 number、安全且符号正确。
assert.throws(() => projectGhgReportListRow(createListRow({ itemCount: '2' })), /非负安全整数 number/);
assert.throws(() => projectGhgReportListRow(createListRow({ itemCount: Number.MAX_SAFE_INTEGER + 1 })), /非负安全整数 number/);
const negativeEmissionDetail = createDetail();
negativeEmissionDetail.items[0].co2eValue = -1;
assert.throws(() => projectGhgReportDetail(negativeEmissionDetail), /项目 CO2e 必须是非负数/);
const negativeRemovalDetail = createDetail();
negativeRemovalDetail.summaries[0].removalCo2e = -1;
assert.throws(() => projectGhgReportDetail(negativeRemovalDetail), /汇总清除 CO2e 必须是非负数/);
const zeroGwpDetail = createDetail();
zeroGwpDetail.items[0].gwp = 0;
assert.throws(() => projectGhgReportDetail(zeroGwpDetail), /GWP 必须大于 0/);
const invalidRecordTypeDetail = createDetail();
invalidRecordTypeDetail.items[0].recordType = 'removal-as-negative-emission';
assert.throws(() => projectGhgReportDetail(invalidRecordTypeDetail), /emission 或 removal/);

// 预演只保留公共 DTO；唯一 wouldImport、非负安全整数和计数一致性同时成立才可执行。
const projectedPreview = projectGhgReportPreview(createPreview());
assertNoInternalFields(projectedPreview);
assert.equal(canExecuteGhgReportImport(projectedPreview), true);
assert.deepEqual(buildGhgReportImportExecutePayload(projectedPreview), {
  batchId: 21,
  confirmText: '确认导入温室气体报告',
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
assert.equal(canExecuteGhgReportImport(createPreview({ summary: { totalRows: 1, wouldImport: 2, skipped: 0, blocked: 0, warnings: 0, errors: 0 } })), false);
assert.equal(canExecuteGhgReportImport(createPreview({ items: [createPreview().items[0], { ...createPreview().items[0], reportCode: 'GHG-002' }], summary: { totalRows: 2, wouldImport: 2, skipped: 0, blocked: 0, warnings: 0, errors: 0 } })), false);
assert.equal(canExecuteGhgReportImport(createPreview({ items: [{ ...createPreview().items[0], status: 'blocked' }], summary: { totalRows: 1, wouldImport: 0, skipped: 0, blocked: 1, warnings: 0, errors: 0 } })), false);
assert.throws(() => projectGhgReportPreview(createPreview({ summary: { totalRows: 1, wouldImport: '1', skipped: 0, blocked: 0, warnings: 0, errors: 0 } })), /非负安全整数 number/);
assert.throws(() => projectGhgReportPreview(createPreview({ summary: { totalRows: 1, wouldImport: Number.MAX_SAFE_INTEGER + 1, skipped: 0, blocked: 0, warnings: 0, errors: 0 } })), /非负安全整数 number/);

// stale 必须精确匹配 HTTP 409、错误码和 requiresNewPreview。
const staleError = { response: { status: 409 }, apiError: { code: 'GHG_REPORT_PREVIEW_STALE', details: { requiresNewPreview: true } } };
assert.equal(isGhgReportPreviewStaleError(staleError), true);
assert.equal(isGhgReportPreviewStaleError({ response: { status: 409 }, apiError: { code: 'CARBON_EMISSION_REPORT_PREVIEW_STALE', details: { requiresNewPreview: true } } }), false);
assert.equal(isGhgReportPreviewStaleError({ response: { status: 409 }, apiError: { code: 'GHG_REPORT_PREVIEW_STALE', details: { requiresNewPreview: false } } }), false);

// 当前非取消 execute 失败必须清空预演、提交世代和可执行状态。
assert.deepEqual(buildGhgReportExecuteFailureState('事务失败'), {
  previewResult: null,
  committedPreviewGeneration: 0,
  canExecute: false,
  importError: '事务失败'
});

// 真实 deferred Promise 逆序完成：旧 success、旧 error 和旧 finally 均不得覆盖新意图。
let currentGeneration = 1;
const olderSuccess = createDeferred();
const newerSuccess = createDeferred();
const commits = [];
let finallyCount = 0;
const olderSuccessTask = runLatestGhgReportRequest({
  requestGeneration: 1,
  getCurrentGeneration: () => currentGeneration,
  request: () => olderSuccess.promise,
  onSuccess: (value) => commits.push(value),
  onFinally: () => { finallyCount += 1; }
});
currentGeneration = 2;
const newerSuccessTask = runLatestGhgReportRequest({
  requestGeneration: 2,
  getCurrentGeneration: () => currentGeneration,
  request: () => newerSuccess.promise,
  onSuccess: (value) => commits.push(value),
  onFinally: () => { finallyCount += 1; }
});
newerSuccess.resolve('newer');
assert.equal((await newerSuccessTask).status, 'succeeded');
olderSuccess.resolve('older');
assert.equal((await olderSuccessTask).status, 'ignored');
assert.deepEqual(commits, ['newer']);
assert.equal(finallyCount, 1);

const olderError = createDeferred();
const errorCommits = [];
currentGeneration = 3;
const olderErrorTask = runLatestGhgReportRequest({
  requestGeneration: 3,
  getCurrentGeneration: () => currentGeneration,
  request: () => olderError.promise,
  onError: (error) => errorCommits.push(error.message),
  onFinally: () => errorCommits.push('old-finally')
});
currentGeneration = 4;
olderError.reject(new Error('旧错误'));
assert.equal((await olderErrorTask).status, 'ignored');
assert.deepEqual(errorCommits, []);

// 当前 execute 错误在 onError 中清空预演后，仍必须由当前世代 finally 结束 loading。
const executeFailure = createDeferred();
const executeFailureState = {
  previewResult: projectedPreview,
  committedPreviewGeneration: 5,
  canExecute: true,
  importError: '',
  loading: true
};
currentGeneration = 5;
const executeFailureTask = runLatestGhgReportRequest({
  requestGeneration: 5,
  getCurrentGeneration: () => currentGeneration,
  canCommit: () => executeFailureState.previewResult === projectedPreview,
  request: () => executeFailure.promise,
  onError: (error) => Object.assign(
    executeFailureState,
    buildGhgReportExecuteFailureState(error.message)
  ),
  onFinally: () => { executeFailureState.loading = false; }
});
executeFailure.reject(new Error('服务端事务失败'));
assert.equal((await executeFailureTask).status, 'failed');
assert.equal(executeFailureState.previewResult, null);
assert.equal(executeFailureState.canExecute, false);
assert.equal(executeFailureState.loading, false, '当前失败清空预演后仍必须可靠结束 execute loading。');

// 同一报告连续查看仍形成两个独立 intent。
const firstViewIntent = createGhgReportViewIntent('report', 11, 0);
const secondViewIntent = createGhgReportViewIntent('report', 11, firstViewIntent.intent);
assert.equal(firstViewIntent.targetId, secondViewIntent.targetId);
assert.notEqual(firstViewIntent.intent, secondViewIntent.intent);

// XLSX 和导出响应头合同。
assert.equal(isGhgReportXlsxFile({ name: '温室气体报告.XLSX' }), true);
assert.equal(isGhgReportXlsxFile({ name: '温室气体报告.xls' }), false);
assert.equal(getGhgReportExportedRowCount({ headers: { 'x-exported-row-count': '6' } }), 6);
assert.equal(getGhgReportExportedRowCount({ headers: { 'x-exported-row-count': '-1' } }), null);

// 静态 API 合同：只复用共享 http，不创建 Axios 实例，模板和领域路由不混用 N6。
const apiSource = readClientSource('api/ghgReports.js');
assert.match(apiSource, /import \{ download, query, request \} from '@\/api\/http'/);
assert.match(apiSource, /\/templates\/ghg-report\.xlsx/);
assert.match(apiSource, /\/carbon\/ghg-reports/);
assert.doesNotMatch(apiSource, /axios\.create/);
assert.doesNotMatch(apiSource, /carbon-emission-report\.xlsx|\/carbon\/emission-reports/);

// 导入组件合同：同文件重选、execute fail-closed、stale 和三项操作权限提示均存在。
const importPanelSource = readClientSource('views/carbon/components/GhgReportImportPanel.vue');
assert.match(importPanelSource, /handleStart\?\.\(rawFile\)/);
assert.match(importPanelSource, /buildGhgReportExecuteFailureState/);
assert.match(importPanelSource, /isGhgReportPreviewStaleError/);
assert.match(importPanelSource, /previewResult\.value = failureState\.previewResult/);
assert.match(importPanelSource, /committedPreviewGeneration\.value = failureState\.committedPreviewGeneration/);
assert.match(importPanelSource, /carbon:ghg-reports:import:execute/);
assert.doesNotMatch(importPanelSource, /carbon:emission-reports:/);

// 六部分组件合同：重复查看、N7 权限、emission/removal、净 CO2e 与 Blob JSON 共享下载恢复链均冻结。
const sectionSource = readClientSource('views/carbon/components/GhgReportsSection.vue');
assert.match(sectionSource, /六部分详情/);
assert.match(sectionSource, /organizationBoundaries/);
assert.match(sectionSource, /operationalBoundaries/);
assert.match(sectionSource, /recordType/);
assert.match(sectionSource, /removalCo2e/);
assert.match(sectionSource, /netCo2e/);
assert.match(sectionSource, /createGhgReportViewIntent\('report'/);
assert.match(sectionSource, /carbon:ghg-reports:import:preview/);
assert.match(sectionSource, /carbon:ghg-reports:import:execute/);
assert.match(sectionSource, /carbon:ghg-reports:export/);
assert.doesNotMatch(sectionSource, /carbon:emission-reports:/);
const httpSource = readClientSource('api/http.js');
assert.match(httpSource, /parseJsonErrorBlob/);
assert.match(httpSource, /responseType: 'blob'/);

// CarbonManagement 投影两类报告且 report-only 不加载能源字典。
const carbonPageSource = readClientSource('views/carbon/CarbonManagement.vue');
assert.match(carbonPageSource, /projectGhgReportPermissions/);
assert.match(carbonPageSource, /name="ghg-reports"/);
assert.match(carbonPageSource, /<GhgReportsSection/);
assert.match(carbonPageSource, /canGhgReportView/);
assert.match(carbonPageSource, /const requiresEnergyTypes = computed\(\(\) => canFactorView\.value \|\| canActivityView\.value \|\| canAccountingView\.value \|\| canLegacyEnergyView\.value\)/);

// ImportCenter 同时投影 N6/N7 view/export，四项权限不得互相替代。
const importCenterSource = readClientSource('views/imports/ImportCenter.vue');
assert.match(importCenterSource, /carbon:emission-reports:view/);
assert.match(importCenterSource, /carbon:emission-reports:export/);
assert.match(importCenterSource, /carbon:ghg-reports:view/);
assert.match(importCenterSource, /carbon:ghg-reports:export/);
assert.match(importCenterSource, /availableImportBatchTypeOptions\(canViewCarbonEmissionReports\.value, canViewGhgReports\.value\)/);
assert.match(importCenterSource, /filterVisibleImportBatches\(result\.value\.data, canViewCarbonEmissionReports\.value, canViewGhgReports\.value\)/);
assert.match(importCenterSource, /canExportGhgReports: canExportGhgReports\.value/);

assert.ok(currentDirectory.endsWith('tests\\') || currentDirectory.endsWith('tests/'));
console.log('ghgReports 前端纯逻辑与静态合同测试通过');
