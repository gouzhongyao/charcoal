// 供应商前端展示状态只映射服务端冻结的 active/inactive，不猜测其他值。
export const SUPPLIER_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: 'active', label: '合作中' }),
  Object.freeze({ value: 'inactive', label: '已踢出' })
]);
const SUPPLIER_STATUS_LABELS = Object.freeze(Object.fromEntries(SUPPLIER_STATUS_OPTIONS.map((item) => [item.value, item.label])));

/** 返回供应商合作状态中文名称。 */
export function supplierStatusLabel(status) {
  return SUPPLIER_STATUS_LABELS[String(status || '')] || '未知状态';
}

/** 构造新增供应商载荷；状态仅允许在新增时显式提交。 */
export function buildSupplierCreatePayload(form = {}) {
  return {
    supplierCode: String(form.supplierCode || '').trim(),
    supplierName: String(form.supplierName || '').trim(),
    address: String(form.address || '').trim(),
    contactPerson: String(form.contactPerson || '').trim(),
    // 联系电话始终按文本提交，禁止 Number 转换。
    contactPhone: String(form.contactPhone || '').trim(),
    remarks: String(form.remarks || '').trim(),
    status: form.status === 'inactive' ? 'inactive' : 'active'
  };
}

/** 构造普通编辑载荷，固定排除 status 以匹配服务端 fail-closed 契约。 */
export function buildSupplierUpdatePayload(form = {}) {
  const payload = buildSupplierCreatePayload(form);
  delete payload.status;
  return payload;
}

/** 规范化供应商导入预演汇总，便于页面稳定展示零值。 */
export function normalizeSupplierImportSummary(summary = {}) {
  return {
    totalRows: Number(summary.totalRows || 0),
    wouldImport: Number(summary.wouldImport || 0),
    skipped: Number(summary.skipped || 0),
    blocked: Number(summary.blocked || 0),
    warnings: Number(summary.warnings || 0),
    errors: Number(summary.errors || 0)
  };
}

/** 只有持久批次存在且至少一行可导入时才允许执行。 */
export function canExecuteSupplierImport(preview) {
  const batchId = Number(preview?.batchId);
  const summary = normalizeSupplierImportSummary(preview?.summary);
  return Number.isSafeInteger(batchId) && batchId > 0 && summary.wouldImport > 0;
}
