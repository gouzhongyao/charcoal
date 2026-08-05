import assert from 'node:assert/strict';
import { buildImportBatchFilters, canUseGenericImportBatchDelete, chartPercentage, compactFieldMapping, dashboardScopeNotice, projectBootstrapInfo } from '../utils/specialModules.js';

// 导入批次筛选仅保留服务端允许的有效参数。
assert.deepEqual(buildImportBatchFilters({ importType: 'energy_record', status: '', fileType: 'xlsx' }, { page: 2, pageSize: 50 }), {
  importType: 'energy_record', fileType: 'xlsx', page: 2, pageSize: 50
});

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

console.log('special module helper tests passed');
