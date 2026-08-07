'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const XLSX = require('xlsx');

// 测试数据、数据库、上传与备份目录全部隔离到系统临时目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-analysis-central-import-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-analysis-central-import.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { getDatabaseInfo, initDatabase, openDatabase } = require('../db/database');
const {
  AUDIT_IMPORT_TYPES,
  assertAuditBatchCanUseGenericDelete,
  createPreviewAuditBatch,
  isGenericDeleteAllowedForImportType,
  updateExecuteAuditResult
} = require('../services/importAuditService');
const { createBackup } = require('../services/backupService');
const {
  assertImportBatchCanUseGenericDelete,
  getImportTypeLabel,
  listImportBatches
} = require('../services/importService');
const { getImportParseLimits, parseImportBuffer, parseImportFile } = require('../services/import/parser');
const { buildEnergyTypeIndex, validateAndNormalizeRow } = require('../services/import/normalization');

// 测试独立冻结公共解析阈值，不从生产常量推导预期。
const EXPECTED_MAX_DATA_ROWS = 5000;
const EXPECTED_MAX_COLUMNS = 100;
const EXPECTED_MAX_CSV_RECORD_SIZE_BYTES = 65536;
const EXPECTED_MAX_FILE_SIZE_BYTES = 10485760;
const EXPECTED_MAX_XLSX_ZIP_ENTRIES = 256;
const EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES = 52428800;
const EXPECTED_MAX_EXCEL_DECLARED_ROWS = 10000;
const EXPECTED_MAX_EXCEL_LOGICAL_CELLS = 600000;

// 全部历史和新增正式导入类型及其固定中文标签。
const ALL_IMPORT_TYPE_LABELS = Object.freeze({
  energy_record: '能耗数据导入',
  meter_reading: '计量抄表导入',
  organization_unit: '组织/用能单元导入',
  meter_device: '计量器具导入',
  production_unit: '产能单元导入',
  production_output: '月度产量导入',
  generation_record: '发电记录导入',
  energy_budget: '用能预算导入',
  carbon_factor: '碳排放因子导入',
  prediction_config: '预测配置导入',
  energy_timeseries: '能耗时序数据导入',
  shift_schedule: '排班计划导入',
  device_state: '设备状态导入',
  energy_conversion_factor: '能源折标系数导入',
  energy_benchmark: '能效对标导入',
  energy_flow_node: '能流节点导入',
  energy_flow_edge: '能流边导入',
  energy_flow_record: '显式边值导入'
});

// 统一审计服务正式支持的历史和新增类型。
const AUDIT_IMPORT_TYPE_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(ALL_IMPORT_TYPE_LABELS).filter(([importType]) => ![
    'energy_record',
    'meter_reading',
    'organization_unit',
    'meter_device'
  ].includes(importType))
));

/**
 * 创建单工作表 Excel Buffer，用于验证 XLSX 与 XLS 解析入口一致性。
 * @param {'xlsx'|'biff8'} bookType SheetJS 工作簿类型。
 * @returns {Buffer} Excel 文件 Buffer。
 */
function createWorkbookBuffer(bookType) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['能源类型编码', '月份', '数值'],
    ['electricity', '2026-07', 123.45]
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, '测试数据');
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

/**
 * 创建超过固定 5000 条数据行的工作簿，并可在中间插入空白物理行。
 * @param {'xlsx'|'biff8'} bookType SheetJS 工作簿类型。
 * @param {boolean} includeMiddleBlankRow 是否插入中间空白行。
 * @returns {Buffer} 超限 Excel 文件 Buffer。
 */
function createExcessiveWorkbookBuffer(bookType, includeMiddleBlankRow) {
  const rows = [['字段']];
  for (let index = 0; index < EXPECTED_MAX_DATA_ROWS + 1; index += 1) {
    if (includeMiddleBlankRow && index === Math.floor(EXPECTED_MAX_DATA_ROWS / 2)) {
      rows.push([]);
    }
    rows.push([`值${index}`]);
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '超限数据');
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

/**
 * 创建恰好 5000 条非空数据并包含中间空白行的工作簿。
 * @returns {Buffer} 行数边界 XLSX Buffer。
 */
function createExactLimitWorkbookBuffer() {
  const rows = [['字段']];
  for (let index = 0; index < EXPECTED_MAX_DATA_ROWS; index += 1) {
    if (index === Math.floor(EXPECTED_MAX_DATA_ROWS / 2)) {
      rows.push([]);
    }
    rows.push([`值${index}`]);
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '边界数据');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 创建仅含少量真实单元格但声明超大范围的 Excel 文件。
 * @param {'xlsx'|'biff8'} bookType SheetJS 工作簿类型。
 * @param {string} rangeReference 工作表声明范围。
 * @returns {Buffer} 稀疏范围 Excel Buffer。
 */
function createSparseRangeWorkbookBuffer(bookType, rangeReference) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([['字段'], ['值']]);
  worksheet['!ref'] = rangeReference;
  XLSX.utils.book_append_sheet(workbook, worksheet, '稀疏范围');
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

/**
 * 定位测试 ZIP 的中央目录结束记录。
 * @param {Buffer} zipBuffer ZIP 文件 Buffer。
 * @returns {number} EOCD 偏移。
 */
function findTestZipEocdOffset(zipBuffer) {
  for (let offset = zipBuffer.length - 22; offset >= 0; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('测试 ZIP 缺少 EOCD。');
}

/**
 * 向合法 XLSX 中央目录末尾追加测试记录并同步 EOCD。
 * @param {Buffer} xlsxBuffer 合法 XLSX Buffer。
 * @param {Buffer} centralTail 待追加的中央目录尾部记录。
 * @returns {Buffer} 重建后的 XLSX Buffer。
 */
function appendCentralDirectoryTail(xlsxBuffer, centralTail) {
  const eocdOffset = findTestZipEocdOffset(xlsxBuffer);
  const originalCentralSize = xlsxBuffer.readUInt32LE(eocdOffset + 12);
  const rebuiltEocd = Buffer.from(xlsxBuffer.subarray(eocdOffset, eocdOffset + 22));
  rebuiltEocd.writeUInt32LE(originalCentralSize + centralTail.length, 12);
  return Buffer.concat([
    xlsxBuffer.subarray(0, eocdOffset),
    centralTail,
    rebuiltEocd
  ]);
}

/**
 * 创建 ZIP 中央目录数字签名记录。
 * @param {Buffer} signatureBytes 数字签名字节。
 * @param {number} declaredLength 记录声明长度。
 * @returns {Buffer} 数字签名记录。
 */
function createZipDigitalSignatureRecord(signatureBytes, declaredLength = signatureBytes.length) {
  const record = Buffer.alloc(6 + signatureBytes.length);
  record.writeUInt32LE(0x05054b50, 0);
  record.writeUInt16LE(declaredLength, 4);
  signatureBytes.copy(record, 6);
  return record;
}

/**
 * 在真实 XLSX 容器中注入带数据描述符的伪造 Deflate 条目。
 * @param {Buffer} xlsxBuffer 合法 XLSX Buffer。
 * @param {Buffer} sourceBuffer 条目实际解压内容。
 * @param {number} declaredUncompressedSize 中央目录和描述符声明的解压大小。
 * @param {string} entryName 注入条目名称。
 * @returns {Buffer} 带伪造 Deflate 条目的 XLSX Buffer。
 */
function injectForgedDeflatedEntry(xlsxBuffer, sourceBuffer, declaredUncompressedSize, entryName) {
  const eocdOffset = findTestZipEocdOffset(xlsxBuffer);
  const originalEntryCount = xlsxBuffer.readUInt16LE(eocdOffset + 10);
  const originalCentralSize = xlsxBuffer.readUInt32LE(eocdOffset + 12);
  const originalCentralOffset = xlsxBuffer.readUInt32LE(eocdOffset + 16);
  const originalLocalData = xlsxBuffer.subarray(0, originalCentralOffset);
  const originalCentralDirectory = xlsxBuffer.subarray(originalCentralOffset, eocdOffset);
  const fileName = Buffer.from(entryName, 'utf8');
  const compressedData = zlib.deflateRawSync(sourceBuffer, { level: 9 });

  const localHeader = Buffer.alloc(30 + fileName.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0008, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(fileName.length, 26);
  fileName.copy(localHeader, 30);

  const dataDescriptor = Buffer.alloc(16);
  dataDescriptor.writeUInt32LE(0x08074b50, 0);
  dataDescriptor.writeUInt32LE(0, 4);
  dataDescriptor.writeUInt32LE(compressedData.length, 8);
  dataDescriptor.writeUInt32LE(declaredUncompressedSize, 12);

  const centralEntry = Buffer.alloc(46 + fileName.length);
  centralEntry.writeUInt32LE(0x02014b50, 0);
  centralEntry.writeUInt16LE(20, 4);
  centralEntry.writeUInt16LE(20, 6);
  centralEntry.writeUInt16LE(0x0008, 8);
  centralEntry.writeUInt16LE(8, 10);
  centralEntry.writeUInt32LE(0, 16);
  centralEntry.writeUInt32LE(compressedData.length, 20);
  centralEntry.writeUInt32LE(declaredUncompressedSize, 24);
  centralEntry.writeUInt16LE(fileName.length, 28);
  centralEntry.writeUInt32LE(originalCentralOffset, 42);
  fileName.copy(centralEntry, 46);

  const injectedLocalData = Buffer.concat([localHeader, compressedData, dataDescriptor]);
  const newCentralOffset = originalCentralOffset + injectedLocalData.length;
  const newCentralSize = originalCentralSize + centralEntry.length;
  const newEocd = Buffer.alloc(22);
  newEocd.writeUInt32LE(0x06054b50, 0);
  newEocd.writeUInt16LE(originalEntryCount + 1, 8);
  newEocd.writeUInt16LE(originalEntryCount + 1, 10);
  newEocd.writeUInt32LE(newCentralSize, 12);
  newEocd.writeUInt32LE(newCentralOffset, 16);
  return Buffer.concat([
    originalLocalData,
    injectedLocalData,
    originalCentralDirectory,
    centralEntry,
    newEocd
  ]);
}

/**
 * 创建中央目录伪造为 1 字节但实际解压超过 50MB 的真实 XLSX 容器。
 * @param {Buffer} xlsxBuffer 合法 XLSX Buffer。
 * @returns {Buffer} 实际解压超限 XLSX Buffer。
 */
function injectActualInflateBomb(xlsxBuffer) {
  return injectForgedDeflatedEntry(
    xlsxBuffer,
    Buffer.alloc(EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES + 1, 0x41),
    1,
    'xl/hidden-inflate-bomb.bin'
  );
}

/**
 * 篡改合法 XLSX 首个中央目录条目的 CRC，用于验证矛盾元数据会被拒绝。
 * @param {Buffer} xlsxBuffer 合法 XLSX Buffer。
 * @returns {Buffer} CRC 矛盾的 XLSX Buffer。
 */
function corruptFirstCentralDirectoryCrc(xlsxBuffer) {
  const corrupted = Buffer.from(xlsxBuffer);
  const eocdOffset = findTestZipEocdOffset(corrupted);
  const centralOffset = corrupted.readUInt32LE(eocdOffset + 16);
  const localOffset = corrupted.readUInt32LE(centralOffset + 42);
  const flags = corrupted.readUInt16LE(centralOffset + 8);
  const compressedSize = corrupted.readUInt32LE(centralOffset + 20);
  const originalCrc = corrupted.readUInt32LE(centralOffset + 16);
  const corruptedCrc = (originalCrc ^ 0xffffffff) >>> 0;
  corrupted.writeUInt32LE(corruptedCrc, centralOffset + 16);
  if ((flags & 0x0008) === 0) {
    corrupted.writeUInt32LE(corruptedCrc, localOffset + 14);
    return corrupted;
  }
  const localFileNameLength = corrupted.readUInt16LE(localOffset + 26);
  const localExtraLength = corrupted.readUInt16LE(localOffset + 28);
  const descriptorOffset = localOffset + 30 + localFileNameLength + localExtraLength + compressedSize;
  const descriptorValueOffset = corrupted.readUInt32LE(descriptorOffset) === 0x08074b50
    ? descriptorOffset + 4
    : descriptorOffset;
  corrupted.writeUInt32LE(corruptedCrc, descriptorValueOffset);
  return corrupted;
}

/**
 * 构造只用于 ZIP 中央目录预检的最小 XLSX 容器探针。
 * @param {number} entryCount 中央目录条目数。
 * @param {number} totalUncompressedBytes 首条目录记录声明的解压字节数。
 * @returns {Buffer} XLSX ZIP 安全探针。
 */
function createXlsxZipProbe(entryCount, totalUncompressedBytes = 0) {
  if (entryCount > EXPECTED_MAX_XLSX_ZIP_ENTRIES) {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entryCount, 8);
    eocd.writeUInt16LE(entryCount, 10);
    return eocd;
  }

  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt32LE(totalUncompressedBytes, 24);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}

/**
 * 向隔离数据库插入不经过统一审计服务的历史中央批次。
 * @param {string} importType 历史导入类型。
 */
function insertHistoricalCentralBatch(importType) {
  const db = openDatabase();
  try {
    db.prepare(`INSERT INTO import_batches (
      import_type, original_filename, stored_filename, file_type, file_size_bytes,
      status, total_rows, success_count, failure_count, skipped_count, duplicate_strategy
    ) VALUES (?, ?, ?, 'csv', 16, 'completed', 1, 1, 0, 0, 'skip')`).run(
      importType,
      `${importType}.csv`,
      `${importType}-stored.csv`
    );
  } finally {
    db.close();
  }
}

/**
 * 将 Buffer 写入隔离临时文件，并断言文件入口与 Buffer 入口结果一致。
 * @param {Buffer} buffer 文件内容。
 * @param {string} filename 原始文件名。
 * @returns {object} 统一解析结果。
 */
function assertSuccessfulParserParity(buffer, filename) {
  const filePath = path.join(tmpDir, `file-${Date.now()}-${Math.random().toString(16).slice(2)}-${filename}`);
  fs.writeFileSync(filePath, buffer);
  const fromBuffer = parseImportBuffer(buffer, filename);
  const fromFile = parseImportFile(filePath, filename);
  assert.deepStrictEqual(fromBuffer, fromFile, `${filename} 的 Buffer 与文件解析结果必须一致。`);
  return fromBuffer;
}

/**
 * 捕获解析稳定错误码。
 * @param {Function} callback 待执行解析操作。
 * @returns {string} 错误详情中的稳定 code。
 */
function captureParserError(callback) {
  try {
    callback();
  } catch (error) {
    assert.strictEqual(error.code, 'BAD_REQUEST');
    assert(error.details && error.details.code, '解析失败必须返回稳定 details.code。');
    return error;
  }
  assert.fail('预期解析操作失败，但实际成功。');
}

/**
 * 断言 Buffer 与文件解析入口返回同一稳定错误码。
 * @param {Buffer} buffer 文件内容。
 * @param {string} filename 原始文件名。
 * @param {string} expectedCode 预期错误码。
 * @returns {Error} Buffer 入口返回的领域错误。
 */
function assertFailedParserParity(buffer, filename, expectedCode) {
  const filePath = path.join(tmpDir, `invalid-${Date.now()}-${Math.random().toString(16).slice(2)}-${filename}`);
  fs.writeFileSync(filePath, buffer);
  const bufferError = captureParserError(() => parseImportBuffer(buffer, filename));
  const fileError = captureParserError(() => parseImportFile(filePath, filename));
  assert.strictEqual(bufferError.details.code, expectedCode);
  assert.strictEqual(fileError.details.code, expectedCode);
  assert.deepStrictEqual(fileError.details, bufferError.details, `${filename} 的 Buffer 与文件错误详情必须一致。`);
  return bufferError;
}

(async () => {
  try {
    initDatabase();
    assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '测试必须使用隔离 SQLite 文件。');

    assert.deepStrictEqual(getImportParseLimits(), {
      maxDataRows: EXPECTED_MAX_DATA_ROWS,
      maxColumns: EXPECTED_MAX_COLUMNS,
      maxCsvRecordSizeBytes: EXPECTED_MAX_CSV_RECORD_SIZE_BYTES,
      maxFileSizeBytes: EXPECTED_MAX_FILE_SIZE_BYTES,
      maxXlsxZipEntries: EXPECTED_MAX_XLSX_ZIP_ENTRIES,
      maxXlsxUncompressedBytes: EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES,
      maxExcelDeclaredRows: EXPECTED_MAX_EXCEL_DECLARED_ROWS,
      maxExcelLogicalCells: EXPECTED_MAX_EXCEL_LOGICAL_CELLS
    }, '公共解析阈值必须保持固定安全口径。');
    assert.deepStrictEqual(
      [...AUDIT_IMPORT_TYPES].sort(),
      Object.keys(AUDIT_IMPORT_TYPE_LABELS).sort(),
      '统一审计类型必须完整覆盖固定的历史和新增正式类型。'
    );

    for (const [importType, expectedLabel] of Object.entries(AUDIT_IMPORT_TYPE_LABELS)) {
      const preview = createPreviewAuditBatch({
        importType,
        originalFilename: `${expectedLabel}.csv`,
        storedFilename: `${importType}.csv`,
        fileType: 'csv',
        fileSizeBytes: 64,
        fileSha256: `${importType}-sha256`,
        previewSignature: `${importType}-preview-signature`,
        previewAuditDigest: `${importType}-preview-audit-digest`,
        auditContext: { templateType: importType },
        statistics: { totalRows: 2, successCount: 1, failureCount: 0, skippedCount: 1 }
      });
      assert.strictEqual(preview.importType, importType);
      assert.strictEqual(preview.auditPhase, 'preview');

      const executed = updateExecuteAuditResult(preview.id, {
        statistics: { totalRows: 2, successCount: 1, failureCount: 0, skippedCount: 1 },
        executeResult: { imported: 1, skipped: 1 },
        backup: { backupName: `${importType}.sqlite`, reason: 'energy-analysis-import' }
      });
      assert.strictEqual(executed.auditPhase, 'execute');
      assert.strictEqual(executed.backup.reason, 'energy-analysis-import');
      assert.strictEqual(isGenericDeleteAllowedForImportType(importType), false);
      assert.throws(
        () => assertAuditBatchCanUseGenericDelete({ id: preview.id, importType }),
        (error) => error?.details?.code === 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN',
        `${importType} 必须禁止通用批次删除。`
      );
      assert.throws(
        () => assertImportBatchCanUseGenericDelete({ id: preview.id, importType }),
        (error) => error?.details?.code === 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN',
        `${importType} 必须由中央导入删除检查拒绝。`
      );
    }

    ['energy_record', 'meter_reading', 'organization_unit', 'meter_device'].forEach(insertHistoricalCentralBatch);
    for (const [importType, expectedLabel] of Object.entries(ALL_IMPORT_TYPE_LABELS)) {
      const filtered = listImportBatches({ importType, pageSize: 20 });
      assert.strictEqual(filtered.pagination.total, 1, `${importType} 中央批次筛选应命中唯一对应批次。`);
      assert.strictEqual(filtered.rows[0].importType, importType);
      assert.strictEqual(filtered.rows[0].importTypeLabel, expectedLabel);
      assert.strictEqual(getImportTypeLabel(importType), expectedLabel);
    }

    assert.strictEqual(isGenericDeleteAllowedForImportType('production_output'), false, '历史受控批次仍应禁止通用删除。');
    assert.strictEqual(isGenericDeleteAllowedForImportType('energy_record'), true, '历史通用能耗批次删除口径不得改变。');

    const backup = await createBackup({ reason: 'energy-analysis-import' });
    assert.strictEqual(backup.reason, 'energy-analysis-import', '能源分析导入备份原因不得降级为 manual。');
    assert(backup.backupName.includes('energy-analysis-import'), '备份文件名应保留能源分析导入 reason。');
    assert.strictEqual(path.dirname(backup.path), process.env.BACKUPS_DIR, '备份文件必须写入隔离备份目录。');

    const csvBuffer = Buffer.from('﻿能源类型编码,月份,数值\nelectricity,2026-07,123.45\n', 'utf8');
    const parsedCsv = assertSuccessfulParserParity(csvBuffer, '合法导入.csv');
    assert.strictEqual(parsedCsv.fileType, 'csv');
    assert.deepStrictEqual(parsedCsv.rows, [{ 能源类型编码: 'electricity', 月份: '2026-07', 数值: '123.45' }]);

    const missingOptionalCsv = Buffer.from('period,energy_type,value,unit,remark\n2026-07,electricity,12,kWh\n', 'utf8');
    const parsedMissingOptional = assertSuccessfulParserParity(missingOptionalCsv, '缺尾部可选字段.csv');
    assert.strictEqual(parsedMissingOptional.rows[0].remark, '', '缺少尾部可选字段时必须补为空值。');
    const missingRequiredCsv = Buffer.from('period,energy_type,value,unit,remark\n2026-07,electricity,12\n', 'utf8');
    const parsedMissingRequired = assertSuccessfulParserParity(missingRequiredCsv, '缺尾部必填字段.csv');
    const normalizedMissingRequired = validateAndNormalizeRow(
      parsedMissingRequired.rows[0],
      2,
      buildEnergyTypeIndex([{ id: 1, code: 'electricity', name: '电力' }])
    );
    assert(
      normalizedMissingRequired.errors.some((error) => error.errorCode === 'REQUIRED_FIELD_MISSING' && error.fieldName === 'unit'),
      '缺少尾部必填字段必须进入 normalization 并返回 REQUIRED_FIELD_MISSING。'
    );

    const xlsxBuffer = createWorkbookBuffer('xlsx');
    const parsedXlsx = assertSuccessfulParserParity(xlsxBuffer, '合法导入.xlsx');
    assert.strictEqual(parsedXlsx.fileType, 'xlsx');
    assert.strictEqual(parsedXlsx.rows[0].数值, 123.45);

    const digitalSignatureRecord = createZipDigitalSignatureRecord(Buffer.from([0x10, 0x20, 0x30, 0x40]));
    const signedXlsx = appendCentralDirectoryTail(xlsxBuffer, digitalSignatureRecord);
    const parsedSignedXlsx = assertSuccessfulParserParity(signedXlsx, '合法数字签名.xlsx');
    assert.deepStrictEqual(parsedSignedXlsx.rows, parsedXlsx.rows, '合法数字签名记录不得改变工作簿解析结果。');
    assertFailedParserParity(
      appendCentralDirectoryTail(
        xlsxBuffer,
        createZipDigitalSignatureRecord(Buffer.from([0x10, 0x20]), 4)
      ),
      '截断数字签名.xlsx',
      'EXCEL_PARSE_FAILED'
    );
    assertFailedParserParity(
      appendCentralDirectoryTail(xlsxBuffer, Buffer.concat([digitalSignatureRecord, Buffer.from([0x00])])),
      '数字签名多余字节.xlsx',
      'EXCEL_PARSE_FAILED'
    );
    assertFailedParserParity(
      appendCentralDirectoryTail(xlsxBuffer, Buffer.concat([digitalSignatureRecord, digitalSignatureRecord])),
      '重复数字签名.xlsx',
      'EXCEL_PARSE_FAILED'
    );

    const xlsBuffer = createWorkbookBuffer('biff8');
    const parsedXls = assertSuccessfulParserParity(xlsBuffer, '合法导入.xls');
    assert.strictEqual(parsedXls.fileType, 'xls');
    assert.strictEqual(parsedXls.rows[0].月份, '2026-07');

    assertFailedParserParity(csvBuffer, '伪装文件.xlsx', 'INVALID_EXCEL_FILE_SIGNATURE');
    assertFailedParserParity(xlsxBuffer, '伪装文件.csv', 'INVALID_CSV_FILE_SIGNATURE');
    assertFailedParserParity(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]), '损坏文件.xlsx', 'EXCEL_PARSE_FAILED');
    assertFailedParserParity(Buffer.alloc(0), '空文件.csv', 'EMPTY_IMPORT_FILE');

    const excessiveRows = ['字段', ...Array.from({ length: EXPECTED_MAX_DATA_ROWS + 1 }, (_, index) => `值${index}`)].join('\n');
    assertFailedParserParity(Buffer.from(excessiveRows, 'utf8'), '超行数.csv', 'IMPORT_ROW_LIMIT_EXCEEDED');

    const excessiveColumns = Array.from({ length: EXPECTED_MAX_COLUMNS + 1 }, (_, index) => `列${index}`).join(',');
    assertFailedParserParity(Buffer.from(`${excessiveColumns}\n`, 'utf8'), '超列数.csv', 'IMPORT_COLUMN_LIMIT_EXCEEDED');

    const excessiveRecord = `字段\n${'a'.repeat(EXPECTED_MAX_CSV_RECORD_SIZE_BYTES + 1024)}\n`;
    assertFailedParserParity(Buffer.from(excessiveRecord, 'utf8'), '超记录大小.csv', 'CSV_PARSE_FAILED');

    assertFailedParserParity(
      Buffer.from('列一,列二\n值一,值二,额外值\n', 'utf8'),
      '数据行额外列.csv',
      'CSV_COLUMN_COUNT_MISMATCH'
    );
    const oneHundredHeaders = Array.from({ length: EXPECTED_MAX_COLUMNS }, (_, index) => `列${index}`);
    const oneHundredOneValues = Array.from({ length: EXPECTED_MAX_COLUMNS + 1 }, (_, index) => `值${index}`);
    assertFailedParserParity(
      Buffer.from(`${oneHundredHeaders.join(',')}\n${oneHundredOneValues.join(',')}\n`, 'utf8'),
      '数据行超一百列.csv',
      'IMPORT_COLUMN_LIMIT_EXCEEDED'
    );

    const gbkChineseCsv = Buffer.concat([
      Buffer.from('字段\n', 'ascii'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    ]);
    assertFailedParserParity(gbkChineseCsv, 'GBK中文.csv', 'INVALID_CSV_UTF8_ENCODING');
    assertFailedParserParity(
      Buffer.from([0x66, 0x69, 0x65, 0x6c, 0x64, 0x0a, 0xc3, 0x28, 0x0a]),
      '非法UTF8.csv',
      'INVALID_CSV_UTF8_ENCODING'
    );

    const oversizedFileError = assertFailedParserParity(
      Buffer.alloc(EXPECTED_MAX_FILE_SIZE_BYTES + 1, 0x61),
      '超文件体积.csv',
      'IMPORT_FILE_SIZE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(oversizedFileError.details.maxFileSizeBytes, EXPECTED_MAX_FILE_SIZE_BYTES);

    const excessiveEntryError = assertFailedParserParity(
      createXlsxZipProbe(EXPECTED_MAX_XLSX_ZIP_ENTRIES + 1),
      '超ZIP条目.xlsx',
      'IMPORT_EXCEL_RESOURCE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(excessiveEntryError.details.limitType, 'zipEntries');
    assert.strictEqual(excessiveEntryError.details.limit, EXPECTED_MAX_XLSX_ZIP_ENTRIES);

    const excessiveUncompressedError = assertFailedParserParity(
      createXlsxZipProbe(1, EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES + 1),
      '超ZIP解压字节.xlsx',
      'IMPORT_EXCEL_RESOURCE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(excessiveUncompressedError.details.limitType, 'zipUncompressedBytes');
    assert.strictEqual(excessiveUncompressedError.details.limit, EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES);

    const actualInflateBombError = assertFailedParserParity(
      injectActualInflateBomb(xlsxBuffer),
      '中央目录伪造实际超限.xlsx',
      'IMPORT_EXCEL_RESOURCE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(actualInflateBombError.details.limitType, 'zipActualUncompressedBytes');
    assert.strictEqual(actualInflateBombError.details.limit, EXPECTED_MAX_XLSX_UNCOMPRESSED_BYTES);
    assertFailedParserParity(
      corruptFirstCentralDirectoryCrc(xlsxBuffer),
      'CRC矛盾.xlsx',
      'EXCEL_PARSE_FAILED'
    );
    assertFailedParserParity(
      injectForgedDeflatedEntry(xlsxBuffer, Buffer.from('abc', 'utf8'), 1, 'xl/size-mismatch.bin'),
      '实际解压大小矛盾.xlsx',
      'EXCEL_PARSE_FAILED'
    );

    const excessiveDeclaredRowsXlsx = createSparseRangeWorkbookBuffer('xlsx', 'A1:CV20000');
    assert(excessiveDeclaredRowsXlsx.length < 1024 * 1024, '稀疏 XLSX 探针必须保持小文件规模。');
    const declaredRowsXlsxError = assertFailedParserParity(
      excessiveDeclaredRowsXlsx,
      '稀疏超声明行.xlsx',
      'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(declaredRowsXlsxError.details.limitType, 'declaredRows');
    assert.strictEqual(declaredRowsXlsxError.details.limit, EXPECTED_MAX_EXCEL_DECLARED_ROWS);

    const excessiveDeclaredRowsXls = createSparseRangeWorkbookBuffer('biff8', 'A1:CV20000');
    assert(excessiveDeclaredRowsXls.length < 1024 * 1024, '稀疏 XLS 探针必须保持小文件规模。');
    const declaredRowsXlsError = assertFailedParserParity(
      excessiveDeclaredRowsXls,
      '稀疏超声明行.xls',
      'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(declaredRowsXlsError.details.limitType, 'declaredRows');

    const logicalCellError = assertFailedParserParity(
      createSparseRangeWorkbookBuffer('xlsx', 'A1:CV7000'),
      '稀疏超逻辑单元格.xlsx',
      'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(logicalCellError.details.limitType, 'logicalCells');
    assert.strictEqual(logicalCellError.details.limit, EXPECTED_MAX_EXCEL_LOGICAL_CELLS);

    const declaredColumnError = assertFailedParserParity(
      createSparseRangeWorkbookBuffer('xlsx', 'A1:CW2'),
      '稀疏超声明列.xlsx',
      'IMPORT_EXCEL_RANGE_LIMIT_EXCEEDED'
    );
    assert.strictEqual(declaredColumnError.details.limitType, 'declaredColumns');
    assert.strictEqual(declaredColumnError.details.limit, EXPECTED_MAX_COLUMNS);

    const exactLimitWorkbook = assertSuccessfulParserParity(
      createExactLimitWorkbookBuffer(),
      '五千条含中间空行.xlsx'
    );
    assert.strictEqual(exactLimitWorkbook.rows.length, EXPECTED_MAX_DATA_ROWS);

    assertFailedParserParity(
      createExcessiveWorkbookBuffer('xlsx', true),
      '中间空行超五千条.xlsx',
      'IMPORT_ROW_LIMIT_EXCEEDED'
    );
    assertFailedParserParity(
      createExcessiveWorkbookBuffer('biff8', false),
      '超五千条.xls',
      'IMPORT_ROW_LIMIT_EXCEEDED'
    );

    console.log('energy analysis central import foundation tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
