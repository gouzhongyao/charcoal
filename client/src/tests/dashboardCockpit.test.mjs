import assert from 'node:assert/strict';
import {
  DASHBOARD_PANEL_STATUS,
  attachSeriesComparisonRows,
  buildCarbonTrendSeries,
  buildDashboardBaselineRange,
  buildDashboardYearRange,
  buildEnergyTrendSeries,
  calculateZeroSafePercentage,
  createDashboardPanelState,
  filterDashboardRowsByMonthRange,
  formatDashboardMeasurement,
  formatDashboardPercentage,
  groupCarbonRowsByUnit,
  groupEnergyRowsByUnit,
  isLatestDashboardRequest,
  projectBudgetWarningStatus,
  projectCarbonDashboardStats,
  projectDashboardSceneState,
  projectSeriesChange,
  resolveDashboardSummaryDomainState,
  resolveTrendAxisMaximum,
  settleDashboardPanelSuccess
} from '../utils/dashboardCockpit.js';

// 年度范围必须稳定输出完整自然年，并对非法年度回退。
assert.deepEqual(buildDashboardYearRange(2026), {
  year: 2026,
  normalizedMonthStart: '2026-01',
  normalizedMonthEnd: '2026-12'
});
assert.equal(buildDashboardYearRange('invalid', 2025).year, 2025);
const selectedDashboardRange = buildDashboardYearRange(2026);
const baselineDashboardRange = buildDashboardBaselineRange(selectedDashboardRange);
assert.deepEqual(baselineDashboardRange, {
  normalizedMonthStart: '2025-12',
  normalizedMonthEnd: '2025-12'
});
const extendedEnergyRows = [
  { month: '2025-12', energyTypeCode: 'electricity', energyTypeName: '电力', normalizedUnit: 'kWh', totalNormalizedValue: 100, recordCount: 1 },
  { month: '2026-01', energyTypeCode: 'electricity', energyTypeName: '电力', normalizedUnit: 'kWh', totalNormalizedValue: 120, recordCount: 1 }
];
const selectedEnergyRows = filterDashboardRowsByMonthRange(extendedEnergyRows, selectedDashboardRange);
const baselineEnergyRows = filterDashboardRowsByMonthRange(extendedEnergyRows, baselineDashboardRange);
const selectedEnergySeries = buildEnergyTrendSeries(selectedEnergyRows);
const baselineEnergySeries = buildEnergyTrendSeries(baselineEnergyRows);
const projectedEnergySeries = attachSeriesComparisonRows(selectedEnergySeries, baselineEnergySeries);
assert.deepEqual(selectedEnergySeries[0].rows.map((row) => row.month), ['2026-01'], '年度图表行不得包含上一年基线。');
assert.equal(selectedEnergySeries[0].totalValue, 120, '年度趋势总量不得包含上一年基线。');
assert.equal(projectSeriesChange(projectedEnergySeries[0]).previousMonth, '2025-12', '跨年基线只能进入环比投影。');
assert.equal(projectSeriesChange(projectedEnergySeries[0]).delta, 20);

// 能源月度趋势必须按能源类型与标准单位拆分，禁止 kWh 与 MJ 跨单位合并。
const energySeries = buildEnergyTrendSeries([
  { month: '2026-02', energyTypeCode: 'electricity', energyTypeName: '电力', normalizedUnit: 'kWh', totalNormalizedValue: 20, recordCount: 2 },
  { month: '2026-01', energyTypeCode: 'electricity', energyTypeName: '电力', normalizedUnit: 'kWh', totalNormalizedValue: 10, recordCount: 1 },
  { month: '2026-01', energyTypeCode: 'heat', energyTypeName: '热力', normalizedUnit: 'MJ', totalNormalizedValue: 30, recordCount: 3 }
]);
assert.equal(energySeries.length, 2);
assert.deepEqual(energySeries.find((series) => series.normalizedUnit === 'kWh').rows.map((row) => row.month), ['2026-01', '2026-02']);
assert.equal(energySeries.find((series) => series.normalizedUnit === 'kWh').totalValue, 30);
assert.equal(energySeries.find((series) => series.normalizedUnit === 'MJ').totalValue, 30);

// 能源结构和碳排统计都必须按各自单位安全分组。
const energyGroups = groupEnergyRowsByUnit([
  { normalizedUnit: 'kWh', totalNormalizedValue: 12, recordCount: 2 },
  { normalizedUnit: 'kWh', totalNormalizedValue: 8, recordCount: 1 },
  { normalizedUnit: 'MJ', totalNormalizedValue: 4, recordCount: 1 }
]);
assert.deepEqual(energyGroups.map((group) => [group.unit, group.totalValue]), [['kWh', 20], ['MJ', 4]]);
const carbonGroups = groupCarbonRowsByUnit([
  { emissionUnit: 'kgCO2e', totalEmissionValue: 5, emissionRecordCount: 2 },
  { emissionUnit: 'tCO2e', totalEmissionValue: 1, emissionRecordCount: 1 }
]);
assert.deepEqual(carbonGroups.map((group) => [group.unit, group.totalValue]), [['kgCO2e', 5], ['tCO2e', 1]]);

// 全部记录缺失因子时不得创建零排放单位组或零线趋势。
const missingOnlyCarbon = projectCarbonDashboardStats({
  totalRecords: 2,
  calculatedCount: 0,
  missingFactorCount: 2,
  totalsByEmissionUnit: [{ emissionUnit: 'kgCO2e', totalEmissionValue: 0, emissionRecordCount: 2 }],
  byMonth: [{ normalizedMonth: '2026-01', emissionUnit: 'kgCO2e', totalEmissionValue: 0, emissionRecordCount: 2, calculatedCount: 0, missingFactorCount: 2 }]
});
assert.equal(missingOnlyCarbon.hasOnlyMissingFactors, true);
assert.deepEqual(missingOnlyCarbon.unitGroups, []);
assert.deepEqual(missingOnlyCarbon.trendSeries, []);

// 部分已核算且部分缺失时必须保留真实总量，并排除只有缺失记录的零排放单位。
const partialCarbon = projectCarbonDashboardStats({
  totalRecords: 3,
  calculatedCount: 1,
  missingFactorCount: 2,
  totalsByEmissionUnit: [
    { emissionUnit: 'kgCO2e', totalEmissionValue: 12.5, emissionRecordCount: 2 },
    { emissionUnit: 'tCO2e', totalEmissionValue: 0, emissionRecordCount: 1 }
  ],
  byMonth: [
    { normalizedMonth: '2026-01', emissionUnit: 'kgCO2e', totalEmissionValue: 12.5, emissionRecordCount: 2, calculatedCount: 1, missingFactorCount: 1 },
    { normalizedMonth: '2026-02', emissionUnit: 'tCO2e', totalEmissionValue: 0, emissionRecordCount: 1, calculatedCount: 0, missingFactorCount: 1 }
  ]
});
assert.equal(partialCarbon.hasMissingGap, true);
assert.deepEqual(partialCarbon.unitGroups.map((group) => [group.unit, group.totalValue]), [['kgCO2e', 12.5]]);
assert.deepEqual(partialCarbon.trendSeries.map((series) => [series.normalizedUnit, series.totalValue]), [['kgCO2e', 12.5]]);
assert.equal(partialCarbon.trendSeries[0].rows[0].missingFactorCount, 1);

// 碳排趋势必须按 emissionUnit 隔离、按月份排序，并保留真实零排放结果。
const carbonTrendSeries = buildCarbonTrendSeries([
  { normalizedMonth: '2026-02', emissionUnit: 'kgCO2e', totalEmissionValue: 0, emissionRecordCount: 1, calculatedCount: 1, missingFactorCount: 0 },
  { normalizedMonth: '2026-01', emissionUnit: 'kgCO2e', totalEmissionValue: 8, emissionRecordCount: 2, calculatedCount: 1, missingFactorCount: 1 },
  { normalizedMonth: '2026-01', emissionUnit: 'tCO2e', totalEmissionValue: 0.01, emissionRecordCount: 1, calculatedCount: 1, missingFactorCount: 0 }
]);
assert.equal(carbonTrendSeries.length, 2);
assert.deepEqual(carbonTrendSeries.find((series) => series.normalizedUnit === 'kgCO2e').rows.map((row) => [row.month, row.totalNormalizedValue]), [['2026-01', 8], ['2026-02', 0]]);
assert.equal(carbonTrendSeries.find((series) => series.normalizedUnit === 'tCO2e').totalValue, 0.01);
const currentCarbonProjection = projectCarbonDashboardStats({
  calculatedCount: 1,
  missingFactorCount: 0,
  totalsByEmissionUnit: [{ emissionUnit: 'kgCO2e', totalEmissionValue: 12, emissionRecordCount: 1 }],
  byMonth: [{ normalizedMonth: '2026-01', emissionUnit: 'kgCO2e', totalEmissionValue: 12, emissionRecordCount: 1, calculatedCount: 1, missingFactorCount: 0 }]
});
const baselineCarbonProjection = projectCarbonDashboardStats({
  calculatedCount: 1,
  missingFactorCount: 0,
  totalsByEmissionUnit: [{ emissionUnit: 'kgCO2e', totalEmissionValue: 10, emissionRecordCount: 1 }],
  byMonth: [{ normalizedMonth: '2025-12', emissionUnit: 'kgCO2e', totalEmissionValue: 10, emissionRecordCount: 1, calculatedCount: 1, missingFactorCount: 0 }]
});
const projectedCarbonSeries = attachSeriesComparisonRows(currentCarbonProjection.trendSeries, baselineCarbonProjection.trendSeries);
assert.equal(currentCarbonProjection.unitGroups[0].totalValue, 12, '年度碳排总量不得包含上一年基线。');
assert.deepEqual(projectedCarbonSeries[0].rows.map((row) => row.month), ['2026-01'], '年度碳排图表行不得包含上一年基线。');
assert.equal(projectSeriesChange(projectedCarbonSeries[0]).delta, 2, '上一年十二月只参与碳排环比投影。');

// 沉浸大屏趋势变化必须来自真实有序月份；单点和零基数不得伪造环比百分比。
assert.deepEqual(projectSeriesChange(null), {
  status: 'empty', comparisonStatus: 'empty', latestMonth: '', latestValue: null,
  previousMonth: '', previousValue: null, delta: null, rate: null, direction: 'none'
});
assert.deepEqual(projectSeriesChange({ rows: [{ month: '2026-02', totalNormalizedValue: 15 }] }), {
  status: 'available', comparisonStatus: 'single', latestMonth: '2026-02', latestValue: 15,
  previousMonth: '2026-01', previousValue: null, delta: null, rate: null, direction: 'single'
});
// 非连续月份不得把最近一条有数据记录误称为自然上月，也不得计算伪环比。
const missingPreviousMonthChange = projectSeriesChange({ rows: [
  { month: '2026-01', totalNormalizedValue: 100 },
  { month: '2026-03', totalNormalizedValue: 120 }
] });
assert.equal(missingPreviousMonthChange.comparisonStatus, 'missing-previous-month');
assert.equal(missingPreviousMonthChange.previousMonth, '2026-02');
assert.equal(missingPreviousMonthChange.previousValue, null);
assert.equal(missingPreviousMonthChange.delta, null);
assert.equal(missingPreviousMonthChange.rate, null);
assert.equal(missingPreviousMonthChange.direction, 'missing');
// 年初跨年时，上一年 12 月是自然连续月份。
const crossYearChange = projectSeriesChange({ rows: [
  { month: '2026-01', totalNormalizedValue: 120 },
  { month: '2025-12', totalNormalizedValue: 100 }
] });
assert.equal(crossYearChange.comparisonStatus, 'available');
assert.equal(crossYearChange.previousMonth, '2025-12');
assert.equal(crossYearChange.delta, 20);
const increasingChange = projectSeriesChange({ rows: [
  { month: '2026-02', totalNormalizedValue: 120 },
  { month: '2026-01', totalNormalizedValue: 100 }
] });
assert.equal(increasingChange.latestMonth, '2026-02');
assert.equal(increasingChange.delta, 20);
assert.equal(increasingChange.rate, 20);
assert.equal(increasingChange.direction, 'up');
const zeroBaseChange = projectSeriesChange({ rows: [
  { month: '2026-01', totalNormalizedValue: 0 },
  { month: '2026-02', totalNormalizedValue: 5 }
] });
assert.equal(zeroBaseChange.delta, 5);
assert.equal(zeroBaseChange.rate, null);
assert.equal(zeroBaseChange.direction, 'up');
assert.equal(projectSeriesChange({ rows: [
  { month: '2026-01', totalNormalizedValue: 8 },
  { month: '2026-02', totalNormalizedValue: 8 }
] }).direction, 'flat');
assert.equal(projectSeriesChange({ rows: [
  { month: '2026-01', totalNormalizedValue: 8 },
  { month: '2026-02', totalNormalizedValue: 3 }
] }).direction, 'down');

// 预算投影必须保留各类预警计数并选择最高严重级别。
const budgetProjection = projectBudgetWarningStatus([
  { warningLevel: 'normal' },
  { warningLevel: 'nearing' },
  { warningLevel: 'missing_budget' },
  { warningLevel: 'exceeded' }
]);
assert.equal(budgetProjection.highestLevel, 'exceeded');
assert.equal(budgetProjection.warningCount, 3);
assert.deepEqual(budgetProjection.counts, { normal: 1, nearing: 1, exceeded: 1, missingBudget: 1, unitMismatch: 0 });
assert.deepEqual(budgetProjection.warningRows.map((row) => row.dashboardWarningLevel), ['exceeded', 'missing_budget', 'nearing']);

// 单位不一致必须优先进入不可比较预警，不得归入正常或参与使用率判断。
const mismatchBudgetProjection = projectBudgetWarningStatus([
  { comparisonStatus: 'unit_mismatch', warningLevel: 'normal', isComparable: false, budgetValue: 100, budgetUnit: 'kWh', actualValue: 2, actualUnit: 'MWh', usageRate: null },
  { comparisonStatus: 'comparable', warningLevel: 'normal', isComparable: true, budgetValue: 100, budgetUnit: 'kWh', actualValue: 40, actualUnit: 'kWh', usageRate: 0.4 }
]);
assert.equal(mismatchBudgetProjection.highestLevel, 'unit_mismatch');
assert.equal(mismatchBudgetProjection.warningCount, 1);
assert.deepEqual(mismatchBudgetProjection.counts, { normal: 1, nearing: 0, exceeded: 0, missingBudget: 0, unitMismatch: 1 });
assert.equal(mismatchBudgetProjection.warningRows[0].dashboardWarningLevel, 'unit_mismatch');
assert.equal(mismatchBudgetProjection.warningRows[0].usageRate, null);

// 面板状态必须区分 loading、success、empty、forbidden 和 error。
assert.equal(createDashboardPanelState(DASHBOARD_PANEL_STATUS.LOADING).status, 'loading');
assert.equal(settleDashboardPanelSuccess([], true).status, 'empty');
assert.equal(settleDashboardPanelSuccess([1], false).status, 'success');
assert.equal(createDashboardPanelState(DASHBOARD_PANEL_STATUS.FORBIDDEN).status, 'forbidden');
assert.equal(createDashboardPanelState(DASHBOARD_PANEL_STATUS.ERROR, null, '失败').error, '失败');

// 摘要领域必须消费服务端明确授权元数据，缺字段或未知状态不得伪装成成功。
assert.equal(resolveDashboardSummaryDomainState({ authorized: false, status: 'forbidden' }).status, 'forbidden');
assert.equal(resolveDashboardSummaryDomainState({ authorized: true, status: 'available' }).status, 'success');
assert.equal(resolveDashboardSummaryDomainState({ authorized: true, status: 'empty' }).status, 'empty');
assert.equal(resolveDashboardSummaryDomainState({ status: 'available' }).status, 'error');
assert.equal(resolveDashboardSummaryDomainState({ status: 'available' }).error, '中控摘要缺少明确的领域授权状态。');
assert.equal(resolveDashboardSummaryDomainState({ authorized: true, status: 'unknown' }).status, 'error');
assert.equal(resolveDashboardSummaryDomainState({ authorized: true, status: 'unknown' }).error, '中控摘要返回了无法识别的领域状态。');

// 请求版本必须严格匹配；零值比例不得伪造最小可视值。
assert.equal(isLatestDashboardRequest(3, 3), true);
assert.equal(isLatestDashboardRequest(2, 3), false);
assert.equal(calculateZeroSafePercentage(0, 100), 0);
assert.equal(calculateZeroSafePercentage(25, 100), 25);
assert.equal(calculateZeroSafePercentage(200, 100), 100);
assert.equal(calculateZeroSafePercentage('bad', 100), 0);
// 碳排格式必须保留足够精度，极小非零值不得显示成精确 0；能源仍按原有最多两位小数展示。
assert.match(formatDashboardMeasurement(0.00001, { kind: 'carbon' }), /0\.00001/);
assert.notEqual(formatDashboardMeasurement(0.000000001, { kind: 'carbon' }), '0');
assert.equal(formatDashboardMeasurement(12.3456, { kind: 'energy', maximumFractionDigits: 2 }), '12.35');
assert.equal(formatDashboardPercentage(0.001), '<0.1%', '极小非零变化率不得显示为 0.0%。');
assert.equal(formatDashboardPercentage(0.00001, { maximumFractionDigits: 4 }), '<0.0001%', '极小非零占比不得显示为 0%。');
assert.equal(resolveTrendAxisMaximum([{ totalNormalizedValue: 0.000001 }]), 0.000001, '非零极小趋势轴不得被抬高到 1。');
assert.equal(resolveTrendAxisMaximum([{ totalNormalizedValue: 0 }, { totalNormalizedValue: 0 }]), 1, '真实全零趋势轴才回退到 1。');

// 园区场景状态必须聚合五个真实面板，局部失败或无权限不得伪装为整体成功。
assert.deepEqual(projectDashboardSceneState([
  { status: 'loading' }, { status: 'success' }, { status: 'success' }, { status: 'empty' }, { status: 'success' }
]), { status: 'loading', description: '正在汇总已授权的真实业务面板状态。' });
assert.equal(projectDashboardSceneState(Array.from({ length: 5 }, () => ({ status: 'success' }))).status, 'success');
assert.equal(projectDashboardSceneState(Array.from({ length: 5 }, () => ({ status: 'empty' }))).status, 'empty');
assert.equal(projectDashboardSceneState(Array.from({ length: 5 }, () => ({ status: 'forbidden' }))).status, 'forbidden');
assert.equal(projectDashboardSceneState(Array.from({ length: 5 }, () => ({ status: 'error' }))).status, 'error');
const partialScene = projectDashboardSceneState([
  { status: 'success' }, { status: 'empty' }, { status: 'forbidden' }, { status: 'error' }, { status: 'success' }
]);
assert.equal(partialScene.status, 'partial');
assert.match(partialScene.description, /2 个面板读取失败或无权限/);
const unavailableMixedScene = projectDashboardSceneState([
  { status: 'error' }, { status: 'forbidden' }, { status: 'error' }, { status: 'forbidden' }, { status: 'error' }
]);
assert.equal(unavailableMixedScene.status, 'partial');
assert.match(unavailableMixedScene.description, /当前没有可汇总\/展示的真实业务数据/);
assert.match(unavailableMixedScene.description, /3 个面板读取失败/);
assert.match(unavailableMixedScene.description, /2 个面板无权限/);
assert.doesNotMatch(unavailableMixedScene.description, /已汇总部分真实业务数据/);
// empty 与不可用面板混合但没有 success 时，不得把空响应表述为已汇总真实业务数据。
const emptyUnavailableMixedScene = projectDashboardSceneState([
  { status: 'empty' }, { status: 'empty' }, { status: 'error' }, { status: 'forbidden' }, { status: 'empty' }
]);
assert.equal(emptyUnavailableMixedScene.status, 'partial');
assert.match(emptyUnavailableMixedScene.description, /当前没有可汇总\/展示的真实业务数据/);
assert.match(emptyUnavailableMixedScene.description, /3 个面板暂无数据/);
assert.match(emptyUnavailableMixedScene.description, /1 个面板读取失败/);
assert.match(emptyUnavailableMixedScene.description, /1 个面板无权限/);
assert.doesNotMatch(emptyUnavailableMixedScene.description, /已汇总部分真实业务数据/);
for (const unavailableStatus of ['error', 'forbidden']) {
  const emptySingleUnavailableScene = projectDashboardSceneState([
    { status: 'empty' }, { status: 'empty' }, { status: unavailableStatus }
  ]);
  assert.equal(emptySingleUnavailableScene.status, 'partial');
  assert.match(emptySingleUnavailableScene.description, /当前没有可汇总\/展示的真实业务数据/);
  assert.match(emptySingleUnavailableScene.description, /2 个面板暂无数据/);
  assert.match(emptySingleUnavailableScene.description, new RegExp(unavailableStatus === 'error' ? '1 个面板读取失败' : '1 个面板无权限'));
  assert.doesNotMatch(emptySingleUnavailableScene.description, /已汇总部分真实业务数据/);
}
assert.equal(projectDashboardSceneState([
  { status: 'success' }, { status: 'empty' }, { status: 'success' }, { status: 'success' }, { status: 'empty' }
]).status, 'success');

console.log('dashboardCockpit.test.mjs passed');
