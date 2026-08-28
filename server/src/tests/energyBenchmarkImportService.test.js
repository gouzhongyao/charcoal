'use strict';

const assert = require('assert');
const crypto = require('crypto');
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
const { createDemoContext } = require('../services/demoContextService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = require('../services/demoOwnershipService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('../services/energyAnalysisSingleBatchImportService');
const { getEnergyAnalysisTemplateDefinition } = require('../services/energyAnalysisTemplateService');
const {
  ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR,
  ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR,
  ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR,
  executeEnergyBenchmarkDefinitionImport,
  executeEnergyBenchmarkTargetImport,
  executeEnergyConversionFactorImport,
  isExactConversionFactor,
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
  '指标方向', '来源', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);
const LEGACY_DEFINITION_HEADERS = Object.freeze([
  ...DEFINITION_HEADERS.slice(0, 10), '文号', '版本', ...DEFINITION_HEADERS.slice(10)
]);
const TARGET_HEADERS = Object.freeze([
  '对标编码', '目标值', '下限值', '上限值', '参考期开始时间（UTC）',
  '参考期结束时间（UTC）', '固化值', '固化时间（UTC）', '样本数量', '产量摘要 JSON',
  '来源数据摘要', '是否固化', '是否自动刷新', '状态'
]);
const LEGACY_TARGET_HEADERS = Object.freeze([
  '对标编码', '对标定义版本', ...TARGET_HEADERS.slice(1, -1), '目标版本', '状态'
]);
// artifact 19 专项测试只使用静态 registry 绑定，不允许测试调用方替换实体、角色或导入类型。
const ARTIFACT_19_KEY = '19-conversion-factors';
const ARTIFACT_19_HANDLER_KEY = 'energy-conversion-factors-import';
const ARTIFACT_19_FILE_SHA256 = 'f'.repeat(64);
// managed ownership 公共响应允许返回的固定摘要字段。
const MANAGED_OWNERSHIP_PUBLIC_FIELDS = Object.freeze([
  'applied',
  'mode',
  'noInsertedRecords',
  'registrationCount',
  'insertedCount',
  'idempotentCount',
  'skippedCount',
  'relationCount'
]);
// ownership 公共投影递归禁止出现的内部字段。
const FORBIDDEN_OWNERSHIP_PUBLIC_FIELDS = new Set([
  'context',
  'contextId',
  'runId',
  'datasetId',
  'manifestVersion',
  'manifestDigest',
  'batchBindings',
  'registrations',
  'relations',
  'registryId',
  'identityDigest',
  'snapshotDigest',
  'sourceBatchId',
  'sourceRowNumber',
  'rowWitness',
  'transactionScope',
  'facade',
  'handler',
  'sql',
  'modulePath'
]);

/** 递归断言 ownership 公共投影不包含内部字段。 */
function assertNoManagedOwnershipInternalFields(value, label, currentPath = 'ownership') {
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, nestedValue]) => {
    assert.strictEqual(FORBIDDEN_OWNERSHIP_PUBLIC_FIELDS.has(key), false,
      `${label} ${currentPath}.${key} 不得进入公共 execute 投影。`);
    assertNoManagedOwnershipInternalFields(nestedValue, label, `${currentPath}.${key}`);
  });
}

/** 断言 managed ownership 仅返回固定安全摘要。 */
function assertManagedOwnershipPublicProjection(ownership, label) {
  assert(ownership && typeof ownership === 'object' && !Array.isArray(ownership),
    `${label} execute 必须返回 ownership 公共摘要。`);
  assert.deepStrictEqual(Object.keys(ownership).sort(), [...MANAGED_OWNERSHIP_PUBLIC_FIELDS].sort(),
    `${label} ownership 只能包含固定公共摘要字段。`);
  assertNoManagedOwnershipInternalFields(ownership, label);
  assert.strictEqual(typeof ownership.applied, 'boolean');
  assert.strictEqual(ownership.mode, 'demo');
  assert.strictEqual(typeof ownership.noInsertedRecords, 'boolean');
  ['registrationCount', 'insertedCount', 'idempotentCount', 'skippedCount', 'relationCount'].forEach((field) => {
    assert(Number.isSafeInteger(ownership[field]) && ownership[field] >= 0,
      `${label} ownership.${field} 必须是非负安全整数。`);
  });
}

/** 断言 artifact 19 execute 顶层合法导入合同保持不变。 */
function assertArtifact19ExecuteTopLevelContract(result, preview, label) {
  assert.strictEqual(result.batchId, preview.batchId, `${label} 必须保留 batchId。`);
  assert.strictEqual(result.previewSignature, preview.previewSignature, `${label} 必须保留 previewSignature。`);
  assert.strictEqual(result.previewAuditDigest, preview.previewAuditDigest, `${label} 必须保留 previewAuditDigest。`);
  assert.deepStrictEqual(result.previewAudit, preview.previewAudit, `${label} 必须保留 previewAudit。`);
  assert.deepStrictEqual(result.candidateRows, preview.candidateRows, `${label} 必须保留 candidateRows。`);
  assert.deepStrictEqual(result.candidateRowIds, preview.candidateRowIds, `${label} 必须保留 candidateRowIds。`);
  assert.strictEqual(result.expectedWouldImport, preview.expectedWouldImport, `${label} 必须保留 expectedWouldImport。`);
  assert.strictEqual(result.importedIds.length, result.imported, `${label} importedIds 数量必须匹配 imported。`);
  assert.strictEqual(result.importedItems.length, result.imported, `${label} importedItems 数量必须匹配 imported。`);
  assert(result.importedItems.every((item) => Number.isSafeInteger(Number(item.sourceRowNumber))
    && Number(item.sourceRowNumber) > 0), `${label} 顶层 importedItems.sourceRowNumber 必须继续保留。`);
}

/** 统计与 artifact 19 ownership 端点相关的真实 relation 数量。 */
function countArtifact19Relations(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE source.artifact_key = ? OR target.artifact_key = ?`).get(ARTIFACT_19_KEY, ARTIFACT_19_KEY).total);
}

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
    范围标识: 'OU-001', 指标方向: 'lower_better', 来源: '行业标准',
    '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z', 来源时区: 'Asia/Shanghai', 状态: 'active', ...overrides
  };
}

/** 创建合法对标目标行。 */
function createTargetRow(overrides = {}) {
  return {
    对标编码: 'BENCH-LOWER', 目标值: 120, 下限值: '', 上限值: '',
    '参考期开始时间（UTC）': '', '参考期结束时间（UTC）': '', 固化值: '', '固化时间（UTC）': '',
    样本数量: '', '产量摘要 JSON': '', 来源数据摘要: '', 是否固化: 0,
    是否自动刷新: 0, 状态: 'active', ...overrides
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
     direction, source, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-INACTIVE', '停用定义', 'manual_benchmark', 'metric', '%', 'month', 'organization', 'OU-001',
     'higher_better', '人工', 'inactive-benchmark:v1', 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'inactive')`).run();
  db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-INTERNAL', '内部历史', 'internal_history_baseline', 'metric', '%', 'month', 'organization', 'OU-001',
     'lower_better', '内部计算', 'internal-benchmark:v1', 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run();
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
  assert.deepStrictEqual(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership, {
    artifactKey: '19-conversion-factors',
    entityType: 'energy_conversion_factor',
    batchRole: 'primary',
    expectedImportType: 'energy_conversion_factor'
  });
  assert.strictEqual(Object.isFrozen(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership), true);
  assert.strictEqual(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership.entityType, 'energy_conversion_factor');
  assert.strictEqual(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership.batchRole, 'primary');
  assert.strictEqual(ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership.expectedImportType, 'energy_conversion_factor');

  const definitionTemplate = getEnergyAnalysisTemplateDefinition('energy-benchmark-definitions');
  const targetTemplate = getEnergyAnalysisTemplateDefinition('energy-benchmark-targets');
  assert.deepStrictEqual(definitionTemplate.sheets[0].headers, DEFINITION_HEADERS);
  assert.deepStrictEqual(targetTemplate.sheets[0].headers, TARGET_HEADERS);
  for (const removedHeader of ['文号', '版本']) assert(!definitionTemplate.sheets[0].headers.includes(removedHeader));
  for (const removedHeader of ['对标定义版本', '目标版本']) assert(!targetTemplate.sheets[0].headers.includes(removedHeader));
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
  assert.strictEqual(Object.prototype.hasOwnProperty.call(factorResult, 'ownership'), false,
    '正式无 context 响应不得新增 ownership 字段。');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?')
    .get(factorPreview.batchId).total, 0, '正式无 context 导入不得登记 demo ownership。');
  const factor = db.prepare('SELECT source_batch_id AS batchId, source_row_number AS rowNumber FROM energy_conversion_factors').get();
  assert.deepStrictEqual(factor, { batchId: factorPreview.batchId, rowNumber: 4 });
  const factorAudit = getImportAuditBatchDetail(factorPreview.batchId, { db });
  assert.strictEqual(factorAudit.auditPhase, 'execute');
  assert.strictEqual(factorAudit.executeResult.previewSignature, factorPreview.previewSignature);
  assert.strictEqual(factorAudit.executeResult.backup.reason, 'energy-analysis-import');
  assert(!JSON.stringify(factorAudit).includes(tmpDir));

  const definitionRows = [
    createDefinitionRow(),
    createDefinitionRow({ 对标编码: 'BENCH-HIGHER', 对标名称: '产出率标杆', 对标类型: 'manual_benchmark', 指标编码: 'yield_rate', 指标单位: '%', 范围类型: 'energy', 范围标识: 'electricity', 指标方向: 'higher_better' }),
    createDefinitionRow({ 对标编码: 'BENCH-RANGE', 对标名称: '产品区间', 对标类型: 'manual_benchmark', 指标编码: 'range_metric', 指标单位: '%', 范围类型: 'product', 范围标识: '产品A', 指标方向: 'range' })
  ];
  const definitionFile = writeCsvWithBlankLines('definition-physical.csv', DEFINITION_HEADERS, definitionRows[0]);
  const definitionPreview = previewEnergyBenchmarkDefinitionImport(definitionFile, options);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM benchmark_definitions WHERE benchmark_code = 'BENCH-LOWER'").get().total, 0);
  assert.strictEqual(definitionPreview.candidateRows[0].sourceRowNumber, 4);
  assert.strictEqual(definitionPreview.auditBatch.importType, 'energy_benchmark');
  assert.strictEqual(definitionPreview.operation, 'energy-benchmark-standard-import');
  assert.strictEqual(definitionPreview.recordKind, 'benchmark_standard');
  assert.strictEqual(definitionPreview.candidateRows[0].internalRevision, 1);
  assert.strictEqual(definitionPreview.candidateRows[0].version, 'benchmark-definition-internal-revision:v1');
  await executeEnergyBenchmarkDefinitionImport(createExecuteBody(definitionPreview), options);
  const storedDefinition = db.prepare(`SELECT document_no AS documentNo, version,
    internal_revision AS internalRevision FROM benchmark_definitions WHERE benchmark_code = 'BENCH-LOWER'`).get();
  assert.deepStrictEqual(storedDefinition, {
    documentNo: null,
    version: 'benchmark-definition-internal-revision:v1',
    internalRevision: 1
  });

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
  assert.strictEqual(targetPreview.candidateRows[0].internalRevision, 1);
  assert.strictEqual(targetPreview.candidateRows[0].version, 'benchmark-target-internal-revision:v1');
  const targetResult = await executeEnergyBenchmarkTargetImport(createExecuteBody(targetPreview), options);
  assert.strictEqual(targetResult.imported, 1);
  const target = db.prepare(`SELECT source_batch_id AS batchId, source_row_number AS rowNumber,
    reference_start_utc AS referenceStartUtc, is_frozen AS isFrozen, version,
    internal_revision AS internalRevision FROM benchmark_targets`).get();
  assert.deepStrictEqual(target, {
    batchId: targetPreview.batchId,
    rowNumber: 4,
    referenceStartUtc: null,
    isFrozen: 0,
    version: 'benchmark-target-internal-revision:v1',
    internalRevision: 1
  });

  const rangeCsv = writeCsvWithBlankLines('target-range-physical.csv', TARGET_HEADERS, createTargetRow({
    对标编码: 'BENCH-RANGE', 目标值: '', 下限值: 80, 上限值: 90
  }));
  const rangePreview = previewEnergyBenchmarkTargetImport(rangeCsv, options);
  assert.strictEqual(rangePreview.candidateRows[0].sourceRowNumber, 4);
  await executeEnergyBenchmarkTargetImport(createExecuteBody(rangePreview), options);

  const higherFile = writeCsvUpload('target-higher.csv', TARGET_HEADERS, [createTargetRow({
    对标编码: 'BENCH-HIGHER', 目标值: 95
  })]);
  const higherPreview = previewEnergyBenchmarkTargetImport(higherFile, options);
  assert.strictEqual(higherPreview.summary.wouldImport, 1);
  await executeEnergyBenchmarkTargetImport(createExecuteBody(higherPreview), options);
}

/** 创建用于直接验证折标系数 exact 语义的规范事实。 */
function createExactConversionFactor(overrides = {}) {
  return {
    factorCode: 'EXACT-FACTOR', energyTypeId: 1, sourceUnit: 'kWh', factorValue: 0.1229,
    targetUnit: 'kgce', displayUnit: 'tce', displayDivisor: 1000, source: '测试来源', documentNo: 'DOC-EXACT',
    version: 'exact-factor:v1', effectiveStartUtc: '2030-01-01T00:00:00Z',
    effectiveEndUtc: '2031-01-01T00:00:00Z', sourceTimeZone: 'Asia/Shanghai', status: 'active', ...overrides
  };
}

/** 验证折标系数有效期 canonicalization 及非法值 fail-closed 语义。 */
function testConversionFactorExactComparison() {
  const base = createExactConversionFactor();
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00Z', effectiveEndUtc: '2031-01-01T00:00:00Z' },
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00.000Z', effectiveEndUtc: '2031-01-01T00:00:00.000Z' }
  ), true, 'Z 与 .000Z 必须视为同一 instant。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00.123Z', effectiveEndUtc: '2031-01-01T00:00:00.123Z' },
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00.123Z', effectiveEndUtc: '2031-01-01T00:00:00.123Z' }
  ), true, '非零毫秒必须保留并能稳定比较。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00.123Z' },
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00.124Z' }
  ), false, '不同非零毫秒 instant 不得视为 exact。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00Z' },
    { ...base, effectiveStartUtc: '2030-01-01T00:00:01Z' }
  ), false, '不同 instant 不得视为 exact。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: 'not-a-date' },
    { ...base, effectiveStartUtc: 'not-a-date' }
  ), false, '非法日期即使文本相同也不得视为 exact。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00+08:00' },
    { ...base, effectiveStartUtc: '2030-01-01T00:00:00+08:00' }
  ), false, '带时区偏移文本不得绕过严格 UTC exact 校验。');
  assert.strictEqual(isExactConversionFactor(
    { ...base, effectiveStartUtc: null },
    { ...base, effectiveStartUtc: null }
  ), false, '缺失有效期不得被静默视为 exact。');
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
  db.prepare(`INSERT INTO energy_conversion_factors
    (factor_code, energy_type_id, source_unit, factor_value, target_unit, display_unit, display_divisor,
     source, document_no, version, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('UTC-CANONICAL-DUP', ?, 'utc-canonical-duplicate', 0.1229, 'kgce', 'tce', 1000,
      '企业能源折标制度', 'Q/EA-2026', 'utc-canonical-duplicate:v1',
      '2031-01-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z', 'Asia/Shanghai', 'inactive')`).run(energyTypeId);
  const canonicalDuplicate = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-db-canonical-duplicate.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'UTC-CANONICAL-DUP', 源单位: 'utc-canonical-duplicate', 版本: 'utc-canonical-duplicate:v1',
      '生效开始时间（UTC）': '2031-01-01T00:00:00Z', '生效结束时间（UTC）': '2032-01-01T00:00:00Z',
      状态: 'inactive'
    })]
  ), options);
  assert.strictEqual(canonicalDuplicate.summary.wouldImport, 0);
  assert.strictEqual(canonicalDuplicate.summary.skipped, 1, '数据库 .000Z 与模板 Z 必须走 duplicate skip。');
  assert.strictEqual(canonicalDuplicate.summary.blocked, 0);
  assert(canonicalDuplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_CONVERSION_FACTOR_SKIPPED'));
  assert(!canonicalDuplicate.auditIssues.some((issue) => issue.code === 'CONVERSION_FACTOR_UNIQUE_KEY_CONFLICT'));

  const changedInstantConflict = previewEnergyConversionFactorImport(writeCsvUpload(
    'factor-db-changed-instant-conflict.csv', FACTOR_HEADERS, [createFactorRow({
      系数编码: 'UTC-CANONICAL-DUP', 源单位: 'utc-canonical-duplicate', 版本: 'utc-canonical-duplicate:v1',
      '生效开始时间（UTC）': '2031-01-01T00:00:00Z', '生效结束时间（UTC）': '2032-01-01T00:00:01Z',
      状态: 'inactive'
    })]
  ), options);
  assert.strictEqual(changedInstantConflict.summary.skipped, 0);
  assert.strictEqual(changedInstantConflict.summary.blocked, 1, '不同 instant 必须保持非 exact 并触发唯一键冲突。');
  assert(changedInstantConflict.auditIssues.some((issue) => issue.code === 'CONVERSION_FACTOR_UNIQUE_KEY_CONFLICT'));
  assert(!changedInstantConflict.auditIssues.some((issue) => issue.code === 'DUPLICATE_CONVERSION_FACTOR_SKIPPED'));

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

/** 验证旧定义和目标模板列仅产生弃用 warning，且旧值不会控制内部修订或兼容版本。 */
async function testLegacyBenchmarkHeaders(db, options) {
  const legacyDefinitionRow = createDefinitionRow({
    对标编码: 'BENCH-LEGACY-COLUMNS',
    对标名称: '旧模板列兼容定义',
    文号: 'LEGACY-DOCUMENT-NO',
    版本: 'legacy-definition:v999',
    '生效开始时间（UTC）': '2031-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2032-01-01T00:00:00Z'
  });
  const definitionPreview = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('legacy-definition-columns.csv', LEGACY_DEFINITION_HEADERS, [legacyDefinitionRow]), options
  );
  assert.strictEqual(definitionPreview.summary.wouldImport, 1);
  const definitionWarnings = definitionPreview.auditIssues.filter((issue) => issue.code === 'DEPRECATED_BENCHMARK_HEADER_IGNORED');
  assert.strictEqual(definitionWarnings.length, 2);
  assert(definitionWarnings.some((issue) => issue.message.includes('文号列已弃用')));
  assert(definitionWarnings.some((issue) => issue.message.includes('定义版本列已弃用')));
  assert.strictEqual(definitionPreview.candidateRows[0].documentNo, undefined);
  assert.strictEqual(definitionPreview.candidateRows[0].internalRevision, 1);
  assert.strictEqual(definitionPreview.candidateRows[0].version, 'benchmark-definition-internal-revision:v1');
  assert.notStrictEqual(definitionPreview.candidateRows[0].version, legacyDefinitionRow.版本);
  await executeEnergyBenchmarkDefinitionImport(createExecuteBody(definitionPreview), options);
  const storedDefinition = db.prepare(`SELECT id, document_no AS documentNo, version,
    internal_revision AS internalRevision FROM benchmark_definitions WHERE benchmark_code = 'BENCH-LEGACY-COLUMNS'`).get();
  assert.deepStrictEqual({
    documentNo: storedDefinition.documentNo,
    version: storedDefinition.version,
    internalRevision: storedDefinition.internalRevision
  }, {
    documentNo: null,
    version: 'benchmark-definition-internal-revision:v1',
    internalRevision: 1
  });

  const legacyTargetRow = createTargetRow({
    对标编码: 'BENCH-LEGACY-COLUMNS',
    目标值: 121,
    对标定义版本: 'legacy-definition:v999',
    目标版本: 'legacy-target:v999'
  });
  const targetPreview = previewEnergyBenchmarkTargetImport(
    writeCsvUpload('legacy-target-columns.csv', LEGACY_TARGET_HEADERS, [legacyTargetRow]), options
  );
  assert.strictEqual(targetPreview.summary.wouldImport, 1);
  const targetWarnings = targetPreview.auditIssues.filter((issue) => issue.code === 'DEPRECATED_BENCHMARK_HEADER_IGNORED');
  assert.strictEqual(targetWarnings.length, 2);
  assert(targetWarnings.some((issue) => issue.message.includes('对标定义版本列已弃用')));
  assert(targetWarnings.some((issue) => issue.message.includes('目标版本列已弃用')));
  assert.strictEqual(targetPreview.candidateRows[0].benchmarkDefinitionId, storedDefinition.id);
  assert.strictEqual(targetPreview.candidateRows[0].internalRevision, 1);
  assert.strictEqual(targetPreview.candidateRows[0].version, 'benchmark-target-internal-revision:v1');
  assert.notStrictEqual(targetPreview.candidateRows[0].version, legacyTargetRow.目标版本);
  assert.strictEqual(targetPreview.candidateRows[0].benchmarkVersion, undefined);
  await executeEnergyBenchmarkTargetImport(createExecuteBody(targetPreview), options);
  const storedTarget = db.prepare(`SELECT version, internal_revision AS internalRevision
    FROM benchmark_targets WHERE benchmark_definition_id = ?`).get(storedDefinition.id);
  assert.deepStrictEqual(storedTarget, {
    version: 'benchmark-target-internal-revision:v1',
    internalRevision: 1
  });
}

/** 验证历史兼容版本占位时 preview、锁内重算和 execute 使用同一确定性备用后缀。 */
async function testCompatibilityVersionFallbackAndPreviewStability(db, options) {
  const definitionCode = 'BENCH-IMPORT-DEFINITION-VERSION-COLLISION';
  const definitionBaseVersion = 'benchmark-definition-internal-revision:v3';
  const insertDefinitionHistory = db.prepare(`INSERT INTO benchmark_definitions (
    benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
    scope_type, scope_reference, direction, source, version, internal_revision,
    effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, ?, 'external_standard', 'energy_intensity', 'kgce/t', 'month',
    'organization', 'OU-001', 'lower_better', '历史导入兼容测试', ?, ?, ?, ?, 'Asia/Shanghai', 'inactive')`);
  insertDefinitionHistory.run(definitionCode, '历史导入定义一', definitionBaseVersion, 1,
    '2034-01-01T00:00:00Z', '2035-01-01T00:00:00Z');
  insertDefinitionHistory.run(definitionCode, '历史导入定义二', `${definitionBaseVersion}:server-1`, 2,
    '2035-01-01T00:00:00Z', '2036-01-01T00:00:00Z');

  const definitionFile = writeCsvUpload('definition-version-fallback.csv', DEFINITION_HEADERS, [createDefinitionRow({
    对标编码: definitionCode,
    对标名称: '导入定义确定性备用后缀',
    '生效开始时间（UTC）': '2036-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2037-01-01T00:00:00Z'
  })]);
  const firstDefinitionPreview = previewEnergyBenchmarkDefinitionImport(definitionFile, options);
  const secondDefinitionPreview = previewEnergyBenchmarkDefinitionImport(definitionFile, options);
  assert.strictEqual(firstDefinitionPreview.summary.wouldImport, 1);
  assert.strictEqual(firstDefinitionPreview.candidateRows[0].internalRevision, 3);
  assert.strictEqual(firstDefinitionPreview.candidateRows[0].version, `${definitionBaseVersion}:server-2`);
  assert.deepStrictEqual(secondDefinitionPreview.candidateRows, firstDefinitionPreview.candidateRows,
    '重复定义 preview 必须生成完全一致的兼容版本候选。');
  await executeEnergyBenchmarkDefinitionImport(createExecuteBody(firstDefinitionPreview), options);
  const storedDefinition = db.prepare(`SELECT id, version, internal_revision AS internalRevision
    FROM benchmark_definitions WHERE benchmark_code = ? AND internal_revision = 3`).get(definitionCode);
  assert.deepStrictEqual({
    version: storedDefinition.version,
    internalRevision: storedDefinition.internalRevision
  }, {
    version: firstDefinitionPreview.candidateRows[0].version,
    internalRevision: firstDefinitionPreview.candidateRows[0].internalRevision
  }, '定义 execute 落库结果必须与 preview 候选一致。');
  assert.deepStrictEqual(db.prepare(`SELECT version FROM benchmark_definitions
    WHERE benchmark_code = ? AND internal_revision <= 2 ORDER BY internal_revision`).all(definitionCode).map((row) => row.version), [
    definitionBaseVersion,
    `${definitionBaseVersion}:server-1`
  ], '定义导入不得改写历史 version。');

  const targetDefinitionCode = 'BENCH-IMPORT-TARGET-VERSION-COLLISION';
  const activeTargetDefinitionId = Number(db.prepare(`INSERT INTO benchmark_definitions (
    benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
    scope_type, scope_reference, direction, source, version, internal_revision,
    effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, '目标导入 active 定义', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month',
    'organization', 'OU-001', 'lower_better', '目标导入兼容测试', 'target-import-definition:v1', 1,
    '2036-01-01T00:00:00Z', '2037-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run(targetDefinitionCode).lastInsertRowid);
  db.prepare(`INSERT INTO benchmark_definitions (
    benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
    scope_type, scope_reference, direction, source, version, internal_revision,
    effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, '目标导入 inactive 后继', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month',
    'organization', 'OU-001', 'lower_better', '目标导入兼容测试', 'target-import-definition:v2', 2,
    '2037-01-01T00:00:00Z', '2038-01-01T00:00:00Z', 'Asia/Shanghai', 'inactive')`).run(targetDefinitionCode);

  const targetBaseVersion = 'benchmark-target-internal-revision:v3';
  const insertTargetHistory = db.prepare(`INSERT INTO benchmark_targets (
    benchmark_definition_id, target_value, version, internal_revision, status
  ) VALUES (?, ?, ?, ?, 'inactive')`);
  insertTargetHistory.run(activeTargetDefinitionId, 301, targetBaseVersion, 1);
  insertTargetHistory.run(activeTargetDefinitionId, 302, `${targetBaseVersion}:server-1`, 2);

  const targetFile = writeCsvUpload('target-version-fallback.csv', TARGET_HEADERS, [createTargetRow({
    对标编码: targetDefinitionCode,
    目标值: 303
  })]);
  const firstTargetPreview = previewEnergyBenchmarkTargetImport(targetFile, options);
  const secondTargetPreview = previewEnergyBenchmarkTargetImport(targetFile, options);
  assert.strictEqual(firstTargetPreview.summary.wouldImport, 1);
  assert.strictEqual(firstTargetPreview.candidateRows[0].benchmarkDefinitionId, activeTargetDefinitionId,
    'inactive 定义后继不得参与目标导入的唯一 active 匹配。');
  assert.strictEqual(firstTargetPreview.candidateRows[0].internalRevision, 3);
  assert.strictEqual(firstTargetPreview.candidateRows[0].version, `${targetBaseVersion}:server-2`);
  assert.deepStrictEqual(secondTargetPreview.candidateRows, firstTargetPreview.candidateRows,
    '重复目标 preview 必须生成完全一致的兼容版本候选。');
  await executeEnergyBenchmarkTargetImport(createExecuteBody(firstTargetPreview), options);
  const storedTarget = db.prepare(`SELECT version, internal_revision AS internalRevision
    FROM benchmark_targets WHERE benchmark_definition_id = ? AND internal_revision = 3`).get(activeTargetDefinitionId);
  assert.deepStrictEqual(storedTarget, {
    version: firstTargetPreview.candidateRows[0].version,
    internalRevision: firstTargetPreview.candidateRows[0].internalRevision
  }, '目标 execute 锁内重算和落库结果必须与 preview 候选一致。');
  assert.deepStrictEqual(db.prepare(`SELECT version FROM benchmark_targets
    WHERE benchmark_definition_id = ? AND internal_revision <= 2 ORDER BY internal_revision`).all(activeTargetDefinitionId).map((row) => row.version), [
    targetBaseVersion,
    `${targetBaseVersion}:server-1`
  ], '目标导入不得改写历史 version。');
}

/** 验证定义类型、方向、范围、来源、重复和有效期冲突。 */
function testBenchmarkDefinitionRules(db, options) {
  const invalidFile = writeCsvUpload('definition-invalid.csv', DEFINITION_HEADERS, [
    createDefinitionRow({ 对标编码: 'INTERNAL-FAKE', 对标类型: 'internal_history_baseline' }),
    createDefinitionRow({ 对标编码: 'MISSING-SOURCE', 对标类型: 'manual_benchmark', 来源: '' }),
    createDefinitionRow({ 对标编码: 'BAD-SCOPE', 范围标识: 'OU-NOT-FOUND' }),
    createDefinitionRow({ 对标编码: 'BAD-DIRECTION', 指标方向: 'smaller' })
  ]);
  const invalid = previewEnergyBenchmarkDefinitionImport(invalidFile, options);
  const codes = new Set(invalid.auditIssues.map((issue) => issue.code));
  ['INTERNAL_HISTORY_BENCHMARK_IMPORT_FORBIDDEN', 'REQUIRED_FIELD_MISSING',
    'BENCHMARK_ORGANIZATION_SCOPE_NOT_FOUND', 'INVALID_BENCHMARK_DIRECTION'].forEach((code) => assert(codes.has(code), `缺少 ${code}`));

  const duplicate = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-duplicate.csv', DEFINITION_HEADERS, [createDefinitionRow()]), options
  );
  assert.strictEqual(duplicate.summary.skipped, 1);
  assert(duplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_BENCHMARK_DEFINITION_SKIPPED'));

  const changedOverlap = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-changed-overlap.csv', DEFINITION_HEADERS, [createDefinitionRow({ 对标名称: '非完全相同定义' })]), options
  );
  assert.strictEqual(changedOverlap.summary.blocked, 1);
  assert(changedOverlap.auditIssues.some((issue) => issue.code === 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP'));

  const overlap = previewEnergyBenchmarkDefinitionImport(
    writeCsvUpload('definition-overlap.csv', DEFINITION_HEADERS, [createDefinitionRow({
      '生效开始时间（UTC）': '2026-06-01T00:00:00Z',
      '生效结束时间（UTC）': '2027-06-01T00:00:00Z'
    })]), options
  );
  assert.strictEqual(overlap.summary.blocked, 1);
  assert(overlap.auditIssues.some((issue) => issue.code === 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP'));
}

/** 验证目标唯一 active 定义引用、方向值结构、内部历史伪造和重复。 */
function testBenchmarkTargetRules(db, options) {
  const ambiguousFirst = db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-AMBIGUOUS', '多 active 定义一', 'manual_benchmark', 'metric', '%', 'month', 'organization', 'OU-001',
     'higher_better', '人工', 'legacy-ambiguous:v1', 1, '2028-01-01T00:00:00Z', '2029-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run();
  db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone, status)
    VALUES ('BENCH-AMBIGUOUS', '多 active 定义二', 'manual_benchmark', 'metric', '%', 'month', 'organization', 'OU-001',
     'higher_better', '人工', 'legacy-ambiguous:v2', 2, '2029-01-01T00:00:00Z', '2030-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run();
  assert(ambiguousFirst.lastInsertRowid);

  const invalidFile = writeCsvUpload('target-invalid.csv', TARGET_HEADERS, [
    createTargetRow({ 对标编码: 'NOT-FOUND' }),
    createTargetRow({ 对标编码: 'BENCH-INACTIVE' }),
    createTargetRow({ 对标编码: 'BENCH-AMBIGUOUS' }),
    createTargetRow({ 对标编码: 'BENCH-RANGE', 目标值: 85, 下限值: '', 上限值: '' }),
    createTargetRow({ 对标编码: 'BENCH-LOWER', 目标值: 'not-number' }),
    createTargetRow({ 对标编码: 'BENCH-INTERNAL' }),
    createTargetRow({ 对标编码: 'BENCH-HIGHER', '参考期开始时间（UTC）': '2025-01-01T00:00:00Z', 固化值: 90, 来源数据摘要: 'sha256:fake', 是否固化: 1 })
  ]);
  const invalid = previewEnergyBenchmarkTargetImport(invalidFile, options);
  const codes = new Set(invalid.auditIssues.map((issue) => issue.code));
  ['BENCHMARK_ACTIVE_DEFINITION_NOT_FOUND', 'BENCHMARK_ACTIVE_DEFINITION_AMBIGUOUS',
    'INVALID_BENCHMARK_TARGET_RANGE', 'INVALID_BENCHMARK_TARGET_NUMBER',
    'INTERNAL_HISTORY_BENCHMARK_TARGET_IMPORT_FORBIDDEN',
    'BENCHMARK_INTERNAL_SNAPSHOT_FIELDS_FORBIDDEN'].forEach((code) => assert(codes.has(code), `缺少 ${code}`));
  const ambiguousIssue = invalid.auditIssues.find((issue) => issue.code === 'BENCHMARK_ACTIVE_DEFINITION_AMBIGUOUS');
  assert.strictEqual(JSON.parse(ambiguousIssue.rawValue).definitionIds.length, 2);

  const duplicate = previewEnergyBenchmarkTargetImport(
    writeCsvUpload('target-duplicate.csv', TARGET_HEADERS, [createTargetRow()]), options
  );
  assert.strictEqual(duplicate.summary.skipped, 1);
  assert(duplicate.auditIssues.some((issue) => issue.code === 'DUPLICATE_BENCHMARK_TARGET_SKIPPED'));

  const changedTarget = previewEnergyBenchmarkTargetImport(
    writeCsvUpload('target-changed.csv', TARGET_HEADERS, [createTargetRow({ 目标值: 121 })]), options
  );
  assert.strictEqual(changedTarget.summary.wouldImport, 1);
  assert.strictEqual(changedTarget.candidateRows[0].internalRevision, 2);
  assert.strictEqual(changedTarget.candidateRows[0].version, 'benchmark-target-internal-revision:v2');
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
    const beforeCount = Number(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets').get().total);
    const preview = previewEnergyBenchmarkTargetImport(writeCsvUpload(`descriptor-${index}.csv`, TARGET_HEADERS, [createTargetRow({
      目标值: 130 + index
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
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets').get().total), beforeCount);
  }
}

/** 验证两个 benchmark 批次不可串用，错误 descriptor 不得污染合法批次，且旧 standards 模板 ID 被拒绝。 */
async function testDescriptorIsolation(db, options) {
  const definitionFile = writeCsvUpload('cross-definition.csv', DEFINITION_HEADERS, [createDefinitionRow({
    对标编码: 'BENCH-CROSS', '生效开始时间（UTC）': '2028-01-01T00:00:00Z',
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
    对标编码: 'BENCH-CROSS', 目标值: 88
  })]);
  const targetCountBeforeWrongExecute = Number(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets').get().total);
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
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets').get().total), targetCountBeforeWrongExecute);

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

/** 验证 artifact 19 demo ownership 的真实登记、备份失败回滚和业务失败回滚边界。 */
async function testArtifact19DemoOwnershipBoundaries(db, baseOptions) {
  const admin = db.prepare(`SELECT u.id FROM sys_users AS u
    JOIN sys_user_roles AS ur ON ur.user_id = u.id
    JOIN sys_roles AS role ON role.id = ur.role_id
    WHERE u.status = 'active' AND role.status = 'active' AND role.role_code = 'super_admin'
    ORDER BY u.id LIMIT 1`).get();
  assert(admin, 'artifact 19 专项测试需要隔离库内置管理员。');
  const actorUserId = Number(admin.id);
  toggleDemoRuntime({ enabled: true, actorUserId, actorIp: '127.0.0.1' });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });
  const demoOptions = () => ({
    token: createDemoContext({
      db,
      userId: actorUserId,
      runId: run.runId,
      artifactKey: ARTIFACT_19_KEY,
      handlerKey: ARTIFACT_19_HANDLER_KEY,
      artifactFileSha256: ARTIFACT_19_FILE_SHA256
    }).token,
    userId: actorUserId,
    artifactKey: ARTIFACT_19_KEY,
    handlerKey: ARTIFACT_19_HANDLER_KEY
  });
  const executeDemoCase = async (label, row, executeOptions = {}) => {
    const file = writeCsvUpload(`artifact-19-${label}.csv`, FACTOR_HEADERS, [row]);
    const context = demoOptions();
    const preview = previewEnergyConversionFactorImport(file, { ...baseOptions, demoContext: context });
    assert.strictEqual(preview.expectedWouldImport, 1, `${label} preview 必须产生一个候选。`);
    const result = await executeEnergyConversionFactorImport(createExecuteBody(preview), {
      ...baseOptions,
      ...executeOptions,
      demoContext: context
    });
    return { context, preview, result };
  };

  const valid = await executeDemoCase('valid', createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-VALID', 源单位: 'demo-valid-unit', 版本: 'demo-valid:v1'
  }));
  assertArtifact19ExecuteTopLevelContract(valid.result, valid.preview, 'artifact 19 正常 execute');
  assertManagedOwnershipPublicProjection(valid.result.ownership, 'artifact 19 正常 execute');
  assert.strictEqual(valid.result.ownership.applied, true);
  assert.strictEqual(valid.result.ownership.noInsertedRecords, false);
  assert.strictEqual(valid.result.ownership.insertedCount, 1);
  assert.strictEqual(valid.result.ownership.registrationCount, 1);
  assert.strictEqual(valid.result.ownership.idempotentCount, 0);
  assert.strictEqual(valid.result.ownership.skippedCount, 0);
  assert.strictEqual(valid.result.ownership.relationCount, 0);
  const validAudit = getImportAuditBatchDetail(valid.preview.batchId, { db, includeIssues: false });
  assert.strictEqual(validAudit.auditPhase, 'execute');
  assert.strictEqual(validAudit.executeResult.executed, true);
  assertManagedOwnershipPublicProjection(validAudit.executeResult.ownership, 'artifact 19 正常 execute 审计');
  assert.deepStrictEqual(validAudit.executeResult.ownership, valid.result.ownership,
    'artifact 19 正常 execute 的持久化审计必须使用同一 ownership 公共投影。');
  assert.strictEqual(countArtifact19Relations(db), 0,
    'artifact 19 正常 execute 没有真实 relation 语义，不得写 demo_data_relations。');
  const validRegistry = db.prepare(`SELECT entity_pk AS entityPk, ownership_kind AS ownershipKind,
      identity_digest AS identityDigest, snapshot_digest AS snapshotDigest,
      source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber, registered_by AS registeredBy
    FROM demo_data_registry WHERE source_batch_id = ?`).get(valid.preview.batchId);
  assert(validRegistry, '合法 artifact 19 execute 必须生成 registry。');
  assert.strictEqual(validRegistry.ownershipKind, 'imported');
  assert.strictEqual(Number(validRegistry.registeredBy), actorUserId);
  assert.strictEqual(Number(validRegistry.sourceBatchId), valid.preview.batchId);
  assert.strictEqual(Number(validRegistry.sourceRowNumber), valid.preview.candidateRows[0].sourceRowNumber);
  assert.strictEqual(validRegistry.identityDigest,
    calculateDemoEntityIdentityDigest('energy_conversion_factor', validRegistry.entityPk));
  const validProjection = db.prepare(`SELECT id, source_batch_id, source_row_number, factor_code, energy_type_id,
      source_unit, factor_value, target_unit, display_unit, display_divisor, source, document_no, version,
      effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
    FROM energy_conversion_factors WHERE id = ?`).get(Number(validRegistry.entityPk));
  assert.strictEqual(validRegistry.snapshotDigest,
    calculateDemoEntitySnapshotDigest('energy_conversion_factor', validRegistry.entityPk, validProjection));
  assert.deepStrictEqual(DEMO_OWNERSHIP_ENTITY_HANDLERS.energy_conversion_factor.projectionFields.includes('id'), true);

  const formalDuplicateFile = writeCsvUpload('artifact-19-formal-duplicate.csv', FACTOR_HEADERS, [createFactorRow()]);
  const formalDuplicateContext = demoOptions();
  const formalDuplicatePreview = previewEnergyConversionFactorImport(formalDuplicateFile, {
    ...baseOptions,
    demoContext: formalDuplicateContext
  });
  assert.strictEqual(formalDuplicatePreview.expectedWouldImport, 0);
  assert.strictEqual(formalDuplicatePreview.summary.skipped, 1);
  const formalDuplicateRelationsBefore = countArtifact19Relations(db);
  const formalDuplicateResult = await executeEnergyConversionFactorImport(createExecuteBody(formalDuplicatePreview), {
    ...baseOptions,
    demoContext: formalDuplicateContext
  });
  assert.strictEqual(formalDuplicateResult.writesBusinessRecords, false);
  assertArtifact19ExecuteTopLevelContract(formalDuplicateResult, formalDuplicatePreview, 'artifact 19 正式重复 all-skipped');
  assertManagedOwnershipPublicProjection(formalDuplicateResult.ownership, 'artifact 19 正式重复 all-skipped');
  assert.strictEqual(formalDuplicateResult.ownership.applied, true);
  assert.strictEqual(formalDuplicateResult.ownership.noInsertedRecords, true);
  assert.strictEqual(formalDuplicateResult.ownership.registrationCount, 0);
  assert.strictEqual(formalDuplicateResult.ownership.insertedCount, 0);
  assert.strictEqual(formalDuplicateResult.ownership.idempotentCount, 0);
  assert.strictEqual(formalDuplicateResult.ownership.skippedCount, 1);
  assert.strictEqual(formalDuplicateResult.ownership.relationCount, 0);
  const formalDuplicateAudit = getImportAuditBatchDetail(formalDuplicatePreview.batchId, { db, includeIssues: false });
  assert.strictEqual(formalDuplicateAudit.auditPhase, 'execute');
  assert.strictEqual(formalDuplicateAudit.executeResult.executed, true);
  assertManagedOwnershipPublicProjection(formalDuplicateAudit.executeResult.ownership,
    'artifact 19 正式重复 all-skipped 审计');
  assert.deepStrictEqual(formalDuplicateAudit.executeResult.ownership, formalDuplicateResult.ownership,
    'artifact 19 正式重复 all-skipped 的持久化审计必须使用同一 ownership 公共投影。');
  assert.strictEqual(formalDuplicateRelationsBefore, 0,
    'artifact 19 正式重复 all-skipped 前不得存在领域 relation。');
  assert.strictEqual(countArtifact19Relations(db), formalDuplicateRelationsBefore,
    'artifact 19 正式重复 all-skipped 不得新增或丢失 demo_data_relations。');
  const formalFactor = db.prepare("SELECT id FROM energy_conversion_factors WHERE factor_code = 'ELEC-KGCE-2026' ORDER BY id LIMIT 1").get();
  assert(formalFactor, '正式折标系数必须存在。');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE entity_type = 'energy_conversion_factor' AND entity_pk = ?`).get(String(formalFactor.id)).total, 0,
  'duplicate skipped 不得接管正式业务行。');

  const sameRunDuplicateRow = createFactorRow({
    系数编码: validProjection.factor_code,
    能源类型编码: 'electricity',
    源单位: validProjection.source_unit,
    折标系数值: validProjection.factor_value,
    目标单位: validProjection.target_unit,
    展示单位: validProjection.display_unit,
    展示除数: validProjection.display_divisor,
    来源: validProjection.source,
    文号: validProjection.document_no,
    版本: validProjection.version,
    '生效开始时间（UTC）': validProjection.effective_start_utc,
    '生效结束时间（UTC）': validProjection.effective_end_utc,
    来源时区: validProjection.source_timezone,
    状态: validProjection.status
  });
  const sameRunFile = writeCsvUpload('artifact-19-same-run-duplicate.csv', FACTOR_HEADERS, [sameRunDuplicateRow]);
  const sameRunContext = demoOptions();
  const sameRunPreview = previewEnergyConversionFactorImport(sameRunFile, { ...baseOptions, demoContext: sameRunContext });
  assert.strictEqual(sameRunPreview.expectedWouldImport, 0);
  assert.strictEqual(sameRunPreview.summary.skipped, 1, 'ownership projection 的 .000Z 与模板 Z 必须形成 artifact 19 all-skipped。');
  assert.strictEqual(sameRunPreview.summary.blocked, 0);
  assert(sameRunPreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_CONVERSION_FACTOR_SKIPPED'));
  const sameRunResult = await executeEnergyConversionFactorImport(createExecuteBody(sameRunPreview), {
    ...baseOptions,
    demoContext: sameRunContext
  });
  assert.strictEqual(sameRunResult.ownership.noInsertedRecords, true);
  assert.strictEqual(sameRunResult.ownership.registrationCount, 0);
  assert.strictEqual(sameRunResult.ownership.skippedCount, 1);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE entity_type = 'energy_conversion_factor' AND entity_pk = ?`).get(validRegistry.entityPk).total, 1,
  '同 run 重复导入必须保持单一 registry，不得重复登记。');

  const bindingFile = writeCsvUpload('artifact-19-binding-mismatch.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-BINDING-FAIL', 源单位: 'demo-binding-fail-unit', 版本: 'demo-binding-fail:v1'
  })]);
  const bindingContext = demoOptions();
  const bindingPreview = previewEnergyConversionFactorImport(bindingFile, { ...baseOptions, demoContext: bindingContext });
  let bindingBackupCalls = 0;
  const bindingCases = [
    {
      label: 'artifact',
      descriptor: { ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, demoOwnership: {
        ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership, artifactKey: '18-energy-benchmark-definitions'
      } },
      demoContext: bindingContext,
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_DEMO_OWNERSHIP_BINDING_MISMATCH'
    },
    {
      label: 'handler',
      descriptor: ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR,
      demoContext: { ...bindingContext, handlerKey: 'energy-benchmark-definitions-import' },
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
    },
    {
      label: 'batch role',
      descriptor: { ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, demoOwnership: {
        ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership, batchRole: 'secondary'
      } },
      demoContext: bindingContext,
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_DEMO_OWNERSHIP_BINDING_MISMATCH'
    },
    {
      label: 'entity',
      descriptor: { ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, demoOwnership: {
        ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership, entityType: 'energy_record'
      } },
      demoContext: bindingContext,
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_DEMO_OWNERSHIP_BINDING_MISMATCH'
    },
    {
      label: 'expected import type',
      descriptor: { ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, demoOwnership: {
        ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.demoOwnership, expectedImportType: 'energy_record'
      } },
      demoContext: bindingContext,
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_DEMO_OWNERSHIP_BINDING_MISMATCH'
    }
  ];
  for (const bindingCase of bindingCases) {
    const bindingError = await captureError(() => executeEnergyAnalysisSingleBatchImport(
      createExecuteBody(bindingPreview),
      bindingCase.descriptor,
      {
        ...baseOptions,
        demoContext: bindingCase.demoContext,
        createBackup: async (input) => {
          bindingBackupCalls += 1;
          return createBackupStub()(input);
        }
      }
    ));
    assert.strictEqual(bindingError.details.code, bindingCase.expectedCode, `${bindingCase.label} mismatch 必须 fail-closed。`);
  }
  assert.strictEqual(bindingBackupCalls, 0, 'artifact/handler/role/entity/import type 描述器失配不得进入备份。');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-BINDING-FAIL'").get().total, 0);
  const bindingTokenHash = crypto.createHash('sha256').update(bindingContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(bindingTokenHash).status, 'previewed');

  const provenanceDescriptor = {
    ...ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR,
    insertCandidates(input) {
      const insertion = ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR.insertCandidates(input);
      return {
        ...insertion,
        importedItems: insertion.importedItems.map((item) => ({
          ...item,
          sourceRowNumber: item.sourceRowNumber + 1
        }))
      };
    }
  };
  const provenanceError = await captureError(() => executeEnergyAnalysisSingleBatchImport(
    createExecuteBody(bindingPreview),
    provenanceDescriptor,
    { ...baseOptions, demoContext: bindingContext }
  ));
  assert.strictEqual(provenanceError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-BINDING-FAIL'").get().total, 0,
    'source provenance mismatch 必须回滚真实声明式 INSERT。');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(bindingPreview.batchId).total, 0);
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(bindingTokenHash).status, 'previewed');

  const invalidContextFile = writeCsvUpload('artifact-19-invalid-context.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-CONTEXT-INVALID', 源单位: 'demo-context-invalid-unit', 版本: 'demo-context-invalid:v1'
  })]);
  const invalidContext = demoOptions();
  const invalidContextPreview = previewEnergyConversionFactorImport(invalidContextFile, {
    ...baseOptions,
    demoContext: invalidContext
  });
  const invalidToken = `${invalidContext.token[0] === 'A' ? 'B' : 'A'}${invalidContext.token.slice(1)}`;
  const invalidContextError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(invalidContextPreview), {
    ...baseOptions,
    demoContext: { ...invalidContext, token: invalidToken }
  }));
  assert.strictEqual(invalidContextError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-CONTEXT-INVALID'").get().total, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(invalidContextPreview.batchId).total, 0);
  const invalidContextTokenHash = crypto.createHash('sha256').update(invalidContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(invalidContextTokenHash).status, 'previewed');

  const importTypeFile = writeCsvUpload('artifact-19-import-type-mismatch.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-IMPORT-TYPE-FAIL', 源单位: 'demo-import-type-fail-unit', 版本: 'demo-import-type-fail:v1'
  })]);
  const importTypeContext = demoOptions();
  const importTypePreview = previewEnergyConversionFactorImport(importTypeFile, { ...baseOptions, demoContext: importTypeContext });
  db.prepare("UPDATE import_batches SET import_type = 'energy_benchmark' WHERE id = ?").run(importTypePreview.batchId);
  const importTypeError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(importTypePreview), {
    ...baseOptions,
    demoContext: importTypeContext
  }));
  db.prepare("UPDATE import_batches SET import_type = 'energy_conversion_factor' WHERE id = ?").run(importTypePreview.batchId);
  assert.strictEqual(importTypeError.details.code, 'ENERGY_ANALYSIS_IMPORT_BATCH_IMPORT_TYPE_MISMATCH');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-IMPORT-TYPE-FAIL'").get().total, 0);
  const importTypeTokenHash = crypto.createHash('sha256').update(importTypeContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(importTypeTokenHash).status, 'previewed');

  const batchRoleFile = writeCsvUpload('artifact-19-batch-role-mismatch.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-BATCH-ROLE-FAIL', 源单位: 'demo-batch-role-fail-unit', 版本: 'demo-batch-role-fail:v1'
  })]);
  const batchRoleContext = demoOptions();
  const batchRolePreview = previewEnergyConversionFactorImport(batchRoleFile, { ...baseOptions, demoContext: batchRoleContext });
  const batchRoleTokenHash = crypto.createHash('sha256').update(batchRoleContext.token, 'utf8').digest('hex');
  const batchRoleContextRow = db.prepare('SELECT context_id AS contextId FROM demo_import_contexts WHERE token_hash = ?').get(batchRoleTokenHash);
  db.prepare("UPDATE demo_run_import_batches SET batch_role = 'secondary' WHERE context_id = ?").run(batchRoleContextRow.contextId);
  const batchRoleError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(batchRolePreview), {
    ...baseOptions,
    demoContext: batchRoleContext
  }));
  db.prepare("UPDATE demo_run_import_batches SET batch_role = 'primary' WHERE context_id = ?").run(batchRoleContextRow.contextId);
  assert.strictEqual(batchRoleError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-BATCH-ROLE-FAIL'").get().total, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(batchRolePreview.batchId).total, 0);
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(batchRoleTokenHash).status, 'previewed');

  const registrarFailureFile = writeCsvUpload('artifact-19-registry-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-REGISTRY-FAIL', 源单位: 'demo-registry-fail-unit', 版本: 'demo-registry-fail:v1'
  })]);
  const registrarFailureContext = demoOptions();
  const registrarFailurePreview = previewEnergyConversionFactorImport(registrarFailureFile, {
    ...baseOptions,
    demoContext: registrarFailureContext
  });
  const predictedConflictPk = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM energy_conversion_factors').get().nextId);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest, registered_by)
    VALUES (?, ?, 'energy_conversion_factor', ?, 'imported', ?, ?, ?)`).run(
    run.runId,
    ARTIFACT_19_KEY,
    String(predictedConflictPk),
    'd'.repeat(64),
    'e'.repeat(64),
    actorUserId
  );
  const registryFailureBefore = {
    factors: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total),
    registry: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total)
  };
  const registrarFailureError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(registrarFailurePreview), {
    ...baseOptions,
    demoContext: registrarFailureContext
  }));
  assert.strictEqual(registrarFailureError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total), registryFailureBefore.factors,
    'registrar 写入失败必须回滚业务行。');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total), registryFailureBefore.registry,
    'registrar 写入失败必须回滚新 registry/link 写入。');
  const registrarFailureTokenHash = crypto.createHash('sha256').update(registrarFailureContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(registrarFailureTokenHash).status, 'previewed',
    'registrar 写入失败后 context 必须保持 previewed。');
  db.prepare('DELETE FROM demo_data_registry WHERE run_id = ? AND entity_pk = ?').run(run.runId, String(predictedConflictPk));

  const auditFailureFile = writeCsvUpload('artifact-19-audit-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-AUDIT-FAIL', 源单位: 'demo-audit-fail-unit', 版本: 'demo-audit-fail:v1'
  })]);
  const auditFailureContext = demoOptions();
  const auditFailurePreview = previewEnergyConversionFactorImport(auditFailureFile, {
    ...baseOptions,
    demoContext: auditFailureContext
  });
  const auditBackupMarker = path.join(process.env.BACKUPS_DIR, 'artifact-19-audit-failure.sqlite');
  db.exec(`CREATE TRIGGER test_artifact_19_audit_failure
    BEFORE UPDATE ON import_batches
    FOR EACH ROW WHEN OLD.id = ${auditFailurePreview.batchId} AND NEW.audit_phase = 'execute'
    BEGIN SELECT RAISE(ABORT, 'test artifact 19 audit failure'); END`);
  let auditFailureError;
  try {
    auditFailureError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(auditFailurePreview), {
      ...baseOptions,
      demoContext: auditFailureContext,
      createBackup: async ({ reason }) => {
        fs.writeFileSync(auditBackupMarker, Buffer.from('committed snapshot marker'));
        return { backupName: path.basename(auditBackupMarker), reason, sizeBytes: 25, sha256: 'a'.repeat(64), method: 'test-stub' };
      }
    }));
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_artifact_19_audit_failure');
  }
  assert.strictEqual(auditFailureError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-AUDIT-FAIL'").get().total, 0,
    'execute audit 失败必须回滚业务行。');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(auditFailurePreview.batchId).total, 0,
    'execute audit 失败必须回滚 registry。');
  const auditFailureTokenHash = crypto.createHash('sha256').update(auditFailureContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(auditFailureTokenHash).status, 'previewed');
  const auditFailureBatch = getImportAuditBatchDetail(auditFailurePreview.batchId, { db });
  assert.strictEqual(auditFailureBatch.auditPhase, 'preview', '成功 execute audit 必须随事务回滚。');
  assert.notStrictEqual(auditFailureBatch.executeResult?.executed, true);
  assert.strictEqual(fs.existsSync(auditBackupMarker), true,
    '业务事务回滚不得宣称删除已经成功创建的备份文件。');

  const contextFailureFile = writeCsvUpload('artifact-19-context-cas-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-CONTEXT-FAIL', 源单位: 'demo-context-fail-unit', 版本: 'demo-context-fail:v1'
  })]);
  const contextFailureContext = demoOptions();
  const contextFailurePreview = previewEnergyConversionFactorImport(contextFailureFile, {
    ...baseOptions,
    demoContext: contextFailureContext
  });
  db.exec(`CREATE TRIGGER test_artifact_19_context_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW WHEN NEW.status = 'executed'
    BEGIN SELECT RAISE(ABORT, 'test artifact 19 context failure'); END`);
  let contextFailureError;
  try {
    contextFailureError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(contextFailurePreview), {
      ...baseOptions,
      demoContext: contextFailureContext
    }));
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_artifact_19_context_failure');
  }
  assert.strictEqual(contextFailureError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'DEMO-OWNERSHIP-CONTEXT-FAIL'").get().total, 0,
    'context CAS 失败必须回滚业务行。');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry WHERE source_batch_id = ?').get(contextFailurePreview.batchId).total, 0,
    'context CAS 失败必须回滚 registry。');
  const contextFailureTokenHash = crypto.createHash('sha256').update(contextFailureContext.token, 'utf8').digest('hex');
  assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE token_hash = ?').get(contextFailureTokenHash).status, 'previewed');
  const contextFailureAudit = getImportAuditBatchDetail(contextFailurePreview.batchId, { db });
  assert.notStrictEqual(contextFailureAudit.executeResult?.executed, true, 'context CAS 失败不得残留成功 execute audit。');

  const failureBefore = {
    factors: Number(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total),
    registry: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total)
  };
  const failureFile = writeCsvUpload('artifact-19-registrar-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-REGISTRAR-FAIL', 源单位: 'demo-registrar-fail-unit', 版本: 'demo-registrar-fail:v1'
  })]);
  const failureContext = demoOptions();
  const failurePreview = previewEnergyConversionFactorImport(failureFile, { ...baseOptions, demoContext: failureContext });
  const failureError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(failurePreview), {
    ...baseOptions,
    demoContext: failureContext,
    afterInsertCandidate: () => {
      const error = new Error('registrar failure injection');
      error.details = { code: 'TEST_REGISTRAR_FAILURE' };
      throw error;
    }
  }));
  assert.strictEqual(failureError.details.code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total), failureBefore.factors,
    'ownership registrar 前的业务失败必须回滚业务行。');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_registry').get().total), failureBefore.registry,
    'ownership registrar 前的业务失败必须回滚 registry。');
  const failureTokenHash = crypto.createHash('sha256').update(failureContext.token, 'utf8').digest('hex');
  const failureContextRow = db.prepare(`SELECT context_id AS contextId, status FROM demo_import_contexts
    WHERE token_hash = ?`).get(failureTokenHash);
  assert.strictEqual(failureContextRow.status, 'previewed', '业务事务失败后 context 必须保持 previewed。');
  assert.strictEqual(getImportAuditBatchDetail(failurePreview.batchId, { db }).status, 'failed',
    '业务事务失败后只能记录失败审计，不得伪造成功 execute 审计。');

  const backupFile = writeCsvUpload('artifact-19-backup-failure.csv', FACTOR_HEADERS, [createFactorRow({
    系数编码: 'DEMO-OWNERSHIP-BACKUP-FAIL', 源单位: 'demo-backup-fail-unit', 版本: 'demo-backup-fail:v1'
  })]);
  const backupContext = demoOptions();
  const backupPreview = previewEnergyConversionFactorImport(backupFile, { ...baseOptions, demoContext: backupContext });
  const backupError = await captureError(() => executeEnergyConversionFactorImport(createExecuteBody(backupPreview), {
    ...baseOptions,
    demoContext: backupContext,
    createBackup: async () => {
      const error = new Error('backup failure injection');
      error.details = { code: 'TEST_BACKUP_FAILURE' };
      throw error;
    }
  }));
  assert.strictEqual(backupError.details.code, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code IN ('DEMO-OWNERSHIP-BACKUP-FAIL', 'DEMO-OWNERSHIP-REGISTRAR-FAIL')").get().total), 0);
  assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS total FROM demo_data_registry WHERE entity_type = 'energy_conversion_factor' AND entity_pk NOT IN (SELECT CAST(? AS TEXT))").get(validRegistry.entityPk).total), 0,
    'artifact 19 失败用例不得留下新的 ownership。');
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
  assert.strictEqual(missingFileAudit.auditPhase, 'preview', '原文件恢复前的重读失败不得改变 preview 阶段。');
  assert(['completed', 'completed_with_errors'].includes(missingFileAudit.status), '备份前原文件失败必须保留同批次重试资格。');
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
    testConversionFactorExactComparison();
    await testConversionFactorRules(db, options);
    await testLegacyBenchmarkHeaders(db, options);
    await testCompatibilityVersionFallbackAndPreviewStability(db, options);
    testBenchmarkDefinitionRules(db, options);
    testBenchmarkTargetRules(db, options);
    await testSecurityGates(db, options);
    await testPersistedDescriptorBinding(db, options);
    await testDescriptorIsolation(db, options);
    await testRollbackBoundaries(db, options);
    await testArtifact19DemoOwnershipBoundaries(db, options);

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
