'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-emission-report-import-'));
const databasePath = path.join(temporaryRoot, 'carbon-emission-report.sqlite');
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
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR,
  buildCarbonEmissionReportImportPreview,
  executeCarbonEmissionReportImport,
  parseCarbonEmissionReportWorkbook,
  previewCarbonEmissionReportImport
} = require('../services/carbonEmissionReportImportService');
const {
  CARBON_EMISSION_REPORT_RESOURCE_LIMITS,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION
} = require('../services/carbonEmissionReportContracts');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('../services/energyAnalysisSingleBatchImportService');
const {
  getCarbonEmissionReportByBatch,
  listCarbonEmissionReports
} = require('../services/carbonEmissionReportService');
const { getTemplateXlsx } = require('../services/templateService');

const PROTECTED_TABLES = Object.freeze([
  'carbon_activity_records',
  'carbon_calculation_runs',
  'carbon_accounting_results',
  'carbon_emissions',
  'carbon_factors'
]);

function buildReportRows(reportCode, overrides = {}) {
  const rows = {
    report: [[reportCode, `报告 ${reportCode}`, '测试组织', '2026-01-01', '2026-12-31',
      CARBON_EMISSION_REPORT_TEMPLATE_TYPE, CARBON_EMISSION_REPORT_TEMPLATE_VERSION, '报告备注']],
    boundaries: [
      ['组织边界', '测试组织全部受控设施', '采用运营控制法'],
      ['核算边界', '范围一和范围二', '纳入报告项目中的排放源']
    ],
    items: [
      ['ITEM-001', '范围一', '固定燃烧', '天然气', '100', 'm3', '0.02', 'tCO2e/m3', '2', 'tCO2e', 'EVID-001', '=项目备注'],
      ['ITEM-002', '范围二', '购入电力', '电力', '3000', 'kWh', '0.001', 'tCO2e/kWh', '3', 'tCO2e', 'EVID-002', '项目备注']
    ],
    summaries: [
      ['TOTAL-001', '总计', '全部', '5', 'tCO2e', '总计'],
      ['SCOPE-001', '排放范围', '范围一', '2', 'tCO2e', '范围一'],
      ['SCOPE-002', '排放范围', '范围二', '3', 'tCO2e', '范围二']
    ],
    evidence: [
      ['EVID-001', '燃气证据', '原始凭证', '燃气结算凭证', '@证据备注'],
      ['EVID-002', '电力证据', '计量记录', '电力计量汇总', '证据备注']
    ]
  };
  Object.entries(overrides).forEach(([key, value]) => { rows[key] = value; });
  return rows;
}

function buildWorkbookBuffer(reportCode, options = {}) {
  const workbook = XLSX.utils.book_new();
  const rows = buildReportRows(reportCode, options.rows || {});
  CARBON_EMISSION_REPORT_SHEETS.forEach((contract, sheetIndex) => {
    const worksheet = XLSX.utils.aoa_to_sheet([contract.headers, ...rows[contract.key]]);
    if (typeof options.mutateWorksheet === 'function') {
      options.mutateWorksheet({ workbook, worksheet, contract, sheetIndex });
    }
    const sheetName = options.sheetNames?.[sheetIndex] || contract.name;
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  });
  if (options.hiddenSheetIndex !== undefined) {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = workbook.SheetNames.map((name, index) => ({ name, Hidden: index === options.hiddenSheetIndex ? 1 : 0 }));
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function findZipEndOffset(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error('测试 XLSX 缺少 ZIP 中央目录结束记录。');
}

function mutateFirstZipEntryDeclaredSize(buffer, declaredSize) {
  const clone = Buffer.from(buffer);
  const endOffset = findZipEndOffset(clone);
  const centralOffset = clone.readUInt32LE(endOffset + 16);
  assert.strictEqual(clone.readUInt32LE(centralOffset), 0x02014b50);
  clone.writeUInt32LE(declaredSize, centralOffset + 24);
  return clone;
}

/** 读取 ZIP 中央目录条目，供安全边界定点篡改测试复用。 */
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

/** 重写指定 XLSX XML 条目并重新生成 ZIP。 */
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

/** 断言工作簿安全检查返回 N6 稳定错误。 */
function assertWorkbookError(buffer, expectedCode, expectedStatusCode = null) {
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(buffer, 'unsafe.xlsx'),
    (error) => (
      (error?.code === expectedCode || error?.details?.code === expectedCode)
      && (expectedStatusCode === null || error.statusCode === expectedStatusCode)
    )
  );
}

function storeUpload(fileName, buffer, originalname = '碳排放报告.xlsx') {
  fs.writeFileSync(path.join(uploadsDir, fileName), buffer);
  return {
    path: path.join(uploadsDir, fileName),
    filename: fileName,
    originalname,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length
  };
}

function openTestDatabase() {
  return openDatabase({ databasePath });
}

function buildServiceOptions(overrides = {}) {
  return {
    uploadsDir,
    openDatabase: openTestDatabase,
    env: { ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: 'carbon-emission-report-test-secret-2026' },
    actor: { userId: 1, ip: '127.0.0.1' },
    ...overrides
  };
}

function countRows(tableName) {
  const db = openTestDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
  } finally {
    db.close();
  }
}

function snapshotProtectedTables() {
  return Object.fromEntries(PROTECTED_TABLES.map((tableName) => [tableName, countRows(tableName)]));
}

async function assertAsyncCode(action, expectedCode) {
  const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
  await assert.rejects(async () => action(), (error) => (
    expectedCodes.includes(error?.code) || expectedCodes.includes(error?.details?.code)
  ));
}

async function run() {
  initDatabase({ databasePath });
  // 隔离数据库连接变量：各场景显式打开并在 finally 关闭。
  let db;
  const validBuffer = buildWorkbookBuffer('CER-IMPORT-001');
  const parsed = parseCarbonEmissionReportWorkbook(validBuffer, 'valid.xlsx');
  assert.strictEqual(parsed.report.length, 1);
  assert.strictEqual(parsed.boundaries.length, 2);

  // 固定数值列必须读取真实 cell.v：千分位、普通小数、真实零和百分比均不得按显示文本误判。
  const formattedNumericBuffer = buildWorkbookBuffer('CER-NUMERIC-FORMAT-001', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') {
        worksheet.E2 = { t: 'n', v: 1234.5, z: '#,##0.00' };
        worksheet.G2 = { t: 'n', v: 0.125, z: '0.00%' };
        worksheet.I2 = { t: 'n', v: 0, z: '#,##0.00' };
        worksheet.E3 = { t: 'n', v: 0 };
        worksheet.G3 = { t: 'n', v: 0.001 };
        worksheet.I3 = { t: 'n', v: 3.75 };
      }
      if (contract.key === 'summaries') {
        worksheet.D2 = { t: 'n', v: 3.75, z: '#,##0.00' };
        worksheet.D3 = { t: 'n', v: 0, z: '#,##0.00' };
        worksheet.D4 = { t: 'n', v: 3.75 };
      }
    }
  });
  const formattedNumericParsed = parseCarbonEmissionReportWorkbook(
    formattedNumericBuffer,
    'formatted-numeric.xlsx'
  );
  assert.strictEqual(formattedNumericParsed.items[0].values[4], 1234.5);
  assert.strictEqual(formattedNumericParsed.items[0].values[6], 0.125,
    '百分比格式必须采用底层 0.125，不得转换为显示值 12.50 或字符串 12.50%。');
  assert.strictEqual(formattedNumericParsed.items[0].values[8], 0);
  assert.strictEqual(formattedNumericParsed.items[1].values[4], 0);
  assert.strictEqual(formattedNumericParsed.items[1].values[8], 3.75);
  assert.strictEqual(formattedNumericParsed.summaries[0].values[3], 3.75);
  db = openTestDatabase();
  try {
    const formattedNumericPreview = buildCarbonEmissionReportImportPreview({
      db,
      buffer: formattedNumericBuffer,
      originalFilename: 'formatted-numeric.xlsx'
    });
    assert.strictEqual(formattedNumericPreview.summary.wouldImport, 1);
    assert.strictEqual(formattedNumericPreview.candidateRows[0].items[0].factorValue, 0.125);
    assert.strictEqual(formattedNumericPreview.candidateRows[0].items[0].emissionValue, 0);
  } finally {
    db.close();
  }

  const invalidNumericTextBuffer = buildWorkbookBuffer('CER-NUMERIC-TEXT-001', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.E2 = { t: 's', v: '1,234.50' };
    }
  });
  db = openTestDatabase();
  try {
    const invalidNumericTextPreview = buildCarbonEmissionReportImportPreview({
      db,
      buffer: invalidNumericTextBuffer,
      originalFilename: 'invalid-numeric-text.xlsx'
    });
    assert.strictEqual(invalidNumericTextPreview.summary.blocked, 1);
    assert(invalidNumericTextPreview.auditIssues.some(
      (issue) => issue.code === 'CARBON_EMISSION_REPORT_ACTIVITY_VALUE_INVALID'
    ));
  } finally {
    db.close();
  }
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(validBuffer, 'valid.csv'),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_XLSX_REQUIRED'
  );
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(Buffer.from('not-an-xlsx'), 'fake.xlsx'),
    (error) => error?.code === 'CARBON_EMISSION_REPORT_IMPORT_ZIP_DIRECTORY_INVALID'
  );

  const wrongHeaderBuffer = buildWorkbookBuffer('CER-WRONG-HEADER', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.A1.v = 'itemCode';
    }
  });
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(wrongHeaderBuffer, 'wrong-header.xlsx'),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_HEADERS_MISMATCH'
  );

  const formulaBuffer = buildWorkbookBuffer('CER-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.E2 = { t: 'n', f: 'SUM(1,1)', v: 2 };
    }
  });
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(formulaBuffer, 'formula.xlsx'),
    (error) => error?.code === 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED'
  );
  const hiddenBuffer = buildWorkbookBuffer('CER-HIDDEN', { hiddenSheetIndex: 1 });
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(hiddenBuffer, 'hidden.xlsx'),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_SHEET_CONTRACT_INVALID'
  );
  const mergedBuffer = buildWorkbookBuffer('CER-MERGED', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'report') worksheet['!merges'] = [XLSX.utils.decode_range('A2:B2')];
    }
  });
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(mergedBuffer, 'merged.xlsx'),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_MERGED_CELLS_REJECTED'
  );
  const resourceBuffer = mutateFirstZipEntryDeclaredSize(
    validBuffer,
    CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1
  );
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(resourceBuffer, 'resource.xlsx'),
    (error) => error?.code === 'CARBON_EMISSION_REPORT_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED' && error.statusCode === 413
  );

  // N6 必须直接覆盖 ZIP64、分卷、加密、路径穿越和重复条目拒绝边界。
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(1, endOffset + 4);
  }), 'CARBON_EMISSION_REPORT_IMPORT_ZIP_MULTIDISK_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(0xffff, endOffset + 8);
    buffer.writeUInt16LE(0xffff, endOffset + 10);
  }), 'CARBON_EMISSION_REPORT_IMPORT_ZIP64_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    buffer.writeUInt16LE(buffer.readUInt16LE(entries[0].offset + 8) | 1, entries[0].offset + 8);
  }), 'CARBON_EMISSION_REPORT_IMPORT_ZIP_ENCRYPTED_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    Buffer.from('../', 'utf8').copy(buffer, entries[0].filenameStart);
  }), 'CARBON_EMISSION_REPORT_IMPORT_ZIP_ENTRY_PATH_INVALID');
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
  }), 'CARBON_EMISSION_REPORT_IMPORT_ZIP_ENTRY_DUPLICATED');

  // 无缓存、命名空间和 dimension 低报公式必须在原始工作表 XML 层 fail-closed。
  const noCachedFormulaText = 'SENSITIVE_NO_CACHE_FORMULA';
  const noCachedFormulaBuffer = buildWorkbookBuffer('CER-NO-CACHED-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.E2 = { t: 'n', f: noCachedFormulaText };
    }
  });
  const noCachedSheetJsWorkbook = XLSX.read(noCachedFormulaBuffer, { type: 'buffer' });
  assert.strictEqual(noCachedSheetJsWorkbook.Sheets['报告项目'].E2, undefined);
  assertWorkbookError(noCachedFormulaBuffer, 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED');
  const namespacedFormulaBuffer = rewriteXlsxEntry(
    noCachedFormulaBuffer,
    'xl/worksheets/sheet3.xml',
    (worksheetXml) => {
      const originalFormulaElement = `<f>${noCachedFormulaText}</f>`;
      assert(worksheetXml.includes(originalFormulaElement));
      return worksheetXml.replace(
        originalFormulaElement,
        '<x:f xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" t="shared" />'
      );
    }
  );
  assertWorkbookError(namespacedFormulaBuffer, 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED');
  const outsideReferenceFormulaText = 'SENSITIVE_OUTSIDE_REFERENCE_FORMULA';
  const outsideReferenceFormulaBuffer = buildWorkbookBuffer('CER-LOW-DIMENSION-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') {
        worksheet.M2 = { t: 'n', f: outsideReferenceFormulaText };
        worksheet['!ref'] = 'A1:M3';
      }
    }
  });
  const lowDimensionFormulaBuffer = rewriteXlsxEntry(
    outsideReferenceFormulaBuffer,
    'xl/worksheets/sheet3.xml',
    (worksheetXml) => {
      assert(worksheetXml.includes('<dimension ref="A1:M3"/>'));
      return worksheetXml.replace('<dimension ref="A1:M3"/>', '<dimension ref="A1:L3"/>');
    }
  );
  const lowDimensionSheetJsWorkbook = XLSX.read(lowDimensionFormulaBuffer, { type: 'buffer' });
  assert.strictEqual(lowDimensionSheetJsWorkbook.Sheets['报告项目'].M2, undefined);
  assertWorkbookError(lowDimensionFormulaBuffer, 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED');

  // 真实 N7 六表工作簿必须在 N6 结构合同边界直接阻断，不能伪造成五表后只校验模板身份。
  const ghgTemplate = getTemplateXlsx('ghg-report');
  assert.deepStrictEqual(XLSX.read(ghgTemplate.buffer, { type: 'buffer' }).SheetNames, [
    '报告信息', '组织边界', '运行边界', '报告项目', '汇总', '证据说明'
  ]);
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(ghgTemplate.buffer, ghgTemplate.fileName),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_SHEET_CONTRACT_INVALID'
  );

  // 兼容字符在 NFKC 后可能膨胀，四类持久化规范键均必须按规范化结果阻断超长值。
  const expandedCode = 'ﬃ'.repeat(43);
  const expandedRows = buildReportRows(expandedCode);
  expandedRows.items[0][0] = expandedCode;
  expandedRows.items[0][10] = expandedCode;
  expandedRows.evidence[0][0] = expandedCode;
  expandedRows.summaries[0][0] = expandedCode;
  const expandedKeyBuffer = buildWorkbookBuffer(expandedCode, { rows: expandedRows });
  db = openTestDatabase();
  try {
    const expandedKeyPreview = buildCarbonEmissionReportImportPreview({
      db,
      buffer: expandedKeyBuffer,
      originalFilename: 'expanded-key.xlsx'
    });
    const expandedKeyIssues = expandedKeyPreview.auditIssues.filter(
      (issue) => issue.code === 'CARBON_EMISSION_REPORT_NORMALIZED_KEY_TOO_LONG'
    );
    assert(expandedKeyIssues.some((issue) => issue.fieldName === '报告信息.报告编码'));
    assert(expandedKeyIssues.some((issue) => issue.fieldName === '报告项目.项目编码'));
    assert(expandedKeyIssues.some((issue) => issue.fieldName === '证据说明.证据编号'));
    assert(expandedKeyIssues.some((issue) => issue.fieldName === '汇总.汇总编码'));
    assert.strictEqual(expandedKeyPreview.candidateRows.length, 0);
  } finally {
    db.close();
  }

  // 取得服务端 SHA 后的无效 ZIP、公式和合同错误必须留下原子的 failed 批次、脱敏 issue 与领域预演审计。
  const failedPreviewCases = [
    {
      storedFilename: 'failed-invalid-zip.xlsx',
      buffer: Buffer.from('not-an-xlsx'),
      expectedCode: 'CARBON_EMISSION_REPORT_IMPORT_ZIP_DIRECTORY_INVALID'
    },
    {
      storedFilename: 'failed-formula.xlsx',
      buffer: formulaBuffer,
      expectedCode: 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED'
    },
    {
      storedFilename: 'failed-contract.xlsx',
      buffer: wrongHeaderBuffer,
      expectedCode: 'CARBON_EMISSION_REPORT_IMPORT_HEADERS_MISMATCH'
    }
  ];
  for (const failedCase of failedPreviewCases) {
    const failedUpload = storeUpload(failedCase.storedFilename, failedCase.buffer);
    await assertAsyncCode(
      () => previewCarbonEmissionReportImport(failedUpload, buildServiceOptions()),
      failedCase.expectedCode
    );
    db = openTestDatabase();
    try {
      const failedBatch = db.prepare(`SELECT id, status, audit_phase AS auditPhase, file_sha256 AS fileSha256,
        preview_signature AS previewSignature, preview_audit_digest AS previewAuditDigest
        FROM import_batches WHERE stored_filename = ?`).get(failedCase.storedFilename);
      assert(failedBatch, '解析失败必须持久化统一导入批次。');
      assert.strictEqual(failedBatch.status, 'failed');
      assert.strictEqual(failedBatch.auditPhase, 'preview');
      assert.match(failedBatch.fileSha256, /^[0-9a-f]{64}$/);
      assert.match(failedBatch.previewSignature, /^hmac-sha256:v1:/);
      assert.match(failedBatch.previewAuditDigest, /^hmac-sha256:v1:audit:/);
      const failedIssue = db.prepare(`SELECT error_code AS errorCode, error_reason AS errorReason, raw_value AS rawValue
        FROM import_errors WHERE batch_id = ?`).get(failedBatch.id);
      assert.strictEqual(failedIssue.errorCode, failedCase.expectedCode);
      assert.strictEqual(failedIssue.rawValue, null);
      assert(!failedIssue.errorReason.includes(temporaryRoot));
      assert(db.prepare(`SELECT 1 FROM sys_operation_logs
        WHERE operation = 'carbon.emission-report.import.preview' AND target_id = ?`).get(String(failedBatch.id)));
    } finally {
      db.close();
    }
    assert(fs.existsSync(path.join(uploadsDir, failedCase.storedFilename)), '已被 failed 批次引用的原文件必须保留用于受控追溯。');
    assert.strictEqual(countRows('carbon_emission_reports'), 0, '解析失败不得写报告业务事实。');
  }

  // 领域预演审计钩子失败时批次、issue 和操作审计必须同事务回滚，不留下半成品。
  const failedBatchCountBeforeAuditHook = countRows('import_batches');
  const failedIssueCountBeforeAuditHook = countRows('import_errors');
  const failedOperationCountBeforeAuditHook = countRows('sys_operation_logs');
  const failingAuditDescriptor = {
    ...CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR,
    persistPreviewAudit(context) {
      CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR.persistPreviewAudit(context);
      throw new Error('sensitive preview audit hook failure');
    }
  };
  assert.throws(
    () => createEnergyAnalysisSingleBatchPreview(
      storeUpload('failed-audit-hook.xlsx', Buffer.from('not-an-xlsx')),
      failingAuditDescriptor,
      buildServiceOptions()
    ),
    /sensitive preview audit hook failure/
  );
  assert.strictEqual(countRows('import_batches'), failedBatchCountBeforeAuditHook);
  assert.strictEqual(countRows('import_errors'), failedIssueCountBeforeAuditHook);
  assert.strictEqual(countRows('sys_operation_logs'), failedOperationCountBeforeAuditHook);
  assert.strictEqual(countRows('carbon_emission_reports'), 0);

  const protectedBefore = snapshotProtectedTables();
  const previewUpload = storeUpload('preview-zero-write.xlsx', validBuffer);
  const preview = previewCarbonEmissionReportImport(previewUpload, buildServiceOptions());
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(countRows('carbon_emission_reports'), 0, 'preview 不得写报告业务事实。');
  assert.deepStrictEqual(snapshotProtectedTables(), protectedBefore);
  db = openTestDatabase();
  try {
    const batch = db.prepare(`SELECT stored_filename AS storedFilename, file_sha256 AS fileSha256,
      preview_signature AS previewSignature, preview_audit_digest AS previewAuditDigest,
      audit_context_json AS auditContextJson FROM import_batches WHERE id = ?`).get(preview.batchId);
    assert.strictEqual(batch.storedFilename, previewUpload.filename);
    assert.match(batch.fileSha256, /^[0-9a-f]{64}$/);
    assert.match(batch.previewSignature, /^hmac-sha256:v1:/);
    assert.match(batch.previewAuditDigest, /^hmac-sha256:v1:audit:/);
    assert(JSON.parse(batch.auditContextJson).candidateRows.length === 1);
  } finally {
    db.close();
  }

  // 客户端篡改候选见证必须失败。
  await assertAsyncCode(() => executeCarbonEmissionReportImport({
    batchId: preview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    candidateRows: [{ candidateRowId: 'client-controlled' }]
  }, buildServiceOptions()), [
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'
  ]);
  assert.strictEqual(countRows('carbon_emission_reports'), 0);

  // 持久化签名篡改必须失败。
  const signaturePreview = previewCarbonEmissionReportImport(
    storeUpload('signature-tamper.xlsx', buildWorkbookBuffer('CER-SIGNATURE-001')),
    buildServiceOptions()
  );
  db = openTestDatabase();
  try {
    db.prepare("UPDATE import_batches SET preview_signature = 'hmac-sha256:v1:tampered' WHERE id = ?")
      .run(signaturePreview.batchId);
  } finally { db.close(); }
  await assertAsyncCode(() => executeCarbonEmissionReportImport({
    batchId: signaturePreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID');

  // 原文件在 preview 后变化必须 fail-closed。
  const changedPreviewUpload = storeUpload('source-change.xlsx', buildWorkbookBuffer('CER-SOURCE-001'));
  const changedPreview = previewCarbonEmissionReportImport(changedPreviewUpload, buildServiceOptions());
  fs.writeFileSync(changedPreviewUpload.path, Buffer.from('changed-after-preview'));
  await assertAsyncCode(() => executeCarbonEmissionReportImport({
    batchId: changedPreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), 'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH');

  // 数据库在 preview 后出现同报告编码，锁前重算必须阻断 stale。
  const staleBuffer = buildWorkbookBuffer('CER-STALE-001');
  const stalePreview = previewCarbonEmissionReportImport(storeUpload('stale.xlsx', staleBuffer), buildServiceOptions());
  db = openTestDatabase();
  try {
    const staleBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_emission_report', 'manual.xlsx', 'manual.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO carbon_emission_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('CER-STALE-001', 'CER-STALE-001', '并发写入', '测试组织', '2026-01-01', '2026-12-31', ?, 2)`)
      .run(staleBatchId);
  } finally { db.close(); }
  await assertAsyncCode(() => executeCarbonEmissionReportImport({
    batchId: stalePreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), [
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'
  ]);

  // 已存在报告编码在 preview 和 execute 都确定性阻断，不产生 skip 候选。
  db = openTestDatabase();
  try {
    const duplicatePreview = buildCarbonEmissionReportImportPreview({ db, buffer: staleBuffer, originalFilename: 'duplicate.xlsx' });
    assert.strictEqual(duplicatePreview.summary.blocked, 1);
    assert.strictEqual(duplicatePreview.summary.skipped, 0);
    assert.strictEqual(duplicatePreview.candidateRows.length, 0);
    assert(duplicatePreview.auditIssues.some((issue) => issue.code === 'CARBON_EMISSION_REPORT_CODE_EXISTS'));
  } finally { db.close(); }

  // 备份失败必须不写报告事实，并返回稳定 503 领域码。
  const backupPreview = previewCarbonEmissionReportImport(
    storeUpload('backup-failure.xlsx', buildWorkbookBuffer('CER-BACKUP-001')),
    buildServiceOptions()
  );
  const reportCountBeforeBackupFailure = countRows('carbon_emission_reports');
  await assertAsyncCode(() => executeCarbonEmissionReportImport({
    batchId: backupPreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions({ createBackup: async () => { throw new Error('sensitive backup path'); } })),
  'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(countRows('carbon_emission_reports'), reportCountBeforeBackupFailure);

  // 插入器在写入主表后异常时，BEGIN IMMEDIATE 事务必须回滚全部业务和操作审计写入。
  const rollbackPreview = previewCarbonEmissionReportImport(
    storeUpload('rollback.xlsx', buildWorkbookBuffer('CER-ROLLBACK-001')),
    buildServiceOptions()
  );
  const rollbackDescriptor = {
    ...CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR,
    insertCandidates(context) {
      CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR.insertCandidates(context);
      throw new Error('sensitive transaction failure');
    }
  };
  const reportCountBeforeRollback = countRows('carbon_emission_reports');
  await assertAsyncCode(() => executeEnergyAnalysisSingleBatchImport({
    batchId: rollbackPreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, rollbackDescriptor, buildServiceOptions({
    createBackup: async () => ({ backupName: 'rollback.sqlite', reason: 'carbon-emission-report-import', sizeBytes: 1, sha256: 'a'.repeat(64), method: 'test', createdAt: new Date().toISOString() })
  })), 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countRows('carbon_emission_reports'), reportCountBeforeRollback);

  // 最终成功导入必须完成五表、审计、备份和批次追溯，并保持其他碳领域数据不变。
  const successPreview = previewCarbonEmissionReportImport(
    storeUpload('success.xlsx', buildWorkbookBuffer('CER-SUCCESS-001')),
    buildServiceOptions()
  );
  const protectedBeforeSuccess = snapshotProtectedTables();
  const success = await executeCarbonEmissionReportImport({
    batchId: successPreview.batchId,
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions());
  assert.strictEqual(success.imported, 1);
  assert(success.backup);
  assert.deepStrictEqual(snapshotProtectedTables(), protectedBeforeSuccess);
  const detail = getCarbonEmissionReportByBatch(successPreview.batchId);
  assert.strictEqual(detail.report.reportCode, 'CER-SUCCESS-001');
  assert.strictEqual(detail.boundaries.length, 2);
  assert.strictEqual(detail.items.length, 2);
  assert.strictEqual(detail.summaries.length, 3);
  assert.strictEqual(detail.evidence.length, 2);
  assert.strictEqual(listCarbonEmissionReports({ reportCode: 'cer-success-001' }).rows.length, 1);
  db = openTestDatabase();
  try {
    const batch = db.prepare(`SELECT status, audit_phase AS auditPhase, backup_json AS backupJson,
      execute_result_json AS executeResultJson FROM import_batches WHERE id = ?`).get(successPreview.batchId);
    assert.strictEqual(batch.status, 'completed');
    assert.strictEqual(batch.auditPhase, 'execute');
    assert(batch.backupJson);
    assert(JSON.parse(batch.executeResultJson).executed);
    const operations = db.prepare(`SELECT operation FROM sys_operation_logs
      WHERE target_type = 'carbon_emission_report' ORDER BY id`).all().map((row) => row.operation);
    assert(operations.includes('carbon.emission-report.import.preview'));
    assert(operations.includes('carbon.emission-report.import.execute'));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }

  console.log('carbonEmissionReportImport tests passed');
}

run().finally(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
