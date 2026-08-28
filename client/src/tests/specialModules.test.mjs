import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  availableImportBatchTypeOptions,
  buildImportBatchDeleteConfirmation,
  buildImportBatchDeleteSuccessMessage,
  buildImportBatchFilters,
  buildImportOriginalFileFallbackName,
  canDownloadImportBatchSource,
  canUseGenericImportBatchDelete,
  chartPercentage,
  compactFieldMapping,
  dashboardScopeNotice,
  filterVisibleImportBatches,
  IMPORT_BATCH_TYPE_OPTIONS,
  projectBootstrapInfo
} from '../utils/specialModules.js';

// 导入批次筛选仅保留服务端允许的有效参数。
assert.deepEqual(buildImportBatchFilters({ importType: 'energy_record', status: '', fileType: 'xlsx' }, { page: 2, pageSize: 50 }), {
  importType: 'energy_record', fileType: 'xlsx', page: 2, pageSize: 50
});

// 下拉选项 value 必须与服务端 importType query 完全一致，label 只用于选中后的可见文本。
assert.deepEqual(IMPORT_BATCH_TYPE_OPTIONS.map((item) => item.value), [
  'energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_output', 'generation_record', 'supplier', 'carbon_emission_report', 'ghg_report'
]);
assert.equal(IMPORT_BATCH_TYPE_OPTIONS.find((item) => item.value === 'supplier').label, '供应商台账导入');
assert.equal(IMPORT_BATCH_TYPE_OPTIONS.find((item) => item.value === 'meter_reading').label, '计量抄表导入');
assert.equal(IMPORT_BATCH_TYPE_OPTIONS.find((item) => item.value === 'carbon_emission_report').label, '碳排放报告导入');
assert.equal(IMPORT_BATCH_TYPE_OPTIONS.find((item) => item.value === 'ghg_report').label, '温室气体报告导入');
assert.equal(availableImportBatchTypeOptions(false, false).some((item) => item.value === 'carbon_emission_report'), false, '无 N6 view 权限不得显示 N6 报告批次筛选。');
assert.equal(availableImportBatchTypeOptions(false, false).some((item) => item.value === 'ghg_report'), false, '无 N7 view 权限不得显示 N7 报告批次筛选。');
assert.equal(availableImportBatchTypeOptions(true, false).some((item) => item.value === 'carbon_emission_report'), true);
assert.equal(availableImportBatchTypeOptions(true, false).some((item) => item.value === 'ghg_report'), false, 'N6 view 不得放行 N7 批次。');
assert.equal(availableImportBatchTypeOptions(false, true).some((item) => item.value === 'carbon_emission_report'), false, 'N7 view 不得放行 N6 批次。');
assert.equal(availableImportBatchTypeOptions(false, true).some((item) => item.value === 'ghg_report'), true);
const mixedBatches = [{ id: 1, importType: 'energy_record' }, { id: 2, importType: 'carbon_emission_report' }, { id: 3, importType: 'ghg_report' }];
assert.deepEqual(filterVisibleImportBatches(mixedBatches, false, false).map((row) => row.id), [1]);
assert.deepEqual(filterVisibleImportBatches(mixedBatches, true, false).map((row) => row.id), [1, 2]);
assert.deepEqual(filterVisibleImportBatches(mixedBatches, false, true).map((row) => row.id), [1, 3]);
assert.deepEqual(filterVisibleImportBatches(mixedBatches, true, true).map((row) => row.id), [1, 2, 3]);
assert.equal(canDownloadImportBatchSource(mixedBatches[0], { canDownload: true, canExportCarbonEmissionReports: false, canExportGhgReports: false }), true);
assert.equal(canDownloadImportBatchSource(mixedBatches[1], { canDownload: true, canExportCarbonEmissionReports: false, canExportGhgReports: true }), false, 'N7 export 不得放行 N6 原文件。');
assert.equal(canDownloadImportBatchSource(mixedBatches[1], { canDownload: true, canExportCarbonEmissionReports: true, canExportGhgReports: false }), true);
assert.equal(canDownloadImportBatchSource(mixedBatches[2], { canDownload: true, canExportCarbonEmissionReports: true, canExportGhgReports: false }), false, 'N6 export 不得放行 N7 原文件。');
assert.equal(canDownloadImportBatchSource(mixedBatches[2], { canDownload: true, canExportCarbonEmissionReports: false, canExportGhgReports: true }), true);
assert.equal(canDownloadImportBatchSource(mixedBatches[2], { canDownload: false, canExportGhgReports: true }), false);
const importCenterSource = readFileSync(new URL('../views/imports/ImportCenter.vue', import.meta.url), 'utf8');
assert.match(importCenterSource, /v-model="draftFilters\.importType"/);
assert.match(importCenterSource, /:label="item\.label" :value="item\.value"/);
assert.match(importCenterSource, /availableImportBatchTypeOptions\(canViewCarbonEmissionReports\.value, canViewGhgReports\.value\)/);
assert.match(importCenterSource, /filterVisibleImportBatches\(result\.value\.data, canViewCarbonEmissionReports\.value, canViewGhgReports\.value\)/);
assert.match(importCenterSource, /canDownloadImportBatchSource\(row/);
assert.match(importCenterSource, /hasPermi\('carbon:emission-reports:view'\)/);
assert.match(importCenterSource, /hasPermi\('carbon:emission-reports:export'\)/);
assert.match(importCenterSource, /hasPermi\('carbon:ghg-reports:view'\)/);
assert.match(importCenterSource, /hasPermi\('carbon:ghg-reports:export'\)/);

// 通用批次删除不能误放行领域维护的导入追溯链路。
assert.equal(canUseGenericImportBatchDelete({ importType: 'energy_record' }), true);
assert.equal(canUseGenericImportBatchDelete({ importType: 'meter_reading' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'production_output' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'generation_record' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'supplier' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'carbon_emission_report' }), false);
assert.equal(canUseGenericImportBatchDelete({ importType: 'ghg_report' }), false);
assert.equal(canUseGenericImportBatchDelete({}), false);

// 删除确认必须显示批次、原文件、预计影响、旧碳同步删除、强制备份和预测非联动边界。
const deleteConfirmation = buildImportBatchDeleteConfirmation({
  id: 27,
  importType: 'energy_record',
  displayFilename: '八月能耗.xlsx',
  successCount: 12
});
assert.match(deleteConfirmation, /批次 ID：#27/);
assert.match(deleteConfirmation, /原文件名：八月能耗\.xlsx/);
assert.match(deleteConfirmation, /预计影响能耗记录：12 条/);
assert.match(deleteConfirmation, /关联旧碳排结果将同步删除/);
assert.match(deleteConfirmation, /预测运行和预测结果不会自动删除/);
assert.match(deleteConfirmation, /强制创建 SQLite 备份/);
assert.match(deleteConfirmation, /上传原文件不会/);
const deleteSuccessMessage = buildImportBatchDeleteSuccessMessage({
  deletedEnergyRecords: 11,
  deletedCarbonEmissions: 8,
  backup: { backupName: 'energy-carbon-import-batch-delete-test.sqlite', path: 'D:/private/not-visible.sqlite' }
});
assert.match(deleteSuccessMessage, /能耗记录 11 条/);
assert.match(deleteSuccessMessage, /关联旧碳结果 8 条/);
assert.match(deleteSuccessMessage, /energy-carbon-import-batch-delete-test\.sqlite/);
assert.equal(deleteSuccessMessage.includes('D:/private'), false);
assert.match(importCenterSource, /buildImportBatchDeleteConfirmation\(row\)/);
assert.match(importCenterSource, /buildImportBatchDeleteSuccessMessage\(result\.value\.data \|\| \{\}\)/);
assert.match(importCenterSource, /await loadBatches\(\)/);

// 原文件下载缺少响应文件名时，中文兜底必须保留批次编号和响应对应的原扩展名。
assert.equal(buildImportOriginalFileFallbackName(17, 'text/csv; charset=utf-8'), '导入批次原文件-17.csv');
assert.equal(buildImportOriginalFileFallbackName(18, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), '导入批次原文件-18.xlsx');
assert.equal(buildImportOriginalFileFallbackName(19, 'application/vnd.ms-excel'), '导入批次原文件-19.xls');
assert.equal(buildImportOriginalFileFallbackName(20, 'application/octet-stream'), '导入批次原文件-20');

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
assert.match(httpSource, /if \(encoded\) \{ try \{ return decodeURIComponent\(encoded\); \} catch \{\} \}/);
assert.doesNotMatch(httpSource, /catch \{ return encoded; \}/);
assert.match(httpSource, /typeof fallbackName === 'function' \? fallbackName\(response\) : fallbackName/);
assert.match(httpSource, /filenameFromDisposition\(response\.headers\['content-disposition'\]\) \|\| resolvedFallbackName \|\| '下载文件'/);
assert.match(energyApiSource, /'历史能耗台账回填预演审计预案\.xlsx'/);
assert.doesNotMatch(energyApiSource, /energy-records-台账回填/);
assert.match(importsApiSource, /import \{ buildImportOriginalFileFallbackName \} from '@\/utils\/specialModules'/);
assert.match(importsApiSource, /buildImportOriginalFileFallbackName\(batchId, response\.headers\?\.\['content-type'\]\)/);
assert.match(importsApiSource, /`能耗数据导入模板\.\$\{safeExtension\}`/);
assert.match(importsApiSource, /\/templates\/demo-park\/07-monthly-energy\.xlsx/);
assert.doesNotMatch(importCenterSource, /canDemoExample|demoExampleLoading|downloadMonthlyEnergyDemoParkExample|天坤集团示例/);
assert.match(importCenterSource, /下载模板/);
assert.match(importCenterSource, /上传能耗表格/);
assert.doesNotMatch(importsApiSource, /`import-batch-\$\{batchId\}`/);
assert.match(legacyMainSource, /'导入模板\.xlsx'/);
assert.match(legacyMainSource, /'历史能耗台账回填预演审计预案\.xlsx'/);
assert.doesNotMatch(legacyMainSource, /energy-records-台账回填预演审计预案/);

console.log('special module helper tests passed');
