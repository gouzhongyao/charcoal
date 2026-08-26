'use strict';

const zlib = require('zlib');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  SUPPLIER_FIELD_LIMITS,
  SUPPLIER_IMPORT_RESOURCE_LIMITS,
  buildSupplierCodeKey,
  normalizeSupplierCodeDisplay
} = require('./supplierContracts');
const { createImportIssue, buildImportSummary } = require('./energyAnalysisImportCore');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');

// 供应商领域冻结契约：模板、状态、分页和字段长度统一在服务端维护。
const SUPPLIER_TEMPLATE_TYPE = 'suppliers';
const SUPPLIER_IMPORT_CONFIRM_TEXT = '确认导入供应商台账';
const SUPPLIER_STATUSES = Object.freeze(['active', 'inactive']);
const SUPPLIER_IMPORT_HEADERS = Object.freeze(['供应商编码', '供应商名称', '地址', '联系人', '联系电话', '备注', '合作状态']);
const SUPPLIER_STATUS_LABELS = Object.freeze({ active: '合作中', inactive: '已踢出' });
const SUPPLIER_IMPORT_STATUS_MAP = Object.freeze({
  合作中: 'active',
  是: 'active',
  在库: 'active',
  已踢出: 'inactive',
  否: 'inactive',
  不在库: 'inactive'
});
const SUPPLIER_ALLOWED_CREATE_FIELDS = new Set(['supplierCode', 'supplierName', 'address', 'contactPerson', 'contactPhone', 'remarks', 'status']);
const SUPPLIER_ALLOWED_UPDATE_FIELDS = new Set(['supplierCode', 'supplierName', 'address', 'contactPerson', 'contactPhone', 'remarks']);

/** 返回当前严格 UTC 审计时间。 */
function getNow() {
  return new Date().toISOString();
}

/** 将任意可显示值规范化为去除首尾空白的文本。 */
function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 将可选文本规范化为 null，并执行冻结长度上限。 */
function normalizeOptionalText(value, fieldName, maxLength) {
  const normalized = normalizeText(value);
  if (normalized.length > maxLength) {
    throw badRequest(`${fieldName} 长度不能超过 ${maxLength} 个字符。`, {
      code: 'SUPPLIER_FIELD_TOO_LONG',
      fieldName,
      maxLength
    });
  }
  return normalized || null;
}

/** 读取必填文本并执行冻结长度上限。 */
function normalizeRequiredText(value, fieldName, maxLength) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw badRequest(`${fieldName} 为必填项。`, { code: 'SUPPLIER_REQUIRED_FIELD_MISSING', fieldName });
  }
  if (normalized.length > maxLength) {
    throw badRequest(`${fieldName} 长度不能超过 ${maxLength} 个字符。`, {
      code: 'SUPPLIER_FIELD_TOO_LONG',
      fieldName,
      maxLength
    });
  }
  return normalized;
}

/** 将供应商 ID 规范化为正安全整数。 */
function normalizeSupplierId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw badRequest('供应商 ID 必须是正整数。', { code: 'SUPPLIER_ID_INVALID', id: value });
  }
  return normalized;
}

/** 将分页参数限制在本地轻量化页面允许范围内。 */
function normalizePagination(query = {}) {
  const rawPage = Number(query.page || 1);
  const rawPageSize = Number(query.pageSize || query.page_size || 20);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Number.isSafeInteger(rawPageSize) && rawPageSize > 0 && rawPageSize <= 500 ? rawPageSize : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 验证请求仅包含当前接口允许的业务字段，未知字段默认拒绝。 */
function assertAllowedFields(input, allowedFields, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('供应商请求体必须是 JSON 对象。', { code: 'SUPPLIER_PAYLOAD_INVALID', operation });
  }
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('供应商请求包含不受支持的字段。', {
      code: operation === 'update' && unknownFields.includes('status')
        ? 'SUPPLIER_STATUS_UPDATE_REQUIRES_DEDICATED_ENDPOINT'
        : 'SUPPLIER_UNKNOWN_FIELDS_REJECTED',
      operation,
      unknownFields
    });
  }
}

/** 规范化新增或编辑供应商的业务字段。 */
function normalizeSupplierPayload(input = {}, options = {}) {
  const existing = options.existing || null;
  const supplierCode = normalizeRequiredText(
    normalizeSupplierCodeDisplay(
      Object.prototype.hasOwnProperty.call(input, 'supplierCode') ? input.supplierCode : existing?.supplierCode
    ),
    'supplierCode',
    SUPPLIER_FIELD_LIMITS.supplierCode
  );
  const supplierCodeKey = buildSupplierCodeKey(supplierCode);
  const supplierName = normalizeRequiredText(
    Object.prototype.hasOwnProperty.call(input, 'supplierName') ? input.supplierName : existing?.supplierName,
    'supplierName',
    SUPPLIER_FIELD_LIMITS.supplierName
  );
  const status = options.allowStatus
    ? normalizeText(input.status || existing?.status || 'active')
    : existing?.status;
  if (options.allowStatus && !SUPPLIER_STATUSES.includes(status)) {
    throw badRequest('status 仅支持 active 或 inactive。', { code: 'SUPPLIER_STATUS_INVALID', status });
  }
  return {
    supplierCode,
    supplierCodeKey,
    supplierName,
    address: normalizeOptionalText(Object.prototype.hasOwnProperty.call(input, 'address') ? input.address : existing?.address, 'address', SUPPLIER_FIELD_LIMITS.address),
    contactPerson: normalizeOptionalText(Object.prototype.hasOwnProperty.call(input, 'contactPerson') ? input.contactPerson : existing?.contactPerson, 'contactPerson', SUPPLIER_FIELD_LIMITS.contactPerson),
    // 联系电话始终按原始用户文本保存，禁止 Number 转换。
    contactPhone: normalizeOptionalText(Object.prototype.hasOwnProperty.call(input, 'contactPhone') ? input.contactPhone : existing?.contactPhone, 'contactPhone', SUPPLIER_FIELD_LIMITS.contactPhone),
    remarks: normalizeOptionalText(Object.prototype.hasOwnProperty.call(input, 'remarks') ? input.remarks : existing?.remarks, 'remarks', SUPPLIER_FIELD_LIMITS.remarks),
    status
  };
}

/** 将数据库供应商行投影为稳定 API 字段。 */
function mapSupplierRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    address: row.address || null,
    contactPerson: row.contactPerson || null,
    contactPhone: row.contactPhone || null,
    remarks: row.remarks || null,
    status: row.status,
    statusLabel: SUPPLIER_STATUS_LABELS[row.status] || row.status,
    sourceBatchId: row.sourceBatchId === null || row.sourceBatchId === undefined ? null : Number(row.sourceBatchId),
    sourceRowNumber: row.sourceRowNumber === null || row.sourceRowNumber === undefined ? null : Number(row.sourceRowNumber),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

// 供应商查询字段投影集中维护，避免列表、详情和写后读取漂移。
const SUPPLIER_SELECT_SQL = `SELECT id,
  supplier_code AS supplierCode,
  supplier_name AS supplierName,
  address,
  contact_person AS contactPerson,
  contact_phone AS contactPhone,
  remarks,
  status,
  source_batch_id AS sourceBatchId,
  source_row_number AS sourceRowNumber,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM suppliers`;

/** 在现有连接中按 ID 读取供应商，不存在时返回 404。 */
function getSupplierByIdWithDb(db, supplierId) {
  const row = db.prepare(`${SUPPLIER_SELECT_SQL} WHERE id = ?`).get(supplierId);
  if (!row) throw notFound('供应商不存在。', { id: supplierId });
  return mapSupplierRow(row);
}

/** 在现有连接中按服务端规范键读取供应商，不接受客户端提供规范键。 */
function getSupplierByCodeWithDb(db, supplierCode) {
  const displayCode = normalizeRequiredText(
    normalizeSupplierCodeDisplay(supplierCode),
    'supplierCode',
    SUPPLIER_FIELD_LIMITS.supplierCode
  );
  const supplierCodeKey = buildSupplierCodeKey(displayCode);
  const row = db.prepare(`${SUPPLIER_SELECT_SQL} WHERE supplier_code_key = ?`).get(supplierCodeKey);
  if (!row) throw notFound('供应商不存在。', { supplierCode: displayCode });
  return mapSupplierRow(row);
}

/** 在同一业务事务写入供应商操作审计。 */
function insertSupplierOperationLog(db, actor = {}, operation, targetId, detail = {}) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, ?, 'supplier', ?, ?, ?, ?)`)
    .run(actor.userId || null, operation, targetId === null ? null : String(targetId), JSON.stringify(detail || {}), actor.ip || null, getNow());
}

// 供应商关键词 LIKE 使用固定转义字符，确保用户输入的百分号、下划线和转义字符按文本查询。
const SUPPLIER_LIKE_ESCAPE_CHARACTER = '!';

/** 转义 SQLite LIKE 元字符，避免关键词被解释为不受控通配模式。 */
function escapeSupplierLikePattern(value) {
  return String(value)
    .replaceAll(SUPPLIER_LIKE_ESCAPE_CHARACTER, `${SUPPLIER_LIKE_ESCAPE_CHARACTER}${SUPPLIER_LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${SUPPLIER_LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${SUPPLIER_LIKE_ESCAPE_CHARACTER}_`);
}

/** 构造列表和导出共用的筛选 SQL 与参数。 */
function buildSupplierWhere(query = {}) {
  const clauses = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    if (!SUPPLIER_STATUSES.includes(status)) {
      throw badRequest('status 筛选仅支持 active 或 inactive。', { code: 'SUPPLIER_STATUS_INVALID', status });
    }
    clauses.push('status = @status');
    params.status = status;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    const keywordPattern = `%${escapeSupplierLikePattern(keyword)}%`;
    const supplierCodeKeyPattern = `%${escapeSupplierLikePattern(buildSupplierCodeKey(keyword))}%`;
    clauses.push(`(supplier_code_key LIKE @supplierCodeKeyPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR supplier_code LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR supplier_name LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR address LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR contact_person LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR contact_phone LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}'
      OR remarks LIKE @keywordPattern ESCAPE '${SUPPLIER_LIKE_ESCAPE_CHARACTER}')`);
    params.keywordPattern = keywordPattern;
    params.supplierCodeKeyPattern = supplierCodeKeyPattern;
  }
  return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 分页读取供应商列表。 */
function listSuppliers(query = {}) {
  const pagination = normalizePagination(query);
  const { whereSql, params } = buildSupplierWhere(query);
  const db = openDatabase();
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM suppliers ${whereSql}`).get(params).total || 0);
    const rows = db.prepare(`${SUPPLIER_SELECT_SQL} ${whereSql}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, supplier_name COLLATE NOCASE, id
      LIMIT @limit OFFSET @offset`).all({ ...params, limit: pagination.pageSize, offset: pagination.offset }).map(mapSupplierRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total } };
  } finally {
    db.close();
  }
}

/** 读取供应商详情。 */
function getSupplier(supplierId) {
  const id = normalizeSupplierId(supplierId);
  const db = openDatabase();
  try {
    return getSupplierByIdWithDb(db, id);
  } finally {
    db.close();
  }
}

/** 按显示编码输入查询供应商，内部统一转换为规范键。 */
function getSupplierByCode(supplierCode) {
  const db = openDatabase();
  try {
    return getSupplierByCodeWithDb(db, supplierCode);
  } finally {
    db.close();
  }
}

/** 新增供应商并在同一事务记录操作审计。 */
function createSupplier(input = {}, actor = {}) {
  assertAllowedFields(input, SUPPLIER_ALLOWED_CREATE_FIELDS, 'create');
  const payload = normalizeSupplierPayload(input, { allowStatus: true });
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const now = getNow();
      let result;
      try {
        result = db.prepare(`INSERT INTO suppliers
          (supplier_code, supplier_code_key, supplier_name, address, contact_person, contact_phone, remarks, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(payload.supplierCode, payload.supplierCodeKey, payload.supplierName, payload.address, payload.contactPerson, payload.contactPhone, payload.remarks, payload.status, now, now);
      } catch (error) {
        if (/UNIQUE constraint failed: suppliers\.supplier_code_key/.test(String(error?.message || ''))) {
          throw new AppError('SUPPLIER_CODE_CONFLICT', '供应商编码已存在。', { statusCode: 409, details: { supplierCode: payload.supplierCode } });
        }
        throw error;
      }
      const supplier = getSupplierByIdWithDb(db, Number(result.lastInsertRowid));
      insertSupplierOperationLog(db, actor, 'supplier.create', supplier.id, { supplierCode: supplier.supplierCode, status: supplier.status });
      return supplier;
    }).immediate();
  } finally {
    db.close();
  }
}

/** 编辑供应商业务字段；status 出现在请求中时严格拒绝。 */
function updateSupplier(supplierId, input = {}, actor = {}) {
  assertAllowedFields(input, SUPPLIER_ALLOWED_UPDATE_FIELDS, 'update');
  const id = normalizeSupplierId(supplierId);
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const existing = getSupplierByIdWithDb(db, id);
      const payload = normalizeSupplierPayload(input, { existing, allowStatus: false });
      try {
        db.prepare(`UPDATE suppliers SET supplier_code = ?, supplier_code_key = ?, supplier_name = ?, address = ?, contact_person = ?,
          contact_phone = ?, remarks = ?, updated_at = ? WHERE id = ?`)
          .run(payload.supplierCode, payload.supplierCodeKey, payload.supplierName, payload.address, payload.contactPerson, payload.contactPhone, payload.remarks, getNow(), id);
      } catch (error) {
        if (/UNIQUE constraint failed: suppliers\.supplier_code_key/.test(String(error?.message || ''))) {
          throw new AppError('SUPPLIER_CODE_CONFLICT', '供应商编码已存在。', { statusCode: 409, details: { supplierCode: payload.supplierCode } });
        }
        throw error;
      }
      const supplier = getSupplierByIdWithDb(db, id);
      insertSupplierOperationLog(db, actor, 'supplier.update', id, { supplierCode: supplier.supplierCode, changedFields: Object.keys(input) });
      return supplier;
    }).immediate();
  } finally {
    db.close();
  }
}

/** 通过专用接口踢出或恢复供应商合作状态。 */
function setSupplierStatus(supplierId, statusValue, actor = {}) {
  const id = normalizeSupplierId(supplierId);
  const status = normalizeText(statusValue);
  if (!SUPPLIER_STATUSES.includes(status)) {
    throw badRequest('status 仅支持 active 或 inactive。', { code: 'SUPPLIER_STATUS_INVALID', status });
  }
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const existing = getSupplierByIdWithDb(db, id);
      db.prepare('UPDATE suppliers SET status = ?, updated_at = ? WHERE id = ?').run(status, getNow(), id);
      const supplier = getSupplierByIdWithDb(db, id);
      insertSupplierOperationLog(db, actor, status === 'inactive' ? 'supplier.kick-out' : 'supplier.restore', id, {
        supplierCode: supplier.supplierCode,
        previousStatus: existing.status,
        status
      });
      return supplier;
    }).immediate();
  } finally {
    db.close();
  }
}

/** 防止电子表格软件把业务文本解释为公式。 */
function escapeSpreadsheetFormula(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/** 按当前筛选导出供应商 XLSX，并显式保持联系电话文本类型。 */
function exportSuppliers(query = {}) {
  const { whereSql, params } = buildSupplierWhere(query);
  const db = openDatabase();
  try {
    const rows = db.prepare(`${SUPPLIER_SELECT_SQL} ${whereSql}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, supplier_name COLLATE NOCASE, id`).all(params).map(mapSupplierRow);
    const data = rows.map((row) => [
      row.supplierCode,
      row.supplierName,
      row.address || '',
      row.contactPerson || '',
      row.contactPhone || '',
      row.remarks || '',
      row.statusLabel
    ].map(escapeSpreadsheetFormula));
    const worksheet = XLSX.utils.aoa_to_sheet([SUPPLIER_IMPORT_HEADERS, ...data]);
    data.forEach((row, rowIndex) => {
      const address = XLSX.utils.encode_cell({ r: rowIndex + 1, c: 4 });
      if (worksheet[address]) {
        worksheet[address].t = 's';
        worksheet[address].v = String(row[4] || '');
        worksheet[address].w = String(row[4] || '');
        worksheet[address].z = '@';
      }
    });
    worksheet['!cols'] = [16, 24, 32, 16, 24, 32, 12].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '供应商');
    return {
      body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `供应商台账-${new Date().toISOString().slice(0, 10)}.xlsx`,
      rowCount: rows.length
    };
  } finally {
    db.close();
  }
}

// ZIP 元数据签名只用于供应商固定 XLSX 在 SheetJS 解压前的资源边界校验。
const ZIP_SIGNATURES = Object.freeze({
  endOfCentralDirectory: 0x06054b50,
  centralDirectoryEntry: 0x02014b50,
  localFileHeader: 0x04034b50
});
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_UTF8_FILENAME_FLAG = 0x0800;
const ZIP_ENCRYPTION_FLAGS = 0x0041;
// 供应商工作簿公开错误只允许受控资源数字和工作表契约，不返回本机或 ZIP 内部路径。
const SUPPLIER_WORKBOOK_PUBLIC_DETAIL_FIELDS = new Set([
  'maxZipEntries',
  'actualZipEntries',
  'compressionMethod',
  'declaredSize',
  'actualSize',
  'maxEntryBytes',
  'maxTotalBytes',
  'declaredTotalBytes',
  'actualTotalBytes',
  'actualSheetNames',
  'maxWorksheets',
  'reference',
  'maxColumns',
  'actualLastColumn',
  'maxDataRows',
  'actualLastRow',
  'maxNonEmptyCells',
  'actualNonEmptyCells',
  'maxTextCharacters',
  'actualTextCharacters'
]);

/** 投影供应商工作簿公开错误详情，防止内部路径随异常响应泄露。 */
function projectSupplierWorkbookErrorDetails(details = {}) {
  return Object.fromEntries(
    Object.entries(details).filter(([fieldName]) => SUPPLIER_WORKBOOK_PUBLIC_DETAIL_FIELDS.has(fieldName))
  );
}

/** 构造稳定的供应商 XLSX 资源或结构错误。 */
function createSupplierWorkbookError(code, message, details = {}, statusCode = 400) {
  return new AppError(code, message, {
    statusCode,
    details: projectSupplierWorkbookErrorDetails(details)
  });
}

/** 在 ZIP 尾部定位唯一可用的中央目录结束记录。 */
function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_SIGNATURES.endOfCentralDirectory) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw createSupplierWorkbookError(
    'SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID',
    '供应商 Excel 的 ZIP 中央目录无效。'
  );
}

/** 校验 ZIP extra field 结构并明确拒绝 ZIP64。 */
function assertZipExtraFields(extraBuffer) {
  let offset = 0;
  while (offset < extraBuffer.length) {
    if (offset + 4 > extraBuffer.length) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 包含异常 ZIP 扩展字段。');
    }
    const fieldId = extraBuffer.readUInt16LE(offset);
    const fieldSize = extraBuffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldSize > extraBuffer.length) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 包含截断的 ZIP 扩展字段。');
    }
    if (fieldId === ZIP64_EXTRA_FIELD_ID) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP64_REJECTED', '供应商 Excel 不支持 ZIP64 格式。');
    }
    offset += fieldSize;
  }
}

/** 校验 XLSX 内部路径，拒绝重复项、绝对路径和目录穿越。 */
function assertSafeZipEntryName(entryName, seenEntryNames) {
  const normalizedName = String(entryName || '').replace(/\\/g, '/');
  const segments = normalizedName.split('/');
  if (!normalizedName
    || normalizedName.includes('\0')
    || normalizedName.startsWith('/')
    || /^[A-Za-z]:/.test(normalizedName)
    || segments.some((segment) => segment === '..' || segment === '.')) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENTRY_PATH_INVALID', '供应商 Excel 包含异常 ZIP 条目路径。', { entryName });
  }
  if (seenEntryNames.has(normalizedName)) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENTRY_DUPLICATED', '供应商 Excel 包含重复 ZIP 条目。', { entryName: normalizedName });
  }
  seenEntryNames.add(normalizedName);
  return normalizedName;
}

/** 解压单个受限 ZIP 条目，验证实际大小与中央目录声明一致。 */
function validateZipEntryPayload(entry, buffer, centralDirectoryOffset) {
  if (entry.localHeaderOffset + 30 > centralDirectoryOffset
    || buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_SIGNATURES.localFileHeader) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 本地文件头无效。', { entryName: entry.entryName });
  }
  const localFlags = buffer.readUInt16LE(entry.localHeaderOffset + 6);
  const localCompressionMethod = buffer.readUInt16LE(entry.localHeaderOffset + 8);
  const localFilenameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  if ((localFlags & ZIP_ENCRYPTION_FLAGS) !== 0 || entry.compressionMethod === 99) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENCRYPTED_REJECTED', '供应商 Excel 不支持加密 ZIP 条目。', { entryName: entry.entryName });
  }
  if (localCompressionMethod !== entry.compressionMethod) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 压缩方式声明不一致。', { entryName: entry.entryName });
  }
  const localExtraStart = entry.localHeaderOffset + 30 + localFilenameLength;
  const dataStart = localExtraStart + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (localExtraStart > centralDirectoryOffset || dataEnd > centralDirectoryOffset) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 条目范围越界。', { entryName: entry.entryName });
  }
  assertZipExtraFields(buffer.subarray(localExtraStart, dataStart));
  const compressedPayload = buffer.subarray(dataStart, dataEnd);
  let actualSize;
  try {
    if (entry.compressionMethod === 0) {
      actualSize = compressedPayload.length;
    } else if (entry.compressionMethod === 8) {
      actualSize = zlib.inflateRawSync(compressedPayload, {
        maxOutputLength: Math.min(
          SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1,
          entry.uncompressedSize + 1
        )
      }).length;
    } else {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_COMPRESSION_REJECTED', '供应商 Excel 包含不支持的 ZIP 压缩方式。', {
        entryName: entry.entryName,
        compressionMethod: entry.compressionMethod
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_PAYLOAD_INVALID', '供应商 Excel 的 ZIP 条目无法安全解压。', { entryName: entry.entryName });
  }
  if (actualSize !== entry.uncompressedSize) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_SIZE_MISMATCH', '供应商 Excel 的 ZIP 条目实际大小与声明不一致。', {
      entryName: entry.entryName,
      declaredSize: entry.uncompressedSize,
      actualSize
    });
  }
  return actualSize;
}

/** 在 XLSX.read 前校验 ZIP 中央目录、条目数量、加密、ZIP64 和解压大小。 */
function validateSupplierXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 文件不是有效的 XLSX ZIP 容器。');
  }
  const endOffset = findZipEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const totalEntryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== totalEntryCount) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_MULTIDISK_REJECTED', '供应商 Excel 不支持分卷 ZIP。');
  }
  if (totalEntryCount === 0
    || totalEntryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP64_REJECTED', '供应商 Excel 不支持空归档或 ZIP64 格式。');
  }
  if (totalEntryCount > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntries) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENTRY_LIMIT_EXCEEDED', '供应商 Excel 的 ZIP 条目数量超过限制。', {
      maxZipEntries: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntries,
      actualZipEntries: totalEntryCount
    }, 413);
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 中央目录范围异常。');
  }

  const seenEntryNames = new Set();
  const entries = [];
  let cursor = centralDirectoryOffset;
  let totalDeclaredSize = 0;
  for (let index = 0; index < totalEntryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== ZIP_SIGNATURES.centralDirectoryEntry) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 中央目录条目无效。');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + filenameLength + extraLength + commentLength;
    if (entryEnd > endOffset || diskStart !== 0) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 中央目录条目越界。');
    }
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0 || compressionMethod === 99) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENCRYPTED_REJECTED', '供应商 Excel 不支持加密 ZIP 条目。');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP64_REJECTED', '供应商 Excel 不支持 ZIP64 条目。');
    }
    if (uncompressedSize > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED', '供应商 Excel 的单个 ZIP 条目解压大小超过限制。', {
        maxEntryBytes: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes,
        entryName: index,
        declaredSize: uncompressedSize
      }, 413);
    }
    totalDeclaredSize += uncompressedSize;
    if (totalDeclaredSize > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) {
      throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED', '供应商 Excel 的 ZIP 总解压大小超过限制。', {
        maxTotalBytes: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes,
        declaredTotalBytes: totalDeclaredSize
      }, 413);
    }
    const filenameBuffer = buffer.subarray(cursor + 46, cursor + 46 + filenameLength);
    const entryName = assertSafeZipEntryName(
      filenameBuffer.toString((flags & ZIP_UTF8_FILENAME_FLAG) !== 0 ? 'utf8' : 'latin1'),
      seenEntryNames
    );
    const extraStart = cursor + 46 + filenameLength;
    assertZipExtraFields(buffer.subarray(extraStart, extraStart + extraLength));
    entries.push({ entryName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = entryEnd;
  }
  if (cursor !== endOffset) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_DIRECTORY_INVALID', '供应商 Excel 的 ZIP 中央目录包含异常尾部数据。');
  }
  const totalActualSize = entries.reduce(
    (total, entry) => total + validateZipEntryPayload(entry, buffer, centralDirectoryOffset),
    0
  );
  if (totalActualSize > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED', '供应商 Excel 的 ZIP 实际总解压大小超过限制。', {
      maxTotalBytes: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes,
      actualTotalBytes: totalActualSize
    }, 413);
  }
  return { entryCount: entries.length, totalUncompressedBytes: totalActualSize };
}

/** 从固定 Excel v1 工作表读取原始文本行，并标记公式单元格。 */
function parseSupplierWorkbook(buffer, originalFilename) {
  if (!/\.xlsx$/i.test(String(originalFilename || ''))) {
    throw badRequest('供应商导入仅支持固定 Excel v1 的 .xlsx 文件。', { code: 'SUPPLIER_IMPORT_XLSX_REQUIRED' });
  }
  validateSupplierXlsxArchive(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellText: true,
      cellDates: false,
      sheetRows: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows + 2
    });
  } catch (_error) {
    throw badRequest('供应商 Excel 文件无法解析。', { code: 'SUPPLIER_IMPORT_WORKBOOK_INVALID' });
  }
  if (workbook.SheetNames.length !== SUPPLIER_IMPORT_RESOURCE_LIMITS.maxWorksheets
    || workbook.SheetNames[0] !== '供应商') {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_SHEET_CONTRACT_INVALID', '供应商 Excel 只能包含一个名为“供应商”的工作表。', {
      actualSheetNames: workbook.SheetNames,
      maxWorksheets: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxWorksheets
    });
  }
  const worksheet = workbook.Sheets['供应商'];
  const fullReference = worksheet?.['!fullref'] || worksheet?.['!ref'];
  if (!worksheet || !fullReference) {
    throw badRequest('供应商 Excel 缺少“供应商”工作表或有效区域。', { code: 'SUPPLIER_IMPORT_SHEET_REQUIRED' });
  }
  let worksheetRange;
  try {
    worksheetRange = XLSX.utils.decode_range(fullReference);
  } catch (_error) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_SHEET_RANGE_INVALID', '供应商 Excel 的工作表范围无效。', { reference: fullReference });
  }
  if (worksheetRange.e.c >= SUPPLIER_IMPORT_RESOURCE_LIMITS.maxColumns) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_COLUMN_LIMIT_EXCEEDED', '供应商 Excel 的列数超过固定模板限制。', {
      maxColumns: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxColumns,
      actualLastColumn: worksheetRange.e.c + 1
    }, 413);
  }
  if (worksheetRange.e.r > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_ROW_LIMIT_EXCEEDED', '供应商 Excel 的数据行数超过固定模板限制。', {
      maxDataRows: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows,
      actualLastRow: worksheetRange.e.r + 1
    }, 413);
  }
  const nonEmptyCellCount = Object.entries(worksheet).filter(([address, cell]) => (
    !address.startsWith('!')
      && cell
      && (Boolean(cell.f) || (cell.v !== undefined && cell.v !== null && String(cell.v) !== ''))
  )).length;
  if (nonEmptyCellCount > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxNonEmptyCells) {
    throw createSupplierWorkbookError('SUPPLIER_IMPORT_CELL_LIMIT_EXCEEDED', '供应商 Excel 的非空单元格数量超过限制。', {
      maxNonEmptyCells: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxNonEmptyCells,
      actualNonEmptyCells: nonEmptyCellCount
    }, 413);
  }
  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: true });
  const headers = (matrix[0] || []).map(normalizeText);
  if (headers.length !== SUPPLIER_IMPORT_HEADERS.length
    || headers.some((header, index) => header !== SUPPLIER_IMPORT_HEADERS[index])) {
    throw badRequest('供应商 Excel 表头必须与固定 v1 模板完全一致。', {
      code: 'SUPPLIER_IMPORT_HEADERS_MISMATCH',
      expectedHeaders: SUPPLIER_IMPORT_HEADERS,
      actualHeaders: headers
    });
  }
  const rows = [];
  let totalTextCharacters = headers.reduce((total, value) => total + value.length, 0);
  for (let matrixIndex = 1; matrixIndex < matrix.length; matrixIndex += 1) {
    const values = matrix[matrixIndex] || [];
    const rowNumber = matrixIndex + 1;
    const normalizedValues = SUPPLIER_IMPORT_HEADERS.map(
      (_header, columnIndex) => normalizeText(values[columnIndex])
    );
    totalTextCharacters += normalizedValues.reduce((total, value) => total + value.length, 0);
    if (totalTextCharacters > SUPPLIER_IMPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters) {
      throw createSupplierWorkbookError(
        'SUPPLIER_IMPORT_TEXT_BUDGET_EXCEEDED',
        '供应商 Excel 的业务文本总字符数超过限制。',
        {
          maxTextCharacters: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters,
          actualTextCharacters: totalTextCharacters
        },
        413
      );
    }
    const formulaFields = SUPPLIER_IMPORT_HEADERS.filter((_header, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
      return Boolean(cell && cell.f);
    });
    if (normalizedValues.some(Boolean) || formulaFields.length > 0) {
      rows.push({ rowNumber, values: normalizedValues, formulaFields });
    }
  }
  return rows;
}

/** 将单行供应商导入数据转换为领域预演项。 */
function buildSupplierImportItem(row, existingByCodeKey, duplicateCodeKeys) {
  const [supplierCode, supplierName, address, contactPerson, contactPhone, remarks, rawStatus] = row.values;
  const supplierCodeKey = supplierCode ? buildSupplierCodeKey(supplierCode) : '';
  const issues = [];
  if (row.formulaFields.length > 0) {
    issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName: row.formulaFields.join(','), rawValue: null, code: 'SUPPLIER_IMPORT_FORMULA_CELL_REJECTED', message: '供应商模板不允许公式单元格，请改为纯文本后重新预演。', severity: 'error' }));
  }
  if (!supplierCode) issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName: '供应商编码', rawValue: supplierCode, code: 'SUPPLIER_CODE_REQUIRED', message: '供应商编码为必填项。', severity: 'error' }));
  if (!supplierName) issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName: '供应商名称', rawValue: supplierName, code: 'SUPPLIER_NAME_REQUIRED', message: '供应商名称为必填项。', severity: 'error' }));
  const fieldValues = { supplierCode, supplierName, address, contactPerson, contactPhone, remarks };
  Object.entries(fieldValues).forEach(([fieldName, value]) => {
    if (value && value.length > SUPPLIER_FIELD_LIMITS[fieldName]) {
      issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName, rawValue: value, code: 'SUPPLIER_FIELD_TOO_LONG', message: `${fieldName} 超过允许长度。`, severity: 'error' }));
    }
  });
  const supplierStatus = SUPPLIER_IMPORT_STATUS_MAP[rawStatus];
  if (!supplierStatus) {
    issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName: '合作状态', rawValue: rawStatus, code: 'SUPPLIER_IMPORT_STATUS_UNKNOWN', message: '合作状态仅支持合作中/是/在库或已踢出/否/不在库。', severity: 'error' }));
  }
  if (supplierCodeKey && duplicateCodeKeys.has(supplierCodeKey)) {
    issues.push(createImportIssue({ rowNumber: row.rowNumber, fieldName: '供应商编码', rawValue: supplierCode, code: 'SUPPLIER_IMPORT_DUPLICATE_CODE_BLOCKED', message: '同一文件内供应商编码按大小写和全角规范化后重复，所有重复行均已阻断。', severity: 'error' }));
  }
  const base = {
    rowNumber: row.rowNumber,
    rowId: row.rowNumber,
    candidateRowId: `supplier:${row.rowNumber}`,
    supplierCode: supplierCode || null,
    supplierName: supplierName || null,
    address: address || null,
    contactPerson: contactPerson || null,
    contactPhone: contactPhone || null,
    remarks: remarks || null,
    collaborationStatus: supplierStatus || null,
    issues
  };
  if (issues.some((issue) => issue.severity === 'error')) return { ...base, status: 'blocked' };
  const existing = existingByCodeKey.get(supplierCodeKey);
  if (existing) {
    return {
      ...base,
      status: 'skipped',
      existingSupplierId: Number(existing.id),
      issues: [createImportIssue({ rowNumber: row.rowNumber, fieldName: '供应商编码', rawValue: supplierCode, code: 'SUPPLIER_CODE_EXISTS_SKIPPED', message: `库内已有该供应商编码且状态为 ${SUPPLIER_STATUS_LABELS[existing.status] || existing.status}，按 skip 策略跳过，不覆盖、不恢复。`, severity: 'warning' })]
    };
  }
  return { ...base, status: 'wouldImport' };
}

/** 使用当前数据库状态重算供应商导入候选、跳过项和阻断项。 */
function buildSupplierImportPreview({ db, buffer, originalFilename }) {
  const rows = parseSupplierWorkbook(buffer, originalFilename);
  const codeCounts = rows.reduce((counts, row) => {
    const supplierCodeKey = row.values[0] ? buildSupplierCodeKey(row.values[0]) : '';
    if (supplierCodeKey) counts.set(supplierCodeKey, (counts.get(supplierCodeKey) || 0) + 1);
    return counts;
  }, new Map());
  const duplicateCodeKeys = new Set([...codeCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([supplierCodeKey]) => supplierCodeKey));
  const existingByCodeKey = new Map(db.prepare('SELECT id, supplier_code AS supplierCode, supplier_code_key AS supplierCodeKey, status FROM suppliers').all()
    .map((supplier) => [supplier.supplierCodeKey, supplier]));
  const items = rows.map((row) => buildSupplierImportItem(row, existingByCodeKey, duplicateCodeKeys));
  const summary = buildImportSummary(items);
  const candidateRows = items.filter((item) => item.status === 'wouldImport').map((item) => ({
    candidateRowId: item.candidateRowId,
    rowNumber: item.rowNumber,
    supplierCode: item.supplierCode,
    supplierName: item.supplierName,
    address: item.address,
    contactPerson: item.contactPerson,
    contactPhone: item.contactPhone,
    remarks: item.remarks,
    status: item.collaborationStatus
  }));
  const auditIssues = items.flatMap((item) => item.issues || []);
  return {
    fieldMapping: Object.fromEntries(SUPPLIER_IMPORT_HEADERS.map((header) => [header, header])),
    summary,
    candidateRows,
    items,
    auditIssues,
    notices: [
      '预演不写入 suppliers；执行时服务端会重读同一原文件、重新计算候选并校验 SHA、签名和 stale 状态。',
      '供应商编码按 trim、NFKC 和大写规范键判重；同文件规范键重复全部阻断，库内已有规范键按 skip warning 处理，不覆盖、不恢复、不静默更新。',
      '联系电话始终按 TEXT 保存；合作状态为必填项，仅按固定中文映射转换为 active/inactive，空白或未知值均阻断。'
    ]
  };
}

/** 在安全导入事务中插入服务端重算后的供应商候选。 */
function insertSupplierImportCandidates({ db, batchId, candidateRows, options = {} }) {
  const now = getNow();
  const insert = db.prepare(`INSERT INTO suppliers
    (supplier_code, supplier_code_key, supplier_name, address, contact_person, contact_phone, remarks, status,
     source_batch_id, source_row_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const importedItems = candidateRows.map((row) => {
    const supplierCode = normalizeSupplierCodeDisplay(row.supplierCode);
    const supplierCodeKey = buildSupplierCodeKey(supplierCode);
    const result = insert.run(supplierCode, supplierCodeKey, row.supplierName, row.address, row.contactPerson, row.contactPhone, row.remarks,
      row.status, batchId, row.rowNumber, now, now);
    return { supplierId: Number(result.lastInsertRowid), supplierCode: row.supplierCode, rowNumber: row.rowNumber };
  });
  insertSupplierOperationLog(db, options.actor || {}, 'supplier.import.execute', batchId, {
    batchId,
    imported: importedItems.length,
    supplierIds: importedItems.map((item) => item.supplierId)
  });
  return { imported: importedItems.length, importedIds: importedItems.map((item) => item.supplierId), importedItems };
}

/** 在共享 preview 事务中持久化供应商领域操作审计。 */
function persistSupplierPreviewAudit({ db, batch, preview, safeFile, options = {} }) {
  insertSupplierOperationLog(db, options.actor || {}, 'supplier.import.preview', batch.id, {
    batchId: batch.id,
    fileSha256: safeFile.fileSha256,
    summary: preview.summary
  });
}

// 供应商描述器提供领域解析、同事务 preview 审计与写入；原文件安全链由共享服务执行。
const SUPPLIER_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: SUPPLIER_TEMPLATE_TYPE,
  domainName: '供应商',
  buildPreview: buildSupplierImportPreview,
  persistPreviewAudit: persistSupplierPreviewAudit,
  insertCandidates: insertSupplierImportCandidates
});

/** 创建供应商受控导入预演，批次、问题和操作审计在共享事务中提交。 */
function previewSupplierImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, SUPPLIER_IMPORT_DESCRIPTOR, options);
}

/** 执行供应商受控导入；客户端只提交批次与固定确认字段。 */
async function executeSupplierImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, SUPPLIER_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  SUPPLIER_FIELD_LIMITS,
  SUPPLIER_IMPORT_CONFIRM_TEXT,
  SUPPLIER_IMPORT_DESCRIPTOR,
  SUPPLIER_IMPORT_HEADERS,
  SUPPLIER_IMPORT_RESOURCE_LIMITS,
  SUPPLIER_IMPORT_STATUS_MAP,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_STATUSES,
  SUPPLIER_TEMPLATE_TYPE,
  buildSupplierImportItem,
  buildSupplierImportPreview,
  createSupplier,
  escapeSpreadsheetFormula,
  executeSupplierImport,
  exportSuppliers,
  getSupplier,
  getSupplierByCode,
  insertSupplierImportCandidates,
  listSuppliers,
  normalizeSupplierPayload,
  parseSupplierWorkbook,
  persistSupplierPreviewAudit,
  previewSupplierImport,
  setSupplierStatus,
  updateSupplier,
  validateSupplierXlsxArchive
};
