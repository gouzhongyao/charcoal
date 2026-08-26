import assert from 'node:assert/strict';
import {
  ENERGY_BENCHMARK_CHART_MAX_ENTITIES,
  ENERGY_BENCHMARK_DIRECTION_LABELS,
  ENERGY_BENCHMARK_ENTITY_COLORS,
  ENERGY_BENCHMARK_IMPORT_TYPES,
  ENERGY_BENCHMARK_ORGANIZATION_LEVELS,
  ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS,
  ENERGY_BENCHMARK_PERMISSIONS,
  ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS,
  applyEnergyBenchmarkOrganizationSelection,
  assignEnergyBenchmarkCompetitionRanks,
  buildEnergyBenchmarkAnalysisSnapshot,
  buildEnergyBenchmarkCapabilityMatrix,
  buildEnergyBenchmarkCsv,
  buildEnergyBenchmarkDefinitionFilters,
  buildEnergyBenchmarkDefinitionPayload,
  buildEnergyBenchmarkGroupPayload,
  buildEnergyBenchmarkImportExecutePayload,
  buildEnergyBenchmarkInternalHistoryPayload,
  buildEnergyBenchmarkTargetFilters,
  buildEnergyBenchmarkTargetPayload,
  canExecuteEnergyBenchmarkImport,
  createEnergyBenchmarkActualRow,
  createEnergyBenchmarkEntityColorRegistry,
  createEnergyBenchmarkLatestRequestGuard,
  energyBenchmarkEntityColor,
  energyBenchmarkStatusPresentation,
  formatEnergyBenchmarkBoundary,
  formatEnergyBenchmarkQualificationRate,
  formatEnergyBenchmarkRatio,
  formatEnergyBenchmarkReasons,
  formatEnergyBenchmarkScopeOptionLabel,
  isEnergyBenchmarkStrictUtcRange,
  normalizeEnergyBenchmarkAnalysisFailureState,
  normalizeEnergyBenchmarkOrganizationAccessError,
  normalizeEnergyBenchmarkProductionAccessError,
  normalizeEnergyBenchmarkRankingRows,
  projectEnergyBenchmarkMaintenance,
  projectEnergyBenchmarkRequestError,
  reduceEnergyBenchmarkPageErrors,
  resetEnergyBenchmarkScopeSelection,
  resolveEnergyBenchmarkAnalysisInvalidation,
  resolveEnergyBenchmarkDefinitionObjectLevel,
  resolveEnergyBenchmarkErrorDestination,
  resolveEnergyBenchmarkScopeOptionValue,
  selectEnergyBenchmarkPageError,
  transitionEnergyBenchmarkAnalysisState,
  validateEnergyBenchmarkAnalysisContext,
  validateEnergyBenchmarkScopeSelection
} from '../utils/energyBenchmarkManagement.js';

// 轻量测试注册与执行模块。
const tests = [];
function test(name, handler) { tests.push({ name, handler }); }

// 三方向、零目标与状态展示模块。
test('三种指标方向均提供明确中文展示', () => {
  assert.deepEqual(ENERGY_BENCHMARK_DIRECTION_LABELS, {
    lower_better: '越低越好',
    higher_better: '越高越好',
    range: '区间达标'
  });
  assert.equal(formatEnergyBenchmarkBoundary({ direction: 'lower_better', targetValue: 8 }, 'kWh/t'), '8 kWh/t');
  assert.equal(formatEnergyBenchmarkBoundary({ direction: 'higher_better', targetValue: 8 }, 'tce/t'), '8 tce/t');
  assert.equal(formatEnergyBenchmarkBoundary({ direction: 'range', lowerBound: 6, upperBound: 9 }, '%'), '6 ～ 9 %');
});

test('零目标差距比例保持不可计算而不是零百分比', () => {
  assert.equal(formatEnergyBenchmarkRatio(null), '不可计算');
  assert.equal(formatEnergyBenchmarkRatio(0), '0%');
});

test('状态同时包含图标、文字和语义类型', () => {
  assert.deepEqual(energyBenchmarkStatusPresentation({ comparable: false }), { key: 'not_comparable', icon: '!', label: '不兼容', type: 'info' });
  assert.deepEqual(energyBenchmarkStatusPresentation({ met: true }), { key: 'met', icon: '✓', label: '达标', type: 'success' });
  assert.deepEqual(energyBenchmarkStatusPresentation({ met: false }), { key: 'not_met', icon: '×', label: '未达标', type: 'danger' });
});

// 兼容分母、排除原因与排名模块。
test('没有兼容分母时合格率显示不可计算', () => {
  assert.equal(formatEnergyBenchmarkQualificationRate(null, 0), '不可计算');
  assert.equal(formatEnergyBenchmarkQualificationRate(0, 0), '不可计算');
  assert.equal(formatEnergyBenchmarkQualificationRate(0, 3), '0%');
});

test('排除原因显示中文说明并保留服务端原因码', () => {
  assert.equal(
    formatEnergyBenchmarkReasons(['BENCHMARK_UNIT_MISMATCH', 'BENCHMARK_NO_COMPARABLE_OBJECTS']),
    '单位不一致（BENCHMARK_UNIT_MISMATCH）；没有兼容对象，合格率不可计算（BENCHMARK_NO_COMPARABLE_OBJECTS）'
  );
});

test('并列值使用竞赛排名 1、1、3', () => {
  const ranked = assignEnergyBenchmarkCompetitionRanks([
    { objectId: 'b', actualValue: 10 },
    { objectId: 'a', actualValue: 10 },
    { objectId: 'c', actualValue: 12 }
  ], 'lower_better');
  assert.deepEqual(ranked.map((item) => item.rank), [1, 1, 3]);
});

test('服务端已有并列名次时展示投影原样保留名次', () => {
  const rows = normalizeEnergyBenchmarkRankingRows([
    { objectId: 'a', actualValue: 10, rank: 1 },
    { objectId: 'b', actualValue: 10, rank: 1 },
    { objectId: 'c', actualValue: 12, rank: 3 }
  ]);
  assert.deepEqual(rows.map((item) => item.rank), [1, 1, 3]);
  assert.equal(rows[2].barPercentage, 100);
});

test('实体颜色注册表不依赖排名或筛选顺序且第九对象不循环复色', () => {
  const registry = createEnergyBenchmarkEntityColorRegistry();
  const forward = normalizeEnergyBenchmarkRankingRows([
    { objectId: 'workshop-a', actualValue: 1, rank: 1 },
    { objectId: 'workshop-b', actualValue: 2, rank: 2 },
    { objectId: 'workshop-c', actualValue: 3, rank: 3 }
  ], registry);
  const reverse = normalizeEnergyBenchmarkRankingRows([
    { objectId: 'workshop-c', actualValue: 3, rank: 1 },
    { objectId: 'workshop-a', actualValue: 1, rank: 2 }
  ], registry);
  assert.equal(forward.find((item) => item.objectId === 'workshop-a').entityColor, reverse.find((item) => item.objectId === 'workshop-a').entityColor);
  assert.equal(forward.find((item) => item.objectId === 'workshop-c').entityColor, reverse.find((item) => item.objectId === 'workshop-c').entityColor);
  const originalColors = Object.fromEntries(forward.map((item) => [item.objectId, item.entityColor]));
  registry.reconcile(['workshop-b', 'workshop-c']);
  assert.equal(registry.colorFor('workshop-b'), originalColors['workshop-b'], '移除 A 后幸存的 B 不得换色');
  assert.equal(registry.colorFor('workshop-c'), originalColors['workshop-c'], '移除 A 后幸存的 C 不得换色');
  registry.reconcile(['workshop-b', 'workshop-c', 'workshop-d']);
  assert.equal(registry.colorFor('workshop-d'), originalColors['workshop-a'], '新增 D 应复用已由 A 释放的空槽');
  const nineRows = normalizeEnergyBenchmarkRankingRows(Array.from({ length: 9 }, (_, index) => ({ objectId: `entity-${index + 1}`, actualValue: index + 1, rank: index + 1 })), createEnergyBenchmarkEntityColorRegistry());
  assert.equal(ENERGY_BENCHMARK_CHART_MAX_ENTITIES, 8);
  assert.equal(nineRows.slice(0, 8).every((item) => ENERGY_BENCHMARK_ENTITY_COLORS.includes(item.entityColor)), true);
  assert.equal(new Set(nineRows.slice(0, 8).map((item) => item.entityColor)).size, 8);
  assert.equal(nineRows[8].entityColor, null);
  assert.equal(energyBenchmarkEntityColor('workshop-a'), null, '没有注册表时不得按哈希取模猜测颜色');
});

// 组织对象、分析快照与竞态守卫模块。
test('organization 定义只能映射为五种真实组织层级并选择 active 同层级对象', () => {
  assert.deepEqual(ENERGY_BENCHMARK_ORGANIZATION_LEVELS, ['enterprise', 'department', 'workshop', 'process', 'equipment']);
  const definition = { id: 3, status: 'active', scopeType: 'organization', scopeReference: 'plant-a', metricCode: 'energy_intensity', unit: 'kWh/t', periodType: 'month', direction: 'lower_better' };
  const target = { id: 4, benchmarkDefinitionId: 3, status: 'active', targetValue: 8 };
  const organizations = [
    { id: 1, unitCode: 'plant-a', unitName: '甲企业', unitType: 'enterprise', status: 'active' },
    { id: 2, unitCode: 'plant-b', unitName: '乙企业', unitType: 'enterprise', status: 'active' },
    { id: 3, unitCode: 'old-plant', unitName: '停用企业', unitType: 'enterprise', status: 'inactive' }
  ];
  assert.equal(resolveEnergyBenchmarkDefinitionObjectLevel(definition, organizations), 'enterprise');
  const emptyRow = createEnergyBenchmarkActualRow(definition);
  assert.equal(emptyRow.objectLevel, '', 'organization 不得作为实际对象层级预填');
  const selectedRow = applyEnergyBenchmarkOrganizationSelection({ ...emptyRow, actualValue: 7, periodStartUtc: '2026-01-01T00:00:00Z', periodEndUtc: '2026-02-01T00:00:00Z' }, organizations[1]);
  assert.deepEqual({ objectId: selectedRow.objectId, objectName: selectedRow.objectName, objectLevel: selectedRow.objectLevel, scopeReference: selectedRow.scopeReference }, { objectId: 'plant-b', objectName: '乙企业', objectLevel: 'enterprise', scopeReference: 'plant-b' });
  assert.equal(validateEnergyBenchmarkAnalysisContext({ definition, target, actualRows: [selectedRow], organizationUnits: organizations }).ready, true);
  assert.equal(validateEnergyBenchmarkAnalysisContext({ definition, target, actualRows: [{ ...selectedRow, objectLevel: 'organization' }], organizationUnits: organizations }).ready, false);
  assert.equal(validateEnergyBenchmarkAnalysisContext({ definition, target, actualRows: [applyEnergyBenchmarkOrganizationSelection(selectedRow, organizations[2])], organizationUnits: organizations }).ready, false);
});

test('三类定义范围选择器使用真实编码并提供可读名称标签', () => {
  const organization = { unitCode: 'OU-1', unitName: '一号车间', unitPath: '企业 / 一号车间' };
  const energy = { code: 'electricity', name: '电力' };
  const production = { id: 9, unitCode: 'PU-9', unitName: '一号产线', productName: '熟料' };
  assert.equal(formatEnergyBenchmarkScopeOptionLabel('organization', organization), '企业 / 一号车间（OU-1）');
  assert.equal(formatEnergyBenchmarkScopeOptionLabel('energy', energy), '电力（electricity）');
  assert.equal(formatEnergyBenchmarkScopeOptionLabel('product', production), '熟料 / 一号产线（PU-9）');
  assert.equal(resolveEnergyBenchmarkScopeOptionValue('organization', organization), 'OU-1');
  assert.equal(resolveEnergyBenchmarkScopeOptionValue('energy', energy), 'electricity');
  assert.equal(resolveEnergyBenchmarkScopeOptionValue('product', production), 'PU-9');
});

test('范围类型切换清空旧值且 active 主数据校验不接受自由输入或产品名别名', () => {
  const sources = {
    organizationUnits: [{ unitCode: 'OU-1' }],
    energyTypes: [{ code: 'electricity' }],
    productionUnits: [{ id: 9, unitCode: 'PU-9', productName: '熟料' }]
  };
  assert.deepEqual(resetEnergyBenchmarkScopeSelection({ scopeType: 'organization', scopeReference: 'OU-1', benchmarkCode: 'B' }, 'product'), { scopeType: 'product', scopeReference: '', benchmarkCode: 'B' });
  assert.equal(validateEnergyBenchmarkScopeSelection('organization', 'OU-1', sources).valid, true);
  assert.equal(validateEnergyBenchmarkScopeSelection('energy', 'electricity', sources).valid, true);
  assert.equal(validateEnergyBenchmarkScopeSelection('product', 'PU-9', sources).valid, true);
  assert.equal(validateEnergyBenchmarkScopeSelection('product', '熟料', sources).valid, false, '前端新增选择器必须提交 unitCode，不使用服务端历史 productName 兼容入口');
  assert.equal(validateEnergyBenchmarkScopeSelection('energy', 'manual-input', sources).valid, false);
});

test('分析输入变化产生不同快照并让旧 latest-response 令牌失效', () => {
  const rows = [{ objectId: 'a', objectName: 'A', objectLevel: 'energy', actualValue: 1, metricCode: 'm', unit: 'kWh', periodType: 'month', periodStartUtc: '2026-01-01T00:00:00Z', periodEndUtc: '2026-02-01T00:00:00Z', scopeType: 'energy', scopeReference: 'electricity', benchmarkScopeReference: 'electricity', energyTypeCode: 'electricity' }];
  const firstSnapshot = buildEnergyBenchmarkAnalysisSnapshot(1, 2, rows);
  const secondSnapshot = buildEnergyBenchmarkAnalysisSnapshot(1, 2, [{ ...rows[0], actualValue: 2 }]);
  assert.notEqual(firstSnapshot, secondSnapshot);
  const guard = createEnergyBenchmarkLatestRequestGuard();
  const oldToken = guard.next('analysis', firstSnapshot);
  const latestToken = guard.next('analysis', secondSnapshot);
  assert.equal(guard.isLatest(oldToken, firstSnapshot), false);
  assert.equal(guard.isLatest(latestToken, secondSnapshot), true);
  guard.invalidate('analysis');
  assert.equal(guard.isLatest(latestToken, secondSnapshot), false);
});

test('active 定义读取失败归一化后不保留选择、目标、对象、结果或导出快照', () => {
  const state = normalizeEnergyBenchmarkAnalysisFailureState('定义读取失败');
  assert.deepEqual(state, {
    definitionId: null,
    targetId: null,
    targets: [],
    actualRows: [],
    organizationObjects: [],
    organizationError: '',
    singleEvaluation: null,
    rankingResult: null,
    qualificationResult: null,
    latestSuccessfulAnalysis: null,
    staleNotice: '定义读取失败'
  });
});

test('active 定义控制器完成失败清空、恢复默认选择和重新加载目标副作用', () => {
  const initialState = {
    definitionId: 9,
    targetId: 10,
    targets: [{ id: 10 }],
    actualRows: [{ objectId: 'A' }],
    organizationObjects: [{ unitCode: 'A' }],
    organizationError: '旧错误',
    singleEvaluation: { met: true },
    rankingResult: { ranked: [] },
    qualificationResult: { denominator: 1 },
    latestSuccessfulAnalysis: { signature: 'old' },
    staleNotice: ''
  };
  const failed = transitionEnergyBenchmarkAnalysisState(initialState, { type: 'active-definitions-failed', notice: '读取失败' });
  assert.equal(failed.nextState.definitionId, null);
  assert.equal(failed.nextState.targetId, null);
  assert.deepEqual(failed.nextState.targets, []);
  assert.deepEqual(failed.nextState.actualRows, []);
  assert.equal(failed.nextState.rankingResult, null);
  assert.equal(failed.nextState.latestSuccessfulAnalysis, null);
  assert.deepEqual(failed.effects, [{ type: 'invalidate-analysis-requests', source: 'active-source-failure' }]);
  const recovered = transitionEnergyBenchmarkAnalysisState(failed.nextState, {
    type: 'active-definitions-loaded',
    definitions: [{ id: 21, status: 'active' }, { id: 22, status: 'inactive' }]
  });
  assert.equal(recovered.nextState.definitionId, 21);
  assert.equal(recovered.nextState.targetId, null);
  assert.deepEqual(recovered.effects, [{ type: 'load-targets', definitionId: 21 }]);
  const preserved = transitionEnergyBenchmarkAnalysisState({ ...recovered.nextState, targetId: 31, rankingResult: { ranked: [{ objectId: 'A' }] } }, { type: 'management-view-changed' });
  assert.equal(preserved.nextState.targetId, 31);
  assert.deepEqual(preserved.nextState.rankingResult, { ranked: [{ objectId: 'A' }] });
  assert.deepEqual(preserved.effects, []);
});

test('局部错误优先且全页错误按工作流来源独立设置和清除', () => {
  const forbiddenProjection = projectEnergyBenchmarkRequestError({ response: { status: 403, data: { error: { code: 'FORBIDDEN' } } } }, '读取定义列表');
  const localOnly = resolveEnergyBenchmarkErrorDestination(forbiddenProjection, { hasLocalTarget: true, source: 'definitions' });
  assert.match(localOnly.localMessage, /FORBIDDEN/);
  assert.equal(localOnly.pageErrorAction, null, '局部 target 即使携带 source 也不得污染顶部错误');

  const payloadTooLarge = projectEnergyBenchmarkRequestError({ response: { status: 413, data: { error: { code: 'REQUEST_BODY_TOO_LARGE' } } } }, '对标排名');
  const maintenanceLocked = projectEnergyBenchmarkRequestError({ response: { status: 423, data: { error: { code: 'MAINTENANCE_IN_PROGRESS' } } } }, '启用对标定义');
  const rankingDestination = resolveEnergyBenchmarkErrorDestination(payloadTooLarge, { source: 'analysis-ranking' });
  const statusDestination = resolveEnergyBenchmarkErrorDestination(maintenanceLocked, { source: 'definition-status' });
  assert.match(rankingDestination.pageErrorAction.message, /413|REQUEST_BODY_TOO_LARGE/);
  assert.match(statusDestination.pageErrorAction.message, /423|MAINTENANCE_IN_PROGRESS/);

  const serverFailure = projectEnergyBenchmarkRequestError({ response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: '服务异常' } } } }, '对标导出');
  const exportDestination = resolveEnergyBenchmarkErrorDestination(serverFailure, { source: 'analysis-export' });
  assert.match(exportDestination.pageErrorAction.message, /INTERNAL_ERROR/);
  const networkProjection = projectEnergyBenchmarkRequestError(new Error('网络不可用'), '读取维护态');
  const globalNetwork = resolveEnergyBenchmarkErrorDestination(networkProjection, { source: 'maintenance' });
  assert.deepEqual(globalNetwork.pageErrorAction, {
    type: 'set',
    source: 'maintenance',
    message: networkProjection.message
  }, '显式全局来源必须接收网络错误和非特定 HTTP 状态错误');

  let errors = reduceEnergyBenchmarkPageErrors({}, rankingDestination.pageErrorAction);
  errors = reduceEnergyBenchmarkPageErrors(errors, statusDestination.pageErrorAction);
  errors = reduceEnergyBenchmarkPageErrors(errors, { type: 'clear', source: 'analysis-ranking' });
  assert.equal(selectEnergyBenchmarkPageError(errors), statusDestination.pageErrorAction.message, 'A 工作流成功不得清除 B 工作流错误');
  errors = reduceEnergyBenchmarkPageErrors(errors, { type: 'clear', source: 'definition-status' });
  assert.equal(selectEnergyBenchmarkPageError(errors), '', '同源请求成功后必须清理自身错误');
});

test('端到端能力矩阵要求导出 analyze 加 export 且导入执行 preview 加 execute', () => {
  const analyzeOnly = buildEnergyBenchmarkCapabilityMatrix({ analyze: true, export: false, importPreview: true, importExecute: false });
  assert.equal(analyzeOnly.analyze, true);
  assert.equal(analyzeOnly.exportWorkflow, false);
  assert.equal(analyzeOnly.importPreview, true);
  assert.equal(analyzeOnly.importExecuteWorkflow, false);
  const terminalOnly = buildEnergyBenchmarkCapabilityMatrix({ export: true, importExecute: true });
  assert.equal(terminalOnly.exportPermission, true);
  assert.equal(terminalOnly.exportWorkflow, false);
  assert.equal(terminalOnly.importExecutePermission, true);
  assert.equal(terminalOnly.importExecuteWorkflow, false);
  const complete = buildEnergyBenchmarkCapabilityMatrix({ analyze: true, export: true, importPreview: true, importExecute: true, organizationView: true, productionUnitView: true });
  assert.equal(complete.exportWorkflow, true);
  assert.equal(complete.importExecuteWorkflow, true);
  assert.equal(complete.organizationView, true);
  assert.equal(complete.productionView, true);
  assert.equal(buildEnergyBenchmarkCapabilityMatrix({ organizationUnitsView: true }).organizationView, true);
  assert.equal(buildEnergyBenchmarkCapabilityMatrix({ productionView: true }).productionView, true);
});

test('分析失效规则忽略管理筛选分页并仅在定义目标语义变化时重建颜色', () => {
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('management-filter', true), { invalidate: false, resetColors: false });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('management-page', true), { invalidate: false, resetColors: false });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('analysis-input', true), { invalidate: true, resetColors: false });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('definition-context', true), { invalidate: true, resetColors: true });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('target-context', true), { invalidate: true, resetColors: true });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('active-source-failure', true), { invalidate: true, resetColors: false });
  assert.deepEqual(resolveEnergyBenchmarkAnalysisInvalidation('analysis-input', false), { invalidate: false, resetColors: false });
});

test('组织和产能权限缺失或 403 归一化为对应范围专属错误', () => {
  const organizationExpected = '组织范围需要组织台账查看权限（ledger:units:view 或 ledger:organization:view）。';
  const productionExpected = '产品范围和内部历史计算范围需要产能单元查看权限（ledger:production-unit:view 或 ledger:production:view）。';
  assert.equal(normalizeEnergyBenchmarkOrganizationAccessError(null, false), organizationExpected);
  assert.equal(normalizeEnergyBenchmarkOrganizationAccessError({ response: { status: 403, data: { error: { code: 'FORBIDDEN' } } } }, true), organizationExpected);
  assert.match(normalizeEnergyBenchmarkOrganizationAccessError({ response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: '服务异常' } } } }, true), /读取组织主数据失败/);
  assert.equal(normalizeEnergyBenchmarkProductionAccessError(null, false), productionExpected);
  assert.equal(normalizeEnergyBenchmarkProductionAccessError({ response: { status: 403, data: { error: { code: 'FORBIDDEN' } } } }, true), productionExpected);
  assert.match(normalizeEnergyBenchmarkProductionAccessError({ response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: '服务异常' } } } }, true), /读取产能单元主数据失败/);
});

test('页面级状态和业务原因码统一投影且抑制重复 toast', () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [423, 'MAINTENANCE_IN_PROGRESS']]) {
    const projection = projectEnergyBenchmarkRequestError({ response: { status, data: { error: { code } } } }, '读取定义');
    assert.equal(projection.pageLevel, true);
    assert.equal(projection.suppressToast, true);
    assert.match(projection.message, new RegExp(code));
  }
  const tooLarge = projectEnergyBenchmarkRequestError({ response: { status: 413, data: { error: { code: 'REQUEST_BODY_TOO_LARGE', details: { code: 'ENERGY_BENCHMARK_JSON_TOO_LARGE' } } } } }, '执行分析');
  assert.equal(tooLarge.pageLevel, true);
  assert.equal(tooLarge.suppressToast, true);
  assert.equal(tooLarge.code, 'ENERGY_BENCHMARK_JSON_TOO_LARGE');
  assert.match(tooLarge.message, /能效对标请求体超过专属大小限制/);
  const reason = projectEnergyBenchmarkRequestError({ response: { status: 400, data: { error: { code: 'BAD_REQUEST', message: '停用定义不能分析', details: { code: 'BENCHMARK_DEFINITION_INACTIVE' } } } } }, '执行分析');
  assert.match(reason.message, /对标定义已停用/);
  assert.match(reason.message, /BENCHMARK_DEFINITION_INACTIVE/);
  assert.equal(reason.message.includes('BAD_REQUEST'), false);
});

// 写载荷与查询白名单模块。
test('严格 UTC 范围只接受 Z 结尾且开始早于不含结束时间', () => {
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), true);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), true);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-01-01T00:00:00.001Z', '2027-01-01T00:00:00Z'), false);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-02-30T00:00:00Z', '2027-01-01T00:00:00Z'), false);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-01-01T08:00:00+08:00', '2027-01-01T08:00:00+08:00'), false);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), false);
  assert.equal(isEnergyBenchmarkStrictUtcRange('2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), false);
});

test('定义、内部历史和实际值载荷保留八个 UTC 字段名与原始 Z 值', () => {
  const definitionPayload = buildEnergyBenchmarkDefinitionPayload({ effectiveStartUtc: '2026-01-01T00:00:00Z', effectiveEndUtc: '2027-01-01T00:00:00Z', sourceTimeZone: 'Asia/Shanghai' });
  const internalPayload = buildEnergyBenchmarkInternalHistoryPayload({
    definition: { effectiveStartUtc: '2026-01-01T00:00:00Z', effectiveEndUtc: '2027-01-01T00:00:00Z', sourceTimeZone: 'Asia/Shanghai' },
    referencePeriod: { startUtc: '2025-01-01T00:00:00Z', endUtc: '2026-01-01T00:00:00Z' }
  });
  const actualPayload = buildEnergyBenchmarkGroupPayload(1, 2, [{ periodStartUtc: '2026-01-01T00:00:00Z', periodEndUtc: '2026-02-01T00:00:00Z' }]);
  assert.deepEqual(
    { effectiveStartUtc: definitionPayload.effectiveStartUtc, effectiveEndUtc: definitionPayload.effectiveEndUtc },
    { effectiveStartUtc: '2026-01-01T00:00:00Z', effectiveEndUtc: '2027-01-01T00:00:00Z' }
  );
  assert.deepEqual(
    {
      effectiveStartUtc: internalPayload.definition.effectiveStartUtc,
      effectiveEndUtc: internalPayload.definition.effectiveEndUtc,
      startUtc: internalPayload.referencePeriod.startUtc,
      endUtc: internalPayload.referencePeriod.endUtc
    },
    {
      effectiveStartUtc: '2026-01-01T00:00:00Z',
      effectiveEndUtc: '2027-01-01T00:00:00Z',
      startUtc: '2025-01-01T00:00:00Z',
      endUtc: '2026-01-01T00:00:00Z'
    }
  );
  assert.deepEqual(
    { periodStartUtc: actualPayload.actuals[0].periodStartUtc, periodEndUtc: actualPayload.actuals[0].periodEndUtc },
    { periodStartUtc: '2026-01-01T00:00:00Z', periodEndUtc: '2026-02-01T00:00:00Z' }
  );
});

test('普通定义和内部历史写载荷统一拒绝空值及当前运行时未知时区', () => {
  assert.throws(() => buildEnergyBenchmarkDefinitionPayload({}), /请选择来源时区/);
  assert.throws(() => buildEnergyBenchmarkDefinitionPayload({ sourceTimeZone: 'UTC' }), /当前运行时可识别的 IANA 来源时区/);
  assert.throws(() => buildEnergyBenchmarkDefinitionPayload({ sourceTimeZone: 'Mars/Olympus_Mons' }), /当前运行时可识别的 IANA 来源时区/);
  assert.equal(buildEnergyBenchmarkDefinitionPayload({ sourceTimeZone: 'Asia/Shanghai' }).sourceTimeZone, 'Asia/Shanghai');
  assert.throws(
    () => buildEnergyBenchmarkInternalHistoryPayload({ definition: { sourceTimeZone: 'Legacy/Removed_Zone' } }),
    /当前运行时可识别的 IANA 来源时区/
  );
});

test('内部历史载荷只包含定义、参考期和显式计算范围', () => {
  const payload = buildEnergyBenchmarkInternalHistoryPayload({
    definition: {
      benchmarkCode: 'internal-2025', benchmarkName: '2025 历史基准', benchmarkType: 'manual_benchmark', metricCode: 'energy_intensity', unit: 'kWh/t', periodType: 'month', scopeType: 'organization', scopeReference: 'plant-a', direction: 'lower_better', source: '企业内部历史', documentNo: '', version: 'internal:v1', effectiveStartUtc: '2026-01-01T00:00:00Z', effectiveEndUtc: '2027-01-01T00:00:00Z', sourceTimeZone: 'Asia/Shanghai', status: 'active'
    },
    referencePeriod: { startUtc: '2025-01-01T00:00:00Z', endUtc: '2026-01-01T00:00:00Z' },
    calculationScope: { productionUnitId: 2, energyTypeCode: 'electricity' },
    snapshot: { forged: true }, frozenValue: 99, sampleCount: 100, targetValue: 99
  });
  assert.deepEqual(Object.keys(payload), ['definition', 'referencePeriod', 'calculationScope']);
  assert.equal(payload.definition.benchmarkType, 'internal_history_baseline');
  assert.deepEqual(payload.referencePeriod, { startUtc: '2025-01-01T00:00:00Z', endUtc: '2026-01-01T00:00:00Z' });
  assert.deepEqual(payload.calculationScope, { productionUnitId: 2, energyTypeCode: 'electricity' });
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['snapshot', 'frozenValue', 'sampleCount', 'productionSummary', 'productionSummaryJson', 'sourceDataDigest', 'frozenAt', 'targetValue', 'documentNo', 'version', 'benchmarkVersion', 'targetVersion', 'internalRevision']) assert.equal(serialized.includes(forbidden), false, `不得提交 ${forbidden}`);
});

test('定义和目标写载荷忽略客户端伪造的历史技术字段与内部修订', () => {
  const definitionPayload = buildEnergyBenchmarkDefinitionPayload({
    benchmarkCode: 'BENCH-1',
    benchmarkName: '标杆',
    benchmarkType: 'external_standard',
    metricCode: 'energy_intensity',
    unit: 'kWh/t',
    periodType: 'month',
    scopeType: 'organization',
    scopeReference: 'OU-1',
    direction: 'lower_better',
    source: '公开来源',
    documentNo: '客户端文号',
    version: 'client-definition:v999',
    benchmarkVersion: 'client-benchmark:v999',
    targetVersion: 'client-target:v999',
    internalRevision: 999,
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active'
  });
  const targetPayload = buildEnergyBenchmarkTargetPayload({
    benchmarkDefinitionId: 9,
    targetValue: 8,
    lowerBound: null,
    upperBound: null,
    documentNo: '客户端文号',
    version: 'client-target:v999',
    benchmarkVersion: 'client-benchmark:v999',
    targetVersion: 'client-target-version:v999',
    internalRevision: 999,
    status: 'active'
  }, true);
  for (const payload of [definitionPayload, targetPayload]) {
    for (const forbidden of ['documentNo', 'version', 'benchmarkVersion', 'targetVersion', 'internalRevision']) {
      assert.equal(Object.prototype.hasOwnProperty.call(payload, forbidden), false, `写载荷不得包含 ${forbidden}`);
    }
  }
  assert.equal(targetPayload.benchmarkDefinitionId, 9);
  assert.equal(targetPayload.targetValue, 8);
});

test('导入执行载荷只有持久化批次和固定确认字段', () => {
  const payload = buildEnergyBenchmarkImportExecutePayload({ batchId: 17, previewSignature: 'sig', candidateRows: [{ id: 1 }] }, '确认导入');
  assert.deepEqual(payload, { batchId: 17, confirmText: '确认导入', requireBackup: true, acknowledgeSkippedRisks: true });
});

test('导入预演只有完整服务端见证与候选数量一致时可执行', () => {
  const preview = { batchId: 17, previewSignature: 'sig', previewAuditDigest: 'digest', summary: { wouldImport: 2 }, candidateRows: [{}, {}] };
  assert.equal(canExecuteEnergyBenchmarkImport(preview), true);
  assert.equal(canExecuteEnergyBenchmarkImport({ ...preview, previewSignature: '' }), false);
  assert.equal(canExecuteEnergyBenchmarkImport({ ...preview, candidateRows: [{}] }), false);
  assert.equal(canExecuteEnergyBenchmarkImport({ ...preview, summary: { wouldImport: 0 }, candidateRows: [] }), false);
});

test('定义和目标查询参数只保留服务端允许字段并删除空值', () => {
  assert.deepEqual(buildEnergyBenchmarkDefinitionFilters({ status: 'active', benchmarkType: '', benchmarkCode: 'A', metricCode: 'M', scopeType: null, scopeReference: 'plant' }, { page: 2, pageSize: 50 }), { status: 'active', benchmarkCode: 'A', metricCode: 'M', scopeReference: 'plant', page: 2, pageSize: 50 });
  assert.deepEqual(buildEnergyBenchmarkTargetFilters({ definitionId: 9, status: 'inactive', ignored: 'x' }, { page: 1, pageSize: 20 }), { definitionId: 9, status: 'inactive', page: 1, pageSize: 20 });
});

test('排名、合格率和结构化导出共用显式 actuals 载荷', () => {
  const payload = buildEnergyBenchmarkGroupPayload(3, 4, [{ objectId: 'a', objectName: '=危险名称', objectLevel: 'enterprise', actualValue: 0, metricCode: 'energy_intensity', unit: 'kWh/t', periodType: 'month', periodStartUtc: '2026-01-01T00:00:00Z', periodEndUtc: '2026-02-01T00:00:00Z', scopeType: 'organization', scopeReference: 'a', benchmarkScopeReference: 'plant', energyTypeCode: '' }]);
  assert.equal(payload.definitionId, 3);
  assert.equal(payload.targetId, 4);
  assert.equal(payload.actuals.length, 1);
  assert.equal(payload.actuals[0].actualValue, 0);
  assert.equal('ignored' in payload.actuals[0], false);
});

// CSV 安全与固定权限模块。
test('CSV 使用中文表头、UTF-8 BOM、CRLF 与 RFC 4180 转义', () => {
  const csv = buildEnergyBenchmarkCsv({ rows: [{ objectId: 'A,1', objectName: '名称"甲', objectLevel: 'enterprise', actualValue: 10, targetValue: 8, lowerBound: null, upperBound: null, absoluteDifference: 2, differenceRatio: 0.25, met: false, rank: 1, excluded: false, reasonCodes: ['BENCHMARK_UNIT_MISMATCH'] }] });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.startsWith('\uFEFF对象标识,对象名称,对象层级,实际值,目标值,下限值,上限值,差额,差距比例,达标状态,排名,是否排除,原因码\r\n'));
  assert.ok(csv.includes('"A,1"'));
  assert.ok(csv.includes('"名称""甲"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('CSV 对等号、加号、减号、@、Tab 和 CR 开头文本执行公式注入防护', () => {
  const dangerous = ['=2+2', '+SUM(A1:A2)', '-1+2', '@cmd', '\t=evil', '\r=evil'];
  const csv = buildEnergyBenchmarkCsv({ rows: dangerous.map((value, index) => ({ objectId: value, objectName: `对象${index}`, reasonCodes: [] })) });
  for (const value of dangerous) assert.ok(csv.includes(`'${value}`), `应防护 ${JSON.stringify(value)}`);
});

test('权限编码和三类导入路径与后端严格对应', () => {
  assert.deepEqual(ENERGY_BENCHMARK_PERMISSIONS, {
    view: 'energy:benchmarks:view', manage: 'energy:benchmarks:manage', analyze: 'energy:benchmarks:analyze', export: 'energy:benchmarks:export', importPreview: 'energy:benchmarks:import:preview', importExecute: 'energy:benchmarks:import:execute'
  });
  assert.deepEqual(ENERGY_BENCHMARK_ORGANIZATION_VIEW_PERMISSIONS, { units: 'ledger:units:view', organization: 'ledger:organization:view' });
  assert.deepEqual(ENERGY_BENCHMARK_PRODUCTION_VIEW_PERMISSIONS, { unit: 'ledger:production-unit:view', legacy: 'ledger:production:view' });
  assert.deepEqual(ENERGY_BENCHMARK_IMPORT_TYPES.map((item) => item.value), ['conversion-factors', 'definitions', 'targets']);
});

test('bootstrap 只投影公开维护态字段', () => {
  assert.deepEqual(projectEnergyBenchmarkMaintenance({ maintenance: { active: true, reason: '本地备份', lockPath: 'D:/private/path' } }), { active: true, reason: '本地备份' });
});

let passed = 0;
for (const item of tests) {
  try { await item.handler(); passed += 1; console.log(`通过：${item.name}`); }
  catch (error) { console.error(`失败：${item.name}`); throw error; }
}
console.log(`能效对标纯逻辑测试通过：${passed}/${tests.length}`);
