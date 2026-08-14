import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENERGY_BALANCE_IMPORT_CONFIRM_TEXT,
  buildEnergyBalanceBundleExecutePayload,
  canExecuteEnergyBalanceBundleImport
} from '../utils/energyBalanceManagement.js';

// 静态读取平衡 API、页面、服务与路由契约。
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = (relativePath) => readFile(resolve(currentDirectory, relativePath), 'utf8');
const [apiSource, pageSource, logicSource, routeSource, serviceSource, indexSource] = await Promise.all([
  source('../api/energyBalances.js'),
  source('../views/energy/balances/index.vue'),
  source('../utils/energyBalanceManagement.js'),
  source('../../../server/src/routes/energyBalanceImports.js'),
  source('../../../server/src/services/energyBalanceImportService.js'),
  source('../../../server/src/index.js')
]);

// API 必须复用共享 HTTP 且只允许双工作表 XLSX。
assert(apiSource.includes("import { download, query, request } from '@/api/http';"));
assert(!apiSource.includes('axios.create'));
for (const endpoint of [
  '/templates/energy-balance-configs.xlsx',
  '/templates/demo-park/25-energy-balance-configs.xlsx',
  '/energy-balance-imports',
  '/bundle/preview',
  '/bundle/execute'
]) assert(apiSource.includes(endpoint), `平衡 API 应包含 ${endpoint}`);
assert(apiSource.includes("data.append('file', file)"), 'preview 上传字段必须固定为 file。');

// 页面必须声明权限、固定确认和非联动边界。
for (const permission of ['energy:balance:import:preview', 'energy:balance:import:execute']) {
  assert(logicSource.includes(permission), `平衡权限定义应包含 ${permission}`);
}
assert(logicSource.includes('确认导入平衡边界及九角色项目'), '逻辑层必须冻结固定中文确认文本。');
for (const text of [
  '不会自动执行平衡计算',
  '不会自动生成优化建议',
  '不会修改能耗记录',
  '发电记录',
  '预算',
  '碳排记录'
]) assert(pageSource.includes(text), `页面必须展示非联动提示：${text}`);
assert(pageSource.includes('await loadBoundaries();'), 'execute 成功后应刷新边界列表。');
assert(!pageSource.includes('await calculateEnergyBalanceSnapshots'), '导入成功不得自动执行平衡计算。');
assert(pageSource.includes('balanceImportPreview.value = null'), '重新选择和执行完成时必须清空旧 preview。');
assert(pageSource.includes('balanceImportFile.value !== selectedFile'), 'preview 响应必须绑定当前文件。');

// 最小 execute 正文不能携带服务端见证字段。
const payload = buildEnergyBalanceBundleExecutePayload({ boundaryBatchId: 11, itemBatchId: 12 }, ENERGY_BALANCE_IMPORT_CONFIRM_TEXT);
assert.deepStrictEqual(payload, {
  boundaryBatchId: 11,
  itemBatchId: 12,
  confirmText: ENERGY_BALANCE_IMPORT_CONFIRM_TEXT,
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
for (const forbidden of ['candidateRows', 'candidateRowIds', 'previewSignature', 'fileSha256', 'previewAuditDigest', 'uploadGroupId']) {
  assert(!Object.prototype.hasOwnProperty.call(payload, forbidden), `execute 正文不得提交 ${forbidden}`);
}

// 空、失效、阻断或候选不完整的 preview 一律不可执行。
assert.strictEqual(canExecuteEnergyBalanceBundleImport(null), false);
assert.strictEqual(canExecuteEnergyBalanceBundleImport({}), false);
assert.strictEqual(canExecuteEnergyBalanceBundleImport({
  boundaryBatchId: 1, itemBatchId: 2, uploadGroupId: 'g', previewSignature: 's', previewAuditDigest: 'd',
  expectedWouldImport: 1, summary: { wouldImport: 1, blocked: 1 }, candidateRows: [{}], candidateRowIds: ['a']
}), false);
assert.strictEqual(canExecuteEnergyBalanceBundleImport({
  boundaryBatchId: 1, itemBatchId: 2, uploadGroupId: 'g', previewSignature: 's', previewAuditDigest: 'd',
  expectedWouldImport: 1, summary: { wouldImport: 1, blocked: 0 }, candidateRows: [{}], candidateRowIds: ['a']
}), true);

// 后端必须固定精确工作表、配对批次、安全中间件顺序和原子执行契约。
for (const contract of [
  "sheetName: '平衡边界'",
  "sheetName: '九角色项目'",
  "importType: 'energy_balance_boundary'",
  "importType: 'energy_balance_item'",
  'BEGIN IMMEDIATE',
  "skipCheckpoint: true",
  "createBalanceBoundary",
  "createBalanceItem",
  'validateBalanceBundleMetadata',
  'buildEnergyBalanceBundleImportPreview'
]) assert(serviceSource.includes(contract), `服务应包含 ${contract}`);
assert(routeSource.indexOf('authenticate,') < routeSource.indexOf('requirePermission(ENERGY_BALANCE_IMPORT_PERMISSIONS.execute)'));
assert(routeSource.indexOf('requirePermission(ENERGY_BALANCE_IMPORT_PERMISSIONS.execute)') < routeSource.indexOf("requireWritable('energy-balance:bundle-import-execute')"));
assert(routeSource.indexOf("requireWritable('energy-balance:bundle-import-execute')") < routeSource.indexOf('parseExecuteJsonBody,'));
assert(indexSource.indexOf("app.use('/api/energy-balance-imports'") < indexSource.indexOf("app.use(express.json({ limit: '2mb' }))"), '平衡导入路由必须在全局 JSON parser 之前挂载。');

console.log('energyBalanceImportContract.test.mjs passed');
