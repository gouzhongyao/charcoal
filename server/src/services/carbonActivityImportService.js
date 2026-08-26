'use strict';

const zlib = require('zlib');
const XLSX = require('xlsx');
const { AppError, badRequest } = require('../utils/errors');
const { createImportIssue, buildImportSummary } = require('./energyAnalysisImportCore');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');
const {
  CARBON_ACTIVITY_FIELD_LIMITS,
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS,
  CARBON_ACTIVITY_TEMPLATE_TYPE,
  CARBON_ACTIVITY_WORKSHEET_NAME,
  buildCarbonActivityCodeKey,
  buildCarbonActivityDuplicateKey,
  buildCarbonActivityNormalizationKey,
  normalizeCarbonActivityFactorRegion,
  normalizeCarbonActivityScope,
  normalizeCarbonActivityText,
  normalizeCarbonActivityValue
} = require('./carbonActivityContracts');
const { convertSourceWallClockRangeToUtc, isValidIanaTimezone } = require('./sourceWallClockService');

// ZIP 中央目录和本地文件头签名用于 SheetJS 解压前的资源预检。
const ZIP_SIGNATURES = Object.freeze({
  endOfCentralDirectory: 0x06054b50,
  centralDirectoryEntry: 0x02014b50,
  localFileHeader: 0x04034b50
});
// ZIP64 extra field、UTF-8 文件名和加密标志使用规范位值。
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_UTF8_FILENAME_FLAG = 0x0800;
const ZIP_ENCRYPTION_FLAGS = 0x0041;
// 活动查询重叠使用半开区间 [start,end)。
const ACTIVE_ACTIVITY_OVERLAP_SQL = `SELECT id, activity_code AS activityCode, activity_code_key AS activityCodeKey,
  duplicate_key AS duplicateKey, emission_scope AS emissionScope,
  activity_category_key AS activityCategoryKey, organization_unit_id AS organizationUnitId,
  energy_type_id AS energyTypeId, start_utc AS startUtc, end_utc AS endUtc,
  activity_unit AS activityUnit, source_type AS sourceType, record_status AS recordStatus
FROM carbon_activity_records
WHERE record_status = 'active'`;

/** 构造不包含 ZIP 内部路径和底层异常的固定 XLSX 错误。 */
function createCarbonActivityWorkbookError(code, message, details = {}, statusCode = 400) {
  const publicFields = new Set([
    'maxZipEntries', 'actualZipEntries', 'compressionMethod', 'declaredSize', 'actualSize',
    'maxEntryBytes', 'maxTotalBytes', 'declaredTotalBytes', 'actualTotalBytes',
    'actualSheetNames', 'maxWorksheets', 'maxColumns', 'actualLastColumn', 'maxDataRows',
    'actualLastRow', 'maxNonEmptyCells', 'actualNonEmptyCells', 'maxTextCharacters',
    'actualTextCharacters', 'maxIssues', 'actualIssues'
  ]);
  return new AppError(code, message, {
    statusCode,
    details: Object.fromEntries(Object.entries(details).filter(([fieldName]) => publicFields.has(fieldName)))
  });
}

/** 在 ZIP 尾部定位唯一中央目录结束记录。 */
function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_SIGNATURES.endOfCentralDirectory) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 中央目录无效。');
}

/** 校验 ZIP extra field 结构并拒绝 ZIP64。 */
function assertZipExtraFields(extraBuffer) {
  let offset = 0;
  while (offset < extraBuffer.length) {
    if (offset + 4 > extraBuffer.length) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 包含异常 ZIP 扩展字段。');
    }
    const fieldId = extraBuffer.readUInt16LE(offset);
    const fieldSize = extraBuffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldSize > extraBuffer.length) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 包含截断 ZIP 扩展字段。');
    }
    if (fieldId === ZIP64_EXTRA_FIELD_ID) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP64_REJECTED', '独立碳活动 Excel 不支持 ZIP64。');
    }
    offset += fieldSize;
  }
}

/** 拒绝重复、绝对、空和目录穿越 ZIP 条目名。 */
function assertSafeZipEntryName(entryName, seenEntryNames) {
  const normalizedName = String(entryName || '').replace(/\\/g, '/');
  const segments = normalizedName.split('/');
  if (!normalizedName || normalizedName.includes('\0') || normalizedName.startsWith('/')
    || /^[A-Za-z]:/.test(normalizedName)
    || segments.some((segment) => segment === '..' || segment === '.')) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_PATH_INVALID', '独立碳活动 Excel 包含异常 ZIP 条目路径。');
  }
  if (seenEntryNames.has(normalizedName)) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_DUPLICATED', '独立碳活动 Excel 包含重复 ZIP 条目。');
  }
  seenEntryNames.add(normalizedName);
  return normalizedName;
}

/** 判断安全 ZIP 条目是否属于 XLSX 的实际工作表 XML 目录。 */
function isCarbonActivityWorksheetXmlEntry(entryName) {
  return /^xl\/worksheets\/[^/]+\.xml$/iu.test(String(entryName || ''));
}

/** 判断受限工作表 XML 是否包含普通或带命名空间的公式开始元素。 */
function hasCarbonActivityWorksheetFormulaElement(xmlBuffer) {
  return /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?f(?=[\s/>])/u.test(xmlBuffer.toString('utf8'));
}

/** 解压单条受限 ZIP 数据并验证实际大小，返回本次受限解压结果供工作表安全扫描复用。 */
function validateZipEntryPayload(entry, buffer, centralDirectoryOffset) {
  if (entry.localHeaderOffset + 30 > centralDirectoryOffset
    || buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_SIGNATURES.localFileHeader) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 本地文件头无效。');
  }
  const localFlags = buffer.readUInt16LE(entry.localHeaderOffset + 6);
  const localCompressionMethod = buffer.readUInt16LE(entry.localHeaderOffset + 8);
  const localFilenameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  if ((localFlags & ZIP_ENCRYPTION_FLAGS) !== 0 || entry.compressionMethod === 99) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENCRYPTED_REJECTED', '独立碳活动 Excel 不支持加密 ZIP 条目。');
  }
  if (localCompressionMethod !== entry.compressionMethod) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 压缩方式声明不一致。');
  }
  const localExtraStart = entry.localHeaderOffset + 30 + localFilenameLength;
  const dataStart = localExtraStart + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (localExtraStart > centralDirectoryOffset || dataEnd > centralDirectoryOffset) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 条目范围越界。');
  }
  assertZipExtraFields(buffer.subarray(localExtraStart, dataStart));
  const compressedPayload = buffer.subarray(dataStart, dataEnd);
  let actualPayload;
  try {
    if (entry.compressionMethod === 0) {
      actualPayload = compressedPayload;
    } else if (entry.compressionMethod === 8) {
      actualPayload = zlib.inflateRawSync(compressedPayload, {
        maxOutputLength: Math.min(
          CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1,
          entry.uncompressedSize + 1
        )
      });
    } else {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_COMPRESSION_REJECTED', '独立碳活动 Excel 包含不支持的 ZIP 压缩方式。', {
        compressionMethod: entry.compressionMethod
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_PAYLOAD_INVALID', '独立碳活动 Excel 的 ZIP 条目无法安全解压。');
  }
  if (actualPayload.length !== entry.uncompressedSize) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_SIZE_MISMATCH', '独立碳活动 Excel 的 ZIP 条目实际大小与声明不一致。', {
      declaredSize: entry.uncompressedSize,
      actualSize: actualPayload.length
    });
  }
  return actualPayload;
}

/** 在 XLSX.read 前完成 ZIP 安全边界校验，并复用受限解压结果扫描原始工作表公式。 */
function validateCarbonActivityXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动文件不是有效 XLSX ZIP 容器。');
  }
  if (buffer.length > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxUploadBytes) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_UPLOAD_SIZE_EXCEEDED', '独立碳活动压缩上传文件超过限制。', {
      declaredSize: buffer.length,
      maxEntryBytes: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxUploadBytes
    }, 413);
  }
  const endOffset = findZipEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const totalEntryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== totalEntryCount) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_MULTIDISK_REJECTED', '独立碳活动 Excel 不支持分卷 ZIP。');
  }
  if (totalEntryCount === 0 || totalEntryCount === 0xffff
    || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP64_REJECTED', '独立碳活动 Excel 不支持空归档或 ZIP64。');
  }
  if (totalEntryCount > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntries) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_LIMIT_EXCEEDED', '独立碳活动 Excel 的 ZIP 条目数量超过限制。', {
      maxZipEntries: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntries,
      actualZipEntries: totalEntryCount
    }, 413);
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 中央目录范围异常。');
  }
  const seenEntryNames = new Set();
  const entries = [];
  let cursor = centralDirectoryOffset;
  let totalDeclaredSize = 0;
  for (let index = 0; index < totalEntryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== ZIP_SIGNATURES.centralDirectoryEntry) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 中央目录条目无效。');
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
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 中央目录条目越界。');
    }
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0 || compressionMethod === 99) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENCRYPTED_REJECTED', '独立碳活动 Excel 不支持加密 ZIP 条目。');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP64_REJECTED', '独立碳活动 Excel 不支持 ZIP64 条目。');
    }
    if (uncompressedSize > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED', '独立碳活动 Excel 的单条解压大小超过限制。', {
        maxEntryBytes: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes,
        declaredSize: uncompressedSize
      }, 413);
    }
    totalDeclaredSize += uncompressedSize;
    if (totalDeclaredSize > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED', '独立碳活动 Excel 的总解压大小超过限制。', {
        maxTotalBytes: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes,
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
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_DIRECTORY_INVALID', '独立碳活动 Excel 的 ZIP 中央目录包含异常尾部数据。');
  }
  let totalActualSize = 0;
  let worksheetFormulaElementDetected = false;
  entries.forEach((entry) => {
    const actualPayload = validateZipEntryPayload(entry, buffer, centralDirectoryOffset);
    totalActualSize += actualPayload.length;
    if (isCarbonActivityWorksheetXmlEntry(entry.entryName)
      && hasCarbonActivityWorksheetFormulaElement(actualPayload)) {
      worksheetFormulaElementDetected = true;
    }
  });
  if (totalActualSize > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED', '独立碳活动 Excel 的实际总解压大小超过限制。', {
      maxTotalBytes: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes,
      actualTotalBytes: totalActualSize
    }, 413);
  }
  if (worksheetFormulaElementDetected) {
    throw createCarbonActivityWorkbookError(
      'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED',
      '固定模板不允许公式单元格。'
    );
  }
  return { entryCount: entries.length, totalUncompressedBytes: totalActualSize };
}

/** 扫描工作表有效区域并在读取表头或业务数据前拒绝任意公式单元格。 */
function assertCarbonActivityWorksheetHasNoFormulas(worksheet, worksheetRange) {
  for (let rowIndex = worksheetRange.s.r; rowIndex <= worksheetRange.e.r; rowIndex += 1) {
    for (let columnIndex = worksheetRange.s.c; columnIndex <= worksheetRange.e.c; columnIndex += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[cellAddress];
      if (cell && Object.prototype.hasOwnProperty.call(cell, 'f')) {
        throw createCarbonActivityWorkbookError(
          'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED',
          '固定模板不允许公式单元格。'
        );
      }
    }
  }
}

/** 从固定 Excel v1 工作表读取原始文本行，并拒绝隐藏表、公式和合并区域。 */
function parseCarbonActivityWorkbook(buffer, originalFilename) {
  if (!/\.xlsx$/i.test(String(originalFilename || ''))) {
    throw badRequest('独立碳活动导入仅支持固定 Excel v1 的 .xlsx 文件。', {
      code: 'CARBON_ACTIVITY_IMPORT_XLSX_REQUIRED'
    });
  }
  validateCarbonActivityXlsxArchive(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellText: true,
      cellDates: false,
      sheetRows: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows + 2
    });
  } catch (_error) {
    throw badRequest('独立碳活动 Excel 文件无法解析。', { code: 'CARBON_ACTIVITY_IMPORT_WORKBOOK_INVALID' });
  }
  const workbookSheetMetadata = workbook.Workbook?.Sheets || [];
  const hiddenSheetExists = workbookSheetMetadata.some((sheet) => Number(sheet.Hidden || 0) !== 0);
  if (workbook.SheetNames.length !== 1
    || workbook.SheetNames[0] !== CARBON_ACTIVITY_WORKSHEET_NAME
    || hiddenSheetExists) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_SHEET_CONTRACT_INVALID', '独立碳活动 Excel 只能包含一张名为“独立碳活动”的可见工作表。', {
      actualSheetNames: workbook.SheetNames,
      maxWorksheets: 1
    });
  }
  const worksheet = workbook.Sheets[CARBON_ACTIVITY_WORKSHEET_NAME];
  const fullReference = worksheet?.['!fullref'] || worksheet?.['!ref'];
  if (!worksheet || !fullReference) {
    throw badRequest('独立碳活动 Excel 缺少固定工作表或有效区域。', {
      code: 'CARBON_ACTIVITY_IMPORT_SHEET_REQUIRED'
    });
  }
  if (Array.isArray(worksheet['!merges']) && worksheet['!merges'].length > 0) {
    throw badRequest('独立碳活动 Excel 不允许合并单元格。', {
      code: 'CARBON_ACTIVITY_IMPORT_MERGED_CELLS_REJECTED'
    });
  }
  let worksheetRange;
  try {
    worksheetRange = XLSX.utils.decode_range(fullReference);
  } catch (_error) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_SHEET_RANGE_INVALID', '独立碳活动 Excel 工作表范围无效。');
  }
  if (worksheetRange.e.c >= CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxColumns) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_COLUMN_LIMIT_EXCEEDED', '独立碳活动 Excel 列数超过固定模板限制。', {
      maxColumns: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxColumns,
      actualLastColumn: worksheetRange.e.c + 1
    }, 413);
  }
  if (worksheetRange.e.r > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ROW_LIMIT_EXCEEDED', '独立碳活动 Excel 数据行数超过限制。', {
      maxDataRows: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows,
      actualLastRow: worksheetRange.e.r + 1
    }, 413);
  }
  assertCarbonActivityWorksheetHasNoFormulas(worksheet, worksheetRange);
  const nonEmptyCellCount = Object.entries(worksheet).filter(([address, cell]) => (
    !address.startsWith('!') && cell
    && (Boolean(cell.f) || (cell.v !== undefined && cell.v !== null && String(cell.v) !== ''))
  )).length;
  if (nonEmptyCellCount > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxNonEmptyCells) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_CELL_LIMIT_EXCEEDED', '独立碳活动 Excel 非空单元格数量超过限制。', {
      maxNonEmptyCells: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxNonEmptyCells,
      actualNonEmptyCells: nonEmptyCellCount
    }, 413);
  }
  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true
  });
  const headers = (matrix[0] || []).map(normalizeCarbonActivityText);
  if (headers.length !== CARBON_ACTIVITY_IMPORT_HEADERS.length
    || headers.some((header, index) => header !== CARBON_ACTIVITY_IMPORT_HEADERS[index])) {
    throw badRequest('独立碳活动 Excel 表头必须与固定 v1 模板完全一致。', {
      code: 'CARBON_ACTIVITY_IMPORT_HEADERS_MISMATCH',
      expectedHeaders: CARBON_ACTIVITY_IMPORT_HEADERS,
      actualHeaders: headers
    });
  }
  const rows = [];
  let totalTextCharacters = headers.reduce((total, value) => total + value.length, 0);
  for (let matrixIndex = 1; matrixIndex < matrix.length; matrixIndex += 1) {
    const rowNumber = matrixIndex + 1;
    const values = CARBON_ACTIVITY_IMPORT_HEADERS.map(
      (_header, columnIndex) => normalizeCarbonActivityText(matrix[matrixIndex]?.[columnIndex])
    );
    totalTextCharacters += values.reduce((total, value) => total + value.length, 0);
    if (totalTextCharacters > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters) {
      throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_TEXT_BUDGET_EXCEEDED', '独立碳活动 Excel 业务文本总字符数超过限制。', {
        maxTextCharacters: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters,
        actualTextCharacters: totalTextCharacters
      }, 413);
    }
    const formulaFields = CARBON_ACTIVITY_IMPORT_HEADERS.filter((_header, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
      return Boolean(cell && cell.f);
    });
    if (values.some(Boolean) || formulaFields.length > 0) rows.push({ rowNumber, values, formulaFields });
  }
  return rows;
}

/** 向行问题列表添加冻结问题，避免重复模板代码。 */
function pushIssue(issues, rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  issues.push(createImportIssue({ rowNumber, fieldName, rawValue, code, message, severity }));
}

/** 校验字段长度并添加行级问题。 */
function validateFieldLength(issues, rowNumber, fieldName, value, limitName) {
  const maxLength = CARBON_ACTIVITY_FIELD_LIMITS[limitName];
  if (value && value.length > maxLength) {
    pushIssue(issues, rowNumber, fieldName, value, 'CARBON_ACTIVITY_FIELD_TOO_LONG', `${fieldName} 超过 ${maxLength} 个字符。`);
  }
}

/** 将数据库编码列表构造为规范键映射，并保留规范键冲突用于 fail-closed。 */
function buildNormalizedLookup(rows, codeField) {
  const lookup = new Map();
  rows.forEach((row) => {
    const key = buildCarbonActivityCodeKey(row[codeField]);
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(row);
  });
  return lookup;
}

/** 判断两个半开 UTC 区间是否重叠。 */
function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Date.parse(leftStart) < Date.parse(rightEnd) && Date.parse(rightStart) < Date.parse(leftEnd);
}

/** 判断两个活动是否属于必须执行重叠保护的相同活动流。 */
function sameActivityStream(left, right) {
  return left.emissionScope === right.emissionScope
    && left.activityCategoryKey === right.activityCategoryKey
    && Number(left.organizationUnitId) === Number(right.organizationUnitId)
    && Number(left.energyTypeId) === Number(right.energyTypeId);
}

/** 将原始 Excel 行解析为服务端规范活动事实并收集基础问题。 */
function normalizeCarbonActivityImportRow(row, context) {
  const [activityCode, supersedesActivityCode, rawScope, activityCategory,
    organizationUnitCode, energyTypeCode, startWallClock, endWallClock,
    sourceTimezone, rawActivityValue, activityUnit, rawFactorRegion,
    sourceReference, evidenceReference, note] = row.values;
  const issues = [];
  if (row.formulaFields.length > 0) {
    pushIssue(issues, row.rowNumber, row.formulaFields.join(','), null, 'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED', '固定模板不允许公式单元格。');
  }
  const requiredFields = [
    ['活动记录编码', activityCode], ['排放范围', rawScope], ['活动类别', activityCategory],
    ['用能单元编码', organizationUnitCode], ['能源类型编码', energyTypeCode],
    ['活动开始时间', startWallClock], ['活动结束时间', endWallClock],
    ['来源时区', sourceTimezone], ['活动数据值', rawActivityValue],
    ['活动数据单位', activityUnit], ['来源标识', sourceReference]
  ];
  requiredFields.forEach(([fieldName, value]) => {
    if (!value) pushIssue(issues, row.rowNumber, fieldName, value, 'CARBON_ACTIVITY_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`);
  });
  [
    ['活动记录编码', activityCode, 'activityCode'],
    ['替代活动记录编码', supersedesActivityCode, 'supersedesActivityCode'],
    ['活动类别', activityCategory, 'activityCategory'],
    ['用能单元编码', organizationUnitCode, 'organizationUnitCode'],
    ['能源类型编码', energyTypeCode, 'energyTypeCode'],
    ['来源时区', sourceTimezone, 'sourceTimezone'],
    ['活动数据单位', activityUnit, 'activityUnit'],
    ['因子地区', rawFactorRegion, 'factorRegion'],
    ['来源标识', sourceReference, 'sourceReference'],
    ['证据引用', evidenceReference, 'evidenceReference'],
    ['备注', note, 'note']
  ].forEach(([fieldName, value, limitName]) => validateFieldLength(issues, row.rowNumber, fieldName, value, limitName));

  const activityCodeKey = buildCarbonActivityCodeKey(activityCode);
  const supersedesActivityCodeKey = buildCarbonActivityCodeKey(supersedesActivityCode);
  const emissionScope = normalizeCarbonActivityScope(rawScope);
  if (rawScope && !emissionScope) {
    pushIssue(issues, row.rowNumber, '排放范围', rawScope, 'CARBON_ACTIVITY_SCOPE_INVALID', '排放范围仅支持固定 scope_1、scope_2、scope_3 或中文别名。');
  }
  const organizationMatches = context.organizationLookup.get(buildCarbonActivityCodeKey(organizationUnitCode)) || [];
  if (organizationUnitCode && organizationMatches.length !== 1) {
    pushIssue(issues, row.rowNumber, '用能单元编码', organizationUnitCode,
      organizationMatches.length === 0 ? 'CARBON_ACTIVITY_ORGANIZATION_NOT_FOUND' : 'CARBON_ACTIVITY_ORGANIZATION_AMBIGUOUS',
      organizationMatches.length === 0 ? '用能单元编码不存在或未启用。' : '用能单元编码规范化后存在歧义。');
  }
  const energyTypeMatches = context.energyTypeLookup.get(buildCarbonActivityCodeKey(energyTypeCode)) || [];
  if (energyTypeCode && energyTypeMatches.length !== 1) {
    pushIssue(issues, row.rowNumber, '能源类型编码', energyTypeCode,
      energyTypeMatches.length === 0 ? 'CARBON_ACTIVITY_ENERGY_TYPE_NOT_FOUND' : 'CARBON_ACTIVITY_ENERGY_TYPE_AMBIGUOUS',
      energyTypeMatches.length === 0 ? '能源类型编码不存在或未启用。' : '能源类型编码规范化后存在歧义。');
  }
  const organizationUnit = organizationMatches.length === 1 ? organizationMatches[0] : null;
  const energyType = energyTypeMatches.length === 1 ? energyTypeMatches[0] : null;
  if (energyType && activityUnit
    && buildCarbonActivityNormalizationKey(activityUnit) !== buildCarbonActivityNormalizationKey(energyType.standardUnit)) {
    pushIssue(issues, row.rowNumber, '活动数据单位', activityUnit, 'CARBON_ACTIVITY_STANDARD_UNIT_REQUIRED', `活动数据单位必须等于能源类型标准单位 ${energyType.standardUnit}，导入不猜测换算。`);
  }
  const activityValue = normalizeCarbonActivityValue(rawActivityValue);
  if (rawActivityValue && activityValue === null) {
    pushIssue(issues, row.rowNumber, '活动数据值', rawActivityValue, 'CARBON_ACTIVITY_VALUE_INVALID', '活动数据值必须有限、非负且不超过 1e15。');
  }
  if (sourceTimezone && !isValidIanaTimezone(sourceTimezone)) {
    pushIssue(issues, row.rowNumber, '来源时区', sourceTimezone, 'CARBON_ACTIVITY_TIMEZONE_INVALID', '来源时区必须是项目允许的 IANA 时区。');
  }
  let utcRange = null;
  if (startWallClock && endWallClock && sourceTimezone && isValidIanaTimezone(sourceTimezone)) {
    try {
      utcRange = convertSourceWallClockRangeToUtc(startWallClock, endWallClock, sourceTimezone);
    } catch (error) {
      pushIssue(issues, row.rowNumber, '活动开始时间,活动结束时间', `${startWallClock}|${endWallClock}`,
        error?.details?.code || 'CARBON_ACTIVITY_WALL_CLOCK_INVALID', error.message);
    }
  }
  const existingCodeMatches = context.activityCodeLookup.get(activityCodeKey) || [];
  if (activityCodeKey && context.fileActivityCodeCounts.get(activityCodeKey) > 1) {
    pushIssue(issues, row.rowNumber, '活动记录编码', activityCode, 'CARBON_ACTIVITY_FILE_CODE_DUPLICATED', '同一文件内活动记录编码规范化后重复，所有重复行均阻断。');
  }
  if (activityCodeKey && existingCodeMatches.length > 0) {
    pushIssue(issues, row.rowNumber, '活动记录编码', activityCode, 'CARBON_ACTIVITY_CODE_EXISTS', '活动记录编码已用于历史事实，禁止覆盖或复用。');
  }
  if (supersedesActivityCodeKey && supersedesActivityCodeKey === activityCodeKey) {
    pushIssue(issues, row.rowNumber, '替代活动记录编码', supersedesActivityCode, 'CARBON_ACTIVITY_SELF_SUPERSEDE_REJECTED', '活动不能替代自身编码。');
  }
  const replacementMatches = supersedesActivityCodeKey
    ? (context.activityCodeLookup.get(supersedesActivityCodeKey) || [])
    : [];
  let supersedesActivity = null;
  if (supersedesActivityCodeKey) {
    if (replacementMatches.length !== 1) {
      pushIssue(issues, row.rowNumber, '替代活动记录编码', supersedesActivityCode,
        replacementMatches.length === 0 ? 'CARBON_ACTIVITY_SUPERSEDED_TARGET_NOT_FOUND' : 'CARBON_ACTIVITY_SUPERSEDED_TARGET_AMBIGUOUS',
        replacementMatches.length === 0 ? '待替代活动记录不存在。' : '待替代活动记录编码存在歧义。');
    } else {
      supersedesActivity = replacementMatches[0];
      if (supersedesActivity.recordStatus !== 'active' || supersedesActivity.sourceType !== 'independent_activity') {
        pushIssue(issues, row.rowNumber, '替代活动记录编码', supersedesActivityCode, 'CARBON_ACTIVITY_SUPERSEDED_TARGET_INVALID', '仅允许替代 active 的独立碳活动事实。');
      }
    }
  }
  const normalized = {
    candidateRowId: `carbon-activity:${row.rowNumber}`,
    rowNumber: row.rowNumber,
    activityCode: activityCode || null,
    activityCodeKey: activityCodeKey || null,
    supersedesActivityCode: supersedesActivityCode || null,
    supersedesActivityId: supersedesActivity ? Number(supersedesActivity.id) : null,
    emissionScope,
    activityCategory: activityCategory || null,
    activityCategoryKey: activityCategory ? buildCarbonActivityNormalizationKey(activityCategory) : null,
    organizationUnitId: organizationUnit ? Number(organizationUnit.id) : null,
    organizationUnitCode: organizationUnit?.unitCode || organizationUnitCode || null,
    energyTypeId: energyType ? Number(energyType.id) : null,
    energyTypeCode: energyType?.code || energyTypeCode || null,
    startWallClock: startWallClock || null,
    endWallClock: endWallClock || null,
    sourceTimezone: sourceTimezone || null,
    startUtc: utcRange?.startUtc || null,
    endUtc: utcRange?.endUtc || null,
    activityValue,
    activityUnit: energyType && activityUnit ? energyType.standardUnit : (activityUnit || null),
    factorRegion: normalizeCarbonActivityFactorRegion(rawFactorRegion),
    sourceReference: sourceReference || null,
    evidenceReference: evidenceReference || null,
    note: note || null
  };
  if (!issues.some((issue) => issue.severity === 'error')
    && normalized.organizationUnitId && normalized.energyTypeId && normalized.startUtc && normalized.endUtc) {
    normalized.duplicateKey = buildCarbonActivityDuplicateKey(normalized);
  } else {
    normalized.duplicateKey = null;
  }
  return { ...normalized, issues, status: issues.some((issue) => issue.severity === 'error') ? 'blocked' : 'pending' };
}

/** 阻断同一文件内多个有效候选替代同一个 active 活动目标。 */
function blockCarbonActivitySharedSupersedeTargets(items) {
  const supersedeTargetGroups = items.reduce((groups, item) => {
    const supersedesActivityId = Number(item.supersedesActivityId || 0);
    if (item.status !== 'pending' || !supersedesActivityId) return groups;
    if (!groups.has(supersedesActivityId)) groups.set(supersedesActivityId, []);
    groups.get(supersedesActivityId).push(item);
    return groups;
  }, new Map());

  supersedeTargetGroups.forEach((targetItems) => {
    if (targetItems.length <= 1) return;
    targetItems.forEach((item) => {
      pushIssue(
        item.issues,
        item.rowNumber,
        '替代活动记录编码',
        item.supersedesActivityCode,
        'CARBON_ACTIVITY_FILE_SUPERSEDE_TARGET_CONFLICT',
        '同一文件内多个候选不能替代同一个 active 独立碳活动，所有相关行均已阻断。'
      );
      item.status = 'blocked';
    });
  });
}

/** 对规范行执行同文件重复、库内重复、替代和半开区间重叠规则。 */
function finalizeCarbonActivityImportItems(items, activeActivities) {
  const duplicateCounts = items.reduce((counts, item) => {
    if (item.status === 'pending' && item.duplicateKey) counts.set(item.duplicateKey, (counts.get(item.duplicateKey) || 0) + 1);
    return counts;
  }, new Map());
  items.forEach((item) => {
    if (item.status !== 'pending') return;
    if (duplicateCounts.get(item.duplicateKey) > 1) {
      pushIssue(item.issues, item.rowNumber, '活动记录编码', item.activityCode, 'CARBON_ACTIVITY_FILE_DUPLICATE_BLOCKED', '同一文件内存在重复活动事实，所有重复行均阻断。');
      item.status = 'blocked';
      return;
    }
    const overlapping = activeActivities.filter((existing) => sameActivityStream(item, existing)
      && intervalsOverlap(item.startUtc, item.endUtc, existing.startUtc, existing.endUtc));
    const supersedesId = Number(item.supersedesActivityId || 0);
    if (supersedesId) {
      const target = overlapping.find((existing) => Number(existing.id) === supersedesId);
      if (!target) {
        pushIssue(item.issues, item.rowNumber, '替代活动记录编码', item.supersedesActivityCode, 'CARBON_ACTIVITY_SUPERSEDE_OVERLAP_REQUIRED', '替代事实必须与待替代 active 事实属于相同活动流且时间区间重叠。');
      }
      const otherOverlaps = overlapping.filter((existing) => Number(existing.id) !== supersedesId);
      if (otherOverlaps.length > 0) {
        pushIssue(item.issues, item.rowNumber, '活动开始时间,活动结束时间', `${item.startUtc}|${item.endUtc}`, 'CARBON_ACTIVITY_OVERLAP_BLOCKED', '替代后仍会与其他 active 活动重叠，已阻断。');
      }
    } else {
      const exactDuplicate = activeActivities.find((existing) => existing.duplicateKey === item.duplicateKey);
      if (exactDuplicate) {
        pushIssue(item.issues, item.rowNumber, '活动记录编码', item.activityCode, 'CARBON_ACTIVITY_DATABASE_DUPLICATE_SKIPPED', '库内已有相同 active 活动事实，按 skip 策略跳过。', 'warning');
        item.existingActivityId = Number(exactDuplicate.id);
        item.status = 'skipped';
        return;
      }
      if (overlapping.length > 0) {
        pushIssue(item.issues, item.rowNumber, '活动开始时间,活动结束时间', `${item.startUtc}|${item.endUtc}`, 'CARBON_ACTIVITY_OVERLAP_BLOCKED', '同一活动流已存在重叠 active 事实；请明确使用替代活动记录编码。');
      }
    }
    if (item.issues.some((issue) => issue.severity === 'error')) item.status = 'blocked';
  });
  blockCarbonActivitySharedSupersedeTargets(items);
  const pendingItems = items.filter((item) => item.status === 'pending');
  pendingItems.forEach((item) => {
    const conflicts = pendingItems.filter((other) => other !== item
      && sameActivityStream(item, other)
      && intervalsOverlap(item.startUtc, item.endUtc, other.startUtc, other.endUtc));
    if (conflicts.length > 0) {
      pushIssue(item.issues, item.rowNumber, '活动开始时间,活动结束时间', `${item.startUtc}|${item.endUtc}`, 'CARBON_ACTIVITY_FILE_OVERLAP_BLOCKED', '同一文件内候选活动在相同活动流上发生重叠。');
      item.status = 'blocked';
    }
  });
  items.forEach((item) => {
    if (item.status === 'pending') item.status = 'wouldImport';
  });
  return items;
}

/** 使用当前数据库状态重算独立碳活动候选、跳过和阻断项。 */
function buildCarbonActivityImportPreview({ db, buffer, originalFilename }) {
  const rows = parseCarbonActivityWorkbook(buffer, originalFilename);
  const organizations = db.prepare(`SELECT id, unit_code AS unitCode, unit_name AS unitName
    FROM organization_units WHERE status = 'active'`).all();
  const energyTypes = db.prepare(`SELECT id, code, name, standard_unit AS standardUnit
    FROM energy_types WHERE is_active = 1`).all();
  const allActivities = db.prepare(`SELECT id, activity_code AS activityCode,
    activity_code_key AS activityCodeKey, source_type AS sourceType,
    record_status AS recordStatus FROM carbon_activity_records`).all();
  const activeActivities = db.prepare(ACTIVE_ACTIVITY_OVERLAP_SQL).all();
  const fileActivityCodeCounts = rows.reduce((counts, row) => {
    const key = buildCarbonActivityCodeKey(row.values[0]);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const context = {
    organizationLookup: buildNormalizedLookup(organizations, 'unitCode'),
    energyTypeLookup: buildNormalizedLookup(energyTypes, 'code'),
    activityCodeLookup: buildNormalizedLookup(allActivities, 'activityCode'),
    fileActivityCodeCounts
  };
  const items = finalizeCarbonActivityImportItems(
    rows.map((row) => normalizeCarbonActivityImportRow(row, context)),
    activeActivities
  );
  const auditIssues = items.flatMap((item) => item.issues || []);
  if (auditIssues.length > CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxIssues) {
    throw createCarbonActivityWorkbookError('CARBON_ACTIVITY_IMPORT_ISSUE_LIMIT_EXCEEDED', '独立碳活动预演问题数量超过限制。', {
      maxIssues: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxIssues,
      actualIssues: auditIssues.length
    }, 413);
  }
  const summary = buildImportSummary(items);
  const candidateRows = items.filter((item) => item.status === 'wouldImport').map((item) => ({
    candidateRowId: item.candidateRowId,
    rowNumber: item.rowNumber,
    activityCode: item.activityCode,
    activityCodeKey: item.activityCodeKey,
    supersedesActivityCode: item.supersedesActivityCode,
    supersedesActivityId: item.supersedesActivityId,
    emissionScope: item.emissionScope,
    activityCategory: item.activityCategory,
    activityCategoryKey: item.activityCategoryKey,
    organizationUnitId: item.organizationUnitId,
    organizationUnitCode: item.organizationUnitCode,
    energyTypeId: item.energyTypeId,
    energyTypeCode: item.energyTypeCode,
    startWallClock: item.startWallClock,
    endWallClock: item.endWallClock,
    sourceTimezone: item.sourceTimezone,
    startUtc: item.startUtc,
    endUtc: item.endUtc,
    activityValue: item.activityValue,
    activityUnit: item.activityUnit,
    factorRegion: item.factorRegion,
    sourceReference: item.sourceReference,
    evidenceReference: item.evidenceReference,
    note: item.note,
    duplicateKey: item.duplicateKey
  }));
  return {
    fieldMapping: Object.fromEntries(CARBON_ACTIVITY_IMPORT_HEADERS.map((header) => [header, header])),
    summary,
    candidateRows,
    items,
    auditIssues,
    notices: [
      '预演只持久化导入审计和服务端见证，不写入碳活动、计算运行、核算结果或旧 carbon_emissions。',
      '来源墙钟按 IANA 时区唯一转换为 UTC；DST gap/fold、带秒、Z、offset 和无效日期全部阻断。',
      '同文件重复和重叠阻断；库内精确重复按 skip 告警；替代仅允许同活动流时间重叠的 active 独立活动。'
    ]
  };
}

/** 在同一业务事务写入独立碳活动操作审计。 */
function insertCarbonActivityOperationLog(db, actor = {}, operation, targetId, detail = {}) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, ?, 'carbon_activity', ?, ?, ?, ?)`)
    .run(actor.userId || null, operation, targetId === null ? null : String(targetId),
      JSON.stringify(detail || {}), actor.ip || null, new Date().toISOString());
}

/** 在锁内事务中执行替代和新事实写入，不写任何 N5-B 计算表。 */
function insertCarbonActivityImportCandidates({ db, batchId, candidateRows, options = {} }) {
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO carbon_activity_records
    (source_type, source_batch_id, source_row_number, activity_code, activity_code_key,
     supersedes_activity_id, emission_scope, activity_category, activity_category_key,
     organization_unit_id, energy_type_id, start_wall_clock, end_wall_clock, source_timezone,
     start_utc, end_utc, activity_value, activity_unit, factor_region, source_reference,
     evidence_reference, note, duplicate_key, record_status, created_by, created_at, updated_at)
    VALUES ('independent_activity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`);
  const importedItems = [];
  candidateRows.forEach((row) => {
    if (row.supersedesActivityId) {
      const supersedeResult = db.prepare(`UPDATE carbon_activity_records
        SET record_status = 'superseded', superseded_by_activity_id = id, updated_at = ?
        WHERE id = ? AND source_type = 'independent_activity' AND record_status = 'active'`)
        .run(now, row.supersedesActivityId);
      if (supersedeResult.changes !== 1) {
        throw badRequest('待替代独立碳活动已变化，请重新预演。', {
          code: 'CARBON_ACTIVITY_SUPERSEDED_TARGET_STALE',
          rowNumber: row.rowNumber
        });
      }
    }
    const result = insert.run(
      batchId, row.rowNumber, row.activityCode, row.activityCodeKey, row.supersedesActivityId || null,
      row.emissionScope, row.activityCategory, row.activityCategoryKey, row.organizationUnitId,
      row.energyTypeId, row.startWallClock, row.endWallClock, row.sourceTimezone, row.startUtc,
      row.endUtc, row.activityValue, row.activityUnit, row.factorRegion, row.sourceReference,
      row.evidenceReference, row.note, row.duplicateKey, options.actor?.userId || null, now, now
    );
    const activityId = Number(result.lastInsertRowid);
    if (row.supersedesActivityId) {
      db.prepare(`UPDATE carbon_activity_records
        SET superseded_by_activity_id = ?, updated_at = ?
        WHERE id = ? AND record_status = 'superseded' AND superseded_by_activity_id = id`)
        .run(activityId, now, row.supersedesActivityId);
    }
    importedItems.push({ activityId, activityCode: row.activityCode, rowNumber: row.rowNumber });
  });
  insertCarbonActivityOperationLog(db, options.actor || {}, 'carbon.activity.import.execute', batchId, {
    batchId,
    imported: importedItems.length,
    activityIds: importedItems.map((item) => item.activityId)
  });
  return {
    imported: importedItems.length,
    importedIds: importedItems.map((item) => item.activityId),
    importedItems
  };
}

/** 在共享 preview 事务中持久化领域操作审计。 */
function persistCarbonActivityPreviewAudit({ db, batch, preview, safeFile, options = {} }) {
  insertCarbonActivityOperationLog(db, options.actor || {}, 'carbon.activity.import.preview', batch.id, {
    batchId: batch.id,
    fileSha256: safeFile.fileSha256,
    summary: preview.summary
  });
}

// 描述器将固定模板解析、预演审计和锁内写入接入共享受控导入安全链。
const CARBON_ACTIVITY_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: CARBON_ACTIVITY_TEMPLATE_TYPE,
  domainName: '独立碳活动',
  buildPreview: buildCarbonActivityImportPreview,
  persistPreviewAudit: persistCarbonActivityPreviewAudit,
  insertCandidates: insertCarbonActivityImportCandidates
});

/** 创建独立碳活动受控预演。 */
function previewCarbonActivityImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, CARBON_ACTIVITY_IMPORT_DESCRIPTOR, options);
}

/** 执行独立碳活动受控导入。 */
async function executeCarbonActivityImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, CARBON_ACTIVITY_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  CARBON_ACTIVITY_IMPORT_DESCRIPTOR,
  buildCarbonActivityImportPreview,
  executeCarbonActivityImport,
  finalizeCarbonActivityImportItems,
  insertCarbonActivityImportCandidates,
  intervalsOverlap,
  parseCarbonActivityWorkbook,
  previewCarbonActivityImport,
  sameActivityStream,
  validateCarbonActivityXlsxArchive
};
