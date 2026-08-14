import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankForm, buildControlledExecutePayload, buildLedgerFilters, canExecutePreview, chartRows, nextLedgerStatus } from '../utils/ledgerManagement.js';
assert.deepEqual(buildLedgerFilters({ keyword: '仪表', status: '', monthStart: '2026-01' }, { page: 2, pageSize: 20 }), { keyword: '仪表', monthStart: '2026-01', page: 2, pageSize: 20 });
assert.equal(nextLedgerStatus('active'), 'inactive'); assert.equal(nextLedgerStatus('active', true), 'void');
assert.deepEqual(chartRows([{ unitType: 'department', total: '3' }], 'unitType', 'total'), [{ label: 'department', value: 3, color: '#2a78d6' }]);
const preview = { batchId: 9, confirmText: '确认导入发电自用记录', previewSignature: 'sig', summary: { wouldImport: 1 }, candidateRowIds: [2], candidateRows: [{ rowNumber: 2 }] };
assert.equal(canExecutePreview(preview), true); assert.deepEqual(buildControlledExecutePayload(preview, 'generation').candidateRowIds, [2]);
const productionUnitPreview = { batchId: 11, confirmText: '确认导入产能单元', previewSignature: 'unit-sig', summary: { wouldImport: 2 }, candidateRowIds: [2, 4], candidateRows: [{ rowNumber: 2, unitCode: 'PU-001' }, { rowNumber: 4, unitCode: 'PU-002' }] };
assert.equal(canExecutePreview(productionUnitPreview), true); assert.deepEqual(buildControlledExecutePayload(productionUnitPreview, 'production').candidateRows.map((row) => row.unitCode), ['PU-001', 'PU-002']);
const generation = { confirmText: '确认由抄表生成能耗记录', previewSignature: 'sig', summary: { wouldGenerate: 2 }, candidateReadingIds: [3, 5], filters: { monthStart: '2026-01' } };
assert.equal(canExecutePreview(generation, 'reading-generation'), true); assert.deepEqual(buildControlledExecutePayload(generation, 'reading-generation').candidateReadingIds, [3, 5]);
assert.equal(canExecutePreview(null), false, '导入预演空状态不得读取 previewSignature。');
assert.equal(canExecutePreview(null, 'reading-generation'), false, '抄表生成预演空状态不得读取 previewSignature。');
assert.equal(blankForm('productionOutputs').recordStatus, 'active');
const ledgerApiSource = readFileSync(new URL('../api/ledger.js', import.meta.url), 'utf8');
['/production/units/import/preview', '/production/units/import/execute', '/production/units/export', "template('production-units', '产能单元')"].forEach((contract) => assert.ok(ledgerApiSource.includes(contract), `missing production-unit API contract: ${contract}`));
for (const artifactKey of ['01-organization-root', '02-organization-departments', '03-organization-process-equipment', '04-meters', '05-production-units', '06-production-outputs', '08-meter-readings-2026-08', '09-generation-records']) assert.match(ledgerApiSource, new RegExp(`/templates/demo-park/${artifactKey}\\.xlsx|${artifactKey}`), `缺少青岚台账示例 ${artifactKey}`);

// 六个台账二级路由必须绑定实际页面，并由 Shell 的路由出口在导航切换时保留可读错误态。
const routerSource = readFileSync(new URL('../router/index.js', import.meta.url), 'utf8');
[
  "'ledger/organization/index': OrganizationUnits",
  "'ledger/meters/index': Meters",
  "'ledger/meter-readings/index': MeterReadings",
  "'ledger/generation/index': Generation",
  "'ledger/production-units/index': ProductionUnits",
  "'ledger/production-output/index': ProductionOutputs"
].forEach((contract) => assert.ok(routerSource.includes(contract), `missing ledger route component map: ${contract}`));
[
  ['OrganizationUnits.vue', 'units'], ['Meters.vue', 'meters'], ['MeterReadings.vue', 'readings'],
  ['Generation.vue', 'generation'], ['ProductionUnits.vue', 'productionUnits'], ['ProductionOutputs.vue', 'productionOutputs']
].forEach(([filename, kind]) => {
  const pageSource = readFileSync(new URL(`../views/ledger/${filename}`, import.meta.url), 'utf8');
  assert.match(pageSource, new RegExp(`<LedgerManagement kind="${kind}"`));
});
const layoutSource = readFileSync(new URL('../layouts/DefaultLayout.vue', import.meta.url), 'utf8');
assert.match(layoutSource, /<router-view v-slot="\{ Component \}">/);
assert.match(layoutSource, /<RouteErrorBoundary :route-key="route\.fullPath">/);

// 台账月份筛选和 render-prop 日期控件必须显式支持键盘输入，并保持原字符串 model。
const ledgerPageSource = readFileSync(new URL('../views/ledger/LedgerManagement.vue', import.meta.url), 'utf8');
for (const permission of ['ledger:units:import', 'ledger:meters:import', 'ledger:production:import', 'ledger:production:preview', 'ledger:readings:import', 'ledger:generation:preview']) assert.match(ledgerPageSource, new RegExp(`demoPermission:'${permission}'`), `青岚示例缺少 manifest 权限 ${permission}`);
for (const buttonText of ['1. 青岚园区示例：根级组织', '2. 青岚园区示例：部门/车间', '3. 青岚园区示例：工序/设备', '青岚园区示例：计量器具', '青岚园区示例：产能单元', '青岚园区示例：月度产量', '青岚园区示例：2026-08 抄表', '青岚园区示例：发电自用']) assert.ok(ledgerPageSource.includes(buttonText), `页面缺少按钮 ${buttonText}`);
assert.match(ledgerPageSource, /根级→部门\/车间→工序\/设备顺序导入/);
assert.match(ledgerPageSource, /async function downloadDemoExample\(item\)[\s\S]*?青岚园区示例下载失败/);
for (const fieldName of ['draft.monthStart', 'draft.monthEnd']) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(ledgerPageSource, new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`));
}
assert.match(ledgerPageSource, /const FormMonth\s*=\s*defineComponent\([\s\S]*?type\s*:\s*'month',[\s\S]*?valueFormat\s*:\s*'YYYY-MM',[\s\S]*?format\s*:\s*'YYYY-MM',[\s\S]*?editable\s*:\s*true[\s\S]*?const FormDate\s*=\s*defineComponent/);
assert.match(ledgerPageSource, /const FormDate\s*=\s*defineComponent\([\s\S]*?type\s*:\s*'date',[\s\S]*?valueFormat\s*:\s*'YYYY-MM-DD',[\s\S]*?format\s*:\s*'YYYY-MM-DD',[\s\S]*?editable\s*:\s*true[\s\S]*?const ActiveStatus\s*=\s*defineComponent/);
console.log('ledger management logic tests passed');
