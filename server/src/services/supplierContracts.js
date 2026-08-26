'use strict';

// 供应商业务字段长度由页面写入、查询和 Excel v1 导入共同遵守。
const SUPPLIER_FIELD_LIMITS = Object.freeze({
  supplierCode: 64,
  supplierName: 200,
  address: 500,
  contactPerson: 100,
  contactPhone: 100,
  remarks: 1000
});

// 供应商 Excel v1 资源上限覆盖 5000 行字段合同，并在 SheetJS 解压前保留 ZIP bomb 防护。
const SUPPLIER_IMPORT_RESOURCE_LIMITS = Object.freeze({
  maxDataRows: 5000,
  maxColumns: 7,
  maxNonEmptyCells: 35007,
  maxWorksheets: 1,
  maxZipEntries: 256,
  maxZipEntryUncompressedBytes: 64 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 128 * 1024 * 1024,
  // 现有六个业务字段上限加最长合作状态后，5000 行理论字符量小于 1000 万。
  maxWorkbookTextCharacters: 10_000_000
});

/** 清理供应商显示编码首尾空白，同时保留用户输入的大小写、全角和内部空白。 */
function normalizeSupplierCodeDisplay(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 使用 trim、Unicode NFKC 和 locale-independent 大写生成服务端唯一规范键。 */
function buildSupplierCodeKey(value) {
  return normalizeSupplierCodeDisplay(value).normalize('NFKC').toUpperCase();
}

module.exports = {
  SUPPLIER_FIELD_LIMITS,
  SUPPLIER_IMPORT_RESOURCE_LIMITS,
  buildSupplierCodeKey,
  normalizeSupplierCodeDisplay
};
