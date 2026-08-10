import assert from 'node:assert/strict';
import {
  DASHBOARD_PANEL_STATUS,
  buildCarbonTrendSeries,
  buildDashboardYearRange,
  buildEnergyTrendSeries,
  calculateZeroSafePercentage,
  createDashboardPanelState,
  groupCarbonRowsByUnit,
  groupEnergyRowsByUnit,
  isLatestDashboardRequest,
  projectBudgetWarningStatus,
  projectCarbonDashboardStats,
  resolveDashboardSummaryDomainState,
  settleDashboardPanelSuccess
} from '../utils/dashboardCockpit.js';

// 年度范围必须稳定输出完整自然年，并对非法年度回退。
assert.deepEqual(buildDashboardYearRange(2026), {
  year: 2026,
  normalizedMonthStart: '2026-01',
  normalizedMonthEnd: '2026-12'
});
assert.equal(buildDashboardYearRange('invalid', 2025).year, 2025);

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
assert.equal(resolveDashboardSummaryDomainState({ authorized: true, status: 'unknown' }).status, 'error');

// 请求版本必须严格匹配；零值比例不得伪造最小可视值。
assert.equal(isLatestDashboardRequest(3, 3), true);
assert.equal(isLatestDashboardRequest(2, 3), false);
assert.equal(calculateZeroSafePercentage(0, 100), 0);
assert.equal(calculateZeroSafePercentage(25, 100), 25);
assert.equal(calculateZeroSafePercentage(200, 100), 100);
assert.equal(calculateZeroSafePercentage('bad', 100), 0);

console.log('dashboardCockpit.test.mjs passed');
