'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 数据库、上传文件和备份全部隔离到系统临时目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-benchmark-import-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-benchmark-import.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-benchmark-import-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { createEnergyAnalysisSingleBatchPreview } = require('../services/energyAnalysisSingleBatchImportService');
const {
  ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR,
  ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR,
  ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR,
  executeEnergyBenchmarkDefinitionImport,
  executeEnergyBenchmarkTargetImport,
  executeEnergyConversionFactorImport,
  previewEnergyBenchmarkDefinitionImport,
  previewEnergyBenchmarkTargetImport,
  previewEnergyConversionFactorImport
} = require('../services/energyBenchmarkImportService');

// 三类冻结模板中文标题。
const FACTOR_HEADERS = Object.freeze([
  '系数编码', '能源类型编码', '源单位', '折标系数值', '目标单位', '展示单位', '展示除数',
  '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);
const DEFINITION_HEADERS = Object.freeze([
  '对标编码', '对标名称', '对标类型', '指标编码', '指标单位', '周期类型', '范围类型', '范围标识',
  '指标方向', '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);
const TARGET_HEADERS = Object.freeze([
  '对标编码', '对标定义版本', '目标值', '下限值', '上限值', '参考期开始时间（UTC）',
  '参考期结束时间（UTC）', '固化值', '固化时间（UTC）', '样本数量', '产量摘要 JSON',
  '来源数据摘要', '是否固化', '是否自动刷新', '目标版本', '状态'
]);

/** 创建合法折标系数行。 */
function createFactorRow(overrides = {}) {
  return {
    系数编码: 'ELEC-KGCE-2026', 能源类型编码: 'electricity', 源单位: 'kWh', 折标系数值: 0.1229,
    目标单位: 'kgce', 展示单位: 'tce', 展示除数: 1000, 来源: '企业能源折标制度', 文号: 'Q/EA-2026',
    版本: 'electricity-factor:v1', '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z', 来源时区: 'Asia/Shanghai', 状态: 'active', ...overrides
  };
}

/** 创建合法对标定义行。 */
function createDefinitionRow(overrides = {}) {
  return {
    对标编码: 'BENCH-LOWER', 对标名称: '单位产品综合能耗基准', 对标类型: 'external_standard',
    指标编码: 'energy_intensity', 指标单位: 'kgce/t', 周期类型: 'month', 范围类型: 'organization',
    范围标识: 'OU-001', 指标方向: 'lower_better', 来源: '行业标准', 文号: 'GB/T-EXAMPLE',
    版本: 'energy-benchmark:v1', '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z', 来源时区: 'Asia/Shanghai', 状态: 'active', ...overrides
  };
}

/** 创建合法对标目标行。 */
function createTargetRow(overrides = {}) {
  return {
    对标编码: 'BENCH-LOWER', 对标定义版本: 'energy-benchmark:v1', 目标值: 120,
    下限值: '', 上限值: '', '参考期开始时间（UTC）': '', '参考期结束时间（UTC）': '', 固化值: '',
    '固化时间（UTC）': '', 样本数量: '', '产量摘要 JSON': '', 来源数据摘要: '', 是否固化: 0,
    是否自动刷新: 0, 目标版本: 'benchmark-target:v1', 状态: 'active', ...overrides
  };
}

/** 转义 CSV 单元格。 */
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 写入普通 CSV 上传文件。 */
function writeCsvUpload(filename, headers, rows) {
  const text = [headers.map(escapeCsvCell).join(','), ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))].join('\n');
  const buffer = Buffer.from(`﻿${text}\n`, 'utf8');
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, filename), buffer);
  return { originalname: filename, filename, size: buffer.length };
}

/** 写入表头后包含两个空白物理行的 CSV。 */
function writeCsvWithBlankLines(filename, headers, row) {
  const buffer = Buffer.from(`﻿${headers.map(escapeCsvCell).join(',')}\n\n\n${headers.map((header) => escapeCsvCell(row[header])).join(',')}\n`, 'utf8');
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, filename), buffer);
  return { originalname: filename, filename, size: buffer.length };
}

/** 写入含两个中间空白物理行的 XLSX。 */
function writeXlsxWithBlankLines(filename, sheetName, headers, row) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, [], [], headers.map((header) => row[header] ?? '')]), sheetName);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, filename), buffer);
  return { originalname: filename, filename, size: buffer.length };
}

/** 构造与 preview 完全绑定的 execute 请求。 */
function createExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    duplicateStrategy: 'skip',
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows.map((row) => ({ ...row }))
  };
}

/** 创建不访问真实数据目录的备份桩。 */
function createBackupStub() {
  return async ({ reason }) => ({
    backupName: `test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`, reason,
    sizeBytes: 128, sha256: 'a'.repeat(64), method: 'test-stub'
  });
}

/** 捕获带稳定 details.code 的异步错误。 */
async function captureError(callback) {
  try {
    await callback();
  } catch (error) {
    assert(error.details && error.details.code, `错误必须包含稳定 details.code：${error.stack || error}`);
    return error;
  }
  assert.fail('预期操作失败，但实际成功。');
}

/** 初始化组织、产品与内部历史测试定义。 */
function seedMasterData(db) {
  const organizationId = db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status) VALUES ('OU-001', '一号车间', '/OU-001', 'workshop', 'active')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO production_units
    (unit_code, unit_name, organization_unit_id, product_name, output_unit, status)
    VALUES ('PU-001', '产品一线', ?, '产品A', 't', 'active')`).run(organizationId);
  db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, version, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-INACTIVE', '停用定义', 'manual_benchmark', 'metric', '%', 'month', 'organization', 'OU-001',
     'higher_better', '人工', 'inactive-benchmark:v1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'inactive')`).run();
  db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, version, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-INTERNAL', '内部历史', 'internal_history_baseline', 'metric', '%', 'month', 'organization', 'OU-001',
     'lower_better', '内部计算', 'internal-benchmark:v1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run();
}

/** 验证三个描述器的冻结绑定。 */
function testDescriptorBindings() {
  assert.strictEqual(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.templateType, 'energy-conversion-factors');
  assert.strictEqual(ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR.templateType, 'energy-benchmark-definitions');
  assert.strictEqual(ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR.templateType, 'energy-benchmark-targets');
  assert.notStrictEqual(ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR.templateType, ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR.templateType);
  assert.strictEqual(Object.isFrozen(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR), true);
  assert.strictEqual(Object.isFrozen(ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR), true);
  assert.strictEqual(Object.isFrozen(ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR), true);
}

/** 验证三类 CSV 均通过统一模板 Buffer 解析保留重复标题、别名冲突和零数据结构问题。 */
function testCsvHeaderSafety(options) {
  const templateCases = [
    {
      name: 'factor', headers: FACTOR_HEADERS, requiredHeader: '系数编码', normalizedHeader: '系数 编码',
      aliasHeader: '折标系数编码', createRow: createFactorRow, preview: previewEnergyConversionFactorImport,
      conflictValue: 'FACTOR-ALIAS-CONFLICT'
    },
    {
      name: 'definition', headers: DEFINITION_HEADERS, requiredHeader: '对标编码', normalizedHeader: '对标 编码',
      aliasHeader: '标准编码', createRow: createDefinitionRow, preview: previewEnergyBenchmarkDefinitionImport,
      conflictValue: 'DEFINITION-ALIAS-CONFLICT'
    },
    {
      name: 'target', headers: TARGET_HEADERS, requiredHeader: '对标编码', normalizedHeader: '对标 编码',
      aliasHeader: '标准编码', createRow: createTargetRow, preview: previewEnergyBenchmarkTargetImport,
      conflictValue: 'TARGET-ALIAS-CONFLICT'
    }
  ];

  templateCases.forEach((templateCase) => {
    const duplicateRaw = templateCase.preview(writeCsvUpload(
      `${templateCase.name}-duplicate-raw-header.csv`,
      [...templateCase.headers, templateCase.requiredHeader],
      [templateCase.createRow()]
    ), options);
    assert.strictEqual(duplicateRaw.summary.blocked, 1);
    assert(duplicateRaw.auditIssues.some((issue) => issue.code === 'DUPLICATE_RAW_HEADER'));

    const normalizedRow = templateCase.createRow({ [templateCase.normalizedHeader]: templateCase.createRow()[templateCase.requiredHeader] });
    const normalizedDuplicate = templateCase.preview(writeCsvUpload(
      `${templateCase.name}-duplicate-normalized-header.csv`,
      [...templateCase.headers, templateCase.normalizedHeader],
      [normalizedRow]
    ), options);
    assert.strictEqual(normalizedDuplicate.summary.blocked, 1);
    assert(normalizedDuplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_NORMALIZED_HEADER'));

    const aliasConflict = templateCase.preview(writeCsvUpload(
      `${templateCase.name}-alias-conflict.csv`,
      [...templateCase.headers, templateCase.aliasHeader],
      [templateCase.createRow({ [templateCase.aliasHeader]: templateCase.conflictValue })]
    ), options);
    assert.strictEqual(aliasConflict.summary.blocked, 1);
    assert(aliasConflict.auditIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_MAPPING'));
    assert(aliasConflict.auditIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_VALUE'));

    const missingRequired = templateCase.preview(writeCsvUpload(
      `${templateCase.name}-missing-required-header.csv`,
      templateCase.headers.filter((header) => header !== templateCase.requiredHeader),
      []
    ), options);
    assert.strictEqual(missingRequired.summary.blocked, 1);
    assert(missingRequired.auditIssues.some((issue) => issue.code === 'MISSING_REQUIRED_HEADER'));

    const errorHeaderOnly = templateCase.preview(writeCsvUpload(
      `${templateCase.name}-error-header-only.csv`,
      [...templateCase.headers, templateCase.requiredHeader],
      []
    ), options);
    assert.strictEqual(errorHeaderOnly.summary.blocked, 1, '仅错误表头且无数据时也必须生成结构阻断项。');
    assert(errorHeaderOnly.auditIssues.some((issue) => issue.code === 'DUPLICATE_RAW_HEADER'));
  });
}

/** 验证三类 preview 零业务写、合法 execute、审计和物理行追溯。 */
async function testPreviewExecuteAndTraceability(db, options) {
  const factorFile = writeXlsxWithBlankLines('factor-physical.xlsx', '能源折标系数', FACTOR_HEADERS, createFactorRow());
  const factorPreview = previewEnergyConversionFactorImport(factorFile, options);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total, 0);
  assert.strictEqual(factorPreview.candidateRows[0].sourceRowNumber, 4);
  assert.strictEqual(factorPreview.auditBatch.importType, 'energy_conversion_factor');
  assert.strictEqual(factorPreview.operation, 'energy-conversion-factor-import');
  const factorResult = await executeEnergyConversionFactorImport(createExecuteBody(factorPreview), options);
  assert.strictEqual(factorResult.imported, 1);
  const factor = db.prepare('SELECT source_batch_id AS batchId, source_row_number AS rowNumber FROM energy_conversion_factors').get();
  assert.deepStrictEqual(factor, { batchId: factorPreview.batchId, rowNumber: 4 });
  const factorAudit = getImportAuditBatchDetail(factorPreview.batchId, { db });
  assert.strictEqual(factorAudit.auditPhase, 'execute');
  assert.strictEqual(factorAudit.executeResult.previewSignature, factorPreview.previewSignature);
  assert.strictEqual(factorAudit.executeResult.backup.reason, 'energy-analysis-import');
  assert(!JSON.stringify(factorAudit).includes(tmpDir));

  const definitionRows = [
    createDefinitionRow(),
    createDefinitionRow({ 对标编码: 'BENCH-HIGHER', 对标名称: '产出率标杆', 对标类型: 'manual_benchmark', 指标编码: 'yield_rate', 指标单位: '%', 范围类型: 'energy', 范围标识: 'electricity', 指标方向: 'higher_better', 文号: '' }),
    createDefinitionRow({ 对标编码: 'BENCH-RANGE', 对标名称: '产品区间', 对标类型: 'manual_benchmark', 指标编码: 'range_metric', 指标单位: '%', 范围类型: 'product', 范围标识: '产品A', 指标方向: 'range', 文号: '' })
  ];
  const definitionFile = writeCsvWithBlankLines('definition-physical.csv', DEFINITION_HEADERS, definitionRows[0]);
  const definitionPreview = previewEnergyBenchmarkDefinitionImport(definitionFile, options);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM benchmark_definitions WHERE benchmark_code = 'BENCH-LOWER'").get().total, 0);
  assert.strictEqual(definitionPreview.candidateRows[0].sourceRowNumber, 4);
  assert.strictEqual(definitionPreview.auditBatch.importType, 'energy_benchmark');
  assert.strictEqual(definitionPreview.operation, 'energy-benchmark-standard-import');
  assert.strictEqual(definitionPreview.recordKind, 'benchmark_standard');
  await executeEnergyBenchmarkDefinitionImport(createExecuteBody(definitionPreview), options);

  const moreDefinitions = writeCsvUpload('definition-directions.csv', DEFINITION_HEADERS, definitionRows.slice(1));
  const moreDefinitionsPreview = previewEnergyBenchmarkDefinitionImport(moreDefinitions, options);
  assert.strictEqual(moreDefinitionsPreview.summary.wouldImport, 2);
  await executeEnergyBenchmarkDefinitionImport(createExecuteBody(moreDefinitionsPreview), options);

  const targetFile = writeXlsxWithBlankLines('target-physical.xlsx', '对标目标', TARGET_HEADERS, createTargetRow());
  const targetPreview = previewEnergyBenchmarkTargetImport(targetFile, options);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets').get().total, 0);
  assert.strictEqual(targetPreview.candidateRows[0].sourceRowNumber, 4);
  assert.strictEqual(targetPreview.operation, 'energy-benchmark-target-import');
  assert.strictEqual(targetPreview.recordKind, 'benchmark_target');
  const targetResult = await executeEnergyBenchmarkTargetImport(createExecuteBody(targetPreview), options);
  assert.strictEqual(targetResult.imported, 1);
  const target = db.prepare(`SELECT source_batch_id AS batchId, source_row_number AS rowNumber,
    reference_start_utc AS referenceStartUtc, is_frozen AS isFrozen FROM benchmark_targets`).get();
  assert.deepStrictEqual(target, { batchId: targetPreview.batchId, rowNumber: 4, referenceStartUtc: null, isFrozen: 0 });

  const rangeCsv = writeCsvWithBlankLines('target-range-physical.csv', TARGET_HEADERS, createTargetRow({
    对标编码: 'BENCH-RANGE', 目标值: '', 下限值: 80, 上限值: 90, 目标版本: 'range-target:v1'
  }));
  const rangePreview = previewEnergyBenchmarkTargetImport(rangeCsv, options);
  assert.strictEqual(rangePreview.candidateRows[0].sourceRowNumber, 4);
  await executeEnergyBenchmarkTargetImport(createExecuteBody(rangePreview), options);

  const higherFile = writeCsvUpload('target-higher.csv', TARGET_HEADERS, [createTargetRow({
    对标编码: 'BENCH-HIGHER', 目标值: 95, 目标版本: 'higher-target:v1'
  })]);
  const higherPreview = previewEnergyBenchmarkTargetImport(higherFile, options);
  assert.strictEqual(higherPreview.summary.wouldImport, 1);
  await executeEnergyBenchmarkTargetImport(createExecuteBody(higherPreview), options);
}

/** 验证折标正数、能源、有效期、文件/数据库重叠与重复 skip。 */
async function testConversionFactorRules(db, options) {
  const invalidFile = writeCsvUpload('factor-invalid.csv', FACTOR_HEADERS, [
    createFactorRow({ 系数编码: 'BAD-ZERO', 源单位: 'zero-unit', 折标系数值: 0 }),
    createFactorRow({ 系数编码: 'BAD-ENERGY', 能源类型编码: 'missing-energy', 源单位: 'missing-unit' }),
    createFactorRow({ 系数编码: 'BAD-RANGE', 源单位: 'range-unit', '生效结束时间（UTC）': '2025-01-01T00:00:00Z' })
  ]);
  const invalidPreview = previewEnergyConversionFactorImport(invalidFile, options);
  const invalidCodes = new Set(invalidPreview.auditIssues.map((issue) => issue.code));
  ['INVALID_FACTOR_VALUE', 'ENERGY_TYPE_NOT_FOUND', 'INVALID_EFFECTIVE_RANGE'].forEach((code) => assert(invalidCodes.has(code)));

  const inputOverlapFile = writeCsvUpload('factor-input-overlap.csv', FACTOR_HEADERS, [
    createFactorRow({ 系数编码: 'INPUT-A', 源单位: 'input-overlap', 版本: 'input-a:v1' }),
    createFactorRow({ 系数编码: 'INPUT-B', 源单位: 'input-overlap', 版本: 'input-b:v1',
      '生效开始时间（UTC）': '2026-06-01T00:00:00Z', '生效结束时间（UTC）': '2027-06-01T00:00:00Z' })
  ]);
  const inputOverlap = previewEnergyConversionFactorImport(inputOverlapFile, options);
  assert.strictEqual(inputOverlap.summary.blocked, 2);
  assert(inputOverlap.items.every((item) => item.issues.some((issue) => issue.code === 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP')));
  assert(inputOverlap.auditIssues.some((issue) => issue.message.includes('第 2 行与第 3 行冲突')));

  const exactInputFile = writeCsvUpload('factor-exact-input.csv', FACTOR_HEADERS, [
    createFactorRow({ 系数编码: 'INPUT-DUP', 源单位: 'input-duplicate', 版本: 'input-duplicate:v1' }),
    createFactorRow({ 系数编码: 'INPUT-DUP', 源单位: 'input-duplicate', 版本: 'input-duplicate:v1' })
  ]);
  const exactInput = previewEnergyConversionFactorImport(exactInputFile, options);
  assert.strictEqual(exactInput.summary.wouldImport, 1);
  assert.strictEqual(exactInput.summary.skipped, 1);

  const databaseOverlapFile = writeCsvUpload('factor-db-overlap.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DB-OVERLAP', 版本: 'db-overlap:v1', '生效开始时间（UTC）': '2026-06-01T00:00:00Z',
    '生效结束时间（UTC）': '2026-12-01T00:00:00Z'
  })]);
  const databaseOverlap = previewEnergyConversionFactorImport(databaseOverlapFile, options);
  assert.strictEqual(databaseOverlap.summary.blocked, 1);
  assert(databaseOverlap.auditIssues.some((issue) => issue.code === 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP'));

  const duplicateFile = writeCsvUpload('factor-db-duplicate.csv', FACTOR_HEADERS, [createFactorRow()]);
  const duplicate = previewEnergyConversionFactorImport(duplicateFile, options);
  assert.strictEqual(duplicate.summary.skipped, 1);
  assert(duplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_CONVERSION_FACTOR_SKIPPED'));

  const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
  const insertExisting = db.prepare(`INSERT INTO energy_conversion_factors
    (factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
     effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES (?, ?, ?, 0.2, '毫秒测试', 'MS-DOC', ?, ?, ?, 'Asia/Shanghai', 'active')`);
  insertExisting.run('MS-OVERLAP-EXISTING', energyTypeId, 'ms-overlap', 'ms-overlap-existing:v1',
    '2030-01-01T00:00:00.500Z', '2030-01-01T01:00:00.500Z');
  const millisecondOverlap = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-db-millisecond-overlap.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'MS-OVERLAP-CANDIDATE', 源单位: 'ms-overlap', 版本: 'ms-overlap-candidate:v1',
      '生效开始时间（UTC）': '2030-01-01T01:00:00Z', '生效结束时间（UTC）': '2030-01-01T02:00:00Z'
    })]
  ), options);
  assert.strictEqual(millisecondOverlap.summary.blocked, 1, 'Z 与 .500Z 的真实 500ms 重叠必须阻断。');
  assert(millisecondOverlap.auditIssues.some((issue) => issue.code === 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP'));

  insertExisting.run('MS-ADJACENT-EXISTING', energyTypeId, 'ms-adjacent', 'ms-adjacent-existing:v1',
    '2030-01-02T00:00:00.000Z', '2030-01-02T01:00:00.000Z');
  const millisecondAdjacent = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-db-millisecond-adjacent.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'MS-ADJACENT-CANDIDATE', 源单位: 'ms-adjacent', 版本: 'ms-adjacent-candidate:v1',
      '生效开始时间（UTC）': '2030-01-02T01:00:00Z', '生效结束时间（UTC）': '2030-01-02T02:00:00Z'
    })]
  ), options);
  assert.strictEqual(millisecondAdjacent.summary.wouldImport, 1, 'Z 与 .000Z 的左闭右开相邻区间不得误判重叠。');

  insertExisting.run('MS-SEPARATE-EXISTING', energyTypeId, 'ms-separate', 'ms-separate-existing:v1',
    '2030-01-03T00:00:00Z', '2030-01-03T01:00:00.500Z');
  const millisecondSeparate = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-db-millisecond-separate.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'MS-SEPARATE-CANDIDATE', 源单位: 'ms-separate', 版本: 'ms-separate-candidate:v1',
      '生效开始时间（UTC）': '2030-01-03T01:00:01Z', '生效结束时间（UTC）': '2030-01-03T02:00:00Z'
    })]
  ), options);
  assert.strictEqual(millisecondSeparate.summary.wouldImport, 1, '毫秒区间真实不相交时不得阻断。');

  const executeRecheckPreview = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-execute-millisecond-recheck.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'MS-EXECUTE-CANDIDATE', 源单位: 'ms-execute-recheck', 版本: 'ms-execute-candidate:v1',
      '生效开始时间（UTC）': '2030-01-04T01:00:00Z', '生效结束时间（UTC）': '2030-01-04T02:00:00Z'
    })]
  ), options);
  assert.strictEqual(executeRecheckPreview.summary.wouldImport, 1);
  insertExisting.run('MS-EXECUTE-EXISTING', energyTypeId, 'ms-execute-recheck', 'ms-execute-existing:v1',
    '2030-01-04T00:00:00.500Z', '2030-01-04T01:00:00.500Z');
  const executeRecheckError = await captureError(() => executeEnergyConversionFactorImport(
    createExecuteBody(executeRecheckPreview), options
  ));
  assert([
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'
  ].includes(executeRecheckError.details.code), 'execute 服务端重算必须捕获新增的毫秒级有效期重叠。');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'MS-EXECUTE-CANDIDATE'").get().total, 0);
}

/** 验证定义类型、方向、范围、来源版本、重复和冲突。 */
function testBenchmarkDefinitionRules(db, options) {
  const invalidFile = writeCsvUpload('definition-invalid.csv', DEFINITION_HEADERS, [
    createDefinitionRow({ 对标编码: 'INTERNAL-FAKE', 对标类型: 'internal_history_baseline' }),
    createDefinitionRow({ 对标编码: 'MISSING-SOURCE', 对标类型: 'manual_benchmark', 来源: '', 文号: '', 版本: '' }),
    createDefinitionRow({ 对标编码: 'BAD-SCOPE', 范围标识: 'OU-NOT-FOUND' }),
    createDefinitionRow({ 对标编码: 'BAD-DIRECTION', 指标方向: 'smaller' })
  ]);
  const invalid = previewEnergyBenchmarkDefinitionImport(invalidFile, options);
  const codes = new Set(invalid.auditIssues.map((issue) => issue.code));
  ['INTERNAL_HISTORY_BENCHMARK_IMPORT_FORBIDDEN', 'REQUIRED_FIELD_MISSING', 'INVALID_BENCHMARK_VERSION',
    'BENCHMARK_ORGANIZATION_SCOPE_NOT_FOUND', 'INVALID_BENCHMARK_DIRECTION'].forEach((code) => assert(codes.has(code), `缺少 ${code}`));

  const duplicate = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-duplicate.csv', DEFINITION_HEADERS, [createDefinitionRow()]), options
  );
  assert.strictEqual(duplicate.summary.skipped, 1);
  assert(duplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_BENCHMARK_DEFINITION_SKIPPED'));

  const conflict = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-conflict.csv', DEFINITION_HEADERS, [createDefinitionRow({ 对标名称: '非完全相同定义' })]), options
  );
  assert.strictEqual(conflict.summary.blocked, 1);
  assert(conflict.auditIssues.some((issue) => issue.code === 'BENCHMARK_DEFINITION_UNIQUE_KEY_CONFLICT'));

  const overlap = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-overlap.csv', DEFINITION_HEADERS, [createDefinitionRow({
      版本: 'energy-benchmark-overlap:v1', '生效开始时间（UTC）': '2026-06-01T00:00:00Z',
      '生效结束时间（UTC）': '2027-06-01T00:00:00Z'
    })]), options
  );
  assert.strictEqual(overlap.summary.blocked, 1);
  assert(overlap.auditIssues.some((issue) => issue.code === 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP'));
}

/** 验证目标定义引用、方向值结构、内部历史伪造、重复和冲突。 */
function testBenchmarkTargetRules(db, options) {
  const invalidFile = writeCsvUpload('target-invalid.csv', TARGET_HEADERS, [
    createTargetRow({ 对标编码: 'NOT-FOUND', 目标版本: 'missing-target:v1' }),
    createTargetRow({ 对标编码: 'BENCH-INACTIVE', 对标定义版本: 'inactive-benchmark:v1', 目标版本: 'inactive-target:v1' }),
    createTargetRow({ 对标编码: 'BENCH-RANGE', 目标值: 85, 下限值: '', 上限值: '', 目标版本: 'invalid-range:v1' }),
    createTargetRow({ 对标编码: 'BENCH-LOWER', 目标值: 'not-number', 目标版本: 'invalid-number:v1' }),
    createTargetRow({ 对标编码: 'BENCH-INTERNAL', 对标定义版本: 'internal-benchmark:v1', 目标版本: 'internal-target:v1' }),
    createTargetRow({ 对标编码: 'BENCH-HIGHER', 目标版本: 'forged-target:v1', '参考期开始时间（UTC）': '2025-01-01T00:00:00Z', 固化值: 90, 来源数据摘要: 'sha256:fake', 是否固化: 1 })
  ]);
  const invalid = previewEnergyBenchmarkTargetImport(invalidFile, options);
  const codes = new Set(invalid.auditIssues.map((issue) => issue.code));
  ['BENCHMARK_DEFINITION_NOT_FOUND', 'BENCHMARK_DEFINITION_INACTIVE', 'INVALID_BENCHMARK_TARGET_RANGE',
    'INVALID_BENCHMARK_TARGET_NUMBER', 'INTERNAL_HISTORY_BENCHMARK_TARGET_IMPORT_FORBIDDEN',
    'BENCHMARK_INTERNAL_SNAPSHOT_FIELDS_FORBIDDEN'].forEach((code) => assert(codes.has(code), `缺少 ${code}`));

  const duplicate = previewEnergyBenchmarkTargetImport(
    writeCsvUpload('target-duplicate.csv', TARGET_HEADERS, [createTargetRow()]), options
  );
  assert.strictEqual(duplicate.summary.skipped, 1);
  assert(duplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_BENCHMARK_TARGET_SKIPPED'));

  const conflict = previewEnergyBenchmarkTargetImport(
    writeCsvUpload('target-conflict.csv', TARGET_HEADERS, [createTargetRow({ 目标值: 121 })]), options
  );
  assert.strictEqual(conflict.summary.blocked, 1);
  assert(conflict.auditIssues.some((issue) => issue.code === 'BENCHMARK_TARGET_UNIQUE_KEY_CONFLICT'));
}

/** 验证 SHA、签名、摘要、候选见证、确认、备份、风险和 stale 门槛。 */
async function testSecurityGates(db, baseOptions) {
  const cases = [
    ['SHA', 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH', ({ body }) => { body.fileSha256 = '0'.repeat(64); }],
    ['签名', 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID', ({ body }) => { body.previewSignature = `hmac-sha256:v1:${'0'.repeat(64)}`; }],
    ['摘要', 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID', ({ body }) => { body.previewAuditDigest = `hmac-sha256:v1:audit:${'0'.repeat(64)}`; }],
    ['候选', 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH', ({ body }) => { body.candidateRows[0].factorValue = 999; }],
    ['确认', 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH', ({ body }) => { body.confirmText = '错误确认'; }],
    ['备份', 'ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED', ({ body }) => { body.requireBackup = false; }],
    ['风险', 'ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED', ({ body }) => { body.acknowledgeSkippedRisks = false; }],
    ['stale', 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID', ({ preview }) => { db.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(preview.batchId); }]
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [name, expectedCode, mutate] = cases[index];
    const row = createFactorRow({ 系数编码: `SECURITY-${index}`, 源单位: `security-unit-${index}`, 版本: `security-${index}:v1` });
    const preview = previewEnergyConversionFactorImport(writeCsvUpload(`security-${index}.csv`, FACTOR_HEADERS, [row]), baseOptions);
    const body = createExecuteBody(preview);
    let backupCalls = 0;
    mutate({ body, preview });
    const error = await captureError(() => executeEnergyConversionFactorImport(body, {
      ...baseOptions,
      createBackup: async (input) => { backupCalls += 1; return createBackupStub()(input); }
    }));
    assert.strictEqual(error.details.code, expectedCode, name);
    assert.strictEqual(backupCalls, 0, `${name} 失败不得备份。`);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = ?").get(`SECURITY-${index}`).total, 0);
  }

  const staleDbFile = writeCsvUpload('stale-db.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'STALE-DB', 源单位: 'stale-unit', 版本: 'stale-db:v1'
  })]);
  const stalePreview = previewEnergyConversionFactorImport(staleDbFile, baseOptions);
  const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
  db.prepare(`INSERT INTO energy_conversion_factors
    (factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
     effective_start_utc, effective_end_utc, source_timezone)
    VALUES ('STALE-DB-CONFLICT', ?, 'stale-unit', 0.2, '测试', 'DOC', 'stale-conflict:v1',
     '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai')`).run(energyTypeId);
  const staleError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(stalePreview), baseOptions));
  assert(['ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH', 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH', 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH', 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'].includes(staleError.details.code));

  const wrongBatchPreview = previewEnergyConversionFactorImport(writeCsvUpload(
    'wrong-batch-owner.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'WRONG-BATCH-OWNER', 源单位: 'wrong-batch-owner', 版本: 'wrong-batch-owner:v1'
    })]
  ), baseOptions);
  const foreignBodyPreview = previewEnergyConversionFactorImport(writeCsvUpload(
    'wrong-batch-foreign-body.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'WRONG-BATCH-FOREIGN', 源单位: 'wrong-batch-foreign', 版本: 'wrong-batch-foreign:v1'
    })]
  ), baseOptions);
  const foreignBody = createExecuteBody(foreignBodyPreview);
  foreignBody.batchId = wrongBatchPreview.batchId;
  await captureError(() => executeEnergyConversionFactorImport(foreignBody, baseOptions));
  const wrongBatchAfterReject = getImportAuditBatchDetail(wrongBatchPreview.batchId, { db });
  assert.strictEqual(wrongBatchAfterReject.auditPhase, 'preview', '同 descriptor 的错误 batchId 请求也不得污染目标合法批次。');
  assert.strictEqual(wrongBatchAfterReject.status, wrongBatchPreview.auditBatch.status);
  assert.strictEqual(wrongBatchAfterReject.executeResult, null);
  const wrongBatchResult = await executeEnergyConversionFactorImport(createExecuteBody(wrongBatchPreview), baseOptions);
  assert.strictEqual(wrongBatchResult.imported, 1, '错误 batchId 请求被拒绝后，合法批次仍必须可以正常执行。');
}

/** 验证持久化批次的 templateType、operation、recordKind 均参与服务端授权。 */
async function testPersistedDescriptorBinding(db, baseOptions) {
  const cases = [
    ['templateType', 'energy-benchmark-definitions', 'ENERGY_ANALYSIS_IMPORT_BATCH_TEMPLATE_MISMATCH'],
    ['operation', 'energy-benchmark-standard-import', 'ENERGY_ANALYSIS_IMPORT_BATCH_OPERATION_MISMATCH'],
    ['recordKind', 'benchmark_standard', 'ENERGY_ANALYSIS_IMPORT_BATCH_RECORD_KIND_MISMATCH']
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [fieldName, forgedValue, expectedCode] = cases[index];
    const preview = previewEnergyBenchmarkTargetImport(writeCsvUpload(`descriptor-${index}.csv`, TARGET_HEADERS, [createTargetRow({
      目标值: 130 + index,
      目标版本: `descriptor-target-${index}:v1`
    })]), baseOptions);
    const batchRow = db.prepare('SELECT audit_context_json AS auditContextJson FROM import_batches WHERE id = ?').get(preview.batchId);
    const auditContext = JSON.parse(batchRow.auditContextJson);
    auditContext[fieldName] = forgedValue;
    db.prepare('UPDATE import_batches SET audit_context_json = ? WHERE id = ?').run(JSON.stringify(auditContext), preview.batchId);
    let backupCalls = 0;
    const error = await captureError(() => executeEnergyBenchmarkTargetImport(createExecuteBody(preview), {
      ...baseOptions,
      createBackup: async (input) => { backupCalls += 1; return createBackupStub()(input); }
    }));
    assert.strictEqual(error.details.code, expectedCode);
    assert.strictEqual(backupCalls, 0, `${fieldName} 失配不得进入备份。`);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets WHERE version = ?').get(`descriptor-target-${index}:v1`).total, 0);
  }
}

/** 验证两个 benchmark 批次不可串用，错误 descriptor 不得污染合法批次，且旧 standards 模板 ID 被拒绝。 */
async function testDescriptorIsolation(db, options) {
  const definitionFile = writeCsvUpload('cross-definition.csv', DEFINITION_HEADERS, [createDefinitionRow({
    对标编码: 'BENCH-CROSS', 版本: 'cross-benchmark:v1', '生效开始时间（UTC）': '2028-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2029-01-01T00:00:00Z'
  })]);
  const definitionPreview = previewEnergyBenchmarkDefinitionImport(definitionFile, options);
  const definitionBody = createExecuteBody(definitionPreview);
  definitionBody.confirmText = '确认导入能效对标目标';
  await captureError(() => executeEnergyBenchmarkTargetImport(definitionBody, options));
  const definitionAfterWrongExecute = getImportAuditBatchDetail(definitionPreview.batchId, { db, includeIssues: false });
  assert.strictEqual(definitionAfterWrongExecute.auditPhase, 'preview');
  assert.strictEqual(definitionAfterWrongExecute.status, definitionPreview.auditBatch.status);
  assert.strictEqual(definitionAfterWrongExecute.auditContext.templateType, 'energy-benchmark-definitions');
  assert.strictEqual(definitionAfterWrongExecute.auditContext.operation, 'energy-benchmark-standard-import');
  assert.strictEqual(definitionAfterWrongExecute.auditContext.recordKind, 'benchmark_standard');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM benchmark_definitions WHERE benchmark_code = 'BENCH-CROSS'").get().total, 0);

  const definitionResult = await executeEnergyBenchmarkDefinitionImport(createExecuteBody(definitionPreview), options);
  assert.strictEqual(definitionResult.imported, 1, '定义批次被错误目标 execute 调用后仍必须可以正常执行。');
  assert.strictEqual(getImportAuditBatchDetail(definitionPreview.batchId, { db }).auditPhase, 'execute');

  const targetFile = writeCsvUpload('cross-target.csv', TARGET_HEADERS, [createTargetRow({
    对标编码: 'BENCH-CROSS', 对标定义版本: 'cross-benchmark:v1', 目标值: 88,
    目标版本: 'cross-target:v1'
  })]);
  const targetPreview = previewEnergyBenchmarkTargetImport(targetFile, options);
  const targetBody = createExecuteBody(targetPreview);
  targetBody.confirmText = '确认导入能效对标标准';
  await captureError(() => executeEnergyBenchmarkDefinitionImport(targetBody, options));
  const targetAfterWrongExecute = getImportAuditBatchDetail(targetPreview.batchId, { db, includeIssues: false });
  assert.strictEqual(targetAfterWrongExecute.auditPhase, 'preview');
  assert.strictEqual(targetAfterWrongExecute.status, targetPreview.auditBatch.status);
  assert.strictEqual(targetAfterWrongExecute.auditContext.templateType, 'energy-benchmark-targets');
  assert.strictEqual(targetAfterWrongExecute.auditContext.operation, 'energy-benchmark-target-import');
  assert.strictEqual(targetAfterWrongExecute.auditContext.recordKind, 'benchmark_target');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM benchmark_targets WHERE version = 'cross-target:v1'").get().total, 0);

  const targetResult = await executeEnergyBenchmarkTargetImport(createExecuteBody(targetPreview), options);
  assert.strictEqual(targetResult.imported, 1, '目标批次被错误定义 execute 调用后仍必须可以正常执行。');
  assert.strictEqual(getImportAuditBatchDetail(targetPreview.batchId, { db }).auditPhase, 'execute');

  const oldFile = writeCsvUpload('old-standards.csv', DEFINITION_HEADERS, [createDefinitionRow()]);
  const oldError = await captureError(async () => createEnergyAnalysisSingleBatchPreview(oldFile, {
    ...ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR,
    templateType: 'energy-benchmark-standards'
  }, options));
  assert.strictEqual(oldError.details.code, 'ENERGY_ANALYSIS_IMPORT_TEMPLATE_UNSUPPORTED');
}

/** 验证备份失败零写和事务中途失败完整回滚。 */
async function testRollbackBoundaries(db, baseOptions) {
  const missingFile = writeCsvUpload('trusted-file-missing.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'TRUSTED-FILE-MISSING', 源单位: 'trusted-file-missing', 版本: 'trusted-file-missing:v1'
  })]);
  const missingFilePreview = previewEnergyConversionFactorImport(missingFile, baseOptions);
  fs.unlinkSync(path.join(process.env.UPLOADS_DIR, missingFile.filename));
  await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(missingFilePreview), baseOptions));
  const missingFileAudit = getImportAuditBatchDetail(missingFilePreview.batchId, { db });
  assert.strictEqual(missingFileAudit.status, 'failed', '完整匹配 descriptor 且持有合法 preview 见证的文件失败必须标记批次失败。');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'TRUSTED-FILE-MISSING'").get().total, 0);

  const backupPreview = previewEnergyConversionFactorImport(writeCsvUpload('backup-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'BACKUP-FAIL', 源单位: 'backup-fail-unit', 版本: 'backup-fail:v1'
  })]), baseOptions);
  const backupError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(backupPreview), {
    ...baseOptions,
    createBackup: async () => { const error = new Error('备份失败'); error.details = { code: 'TEST_BACKUP_FAILED' }; throw error; }
  }));
  assert.strictEqual(backupError.details.code, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(backupError.statusCode, 503);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'BACKUP-FAIL'").get().total, 0);
  assert.strictEqual(getImportAuditBatchDetail(backupPreview.batchId, { db }).status, 'failed');

  const transactionRows = [
    createFactorRow({ 系数编码: 'TX-ONE', 源单位: 'tx-unit-one', 版本: 'tx-one:v1' }),
    createFactorRow({ 系数编码: 'TX-TWO', 源单位: 'tx-unit-two', 版本: 'tx-two:v1' })
  ];
  const transactionPreview = previewEnergyConversionFactorImport(writeCsvUpload('transaction-failure.csv', FACTOR_HEADERS, transactionRows), baseOptions);
  const transactionError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(transactionPreview), {
    ...baseOptions,
    afterInsertCandidate: ({ index }) => {
      if (index === 0) { const error = new Error('事务失败'); error.details = { code: 'TEST_TRANSACTION_FAILED' }; throw error; }
    }
  }));
  assert.strictEqual(transactionError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(transactionError.statusCode, 500);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code IN ('TX-ONE', 'TX-TWO')").get().total, 0);
  const audit = getImportAuditBatchDetail(transactionPreview.batchId, { db });
  assert.strictEqual(audit.status, 'failed');
  assert.notStrictEqual(audit.executeResult?.executed, true);
}

(async () => {
  let db = null;
  try {
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    initDatabase();
    db = openDatabase();
    seedMasterData(db);
    const options = { db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub() };

    testDescriptorBindings();
    testCsvHeaderSafety(options);
    await testPreviewExecuteAndTraceability(db, options);
    await testConversionFactorRules(db, options);
    testBenchmarkDefinitionRules(db, options);
    testBenchmarkTargetRules(db, options);
    await testSecurityGates(db, options);
    await testPersistedDescriptorBinding(db, options);
    await testDescriptorIsolation(db, options);
    await testRollbackBoundaries(db, options);

    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
    console.log('energy benchmark import service tests passed');
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
