import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildImportBatchFilters, canUseGenericImportBatchDelete, chartPercentage, compactFieldMapping, dashboardScopeNotice, IMPORT_BATCH_TYPE_OPTIONS, projectBootstrapInfo } from '../utils/specialModules.js';

// 导入批次筛选仅保留服务端允许的有效参数。
assert.deepEqual(buildImportBatchFilters({ importType: 'energy_record', status: '', fileType: 'xlsx' }, { page: 2, pageSize: 50 }), {
  importType: 'energy_record', fileType: 'xlsx', page: 2, pageSize: 50
});

// 下拉选项 value 必须与服务端 importType query 完全一致，label 只用于选中后的可见文本。
assert.deepEqual(IMPORT_BATCH_TYPE_OPTIONS.map((item) => item.value), [
  'energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_output', 'generation_record'
]);
assert.equal(IMPORT_BATCH_TYPE_OPTIONS.find((item) => item.value === 'meter_reading').label, '计量抄表导入');
const importCenterSource = readFileSync(new URL('../views/imports/ImportCenter.vue', import.meta.url), 'utf8');
assert.match(importCenterSource, /v-model="draftFilters\.importType"/);
assert.match(importCenterSource, /:label="item\.label" :value="item\.value"/);
assert.match(importCenterSource, /importTypes = IMPORT_BATCH_TYPE_OPTIONS/);

// 通用批次删除不能误放行领域维护的导入追溯链路。
assert.equal(canUseGenericImportBatchDelete({ importType: 'energy_record' }), true);
assert.equal(canUseGenericImportBatchDelete({ importType: 'meter_reading' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'production_output' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'generation_record' }), false);

// 映射值和图表比例不得引入空字段或伪造零值。
assert.deepEqual(compactFieldMapping({ period: '月份', value: ' ', ' ': '数值' }), { period: '月份' });
assert.equal(chartPercentage(0, 100), 0);
assert.equal(chartPercentage(-1, 100), 0);
assert.equal(chartPercentage(25, 100), 25);
assert.equal(chartPercentage(250, 100), 100);

// 系统启动信息投影不得把服务端路径暴露给页面。
const projected = projectBootstrapInfo({
  appName: '测试平台',
  database: { storage: 'local-file', databasePath: 'D:/private/energy.sqlite', backupsDir: 'D:/private/backups' },
  maintenance: { active: true, reason: 'backups:restore' },
  nextCapabilities: ['backup-restore', 1]
});
assert.deepEqual(projected, { appName: '测试平台', mode: 'local-file', maintenanceActive: true, maintenanceReason: 'backups:restore', capabilities: ['backup-restore'] });
assert.equal(JSON.stringify(projected).includes('D:/private'), false);
assert.match(dashboardScopeNotice({ scope: 'energy-records-and-imports-only', excludes: ['carbon-accounting'] }), /不包含 carbon-accounting/);

// 下载响应头缺失时也必须使用中文业务文件名，不能回退到内部技术前缀。
const httpSource = readFileSync(new URL('../api/http.js', import.meta.url), 'utf8');
const energyApiSource = readFileSync(new URL('../api/energy.js', import.meta.url), 'utf8');
const importsApiSource = readFileSync(new URL('../api/imports.js', import.meta.url), 'utf8');
const legacyMainSource = readFileSync(new URL('../legacy-main.js', import.meta.url), 'utf8');
assert.match(httpSource, /fallbackName = '下载文件'/);
assert.match(energyApiSource, /'历史能耗台账回填预演审计预案\.xlsx'/);
assert.doesNotMatch(energyApiSource, /energy-records-台账回填/);
assert.match(importsApiSource, /`导入批次原文件-\$\{batchId\}`/);
assert.doesNotMatch(importsApiSource, /`import-batch-\$\{batchId\}`/);
assert.match(legacyMainSource, /'导入模板\.xlsx'/);
assert.match(legacyMainSource, /'历史能耗台账回填预演审计预案\.xlsx'/);
assert.doesNotMatch(legacyMainSource, /energy-records-台账回填预演审计预案/);

console.log('special module helper tests passed');
