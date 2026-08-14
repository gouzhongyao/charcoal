import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCarbonEmissionFilters, buildCarbonFactorFilters, buildCarbonFactorImportExecutePayload, nextCarbonFactorStatus, rowsForEmissionUnit, totalsByEmissionUnitLabel } from '../utils/carbonManagement.js';

assert.deepEqual(
  buildCarbonFactorFilters({ energyTypeCode: 'electricity', region: 'default', factorYear: '2028', status: 'active', keyword: '测试来源' }, { page: 2, pageSize: 50 }),
  { energyTypeCode: 'electricity', region: 'default', factorYear: '2028', status: 'active', keyword: '测试来源', page: 2, pageSize: 50 }
);
assert.deepEqual(buildCarbonFactorFilters({}, { page: 1, pageSize: 20 }), { page: 1, pageSize: 20 });

assert.deepEqual(
  buildCarbonEmissionFilters({ normalizedMonthStart: '2028-01', normalizedMonthEnd: '2028-03', energyTypeCode: 'electricity', organization: '碳统计组织', status: 'calculated', keyword: '厂区' }, { page: 3, pageSize: 100 }),
  { normalizedMonthStart: '2028-01', normalizedMonthEnd: '2028-03', energyTypeCode: 'electricity', organization: '碳统计组织', status: 'calculated', keyword: '厂区', page: 3, pageSize: 100 }
);

const preview = { batchId: 6, confirmText: '确认导入碳因子', previewSignature: 'hmac-sha256:v1:example', summary: { wouldImport: 2 }, candidateRowIds: [2, 5], candidateRows: [{ candidateRowId: 'carbon-factor:2', rowNumber: 2 }, { candidateRowId: 'carbon-factor:5', rowNumber: 5 }] };
assert.deepEqual(buildCarbonFactorImportExecutePayload(preview), {
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

const mixedUnits = [{ emissionUnit: 'kgCO2e', totalEmissionValue: 50 }, { emissionUnit: 'tCO2e', totalEmissionValue: 0.05 }, { emissionUnit: 'kgCO2e', totalEmissionValue: 25 }];
assert.deepEqual(rowsForEmissionUnit(mixedUnits, 'kgCO2e'), [mixedUnits[0], mixedUnits[2]], '图表仅可接收同一排放单位的统计行。');
assert.equal(totalsByEmissionUnitLabel(mixedUnits), '50 kgCO2e；0.05 tCO2e；25 kgCO2e', '汇总卡必须分列展示，不能跨单位相加。');

// 碳因子年份和碳排月份、日期字段必须保留原字符串 model，并显式允许键盘输入。
const carbonPageSource = readFileSync(new URL('../views/carbon/CarbonManagement.vue', import.meta.url), 'utf8');
const carbonApiSource = readFileSync(new URL('../api/carbon.js', import.meta.url), 'utf8');
assert.match(carbonApiSource, /\/templates\/demo-park\/11-carbon-factors\.xlsx/);
assert.match(carbonPageSource, /v-if="canFactorImport" :loading="factorDemoExampleLoading" @click="downloadFactorDemoExample">下载青岚园区示例/);
assert.match(carbonPageSource, /hasPermi\('carbon:factor:import'\)/);
assert.match(carbonPageSource, /不自动计算碳排放/);
assert.match(carbonPageSource, /青岚园区示例下载失败/);
for (const fieldName of ['factorDraftFilters.factorYear', 'factorForm.factorYear']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(
    carbonPageSource,
    new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="year")(?=[^>]*value-format="YYYY")(?=[^>]*format="YYYY")(?=[^>]*clearable)(?=[^>]*:editable="true")[^>]*>`),
    `${fieldName} 必须使用可清空、可编辑的年份选择器。`
  );
}
for (const fieldName of ['factorForm.effectiveFrom', 'factorForm.effectiveTo']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(carbonPageSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="date")(?=[^>]*value-format="YYYY-MM-DD")(?=[^>]*format="YYYY-MM-DD")(?=[^>]*:editable="true")[^>]*>`));
}
for (const fieldName of ['emissionDraftFilters.normalizedMonthStart', 'emissionDraftFilters.normalizedMonthEnd', 'calculateForm.normalizedMonthStart', 'calculateForm.normalizedMonthEnd']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(carbonPageSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`));
}

console.log('carbonManagement.test.mjs passed');
