import { download, query, request } from '@/api/http';

// 供应商接口根路径和受控导入固定确认文案由前后端冻结契约共同维护。
const SUPPLIER_BASE_URL = '/suppliers';
export const SUPPLIER_IMPORT_CONFIRM_TEXT = '确认导入供应商台账';

/** 查询供应商分页列表。 */
export function getSuppliers(params = {}) {
  return request({ url: SUPPLIER_BASE_URL, params: query(params) });
}

/** 查询单个供应商详情。 */
export function getSupplier(supplierId) {
  return request({ url: `${SUPPLIER_BASE_URL}/${supplierId}` });
}

/** 新增供应商。 */
export function createSupplier(payload) {
  return request({ method: 'post', url: SUPPLIER_BASE_URL, data: payload });
}

/** 编辑供应商普通字段；调用方不得传入 status。 */
export function updateSupplier(supplierId, payload) {
  return request({ method: 'patch', url: `${SUPPLIER_BASE_URL}/${supplierId}`, data: payload });
}

/** 通过专用接口踢出或恢复供应商。 */
export function updateSupplierStatus(supplierId, status) {
  return request({ method: 'patch', url: `${SUPPLIER_BASE_URL}/${supplierId}/status`, data: { status } });
}

/** 下载固定 Excel v1 供应商模板。 */
export function downloadSupplierTemplate() {
  return download({ url: '/templates/suppliers.xlsx' }, '供应商导入模板.xlsx');
}

/** 按当前筛选下载供应商台账。 */
export function exportSuppliers(params = {}) {
  return download({ url: `${SUPPLIER_BASE_URL}/export.xlsx`, params: query(params) }, '供应商台账.xlsx');
}

/** 上传原文件并创建受控导入预演。 */
export function previewSupplierImport(file) {
  const data = new FormData();
  data.append('file', file);
  return request({ method: 'post', url: `${SUPPLIER_BASE_URL}/imports/preview`, data });
}

/** 使用服务端持久批次执行供应商导入，不提交客户端候选或签名。 */
export function executeSupplierImport(batchId) {
  return request({
    method: 'post',
    url: `${SUPPLIER_BASE_URL}/imports/execute`,
    data: {
      batchId,
      confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }
  });
}
