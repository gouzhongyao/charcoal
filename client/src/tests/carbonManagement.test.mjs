import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCarbonEmissionFilters,
  buildCarbonFactorFilters,
  buildCarbonFactorImportExecutePayload,
  nextCarbonFactorStatus,
  rowsForEmissionUnit,
  totalsByEmissionUnitLabel
} from '../utils/carbonManagement.js';
import {
  buildCarbonActivityImportExecutePayload,
  buildCarbonActivityVoidPayload,
  canExecuteCarbonActivityImport,
  formatSourceWallClock
} from '../utils/carbonActivityManagement.js';
import {
  CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE,
  CARBON_ACCOUNTING_DOUBLE_COUNT_WARNING,
  availableCarbonAccountingSources,
  buildCarbonAccountingFilters,
  buildCarbonCalculationRunPayload,
  canExportCarbonAccountingSource,
  canViewCarbonAccountingSource,
  createCarbonRunSelectionIntent,
  createEmptyCarbonAccountingFacet,
  createEmptyCarbonAccountingFilters,
  createEmptyCarbonAccountingSourceState,
  createEmptyCarbonAccountingStatistics,
  formatNullableCarbonValue,
  hasCarbonRunSelectionIntentChanged,
  normalizeAllCarbonAccountingResponse,
  normalizeAllCarbonAccountingStatisticsResponse,
  projectCarbonPagePermissions,
  projectCarbonRunSelectionState,
  resolveInitialCarbonAccountingSource
} from '../utils/carbonSourceManagement.js';
import {
  isLatestRequestGeneration,
  nextRequestGeneration
} from '../utils/requestGeneration.js';

// 可控异步模块：测试主动决定 Promise 完成顺序，不依赖计时器或源码正则。
/** 创建可由测试显式完成或拒绝的 Promise。 */
function createDeferredPromise() {
  // 外部完成方法：在 Promise 构造时捕获。
  let resolvePromise;
  // 外部拒绝方法：在 Promise 构造时捕获。
  let rejectPromise;
  // 可控 Promise：仅由测试步骤决定终态。
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

// 旧碳因子和旧能耗筛选合同继续保留。
assert.deepEqual(
  buildCarbonFactorFilters({ energyTypeCode: 'electricity', region: 'default', factorYear: '2028', status: 'active', keyword: '测试来源' }, { page: 2, pageSize: 50 }),
  { energyTypeCode: 'electricity', region: 'default', factorYear: '2028', status: 'active', keyword: '测试来源', page: 2, pageSize: 50 }
);
assert.deepEqual(buildCarbonFactorFilters({}, { page: 1, pageSize: 20 }), { page: 1, pageSize: 20 });
assert.deepEqual(
  buildCarbonEmissionFilters({ normalizedMonthStart: '2028-01', normalizedMonthEnd: '2028-03', energyTypeCode: 'electricity', organization: '碳统计组织', status: 'calculated', keyword: '厂区' }, { page: 3, pageSize: 100 }),
  { normalizedMonthStart: '2028-01', normalizedMonthEnd: '2028-03', energyTypeCode: 'electricity', organization: '碳统计组织', status: 'calculated', keyword: '厂区', page: 3, pageSize: 100 }
);

// 旧碳因子导入继续使用服务端签名候选合同。
const factorPreview = { batchId: 6, confirmText: '确认导入碳因子', previewSignature: 'hmac-sha256:v1:example', summary: { wouldImport: 2 }, candidateRowIds: [2, 5], candidateRows: [{ candidateRowId: 'carbon-factor:2', rowNumber: 2 }, { candidateRowId: 'carbon-factor:5', rowNumber: 5 }] };
assert.deepEqual(buildCarbonFactorImportExecutePayload(factorPreview), {
  batchId: 6,
  confirmText: '确认导入碳因子',
  previewSignature: 'hmac-sha256:v1:example',
  expectedWouldImport: 2,
  candidateRowIds: [2, 5],
  candidateRows: [{ candidateRowId: 'carbon-factor:2', rowNumber: 2 }, { candidateRowId: 'carbon-factor:5', rowNumber: 5 }],
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
assert.equal(nextCarbonFactorStatus('active'), 'inactive');
assert.equal(nextCarbonFactorStatus('inactive'), 'active');

// 排放单位继续分列，禁止跨单位前端求和。
const mixedUnits = [{ emissionUnit: 'kgCO2e', totalEmissionValue: 50 }, { emissionUnit: 'tCO2e', totalEmissionValue: 0.05 }, { emissionUnit: 'kgCO2e', totalEmissionValue: 25 }];
assert.deepEqual(rowsForEmissionUnit(mixedUnits, 'kgCO2e'), [mixedUnits[0], mixedUnits[2]], '图表仅可接收同一排放单位的统计行。');
assert.equal(totalsByEmissionUnitLabel(mixedUnits), '50 kgCO2e；0.05 tCO2e；25 kgCO2e', '汇总卡必须分列展示，不能跨单位相加。');

// 独立活动导入 execute 只提交服务端允许的四字段最小载荷。
const activityPreview = {
  batchId: 18,
  confirmText: '确认导入独立碳活动',
  previewSignature: '禁止提交',
  candidateRows: [{ rowNumber: 2 }],
  candidateRowIds: [2],
  auditDigest: '禁止提交',
  summary: { wouldImport: 1, skipped: 2, blocked: 0 }
};
assert.equal(canExecuteCarbonActivityImport(activityPreview), true);
assert.equal(canExecuteCarbonActivityImport({ batchId: 18, summary: { wouldImport: 0 } }), false, '空候选预演不可执行。');
assert.equal(canExecuteCarbonActivityImport({ batchId: 0, summary: { wouldImport: 1 } }), false, '批次无效不可执行。');
assert.deepEqual(buildCarbonActivityImportExecutePayload(activityPreview), {
  batchId: 18,
  confirmText: '确认导入独立碳活动',
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
assert.deepEqual(Object.keys(buildCarbonActivityImportExecutePayload(activityPreview)).sort(), ['acknowledgeSkippedRisks', 'batchId', 'confirmText', 'requireBackup']);
assert.deepEqual(buildCarbonActivityVoidPayload('  数据撤回  ', { updatedAt: '2028-04-01T02:03:04Z', previewSignature: '禁止提交' }), { reason: '数据撤回', expectedUpdatedAt: '2028-04-01T02:03:04Z' });
assert.equal(formatSourceWallClock('2028-04-01T09:30'), '2028-04-01T09:30', '来源墙钟必须原样展示，不能追加 Z。');
assert.doesNotMatch(formatSourceWallClock('2028-04-01T09:30'), /Z$/);

// 统一结果默认独立来源；没有独立活动权限时必须保持未选择，旧来源只能由用户显式选择。
assert.equal(CARBON_ACCOUNTING_DEFAULT_SOURCE_TYPE, 'independent_activity');
assert.equal(CARBON_ACCOUNTING_DOUBLE_COUNT_WARNING, '两来源不可直接合计，避免双计。');
assert.equal(resolveInitialCarbonAccountingSource({ canActivityView: true, canEnergyView: true }), 'independent_activity');
assert.equal(resolveInitialCarbonAccountingSource({ canActivityView: false, canEnergyView: true }), null);
assert.equal(canViewCarbonAccountingSource('all', { canActivityView: true, canEnergyView: false }), false);
assert.equal(canViewCarbonAccountingSource('all', { canActivityView: true, canEnergyView: true }), true);
assert.equal(canExportCarbonAccountingSource('all', { canActivityExport: true, canEnergyExport: false }), false);
assert.equal(canExportCarbonAccountingSource('all', { canActivityExport: true, canEnergyExport: true }), true);
assert.deepEqual(availableCarbonAccountingSources({ canActivityView: true, canEnergyView: false }).map((item) => item.value), ['independent_activity']);
assert.deepEqual(availableCarbonAccountingSources({ canActivityView: true, canEnergyView: true }).map((item) => item.value), ['independent_activity', 'energy_record', 'all']);
assert.deepEqual(buildCarbonAccountingFilters({ status: 'factor_missing', keyword: '活动', includeSuperseded: false }, 'independent_activity', { page: 2, pageSize: 50 }), { sourceType: 'independent_activity', status: 'factor_missing', keyword: '活动', page: 2, pageSize: 50 });

// legacy carbon:view 只兼容旧因子和旧 emissions，不得扩张新 accounting 的 energy_record 或 all。
const legacyPermissions = projectCarbonPagePermissions((permission) => permission === 'carbon:view');
assert.equal(legacyPermissions.canFactorView, true);
assert.equal(legacyPermissions.canLegacyEnergyView, true);
assert.equal(legacyPermissions.canAccountingEnergyView, false);
assert.equal(legacyPermissions.canActivityView, false);
assert.deepEqual(availableCarbonAccountingSources({ canActivityView: false, canEnergyView: legacyPermissions.canAccountingEnergyView }), []);
const exactEnergyPermissions = projectCarbonPagePermissions((permission) => permission === 'carbon:emissions:view');
assert.equal(exactEnergyPermissions.canLegacyEnergyView, true);
assert.equal(exactEnergyPermissions.canAccountingEnergyView, true);

// 请求世代纯逻辑：逆序响应和旧 finally 都不得提交当前状态。
let requestGeneration = 0;
requestGeneration = nextRequestGeneration(requestGeneration);
const olderGeneration = requestGeneration;
requestGeneration = nextRequestGeneration(requestGeneration);
const latestGeneration = requestGeneration;
assert.equal(isLatestRequestGeneration(olderGeneration, requestGeneration), false);
assert.equal(isLatestRequestGeneration(latestGeneration, requestGeneration), true);
assert.equal(nextRequestGeneration(Number.MAX_SAFE_INTEGER), 1);

// 运行选择意图纯逻辑：同一 runCode 连续选择必须产生新 intent，并重新覆盖中间改变的来源和筛选。
const firstRunSelection = createCarbonRunSelectionIntent('RUN-2028-001', 0);
const repeatedRunSelection = createCarbonRunSelectionIntent('RUN-2028-001', firstRunSelection.intent);
assert.equal(firstRunSelection.runCode, repeatedRunSelection.runCode);
assert.notEqual(firstRunSelection.intent, repeatedRunSelection.intent);
assert.equal(hasCarbonRunSelectionIntentChanged(firstRunSelection, repeatedRunSelection), true);
// 模拟结果组件当前投影：第一次应用后，用户切换旧来源并改变筛选，再次选择同一运行。
let runSelectionProjection = projectCarbonRunSelectionState(
  firstRunSelection,
  { canActivityView: true }
);
assert.equal(runSelectionProjection.sourceType, 'independent_activity');
runSelectionProjection = {
  sourceType: 'energy_record',
  filters: { ...createEmptyCarbonAccountingFilters(), keyword: '用户改过的筛选' },
  page: 4
};
assert.equal(hasCarbonRunSelectionIntentChanged(firstRunSelection, repeatedRunSelection), true);
runSelectionProjection = projectCarbonRunSelectionState(
  repeatedRunSelection,
  { canActivityView: true }
);
assert.equal(runSelectionProjection.sourceType, 'independent_activity');
assert.deepEqual(runSelectionProjection.filters, {
  ...createEmptyCarbonAccountingFilters(),
  runCode: 'RUN-2028-001'
});
assert.equal(runSelectionProjection.page, 1);

// 可控 Promise 逆序完成：最新请求先完成后，旧请求再完成也不能覆盖数据或 loading。
let controlledRequestGeneration = 0;
const controlledRequestState = { rows: ['旧页面状态'], loading: false, error: '' };
/** 使用生产请求世代纯函数执行一次可控列表请求。 */
async function loadControlledRows(task) {
  controlledRequestGeneration = nextRequestGeneration(controlledRequestGeneration);
  const currentGeneration = controlledRequestGeneration;
  controlledRequestState.loading = true;
  controlledRequestState.error = '';
  try {
    const rows = await task;
    if (!isLatestRequestGeneration(currentGeneration, controlledRequestGeneration)) return;
    controlledRequestState.rows = rows;
  } catch (error) {
    if (!isLatestRequestGeneration(currentGeneration, controlledRequestGeneration)) return;
    controlledRequestState.rows = [];
    controlledRequestState.error = error.message;
  } finally {
    if (isLatestRequestGeneration(currentGeneration, controlledRequestGeneration)) {
      controlledRequestState.loading = false;
    }
  }
}
const olderDeferredRequest = createDeferredPromise();
const latestDeferredRequest = createDeferredPromise();
const olderRequestTask = loadControlledRows(olderDeferredRequest.promise);
const latestRequestTask = loadControlledRows(latestDeferredRequest.promise);
latestDeferredRequest.resolve(['最新请求数据']);
await latestRequestTask;
assert.deepEqual(controlledRequestState, { rows: ['最新请求数据'], loading: false, error: '' });
olderDeferredRequest.resolve(['过期请求数据']);
await olderRequestTask;
assert.deepEqual(controlledRequestState, { rows: ['最新请求数据'], loading: false, error: '' });

// 旧状态到失败空状态：请求开始和失败提交都必须使用完整空来源状态，不能残留旧 facet 或统计。
let accountingRequestGeneration = 0;
const accountingFailureState = {
  facet: {
    sourceType: 'independent_activity',
    run: { runCode: 'OLD-RUN' },
    rows: [{ id: 99 }],
    pagination: { page: 2, pageSize: 20, total: 21 }
  },
  statistics: {
    sourceType: 'independent_activity',
    run: { runCode: 'OLD-RUN' },
    summary: { totalRecords: 21, calculatedCount: 20, factorMissingCount: 1, invalidRecordCount: 0, supersededCount: 0 },
    totalsByEmissionUnit: [{ emissionUnit: 'kgCO2e', emissionRecordCount: 20, totalEmissionValue: 88 }]
  },
  loading: false,
  error: ''
};
/** 执行单来源快照请求，失败时同步转为生产空状态工厂返回值。 */
async function loadControlledAccountingSnapshot(task) {
  accountingRequestGeneration = nextRequestGeneration(accountingRequestGeneration);
  const currentGeneration = accountingRequestGeneration;
  const emptySourceState = createEmptyCarbonAccountingSourceState(
    'independent_activity',
    { page: 2, pageSize: 20, total: 21 }
  );
  accountingFailureState.facet = emptySourceState.facet;
  accountingFailureState.statistics = emptySourceState.statistics;
  accountingFailureState.loading = true;
  accountingFailureState.error = '';
  try {
    const snapshot = await task;
    if (!isLatestRequestGeneration(currentGeneration, accountingRequestGeneration)) return;
    accountingFailureState.facet = snapshot.facet;
    accountingFailureState.statistics = snapshot.statistics;
  } catch (error) {
    if (!isLatestRequestGeneration(currentGeneration, accountingRequestGeneration)) return;
    const failedSourceState = createEmptyCarbonAccountingSourceState(
      'independent_activity',
      { page: 2, pageSize: 20, total: 21 }
    );
    accountingFailureState.facet = failedSourceState.facet;
    accountingFailureState.statistics = failedSourceState.statistics;
    accountingFailureState.error = error.message;
  } finally {
    if (isLatestRequestGeneration(currentGeneration, accountingRequestGeneration)) {
      accountingFailureState.loading = false;
    }
  }
}
const failedAccountingRequest = createDeferredPromise();
const failedAccountingTask = loadControlledAccountingSnapshot(failedAccountingRequest.promise);
assert.deepEqual(accountingFailureState.facet.rows, []);
assert.equal(accountingFailureState.statistics.summary.totalRecords, 0);
assert.equal(accountingFailureState.loading, true);
failedAccountingRequest.reject(new Error('受控结果请求失败'));
await failedAccountingTask;
assert.deepEqual(accountingFailureState, {
  ...createEmptyCarbonAccountingSourceState('independent_activity', { page: 2, pageSize: 20, total: 21 }),
  loading: false,
  error: '受控结果请求失败'
});

// 空状态工厂同时清空旧结果和旧统计，并保留当前独立分页。
assert.deepEqual(createEmptyCarbonAccountingFacet('independent_activity', { page: 3, pageSize: 50, total: 99 }), {
  sourceType: 'independent_activity', run: null, rows: [], pagination: { page: 3, pageSize: 50, total: 0 }
});
assert.deepEqual(createEmptyCarbonAccountingStatistics('energy_record'), {
  sourceType: 'energy_record',
  summary: { totalRecords: 0, calculatedCount: 0, factorMissingCount: 0, invalidRecordCount: 0, supersededCount: 0 },
  totalsByEmissionUnit: []
});

// all 结果和统计必须严格验证两个自有 facet、来源、行、分页和防双计外壳。
const allResponse = normalizeAllCarbonAccountingResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'independent_activity', run: null, rows: [{ id: 1 }], pagination: { page: 1, pageSize: 20, total: 1 } },
    energyRecord: { sourceType: 'energy_record', rows: [{ id: 2 }], pagination: { page: 3, pageSize: 10, total: 31 } }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别分页，禁止合计。'
});
assert.equal(allResponse.crossSourceTotal, null);
assert.equal(allResponse.independentActivity.pagination.page, 1);
assert.equal(allResponse.energyRecord.pagination.page, 3, '两个分面保留各自分页，不合并。');
assert.throws(() => normalizeAllCarbonAccountingResponse({ sourceType: 'all', facets: {}, crossSourceTotal: 0 }), /防双计合同/);
assert.throws(() => normalizeAllCarbonAccountingResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'energy_record', run: null, rows: [], pagination: { page: 1, pageSize: 20, total: 0 } },
    energyRecord: { sourceType: 'energy_record', rows: [], pagination: { page: 1, pageSize: 20, total: 0 } }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别分页。'
}), /结果分面 independent_activity/);
assert.throws(() => normalizeAllCarbonAccountingResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'independent_activity', run: null, rows: {}, pagination: { page: 1, pageSize: 20, total: 0 } },
    energyRecord: { sourceType: 'energy_record', rows: [], pagination: { page: 1, pageSize: 20, total: 0 } }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别分页。'
}), /结果分面 independent_activity/);
assert.throws(() => normalizeAllCarbonAccountingResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'independent_activity', run: null, rows: [], pagination: { page: 0, pageSize: 20, total: 0 } },
    energyRecord: { sourceType: 'energy_record', rows: [], pagination: { page: 1, pageSize: 20, total: 0 } }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别分页。'
}), /结果分面 independent_activity/);
const emptySummary = { totalRecords: 0, calculatedCount: 0, factorMissingCount: 0, invalidRecordCount: 0, supersededCount: 0 };
const allStatistics = normalizeAllCarbonAccountingStatisticsResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'independent_activity', run: null, summary: emptySummary, totalsByEmissionUnit: [] },
    energyRecord: { sourceType: 'energy_record', summary: emptySummary, totalsByEmissionUnit: [{ emissionUnit: 'kgCO2e', emissionRecordCount: 1, totalEmissionValue: 3.5 }] }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别统计，禁止合计。'
});
assert.equal(allStatistics.energyRecord.totalsByEmissionUnit[0].totalEmissionValue, 3.5);
assert.throws(() => normalizeAllCarbonAccountingStatisticsResponse({
  sourceType: 'all',
  facets: {
    independentActivity: { sourceType: 'independent_activity', run: null, summary: { ...emptySummary, totalRecords: -1 }, totalsByEmissionUnit: [] },
    energyRecord: { sourceType: 'energy_record', summary: emptySummary, totalsByEmissionUnit: [] }
  },
  crossSourceTotal: null,
  aggregationPolicy: '分别统计。'
}), /统计分面 independent_activity/);

// 缺失因子的可空字段不能通过 Number(null) 显示成 0。
for (const value of [null, undefined, '', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatNullableCarbonValue(value), '—');
assert.equal(formatNullableCarbonValue(0), '0', '真实零仍应显示为 0。');

// 创建运行只接受严格 UTC 秒精度，并允许 .000Z 无损规范化。
assert.deepEqual(buildCarbonCalculationRunPayload({ startUtc: '2028-01-01T00:00:00.000Z', endUtc: '2028-02-01T00:00:00Z' }), {
  valid: true,
  payload: { startUtc: '2028-01-01T00:00:00Z', endUtc: '2028-02-01T00:00:00Z' },
  message: null
});
assert.equal(buildCarbonCalculationRunPayload({ startUtc: '2028-01-01T00:00', endUtc: '2028-02-01T00:00:00Z' }).valid, false, '来源墙钟不能直接作为 UTC 运行输入。');
assert.equal(buildCarbonCalculationRunPayload({ startUtc: '2028-01-01T08:00:00+08:00', endUtc: '2028-02-01T00:00:00Z' }).valid, false, 'offset 时间不能替代严格 Z 合同。');
assert.equal(buildCarbonCalculationRunPayload({ startUtc: '2028-02-01T00:00:00Z', endUtc: '2028-01-01T00:00:00Z' }).valid, false, '开始必须早于结束。');

// 页面拆分、API 路径、权限、时间和防双计静态合同。
const carbonPageSource = readFileSync(new URL('../views/carbon/CarbonManagement.vue', import.meta.url), 'utf8');
const factorSectionSource = readFileSync(new URL('../views/carbon/components/CarbonFactorsSection.vue', import.meta.url), 'utf8');
const legacySectionSource = readFileSync(new URL('../views/carbon/components/LegacyEnergyCalculationPanel.vue', import.meta.url), 'utf8');
const activitySectionSource = readFileSync(new URL('../views/carbon/components/CarbonActivitiesSection.vue', import.meta.url), 'utf8');
const activityImportSource = readFileSync(new URL('../views/carbon/components/CarbonActivityImportPanel.vue', import.meta.url), 'utf8');
const runSectionSource = readFileSync(new URL('../views/carbon/components/CarbonCalculationRunsSection.vue', import.meta.url), 'utf8');
const resultSectionSource = readFileSync(new URL('../views/carbon/components/CarbonEmissionResultsSection.vue', import.meta.url), 'utf8');
const resultFacetSource = readFileSync(new URL('../views/carbon/components/CarbonSourceResultFacet.vue', import.meta.url), 'utf8');
const carbonApiSource = readFileSync(new URL('../api/carbon.js', import.meta.url), 'utf8');
const activityApiSource = readFileSync(new URL('../api/carbonActivities.js', import.meta.url), 'utf8');
const accountingApiSource = readFileSync(new URL('../api/carbonAccounting.js', import.meta.url), 'utf8');

for (const componentName of ['CarbonFactorsSection', 'CarbonActivitiesSection', 'CarbonCalculationRunsSection', 'CarbonEmissionResultsSection', 'LegacyEnergyCalculationPanel']) assert.match(carbonPageSource, new RegExp(componentName));
assert.match(carbonPageSource, /两来源不可直接合计，避免双计。/);
assert.match(carbonPageSource, /projectCarbonPagePermissions/);
assert.match(carbonPageSource, /canLegacyEnergyView/);
assert.match(carbonPageSource, /canActivityExport: canActivityExport\.value/);
assert.match(carbonPageSource, /canEnergyExport: canEnergyExport\.value/);
assert.match(carbonPageSource, /:selected-run-intent="selectedRunIntent"/);
assert.match(carbonPageSource, /createCarbonRunSelectionIntent/);
assert.match(carbonPageSource, /selectedRunIntent\.value = selectionIntent\.intent/);
assert.match(activityApiSource, /\/carbon\/activities/);
assert.match(activityApiSource, /\/templates\/carbon-activities\.xlsx/);
assert.match(activityApiSource, /\/imports\/preview/);
assert.match(activityApiSource, /\/imports\/execute/);
assert.match(activityApiSource, /\/void/);
assert.match(accountingApiSource, /\/carbon\/accounting/);
for (const endpoint of ['/runs', '/results', '/statistics', '/export']) assert.ok(accountingApiSource.includes(endpoint));
assert.match(resultSectionSource, /sourceType === 'all'/);
assert.match(resultSectionSource, /crossSourceTotal/);
assert.match(resultSectionSource, /normalizeAllCarbonAccountingResponse/);
assert.match(resultSectionSource, /normalizeAllCarbonAccountingStatisticsResponse/);
assert.match(resultSectionSource, /clearAllSourceState/);
assert.match(resultSectionSource, /isLatestRequestGeneration/);
assert.match(resultSectionSource, /selectedRunIntent/);
assert.match(resultSectionSource, /\[props\.selectedRunCode, props\.selectedRunIntent\]/, '结果组件必须同时监听 runCode 和每次变化的查看意图。');
assert.match(resultSectionSource, /\{ immediate: true \}/, 'lazy 结果组件首次挂载必须立即采用父级已有 runCode。');
assert.doesNotMatch(resultSectionSource, /onMounted\(loadResults\)/, '结果组件不得用 mounted 请求覆盖 immediate runCode 请求。');
assert.match(resultSectionSource, /当前没有默认结果来源/);
assert.match(resultSectionSource, /请显式选择结果来源/);
assert.match(resultSectionSource, /safeRequest/);
assert.match(resultSectionSource, /两次 all 请求分别承载两个分面的独立分页/);
assert.match(resultSectionSource, /StrictUtcDateTimeInput/);
assert.match(resultSectionSource, /@validity-change/);
assert.match(resultSectionSource, /:disabled="!sourceType \|\| !areResultFiltersValid"/);
assert.match(runSectionSource, /StrictUtcDateTimeInput/);
assert.match(runSectionSource, /YYYY-MM-DDTHH:mm:ssZ/);
assert.match(runSectionSource, /禁止把 YYYY-MM-DDTHH:mm 墙钟字符串直接追加 Z/);
assert.match(activitySectionSource, /YYYY-MM-DDTHH:mm/);
assert.match(activitySectionSource, /禁止直接追加 Z/);
assert.match(activityImportSource, /当前预演没有可导入候选/);
assert.match(activityImportSource, /previewRequestGeneration/);
assert.match(activityImportSource, /selectedFile\.value !== previewFile/);
assert.match(activityImportSource, /服务端会重读当前原文件/);
assert.match(activityImportSource, /候选见证/);
assert.match(activityImportSource, /stale/);
assert.match(activityImportSource, /写入前强制备份/);
assert.match(activityImportSource, /事务回滚/);
assert.match(activityImportSource, /skip 行不会覆盖、更新或恢复既有事实/);
assert.match(activityImportSource, /previewSignature、candidateRows、candidateRowIds 或 auditDigest/);
assert.match(resultFacetSource, /factor_missing/);
assert.match(resultFacetSource, /scope\.row\.emissionValue === null/);
assert.match(legacySectionSource, /\/api\/carbon\/emissions\*/);
assert.match(legacySectionSource, /factor_missing/);
assert.match(carbonApiSource, /\/carbon\/emissions/);
assert.match(carbonApiSource, /\/templates\/demo-park\/11-carbon-factors\.xlsx/);
assert.match(factorSectionSource, /hasPermi\('carbon:factor:import'\)/);
assert.match(factorSectionSource, /不自动计算排放/);
assert.match(factorSectionSource, /青岚园区示例下载失败/);

// 拆分后日期选择器合同检查对应职责组件，而非巨型页面壳。
for (const fieldName of ['factorDraftFilters.factorYear', 'factorForm.factorYear']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(factorSectionSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="year")(?=[^>]*value-format="YYYY")(?=[^>]*format="YYYY")(?=[^>]*clearable)(?=[^>]*:editable="true")[^>]*>`));
}
for (const fieldName of ['factorForm.effectiveFrom', 'factorForm.effectiveTo']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(factorSectionSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="date")(?=[^>]*value-format="YYYY-MM-DD")(?=[^>]*format="YYYY-MM-DD")(?=[^>]*:editable="true")[^>]*>`));
}
for (const fieldName of ['emissionDraftFilters.normalizedMonthStart', 'emissionDraftFilters.normalizedMonthEnd', 'calculateForm.normalizedMonthStart', 'calculateForm.normalizedMonthEnd']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(legacySectionSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`));
}

// 新页面区域必须显式覆盖 loading、error、empty 和 pagination 合同。
for (const [name, source] of [['活动', activitySectionSource], ['运行', runSectionSource], ['统一结果', resultSectionSource], ['结果分面', resultFacetSource]]) {
  assert.match(source, /loading/i, `${name}板块缺少 loading 合同。`);
  assert.match(source, /error/i, `${name}板块缺少 error 合同。`);
}
for (const [name, source] of [['活动', activitySectionSource], ['运行', runSectionSource], ['结果分面', resultFacetSource]]) {
  assert.match(source, /PageState/, `${name}板块缺少 empty/error 状态组件。`);
  assert.match(source, /pagination/, `${name}板块缺少分页。`);
}

console.log('carbonManagement.test.mjs passed');
