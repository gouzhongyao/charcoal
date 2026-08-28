'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 受控导入专项测试始终使用隔离临时数据库和上传目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-activity-import-'));
const databasePath = path.join(temporaryRoot, 'carbon-activity.sqlite');
const uploadsDir = path.join(temporaryRoot, 'uploads');
const backupsDir = path.join(temporaryRoot, 'backups');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = uploadsDir;
process.env.BACKUPS_DIR = backupsDir;
process.env.SQLITE_PATH = databasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const { initDatabase, openDatabase } = require('../db/database');
const {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  buildCarbonActivityImportPreview,
  executeCarbonActivityImport,
  parseCarbonActivityWorkbook,
  previewCarbonActivityImport
} = require('../services/carbonActivityImportService');
const {
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS,
  CARBON_ACTIVITY_TEMPLATE_TYPE,
  CARBON_ACTIVITY_WORKSHEET_NAME
} = require('../services/carbonActivityContracts');
const { getTemplateDefinition, getTemplateXlsx } = require('../services/templateService');

// 固定测试组织编码和活动行构建器。
const TEST_ORGANIZATION_CODE = 'CA-IMPORT-OU';
let energyTypeCode = '';
let energyStandardUnit = '';

/** 构造一行固定 Excel v1 数据。 */
function buildActivityRow(overrides = {}) {
  const row = {
    activityCode: 'CA-001',
    supersedesActivityCode: '',
    emissionScope: '范围二',
    activityCategory: '购入电力',
    organizationUnitCode: TEST_ORGANIZATION_CODE,
    energyTypeCode,
    startWallClock: '2026-08-24T09:00',
    endWallClock: '2026-08-24T10:00',
    sourceTimezone: 'Asia/Shanghai',
    activityValue: '100',
    activityUnit: energyStandardUnit,
    factorRegion: '',
    sourceReference: 'meter-A',
    evidenceReference: 'evidence-A',
    note: '正常导入'
  };
  Object.assign(row, overrides);
  return [
    row.activityCode,
    row.supersedesActivityCode,
    row.emissionScope,
    row.activityCategory,
    row.organizationUnitCode,
    row.energyTypeCode,
    row.startWallClock,
    row.endWallClock,
    row.sourceTimezone,
    row.activityValue,
    row.activityUnit,
    row.factorRegion,
    row.sourceReference,
    row.evidenceReference,
    row.note
  ];
}

/** 生成固定单工作表 XLSX，可通过回调和写入选项构造异常或兼容合同。 */
function buildWorkbookBuffer(rows, mutateWorkbook = null, writeOptions = {}) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([CARBON_ACTIVITY_IMPORT_HEADERS, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, CARBON_ACTIVITY_WORKSHEET_NAME);
  if (typeof mutateWorkbook === 'function') mutateWorkbook(workbook, worksheet);
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
    ...writeOptions
  });
}

/** 将上传 Buffer 保存为服务端文件并返回 Multer 风格描述器。 */
/** 定位测试 XLSX 的 ZIP 中央目录结束记录。 */
function findZipEndOffset(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      return offset;
    }
  }
  throw new Error('测试 XLSX 缺少 ZIP 中央目录结束记录。');
}

/** 读取测试 XLSX 的中央目录条目偏移和本地头偏移。 */
function readZipCentralEntries(buffer, endOffset = findZipEndOffset(buffer)) {
  const entries = [];
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const total = buffer.readUInt16LE(endOffset + 10);
  for (let index = 0; index < total; index += 1) {
    assert.strictEqual(buffer.readUInt32LE(cursor), 0x02014b50);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push({
      offset: cursor,
      filenameStart: cursor + 46,
      filenameLength,
      localHeaderOffset: buffer.readUInt32LE(cursor + 42)
    });
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

/** 克隆有效 XLSX 并定点篡改 ZIP 结构。 */
function mutateXlsxArchive(buffer, mutator) {
  const clone = Buffer.from(buffer);
  const endOffset = findZipEndOffset(clone);
  const entries = readZipCentralEntries(clone, endOffset);
  mutator(clone, endOffset, entries);
  return clone;
}

/** 在测试归档内重写指定 XLSX 条目，并由 SheetJS 重新生成合法受限 ZIP。 */
function rewriteXlsxEntry(buffer, entryName, transformContent) {
  const archive = XLSX.CFB.read(buffer, { type: 'buffer' });
  const normalizedEntryName = `Root Entry/${entryName}`;
  const entryIndex = archive.FullPaths.findIndex((entryPath) => entryPath === normalizedEntryName);
  assert.notStrictEqual(entryIndex, -1, `测试 XLSX 缺少条目 ${entryName}`);
  const originalContent = Buffer.from(archive.FileIndex[entryIndex].content).toString('utf8');
  const nextContent = Buffer.from(transformContent(originalContent), 'utf8');
  archive.FileIndex[entryIndex].content = nextContent;
  archive.FileIndex[entryIndex].size = nextContent.length;
  return XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip', compression: true });
}

/** 捕获并断言工作簿安全预检的稳定公开错误。 */
function captureWorkbookError(buffer, expectedCode, expectedStatusCode = null) {
  let capturedError = null;
  assert.throws(
    () => parseCarbonActivityWorkbook(buffer, 'unsafe.xlsx'),
    (error) => {
      capturedError = error;
      return (error?.code === expectedCode || error?.details?.code === expectedCode)
        && (expectedStatusCode === null || error.statusCode === expectedStatusCode);
    }
  );
  return capturedError;
}

/** 断言公式拒绝公开错误不包含公式正文、ZIP 工作表路径或本机临时路径。 */
function assertFormulaErrorIsSanitized(error, forbiddenFormulaText) {
  const publicError = JSON.stringify({
    code: error.code,
    message: error.message,
    details: error.details
  });
  assert(!publicError.includes(forbiddenFormulaText));
  assert(!publicError.includes('xl/worksheets'));
  assert(!publicError.includes(temporaryRoot));
}

/** 断言工作簿安全预检返回稳定错误和可选 HTTP 状态。 */
function assertWorkbookError(buffer, expectedCode, expectedStatusCode = null) {
  captureWorkbookError(buffer, expectedCode, expectedStatusCode);
}

function storeUpload(fileName, buffer, originalname = 'carbon-activities.xlsx') {
  fs.writeFileSync(path.join(uploadsDir, fileName), buffer);
  return { filename: fileName, originalname, size: buffer.length };
}

/** 使用隔离数据库打开新连接，调用方负责关闭。 */
function openTestDatabase() {
  return openDatabase({ databasePath });
}

/** 构造共享 preview/execute 注入选项。 */
function buildServiceOptions(overrides = {}) {
  return {
    uploadsDir,
    openDatabase: openTestDatabase,
    env: { ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: 'carbon-activity-test-secret-2026' },
    ...overrides
  };
}

/** 读取单个表行数。 */
function countRows(tableName) {
  const db = openTestDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
  } finally {
    db.close();
  }
}

/** 断言稳定领域错误码和可选状态码。 */
async function assertAsyncError(action, expectedCode, expectedStatusCode = null) {
  await assert.rejects(async () => action(), (error) => {
    const matchesCode = error?.details?.code === expectedCode || error?.code === expectedCode;
    return matchesCode && (expectedStatusCode === null || error.statusCode === expectedStatusCode);
  });
}

async function run() {
  initDatabase({ databasePath });
  let db = openTestDatabase();
  try {
    db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, '碳活动导入测试单元', ?, 'department', 'active')`)
      .run(TEST_ORGANIZATION_CODE, `/${TEST_ORGANIZATION_CODE}`);
    const energyType = db.prepare(`SELECT code, standard_unit AS standardUnit
      FROM energy_types WHERE is_active = 1 AND standard_unit IS NOT NULL
      ORDER BY id LIMIT 1`).get();
    assert(energyType, '测试数据库必须存在启用且含标准单位的能源类型。');
    energyTypeCode = energyType.code;
    energyStandardUnit = energyType.standardUnit;
  } finally {
    db.close();
  }

  const validBuffer = buildWorkbookBuffer([buildActivityRow()]);
  assert.strictEqual(parseCarbonActivityWorkbook(validBuffer, 'valid.xlsx').length, 1);

  // 中央独立碳活动模板仅在下载 XLSX 的用户可见边界补零秒，定义中的固定示例继续保持内部 T 分钟值。
  const carbonActivityTemplateDefinition = getTemplateDefinition(CARBON_ACTIVITY_TEMPLATE_TYPE);
  assert.deepStrictEqual(carbonActivityTemplateDefinition.userVisibleWallClockColumnIndexes, [6, 7]);
  assert.strictEqual(carbonActivityTemplateDefinition.rows[0][6], '2026-01-01T00:00');
  assert.strictEqual(carbonActivityTemplateDefinition.rows[0][7], '2026-02-01T00:00');
  const carbonActivityTemplateDownload = getTemplateXlsx(CARBON_ACTIVITY_TEMPLATE_TYPE);
  const carbonActivityTemplateWorkbook = XLSX.read(carbonActivityTemplateDownload.buffer, { type: 'buffer' });
  const carbonActivityTemplateRows = XLSX.utils.sheet_to_json(
    carbonActivityTemplateWorkbook.Sheets[CARBON_ACTIVITY_WORKSHEET_NAME],
    { header: 1, raw: false, blankrows: false }
  );
  assert.strictEqual(carbonActivityTemplateRows[1][6], '2026-01-01 00:00:00');
  assert.strictEqual(carbonActivityTemplateRows[1][7], '2026-02-01 00:00:00');
  const carbonFactorTemplateDefinition = getTemplateDefinition('carbon-factors');
  assert.strictEqual(carbonFactorTemplateDefinition.rows[0][7], 'https://example.com/electricity-factor');
  assert.strictEqual(carbonFactorTemplateDefinition.rows[0][8], '2026-01-01', '纯日期模板字段不得被转换为完整日期时间。');
  const carbonFactorTemplateWorkbook = XLSX.read(
    getTemplateXlsx('carbon-factors').buffer,
    { type: 'buffer' }
  );
  const carbonFactorTemplateRows = XLSX.utils.sheet_to_json(
    carbonFactorTemplateWorkbook.Sheets['碳因子模板'],
    { header: 1, raw: false, blankrows: false }
  );
  assert.strictEqual(carbonFactorTemplateRows[1][8], '2026-01-01');

  assert.throws(
    () => parseCarbonActivityWorkbook(validBuffer, 'valid.csv'),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_IMPORT_XLSX_REQUIRED'
  );

  // 新用户墙钟格式在导入边界归一化为内部分钟和 UTC 秒精度，历史 T 分钟格式继续兼容。
  const visibleWallClockBuffer = buildWorkbookBuffer([buildActivityRow({
    activityCode: 'CA-VISIBLE-WALL-CLOCK',
    startWallClock: '2026-08-24 09:00:00',
    endWallClock: '2026-08-24 10:00:00'
  })]);
  let visibleWallClockDb = openTestDatabase();
  try {
    const visiblePreview = buildCarbonActivityImportPreview({
      db: visibleWallClockDb,
      buffer: visibleWallClockBuffer,
      originalFilename: 'visible-wall-clock.xlsx'
    });
    assert.strictEqual(visiblePreview.summary.wouldImport, 1);
    assert.deepStrictEqual(visiblePreview.candidateRows[0].startWallClock, '2026-08-24T09:00');
    assert.deepStrictEqual(visiblePreview.candidateRows[0].endWallClock, '2026-08-24T10:00');
    assert.strictEqual(visiblePreview.candidateRows[0].startUtc, '2026-08-24T01:00:00Z');
    assert.strictEqual(visiblePreview.candidateRows[0].endUtc, '2026-08-24T02:00:00Z');
  } finally {
    visibleWallClockDb.close();
  }
  const nonZeroWallClockBuffer = buildWorkbookBuffer([buildActivityRow({
    activityCode: 'CA-NONZERO-WALL-CLOCK',
    startWallClock: '2026-08-24 09:00:01'
  })]);
  let nonZeroWallClockDb = openTestDatabase();
  try {
    const nonZeroPreview = buildCarbonActivityImportPreview({
      db: nonZeroWallClockDb,
      buffer: nonZeroWallClockBuffer,
      originalFilename: 'non-zero-wall-clock.xlsx'
    });
    assert.strictEqual(nonZeroPreview.summary.blocked, 1);
    assert.strictEqual(nonZeroPreview.summary.wouldImport, 0);
    assert(nonZeroPreview.auditIssues.some((issue) => issue.code === 'CARBON_ACTIVITY_WALL_CLOCK_SECOND_MUST_BE_ZERO'));
  } finally {
    nonZeroWallClockDb.close();
  }
  const invalidDateWallClockBuffer = buildWorkbookBuffer([buildActivityRow({
    activityCode: 'CA-INVALID-DATE-WALL-CLOCK',
    startWallClock: '2026-02-29 09:00:00'
  })]);
  let invalidDateWallClockDb = openTestDatabase();
  try {
    const invalidDatePreview = buildCarbonActivityImportPreview({
      db: invalidDateWallClockDb,
      buffer: invalidDateWallClockBuffer,
      originalFilename: 'invalid-date-wall-clock.xlsx'
    });
    assert.strictEqual(invalidDatePreview.summary.blocked, 1);
    assert(invalidDatePreview.auditIssues.some((issue) => issue.code === 'CARBON_ACTIVITY_WALL_CLOCK_INVALID'));
  } finally {
    invalidDateWallClockDb.close();
  }

  const multipleSheetsBuffer = buildWorkbookBuffer([buildActivityRow()], (workbook) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['额外']]), '额外工作表');
  });
  assert.throws(
    () => parseCarbonActivityWorkbook(multipleSheetsBuffer, 'multiple.xlsx'),
    (error) => error?.code === 'CARBON_ACTIVITY_IMPORT_SHEET_CONTRACT_INVALID'
  );

  const hiddenSheetBuffer = buildWorkbookBuffer([buildActivityRow()], (workbook) => {
    workbook.Workbook = { Sheets: [{ name: CARBON_ACTIVITY_WORKSHEET_NAME, Hidden: 1 }] };
  });
  assert.throws(
    () => parseCarbonActivityWorkbook(hiddenSheetBuffer, 'hidden.xlsx'),
    (error) => error?.code === 'CARBON_ACTIVITY_IMPORT_SHEET_CONTRACT_INVALID'
  );

  const mergedBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet['!merges'] = [XLSX.utils.decode_range('A2:B2')];
  });
  assert.throws(
    () => parseCarbonActivityWorkbook(mergedBuffer, 'merged.xlsx'),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_IMPORT_MERGED_CELLS_REJECTED'
  );

  const badHeaderWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    badHeaderWorkbook,
    XLSX.utils.aoa_to_sheet([['activityCode', ...CARBON_ACTIVITY_IMPORT_HEADERS.slice(1)], buildActivityRow()]),
    CARBON_ACTIVITY_WORKSHEET_NAME
  );
  const badHeaderBuffer = XLSX.write(badHeaderWorkbook, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(
    () => parseCarbonActivityWorkbook(badHeaderBuffer, 'bad-header.xlsx'),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_IMPORT_HEADERS_MISMATCH'
  );

  // 表头公式即使携带合法缓存值，也必须在读取表头前整体拒绝且不暴露公式正文或路径。
  const headerFormulaBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet.A1 = { t: 's', f: '"活动记录编码"', v: CARBON_ACTIVITY_IMPORT_HEADERS[0] };
  });
  const headerFormulaError = captureWorkbookError(
    headerFormulaBuffer,
    'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED'
  );
  assertFormulaErrorIsSanitized(headerFormulaError, '"活动记录编码"');

  // 无缓存值公式会被 SheetJS 丢弃，原始工作表 XML 扫描仍必须 fail-closed 拒绝。
  const noCachedFormulaText = 'SENSITIVE_NO_CACHE_FORMULA';
  const noCachedFormulaBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet.J2 = { t: 'n', f: noCachedFormulaText };
  });
  const sheetJsNoCachedWorkbook = XLSX.read(noCachedFormulaBuffer, {
    type: 'buffer',
    cellText: true,
    cellDates: false,
    sheetRows: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows + 2
  });
  assert.strictEqual(
    sheetJsNoCachedWorkbook.Sheets[CARBON_ACTIVITY_WORKSHEET_NAME].J2,
    undefined,
    '测试前提：SheetJS 当前配置会丢弃无缓存值公式单元格。'
  );
  const noCachedFormulaError = captureWorkbookError(
    noCachedFormulaBuffer,
    'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED'
  );
  assertFormulaErrorIsSanitized(noCachedFormulaError, noCachedFormulaText);

  // 带命名空间、属性、空白和自闭合形式的公式元素同样属于冻结拒绝范围。
  const namespacedFormulaBuffer = rewriteXlsxEntry(
    noCachedFormulaBuffer,
    'xl/worksheets/sheet1.xml',
    (worksheetXml) => {
      const originalFormulaElement = `<f>${noCachedFormulaText}</f>`;
      assert(worksheetXml.includes(originalFormulaElement), '测试工作表 XML 必须包含无缓存公式元素。');
      return worksheetXml.replace(
        originalFormulaElement,
        '<x:f xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"\n t="shared" />'
      );
    }
  );
  assertWorkbookError(namespacedFormulaBuffer, 'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED');

  // dimension 低报时，!ref 外的实际公式仍必须在原始工作表 XML 层拒绝。
  const outsideReferenceFormulaText = 'SENSITIVE_OUTSIDE_REFERENCE_FORMULA';
  const outsideReferenceFormulaWorkbook = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet.P2 = { t: 'n', f: outsideReferenceFormulaText };
    worksheet['!ref'] = 'A1:P2';
  });
  const lowDimensionFormulaBuffer = rewriteXlsxEntry(
    outsideReferenceFormulaWorkbook,
    'xl/worksheets/sheet1.xml',
    (worksheetXml) => {
      assert(worksheetXml.includes('<dimension ref="A1:P2"/>'), '测试工作表 XML 必须先声明 P2 范围。');
      return worksheetXml.replace('<dimension ref="A1:P2"/>', '<dimension ref="A1:O2"/>');
    }
  );
  const sheetJsLowDimensionWorkbook = XLSX.read(lowDimensionFormulaBuffer, {
    type: 'buffer',
    cellText: true,
    cellDates: false,
    sheetRows: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows + 2
  });
  assert.strictEqual(sheetJsLowDimensionWorkbook.Sheets[CARBON_ACTIVITY_WORKSHEET_NAME]['!ref'], 'A1:O2');
  assert.strictEqual(
    sheetJsLowDimensionWorkbook.Sheets[CARBON_ACTIVITY_WORKSHEET_NAME].P2,
    undefined,
    '测试前提：SheetJS 当前配置不会暴露 dimension 之外的无缓存公式单元格。'
  );
  const lowDimensionFormulaError = captureWorkbookError(
    lowDimensionFormulaBuffer,
    'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED'
  );
  assertFormulaErrorIsSanitized(lowDimensionFormulaError, outsideReferenceFormulaText);

  // 工作表普通文本和 sharedStrings 中出现类似公式/XML 片段时不得误拒。
  const formulaLikeTextBuffer = buildWorkbookBuffer([
    buildActivityRow({
      activityCode: 'CA-FORMULA-LIKE-TEXT',
      sourceReference: 'text-formula-marker',
      note: '<f t="shared">SUM(A1:A2)</f> 仅为普通文本'
    })
  ], null, { bookSST: true });
  const formulaLikeTextArchive = XLSX.CFB.read(formulaLikeTextBuffer, { type: 'buffer' });
  assert(
    formulaLikeTextArchive.FullPaths.includes('Root Entry/xl/sharedStrings.xml'),
    '测试工作簿必须把普通公式片段写入 sharedStrings。'
  );
  const formulaLikeTextRows = parseCarbonActivityWorkbook(formulaLikeTextBuffer, 'formula-like-text.xlsx');
  assert.strictEqual(formulaLikeTextRows.length, 1);
  assert.strictEqual(formulaLikeTextRows[0].values[14], '<f t="shared">SUM(A1:A2)</f> 仅为普通文本');

  const wrongSheetWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wrongSheetWorkbook,
    XLSX.utils.aoa_to_sheet([CARBON_ACTIVITY_IMPORT_HEADERS, buildActivityRow()]),
    'Carbon Activities'
  );
  assertWorkbookError(
    XLSX.write(wrongSheetWorkbook, { type: 'buffer', bookType: 'xlsx' }),
    'CARBON_ACTIVITY_IMPORT_SHEET_CONTRACT_INVALID'
  );

  // ZIP 预检必须拒绝 ZIP64、分卷、加密、穿越、重复条目、异常压缩和声明资源炸弹。
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(1, endOffset + 4);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_MULTIDISK_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(0xffff, endOffset + 8);
    buffer.writeUInt16LE(0xffff, endOffset + 10);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP64_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    buffer.writeUInt16LE(buffer.readUInt16LE(entries[0].offset + 8) | 1, entries[0].offset + 8);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_ENCRYPTED_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    Buffer.from('../', 'utf8').copy(buffer, entries[0].filenameStart);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_PATH_INVALID');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    const duplicatePair = entries.find((entry, index) => entries.slice(index + 1)
      .some((candidate) => candidate.filenameLength === entry.filenameLength));
    assert(duplicatePair, '测试 XLSX 必须存在同长度 ZIP 条目名。');
    const duplicateTarget = entries.slice(entries.indexOf(duplicatePair) + 1)
      .find((candidate) => candidate.filenameLength === duplicatePair.filenameLength);
    buffer.copy(
      buffer,
      duplicateTarget.filenameStart,
      duplicatePair.filenameStart,
      duplicatePair.filenameStart + duplicatePair.filenameLength
    );
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_DUPLICATED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    buffer.writeUInt16LE(12, entries[0].offset + 10);
    buffer.writeUInt16LE(12, entries[0].localHeaderOffset + 8);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_COMPRESSION_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    buffer.writeUInt32LE(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1, entries[0].offset + 24);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED', 413);
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    assert(entries.length >= 3);
    buffer.writeUInt32LE(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes, entries[0].offset + 24);
    buffer.writeUInt32LE(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes, entries[1].offset + 24);
    buffer.writeUInt32LE(1, entries[2].offset + 24);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED', 413);
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntries + 1, endOffset + 8);
    buffer.writeUInt16LE(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxZipEntries + 1, endOffset + 10);
  }), 'CARBON_ACTIVITY_IMPORT_ZIP_ENTRY_LIMIT_EXCEEDED', 413);

  const excessiveColumnBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet['!ref'] = 'A1:P2';
  });
  assertWorkbookError(excessiveColumnBuffer, 'CARBON_ACTIVITY_IMPORT_COLUMN_LIMIT_EXCEEDED', 413);
  const excessiveRowBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
    worksheet['!ref'] = `A1:O${CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows + 2}`;
  });
  assertWorkbookError(excessiveRowBuffer, 'CARBON_ACTIVITY_IMPORT_ROW_LIMIT_EXCEEDED', 413);

  db = openTestDatabase();
  try {
    const formulaBuffer = buildWorkbookBuffer([buildActivityRow()], (_workbook, worksheet) => {
      worksheet.J2 = { t: 'n', f: '1+1', v: 2 };
    });
    assertWorkbookError(
      formulaBuffer,
      'CARBON_ACTIVITY_IMPORT_FORMULA_CELL_REJECTED'
    );

    const duplicateRowsBuffer = buildWorkbookBuffer([
      buildActivityRow({ activityCode: 'CA-DUP-1' }),
      buildActivityRow({ activityCode: 'CA-DUP-2' })
    ]);
    const duplicatePreview = buildCarbonActivityImportPreview({
      db,
      buffer: duplicateRowsBuffer,
      originalFilename: 'duplicate.xlsx'
    });
    assert.strictEqual(duplicatePreview.summary.blocked, 2);
    assert.strictEqual(duplicatePreview.summary.wouldImport, 0);
    assert(duplicatePreview.auditIssues.filter((issue) => issue.code === 'CARBON_ACTIVITY_FILE_DUPLICATE_BLOCKED').length >= 2);

    const issueLimitRows = Array.from({ length: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows }, (_value, index) => (
      buildActivityRow({
        activityCode: `CA-ISSUE-${index + 1}`,
        emissionScope: '范围四',
        sourceTimezone: 'UTC',
        sourceReference: `issue-${index + 1}`
      })
    ));
    assert.throws(
      () => buildCarbonActivityImportPreview({
        db,
        buffer: buildWorkbookBuffer(issueLimitRows),
        originalFilename: 'issue-limit.xlsx'
      }),
      (error) => error?.code === 'CARBON_ACTIVITY_IMPORT_ISSUE_LIMIT_EXCEEDED' && error.statusCode === 413
    );

    const longNote = '长'.repeat(2100);
    const textBudgetRows = Array.from({ length: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxDataRows }, (_value, index) => (
      buildActivityRow({ activityCode: `CA-TEXT-${index + 1}`, sourceReference: `text-${index + 1}`, note: longNote })
    ));
    assertWorkbookError(
      buildWorkbookBuffer(textBudgetRows),
      'CARBON_ACTIVITY_IMPORT_TEXT_BUDGET_EXCEEDED',
      413
    );
  } finally {
    db.close();
  }

  // 资源失败必须在共享 preview 写批次和 issues 之前返回 413。
  const batchCountBeforeResourceFailure = countRows('import_batches');
  const oversizedBuffer = Buffer.alloc(CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxUploadBytes + 1);
  const oversizedFile = storeUpload('oversized-carbon.xlsx', oversizedBuffer);
  await assertAsyncError(
    () => Promise.resolve(previewCarbonActivityImport(oversizedFile, buildServiceOptions({
      maxFileSizeBytes: CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS.maxUploadBytes + 1024
    }))),
    'CARBON_ACTIVITY_IMPORT_UPLOAD_SIZE_EXCEEDED',
    413
  );
  assert.strictEqual(countRows('import_batches'), batchCountBeforeResourceFailure);
  assert.strictEqual(countRows('import_errors'), 0);

  // 完整 preview 持久化服务端原文件见证、SHA、HMAC 签名和审计摘要。
  const validFile = storeUpload('carbon-valid.xlsx', validBuffer);
  const preview = previewCarbonActivityImport(validFile, buildServiceOptions());
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(preview.summary.blocked, 0);
  assert.match(preview.fileSha256, /^[0-9a-f]{64}$/);
  assert.match(preview.previewSignature, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.match(preview.previewAuditDigest, /^hmac-sha256:v1:audit:[0-9a-f]{64}$/);
  assert.strictEqual(preview.batchId > 0, true);
  assert.strictEqual(countRows('carbon_activity_records'), 0, 'preview 不得写活动事实。');

  // execute 必须重读同一服务端原文件；文件被替换后稳定拒绝且不写业务表。
  const tamperedBuffer = buildWorkbookBuffer([buildActivityRow({ activityCode: 'CA-TAMPERED' })]);
  fs.writeFileSync(path.join(uploadsDir, validFile.filename), tamperedBuffer);
  await assertAsyncError(
    () => executeCarbonActivityImport({
      batchId: preview.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, buildServiceOptions({ createBackup: async () => ({ backupName: 'should-not-run.sqlite' }) })),
    'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH'
  );
  assert.strictEqual(countRows('carbon_activity_records'), 0);

  // 新批次成功执行时只写活动事实，不写 N5-B 或旧碳结果。
  const executeFile = storeUpload('carbon-execute.xlsx', validBuffer);
  const executePreview = previewCarbonActivityImport(executeFile, buildServiceOptions());
  let backupCall = null;
  const executeResult = await executeCarbonActivityImport({
    batchId: executePreview.batchId,
    confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions({
    createBackup: async (input) => {
      backupCall = input;
      return {
        backupName: 'carbon-before-import.sqlite',
        reason: input.reason,
        sizeBytes: 100,
        sha256: 'b'.repeat(64),
        method: 'sqlite-online-backup',
        createdAt: '2026-08-24T00:00:00.000Z'
      };
    }
  }));
  assert.strictEqual(executeResult.imported, 1);
  assert.deepStrictEqual(backupCall, { reason: 'carbon-activity-import', skipCheckpoint: true });
  assert.strictEqual(countRows('carbon_activity_records'), 1);
  assert.strictEqual(countRows('carbon_calculation_runs'), 0);
  assert.strictEqual(countRows('carbon_accounting_results'), 0);
  assert.strictEqual(countRows('carbon_emissions'), 0);

  // 同一文件中两个互不重叠候选也不能同时替代同一个 active 目标，execute 必须在备份前不可达。
  const sharedSupersedeFile = storeUpload('carbon-shared-supersede.xlsx', buildWorkbookBuffer([
    buildActivityRow({
      activityCode: 'CA-SHARED-SUPERSEDE-A',
      supersedesActivityCode: 'CA-001',
      startWallClock: '2026-08-24T09:00',
      endWallClock: '2026-08-24T09:30',
      activityValue: '40',
      sourceReference: 'meter-shared-supersede-a'
    }),
    buildActivityRow({
      activityCode: 'CA-SHARED-SUPERSEDE-B',
      supersedesActivityCode: 'CA-001',
      startWallClock: '2026-08-24T09:30',
      endWallClock: '2026-08-24T10:00',
      activityValue: '60',
      sourceReference: 'meter-shared-supersede-b'
    })
  ]));
  const sharedSupersedePreview = previewCarbonActivityImport(
    sharedSupersedeFile,
    buildServiceOptions()
  );
  assert.strictEqual(sharedSupersedePreview.summary.blocked, 2);
  assert.strictEqual(sharedSupersedePreview.summary.wouldImport, 0);
  assert.strictEqual(sharedSupersedePreview.candidateRows.length, 0);
  assert.strictEqual(sharedSupersedePreview.auditIssues.filter(
    (issue) => issue.code === 'CARBON_ACTIVITY_FILE_SUPERSEDE_TARGET_CONFLICT'
  ).length, 2);
  const activityCountBeforeSharedSupersedeExecute = countRows('carbon_activity_records');
  let sharedSupersedeBackupCalls = 0;
  await assertAsyncError(
    () => executeCarbonActivityImport({
      batchId: sharedSupersedePreview.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, buildServiceOptions({
      createBackup: async () => {
        sharedSupersedeBackupCalls += 1;
        return { backupName: 'must-not-be-created.sqlite' };
      }
    })),
    'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED'
  );
  assert.strictEqual(sharedSupersedeBackupCalls, 0, '冲突批次不得创建无意义备份。');
  assert.strictEqual(countRows('carbon_activity_records'), activityCountBeforeSharedSupersedeExecute);
  db = openTestDatabase();
  try {
    const sharedSupersedeBatch = db.prepare(`SELECT status, audit_phase AS auditPhase,
      success_count AS successCount, failure_count AS failureCount,
      execute_result_json AS executeResultJson, backup_json AS backupJson
      FROM import_batches WHERE id = ?`).get(sharedSupersedePreview.batchId);
    assert.strictEqual(sharedSupersedeBatch.status, 'completed_with_errors');
    assert.strictEqual(sharedSupersedeBatch.auditPhase, 'preview');
    assert.strictEqual(Number(sharedSupersedeBatch.successCount), 0);
    assert.strictEqual(Number(sharedSupersedeBatch.failureCount), 2);
    assert.strictEqual(sharedSupersedeBatch.executeResultJson, null);
    assert.strictEqual(sharedSupersedeBatch.backupJson, null);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM import_errors
      WHERE batch_id = ? AND error_code = 'CARBON_ACTIVITY_FILE_SUPERSEDE_TARGET_CONFLICT'`)
      .get(sharedSupersedePreview.batchId).total, 2);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.activity.import.preview' AND target_id = ?`)
      .get(String(sharedSupersedePreview.batchId)).total, 1);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.activity.import.execute' AND target_id = ?`)
      .get(String(sharedSupersedePreview.batchId)).total, 0);
    assert.strictEqual(db.prepare("SELECT record_status AS status FROM carbon_activity_records WHERE activity_code = 'CA-001'").get().status, 'active');
  } finally {
    db.close();
  }

  // 库内精确重复按 skip 告警，不提供 execute 候选。
  const duplicateDatabaseFile = storeUpload('carbon-db-duplicate.xlsx', buildWorkbookBuffer([
    buildActivityRow({ activityCode: 'CA-DB-DUPLICATE' })
  ]));
  const duplicateDatabasePreview = previewCarbonActivityImport(duplicateDatabaseFile, buildServiceOptions());
  assert.strictEqual(duplicateDatabasePreview.summary.skipped, 1);
  assert.strictEqual(duplicateDatabasePreview.summary.wouldImport, 0);
  assert(duplicateDatabasePreview.auditIssues.some((issue) => issue.code === 'CARBON_ACTIVITY_DATABASE_DUPLICATE_SKIPPED'));

  // 未明确替代的同活动流重叠事实必须阻断。
  const overlapFile = storeUpload('carbon-overlap.xlsx', buildWorkbookBuffer([
    buildActivityRow({
      activityCode: 'CA-OVERLAP',
      startWallClock: '2026-08-24T09:30',
      endWallClock: '2026-08-24T10:30',
      sourceReference: 'meter-overlap'
    })
  ]));
  const overlapPreview = previewCarbonActivityImport(overlapFile, buildServiceOptions());
  assert.strictEqual(overlapPreview.summary.blocked, 1);
  assert(overlapPreview.auditIssues.some((issue) => issue.code === 'CARBON_ACTIVITY_OVERLAP_BLOCKED'));

  // 合法替代保留旧事实，旧事实转 superseded 并指向新 active 事实。
  const replacementFile = storeUpload('carbon-replacement.xlsx', buildWorkbookBuffer([
    buildActivityRow({
      activityCode: 'CA-REPLACEMENT',
      supersedesActivityCode: 'CA-001',
      activityValue: '120',
      sourceReference: 'meter-replacement'
    })
  ]));
  const replacementPreview = previewCarbonActivityImport(replacementFile, buildServiceOptions());
  assert.strictEqual(replacementPreview.summary.wouldImport, 1);
  const replacementResult = await executeCarbonActivityImport({
    batchId: replacementPreview.batchId,
    confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions({
    createBackup: async ({ reason }) => ({
      backupName: 'carbon-before-replacement.sqlite',
      reason,
      sizeBytes: 101,
      sha256: 'c'.repeat(64),
      method: 'sqlite-online-backup',
      createdAt: '2026-08-24T00:01:00.000Z'
    })
  }));
  assert.strictEqual(replacementResult.imported, 1);
  db = openTestDatabase();
  try {
    const original = db.prepare(`SELECT id, record_status AS status,
      superseded_by_activity_id AS supersededByActivityId
      FROM carbon_activity_records WHERE activity_code = 'CA-001'`).get();
    const replacement = db.prepare(`SELECT id, record_status AS status,
      supersedes_activity_id AS supersedesActivityId
      FROM carbon_activity_records WHERE activity_code = 'CA-REPLACEMENT'`).get();
    assert.strictEqual(original.status, 'superseded');
    assert.strictEqual(replacement.status, 'active');
    assert.strictEqual(Number(original.supersededByActivityId), Number(replacement.id));
    assert.strictEqual(Number(replacement.supersedesActivityId), Number(original.id));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 锁内备份失败必须回滚，不写新活动和最终 execute 成功审计。
  const activityCountBeforeBackupFailure = countRows('carbon_activity_records');
  const backupFailureFile = storeUpload('carbon-backup-failure.xlsx', buildWorkbookBuffer([
    buildActivityRow({
      activityCode: 'CA-BACKUP-FAILURE',
      startWallClock: '2026-08-24T11:00',
      endWallClock: '2026-08-24T12:00',
      sourceReference: 'meter-backup-failure'
    })
  ]));
  const backupFailurePreview = previewCarbonActivityImport(backupFailureFile, buildServiceOptions());
  await assertAsyncError(
    () => executeCarbonActivityImport({
      batchId: backupFailurePreview.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, buildServiceOptions({
      createBackup: async () => {
        throw new Error(`backup failed at ${temporaryRoot}`);
      }
    })),
    'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED',
    503
  );
  assert.strictEqual(countRows('carbon_activity_records'), activityCountBeforeBackupFailure);

  console.log('carbonActivityImport tests passed');
}

run()
  .finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
