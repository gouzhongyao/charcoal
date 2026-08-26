import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 静态契约覆盖独立页面、API、可信路由映射和导入中心删除保护。
const pageSource = await readFile(new URL('../views/ledger/SupplierManagement.vue', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../api/suppliers.js', import.meta.url), 'utf8');
const utilitySource = await readFile(new URL('../utils/supplierManagement.js', import.meta.url), 'utf8');
const routerSource = await readFile(new URL('../router/index.js', import.meta.url), 'utf8');
const specialModulesSource = await readFile(new URL('../utils/specialModules.js', import.meta.url), 'utf8');

assert.ok(routerSource.includes("import SupplierManagement from '@/views/ledger/SupplierManagement.vue';"));
assert.ok(routerSource.includes("'ledger/suppliers/index': SupplierManagement"));
assert.ok(pageSource.includes('<h2>供应商管理</h2>'));
for (const capability of ['筛选', '分页', '详情', '新增供应商', '编辑供应商', '踢出', '恢复', '下载 Excel v1 模板', '导入预演', '执行导入', '导出']) {
  assert.ok(pageSource.includes(capability), `供应商页面缺少 ${capability} 能力。`);
}
for (const permission of [
  'ledger:suppliers:create',
  'ledger:suppliers:update',
  'ledger:suppliers:status',
  'ledger:suppliers:import:preview',
  'ledger:suppliers:import:execute',
  'ledger:suppliers:export'
]) assert.ok(pageSource.includes(`hasPermi('${permission}')`), `页面缺少权限 ${permission}。`);

// 普通编辑表单不得提供状态编辑；状态单选仅在新增模式显示，载荷固定排除 status。
assert.ok(pageSource.includes('v-if="!editingId" label="初始状态"'));
assert.ok(pageSource.includes('buildSupplierUpdatePayload(supplierForm)'));
assert.match(utilitySource, /function buildSupplierUpdatePayload[\s\S]*?delete payload\.status/);
assert.equal(pageSource.includes('物理删除'), false);
assert.equal(pageSource.includes('删除供应商'), false);

// 联系电话必须使用文本输入并明确保留前导零、符号和分机文本。
assert.ok(pageSource.includes('v-model="supplierForm.contactPhone" type="text"'));
assert.ok(pageSource.includes('前导零、+、空格、连字符和分机文本'));
assert.ok(utilitySource.includes("contactPhone: String(form.contactPhone || '').trim()"));

// 预演必须清楚显示新增、跳过、阻断、警告和错误，执行只提交服务端批次 ID。
for (const label of ['可新增', '跳过', '阻断', '警告', '错误']) assert.ok(pageSource.includes(label), `预演缺少 ${label}。`);
assert.ok(apiSource.includes("data.append('file', file)"));
assert.ok(apiSource.includes("url: `${SUPPLIER_BASE_URL}/imports/preview`"));
assert.ok(apiSource.includes("url: `${SUPPLIER_BASE_URL}/imports/execute`"));
assert.ok(apiSource.includes('batchId,'));
for (const confirmation of ["confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT", 'requireBackup: true', 'acknowledgeSkippedRisks: true']) {
  assert.ok(apiSource.includes(confirmation), `execute 缺少 ${confirmation}。`);
}
assert.equal(apiSource.includes('candidateRows'), false);
assert.equal(apiSource.includes('previewSignature'), false);
assert.equal(apiSource.includes('previewAuditDigest'), false);
assert.equal(/method:\s*['"]delete['"]/.test(apiSource), false);

// 导入中心可筛选 supplier，但通用删除继续只允许 energy_record。
assert.ok(specialModulesSource.includes("value: 'supplier', label: '供应商台账导入'"));
assert.match(specialModulesSource, /canUseGenericImportBatchDelete[\s\S]*?=== 'energy_record'/);

console.log('供应商页面与 API 静态契约测试通过。');
