const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const zlib = require('zlib');
const { parse } = require('csv-parse/sync');
const xlsx = require('xlsx');
const { badRequest } = require('../../utils/errors');

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const MAX_IMPORT_DATA_ROWS = 5000;
const MAX_IMPORT_COLUMNS = 100;
const MAX_CSV_RECORD_SIZE_BYTES = 64 * 1024;
const SIGNATURE_READ_BYTES = 8;
// 通用导入文件压缩体积上限与能源分析模板安全口径保持一致。
const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// XLSX ZIP 中央目录条目上限与能源分析模板安全口径保持一致。
const MAX_XLSX_ZIP_ENTRIES = 256;
// XLSX ZIP 总解压字节上限与能源分析模板安全口径保持一致。
const MAX_XLSX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
// ZIP 中央目录结束记录允许的最大注释长度。
const MAX_ZIP_COMMENT_BYTES = 65535;
// Excel 声明工作表范围最多允许的物理行数，给 5000 条非空数据和合理空白行保留余量。
const MAX_EXCEL_DECLARED_ROWS = 10000;
// Excel 声明范围最多允许的逻辑单元格数，防止稀疏小文件触发超大矩阵遍历。
const MAX_EXCEL_LOGICAL_CELLS = 600000;
// ZIP 通用标志中的数据描述符、传统加密和强加密位。
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_STRONG_ENCRYPTION_FLAG = 0x0040;
// CSV 严格 UTF-8 解码器拒绝非法字节序列，同时兼容 UTF-8 BOM。
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
// CRC32 查找表用于核对 ZIP 条目实际解压内容，避免接受中央目录伪造值。
const CRC32_TABLE = new Uint32Array(256);
for (let tableIndex = 0; tableIndex < CRC32_TABLE.length; tableIndex += 1) {
  let tableValue = tableIndex;
  for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
    tableValue = (tableValue & 1) !== 0 ? (0xedb88320 ^ (tableValue >>> 1)) : (tableValue >>> 1);
  }
  CRC32_TABLE[tableIndex] = tableValue >>> 0;
}

function getFileExtension(filename) {
  return path.extname(filename || '').toLowerCase();
}

function assertSupportedImportFile(filename) {
  const extension = getFileExtension(filename);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw badRequest('仅支持 .xlsx、.xls、.csv 表格文件。', {
      code: 'UNSUPPORTED_IMPORT_FILE_TYPE',
      filename,
      supportedFileTypes: Array.from(SUPPORTED_EXTENSIONS)
    });
  }
  return extension.slice(1);
}

function getImportParseLimits() {
  return {
    maxDataRows: MAX_IMPORT_DATA_ROWS,
    maxColumns: MAX_IMPORT_COLUMNS,
    maxCsvRecordSizeBytes: MAX_CSV_RECORD_SIZE_BYTES,
    maxFileSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES,
    maxXlsxZipEntries: MAX_XLSX_ZIP_ENTRIES,
    maxXlsxUncompressedBytes: MAX_XLSX_UNCOMPRESSED_BYTES,
    maxExcelDeclaredRows: MAX_EXCEL_DECLARED_ROWS,
    maxExcelLogicalCells: MAX_EXCEL_LOGICAL_CELLS
  };
}

function assertColumnLimit(columns, source) {
  const columnCount = Array.isArray(columns) ? columns.length : Number(columns || 0);
  if (columnCount > MAX_IMPORT_COLUMNS) {
    throw badRequest(`导入文件列数超过上限，当前最多支持 ${MAX_IMPORT_COLUMNS} 列。`, {
      code: 'IMPORT_COLUMN_LIMIT_EXCEEDED',
      source,
      columnCount,
      maxColumns: MAX_IMPORT_COLUMNS
    });
  }
}

function assertRowLimit(rows, source) {
  const rowCount = Array.isArray(rows) ? rows.length : Number(rows || 0);
  if (rowCount > MAX_IMPORT_DATA_ROWS) {
    throw badRequest(`导入文件数据行数超过上限，当前最多支持 ${MAX_IMPORT_DATA_ROWS} 行。`, {
      code: 'IMPORT_ROW_LIMIT_EXCEEDED',
      source,
      rowCount,
      maxDataRows: MAX_IMPORT_DATA_ROWS
    });
  }
}

/**
 * 将解析输入规范化为零复制 Buffer 视图，避免仅为签名检查复制完整文件。
 * @param {Buffer|Uint8Array} input 原始导入文件内容。
 * @returns {Buffer} 文件 Buffer 或共享底层内存的 Buffer 视图。
 */
function normalizeImportBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw badRequest('导入文件内容必须是 Buffer 或 Uint8Array。', {
    code: 'INVALID_IMPORT_BUFFER'
  });
}

/**
 * 读取文件前八字节签名，供兼容的文件路径校验入口使用。
 * @param {string} filePath 导入文件路径。
 * @returns {Buffer} 文件签名字节。
 */
function readFileSignature(filePath) {
  const buffer = Buffer.alloc(SIGNATURE_READ_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, SIGNATURE_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 校验 Buffer 的真实文件头是否与声明扩展名一致。
 * @param {Buffer|Uint8Array} input 原始导入文件内容。
 * @param {string} extension 不含点号的文件扩展名。
 * @returns {true} 校验通过。
 */
function assertBufferSignature(input, extension) {
  const signature = input.subarray(0, SIGNATURE_READ_BYTES);
  if (signature.length === 0) {
    throw badRequest('导入文件为空，无法解析。', {
      code: 'EMPTY_IMPORT_FILE',
      extension
    });
  }

  const isZip = signature[0] === 0x50 && signature[1] === 0x4b;
  const isCompoundFile = signature.length >= 8
    && signature[0] === 0xd0
    && signature[1] === 0xcf
    && signature[2] === 0x11
    && signature[3] === 0xe0
    && signature[4] === 0xa1
    && signature[5] === 0xb1
    && signature[6] === 0x1a
    && signature[7] === 0xe1;

  if (extension === 'xlsx' && !isZip) {
    throw badRequest('Excel .xlsx 文件头无效，请上传真实的 .xlsx 表格文件。', {
      code: 'INVALID_EXCEL_FILE_SIGNATURE',
      extension,
      firstBytes: Array.from(signature)
    });
  }

  if (extension === 'xls' && !isCompoundFile) {
    throw badRequest('Excel .xls 文件头无效，请上传真实的 .xls 表格文件。', {
      code: 'INVALID_EXCEL_FILE_SIGNATURE',
      extension,
      firstBytes: Array.from(signature)
    });
  }

  if (extension === 'csv') {
    const hasNullByte = signature.includes(0x00);
    if (isZip || isCompoundFile || hasNullByte) {
      throw badRequest('CSV 文件内容与扩展名不匹配，请上传文本格式 CSV。', {
        code: 'INVALID_CSV_FILE_SIGNATURE',
        extension,
        firstBytes: Array.from(signature)
      });
    }
  }
  return true;
}

/**
 * 校验文件路径对应内容的真实文件头。
 * @param {string} filePath 导入文件路径。
 * @param {string} extension 不含点号的文件扩展名。
 * @returns {true} 校验通过。
 */
function assertFileSignature(filePath, extension) {
  return assertBufferSignature(readFileSignature(filePath), extension);
}

/**
 * 校验导入文件压缩体积上限，避免超大文件进入 CSV 或 Excel 解析器。
 * @param {Buffer} fileBuffer 导入文件内容。
 * @returns {true} 校验通过。
 */
function assertImportFileSize(fileBuffer) {
  if (fileBuffer.length > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw badRequest('导入文件超过允许的字节上限。', {
      code: 'IMPORT_FILE_SIZE_LIMIT_EXCEEDED',
      fileSizeBytes: fileBuffer.length,
      maxFileSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES
    });
  }
  return true;
}

/**
 * 严格校验 CSV 为 UTF-8，非法字节序列和 GBK 中文必须明确拒绝。
 * @param {Buffer} fileBuffer CSV 文件内容。
 * @returns {true} 校验通过。
 */
function assertCsvUtf8Encoding(fileBuffer) {
  try {
    UTF8_DECODER.decode(fileBuffer);
  } catch (error) {
    throw badRequest('CSV 文件必须使用 UTF-8 编码，可包含 UTF-8 BOM。', {
      code: 'INVALID_CSV_UTF8_ENCODING',
      message: error.message
    });
  }
  return true;
}

/**
 * 抛出统一 Excel 损坏或容器结构错误。
 * @param {string} message 原始错误说明。
 * @returns {never} 始终抛出错误。
 */
function throwExcelParseFailed(message) {
  throw badRequest('Excel 文件解析失败，请确认文件未损坏且格式为 .xlsx 或 .xls。', {
    code: 'EXCEL_PARSE_FAILED',
    message
  });
}

/**
 * 抛出统一 XLSX ZIP 资源上限错误。
 * @param {string} limitType 上限类型。
 * @param {number} actual 实际值。
 * @param {number} limit 上限值。
 * @returns {never} 始终抛出错误。
 */
function throwExcelResourceLimitExceeded(limitType, actual, limit) {
  throw badRequest('Excel 文件超过允许的压缩资源上限。', {
    code: 'IMPORT_EXCEL_RESOURCE_LIMIT_EXCEEDED',
    limitType,
    actual,
    limit
  });
}

/**
 * 从 XLSX ZIP 文件尾部定位中央目录结束记录。
 * @param {Buffer} fileBuffer XLSX 文件内容。
 * @returns {number} 中央目录结束记录偏移量，未找到时返回 -1。
 */
function findZipEndOfCentralDirectory(fileBuffer) {
  const minimumOffset = Math.max(0, fileBuffer.length - MAX_ZIP_COMMENT_BYTES - 22);
  for (let offset = fileBuffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (fileBuffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

/**
 * 计算 Buffer 的标准 ZIP CRC32。
 * @param {Buffer} buffer 待校验内容。
 * @returns {number} 无符号 CRC32。
 */
function calculateCrc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 扫描 ZIP extra 字段并拒绝 ZIP64 扩展。
 * @param {Buffer} fileBuffer ZIP 文件内容。
 * @param {number} offset extra 字段起始偏移。
 * @param {number} length extra 字段长度。
 */
function assertNoZip64Extra(fileBuffer, offset, length) {
  const endOffset = offset + length;
  let cursor = offset;
  while (cursor < endOffset) {
    if (cursor + 4 > endOffset) {
      throwExcelParseFailed('XLSX ZIP extra 字段结构无效。');
    }
    const headerId = fileBuffer.readUInt16LE(cursor);
    const dataLength = fileBuffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + dataLength > endOffset) {
      throwExcelParseFailed('XLSX ZIP extra 字段越界。');
    }
    if (headerId === 0x0001) {
      throwExcelResourceLimitExceeded('zip64Entry', dataLength, MAX_XLSX_UNCOMPRESSED_BYTES);
    }
    cursor += dataLength;
  }
}

/**
 * 解析并核对合法的数据描述符。
 * @param {Buffer} fileBuffer ZIP 文件内容。
 * @param {number} descriptorOffset 数据描述符起始偏移。
 * @param {number} boundaryOffset 当前条目允许的结束边界。
 * @param {object} entry 中央目录条目。
 * @returns {number} 数据描述符结束偏移。
 */
function validateZipDataDescriptor(fileBuffer, descriptorOffset, boundaryOffset, entry) {
  const candidateValueOffsets = [];
  if (
    descriptorOffset + 4 <= boundaryOffset
    && fileBuffer.readUInt32LE(descriptorOffset) === 0x08074b50
  ) {
    candidateValueOffsets.push(descriptorOffset + 4);
  }
  candidateValueOffsets.push(descriptorOffset);

  for (const valueOffset of candidateValueOffsets) {
    const descriptorEnd = valueOffset + 12;
    if (descriptorEnd > boundaryOffset) {
      continue;
    }
    const descriptorCrc32 = fileBuffer.readUInt32LE(valueOffset);
    const descriptorCompressedSize = fileBuffer.readUInt32LE(valueOffset + 4);
    const descriptorUncompressedSize = fileBuffer.readUInt32LE(valueOffset + 8);
    if (
      descriptorCrc32 === entry.crc32
      && descriptorCompressedSize === entry.compressedSize
      && descriptorUncompressedSize === entry.uncompressedSize
    ) {
      return descriptorEnd;
    }
  }
  throwExcelParseFailed('XLSX ZIP 数据描述符与中央目录不一致或越界。');
}

/**
 * 严格校验中央目录普通条目后的可选数字签名记录。
 * @param {Buffer} fileBuffer ZIP 文件内容。
 * @param {number} signatureOffset 普通中央目录条目结束偏移。
 * @param {number} centralDirectoryEnd 中央目录结束偏移。
 * @returns {boolean} 是否存在合法数字签名记录。
 */
function validateOptionalZipDigitalSignature(fileBuffer, signatureOffset, centralDirectoryEnd) {
  if (signatureOffset === centralDirectoryEnd) {
    return false;
  }
  if (
    signatureOffset + 6 > centralDirectoryEnd
    || fileBuffer.readUInt32LE(signatureOffset) !== 0x05054b50
  ) {
    throwExcelParseFailed('XLSX ZIP 中央目录尾部记录无效。');
  }
  const signatureLength = fileBuffer.readUInt16LE(signatureOffset + 4);
  const signatureEnd = signatureOffset + 6 + signatureLength;
  if (signatureEnd !== centralDirectoryEnd) {
    throwExcelParseFailed('XLSX ZIP 数字签名记录截断、重复或包含多余字节。');
  }
  return true;
}

/**
 * 在 SheetJS 解压前交叉校验 XLSX ZIP 中央目录、本地头和实际解压内容。
 * @param {Buffer} fileBuffer XLSX 文件内容。
 * @returns {{entryCount:number,totalUncompressedBytes:number}} ZIP 实际资源统计。
 */
function inspectXlsxZipContainer(fileBuffer) {
  const eocdOffset = findZipEndOfCentralDirectory(fileBuffer);
  if (eocdOffset < 0 || eocdOffset + 22 > fileBuffer.length) {
    throwExcelParseFailed('XLSX ZIP 中央目录结束记录缺失。');
  }

  const diskNumber = fileBuffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = fileBuffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = fileBuffer.readUInt16LE(eocdOffset + 8);
  const entryCount = fileBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = fileBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = fileBuffer.readUInt32LE(eocdOffset + 16);
  const commentLength = fileBuffer.readUInt16LE(eocdOffset + 20);

  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
    || eocdOffset + 22 + commentLength !== fileBuffer.length
    || centralDirectoryOffset + centralDirectorySize !== eocdOffset
  ) {
    throwExcelParseFailed('XLSX ZIP 中央目录结构无效。');
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throwExcelResourceLimitExceeded('zip64', entryCount, MAX_XLSX_ZIP_ENTRIES);
  }
  if (entryCount > MAX_XLSX_ZIP_ENTRIES) {
    throwExcelResourceLimitExceeded('zipEntries', entryCount, MAX_XLSX_ZIP_ENTRIES);
  }

  const entries = [];
  const entryNames = new Set();
  let cursor = centralDirectoryOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || fileBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throwExcelParseFailed('XLSX ZIP 中央目录条目无效。');
    }
    const flags = fileBuffer.readUInt16LE(cursor + 8);
    const compressionMethod = fileBuffer.readUInt16LE(cursor + 10);
    const crc32 = fileBuffer.readUInt32LE(cursor + 16);
    const compressedSize = fileBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = fileBuffer.readUInt32LE(cursor + 24);
    const fileNameLength = fileBuffer.readUInt16LE(cursor + 28);
    const extraLength = fileBuffer.readUInt16LE(cursor + 30);
    const fileCommentLength = fileBuffer.readUInt16LE(cursor + 32);
    const diskStart = fileBuffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = fileBuffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + fileCommentLength;
    if (entryEnd > eocdOffset) {
      throwExcelParseFailed('XLSX ZIP 中央目录条目越界。');
    }
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
      || diskStart === 0xffff
    ) {
      throwExcelResourceLimitExceeded('zip64Entry', uncompressedSize, MAX_XLSX_UNCOMPRESSED_BYTES);
    }
    if (diskStart !== 0 || (flags & (ZIP_ENCRYPTED_FLAG | ZIP_STRONG_ENCRYPTION_FLAG)) !== 0) {
      throwExcelParseFailed('XLSX ZIP 不支持加密或跨磁盘条目。');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throwExcelParseFailed('XLSX ZIP 包含不支持的压缩方法。');
    }
    const fileNameOffset = cursor + 46;
    const extraOffset = fileNameOffset + fileNameLength;
    assertNoZip64Extra(fileBuffer, extraOffset, extraLength);
    declaredUncompressedBytes += uncompressedSize;
    if (declaredUncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throwExcelResourceLimitExceeded('zipUncompressedBytes', declaredUncompressedBytes, MAX_XLSX_UNCOMPRESSED_BYTES);
    }
    const fileName = fileBuffer.subarray(fileNameOffset, extraOffset);
    const fileNameKey = fileName.toString('hex');
    if (fileName.length === 0 || entryNames.has(fileNameKey)) {
      throwExcelParseFailed('XLSX ZIP 条目文件名为空或重复。');
    }
    entryNames.add(fileNameKey);
    entries.push({
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      fileName
    });
    cursor = entryEnd;
  }
  validateOptionalZipDigitalSignature(fileBuffer, cursor, eocdOffset);

  const entriesByLocalOffset = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  let previousEntryEnd = 0;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entriesByLocalOffset.length; index += 1) {
    const entry = entriesByLocalOffset[index];
    const localOffset = entry.localHeaderOffset;
    const nextBoundary = index + 1 < entriesByLocalOffset.length
      ? entriesByLocalOffset[index + 1].localHeaderOffset
      : centralDirectoryOffset;
    if (
      localOffset < previousEntryEnd
      || localOffset + 30 > centralDirectoryOffset
      || nextBoundary <= localOffset
      || fileBuffer.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throwExcelParseFailed('XLSX ZIP 本地条目偏移无效或发生重叠。');
    }

    const localFlags = fileBuffer.readUInt16LE(localOffset + 6);
    const localCompressionMethod = fileBuffer.readUInt16LE(localOffset + 8);
    const localCrc32 = fileBuffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = fileBuffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = fileBuffer.readUInt32LE(localOffset + 22);
    const localFileNameLength = fileBuffer.readUInt16LE(localOffset + 26);
    const localExtraLength = fileBuffer.readUInt16LE(localOffset + 28);
    const localFileNameOffset = localOffset + 30;
    const localExtraOffset = localFileNameOffset + localFileNameLength;
    const dataOffset = localExtraOffset + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (
      localFlags !== entry.flags
      || localCompressionMethod !== entry.compressionMethod
      || dataOffset > nextBoundary
      || dataEnd > nextBoundary
      || !fileBuffer.subarray(localFileNameOffset, localExtraOffset).equals(entry.fileName)
    ) {
      throwExcelParseFailed('XLSX ZIP 本地头与中央目录不一致。');
    }
    assertNoZip64Extra(fileBuffer, localExtraOffset, localExtraLength);

    if (
      localCompressedSize === 0xffffffff
      || localUncompressedSize === 0xffffffff
    ) {
      throwExcelResourceLimitExceeded('zip64LocalEntry', localUncompressedSize, MAX_XLSX_UNCOMPRESSED_BYTES);
    }
    if (localUncompressedSize > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throwExcelResourceLimitExceeded(
        'zipLocalUncompressedBytes',
        localUncompressedSize,
        MAX_XLSX_UNCOMPRESSED_BYTES
      );
    }

    const usesDataDescriptor = (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    let entryEnd = dataEnd;
    if (usesDataDescriptor) {
      if (
        (localCrc32 !== 0 && localCrc32 !== entry.crc32)
        || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
      ) {
        throwExcelParseFailed('XLSX ZIP 本地头数据描述符占位值无效。');
      }
      entryEnd = validateZipDataDescriptor(fileBuffer, dataEnd, nextBoundary, entry);
    } else if (
      localCrc32 !== entry.crc32
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
    ) {
      throwExcelParseFailed('XLSX ZIP 本地头大小或 CRC 与中央目录不一致。');
    }

    const compressedData = fileBuffer.subarray(dataOffset, dataEnd);
    let actualData;
    if (entry.compressionMethod === 0) {
      actualData = compressedData;
    } else {
      const remainingOutputBytes = MAX_XLSX_UNCOMPRESSED_BYTES - totalUncompressedBytes;
      try {
        actualData = zlib.inflateRawSync(compressedData, {
          maxOutputLength: Math.max(1, remainingOutputBytes)
        });
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/i.test(error?.message || '')) {
          throwExcelResourceLimitExceeded(
            'zipActualUncompressedBytes',
            MAX_XLSX_UNCOMPRESSED_BYTES + 1,
            MAX_XLSX_UNCOMPRESSED_BYTES
          );
        }
        throwExcelParseFailed(`XLSX ZIP 条目解压失败：${error.message}`);
      }
    }
    if (actualData.length > MAX_XLSX_UNCOMPRESSED_BYTES - totalUncompressedBytes) {
      throwExcelResourceLimitExceeded(
        'zipActualUncompressedBytes',
        totalUncompressedBytes + actualData.length,
        MAX_XLSX_UNCOMPRESSED_BYTES
      );
    }
    if (actualData.length !== entry.uncompressedSize) {
      throwExcelParseFailed('XLSX ZIP 条目声明大小与实际解压大小不一致。');
    }
    if (calculateCrc32(actualData) !== entry.crc32) {
      throwExcelParseFailed('XLSX ZIP 条目 CRC 校验失败。');
    }
    totalUncompressedBytes += actualData.length;
    previousEntryEnd = entryEnd;
  }
  return { entryCount, totalUncompressedBytes };
}

/**
 * 从 Buffer 解析 CSV，并执行列数、行数与单条记录大小限制。
 * @param {Buffer} fileBuffer CSV 文件内容。
 * @returns {object[]} CSV 数据行。
 */
function parseCsvBuffer(fileBuffer) {
  assertCsvUtf8Encoding(fileBuffer);
  let records;
  try {
    records = parse(fileBuffer, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: MAX_CSV_RECORD_SIZE_BYTES
    });
  } catch (error) {
    if (error && error.code === 'BAD_REQUEST') {
      throw error;
    }
    throw badRequest('CSV 文件解析失败，请确认文件为 UTF-8/带表头的文本表格。', {
      code: 'CSV_PARSE_FAILED',
      parserCode: error.code,
      message: error.message
    });
  }
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const headers = records[0];
  assertColumnLimit(headers, 'csv');
  const dataRecords = records.slice(1);
  assertRowLimit(dataRecords, 'csv');
  return dataRecords.map((record, index) => {
    assertColumnLimit(record, 'csv');
    if (record.length > headers.length) {
      throw badRequest('CSV 数据行列数不能超过表头列数。', {
        code: 'CSV_COLUMN_COUNT_MISMATCH',
        rowNumber: index + 2,
        headerColumnCount: headers.length,
        rowColumnCount: record.length
      });
    }
    const normalizedRecord = record.length < headers.length
      ? [...record, ...Array(headers.length - record.length).fill('')]
      : record;
    return headers.reduce((row, header, columnIndex) => {
      row[header] = normalizedRecord[columnIndex];
      return row;
    }, {});
  });
}

/**
 * 在工作表对象化前限制声明范围，避免稀疏小文件触发超大逻辑矩阵。
 * @param {object} sheet Excel 工作表。
 * @returns {{declaredRows:number,declaredColumns:number,logicalCells:number}} 范围统计。
 */
function assertWorkbookSheetRange(sheet) {
  const rangeReference = sheet?.['!ref'];
  if (!rangeReference) {
    return { declaredRows: 0, declaredColumns: 0, logicalCells: 0 };
  }
  let range;
  try {
    range = xlsx.utils.decode_range(rangeReference);
  } catch (error) {
    throwExcelParseFailed(`Excel 工作表声明范围无效：${error.message}`);
  }
  const declaredRows = range.e.r - range.s.r + 1;
  const declaredColumns = range.e.c - range.s.c + 1;
  const logicalCells = declaredRows * declaredColumns;
  if (
    !Number.isSafeInteger(declaredRows)
    || !Number.isSafeInteger(declaredColumns)
    || !Number.isSafeInteger(logicalCells)
    || declaredRows <= 0
    || declaredColumns <= 0
  ) {
    throwExcelParseFailed('Excel 工作表声明范围无效。');
  }
  if (declaredRows > MAX_EXCEL_DECLARED_ROWS) {
    throw badRequest('Excel 工作表声明行范围超过安全上限。', {
      code: 'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED',
      limitType: 'declaredRows',
      actual: declaredRows,
      limit: MAX_EXCEL_DECLARED_ROWS,
      range: rangeReference
    });
  }
  if (declaredColumns > MAX_IMPORT_COLUMNS) {
    throw badRequest('Excel 工作表声明列范围超过安全上限。', {
      code: 'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED',
      limitType: 'declaredColumns',
      actual: declaredColumns,
      limit: MAX_IMPORT_COLUMNS,
      range: rangeReference
    });
  }
  if (logicalCells > MAX_EXCEL_LOGICAL_CELLS) {
    throw badRequest('Excel 工作表声明逻辑单元格数超过安全上限。', {
      code: 'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED',
      limitType: 'logicalCells',
      actual: logicalCells,
      limit: MAX_EXCEL_LOGICAL_CELLS,
      range: rangeReference
    });
  }
  return { declaredRows, declaredColumns, logicalCells };
}

/**
 * 从 Buffer 解析首个 Excel 工作表，并执行列数和数据行数限制。
 * @param {Buffer} fileBuffer XLS/XLSX 文件内容。
 * @returns {object[]} Excel 数据行。
 */
function parseWorkbookBuffer(fileBuffer) {
  let workbook;
  try {
    workbook = xlsx.read(fileBuffer, {
      type: 'buffer',
      cellDates: true,
      sheets: 0,
      WTF: false
    });
  } catch (error) {
    if (error && error.code === 'BAD_REQUEST') {
      throw error;
    }
    throwExcelParseFailed(error.message);
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }

  const sheet = workbook.Sheets[sheetName];
  assertWorkbookSheetRange(sheet);
  const rows = xlsx.utils.sheet_to_json(sheet, {
    defval: '',
    raw: true,
    blankrows: false
  });
  assertRowLimit(rows, 'excel');
  return rows;
}

/**
 * 从同一份文件 Buffer 校验扩展名、真实文件头并解析表格内容。
 * @param {Buffer|Uint8Array} buffer 导入文件内容。
 * @param {string} originalFilename 原始文件名。
 * @returns {{fileType:string,rows:object[]}} 解析结果。
 */
function parseImportBuffer(buffer, originalFilename) {
  const fileType = assertSupportedImportFile(originalFilename);
  const fileBuffer = normalizeImportBuffer(buffer);
  assertBufferSignature(fileBuffer, fileType);
  assertImportFileSize(fileBuffer);
  if (fileType === 'xlsx') {
    inspectXlsxZipContainer(fileBuffer);
  }
  const rows = fileType === 'csv' ? parseCsvBuffer(fileBuffer) : parseWorkbookBuffer(fileBuffer);

  return {
    fileType,
    rows: Array.isArray(rows) ? rows : []
  };
}

/**
 * 读取文件路径并复用统一 Buffer 解析入口。
 * @param {string} filePath 导入文件路径。
 * @param {string} originalFilename 原始文件名。
 * @returns {{fileType:string,rows:object[]}} 解析结果。
 */
function parseImportFile(filePath, originalFilename) {
  return parseImportBuffer(fs.readFileSync(filePath), originalFilename || filePath);
}

module.exports = {
  MAX_CSV_RECORD_SIZE_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_DATA_ROWS,
  SUPPORTED_EXTENSIONS,
  assertFileSignature,
  assertSupportedImportFile,
  getImportParseLimits,
  parseImportBuffer,
  parseImportFile
};
