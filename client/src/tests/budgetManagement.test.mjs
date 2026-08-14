import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBudgetFilters, buildBudgetImportExecutePayload, nextBudgetStatus, totalsByUnitLabel } from '../utils/budgetManagement.js';
import { budgetComparisonChartRows, budgetComparisonMetricValue, budgetComparisonStatusLabel, budgetComparisonSummaryLabel, budgetComparisonUnits, isComparableBudgetRow } from '../utils/energyBudgetManagement.js';

assert.deepEqual(
  buildBudgetFilters({ monthStart: '2026-01', monthEnd: '2026-03', energyTypeCode: 'electricity', organizationScope: '生产部', status: 'active', keyword: '年度预算' }, { page: 2, pageSize: 50 }),
  { monthStart: '2026-01', monthEnd: '2026-03', energyTypeCode: 'electricity', organizationScope: '生产部', status: 'active', keyword: '年度预算', page: 2, pageSize: 50 }
);
assert.deepEqual(buildBudgetFilters({ keyword: '' }, { page: 1, pageSize: 20 }), { page: 1, pageSize: 20 });

assert.equal(totalsByUnitLabel([{ unit: 'kWh', budgetValue: 12000 }, { unit: 'MJ', budgetValue: 800 }]), '12,000 kWh；800 MJ');
assert.equal(totalsByUnitLabel([]), '暂无原始预算值');

const executePayload = buildBudgetImportExecutePayload({
  batchId: 6,
  confirmText: '确认导入用能预算',
  previewSignature: 'hmac-sha256:v1:example',
  summary: { wouldImport: 2 },
  candidateRowIds: [2, 5],
  candidateRows: [{ rowNumber: 2 }, { rowNumber: 5 }]
});
assert.deepEqual(executePayload, {
  batchId: 6,
  confirmText: '确认导入用能预算',
  previewSignature: 'hmac-sha256:v1:example',
  expectedWouldImport: 2,
  candidateRowIds: [2, 5],
  candidateRows: [{ rowNumber: 2 }, { rowNumber: 5 }],
  requireBackup: true,
  acknowledgeSkippedRisks: true
});

assert.equal(nextBudgetStatus('active'), 'inactive');
assert.equal(nextBudgetStatus('inactive'), 'active');

// 预算执行样例覆盖可比较、单位不一致和缺少预算三类新契约状态。
const comparisonRows = [
  { id: 1, comparisonStatus: 'comparable', isComparable: true, budgetUnit: 'kWh', actualUnit: 'kWh', budgetValue: 100, actualValue: 90, variance: -10, usageRate: 0.9, warningLabel: '正常' },
  { id: 2, comparisonStatus: 'unit_mismatch', isComparable: false, budgetUnit: 'kWh', actualUnit: 'MWh', budgetValue: 100, actualValue: 0.1, variance: -99.9, usageRate: 0.001, warningLevel: 'unit_mismatch' },
  { id: 3, comparisonStatus: 'missing_budget', isComparable: false, budgetUnit: null, actualUnit: 'MJ', budgetValue: null, actualValue: 30, variance: null, usageRate: null }
];

assert.equal(isComparableBudgetRow(comparisonRows[0]), true);
assert.equal(isComparableBudgetRow(comparisonRows[1]), false);
assert.deepEqual(budgetComparisonUnits(comparisonRows), ['kWh']);
assert.deepEqual(budgetComparisonChartRows(comparisonRows, 'kWh').map((row) => row.id), [1]);
assert.equal(budgetComparisonMetricValue(comparisonRows[1], 'variance'), null);
assert.equal(budgetComparisonMetricValue(comparisonRows[1], 'usageRate'), null);
assert.equal(budgetComparisonStatusLabel(comparisonRows[1]), '单位不一致 / 不可比较');
assert.equal(budgetComparisonStatusLabel(comparisonRows[2]), '缺少预算');

assert.equal(
  budgetComparisonSummaryLabel({
    summaryUnit: null,
    totalBudgetValue: null,
    totalActualValue: null,
    totalsByUnit: [
      { unit: 'kWh', budgetValue: 100, actualValue: 90 },
      { unit: 'MJ', budgetValue: null, actualValue: 30 }
    ]
  }),
  '多单位汇总：kWh（预算 100，实际 90）；MJ（预算 —，实际 30）'
);
assert.equal(
  budgetComparisonSummaryLabel({ summaryUnit: null, totalBudgetValue: null, totalActualValue: null, totalsByUnit: [] }),
  '多单位或无共同单位，不能跨单位合计'
);

// 页面静态契约保证图表和完整状态明细使用不同数据集。
const budgetPageSource = readFileSync(new URL('../views/energy/BudgetManagement.vue', import.meta.url), 'utf8');
const budgetApiSource = readFileSync(new URL('../api/budgets.js', import.meta.url), 'utf8');
assert.match(budgetApiSource, /\/templates\/demo-park\/10-energy-budgets\.xlsx/);
assert.match(budgetPageSource, /v-if="canImport" :loading="demoExampleLoading" @click="downloadDemoExample">下载青岚园区示例/);
assert.match(budgetPageSource, /hasPermi\('energy:budget:import'\)/);
assert.match(budgetPageSource, /青岚园区示例下载失败/);
assert.match(budgetPageSource, /v-for="row in comparisonChartRows"/);
assert.match(budgetPageSource, /:data="comparisonTableRows"/);
assert.match(budgetPageSource, /budgetComparisonBudgetUnit\(row\)/);
assert.match(budgetPageSource, /budgetComparisonActualUnit\(row\)/);
assert.match(budgetPageSource, /单位不一致，已保留在明细中并标记为不可比较/);
for (const fieldName of ['draftFilters.monthStart', 'draftFilters.monthEnd', 'budgetForm.periodMonth']) {
  assert.match(
    budgetPageSource,
    new RegExp(`<el-date-picker(?=[^>]*v-model="${fieldName.replace('.', '\\.')}"(?:\\s|/|>))(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`),
    `${fieldName} 必须使用可下拉、可键盘输入的 YYYY-MM 月份控件。`
  );
}

console.log('budgetManagement.test.mjs passed');
