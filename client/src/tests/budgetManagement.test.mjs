import assert from 'node:assert/strict';
import { buildBudgetFilters, buildBudgetImportExecutePayload, nextBudgetStatus, totalsByUnitLabel } from '../utils/budgetManagement.js';

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

console.log('budgetManagement.test.mjs passed');
