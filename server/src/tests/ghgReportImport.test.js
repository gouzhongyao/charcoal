'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-ghg-report-import-'));
const databasePath = path.join(temporaryRoot, 'ghg-report.sqlite');
const uploadsDir = path.join(temporaryRoot, 'uploads');
const backupsDir = path.join(temporaryRoot, 'backups');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = uploadsDir;
process.env.BACKUPS_DIR = backupsDir;
process.env.SQLITE_PATH = databasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'GhgReportImport123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'ghg-report-import-test-secret-2026';
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const { initDatabase, openDatabase } = require('../db/database');
const {
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_IMPORT_DESCRIPTOR,
  buildGhgReportImportPreview,
  executeGhgReportImport,
  ghgReportNumbersEqual,
  parseGhgReportWorkbook,
  previewGhgReportImport
} = require('../services/ghgReportImportService');
const {
  GHG_REPORT_RESOURCE_LIMITS,
  GHG_REPORT_SHEETS,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION
} = require('../services/ghgReportContracts');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('../services/energyAnalysisSingleBatchImportService');
const {
  getGhgReportByBatch,
  listGhgReports
} = require('../services/ghgReportService');
const { parseCarbonEmissionReportWorkbook } = require('../services/carbonEmissionReportImportService');
const { getTemplateXlsx } = require('../services/templateService');

// N7 导入前后必须保持不变的 N6 和其他碳领域事实表。
const PROTECTED_TABLES = Object.freeze([
  'carbon_emission_reports',
  'carbon_emission_report_boundaries',
  'carbon_emission_report_items',
  'carbon_emission_report_summaries',
  'carbon_emission_report_evidence',
  'carbon_activity_records',
  'carbon_calculation_runs',
  'carbon_accounting_results',
  'carbon_emissions',
  'carbon_factors'
]);

/** 构造一份同时包含排放和清除的固定六表报告。 */
function buildGhgReportRows(reportCode, overrides = {}) {
  const rows = {
    report: [[reportCode, `报告 ${reportCode}`, '测试组织', '2026-01-01', '2026-12-31',
      GHG_REPORT_TEMPLATE_TYPE, GHG_REPORT_TEMPLATE_VERSION, '报告备注']],
    organizationBoundaries: [
      ['ORG-001', '测试组织全部受控设施', '运营控制法', '报告期间内全部受控设施']
    ],
    operationalBoundaries: [
      ['范围一', '固定燃烧', '天然气锅炉与园区碳汇'],
      ['范围二', '购入电力', '购入电力间接排放']
    ],
    items: [
      ['ITEM-001', '排放', '范围二', '购入电力', 'CO2', '购入电力', 12000, 'kWh', 6.84, 1, 6.84, 'tCO2e', '活动数据法', 'EVID-001', '=项目备注'],
      ['ITEM-002', '清除', '范围一', '固定燃烧', 'CO2', '园区碳汇', 10, 'tCO2', 0.5, 1, 0.5, 'tCO2e', '碳汇监测法', 'EVID-002', '清除量保持正数']
    ],
    summaries: [
      ['TOTAL-001', '总计', '全部', 6.84, 0.5, 6.34, 'tCO2e', '总计'],
      ['TYPE-001', '记录类型', '排放', 6.84, 0, 6.84, 'tCO2e', '排放'],
      ['TYPE-002', '记录类型', '清除', 0, 0.5, -0.5, 'tCO2e', '清除']
    ],
    evidence: [
      ['EVID-001', '电力证据', '计量记录', '电力计量汇总', '@证据备注'],
      ['EVID-002', '碳汇证据', '监测记录', '园区碳汇监测记录', '证据备注']
    ]
  };
  Object.entries(overrides).forEach(([key, value]) => { rows[key] = value; });
  return rows;
}

/** 将固定六表数据写为 XLSX，并允许定点修改工作表。 */
function buildWorkbookBuffer(reportCode, options = {}) {
  const workbook = XLSX.utils.book_new();
  const rows = buildGhgReportRows(reportCode, options.rows || {});
  GHG_REPORT_SHEETS.forEach((contract, sheetIndex) => {
    const worksheet = XLSX.utils.aoa_to_sheet([contract.headers, ...rows[contract.key]]);
    if (typeof options.mutateWorksheet === 'function') {
      options.mutateWorksheet({ workbook, worksheet, contract, sheetIndex });
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, options.sheetNames?.[sheetIndex] || contract.name);
  });
  if (options.hiddenSheetIndex !== undefined) {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = workbook.SheetNames.map((name, index) => ({
      name,
      Hidden: index === options.hiddenSheetIndex ? 1 : 0
    }));
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 定位 ZIP 中央目录结束记录。 */
function findZipEndOffset(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error('测试 XLSX 缺少 ZIP 中央目录结束记录。');
}

/** 读取 ZIP 中央目录条目。 */
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

/** 篡改首个 ZIP 条目的声明解压大小。 */
function mutateFirstZipEntryDeclaredSize(buffer, declaredSize) {
  return mutateXlsxArchive(buffer, (clone, _endOffset, entries) => {
    clone.writeUInt32LE(declaredSize, entries[0].offset + 24);
  });
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

/** 断言工作簿安全检查返回 N7 稳定错误。 */
function assertWorkbookError(buffer, expectedCode, expectedStatusCode = null) {
  assert.throws(
    () => parseGhgReportWorkbook(buffer, 'unsafe.xlsx'),
    (error) => (
      (error?.code === expectedCode || error?.details?.code === expectedCode)
      && (expectedStatusCode === null || error.statusCode === expectedStatusCode)
    )
  );
}

/** 将测试文件持久化到隔离上传目录。 */
function storeUpload(fileName, buffer, originalname = '温室气体报告.xlsx') {
  fs.writeFileSync(path.join(uploadsDir, fileName), buffer);
  return {
    path: path.join(uploadsDir, fileName),
    filename: fileName,
    originalname,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length
  };
}

/** 打开当前隔离数据库。 */
function openTestDatabase() {
  return openDatabase({ databasePath });
}

/** 构造受控导入服务依赖。 */
function buildServiceOptions(overrides = {}) {
  return {
    uploadsDir,
    openDatabase: openTestDatabase,
    env: { ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET },
    actor: { userId: 1, ip: '127.0.0.1' },
    ...overrides
  };
}

/** 查询指定表的行数。 */
function countRows(tableName) {
  const db = openTestDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
  } finally {
    db.close();
  }
}

/** 为全部跨领域保护表写入可辨识且满足真实依赖的业务事实。 */
function seedProtectedDomainFacts() {
  const db = openTestDatabase();
  try {
    db.transaction(() => {
      const now = '2026-01-01T00:00:00Z';
      const adminId = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id;
      const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const organizationUnitId = db.prepare(`INSERT INTO organization_units
        (unit_code, unit_name, unit_path, unit_type, status, remark, created_at, updated_at)
        VALUES ('GHG-PROTECTED-ORG', 'N7跨领域保护组织', '/GHG-PROTECTED-ORG', 'enterprise',
          'active', '用于校验 N7 导入不得 UPDATE 其他领域', ?, ?)`).run(now, now).lastInsertRowid;
      const factorId = db.prepare(`INSERT INTO carbon_factors
        (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source,
         source_url, effective_from, effective_to, is_active, created_at, updated_at)
        VALUES (?, 'ghg-protected', 2026, 'kWh', 0.57, 'kgCO2e', 'N7跨领域保护因子',
          'https://example.invalid/ghg-protected-factor', '2026-01-01', '2026-12-31', 1, ?, ?)`).run(
        energyTypeId,
        now,
        now
      ).lastInsertRowid;
      const energyRecordId = db.prepare(`INSERT INTO energy_records
        (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
         original_value, normalized_unit, normalized_value, remark, duplicate_key, record_status,
         created_at, updated_at)
        VALUES (?, ?, '2026-01', '2026-01', 'kWh', 123.45, 'kWh', 123.45,
          'N7 不得修改该能耗依赖', 'ghg-protected-energy-record', 'active', ?, ?)`).run(
        energyTypeId,
        organizationUnitId,
        now,
        now
      ).lastInsertRowid;
      db.prepare(`INSERT INTO carbon_emissions
        (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, factor_value,
         activity_value, activity_unit, emission_value, emission_unit, status, calculated_at, note)
        VALUES (?, ?, 'standard-factor', 'normalized_value * factor_value', 0.57,
          123.45, 'kWh', 70.3665, 'kgCO2e', 'calculated', ?, 'N7跨领域保护旧排放')`).run(
        energyRecordId,
        factorId,
        now
      );
      const activityId = db.prepare(`INSERT INTO carbon_activity_records
        (source_type, activity_code, activity_code_key, emission_scope, activity_category,
         activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
         end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
         factor_region, source_reference, evidence_reference, note, duplicate_key, record_status,
         created_by, created_at, updated_at)
        VALUES ('independent_activity', 'GHG-PROTECTED-ACTIVITY', 'GHG-PROTECTED-ACTIVITY',
          'scope_2', '购入电力', '购入电力', ?, ?, '2026-01-01T00:00', '2026-02-01T00:00',
          'Asia/Shanghai', '2025-12-31T16:00:00Z', '2026-01-31T16:00:00Z', 123.45, 'kWh',
          'ghg-protected', 'N7跨领域保护来源', 'N7跨领域保护证据', 'N7不得修改独立活动',
          ?, 'active', ?, ?, ?)`).run(
        organizationUnitId,
        energyTypeId,
        'b'.repeat(64),
        adminId,
        now,
        now
      ).lastInsertRowid;
      const runId = db.prepare(`INSERT INTO carbon_calculation_runs
        (run_code, snapshot_schema_version, source_type, status, calculation_method, start_utc,
         end_utc, activity_filter_json, actor_snapshot_json, activity_snapshot_digest,
         activity_count, result_count, calculated_count, factor_missing_count,
         emission_totals_json, created_by, started_at, completed_at, created_at)
        VALUES ('GHG-PROTECTED-RUN', 1, 'independent_activity', 'completed', 'standard-factor',
          '2025-12-31T16:00:00Z', '2026-01-31T16:00:00Z', ?, ?, ?, 1, 1, 1, 0,
          ?, ?, ?, ?, ?)`).run(
        JSON.stringify({ version: 1, marker: 'ghg-protected-filter' }),
        JSON.stringify({ version: 1, marker: 'ghg-protected-actor' }),
        'c'.repeat(64),
        JSON.stringify({ version: 1, total: 70.3665, unit: 'kgCO2e' }),
        adminId,
        now,
        now,
        now
      ).lastInsertRowid;
      const snapshotJson = (marker) => JSON.stringify({ version: 1, marker });
      db.prepare(`INSERT INTO carbon_accounting_results
        (calculation_run_id, snapshot_schema_version, source_type, activity_record_id,
         carbon_factor_id, emission_scope, activity_category, organization_unit_id, energy_type_id,
         activity_start_wall_clock, activity_end_wall_clock, activity_start_utc, activity_end_utc,
         activity_value, activity_unit, requested_region, factor_year, factor_value, factor_unit,
         emission_value, emission_unit, status, missing_reason, calculation_basis, match_priority,
         activity_snapshot_json, organization_snapshot_json, energy_type_snapshot_json,
         factor_snapshot_json, matching_snapshot_json, formula_snapshot_json, created_at)
        VALUES (?, 1, 'independent_activity', ?, ?, 'scope_2', '购入电力', ?, ?,
          '2026-01-01T00:00', '2026-02-01T00:00', '2025-12-31T16:00:00Z',
          '2026-01-31T16:00:00Z', 123.45, 'kWh', 'ghg-protected', 2026, 0.57,
          'kgCO2e/kWh', 70.3665, 'kgCO2e', 'calculated', NULL,
          'activity_value * factor_value', 1, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId,
        activityId,
        factorId,
        organizationUnitId,
        energyTypeId,
        snapshotJson('activity'),
        snapshotJson('organization'),
        snapshotJson('energy-type'),
        snapshotJson('factor'),
        snapshotJson('matching'),
        snapshotJson('formula'),
        now
      );
      const reportBatchId = db.prepare(`INSERT INTO import_batches
        (import_type, original_filename, stored_filename, file_type, status, total_rows,
         success_count, failure_count, skipped_count)
        VALUES ('carbon_emission_report', 'protected-n6.xlsx', 'protected-n6.xlsx', 'xlsx',
          'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
      const reportId = db.prepare(`INSERT INTO carbon_emission_reports
        (report_code, report_code_key, report_name, report_organization, period_start, period_end,
         source_batch_id, source_row_number, created_by, created_at)
        VALUES ('N6-PROTECTED-001', 'N6-PROTECTED-001', 'N7跨领域保护N6报告',
          'N7跨领域保护组织', '2026-01-01', '2026-12-31', ?, 2, ?, ?)`).run(
        reportBatchId,
        adminId,
        now
      ).lastInsertRowid;
      db.prepare(`INSERT INTO carbon_emission_report_boundaries
        (report_id, boundary_type, boundary_name, boundary_description, source_row_number)
        VALUES (?, 'organization', '保护组织边界', 'N7不得修改N6边界', 2)`).run(reportId);
      const evidenceId = db.prepare(`INSERT INTO carbon_emission_report_evidence
        (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type,
         evidence_description, note, source_row_number)
        VALUES (?, 'N6-EVID-PROTECTED', 'N6-EVID-PROTECTED', '保护证据', '原始凭证',
          'N7不得修改N6证据', '保护备注', 2)`).run(reportId).lastInsertRowid;
      db.prepare(`INSERT INTO carbon_emission_report_items
        (report_id, item_code, item_code_key, emission_scope, category, emission_source,
         activity_value, activity_unit, factor_value, factor_unit, emission_value, co2e_unit,
         evidence_id, note, source_row_number)
        VALUES (?, 'N6-ITEM-PROTECTED', 'N6-ITEM-PROTECTED', 'scope_2', '购入电力',
          '保护电力来源', 123.45, 'kWh', 0.57, 'kgCO2e/kWh', 70.3665, 'kgCO2e',
          ?, 'N7不得修改N6项目', 2)`).run(reportId, evidenceId);
      db.prepare(`INSERT INTO carbon_emission_report_summaries
        (report_id, summary_code, summary_code_key, summary_dimension, summary_value,
         emission_value, co2e_unit, note, source_row_number)
        VALUES (?, 'N6-TOTAL-PROTECTED', 'N6-TOTAL-PROTECTED', 'total', '全部',
          70.3665, 'kgCO2e', 'N7不得修改N6汇总', 2)`).run(reportId);
    })();
  } finally {
    db.close();
  }
}

/** 对完整排序行生成稳定内容摘要和行数，任何不改变行数的 UPDATE 也必须可检测。 */
function snapshotProtectedTables() {
  const db = openTestDatabase();
  try {
    return Object.fromEntries(PROTECTED_TABLES.map((tableName) => {
      const rows = db.prepare(`SELECT * FROM ${tableName} ORDER BY id`).all();
      const digest = crypto.createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
      return [tableName, { rowCount: rows.length, digest }];
    }));
  } finally {
    db.close();
  }
}

/** 断言异步动作返回指定稳定错误码。 */
async function assertAsyncCode(action, expectedCode) {
  const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
  await assert.rejects(async () => action(), (error) => (
    expectedCodes.includes(error?.code) || expectedCodes.includes(error?.details?.code)
  ));
}

async function run() {
  initDatabase({ databasePath });
  seedProtectedDomainFacts();
  let db;
  const validBuffer = buildWorkbookBuffer('GHG-IMPORT-001');
  const parsed = parseGhgReportWorkbook(validBuffer, 'valid.xlsx');
  assert.strictEqual(parsed.report.length, 1);
  assert.strictEqual(parsed.organizationBoundaries.length, 1);
  assert.strictEqual(parsed.operationalBoundaries.length, 2);
  assert.strictEqual(parsed.items.length, 2);
  assert.strictEqual(parsed.summaries.length, 3);
  assert.strictEqual(parsed.evidence.length, 2);

  // 数值一致性按固定九位小数比较，绝对差异不得随 1e12/1e15 业务规模被放大容忍。
  assert.strictEqual(ghgReportNumbersEqual(0.1 + 0.2, 0.3), true);
  [1e12, 1e15].forEach((magnitude) => {
    [1, 1000, 1000000].forEach((absoluteDifference) => {
      assert.strictEqual(ghgReportNumbersEqual(magnitude, magnitude + absoluteDifference), false,
        `${magnitude} 数量级下绝对差 ${absoluteDifference} 必须阻断。`);
    });
  });
  const highMagnitudeRows = buildGhgReportRows('GHG-HIGH-MAGNITUDE-001', {
    operationalBoundaries: [['范围一', '固定燃烧', '高数量级测试']],
    items: [[
      'ITEM-HIGH-001', '排放', '范围一', '固定燃烧', 'CO2', '高数量级排放源',
      1e15, 'kg', 1e15, 1, 1e15, 'kgCO2e', '活动数据法', 'EVID-HIGH-001', ''
    ]],
    summaries: [[
      'TOTAL-HIGH-001', '总计', '全部', 1e15, 0, 1e15 - 1, 'kgCO2e', '绝对差一'
    ]],
    evidence: [['EVID-HIGH-001', '高数量级证据', '原始凭证', '高数量级证据', '']]
  });
  db = openTestDatabase();
  try {
    const highMagnitudePreview = buildGhgReportImportPreview({
      db,
      buffer: buildWorkbookBuffer('GHG-HIGH-MAGNITUDE-001', { rows: highMagnitudeRows }),
      originalFilename: 'high-magnitude.xlsx'
    });
    assert.strictEqual(highMagnitudePreview.summary.blocked, 1);
    assert(highMagnitudePreview.auditIssues.some((issue) => issue.code === 'GHG_REPORT_SUMMARY_NET_MISMATCH'));
    assert(highMagnitudePreview.auditIssues.some((issue) => issue.code === 'GHG_REPORT_SUMMARY_MISMATCH'));
  } finally {
    db.close();
  }

  // 只有 cell.t === 'n' 的固定数值列可读取原始 cell.v，百分比按底层数值解释。
  const formattedNumericBuffer = buildWorkbookBuffer('GHG-NUMERIC-FORMAT-001', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') {
        worksheet.G2 = { t: 'n', v: 1234.5, z: '#,##0.00' };
        worksheet.I2 = { t: 'n', v: 6.84 };
        worksheet.J2 = { t: 'n', v: 0.125, z: '0.00%' };
        worksheet.K2 = { t: 'n', v: 6.84 };
        worksheet.G3 = { t: 'n', v: 0 };
        worksheet.I3 = { t: 'n', v: 0.5 };
        worksheet.J3 = { t: 'n', v: 1 };
        worksheet.K3 = { t: 'n', v: 0.5 };
      }
    }
  });
  const formattedNumericParsed = parseGhgReportWorkbook(formattedNumericBuffer, 'formatted.xlsx');
  assert.strictEqual(formattedNumericParsed.items[0].values[6], 1234.5);
  assert.strictEqual(formattedNumericParsed.items[0].values[9], 0.125);
  assert.strictEqual(formattedNumericParsed.items[1].values[6], 0);
  db = openTestDatabase();
  try {
    const formattedPreview = buildGhgReportImportPreview({
      db,
      buffer: formattedNumericBuffer,
      originalFilename: 'formatted.xlsx'
    });
    assert.strictEqual(formattedPreview.summary.wouldImport, 1);
    assert.strictEqual(formattedPreview.candidateRows[0].items[0].gwp, 0.125);
  } finally {
    db.close();
  }

  const numericTextBuffer = buildWorkbookBuffer('GHG-NUMERIC-TEXT-001', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.G2 = { t: 's', v: '1,234.50' };
    }
  });
  db = openTestDatabase();
  try {
    const numericTextPreview = buildGhgReportImportPreview({
      db,
      buffer: numericTextBuffer,
      originalFilename: 'numeric-text.xlsx'
    });
    assert.strictEqual(numericTextPreview.summary.blocked, 1);
    assert(numericTextPreview.auditIssues.some((issue) => issue.code === 'GHG_REPORT_ACTIVITY_VALUE_INVALID'));
  } finally {
    db.close();
  }

  assert.throws(
    () => parseGhgReportWorkbook(validBuffer, 'valid.csv'),
    (error) => error?.details?.code === 'GHG_REPORT_IMPORT_XLSX_REQUIRED'
  );
  assertWorkbookError(Buffer.from('not-an-xlsx'), 'GHG_REPORT_IMPORT_ZIP_DIRECTORY_INVALID');
  const wrongHeaderBuffer = buildWorkbookBuffer('GHG-WRONG-HEADER', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.A1.v = 'itemCode';
    }
  });
  assertWorkbookError(wrongHeaderBuffer, 'GHG_REPORT_IMPORT_HEADERS_MISMATCH');
  const formulaBuffer = buildWorkbookBuffer('GHG-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.G2 = { t: 'n', f: 'SUM(1,1)', v: 2 };
    }
  });
  assertWorkbookError(formulaBuffer, 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED');
  assertWorkbookError(buildWorkbookBuffer('GHG-HIDDEN', { hiddenSheetIndex: 1 }), 'GHG_REPORT_IMPORT_SHEET_CONTRACT_INVALID');
  const mergedBuffer = buildWorkbookBuffer('GHG-MERGED', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'report') worksheet['!merges'] = [XLSX.utils.decode_range('A2:B2')];
    }
  });
  assertWorkbookError(mergedBuffer, 'GHG_REPORT_IMPORT_MERGED_CELLS_REJECTED');
  assertWorkbookError(
    mutateFirstZipEntryDeclaredSize(validBuffer, GHG_REPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1),
    'GHG_REPORT_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED',
    413
  );

  // N7 必须直接覆盖 ZIP64、分卷、加密、异常路径和重复条目拒绝边界。
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(1, endOffset + 4);
  }), 'GHG_REPORT_IMPORT_ZIP_MULTIDISK_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
    buffer.writeUInt16LE(0xffff, endOffset + 8);
    buffer.writeUInt16LE(0xffff, endOffset + 10);
  }), 'GHG_REPORT_IMPORT_ZIP64_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    buffer.writeUInt16LE(buffer.readUInt16LE(entries[0].offset + 8) | 1, entries[0].offset + 8);
  }), 'GHG_REPORT_IMPORT_ZIP_ENCRYPTED_REJECTED');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    Buffer.from('../', 'utf8').copy(buffer, entries[0].filenameStart);
  }), 'GHG_REPORT_IMPORT_ZIP_ENTRY_PATH_INVALID');
  assertWorkbookError(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
    const duplicateSource = entries.find((entry, index) => entries.slice(index + 1)
      .some((candidate) => candidate.filenameLength === entry.filenameLength));
    assert(duplicateSource, '测试 XLSX 必须存在同长度 ZIP 条目名。');
    const duplicateTarget = entries.slice(entries.indexOf(duplicateSource) + 1)
      .find((candidate) => candidate.filenameLength === duplicateSource.filenameLength);
    buffer.copy(
      buffer,
      duplicateTarget.filenameStart,
      duplicateSource.filenameStart,
      duplicateSource.filenameStart + duplicateSource.filenameLength
    );
  }), 'GHG_REPORT_IMPORT_ZIP_ENTRY_DUPLICATED');

  // 无缓存、命名空间公式和 dimension 低报必须在原始工作表 XML 层 fail-closed。
  const noCachedFormulaText = 'SENSITIVE_GHG_NO_CACHE_FORMULA';
  const noCachedFormulaBuffer = buildWorkbookBuffer('GHG-NO-CACHED-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') worksheet.G2 = { t: 'n', f: noCachedFormulaText };
    }
  });
  assert.strictEqual(XLSX.read(noCachedFormulaBuffer, { type: 'buffer' }).Sheets['报告项目'].G2, undefined);
  assertWorkbookError(noCachedFormulaBuffer, 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED');
  const namespacedFormulaBuffer = rewriteXlsxEntry(
    noCachedFormulaBuffer,
    'xl/worksheets/sheet4.xml',
    (worksheetXml) => {
      const originalFormulaElement = `<f>${noCachedFormulaText}</f>`;
      assert(worksheetXml.includes(originalFormulaElement));
      return worksheetXml.replace(
        originalFormulaElement,
        '<x:f xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" t="shared" />'
      );
    }
  );
  assertWorkbookError(namespacedFormulaBuffer, 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED');
  const outsideReferenceFormulaText = 'SENSITIVE_GHG_OUTSIDE_REFERENCE_FORMULA';
  const outsideReferenceFormulaBuffer = buildWorkbookBuffer('GHG-LOW-DIMENSION-FORMULA', {
    mutateWorksheet: ({ worksheet, contract }) => {
      if (contract.key === 'items') {
        worksheet.P2 = { t: 'n', f: outsideReferenceFormulaText };
        worksheet['!ref'] = 'A1:P3';
      }
    }
  });
  const lowDimensionFormulaBuffer = rewriteXlsxEntry(
    outsideReferenceFormulaBuffer,
    'xl/worksheets/sheet4.xml',
    (worksheetXml) => {
      assert(worksheetXml.includes('<dimension ref="A1:P3"/>'));
      return worksheetXml.replace('<dimension ref="A1:P3"/>', '<dimension ref="A1:O3"/>');
    }
  );
  assert.strictEqual(XLSX.read(lowDimensionFormulaBuffer, { type: 'buffer' }).Sheets['报告项目'].P2, undefined);
  assertWorkbookError(lowDimensionFormulaBuffer, 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED');

  // N6 与 N7 工作簿必须双向错传阻断，不能仅依赖模板标识字段。
  const n6Template = getTemplateXlsx('carbon-emission-report');
  assertWorkbookError(n6Template.buffer, 'GHG_REPORT_IMPORT_SHEET_CONTRACT_INVALID');
  assert.throws(
    () => parseCarbonEmissionReportWorkbook(validBuffer, 'ghg-report.xlsx'),
    (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_IMPORT_SHEET_CONTRACT_INVALID'
  );

  // NFKC 后膨胀的编码必须按规范键重新校验长度。
  const expandedCode = 'ﬃ'.repeat(43);
  const expandedRows = buildGhgReportRows(expandedCode);
  expandedRows.organizationBoundaries[0][0] = expandedCode;
  expandedRows.items[0][0] = expandedCode;
  expandedRows.items[0][13] = expandedCode;
  expandedRows.evidence[0][0] = expandedCode;
  expandedRows.summaries[0][0] = expandedCode;
  const expandedBuffer = buildWorkbookBuffer(expandedCode, { rows: expandedRows });
  db = openTestDatabase();
  try {
    const expandedPreview = buildGhgReportImportPreview({ db, buffer: expandedBuffer, originalFilename: 'expanded.xlsx' });
    const expandedIssues = expandedPreview.auditIssues.filter((issue) => issue.code === 'GHG_REPORT_NORMALIZED_KEY_TOO_LONG');
    ['报告信息.报告编码', '组织边界.边界编码', '报告项目.项目编码', '报告项目.证据编号', '证据说明.证据编号', '汇总.汇总编码']
      .forEach((fieldName) => assert(expandedIssues.some((issue) => issue.fieldName === fieldName), `${fieldName} 必须按 NFKC 后长度阻断。`));
    assert.strictEqual(expandedPreview.candidateRows.length, 0);
  } finally {
    db.close();
  }

  // 类别、气体和 CO2e 单位等匹配键也必须在 NFKC 膨胀后重新按目标字段上限校验。
  const expandedCategory = 'ﬃ'.repeat(101);
  const expandedGasOrUnit = 'ﬃ'.repeat(34);
  const expandedSemanticRows = buildGhgReportRows('GHG-EXPANDED-SEMANTIC-001');
  expandedSemanticRows.operationalBoundaries[0][1] = expandedCategory;
  expandedSemanticRows.items[0][3] = expandedCategory;
  expandedSemanticRows.items[0][4] = expandedGasOrUnit;
  expandedSemanticRows.items.forEach((row) => { row[11] = expandedGasOrUnit; });
  expandedSemanticRows.summaries.forEach((row) => { row[6] = expandedGasOrUnit; });
  expandedSemanticRows.summaries.push([
    'CATEGORY-EXPANDED', '类别', expandedCategory, 6.84, 0, 6.84,
    expandedGasOrUnit, 'NFKC 类别键膨胀'
  ]);
  expandedSemanticRows.summaries.push([
    'GAS-EXPANDED', '温室气体', expandedGasOrUnit, 6.84, 0, 6.84,
    expandedGasOrUnit, 'NFKC 气体键膨胀'
  ]);
  db = openTestDatabase();
  try {
    const expandedSemanticPreview = buildGhgReportImportPreview({
      db,
      buffer: buildWorkbookBuffer('GHG-EXPANDED-SEMANTIC-001', { rows: expandedSemanticRows }),
      originalFilename: 'expanded-semantic.xlsx'
    });
    const expandedSemanticIssues = expandedSemanticPreview.auditIssues
      .filter((issue) => issue.code === 'GHG_REPORT_NORMALIZED_KEY_TOO_LONG');
    ['运行边界.类别', '报告项目.类别', '报告项目.温室气体种类', '报告项目.CO2e单位', '汇总.汇总值', '汇总.CO2e单位']
      .forEach((fieldName) => assert(expandedSemanticIssues.some((issue) => issue.fieldName === fieldName),
        `${fieldName} 必须按 NFKC 后目标字段长度阻断。`));
    assert.strictEqual(expandedSemanticPreview.summary.blocked, 1);
    assert.strictEqual(expandedSemanticPreview.candidateRows.length, 0);
  } finally {
    db.close();
  }

  // N6 与 N7 报告编码空间彼此独立，同编码 N6 事实不得阻断 N7 预演。
  db = openTestDatabase();
  try {
    const n6BatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_emission_report', 'n6.xlsx', 'n6.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO carbon_emission_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('GHG-IMPORT-001', 'GHG-IMPORT-001', 'N6 同编码报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2)`).run(n6BatchId);
    const independentPreview = buildGhgReportImportPreview({ db, buffer: validBuffer, originalFilename: 'valid.xlsx' });
    assert.strictEqual(independentPreview.summary.wouldImport, 1);
  } finally {
    db.close();
  }

  // 服务端取得 SHA 后的解析或安全失败必须持久化 failed 批次和脱敏 issue。
  const failedPreviewCases = [
    { storedFilename: 'failed-invalid-zip.xlsx', buffer: Buffer.from('not-an-xlsx'), expectedCode: 'GHG_REPORT_IMPORT_ZIP_DIRECTORY_INVALID' },
    { storedFilename: 'failed-formula.xlsx', buffer: formulaBuffer, expectedCode: 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED' },
    { storedFilename: 'failed-contract.xlsx', buffer: wrongHeaderBuffer, expectedCode: 'GHG_REPORT_IMPORT_HEADERS_MISMATCH' }
  ];
  for (const failedCase of failedPreviewCases) {
    const failedUpload = storeUpload(failedCase.storedFilename, failedCase.buffer);
    await assertAsyncCode(() => previewGhgReportImport(failedUpload, buildServiceOptions()), failedCase.expectedCode);
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
        WHERE operation = 'carbon.ghg-report.import.preview' AND target_id = ?`).get(String(failedBatch.id)));
    } finally {
      db.close();
    }
    assert(fs.existsSync(path.join(uploadsDir, failedCase.storedFilename)));
    assert.strictEqual(countRows('ghg_reports'), 0);
  }

  // 领域预演审计 hook 失败时批次、issue 和操作审计必须整体回滚。
  const failedBatchCountBeforeAuditHook = countRows('import_batches');
  const failedIssueCountBeforeAuditHook = countRows('import_errors');
  const failedOperationCountBeforeAuditHook = countRows('sys_operation_logs');
  const failingAuditDescriptor = {
    ...GHG_REPORT_IMPORT_DESCRIPTOR,
    persistPreviewAudit(context) {
      GHG_REPORT_IMPORT_DESCRIPTOR.persistPreviewAudit(context);
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

  // 正常 preview 只写原文件、摘要、签名、审计摘要和服务端候选见证，不写任何业务事实。
  const protectedBefore = snapshotProtectedTables();
  const previewUpload = storeUpload('preview-zero-write.xlsx', validBuffer);
  const preview = previewGhgReportImport(previewUpload, buildServiceOptions());
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(countRows('ghg_reports'), 0);
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
    assert.strictEqual(JSON.parse(batch.auditContextJson).candidateRows.length, 1);
  } finally {
    db.close();
  }

  // 客户端候选、持久化签名和 preview 后原文件变化都必须 fail-closed。
  await assertAsyncCode(() => executeGhgReportImport({
    batchId: preview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    candidateRows: [{ candidateRowId: 'client-controlled' }]
  }, buildServiceOptions()), [
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'
  ]);
  const signaturePreview = previewGhgReportImport(
    storeUpload('signature-tamper.xlsx', buildWorkbookBuffer('GHG-SIGNATURE-001')),
    buildServiceOptions()
  );
  db = openTestDatabase();
  try {
    db.prepare("UPDATE import_batches SET preview_signature = 'hmac-sha256:v1:tampered' WHERE id = ?")
      .run(signaturePreview.batchId);
  } finally {
    db.close();
  }
  await assertAsyncCode(() => executeGhgReportImport({
    batchId: signaturePreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID');
  const changedUpload = storeUpload('source-change.xlsx', buildWorkbookBuffer('GHG-SOURCE-001'));
  const changedPreview = previewGhgReportImport(changedUpload, buildServiceOptions());
  fs.writeFileSync(changedUpload.path, Buffer.from('changed-after-preview'));
  await assertAsyncCode(() => executeGhgReportImport({
    batchId: changedPreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), 'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH');

  // preview 后同编码并发写入必须触发 stale，既不 overwrite 也不 skip。
  const staleBuffer = buildWorkbookBuffer('GHG-STALE-001');
  const stalePreview = previewGhgReportImport(storeUpload('stale.xlsx', staleBuffer), buildServiceOptions());
  db = openTestDatabase();
  try {
    const staleBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('ghg_report', 'manual.xlsx', 'manual.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO ghg_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('GHG-STALE-001', 'GHG-STALE-001', '并发写入', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2)`).run(staleBatchId);
    const duplicatePreview = buildGhgReportImportPreview({ db, buffer: staleBuffer, originalFilename: 'duplicate.xlsx' });
    assert.strictEqual(duplicatePreview.summary.blocked, 1);
    assert.strictEqual(duplicatePreview.summary.skipped, 0);
    assert.strictEqual(duplicatePreview.candidateRows.length, 0);
    assert(duplicatePreview.auditIssues.some((issue) => issue.code === 'GHG_REPORT_CODE_EXISTS'));
  } finally {
    db.close();
  }
  await assertAsyncCode(() => executeGhgReportImport({
    batchId: stalePreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions()), [
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'
  ]);

  // 锁内备份或事务内审计失败时必须整体回滚 N7 业务事实。
  const backupPreview = previewGhgReportImport(
    storeUpload('backup-failure.xlsx', buildWorkbookBuffer('GHG-BACKUP-001')),
    buildServiceOptions()
  );
  const reportCountBeforeBackupFailure = countRows('ghg_reports');
  const protectedBeforeBackupFailure = snapshotProtectedTables();
  await assertAsyncCode(() => executeGhgReportImport({
    batchId: backupPreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions({ createBackup: async () => { throw new Error('sensitive backup path'); } })),
  'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(countRows('ghg_reports'), reportCountBeforeBackupFailure);
  assert.deepStrictEqual(snapshotProtectedTables(), protectedBeforeBackupFailure);
  const rollbackPreview = previewGhgReportImport(
    storeUpload('rollback.xlsx', buildWorkbookBuffer('GHG-ROLLBACK-001')),
    buildServiceOptions()
  );
  const protectedBeforeTransactionFailure = snapshotProtectedTables();
  const rollbackDescriptor = {
    ...GHG_REPORT_IMPORT_DESCRIPTOR,
    insertCandidates(context) {
      GHG_REPORT_IMPORT_DESCRIPTOR.insertCandidates(context);
      throw new Error('sensitive transaction failure');
    }
  };
  await assertAsyncCode(() => executeEnergyAnalysisSingleBatchImport({
    batchId: rollbackPreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, rollbackDescriptor, buildServiceOptions({
    createBackup: async () => ({
      backupName: 'rollback.sqlite',
      reason: 'ghg-report-import',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      method: 'test',
      createdAt: new Date().toISOString()
    })
  })), 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countRows('ghg_reports'), reportCountBeforeBackupFailure);
  assert.deepStrictEqual(snapshotProtectedTables(), protectedBeforeTransactionFailure);

  // 成功 execute 必须原子写入六表与审计，并保持全部保护表快照不变。
  const successPreview = previewGhgReportImport(
    storeUpload('success.xlsx', buildWorkbookBuffer('GHG-SUCCESS-001')),
    buildServiceOptions()
  );
  const protectedBeforeSuccess = snapshotProtectedTables();
  const success = await executeGhgReportImport({
    batchId: successPreview.batchId,
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  }, buildServiceOptions());
  assert.strictEqual(success.imported, 1);
  assert(success.backup);
  assert.deepStrictEqual(snapshotProtectedTables(), protectedBeforeSuccess);
  const detail = getGhgReportByBatch(successPreview.batchId);
  assert.strictEqual(detail.report.reportCode, 'GHG-SUCCESS-001');
  assert.strictEqual(detail.organizationBoundaries.length, 1);
  assert.strictEqual(detail.operationalBoundaries.length, 2);
  assert.strictEqual(detail.items.length, 2);
  assert.strictEqual(detail.items[0].recordType, 'emission');
  assert.strictEqual(detail.items[1].recordType, 'removal');
  assert.strictEqual(detail.items[1].co2eValue, 0.5);
  assert.strictEqual(detail.summaries[0].netCo2e, 6.34);
  assert.strictEqual(detail.evidence.length, 2);
  assert.strictEqual(listGhgReports({ reportCode: 'ghg-success-001', recordType: 'removal' }).rows.length, 1);
  db = openTestDatabase();
  try {
    const batch = db.prepare(`SELECT status, audit_phase AS auditPhase, backup_json AS backupJson,
      execute_result_json AS executeResultJson FROM import_batches WHERE id = ?`).get(successPreview.batchId);
    assert.strictEqual(batch.status, 'completed');
    assert.strictEqual(batch.auditPhase, 'execute');
    assert(batch.backupJson);
    assert(JSON.parse(batch.executeResultJson).executed);
    const operations = db.prepare(`SELECT operation FROM sys_operation_logs
      WHERE target_type = 'ghg_report' ORDER BY id`).all().map((row) => row.operation);
    assert(operations.includes('carbon.ghg-report.import.preview'));
    assert(operations.includes('carbon.ghg-report.import.execute'));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  console.log('ghgReportImport tests passed');
}

run().finally(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
