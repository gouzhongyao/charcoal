const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const xlsx = require('xlsx');
const { badRequest } = require('../../utils/errors');

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const MAX_IMPORT_DATA_ROWS = 5000;
const MAX_IMPORT_COLUMNS = 100;
const MAX_CSV_RECORD_SIZE_BYTES = 64 * 1024;
const SIGNATURE_READ_BYTES = 8;

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
    maxCsvRecordSizeBytes: MAX_CSV_RECORD_SIZE_BYTES
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

function assertFileSignature(filePath, extension) {
  const signature = readFileSignature(filePath);
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
}

function parseCsv(filePath) {
  let rows;
  try {
    rows = parse(fs.readFileSync(filePath), {
      bom: true,
      columns(header) {
        assertColumnLimit(header, 'csv');
        return header;
      },
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
  assertRowLimit(rows, 'csv');
  return rows;
}

function getSheetDataRows(sheet) {
  const rows = xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false
  });
  return rows.filter((row) => Array.isArray(row) && row.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== ''));
}

function parseWorkbook(filePath) {
  let workbook;
  try {
    workbook = xlsx.readFile(filePath, {
      cellDates: true,
      sheets: 0,
      sheetRows: MAX_IMPORT_DATA_ROWS + 2,
      WTF: false
    });
  } catch (error) {
    throw badRequest('Excel 文件解析失败，请确认文件未损坏且格式为 .xlsx 或 .xls。', {
      code: 'EXCEL_PARSE_FAILED',
      message: error.message
    });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = getSheetDataRows(sheet);
  if (rawRows.length === 0) {
    return [];
  }

  assertColumnLimit(rawRows[0], 'excel');
  const dataRowCount = Math.max(0, rawRows.length - 1);
  if (dataRowCount > MAX_IMPORT_DATA_ROWS) {
    throw badRequest(`Excel 数据行数超过上限，当前最多支持 ${MAX_IMPORT_DATA_ROWS} 行。`, {
      code: 'IMPORT_ROW_LIMIT_EXCEEDED',
      source: 'excel',
      rowCount: dataRowCount,
      maxDataRows: MAX_IMPORT_DATA_ROWS
    });
  }

  return xlsx.utils.sheet_to_json(sheet, {
    defval: '',
    raw: true,
    blankrows: false
  });
}

function parseImportFile(filePath, originalFilename) {
  const fileType = assertSupportedImportFile(originalFilename || filePath);
  assertFileSignature(filePath, fileType);
  const rows = fileType === 'csv' ? parseCsv(filePath) : parseWorkbook(filePath);

  return {
    fileType,
    rows: Array.isArray(rows) ? rows : []
  };
}

module.exports = {
  MAX_CSV_RECORD_SIZE_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_DATA_ROWS,
  SUPPORTED_EXTENSIONS,
  assertFileSignature,
  assertSupportedImportFile,
  getImportParseLimits,
  parseImportFile
};
