'use strict';

const zlib = require('zlib');
const XLSX = require('xlsx');
const { openDatabase: defaultOpenDatabase, uploadsDir: defaultUploadsDir } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const backupService = require('./backupService');
const { insertOperationLogWithDb } = require('./energyStrategyEvaluationService');
const {
  bindDemoContextPreviewInTransaction,
  markDemoContextExecutedInTransaction
} = require('./demoContextService');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssuesWithDatabase,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  authorizeEnergyAnalysisImportExecute,
  buildEnergyAnalysisImportPreviewAuditDigest,
  buildEnergyAnalysisImportPreviewSignature,
  normalizeCandidateRows,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  stableSerialize
} = require('./energyAnalysisImportCore');
const {
  ENERGY_FLOW_WORKBOOK_BACKUP_REASON,
  ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
  ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY,
  ENERGY_FLOW_WORKBOOK_ENUMS,
  ENERGY_FLOW_WORKBOOK_HEADERS,
  ENERGY_FLOW_WORKBOOK_IMPORT_TYPE,
  ENERGY_FLOW_WORKBOOK_OPERATION,
  ENERGY_FLOW_WORKBOOK_RECORD_KIND,
  ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS,
  ENERGY_FLOW_WORKBOOK_SHEETS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION,
  assertWorkbookEnum,
  createWorkbookIssue,
  isWorkbookBlank,
  mapWorkbookRow,
  normalizeWorkbookCode,
  normalizeWorkbookKey,
  normalizeWorkbookNumber,
  normalizeWorkbookText,
  normalizeWorkbookVersion,
  requireWorkbookText,
  normalizeWorkbookWallClockRange,
  projectEnergyFlowWorkbookPublicDto
} = require('./energyFlowWorkbookContracts');

// XLSX ZIP 固定签名与资源安全门禁常量。
const ZIP_SIGNATURES = Object.freeze({
  eocd: 0x06054b50,
  central: 0x02014b50,
  local: 0x04034b50,
  dataDescriptor: 0x08074b50,
  zip64Locator: 0x07064b50
});
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTION_FLAGS = 0x2041;
// CRC32 查找表用于在 SheetJS 解析前核对每个 ZIP 条目的真实内容。
const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, tableIndex) => {
  let crc = tableIndex;
  for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
}));
const NUMERIC_COLUMNS = Object.freeze({
  '设备资产与节点': new Set([11, 12]),
  '有向边': new Set([3]),
  '期间流量': new Set([12]),
  '损耗证据': new Set([13])
});

/** 构造带稳定领域码的工作簿错误，禁止泄露路径和底层异常。 */
function workbookError(code, message, statusCode = 400, details = {}) {
  return new AppError(code, message, { statusCode, details: { ...details, code } });
}

/** 计算 ZIP 条目解压内容的无符号 CRC32。 */
function calculateCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 读取 ZIP 中央目录结束记录，拒绝尾部伪造和异常注释。 */
function findZipEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_SIGNATURES.eocd) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 中央目录无效。');
}

/** 校验 ZIP extra 字段结构并拒绝 ZIP64 扩展字段。 */
function assertZipExtraFields(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 扩展字段无效。');
    const fieldId = extra.readUInt16LE(offset);
    const fieldSize = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldSize > extra.length) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 扩展字段被截断。');
    if (fieldId === ZIP64_EXTRA_FIELD_ID) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP64_REJECTED', '完整能流工作簿不支持 ZIP64。');
    offset += fieldSize;
  }
}

/** 校验 ZIP 条目名，拒绝重复、绝对路径和目录穿越。 */
function assertSafeZipEntryName(name, seen) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)
    || normalized.endsWith('/')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_PATH_INVALID', '完整能流工作簿 ZIP 条目路径无效。');
  }
  if (seen.has(normalized)) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_DUPLICATED', '完整能流工作簿 ZIP 包含重复条目。');
  seen.add(normalized);
  return normalized;
}

/** 读取并交叉校验 ZIP 本地文件头和可选 data descriptor。 */
function readZipLocalEntryLayout(entry, buffer, centralDirectoryOffset) {
  if (entry.localOffset + 30 > centralDirectoryOffset || buffer.readUInt32LE(entry.localOffset) !== ZIP_SIGNATURES.local) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 本地文件头无效。');
  }
  const flags = buffer.readUInt16LE(entry.localOffset + 6);
  const method = buffer.readUInt16LE(entry.localOffset + 8);
  const localCrc32 = buffer.readUInt32LE(entry.localOffset + 14);
  const localCompressedSize = buffer.readUInt32LE(entry.localOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(entry.localOffset + 22);
  const fileNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0 || entry.method === 99) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENCRYPTED_REJECTED', '完整能流工作簿不支持加密 ZIP。');
  if (flags !== entry.flags || method !== entry.method) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 本地头与中央目录声明不一致。');
  const localNameStart = entry.localOffset + 30;
  const localNameEnd = localNameStart + fileNameLength;
  const extraStart = localNameEnd;
  const dataStart = extraStart + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (localNameEnd > centralDirectoryOffset || dataEnd > centralDirectoryOffset || dataStart < entry.localOffset) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 条目范围越界。');
  }
  const localName = assertSafeZipEntryName(buffer.subarray(localNameStart, localNameEnd).toString((flags & ZIP_UTF8_FLAG) ? 'utf8' : 'latin1'), new Set());
  if (localName !== entry.name) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 本地文件头与中央目录条目不一致。');
  assertZipExtraFields(buffer.subarray(extraStart, dataStart));
  let rangeEnd = dataEnd;
  if ((flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
    if ((localCrc32 !== 0 && localCrc32 !== entry.crc32)
      || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
      || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)) {
      throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 本地头与 data descriptor 声明不一致。');
    }
    const hasSignature = dataEnd + 4 <= centralDirectoryOffset && buffer.readUInt32LE(dataEnd) === ZIP_SIGNATURES.dataDescriptor;
    const descriptorOffset = dataEnd + (hasSignature ? 4 : 0);
    rangeEnd = descriptorOffset + 12;
    if (rangeEnd > centralDirectoryOffset
      || buffer.readUInt32LE(descriptorOffset) !== entry.crc32
      || buffer.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize
      || buffer.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize) {
      throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP data descriptor 无效。');
    }
  } else if (localCrc32 !== entry.crc32 || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 本地文件头与中央目录条目不一致。');
  }
  return { dataStart, dataEnd, rangeEnd };
}

/** 判断 zlib 是否因为实际解压输出超过受控上限而终止。 */
function isZipOutputLimitError(error) {
  return error?.code === 'ERR_BUFFER_TOO_LARGE'
    || /maxOutputLength|larger than/iu.test(String(error?.message || ''));
}

/** 解压单个 ZIP 条目并先执行实际单条资源门禁。 */
function inflateZipEntry(entry, buffer, centralDirectoryOffset) {
  const layout = readZipLocalEntryLayout(entry, buffer, centralDirectoryOffset);
  const compressed = buffer.subarray(layout.dataStart, layout.dataEnd);
  const actualEntryLimit = ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes;
  let payload;
  try {
    if (entry.method === 0) payload = compressed;
    else if (entry.method === 8) payload = zlib.inflateRawSync(compressed, { maxOutputLength: actualEntryLimit + 1 });
    else throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_COMPRESSION_REJECTED', '完整能流工作簿包含不支持的 ZIP 压缩方式。', 400, { compressionMethod: entry.method });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isZipOutputLimitError(error)) {
      throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED', '完整能流工作簿单条实际解压大小超过限制。', 413);
    }
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_PAYLOAD_INVALID', '完整能流工作簿 ZIP 条目无法安全解压。');
  }
  if (payload.length > actualEntryLimit) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED', '完整能流工作簿单条实际解压大小超过限制。', 413);
  }
  return payload;
}

/** 在 SheetJS 解析之前完成完整 ZIP/OOXML 安全扫描。 */
function validateEnergyFlowWorkbookXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '文件不是有效 XLSX ZIP 容器。');
  if (buffer.length > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes) throw workbookError('ENERGY_FLOW_WORKBOOK_UPLOAD_SIZE_EXCEEDED', '完整能流工作簿上传文件超过 10 MiB 限制。', 413);
  const end = findZipEndOfCentralDirectory(buffer);
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP_SIGNATURES.zip64Locator) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP64_REJECTED', '完整能流工作簿不支持 ZIP64。');
  }
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const diskCount = buffer.readUInt16LE(end + 8);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_MULTIDISK_REJECTED', '完整能流工作簿不支持分卷 ZIP。');
  if (count === 0 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP64_REJECTED', '完整能流工作簿不支持空归档或 ZIP64。');
  if (count > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntries) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_LIMIT_EXCEEDED', '完整能流工作簿 ZIP 条目数量超过限制。', 413);
  if (centralOffset + centralSize !== end) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 中央目录范围异常。');
  const entries = [];
  const seen = new Set();
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== ZIP_SIGNATURES.central) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 中央目录条目无效。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > end || diskStart !== 0) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 条目越界。');
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0 || method === 99) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENCRYPTED_REJECTED', '完整能流工作簿不支持加密 ZIP。');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP64_REJECTED', '完整能流工作簿不支持 ZIP64 条目。');
    if (uncompressedSize > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED', '完整能流工作簿单条解压大小超过限制。', 413);
    declaredTotal += uncompressedSize;
    if (declaredTotal > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_TOTAL_SIZE_EXCEEDED', '完整能流工作簿声明总解压大小超过限制。', 413);
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const name = assertSafeZipEntryName(nameBuffer.toString((flags & ZIP_UTF8_FLAG) ? 'utf8' : 'latin1'), seen);
    assertZipExtraFields(buffer.subarray(cursor + 46 + fileNameLength, cursor + 46 + fileNameLength + extraLength));
    entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localOffset });
    cursor = entryEnd;
  }
  if (cursor !== end) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 中央目录包含异常尾部。');
  const localRanges = entries.map((entry) => {
    const layout = readZipLocalEntryLayout(entry, buffer, centralOffset);
    return { start: entry.localOffset, end: layout.rangeEnd };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID', '完整能流工作簿 ZIP 条目范围重叠。');
    }
  }
  let actualTotal = 0;
  let deferredIntegrityError = null;
  for (const entry of entries) {
    const payload = inflateZipEntry(entry, buffer, centralOffset);
    actualTotal += payload.length;
    if (actualTotal > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) throw workbookError('ENERGY_FLOW_WORKBOOK_ZIP_TOTAL_SIZE_EXCEEDED', '完整能流工作簿实际总解压大小超过限制。', 413);
    if (!deferredIntegrityError && payload.length !== entry.uncompressedSize) {
      deferredIntegrityError = workbookError('ENERGY_FLOW_WORKBOOK_ZIP_SIZE_MISMATCH', '完整能流工作簿 ZIP 条目实际解压大小与声明不一致。', 400, { declaredSize: entry.uncompressedSize, actualSize: payload.length });
    } else if (!deferredIntegrityError && calculateCrc32(payload) !== entry.crc32) {
      deferredIntegrityError = workbookError('ENERGY_FLOW_WORKBOOK_ZIP_CRC_MISMATCH', '完整能流工作簿 ZIP 条目内容校验失败。');
    } else if (!deferredIntegrityError && /^xl\/worksheets\/[^/]+\.xml$/iu.test(entry.name) && /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?f(?=[\s/>])/u.test(payload.toString('utf8'))) {
      deferredIntegrityError = workbookError('ENERGY_FLOW_WORKBOOK_FORMULA_CELL_REJECTED', '完整能流工作簿不允许公式单元格。');
    }
  }
  if (deferredIntegrityError) throw deferredIntegrityError;
  return { entryCount: entries.length, totalUncompressedBytes: actualTotal };
}

/** 读取固定工作簿的单元格矩阵，严格校验六表顺序、可见性、合并和表头。 */
function parseEnergyFlowWorkbookXlsx(buffer, originalFilename) {
  if (!/\.xlsx$/iu.test(String(originalFilename || ''))) throw workbookError('ENERGY_FLOW_WORKBOOK_XLSX_REQUIRED', '完整能流工作簿仅支持真实 .xlsx 文件。');
  validateEnergyFlowWorkbookXlsxArchive(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: false, sheetRows: ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxWorkbookRows + 2 });
  } catch (_error) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_INVALID', '完整能流工作簿无法解析。');
  }
  const expectedNames = ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.name);
  const metadata = workbook.Workbook?.Sheets || [];
  if (workbook.SheetNames.length !== expectedNames.length || workbook.SheetNames.some((name, index) => name !== expectedNames[index])
    || metadata.length !== expectedNames.length
    || metadata.some((sheet, index) => String(sheet.name || '') !== expectedNames[index] || Number(sheet.Hidden || 0) !== 0)) {
    throw workbookError('ENERGY_FLOW_WORKBOOK_SHEET_CONTRACT_INVALID', '完整能流工作簿工作表名称、顺序和可见性必须严格匹配。');
  }
  let totalCells = 0;
  let totalText = 0;
  let totalRows = 0;
  const parsed = {};
  for (const sheet of ENERGY_FLOW_WORKBOOK_SHEETS) {
    const worksheet = workbook.Sheets[sheet.name];
    const reference = worksheet?.['!fullref'] || worksheet?.['!ref'];
    if (!worksheet || !reference) throw workbookError('ENERGY_FLOW_WORKBOOK_SHEET_REQUIRED', `完整能流工作簿缺少“${sheet.name}”工作表。`);
    if (Array.isArray(worksheet['!merges']) && worksheet['!merges'].length) throw workbookError('ENERGY_FLOW_WORKBOOK_MERGED_CELLS_REJECTED', `完整能流工作簿“${sheet.name}”不允许合并单元格。`);
    let range;
    try { range = XLSX.utils.decode_range(reference); } catch (_error) { throw workbookError('ENERGY_FLOW_WORKBOOK_SHEET_RANGE_INVALID', `完整能流工作簿“${sheet.name}”范围无效。`); }
    if (range.e.c >= sheet.headers.length) throw workbookError('ENERGY_FLOW_WORKBOOK_COLUMN_COUNT_INVALID', `完整能流工作簿“${sheet.name}”列数不得增加。`);
    if (range.e.r > sheet.maxDataRows) throw workbookError('ENERGY_FLOW_WORKBOOK_ROW_LIMIT_EXCEEDED', `完整能流工作簿“${sheet.name}”数据行数超过限制。`, 413);
    for (const [address, cell] of Object.entries(worksheet)) {
      if (address.startsWith('!') || !cell) continue;
      if (Object.prototype.hasOwnProperty.call(cell, 'f')) throw workbookError('ENERGY_FLOW_WORKBOOK_FORMULA_CELL_REJECTED', '完整能流工作簿不允许公式单元格。');
      if (cell.v !== undefined && cell.v !== null && String(cell.v) !== '') totalCells += 1;
    }
    if (totalCells > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxNonEmptyCells) throw workbookError('ENERGY_FLOW_WORKBOOK_CELL_LIMIT_EXCEEDED', '完整能流工作簿非空单元格总数超过限制。', 413);
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: true });
    const headers = (matrix[0] || []).map((value) => String(value ?? ''));
    if (headers.length !== sheet.headers.length || headers.some((header, index) => header !== sheet.headers[index])) throw workbookError('ENERGY_FLOW_WORKBOOK_HEADERS_MISMATCH', `完整能流工作簿“${sheet.name}”表头必须精确匹配。`, 400, { sheetName: sheet.name, rowNumber: 1 });
    totalText += headers.reduce((sum, item) => sum + item.length, 0);
    const rows = [];
    for (let matrixIndex = 1; matrixIndex < matrix.length; matrixIndex += 1) {
      const values = sheet.headers.map((header, columnIndex) => {
        const display = normalizeWorkbookText(matrix[matrixIndex]?.[columnIndex]);
        const cell = worksheet[XLSX.utils.encode_cell({ r: matrixIndex, c: columnIndex })];
        if (NUMERIC_COLUMNS[sheet.name]?.has(columnIndex)) return cell && cell.t === 'n' && cell.v !== undefined ? cell.v : display;
        if (display && cell?.t === 'n') throw workbookError('ENERGY_FLOW_WORKBOOK_TEXT_CELL_REQUIRED', '完整能流工作簿编码和普通文本必须使用文本单元格。', 400, { sheetName: sheet.name, rowNumber: matrixIndex + 1, fieldName: header });
        return display;
      });
      totalText += values.reduce((sum, item) => sum + String(item ?? '').length, 0);
      if (totalText > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxWorkbookTextCharacters) throw workbookError('ENERGY_FLOW_WORKBOOK_TEXT_BUDGET_EXCEEDED', '完整能流工作簿业务文本总字符数超过限制。', 413);
      if (values.some((value) => !isWorkbookBlank(value))) rows.push({ rowNumber: matrixIndex + 1, values });
    }
    if (rows.length > sheet.maxDataRows) throw workbookError('ENERGY_FLOW_WORKBOOK_ROW_LIMIT_EXCEEDED', `完整能流工作簿“${sheet.name}”数据行数超过限制。`, 413);
    totalRows += rows.length;
    if (totalRows > ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxWorkbookRows) throw workbookError('ENERGY_FLOW_WORKBOOK_TOTAL_ROW_LIMIT_EXCEEDED', '完整能流工作簿总数据行数超过限制。', 413);
    parsed[sheet.key] = rows;
  }
  return parsed;
}

/** 打开服务数据库，测试可注入隔离 SQLite 连接。 */
function openWorkbookDatabase(options = {}) {
  if (options.db) return { db: options.db, shouldClose: false };
  const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
  return { db: openDatabase(), shouldClose: true };
}

/** 解析正安全批次 ID。 */
function normalizeBatchId(value) {
  const text = String(value ?? '').trim();
  const numberValue = Number(text);
  if (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(numberValue)) throw badRequest('batchId 必须是正安全整数。', { code: 'ENERGY_FLOW_WORKBOOK_BATCH_ID_INVALID' });
  return numberValue;
}

/** 按固定列读取对象数组，并为每行保留工作表行号。 */
function mapRows(parsed, sheetName, key) {
  return (parsed[key] || []).map((row) => mapWorkbookRow(sheetName, row));
}

/** 规范化可空文本并在 NFKC 后复核长度。 */
function normalizeOptionalWorkbookText(issues, rowNumber, fieldName, value, maxLength) {
  const text = normalizeWorkbookText(value);
  if (text.normalize('NFKC').trim().length > maxLength) pushIssue(issues, createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_FIELD_TOO_LONG', `${fieldName} 超过 ${maxLength} 个字符。`, value));
  return text;
}

/** 将问题压入受限列表；超过问题预算直接作为资源失败。 */
function pushIssue(issues, issue) {
  if (issues.length >= ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxIssues) throw workbookError('ENERGY_FLOW_WORKBOOK_ISSUE_LIMIT_EXCEEDED', '完整能流工作簿问题数量超过限制。', 413);
  issues.push(issue);
}

/** 构造跨表引用映射并拒绝同一规范键重复。 */
function buildUniqueIndex(rows, fieldName, label, issues, keyBuilder = (row) => normalizeWorkbookKey(row[fieldName])) {
  const index = new Map();
  rows.forEach((row) => {
    const key = keyBuilder(row);
    if (!key) return;
    if (index.has(key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NORMALIZED_KEY_COLLISION', `${label}规范键重复，不能覆盖或合并。`, row[fieldName]));
    else index.set(key, row);
  });
  return index;
}

/** 校验损耗基准单位是否可使用唯一且完整覆盖期间的折标因子比较。 */
function validateBenchmarkUnitComparability(db, referenceIndexes, record, evidence, issues) {
  if (normalizeWorkbookKey(record.unit) === normalizeWorkbookKey(evidence.benchmarkUnit)) return;
  const energyRows = referenceIndexes.energyTypes.get(record.energyTypeKey) || [];
  if (energyRows.length !== 1) {
    pushIssue(issues, createWorkbookIssue(evidence.sourceRowNumber, '基准损耗单位', 'ENERGY_FLOW_WORKBOOK_CONVERSION_FACTOR_AMBIGUOUS', '能源类型规范键不唯一，无法确认折标因子。', evidence.benchmarkUnit, 'warning'));
    return;
  }
  const factorRows = db.prepare(`SELECT source_unit AS sourceUnit FROM energy_conversion_factors WHERE energy_type_id = ? AND status = 'active' AND effective_start_utc <= ? AND effective_end_utc >= ?`).all(energyRows[0].id, record.startUtc, record.endUtc);
  [record.unit, evidence.benchmarkUnit].forEach((unit) => {
    const count = factorRows.filter((factor) => normalizeWorkbookKey(factor.sourceUnit) === normalizeWorkbookKey(unit)).length;
    if (count === 0) pushIssue(issues, createWorkbookIssue(evidence.sourceRowNumber, '基准损耗单位', 'ENERGY_FLOW_WORKBOOK_CONVERSION_FACTOR_MISSING', '基准与事实单位不同时，两侧单位都必须有完整覆盖期间的唯一有效折标因子。', unit, 'warning'));
    if (count > 1) pushIssue(issues, createWorkbookIssue(evidence.sourceRowNumber, '基准损耗单位', 'ENERGY_FLOW_WORKBOOK_CONVERSION_FACTOR_AMBIGUOUS', '折标因子存在歧义，不能静默选择。', unit, 'warning'));
  });
}

/** 对显式图执行非推断型质量检查，只报告有向环、孤立节点和多弱连通分量。 */
function appendGraphQualityWarnings(nodes, edges, issues) {
  const activeNodes = nodes.filter((node) => node.status === 'active');
  const activeNodeKeys = new Set(activeNodes.map((node) => node.codeKey));
  const activeEdges = edges.filter((edge) => edge.status === 'active' && activeNodeKeys.has(edge.fromNodeKey) && activeNodeKeys.has(edge.toNodeKey));
  const outgoing = new Map(activeNodes.map((node) => [node.codeKey, []]));
  const undirected = new Map(activeNodes.map((node) => [node.codeKey, new Set()]));
  activeEdges.forEach((edge) => {
    outgoing.get(edge.fromNodeKey).push(edge.toNodeKey);
    undirected.get(edge.fromNodeKey).add(edge.toNodeKey);
    undirected.get(edge.toNodeKey).add(edge.fromNodeKey);
  });
  const isolated = activeNodes.filter((node) => undirected.get(node.codeKey).size === 0);
  if (isolated.length) pushIssue(issues, createWorkbookIssue(isolated[0].sourceRowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_ISOLATED_NODE_WARNING', `存在 ${isolated.length} 个 active 孤立节点。`, isolated.map((node) => node.code).slice(0, 20), 'warning'));
  const visited = new Set();
  let components = 0;
  activeNodes.forEach((node) => {
    if (visited.has(node.codeKey)) return;
    components += 1;
    const queue = [node.codeKey];
    let queueIndex = 0;
    visited.add(node.codeKey);
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      undirected.get(current).forEach((next) => { if (!visited.has(next)) { visited.add(next); queue.push(next); } });
    }
  });
  if (components > 1) pushIssue(issues, createWorkbookIssue(activeNodes[0]?.sourceRowNumber || 1, '节点编码', 'ENERGY_FLOW_WORKBOOK_MULTIPLE_COMPONENTS_WARNING', `active 显式图包含 ${components} 个弱连通分量。`, components, 'warning'));
  const colors = new Map();
  let hasCycle = false;
  function visit(nodeKey) {
    colors.set(nodeKey, 1);
    for (const next of outgoing.get(nodeKey) || []) {
      if (colors.get(next) === 1) return true;
      if (!colors.has(next) && visit(next)) return true;
    }
    colors.set(nodeKey, 2);
    return false;
  }
  for (const node of activeNodes) {
    if (!colors.has(node.codeKey) && visit(node.codeKey)) { hasCycle = true; break; }
  }
  if (hasCycle) pushIssue(issues, createWorkbookIssue(activeEdges[0]?.sourceRowNumber || 1, '边编码', 'ENERGY_FLOW_WORKBOOK_DIRECTED_CYCLE_WARNING', 'active 显式图包含有向环；服务端不会自动拆环或改边。', null, 'warning'));
}

/** 读取能源类型和组织单元索引，所有引用必须显式命中。 */
function loadWorkbookReferenceIndexes(db) {
  const energyTypes = new Map();
  db.prepare('SELECT id, code, name FROM energy_types WHERE is_active = 1').all().forEach((row) => {
    const key = normalizeWorkbookKey(row.code);
    if (!energyTypes.has(key)) energyTypes.set(key, []);
    energyTypes.get(key).push(row);
  });
  const organizations = new Map();
  db.prepare("SELECT id, unit_code AS code, unit_name AS name, status FROM organization_units WHERE status = 'active'").all().forEach((row) => {
    const key = normalizeWorkbookKey(row.code);
    if (!organizations.has(key)) organizations.set(key, []);
    organizations.get(key).push(row);
  });
  return { energyTypes, organizations };
}

/** 校验外部业务编码恰好解析为一条 active 记录，拒绝缺失和规范键歧义。 */
function validateUniqueReference(referenceMap, key, issues, rowNumber, fieldName, rawValue, label) {
  if (!key) return null;
  const matches = referenceMap.get(key) || [];
  if (matches.length === 0) {
    pushIssue(issues, createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', `${label}不存在或未启用。`, rawValue));
    return null;
  }
  if (matches.length !== 1) {
    pushIssue(issues, createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_REFERENCE_AMBIGUOUS', `${label}规范键不唯一，不能静默选择。`, rawValue));
    return null;
  }
  return matches[0];
}

/** 规范化六表业务数据并生成单一统一工作簿候选。 */
function buildWorkbookDomainPreview(db, parsed) {
  const issues = [];
  const models = mapRows(parsed, '模型', 'models');
  const assetsNodes = mapRows(parsed, '设备资产与节点', 'assetsNodes');
  const edges = mapRows(parsed, '有向边', 'edges');
  const records = mapRows(parsed, '期间流量', 'records');
  const wasteHeat = mapRows(parsed, '余热事实', 'wasteHeat');
  const lossEvidence = mapRows(parsed, '损耗证据', 'lossEvidence');
  if (models.length !== 1) pushIssue(issues, createWorkbookIssue(1, '模型', 'ENERGY_FLOW_WORKBOOK_MODEL_ROW_COUNT_INVALID', '模型工作表必须恰好包含一行数据。', models.length));
  if (assetsNodes.length < 1) pushIssue(issues, createWorkbookIssue(1, '设备资产与节点', 'ENERGY_FLOW_WORKBOOK_DATA_ROWS_REQUIRED', '设备资产与节点工作表至少需要一行数据。', assetsNodes.length));
  if (edges.length < 1) pushIssue(issues, createWorkbookIssue(1, '有向边', 'ENERGY_FLOW_WORKBOOK_DATA_ROWS_REQUIRED', '有向边工作表至少需要一行数据。', edges.length));
  if (records.length < 1) pushIssue(issues, createWorkbookIssue(1, '期间流量', 'ENERGY_FLOW_WORKBOOK_DATA_ROWS_REQUIRED', '期间流量工作表至少需要一行数据。', records.length));
  const modelRaw = models[0] || {};
  const modelCode = normalizeWorkbookCode(issues, modelRaw.rowNumber || 2, '模型编码', modelRaw.模型编码);
  const version = normalizeWorkbookVersion(issues, modelRaw.rowNumber || 2, modelRaw.版本);
  const model = {
    sourceRowNumber: modelRaw.rowNumber || 2,
    templateId: normalizeWorkbookText(modelRaw.模板标识),
    templateVersion: normalizeWorkbookText(modelRaw.模板版本),
    modelCode: modelCode.value,
    modelCodeKey: modelCode.key,
    modelName: requireWorkbookText(issues, modelRaw.rowNumber || 2, '模型名称', modelRaw.模型名称, 300),
    source: requireWorkbookText(issues, modelRaw.rowNumber || 2, '来源', modelRaw.来源, 1000),
    documentNo: normalizeOptionalWorkbookText(issues, modelRaw.rowNumber || 2, '文号', modelRaw.文号, 300),
    version,
    ...normalizeWorkbookWallClockRange(issues, modelRaw.rowNumber || 2, modelRaw.生效开始时间, modelRaw.生效结束时间, modelRaw.来源时区, '模型生效区间'),
    classificationStatus: normalizeWorkbookText(modelRaw.分类状态),
    sourceMode: normalizeWorkbookText(modelRaw.来源模式),
    status: assertWorkbookEnum(issues, modelRaw.rowNumber || 2, '状态', modelRaw.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses)
  };
  if (model.templateId !== ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE) pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '模板标识', 'ENERGY_FLOW_WORKBOOK_TEMPLATE_ID_INVALID', '模板标识必须是 energy-flow-workbook。', model.templateId));
  if (model.templateVersion !== ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION) pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '模板版本', 'ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION_INVALID', '模板版本必须是 1.0。', model.templateVersion));
  if (model.classificationStatus !== 'workbook_facts') pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '分类状态', 'ENERGY_FLOW_WORKBOOK_CLASSIFICATION_INVALID', '完整能流工作簿分类状态必须是 workbook_facts。', model.classificationStatus));
  if (model.sourceMode !== 'workbook_facts_only') pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '来源模式', 'ENERGY_FLOW_WORKBOOK_SOURCE_MODE_INVALID', '完整能流工作簿来源模式必须是 workbook_facts_only。', model.sourceMode));
  if (model.status !== 'active') pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '状态', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', '完整工作簿期间事实固定以 active 写入，因此模型状态必须是 active。', model.status));

  const assetRows = assetsNodes.filter((row) => normalizeWorkbookText(row.行类型) === 'asset');
  const nodeRows = assetsNodes.filter((row) => normalizeWorkbookText(row.行类型) === 'node');
  assetsNodes.filter((row) => !ENERGY_FLOW_WORKBOOK_ENUMS.rowTypes.includes(normalizeWorkbookText(row.行类型))).forEach((row) => pushIssue(issues, createWorkbookIssue(row.rowNumber, '行类型', 'ENERGY_FLOW_WORKBOOK_ENUM_INVALID', '行类型必须是 asset 或 node。', row.行类型)));
  const assetIndex = buildUniqueIndex(assetRows, '设备资产编码', '设备资产编码', issues);
  const nodeIndex = buildUniqueIndex(nodeRows, '节点编码', '节点编码', issues);
  const assets = assetRows.map((row) => {
    const rowModelCode = normalizeWorkbookCode(issues, row.rowNumber, '模型编码', row.模型编码);
    if (rowModelCode.key !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(row.rowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '设备资产模型编码必须与模型工作表一致。'));
    const code = normalizeWorkbookCode(issues, row.rowNumber, '设备资产编码', row.设备资产编码);
    ['节点编码', '节点名称', '节点类型', '关联设备资产编码', '阶段代码', '组织单元编码', '横坐标', '纵坐标'].forEach((fieldName) => { if (!isWorkbookBlank(row[fieldName])) pushIssue(issues, createWorkbookIssue(row.rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'asset 行不得填写 node 行字段。', row[fieldName])); });
    return { sourceRowNumber: row.rowNumber, code: code.value, codeKey: code.key, name: requireWorkbookText(issues, row.rowNumber, '设备资产名称', row.设备资产名称, 300), type: assertWorkbookEnum(issues, row.rowNumber, '设备资产类型', row.设备资产类型, ENERGY_FLOW_WORKBOOK_ENUMS.assetTypes), status: assertWorkbookEnum(issues, row.rowNumber, '状态', row.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses) };
  });
  const nodes = nodeRows.map((row) => {
    const rowModelCode = normalizeWorkbookCode(issues, row.rowNumber, '模型编码', row.模型编码);
    if (rowModelCode.key !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(row.rowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '节点模型编码必须与模型工作表一致。'));
    const code = normalizeWorkbookCode(issues, row.rowNumber, '节点编码', row.节点编码);
    ['设备资产编码', '设备资产名称', '设备资产类型'].forEach((fieldName) => { if (!isWorkbookBlank(row[fieldName])) pushIssue(issues, createWorkbookIssue(row.rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'node 行不得填写 asset 行字段。', row[fieldName])); });
    const assetCode = normalizeWorkbookCode(issues, row.rowNumber, '关联设备资产编码', row.关联设备资产编码, 128, false);
    const stageCode = assertWorkbookEnum(issues, row.rowNumber, '阶段代码', row.阶段代码, ENERGY_FLOW_WORKBOOK_ENUMS.stageCodes, true);
    const x = normalizeWorkbookNumber(issues, row.rowNumber, '横坐标', row.横坐标, { maxAbs: 1e9 });
    const y = normalizeWorkbookNumber(issues, row.rowNumber, '纵坐标', row.纵坐标, { maxAbs: 1e9 });
    if ((x === null) !== (y === null)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '横坐标/纵坐标', 'ENERGY_FLOW_WORKBOOK_COORDINATE_PAIR_REQUIRED', '横坐标和纵坐标必须同时填写或同时留空。'));
    if (assetCode.key && !assetIndex.has(assetCode.key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '关联设备资产编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '节点关联的设备资产编码不存在。', row.关联设备资产编码));
    return { sourceRowNumber: row.rowNumber, code: code.value, codeKey: code.key, name: requireWorkbookText(issues, row.rowNumber, '节点名称', row.节点名称, 300), type: assertWorkbookEnum(issues, row.rowNumber, '节点类型', row.节点类型, ENERGY_FLOW_WORKBOOK_ENUMS.nodeTypes), assetCode: assetCode.value, assetCodeKey: assetCode.key, stageCode, organizationUnitCode: normalizeOptionalWorkbookText(issues, row.rowNumber, '组织单元编码', row.组织单元编码, 128), x, y, status: assertWorkbookEnum(issues, row.rowNumber, '状态', row.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses) };
  });
  const refIndexes = loadWorkbookReferenceIndexes(db);
  nodes.forEach((node) => {
    if (node.organizationUnitCode) validateUniqueReference(refIndexes.organizations, normalizeWorkbookKey(node.organizationUnitCode), issues, node.sourceRowNumber, '组织单元编码', node.organizationUnitCode, '组织单元编码');
    const linkedAsset = assets.find((asset) => asset.codeKey === node.assetCodeKey);
    if (node.status === 'active' && node.assetCodeKey && (!linkedAsset || linkedAsset.status !== 'active')) {
      pushIssue(issues, createWorkbookIssue(node.sourceRowNumber, '关联设备资产编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active 节点只能引用 active 设备资产。', node.assetCode));
    }
  });

  const pathIndex = new Map();
  const edgeIndex = buildUniqueIndex(edges, '边编码', '边编码', issues);
  const edgeModels = edges.map((row) => {
    const path = normalizeWorkbookCode(issues, row.rowNumber, '路径编码', row.路径编码);
    const edge = normalizeWorkbookCode(issues, row.rowNumber, '边编码', row.边编码);
    const fromNode = normalizeWorkbookCode(issues, row.rowNumber, '起点节点编码', row.起点节点编码);
    const toNode = normalizeWorkbookCode(issues, row.rowNumber, '终点节点编码', row.终点节点编码);
    const sequence = normalizeWorkbookNumber(issues, row.rowNumber, '路径顺序', row.路径顺序, { integer: true, required: true });
    const sourceType = normalizeWorkbookText(row.来源类型);
    if (sourceType !== 'workbook_fact') pushIssue(issues, createWorkbookIssue(row.rowNumber, '来源类型', 'ENERGY_FLOW_WORKBOOK_SOURCE_TYPE_INVALID', '完整能流工作簿有向边来源类型必须是 workbook_fact。', sourceType));
    if (fromNode.key && toNode.key && fromNode.key === toNode.key) pushIssue(issues, createWorkbookIssue(row.rowNumber, '起点节点编码/终点节点编码', 'ENERGY_FLOW_WORKBOOK_SELF_LOOP_REJECTED', '有向边不允许自环。'));
    if (!nodeIndex.has(fromNode.key) || !nodeIndex.has(toNode.key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '起点节点编码/终点节点编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '有向边起点和终点必须引用同一工作簿节点。', row.起点节点编码 || row.终点节点编码));
    const fromNodeModel = nodes.find((node) => node.codeKey === fromNode.key);
    const toNodeModel = nodes.find((node) => node.codeKey === toNode.key);
    const edgeStatus = assertWorkbookEnum(issues, row.rowNumber, '状态', row.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses);
    if (edgeStatus === 'active' && ((!fromNodeModel || fromNodeModel.status !== 'active') || (!toNodeModel || toNodeModel.status !== 'active'))) pushIssue(issues, createWorkbookIssue(row.rowNumber, '起点节点编码/终点节点编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active 有向边只能引用 active 节点。', row.起点节点编码 || row.终点节点编码));
    validateUniqueReference(refIndexes.energyTypes, normalizeWorkbookKey(row.能源类型编码), issues, row.rowNumber, '能源类型编码', row.能源类型编码, '能源类型编码');
    if (sequence !== null && sequence !== undefined && sequence > 0) {
      const pathKey = path.key;
      const old = pathIndex.get(pathKey);
      if (old && (old.name !== normalizeWorkbookText(row.路径名称))) pushIssue(issues, createWorkbookIssue(row.rowNumber, '路径名称', 'ENERGY_FLOW_WORKBOOK_PATH_METADATA_CONFLICT', '同一路径编码的路径名称必须一致。', row.路径名称));
      if (!old) pathIndex.set(pathKey, { code: path.value, key: pathKey, name: normalizeWorkbookText(row.路径名称), rows: [] });
      pathIndex.get(pathKey).rows.push({ sequence, fromNodeKey: fromNode.key, toNodeKey: toNode.key, rowNumber: row.rowNumber });
    }
    return { sourceRowNumber: row.rowNumber, modelCodeKey: normalizeWorkbookKey(row.模型编码), pathCode: path.value, pathCodeKey: path.key, pathName: requireWorkbookText(issues, row.rowNumber, '路径名称', row.路径名称, 300), sequence, code: edge.value, codeKey: edge.key, fromNodeCode: fromNode.value, fromNodeKey: fromNode.key, toNodeCode: toNode.value, toNodeKey: toNode.key, energyTypeCode: normalizeWorkbookText(row.能源类型编码), energyTypeKey: normalizeWorkbookKey(row.能源类型编码), unit: requireWorkbookText(issues, row.rowNumber, '单位', row.单位, 100), sourceType, sourceReference: normalizeOptionalWorkbookText(issues, row.rowNumber, '来源引用', row.来源引用, 1000) || null, status: edgeStatus };
  });
  edgeModels.forEach((edge) => { if (edge.modelCodeKey !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(edge.sourceRowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '有向边模型编码必须与模型工作表一致。')); });
  pathIndex.forEach((path) => {
    const rows = [...path.rows].sort((left, right) => left.sequence - right.sequence);
    const seen = new Set();
    rows.forEach((item, index) => {
      if (seen.has(item.sequence) || item.sequence !== index + 1) pushIssue(issues, createWorkbookIssue(item.rowNumber, '路径顺序', 'ENERGY_FLOW_WORKBOOK_PATH_SEQUENCE_INVALID', '每条路径的路径顺序必须从 1 连续递增且不得重复。', item.sequence));
      seen.add(item.sequence);
      if (index > 0 && rows[index - 1].toNodeKey !== item.fromNodeKey) pushIssue(issues, createWorkbookIssue(item.rowNumber, '起点节点编码', 'ENERGY_FLOW_WORKBOOK_PATH_DISCONTINUITY', '路径相邻边必须首尾连续。'));
    });
  });

  const recordIndex = buildUniqueIndex(records, '记录编码', '记录编码', issues);
  const recordModels = records.map((row) => {
    const record = normalizeWorkbookCode(issues, row.rowNumber, '记录编码', row.记录编码);
    const role = assertWorkbookEnum(issues, row.rowNumber, '事实角色', row.事实角色, ENERGY_FLOW_WORKBOOK_ENUMS.recordRoles);
    const edge = normalizeWorkbookCode(issues, row.rowNumber, '边编码', row.边编码, 128, role === 'edge_flow');
    const node = normalizeWorkbookCode(issues, row.rowNumber, '节点编码', row.节点编码, 128, role === 'storage_change');
    const path = normalizeWorkbookCode(issues, row.rowNumber, '路径编码', row.路径编码, 128, role === 'edge_flow');
    const asset = normalizeWorkbookCode(issues, row.rowNumber, '设备资产编码', row.设备资产编码, 128, false);
    const stage = assertWorkbookEnum(issues, row.rowNumber, '阶段代码', row.阶段代码, ENERGY_FLOW_WORKBOOK_ENUMS.stageCodes);
    const range = normalizeWorkbookWallClockRange(issues, row.rowNumber, row.期间开始时间, row.期间结束时间, row.来源时区, '期间');
    const value = normalizeWorkbookNumber(issues, row.rowNumber, '数值', row.数值, { maxAbs: 1e15, maxDecimals: 9, min: role === 'edge_flow' ? 0 : undefined, required: true });
    const energyType = normalizeWorkbookCode(issues, row.rowNumber, '能源类型编码', row.能源类型编码);
    if (role === 'edge_flow' && !isWorkbookBlank(row.节点编码)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'edge_flow 事实不得填写节点编码。', row.节点编码));
    if (role === 'storage_change') {
      ['边编码', '路径编码', '设备资产编码'].forEach((fieldName) => { if (!isWorkbookBlank(row[fieldName])) pushIssue(issues, createWorkbookIssue(row.rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'storage_change 事实不得填写边、路径或设备资产编码。', row[fieldName])); });
    }
    if (role === 'edge_flow' && (!edgeIndex.has(edge.key) || !pathIndex.has(path.key))) pushIssue(issues, createWorkbookIssue(row.rowNumber, '边编码/路径编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '边流事实必须引用存在的边和路径。'));
    const referencedEdge = edgeModels.find((item) => item.codeKey === edge.key);
    const referencedNode = nodes.find((item) => item.codeKey === node.key);
    if (role === 'edge_flow' && (!referencedEdge || referencedEdge.status !== 'active')) pushIssue(issues, createWorkbookIssue(row.rowNumber, '边编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active edge_flow 事实只能引用 active 有向边。', row.边编码));
    if (role === 'storage_change' && !nodeIndex.has(node.key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '储能变化事实必须引用存在的节点。', row.节点编码));
    if (role === 'storage_change' && (!referencedNode || referencedNode.status !== 'active')) pushIssue(issues, createWorkbookIssue(row.rowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active storage_change 事实只能引用 active 节点。', row.节点编码));
    validateUniqueReference(refIndexes.energyTypes, energyType.key, issues, row.rowNumber, '能源类型编码', row.能源类型编码, '能源类型编码');
    if (role === 'edge_flow') {
      const edgeModel = edgeModels.find((item) => item.codeKey === edge.key);
      if (edgeModel && (edgeModel.pathCodeKey !== path.key || edgeModel.energyTypeKey !== energyType.key || edgeModel.unit !== normalizeWorkbookText(row.单位))) pushIssue(issues, createWorkbookIssue(row.rowNumber, '边编码/路径编码/能源类型编码/单位', 'ENERGY_FLOW_WORKBOOK_FACT_METADATA_CONFLICT', '期间流量必须与有向边的路径、能源类型和单位一致。'));
    }
    if ((stage === 'device_input' || stage === 'useful_output') && !asset.key) pushIssue(issues, createWorkbookIssue(row.rowNumber, '设备资产编码', 'ENERGY_FLOW_WORKBOOK_ASSET_REQUIRED', 'device_input/useful_output 事实必须显式引用设备资产。'));
    if (asset.key && !assetIndex.has(asset.key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '设备资产编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '期间流量设备资产编码不存在。', row.设备资产编码));
    const referencedAsset = assets.find((item) => item.codeKey === asset.key);
    if (asset.key && (!referencedAsset || referencedAsset.status !== 'active')) pushIssue(issues, createWorkbookIssue(row.rowNumber, '设备资产编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active 期间流量只能引用 active 设备资产。', row.设备资产编码));
    if (node.key && !nodeIndex.has(node.key)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '期间流量节点编码不存在。', row.节点编码));
    return { sourceRowNumber: row.rowNumber, code: record.value, codeKey: record.key, modelCodeKey: normalizeWorkbookKey(row.模型编码), role, edgeCode: edge.value, edgeCodeKey: edge.key, nodeCode: node.value, nodeCodeKey: node.key, pathCode: path.value, pathCodeKey: path.key, assetCode: asset.value, assetCodeKey: asset.key, stageCode: stage, ...range, energyTypeCode: energyType.value, energyTypeKey: energyType.key, value, unit: requireWorkbookText(issues, row.rowNumber, '单位', row.单位, 100), sourceReference: requireWorkbookText(issues, row.rowNumber, '来源引用', row.来源引用, 1000), status: 'active' };
  });
  recordModels.forEach((record) => {
    if (record.modelCodeKey !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(record.sourceRowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '期间流量模型编码必须与模型工作表一致。'));
    if (record.startUtc && record.endUtc && model.startUtc && model.endUtc && (record.startUtc < model.startUtc || record.endUtc > model.endUtc)) pushIssue(issues, createWorkbookIssue(record.sourceRowNumber, '期间开始时间/期间结束时间', 'ENERGY_FLOW_WORKBOOK_PERIOD_OUTSIDE_MODEL', '期间流量必须完整落在模型生效区间内。'));
    if (record.role === 'storage_change') {
      const node = nodes.find((item) => item.codeKey === record.nodeCodeKey);
      if (node && node.type !== 'storage') pushIssue(issues, createWorkbookIssue(record.sourceRowNumber, '节点编码', 'ENERGY_FLOW_WORKBOOK_STORAGE_NODE_REQUIRED', 'storage_change 事实必须引用 storage 节点。'));
    }
  });
  const overlapGroups = new Map();
  recordModels.forEach((record) => {
    if (!record.startUtc || !record.endUtc) return;
    const key = record.role === 'edge_flow'
      ? `edge:${record.edgeCodeKey}`
      : `node:${record.nodeCodeKey}:${record.energyTypeKey}:${normalizeWorkbookKey(record.unit)}`;
    if (!overlapGroups.has(key)) overlapGroups.set(key, []);
    overlapGroups.get(key).push(record);
  });
  overlapGroups.forEach((group) => {
    group.sort((left, right) => left.startUtc.localeCompare(right.startUtc) || left.endUtc.localeCompare(right.endUtc) || left.sourceRowNumber - right.sourceRowNumber);
    let maxEndUtc = null;
    group.forEach((item) => {
      if (maxEndUtc && item.startUtc < maxEndUtc) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '期间开始时间', 'ENERGY_FLOW_WORKBOOK_PERIOD_OVERLAP', '同一显式分面期间不得重叠。'));
      if (!maxEndUtc || item.endUtc > maxEndUtc) maxEndUtc = item.endUtc;
    });
  });

  const wasteModels = wasteHeat.map((row) => {
    const code = normalizeWorkbookCode(issues, row.rowNumber, '余热事实编码', row.余热事实编码);
    const record = normalizeWorkbookCode(issues, row.rowNumber, '关联期间记录编码', row.关联期间记录编码);
    const modelCode = normalizeWorkbookCode(issues, row.rowNumber, '模型编码', row.模型编码);
    const linkedRecord = recordModels.find((item) => item.codeKey === record.key);
    if (linkedRecord && (linkedRecord.role !== 'edge_flow' || linkedRecord.stageCode !== 'waste_heat' || linkedRecord.status !== 'active')) pushIssue(issues, createWorkbookIssue(row.rowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_WASTE_HEAT_RECORD_INVALID', '余热事实必须引用 active、stage_code=waste_heat 的 edge_flow 期间记录。'));
    return { sourceRowNumber: row.rowNumber, code: code.value, codeKey: code.key, recordCode: record.value, recordCodeKey: record.key, role: assertWorkbookEnum(issues, row.rowNumber, '余热角色', row.余热角色, ENERGY_FLOW_WORKBOOK_ENUMS.wasteHeatRoles), sourceReference: normalizeOptionalWorkbookText(issues, row.rowNumber, '来源引用', row.来源引用, 1000) || null, status: assertWorkbookEnum(issues, row.rowNumber, '状态', row.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses), modelCodeKey: modelCode.key };
  });
  const lossFacts = [];
  const evidenceModels = [];
  lossEvidence.forEach((row) => {
    const rowType = assertWorkbookEnum(issues, row.rowNumber, '行类型', row.行类型, ENERGY_FLOW_WORKBOOK_ENUMS.lossRowTypes);
    const rowModelCode = normalizeWorkbookCode(issues, row.rowNumber, '模型编码', row.模型编码);
    const lossCode = normalizeWorkbookCode(issues, row.rowNumber, '损耗事实编码', row.损耗事实编码);
    const status = assertWorkbookEnum(issues, row.rowNumber, '状态', row.状态, ENERGY_FLOW_WORKBOOK_ENUMS.statuses);
    const note = normalizeOptionalWorkbookText(issues, row.rowNumber, '备注', row.备注, 2000);
    if (rowType === 'loss_fact') {
      const record = normalizeWorkbookCode(issues, row.rowNumber, '关联期间记录编码', row.关联期间记录编码);
      const lossRole = assertWorkbookEnum(issues, row.rowNumber, '损耗事实角色', row.损耗事实角色, ENERGY_FLOW_WORKBOOK_ENUMS.lossFactRoles);
      ['证据编码', '证据角色', '证据名称', '证据类型', '证据引用', '证据开始时间', '证据结束时间', '来源时区', '基准损耗值', '基准损耗单位'].forEach((fieldName) => { if (!isWorkbookBlank(row[fieldName])) pushIssue(issues, createWorkbookIssue(row.rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'loss_fact 行不得填写证据字段。', row[fieldName])); });
      const linkedRecord = recordModels.find((item) => item.codeKey === record.key);
      if (linkedRecord && (linkedRecord.role !== 'edge_flow' || linkedRecord.stageCode !== 'loss' || linkedRecord.status !== 'active')) pushIssue(issues, createWorkbookIssue(row.rowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_LOSS_RECORD_INVALID', '损耗事实必须引用 active、stage_code=loss 的 edge_flow 期间记录。'));
      lossFacts.push({ sourceRowNumber: row.rowNumber, code: lossCode.value, codeKey: lossCode.key, recordCode: record.value, recordCodeKey: record.key, role: lossRole, modelCodeKey: rowModelCode.key, status, note });
      return;
    }
    if (rowType === 'evidence') {
      if (!isWorkbookBlank(row.关联期间记录编码) || !isWorkbookBlank(row.损耗事实角色)) pushIssue(issues, createWorkbookIssue(row.rowNumber, '关联期间记录编码/损耗事实角色', 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'evidence 行不得填写关联期间记录编码或损耗事实角色。'));
      const evidence = normalizeWorkbookCode(issues, row.rowNumber, '证据编码', row.证据编码);
      const evidenceRole = assertWorkbookEnum(issues, row.rowNumber, '证据角色', row.证据角色, ENERGY_FLOW_WORKBOOK_ENUMS.evidenceRoles);
      const evidenceType = assertWorkbookEnum(issues, row.rowNumber, '证据类型', row.证据类型, ENERGY_FLOW_WORKBOOK_ENUMS.evidenceTypes);
      const range = normalizeWorkbookWallClockRange(issues, row.rowNumber, row.证据开始时间, row.证据结束时间, row.来源时区, '证据');
      const benchmarkValue = normalizeWorkbookNumber(issues, row.rowNumber, '基准损耗值', row.基准损耗值, { min: 0, maxAbs: 1e15, required: evidenceRole === 'benchmark' });
      const benchmarkUnit = normalizeOptionalWorkbookText(issues, row.rowNumber, '基准损耗单位', row.基准损耗单位, 100);
      if (evidenceRole === 'benchmark' && !benchmarkUnit) pushIssue(issues, createWorkbookIssue(row.rowNumber, '基准损耗单位', 'ENERGY_FLOW_WORKBOOK_REQUIRED_FIELD_MISSING', 'benchmark 证据必须填写基准损耗单位。'));
      if (evidenceRole === 'fact_evidence' && (!isWorkbookBlank(row.基准损耗值) || !isWorkbookBlank(row.基准损耗单位))) pushIssue(issues, createWorkbookIssue(row.rowNumber, '基准损耗值/基准损耗单位', 'ENERGY_FLOW_WORKBOOK_MUTUALLY_EXCLUSIVE_FIELDS', 'fact_evidence 不得填写基准损耗值和单位。'));
      evidenceModels.push({ sourceRowNumber: row.rowNumber, code: evidence.value, codeKey: evidence.key, lossCode: lossCode.value, lossCodeKey: lossCode.key, evidenceRole, name: requireWorkbookText(issues, row.rowNumber, '证据名称', row.证据名称, 300), type: evidenceType, reference: requireWorkbookText(issues, row.rowNumber, '证据引用', row.证据引用, 1000), ...range, benchmarkValue: evidenceRole === 'benchmark' ? benchmarkValue : null, benchmarkUnit: evidenceRole === 'benchmark' ? benchmarkUnit : null, status, note, modelCodeKey: rowModelCode.key });
    }
  });
  const wasteIndex = buildUniqueIndex(wasteModels, 'code', '余热事实编码', issues, (row) => row.codeKey);
  const lossIndex = buildUniqueIndex(lossFacts, 'code', '损耗事实编码', issues, (row) => row.codeKey);
  const evidenceIndex = buildUniqueIndex(evidenceModels, 'code', '证据编码', issues, (row) => row.codeKey);
  wasteModels.forEach((item) => {
    if (item.modelCodeKey !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '余热事实模型编码必须与模型工作表一致。'));
    if (!recordIndex.has(item.recordCodeKey)) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '余热事实引用的期间记录不存在。'));
    if (item.status === 'active' && wasteModels.some((other) => other !== item && other.status === 'active' && other.recordCodeKey === item.recordCodeKey)) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_RECORD_DUPLICATED', '同一 active 期间记录最多绑定一个 active 余热事实。'));
  });
  lossFacts.forEach((item) => {
    if (item.modelCodeKey !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '损耗事实模型编码必须与模型工作表一致。'));
    if (!recordIndex.has(item.recordCodeKey)) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '损耗事实引用的期间记录不存在。'));
    if (item.status === 'active' && lossFacts.some((other) => other !== item && other.status === 'active' && other.recordCodeKey === item.recordCodeKey)) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '关联期间记录编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_RECORD_DUPLICATED', '同一 active 期间记录最多绑定一个 active 损耗事实。'));
  });
  evidenceModels.forEach((item) => {
    if (item.modelCodeKey !== model.modelCodeKey) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '模型编码', 'ENERGY_FLOW_WORKBOOK_CROSS_MODEL_REFERENCE', '损耗证据模型编码必须与模型工作表一致。'));
    const lossFact = lossFacts.find((loss) => loss.codeKey === item.lossCodeKey);
    if (!lossFact) {
      pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '损耗事实编码', 'ENERGY_FLOW_WORKBOOK_REFERENCE_NOT_FOUND', '损耗证据引用的损耗事实不存在。'));
      return;
    }
    if (item.status === 'active' && lossFact.status !== 'active') {
      pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '损耗事实编码', 'ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID', 'active 损耗证据只能引用 active 损耗事实。', item.lossCode));
    }
    const linkedRecord = recordModels.find((record) => record.codeKey === lossFact.recordCodeKey);
    if (!linkedRecord || !item.startUtc || !item.endUtc) return;
    if (item.evidenceRole === 'fact_evidence' && item.status === 'active' && (item.startUtc > linkedRecord.startUtc || item.endUtc < linkedRecord.endUtc)) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '证据开始时间/证据结束时间', 'ENERGY_FLOW_WORKBOOK_FACT_EVIDENCE_COVERAGE_INVALID', 'active fact_evidence 必须完整覆盖所绑损耗事实期间。'));
    if (item.evidenceRole === 'benchmark' && item.status === 'active') {
      if (item.startUtc !== linkedRecord.startUtc || item.endUtc !== linkedRecord.endUtc) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '证据开始时间/证据结束时间', 'ENERGY_FLOW_WORKBOOK_BENCHMARK_PERIOD_MISMATCH', 'active benchmark 必须与损耗事实使用完全相同的 UTC 区间。'));
      const activeBenchmarks = evidenceModels.filter((other) => other.lossCodeKey === item.lossCodeKey && other.evidenceRole === 'benchmark' && other.status === 'active');
      if (activeBenchmarks.length > 1) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '证据角色', 'ENERGY_FLOW_WORKBOOK_ACTIVE_BENCHMARK_DUPLICATED', '同一损耗事实最多一个 active benchmark。'));
      validateBenchmarkUnitComparability(db, refIndexes, linkedRecord, item, issues);
    }
  });
  lossFacts.forEach((item) => { if (item.status === 'active' && !evidenceModels.some((evidence) => evidence.lossCodeKey === item.codeKey && evidence.evidenceRole === 'fact_evidence' && evidence.status === 'active')) pushIssue(issues, createWorkbookIssue(item.sourceRowNumber, '损耗事实编码', 'ENERGY_FLOW_WORKBOOK_LOSS_EVIDENCE_MISSING', 'active 损耗事实缺少有效 active fact_evidence 证据。', item.code, 'warning')); });
  appendGraphQualityWarnings(nodes, edgeModels, issues);
  const existingModel = db.prepare('SELECT id FROM energy_flow_models WHERE normalize_energy_flow_key(model_code) = ? AND normalize_energy_flow_key(version) = ? LIMIT 1').get(model.modelCodeKey, normalizeWorkbookKey(model.version));
  if (existingModel) pushIssue(issues, createWorkbookIssue(model.sourceRowNumber, '模型编码/版本', 'ENERGY_FLOW_WORKBOOK_DATABASE_KEY_COLLISION', '数据库中已存在相同模型编码和版本，完整工作簿不会覆盖或合并。', `${model.modelCode}/${model.version}`));
  // 只产生一个候选，候选内部携带九张事实表的规范数据。
  const candidate = { candidateRowId: `workbook:${model.modelCodeKey}:${normalizeWorkbookKey(model.version)}`, model, assets, nodes, paths: [...pathIndex.values()].map((path) => ({ sourceRowNumber: path.rows[0]?.rowNumber, code: path.code, codeKey: path.key, name: path.name })), edges: edgeModels, records: recordModels, wasteHeat: wasteModels, lossFacts, lossEvidence: evidenceModels };
  const blockers = issues.filter((issue) => issue.severity !== 'warning');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const candidateRows = blockers.length ? [] : [candidate];
  const summary = { totalRows: models.length + assetsNodes.length + edges.length + records.length + wasteHeat.length + lossEvidence.length, wouldImport: candidateRows.length, blocked: blockers.length ? 1 : 0, skipped: 0, warnings: warnings.length, errors: blockers.length };
  return { candidateRows, summary, issues, workbook: candidate, warnings, blockers };
}

/** 为批次安全链生成服务端审计快照。 */
function secureWorkbookPreview(domainPreview, fileSha256, secret) {
  const candidateRows = normalizeCandidateRows(domainPreview.candidateRows || []);
  const previewAudit = { version: 'energy-flow-workbook-import:v1:preview-audit', templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, templateVersion: ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], duplicateStrategy: ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY, fileSha256, summary: domainPreview.summary, items: [], auditIssues: domainPreview.issues };
  const previewSignature = buildEnergyAnalysisImportPreviewSignature({ templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, fileSha256, candidateRows }, secret);
  const previewAuditDigest = buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, secret);
  return { ...domainPreview, dryRun: true, previewOnly: true, writesBusinessRecords: false, templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, templateVersion: ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], confirmText: ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT, backupReason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, duplicateStrategy: ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY, requireBackup: true, fileSha256, candidateRows, candidateRowIds: candidateRows.map((row) => row.candidateRowId), expectedWouldImport: candidateRows.length, previewAudit, previewSignature, previewAuditDigest };
}

/** 从请求中解析并规范化唯一允许的 execute 字段。 */
function assertWorkbookExecuteBody(body) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const allowed = new Set(['batchId', 'confirmText', 'requireBackup', 'acknowledgeSkippedRisks']);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length) throw badRequest('完整能流工作簿 execute 请求体包含未允许字段。', { code: 'ENERGY_FLOW_WORKBOOK_EXECUTE_EXTRA_FIELDS_REJECTED', fields: extra });
  if (request.confirmText !== ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT) throw badRequest('固定中文确认文本不匹配。', { code: 'ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT_MISMATCH' });
  if (request.requireBackup !== true) throw badRequest('requireBackup 必须显式为 true。', { code: 'ENERGY_FLOW_WORKBOOK_BACKUP_REQUIRED' });
  if (request.acknowledgeSkippedRisks !== true) throw badRequest('acknowledgeSkippedRisks 必须显式为 true。', { code: 'ENERGY_FLOW_WORKBOOK_SKIPPED_RISKS_ACK_REQUIRED' });
  return { batchId: normalizeBatchId(request.batchId), confirmText: request.confirmText, requireBackup: true, acknowledgeSkippedRisks: true };
}

/** 原子读取安装级 HMAC 密钥。 */
function resolveWorkbookSecret(db, options = {}) {
  return resolveEnergyAnalysisImportHmacSecret({ env: options.env || process.env, readAppMeta: (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value, persistAppMeta: (key, value) => { db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO NOTHING").run(key, value); return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value; }, randomBytes: options.randomBytes });
}

/** 将六表候选按 canonical 九表顺序写入数据库，并返回导入 ID 摘要。 */
function insertWorkbookCandidate(db, batchId, candidate, options = {}) {
  const modelResult = db.prepare(`INSERT INTO energy_flow_models (source_batch_id, source_row_number, model_code, model_name, source, document_no, version, effective_start_wall_clock, effective_end_wall_clock, effective_start_utc, effective_end_utc, source_timezone, classification_status, source_mode, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workbook_facts', 'workbook_facts_only', ?)`).run(batchId, candidate.model.sourceRowNumber, candidate.model.modelCode, candidate.model.modelName, candidate.model.source, candidate.model.documentNo || null, candidate.model.version, candidate.model.startWallClock, candidate.model.endWallClock, candidate.model.startUtc, candidate.model.endUtc, candidate.model.sourceTimezone, candidate.model.status);
  const modelId = Number(modelResult.lastInsertRowid);
  const assetIds = new Map();
  const insertAsset = db.prepare('INSERT INTO energy_flow_assets (source_batch_id, source_row_number, energy_flow_model_id, asset_code, asset_name, asset_type, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  candidate.assets.forEach((asset) => { const result = insertAsset.run(batchId, asset.sourceRowNumber, modelId, asset.code, asset.name, asset.type, asset.status); assetIds.set(asset.codeKey, Number(result.lastInsertRowid)); });
  const pathIds = new Map();
  const insertPath = db.prepare('INSERT INTO energy_flow_paths (source_batch_id, source_row_number, energy_flow_model_id, path_code, path_name, status) VALUES (?, ?, ?, ?, ?, ?)');
  candidate.paths.forEach((path) => { const result = insertPath.run(batchId, path.sourceRowNumber, modelId, path.code, path.name, 'active'); pathIds.set(path.codeKey, Number(result.lastInsertRowid)); });
  const organizationIds = new Map();
  db.prepare("SELECT id, unit_code AS code FROM organization_units WHERE status = 'active'").all().forEach((row) => organizationIds.set(normalizeWorkbookKey(row.code), Number(row.id)));
  const nodeIds = new Map();
  const insertNode = db.prepare('INSERT INTO energy_flow_nodes (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_asset_id, node_code, node_name, node_type, stage_code, organization_unit_id, x, y, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  candidate.nodes.forEach((node) => { const result = insertNode.run(batchId, node.sourceRowNumber, modelId, node.assetCodeKey ? assetIds.get(node.assetCodeKey) : null, node.code, node.name, node.type, node.stageCode || null, node.organizationUnitCode ? organizationIds.get(normalizeWorkbookKey(node.organizationUnitCode)) : null, node.x, node.y, node.status); nodeIds.set(node.codeKey, Number(result.lastInsertRowid)); });
  const energyTypeIds = new Map();
  db.prepare('SELECT id, code FROM energy_types WHERE is_active = 1').all().forEach((row) => energyTypeIds.set(normalizeWorkbookKey(row.code), Number(row.id)));
  const edgeIds = new Map();
  const insertEdge = db.prepare('INSERT INTO energy_flow_edges (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_path_id, path_sequence, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_reference, source_mapping_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'workbook_fact\', ?, NULL, ?)');
  candidate.edges.forEach((edge) => { const result = insertEdge.run(batchId, edge.sourceRowNumber, modelId, pathIds.get(edge.pathCodeKey), edge.sequence, edge.code, nodeIds.get(edge.fromNodeKey), nodeIds.get(edge.toNodeKey), energyTypeIds.get(edge.energyTypeKey), edge.unit, edge.sourceReference, edge.status); edgeIds.set(edge.codeKey, Number(result.lastInsertRowid)); });
  const recordIds = new Map();
  const insertRecord = db.prepare('INSERT INTO energy_flow_records (source_batch_id, source_row_number, energy_flow_model_id, record_code, record_role, energy_flow_edge_id, energy_flow_node_id, energy_flow_path_id, energy_flow_asset_id, stage_code, energy_type_id, start_wall_clock, end_wall_clock, start_utc, end_utc, source_timezone, original_unit, original_value, source_type, source_reference, source_mapping_json, formula_version, record_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'workbook_fact\', ?, NULL, NULL, \'active\')');
  candidate.records.forEach((record) => { const result = insertRecord.run(batchId, record.sourceRowNumber, modelId, record.code, record.role, record.role === 'edge_flow' ? edgeIds.get(record.edgeCodeKey) : null, record.role === 'storage_change' ? nodeIds.get(record.nodeCodeKey) : null, record.role === 'edge_flow' ? pathIds.get(record.pathCodeKey) : null, record.assetCodeKey ? assetIds.get(record.assetCodeKey) : null, record.stageCode, energyTypeIds.get(record.energyTypeKey), record.startWallClock, record.endWallClock, record.startUtc, record.endUtc, record.sourceTimezone, record.unit, record.value, record.sourceReference); recordIds.set(record.codeKey, Number(result.lastInsertRowid)); });
  const insertWaste = db.prepare('INSERT INTO energy_flow_waste_heat_facts (source_batch_id, source_row_number, energy_flow_model_id, waste_heat_code, energy_flow_record_id, waste_heat_role, source_reference, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const wasteIds = []; candidate.wasteHeat.forEach((item) => { const result = insertWaste.run(batchId, item.sourceRowNumber, modelId, item.code, recordIds.get(item.recordCodeKey), item.role, item.sourceReference, item.status); wasteIds.push(Number(result.lastInsertRowid)); });
  const lossIds = new Map();
  const insertLoss = db.prepare('INSERT INTO energy_flow_loss_facts (source_batch_id, source_row_number, energy_flow_model_id, loss_fact_code, energy_flow_record_id, loss_fact_role, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  candidate.lossFacts.forEach((item) => { const result = insertLoss.run(batchId, item.sourceRowNumber, modelId, item.code, recordIds.get(item.recordCodeKey), item.role, item.status, item.note || null); lossIds.set(item.codeKey, Number(result.lastInsertRowid)); });
  const insertEvidence = db.prepare('INSERT INTO energy_flow_loss_evidence (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_loss_fact_id, evidence_code, evidence_role, evidence_name, evidence_type, evidence_reference, evidence_start_wall_clock, evidence_end_wall_clock, evidence_start_utc, evidence_end_utc, source_timezone, benchmark_loss_value, benchmark_loss_unit, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const evidenceIds = []; candidate.lossEvidence.forEach((item) => { const result = insertEvidence.run(batchId, item.sourceRowNumber, modelId, lossIds.get(item.lossCodeKey), item.code, item.evidenceRole, item.name, item.type, item.reference, item.startWallClock, item.endWallClock, item.startUtc, item.endUtc, item.sourceTimezone, item.benchmarkValue, item.benchmarkUnit, item.status, item.note || null); evidenceIds.push(Number(result.lastInsertRowid)); });
  return { modelId, assetIds: [...assetIds.values()], nodeIds: [...nodeIds.values()], pathIds: [...pathIds.values()], edgeIds: [...edgeIds.values()], recordIds: [...recordIds.values()], wasteIds, lossIds: [...lossIds.values()], evidenceIds };
}

/** 在事务内重新解析当前文件、验签、备份、写事实、写操作审计和 execute 审计。 */
async function executeEnergyFlowWorkbookImport(body = {}, options = {}) {
  const request = assertWorkbookExecuteBody(body);
  const context = openWorkbookDatabase(options);
  let backup = null;
  try {
    const batch = getImportAuditBatchDetail(request.batchId, { db: context.db, includeIssues: false });
    if (batch.importType !== ENERGY_FLOW_WORKBOOK_IMPORT_TYPE) throw badRequest('批次不是完整能流工作簿 preview 批次。', { code: 'ENERGY_FLOW_WORKBOOK_BATCH_TYPE_INVALID' });
    if (batch.auditPhase !== 'preview' || !['completed', 'completed_with_errors'].includes(batch.status)) throw badRequest('完整能流工作簿 preview 批次当前不可执行。', { code: 'ENERGY_FLOW_WORKBOOK_BATCH_NOT_EXECUTABLE' });
    const secret = resolveWorkbookSecret(context.db, options);
    if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) {
      throw badRequest('完整能流工作簿执行必须提供有效正整数操作者。', { code: 'ENERGY_FLOW_WORKBOOK_ACTOR_REQUIRED' });
    }
    const safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, batch.storedFilename, { expectedSizeBytes: batch.fileSizeBytes, maxSizeBytes: ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes });
    if (safeFile.fileSha256 !== batch.fileSha256) throw badRequest('服务端原文件已被篡改。', { code: 'ENERGY_FLOW_WORKBOOK_FILE_SHA256_MISMATCH' });
    const parseAndBuild = (fileSnapshot, originalFilename) => buildWorkbookDomainPreview(context.db, parseEnergyFlowWorkbookXlsx(fileSnapshot.buffer, originalFilename));
    const recomputed = secureWorkbookPreview(parseAndBuild(safeFile, batch.originalFilename), safeFile.fileSha256, secret);
    const persistedContext = batch.auditContext || {};
    const trustedCandidateRows = normalizeCandidateRows(persistedContext.candidateRows || []);
    const authorization = authorizeEnergyAnalysisImportExecute({ templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], confirmText: request.confirmText, backupReason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, duplicateStrategy: ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY, requireBackup: true, acknowledgeSkippedRisks: request.acknowledgeSkippedRisks, fileSha256: batch.fileSha256, previewSignature: batch.previewSignature, previewAuditDigest: batch.previewAuditDigest, expectedWouldImport: trustedCandidateRows.length, candidateRowIds: trustedCandidateRows.map((row) => row.candidateRowId), candidateRows: trustedCandidateRows, expectedBatchId: request.batchId, batch: { id: batch.id, status: batch.status, auditPhase: batch.auditPhase, importType: batch.importType, templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], fileSha256: batch.fileSha256, previewSignature: batch.previewSignature, previewAuditDigest: batch.previewAuditDigest } }, { secret, fileBuffer: safeFile.buffer, recomputedCandidateRows: recomputed.candidateRows, previewAudit: recomputed.previewAudit });
    if (!authorization.valid) throw badRequest('完整能流工作簿 preview 安全链校验失败。', { code: authorization.errors[0]?.code || 'ENERGY_FLOW_WORKBOOK_AUTHORIZATION_FAILED' });
    if (!recomputed.candidateRows.length) throw badRequest('完整能流工作簿没有可执行事实。', { code: 'ENERGY_FLOW_WORKBOOK_EMPTY_CANDIDATES' });
    context.db.exec('BEGIN IMMEDIATE');
    let transactionActive = true;
    try {
      const latestBatch = getImportAuditBatchDetail(request.batchId, { db: context.db, includeIssues: false });
      if (latestBatch.auditPhase !== 'preview'
        || latestBatch.status !== batch.status
        || latestBatch.importType !== batch.importType
        || latestBatch.storedFilename !== batch.storedFilename
        || latestBatch.fileSizeBytes !== batch.fileSizeBytes
        || latestBatch.fileSha256 !== batch.fileSha256
        || latestBatch.previewSignature !== batch.previewSignature
        || latestBatch.previewAuditDigest !== batch.previewAuditDigest
        || stableSerialize((latestBatch.auditContext || {}).candidateRows || []) !== stableSerialize((batch.auditContext || {}).candidateRows || [])) {
        throw badRequest('完整能流工作簿批次已发生 stale 变化。', { code: 'ENERGY_FLOW_WORKBOOK_BATCH_STALE' });
      }
      const latestSafeFile = readSafeUploadFile(
        options.uploadsDir || defaultUploadsDir,
        latestBatch.storedFilename,
        {
          expectedSizeBytes: latestBatch.fileSizeBytes,
          maxSizeBytes: ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes,
          afterFileOpen: options.afterExecuteLockFileOpen
        }
      );
      if (latestSafeFile.fileSha256 !== latestBatch.fileSha256 || latestSafeFile.fileSha256 !== safeFile.fileSha256) {
        throw badRequest('服务端原文件已被篡改。', { code: 'ENERGY_FLOW_WORKBOOK_FILE_SHA256_MISMATCH' });
      }
      const latestPreview = secureWorkbookPreview(parseAndBuild(latestSafeFile, latestBatch.originalFilename), latestSafeFile.fileSha256, secret);
      const latestPersistedCandidates = normalizeCandidateRows((latestBatch.auditContext || {}).candidateRows || []);
      const latestAuthorization = authorizeEnergyAnalysisImportExecute({ templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], confirmText: request.confirmText, backupReason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, duplicateStrategy: ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY, requireBackup: true, acknowledgeSkippedRisks: request.acknowledgeSkippedRisks, fileSha256: latestBatch.fileSha256, previewSignature: latestBatch.previewSignature, previewAuditDigest: latestBatch.previewAuditDigest, expectedWouldImport: latestPersistedCandidates.length, candidateRows: latestPersistedCandidates, candidateRowIds: latestPersistedCandidates.map((row) => row.candidateRowId), expectedBatchId: request.batchId, batch: { id: latestBatch.id, status: latestBatch.status, auditPhase: latestBatch.auditPhase, importType: latestBatch.importType, templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], fileSha256: latestBatch.fileSha256, previewSignature: latestBatch.previewSignature, previewAuditDigest: latestBatch.previewAuditDigest } }, { secret, fileBuffer: latestSafeFile.buffer, recomputedCandidateRows: latestPreview.candidateRows, previewAudit: latestPreview.previewAudit });
      if (!latestAuthorization.valid) throw badRequest('完整能流工作簿锁内重算与 preview 不一致。', { code: latestAuthorization.errors[0]?.code || 'ENERGY_FLOW_WORKBOOK_LOCK_RECALC_MISMATCH' });
      const createBackup = typeof options.createBackup === 'function' ? options.createBackup : backupService.createBackup;
      try {
        backup = await createBackup({ reason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, skipCheckpoint: true });
      } catch (_error) {
        throw new AppError('ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED', '完整能流工作簿在线备份失败，未写入业务事实。', {
          statusCode: 503,
          details: { code: 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED' }
        });
      }
      const insertion = insertWorkbookCandidate(context.db, request.batchId, latestPreview.candidateRows[0], options);
      if (typeof options.auditWriter === 'function') options.auditWriter(context.db, { userId: options.actorUserId, operation: 'energy-flow-workbook.import.execute', targetType: 'energy_flow_model', targetId: insertion.modelId, detail: { batchId: request.batchId, imported: insertion.recordIds.length }, ip: options.actorIp });
      else insertOperationLogWithDb(context.db, { userId: options.actorUserId, operation: 'energy-flow-workbook.import.execute', targetType: 'energy_flow_model', targetId: insertion.modelId, detail: { batchId: request.batchId, imported: insertion.recordIds.length }, ip: options.actorIp });
      const auditBatch = updateExecuteAuditResult(request.batchId, { status: 'completed', statistics: { totalRows: latestPreview.summary.totalRows, successCount: 1, failureCount: 0, skippedCount: 0 }, executeResult: { executed: true, writesBusinessRecords: true, imported: 1, importedFactCounts: { models: 1, assets: insertion.assetIds.length, nodes: insertion.nodeIds.length, paths: insertion.pathIds.length, edges: insertion.edgeIds.length, records: insertion.recordIds.length, wasteHeat: insertion.wasteIds.length, lossFacts: insertion.lossIds.length, lossEvidence: insertion.evidenceIds.length }, backup: { reason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, method: backup?.method || null, sizeBytes: backup?.sizeBytes || null, createdAt: backup?.createdAt || null } }, backup, errorSummary: null }, { db: context.db });
      if (options.demoContext) {
        markDemoContextExecutedInTransaction({
          db: context.db,
          ...options.demoContext,
          uploadFileSha256: latestSafeFile.fileSha256,
          previewDigest: latestPreview.previewAuditDigest,
          batchBindings: [{ batchId: request.batchId, batchRole: 'primary' }]
        });
      }
      context.db.exec('COMMIT'); transactionActive = false;
      return projectEnergyFlowWorkbookPublicDto({ executed: true, writesBusinessRecords: true, batchId: request.batchId, imported: 1, importedFactCounts: { models: 1, assets: insertion.assetIds.length, nodes: insertion.nodeIds.length, paths: insertion.pathIds.length, edges: insertion.edgeIds.length, records: insertion.recordIds.length, wasteHeat: insertion.wasteIds.length, lossFacts: insertion.lossIds.length, lossEvidence: insertion.evidenceIds.length }, auditBatch: getImportAuditSummary(auditBatch.id, { db: context.db }) });
    } catch (error) {
      if (transactionActive && context.db.inTransaction) context.db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (context.shouldClose) context.db.close();
  }
}

/** 判断错误是否属于必须零批次返回的工作簿资源失败。 */
function isWorkbookResourceError(error) {
  return Number(error?.statusCode || error?.status) === 413
    || error?.details?.code === 'ENERGY_ANALYSIS_UPLOAD_FILE_TOO_LARGE';
}

/** 将安全读取入口的上传大小错误统一映射为工作簿 413。 */
function normalizeWorkbookResourceError(error) {
  if (error?.details?.code === 'ENERGY_ANALYSIS_UPLOAD_FILE_TOO_LARGE') {
    return workbookError('ENERGY_FLOW_WORKBOOK_UPLOAD_SIZE_EXCEEDED', '完整能流工作簿上传文件超过 10 MiB 限制。', 413);
  }
  return error;
}

/** 将非资源安全或结构错误转换为可持久化的单批次失败预演。 */
function buildFailedWorkbookPreview(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  const issueCode = details.code || error?.code || 'ENERGY_FLOW_WORKBOOK_INVALID';
  const issue = createWorkbookIssue(Number.isSafeInteger(details.rowNumber) && details.rowNumber > 0 ? details.rowNumber : 1, details.fieldName || details.sheetName || '工作簿', issueCode, error?.message || '完整能流工作簿未通过安全或结构校验。');
  // 结构级失败没有业务数据行，用一个候选级失败行满足统一审计统计约束。
  const summary = { totalRows: 1, wouldImport: 0, blocked: 1, skipped: 0, warnings: 0, errors: 1 };
  return { candidateRows: [], summary, issues: [issue], workbook: null, warnings: [], blockers: [issue] };
}

/** 持久化 preview 批次和问题；领域失败保留服务端原文件，资源失败不创建批次。 */
function persistWorkbookPreview(file, preview, safeFile, db) {
  const status = preview.summary.errors > 0 ? 'failed' : 'completed';
  const totalRows = preview.summary.totalRows;
  const failureCount = totalRows > 0 ? Math.min(totalRows, preview.summary.blocked) : 0;
  const batch = createPreviewAuditBatch({ importType: ENERGY_FLOW_WORKBOOK_IMPORT_TYPE, originalFilename: file.originalname, storedFilename: file.filename, fileType: 'xlsx', fileSizeBytes: safeFile.sizeBytes, fileSha256: safeFile.fileSha256, status, auditPhase: 'preview', duplicateStrategy: ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY, previewSignature: preview.previewSignature, previewAuditDigest: preview.previewAuditDigest, auditContext: { templateType: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, templateVersion: ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION, operation: ENERGY_FLOW_WORKBOOK_OPERATION, recordKind: ENERGY_FLOW_WORKBOOK_RECORD_KIND, importTypes: [ENERGY_FLOW_WORKBOOK_IMPORT_TYPE], confirmText: ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT, backupReason: ENERGY_FLOW_WORKBOOK_BACKUP_REASON, summary: preview.summary, candidateRows: preview.candidateRows, previewAudit: preview.previewAudit }, statistics: { totalRows, successCount: preview.summary.wouldImport, failureCount, skippedCount: 0 }, errorSummary: preview.summary.errors ? '完整能流工作簿预演存在阻断问题。' : null }, { db });
  replaceImportAuditIssuesWithDatabase(db, batch.id, preview.issues || []);
  return batch;
}

/** 创建六表 preview，资源失败在持久化前抛出并由路由清理文件。 */
function previewEnergyFlowWorkbookImport(file, options = {}) {
  if (!file || !file.originalname || !file.filename) throw badRequest('请上传完整能流工作簿文件。', { code: 'ENERGY_FLOW_WORKBOOK_FILE_REQUIRED' });
  const context = openWorkbookDatabase(options);
  try {
    let safeFile;
    try {
      safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, file.filename, { expectedSizeBytes: file.size, maxSizeBytes: ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes, afterFileOpen: options.afterPreviewFileOpen });
    } catch (error) {
      throw normalizeWorkbookResourceError(error);
    }
    const secret = resolveWorkbookSecret(context.db, options);
    let previewBuild;
    try {
      const parsed = parseEnergyFlowWorkbookXlsx(safeFile.buffer, file.originalname);
      previewBuild = buildWorkbookDomainPreview(context.db, parsed);
    } catch (error) {
      if (isWorkbookResourceError(error)) throw normalizeWorkbookResourceError(error);
      previewBuild = buildFailedWorkbookPreview(error);
    }
    const preview = secureWorkbookPreview(previewBuild, safeFile.fileSha256, secret);
    context.db.exec('BEGIN IMMEDIATE');
    try {
      const batch = persistWorkbookPreview(file, preview, safeFile, context.db);
      if (options.demoContext) {
        bindDemoContextPreviewInTransaction({
          db: context.db,
          ...options.demoContext,
          uploadFileSha256: safeFile.fileSha256,
          previewDigest: preview.previewAuditDigest,
          batchBindings: [{ batchId: batch.id, batchRole: 'primary' }]
        });
      }
      context.db.exec('COMMIT');
      return projectEnergyFlowWorkbookPublicDto({ ...preview, batchId: batch.id, auditBatch: getImportAuditSummary(batch.id, { db: context.db }) });
    } catch (error) {
      if (context.db.inTransaction) context.db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (context.shouldClose) context.db.close();
  }
}

/** 供路由预检复用的无数据库严格 XLSX 解析入口。 */
function preflightEnergyFlowWorkbookUpload(file, options = {}) {
  const safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, file.filename, { expectedSizeBytes: file.size, maxSizeBytes: ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes });
  parseEnergyFlowWorkbookXlsx(safeFile.buffer, file.originalname);
  return true;
}

module.exports = {
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  buildWorkbookDomainPreview,
  executeEnergyFlowWorkbookImport,
  parseEnergyFlowWorkbookXlsx,
  preflightEnergyFlowWorkbookUpload,
  previewEnergyFlowWorkbookImport,
  projectEnergyFlowWorkbookPublicDto,
  validateEnergyFlowWorkbookXlsxArchive
};
