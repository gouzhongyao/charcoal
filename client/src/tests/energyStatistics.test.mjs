import assert from 'node:assert/strict';
import { aggregateMonthlyTrend, buildEnergyFilters, ENERGY_TYPE_COLORS, fixedEnergyTypeBreakdown } from '../utils/energyStatistics.js';
import { hasPermission } from '../utils/permissionCore.js';

const filters = buildEnergyFilters({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '', energyTypeCode: 'coal', organization: '第一工厂', keyword: '仪表 Alpha', search: '兼容搜索字段' });
assert.deepEqual(filters, { normalizedMonthStart: '2026-01', energyTypeCode: 'coal', organization: '第一工厂', keyword: '仪表 Alpha', search: '兼容搜索字段' });

assert.deepEqual(aggregateMonthlyTrend([
  { month: '2026-02', totalNormalizedValue: 5, recordCount: 1 },
  { month: '2026-01', totalNormalizedValue: 2, recordCount: 1 },
  { month: '2026-02', totalNormalizedValue: 3, recordCount: 2 }
]), [
  { month: '2026-01', totalNormalizedValue: 2, recordCount: 1 },
  { month: '2026-02', totalNormalizedValue: 8, recordCount: 3 }
]);

const breakdown = fixedEnergyTypeBreakdown([
  { energyTypeCode: 'oil', energyTypeName: '油', totalNormalizedValue: 4, recordCount: 1 },
  { energyTypeCode: 'electricity', energyTypeName: '电力', totalNormalizedValue: 8, recordCount: 2 },
  { energyTypeCode: 'biomass', energyTypeName: '生物质', totalNormalizedValue: 3, recordCount: 1 },
  { energyTypeCode: 'hydrogen', energyTypeName: '氢气', totalNormalizedValue: 2, recordCount: 1 }
]);
assert.deepEqual(breakdown.map((row) => row.energyTypeCode), ['electricity', 'oil', 'other']);
assert.equal(breakdown.at(-1).totalNormalizedValue, 5);
assert.equal(Object.keys(ENERGY_TYPE_COLORS).length, 9);

assert.equal(hasPermission('energy:records:ledger-backfill:execute', [], { roleCode: 'super_admin' }), true);
assert.equal(hasPermission('energy:records:export', [], { roles: [{ roleCode: 'super_admin' }] }), true);
assert.equal(hasPermission(['energy:records:view', 'energy-records:view'], ['energy-records:view'], { roleCode: 'user' }), true);
assert.equal(hasPermission(['energy:records:export', 'energy-records:export'], ['energy-records:export'], { roleCode: 'user' }), true);
assert.equal(hasPermission('energy:records:ledger-backfill:execute', ['energy:records:view'], { roleCode: 'user' }), false);

console.log('energyStatistics.test.mjs passed');
