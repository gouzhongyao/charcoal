import assert from 'node:assert/strict';
import {
  buildSupplierCreatePayload,
  buildSupplierUpdatePayload,
  canExecuteSupplierImport,
  normalizeSupplierImportSummary,
  supplierStatusLabel
} from '../utils/supplierManagement.js';

// 前端状态只展示冻结的 active/inactive 中文名称。
assert.equal(supplierStatusLabel('active'), '合作中');
assert.equal(supplierStatusLabel('inactive'), '已踢出');
assert.equal(supplierStatusLabel('paused'), '未知状态');

// 联系电话按文本保留符号和前导零，不得经过数值转换。
const createPayload = buildSupplierCreatePayload({
  supplierCode: ' SUP-001 ',
  supplierName: ' 测试供应商 ',
  contactPhone: ' 0010 +86-22 转 009 ',
  status: 'inactive'
});
assert.equal(createPayload.contactPhone, '0010 +86-22 转 009');
assert.equal(createPayload.supplierCode, 'SUP-001');
assert.equal(createPayload.status, 'inactive');

// 普通编辑载荷必须固定排除 status，避免前端误走普通编辑接口修改合作状态。
const updatePayload = buildSupplierUpdatePayload({ ...createPayload, status: 'inactive' });
assert.equal(Object.prototype.hasOwnProperty.call(updatePayload, 'status'), false);
assert.equal(updatePayload.contactPhone, '0010 +86-22 转 009');

// 预演汇总缺失值统一投影为零，执行必须同时具备持久批次和可新增行。
assert.deepEqual(normalizeSupplierImportSummary({ wouldImport: '2', skipped: 1 }), {
  totalRows: 0,
  wouldImport: 2,
  skipped: 1,
  blocked: 0,
  warnings: 0,
  errors: 0
});
assert.equal(canExecuteSupplierImport({ batchId: 7, summary: { wouldImport: 1 } }), true);
assert.equal(canExecuteSupplierImport({ batchId: 7, summary: { wouldImport: 0 } }), false);
assert.equal(canExecuteSupplierImport({ summary: { wouldImport: 1 } }), false);

console.log('供应商前端纯逻辑测试通过。');
