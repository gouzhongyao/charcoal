'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 配置导入测试只使用系统临时目录和隔离 SQLite，不访问真实业务库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-config-import-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-config-import.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-config-import-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const {
  executeShiftDefinitionImport,
  executeStrategyRuleImport,
  executeTouSchemeImport,
  previewShiftDefinitionImport,
  previewStrategyRuleImport,
  previewTouSchemeImport
} = require('../services/energyAnalysisConfigurationImportService');

// 三类冻结配置模板表头。
const SHIFT_HEADERS = Object.freeze([
  '班次编码', '班次名称', '开始分钟', '结束分钟', '是否跨日', '来源时区',
  '来源', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '状态'
]);
const TOU_SCHEME_HEADERS = Object.freeze([
  '方案编码', '方案名称', '来源时区', '来源', '文号', '版本',
  '生效开始时间（UTC）', '生效结束时间（UTC）', '状态'
]);
const TOU_RULE_HEADERS = Object.freeze([
  '方案编码', '方案版本', '星期序号', '时段类型', '开始分钟', '结束分钟'
]);
const STRATEGY_HEADERS = Object.freeze([
  '规则编码', '规则名称', '规则版本', '公式版本', '指标编码', '阈值操作符',
  '阈值', '阈值下限', '阈值上限', '阈值单位', '预计降幅', '优先级',
  '最低覆盖率', '最大证据数', '节省依据', '建议内容', '来源',
  '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);

/** 将 CSV 单元格转义为安全文本。 */
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 写入 UTF-8 BOM CSV 并返回 Multer 风格文件对象。 */
function writeCsvUpload(storedFilename, headers, rows, extraHeaders = []) {
  const allHeaders = [...headers, ...extraHeaders];
  const lines = [
    allHeaders.map(escapeCsvCell).join(','),
    ...rows.map((row) => allHeaders.map((header) => escapeCsvCell(row[header])).join(','))
  ];
  const buffer = Buffer.from(`﻿${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/** 写入精确工作表集合 XLSX 并返回 Multer 风格文件对象。 */
function writeXlsxUpload(storedFilename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    const matrix = [
      sheet.headers,
      ...(sheet.rows || []).map((row) => sheet.headers.map((header) => row[header] ?? ''))
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheet.name);
  });
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/** 构造合法班次定义模板行。 */
function createShiftRow(overrides = {}) {
  return {
    班次编码: 'SHIFT-DAY',
    班次名称: '白班',
    开始分钟: 480,
    结束分钟: 1020,
    是否跨日: 0,
    来源时区: 'Asia/Shanghai',
    来源: '配置导入测试',
    版本: 'shift-day:v1',
    '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z',
    状态: 'active',
    ...overrides
  };
}

/** 构造合法 TOU 方案模板行。 */
function createTouSchemeRow(overrides = {}) {
  return {
    方案编码: 'TOU-WEEKLY',
    方案名称: '周峰平谷方案',
    来源时区: 'Asia/Shanghai',
    来源: '配置导入测试',
    文号: 'TOU-DOC-001',
    版本: 'tou-weekly:v1',
    '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z',
    状态: 'active',
    ...overrides
  };
}

/** 构造每天无缺口、无重叠覆盖 0 至 1440 的 TOU 规则。 */
function createCompleteTouRows(overrides = {}) {
  const rows = [];
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    rows.push(
      { 方案编码: 'TOU-WEEKLY', 方案版本: 'tou-weekly:v1', 星期序号: dayOfWeek, 时段类型: 'valley', 开始分钟: 0, 结束分钟: 480, ...overrides },
      { 方案编码: 'TOU-WEEKLY', 方案版本: 'tou-weekly:v1', 星期序号: dayOfWeek, 时段类型: 'flat', 开始分钟: 480, 结束分钟: 1080, ...overrides },
      { 方案编码: 'TOU-WEEKLY', 方案版本: 'tou-weekly:v1', 星期序号: dayOfWeek, 时段类型: 'peak', 开始分钟: 1080, 结束分钟: 1440, ...overrides }
    );
  }
  return rows;
}

/** 构造合法受控策略模板行。 */
function createStrategyRow(overrides = {}) {
  return {
    规则编码: 'LOAD-RATE-HIGH',
    规则名称: '负荷率偏高提示',
    规则版本: 'load-rate-high:v1',
    公式版本: 'load-analysis:v1',
    指标编码: 'load_rate',
    阈值操作符: 'gte',
    阈值: 80,
    阈值下限: '',
    阈值上限: '',
    阈值单位: '%',
    预计降幅: 0.1,
    优先级: 'high',
    最低覆盖率: 1,
    最大证据数: 10,
    节省依据: 'window_total_energy',
    建议内容: '请人工复核高负荷时段。',
    来源: '配置导入测试',
    '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z',
    来源时区: 'Asia/Shanghai',
    状态: 'active',
    ...overrides
  };
}

/** 根据 preview 构造完整 execute 见证请求。 */
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
    candidateRowIds: [...preview.candidateRowIds],
    candidateRows: preview.candidateRows.map((row) => ({ ...row }))
  };
}

/** 创建不访问真实数据库文件的备份桩。 */
function createBackupStub() {
  return async ({ reason }) => ({
    backupName: `test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    reason,
    sizeBytes: 128,
    sha256: 'a'.repeat(64),
    method: 'test-stub'
  });
}

/** 捕获稳定 details.code。 */
async function captureErrorCode(callback, expectedStatusCode) {
  try {
    await callback();
  } catch (error) {
    assert(error.details && error.details.code, `错误必须包含稳定 details.code，实际为 ${error.stack || error}`);
    if (expectedStatusCode !== undefined) assert.strictEqual(error.statusCode, expectedStatusCode);
    return error.details.code;
  }
  assert.fail('预期操作失败，但实际成功。');
}

/** 统计白名单业务表记录数。 */
function countRecords(db, tableName) {
  assert([
    'shift_definitions', 'tou_schemes', 'tou_period_rules', 'strategy_rules',
    'strategy_evaluation_runs', 'strategy_rule_hits', 'energy_records', 'energy_budgets', 'meter_devices'
  ].includes(tableName));
  return db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total;
}

/** 返回测试操作者 ID。 */
function getActorUserId(db) {
  return Number(db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id);
}

/** 执行班次定义重复、冲突、多 active、版本切换和追溯验证。 */
async function testShiftDefinitions(db, baseOptions) {
  const fileDuplicate = writeCsvUpload('shift-file-duplicate.csv', SHIFT_HEADERS, [createShiftRow(), createShiftRow()]);
  const duplicatePreview = previewShiftDefinitionImport(fileDuplicate, baseOptions);
  assert.strictEqual(duplicatePreview.confirmText, '确认导入班次定义');
  assert.strictEqual(duplicatePreview.summary.wouldImport, 1);
  assert.strictEqual(duplicatePreview.summary.skipped, 1, '同文件相同业务内容不得因物理行号不同误判冲突。');

  const duplicateResult = await executeShiftDefinitionImport(createExecuteBody(duplicatePreview), baseOptions);
  assert.strictEqual(duplicateResult.imported, 1);
  const inserted = db.prepare(
    `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber, status
       FROM shift_definitions WHERE shift_code = 'SHIFT-DAY' AND version = 'shift-day:v1'`
  ).get();
  assert.deepStrictEqual(inserted, { sourceBatchId: duplicatePreview.batchId, sourceRowNumber: 2, status: 'active' });

  const databaseDuplicateFile = writeCsvUpload('shift-database-duplicate.csv', SHIFT_HEADERS, [createShiftRow()]);
  const databaseDuplicatePreview = previewShiftDefinitionImport(databaseDuplicateFile, baseOptions);
  assert.strictEqual(databaseDuplicatePreview.summary.skipped, 1, '数据库完全重复必须忽略导入追溯字段并 skip。');
  assert.strictEqual(databaseDuplicatePreview.candidateRows.length, 0);

  const identityConflictFile = writeCsvUpload('shift-identity-conflict.csv', SHIFT_HEADERS, [createShiftRow({ 班次名称: '冲突白班' })]);
  const identityConflictPreview = previewShiftDefinitionImport(identityConflictFile, baseOptions);
  assert.strictEqual(identityConflictPreview.summary.blocked, 1);
  assert(identityConflictPreview.auditIssues.some((issue) => issue.code === 'ENERGY_ANALYSIS_CONFIGURATION_IDENTITY_CONFLICT'));

  const activeConflictFile = writeCsvUpload('shift-multiple-active.csv', SHIFT_HEADERS, [
    createShiftRow({ 班次编码: 'SHIFT-MULTI', 版本: 'shift-multi:v1' }),
    createShiftRow({ 班次编码: 'SHIFT-MULTI', 版本: 'shift-multi:v2' })
  ]);
  const activeConflictPreview = previewShiftDefinitionImport(activeConflictFile, baseOptions);
  assert.strictEqual(activeConflictPreview.summary.blocked, 2);
  assert(activeConflictPreview.items.every((item) => item.issues.some((issue) => issue.code === 'ENERGY_ANALYSIS_MULTIPLE_ACTIVE_VERSIONS_IN_FILE')));

  const versionFile = writeCsvUpload('shift-version-v2.csv', SHIFT_HEADERS, [createShiftRow({
    班次名称: '白班第二版',
    结束分钟: 1080,
    版本: 'shift-day:v2'
  })]);
  const versionPreview = previewShiftDefinitionImport(versionFile, baseOptions);
  assert.strictEqual(versionPreview.summary.wouldImport, 1);
  await executeShiftDefinitionImport(createExecuteBody(versionPreview), baseOptions);
  const versions = db.prepare(
    `SELECT version, status FROM shift_definitions WHERE shift_code = 'SHIFT-DAY' ORDER BY version`
  ).all();
  assert.deepStrictEqual(versions, [
    { version: 'shift-day:v1', status: 'inactive' },
    { version: 'shift-day:v2', status: 'active' }
  ]);
}

/** 执行 TOU 七天覆盖、缺口、重叠、格式、重复和原子版本验证。 */
async function testTouSchemes(db, baseOptions) {
  const validFile = writeXlsxUpload('tou-valid.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow()] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: createCompleteTouRows() }
  ]);
  const validPreview = previewTouSchemeImport(validFile, baseOptions);
  assert.strictEqual(validPreview.confirmText, '确认导入TOU方案与时段');
  assert.strictEqual(validPreview.summary.wouldImport, 1);
  assert.strictEqual(validPreview.candidateRows[0].periodRules.length, 21);
  const validResult = await executeTouSchemeImport(createExecuteBody(validPreview), baseOptions);
  assert.strictEqual(validResult.imported, 1);
  assert.strictEqual(countRecords(db, 'tou_period_rules'), 21, '主方案和七天规则必须全部原子写入。');

  const databaseDuplicateFile = writeXlsxUpload('tou-database-duplicate.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow()] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: createCompleteTouRows() }
  ]);
  assert.strictEqual(previewTouSchemeImport(databaseDuplicateFile, baseOptions).summary.skipped, 1);

  const identityConflictFile = writeXlsxUpload('tou-identity-conflict.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow({ 方案名称: '冲突方案' })] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: createCompleteTouRows() }
  ]);
  assert.strictEqual(previewTouSchemeImport(identityConflictFile, baseOptions).summary.blocked, 1);

  const gapRows = createCompleteTouRows().filter((row) => !(row.星期序号 === 3 && row.开始分钟 === 480));
  const gapFile = writeXlsxUpload('tou-gap.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow({ 方案编码: 'TOU-GAP', 版本: 'tou-gap:v1' })] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: gapRows.map((row) => ({ ...row, 方案编码: 'TOU-GAP', 方案版本: 'tou-gap:v1' })) }
  ]);
  const gapPreview = previewTouSchemeImport(gapFile, baseOptions);
  assert.strictEqual(gapPreview.summary.blocked, 1);
  assert(gapPreview.auditIssues.some((issue) => /TOU|PERIOD|COVERAGE|RANGE/.test(issue.code)));

  const overlapRows = createCompleteTouRows().map((row) => (
    row.星期序号 === 4 && row.开始分钟 === 480 ? { ...row, 开始分钟: 470 } : row
  ));
  const overlapFile = writeXlsxUpload('tou-overlap.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow({ 方案编码: 'TOU-OVERLAP', 版本: 'tou-overlap:v1' })] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: overlapRows.map((row) => ({ ...row, 方案编码: 'TOU-OVERLAP', 方案版本: 'tou-overlap:v1' })) }
  ]);
  assert.strictEqual(previewTouSchemeImport(overlapFile, baseOptions).summary.blocked, 1);

  const csvFile = writeCsvUpload('tou-forbidden.csv', TOU_SCHEME_HEADERS, [createTouSchemeRow()]);
  assert.throws(
    () => previewTouSchemeImport(csvFile, baseOptions),
    (error) => error.details?.code === 'ENERGY_ANALYSIS_CONFIGURATION_FILE_TYPE_UNSUPPORTED'
  );

  const extraSheetFile = writeXlsxUpload('tou-extra-sheet.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow({ 方案编码: 'TOU-EXTRA', 版本: 'tou-extra:v1' })] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: createCompleteTouRows({ 方案编码: 'TOU-EXTRA', 方案版本: 'tou-extra:v1' }) },
    { name: '说明', headers: ['内容'], rows: [{ 内容: '不允许额外工作表' }] }
  ]);
  assert.strictEqual(previewTouSchemeImport(extraSheetFile, baseOptions).summary.blocked, 1);

  const versionFile = writeXlsxUpload('tou-version-v2.xlsx', [
    { name: 'TOU方案', headers: TOU_SCHEME_HEADERS, rows: [createTouSchemeRow({ 方案名称: '周峰平谷第二版', 版本: 'tou-weekly:v2' })] },
    { name: '时段规则', headers: TOU_RULE_HEADERS, rows: createCompleteTouRows({ 方案版本: 'tou-weekly:v2' }) }
  ]);
  const versionPreview = previewTouSchemeImport(versionFile, baseOptions);
  await executeTouSchemeImport(createExecuteBody(versionPreview), baseOptions);
  assert.deepStrictEqual(db.prepare(
    `SELECT version, status FROM tou_schemes WHERE scheme_code = 'TOU-WEEKLY' ORDER BY version`
  ).all(), [
    { version: 'tou-weekly:v1', status: 'inactive' },
    { version: 'tou-weekly:v2', status: 'active' }
  ]);
}

/** 执行策略白名单、任意 JSON 拒绝、重复、版本切换和自动化边界验证。 */
async function testStrategyRules(db, baseOptions) {
  const validFile = writeCsvUpload('strategy-valid.csv', STRATEGY_HEADERS, [createStrategyRow()]);
  const validPreview = previewStrategyRuleImport(validFile, baseOptions);
  assert.strictEqual(validPreview.confirmText, '确认导入策略规则');
  assert.strictEqual(validPreview.summary.wouldImport, 1);
  assert.deepStrictEqual(validPreview.candidateRows[0].evidenceRequirements, {
    minimumCoverageRate: 1,
    maxEvidenceItems: 10,
    savingBasis: 'window_total_energy'
  });

  const beforeDomainCounts = {
    runs: countRecords(db, 'strategy_evaluation_runs'),
    hits: countRecords(db, 'strategy_rule_hits'),
    energy: countRecords(db, 'energy_records'),
    budgets: countRecords(db, 'energy_budgets'),
    meters: countRecords(db, 'meter_devices')
  };
  await executeStrategyRuleImport(createExecuteBody(validPreview), baseOptions);
  assert.deepStrictEqual({
    runs: countRecords(db, 'strategy_evaluation_runs'),
    hits: countRecords(db, 'strategy_rule_hits'),
    energy: countRecords(db, 'energy_records'),
    budgets: countRecords(db, 'energy_budgets'),
    meters: countRecords(db, 'meter_devices')
  }, beforeDomainCounts, '策略导入只能保存规则，不得运行策略或修改其他领域。');

  const databaseDuplicateFile = writeCsvUpload('strategy-database-duplicate.csv', STRATEGY_HEADERS, [createStrategyRow()]);
  assert.strictEqual(previewStrategyRuleImport(databaseDuplicateFile, baseOptions).summary.skipped, 1);

  const conflictFile = writeCsvUpload('strategy-conflict.csv', STRATEGY_HEADERS, [createStrategyRow({ 阈值: 85 })]);
  assert.strictEqual(previewStrategyRuleImport(conflictFile, baseOptions).summary.blocked, 1);

  const whitelistCases = [
    { name: '公式', overrides: { 公式版本: 'dynamic:v1' }, expected: 'UNSUPPORTED_STRATEGY_FORMULA_VERSION' },
    { name: '指标', overrides: { 指标编码: 'javascript_function' }, expected: 'UNSUPPORTED_STRATEGY_METRIC_CODE' },
    { name: '操作符', overrides: { 阈值操作符: 'eval' }, expected: 'INVALID_STRATEGY_THRESHOLD_OPERATOR' },
    { name: '优先级', overrides: { 优先级: 'urgent' }, expected: 'INVALID_STRATEGY_PRIORITY' },
    { name: '节省依据', overrides: { 节省依据: 'dynamic_expression' }, expected: 'INVALID_STRATEGY_EVIDENCE_REQUIREMENTS' }
  ];
  whitelistCases.forEach((testCase, index) => {
    const file = writeCsvUpload(`strategy-whitelist-${index}.csv`, STRATEGY_HEADERS, [createStrategyRow({
      规则编码: `WHITELIST-${index}`,
      规则版本: `whitelist:${index}:v1`,
      ...testCase.overrides
    })]);
    const preview = previewStrategyRuleImport(file, baseOptions);
    assert.strictEqual(preview.summary.blocked, 1, `${testCase.name} 非法值必须阻断。`);
    assert(preview.auditIssues.some((issue) => issue.code.includes(testCase.expected)), `${testCase.name} 必须返回领域白名单错误。`);
  });

  const jsonHeader = '证据要求JSON';
  const jsonFile = writeCsvUpload(
    'strategy-json-injection.csv',
    STRATEGY_HEADERS,
    [createStrategyRow({ 规则编码: 'JSON-INJECTION', 规则版本: 'json-injection:v1', [jsonHeader]: '{"command":"shutdown"}' })],
    [jsonHeader]
  );
  const jsonPreview = previewStrategyRuleImport(jsonFile, baseOptions);
  assert.strictEqual(jsonPreview.summary.blocked, 1, '任意 JSON 标题不得作为可忽略扩展字段进入候选。');
  assert.strictEqual(jsonPreview.candidateRows.length, 0);

  const versionFile = writeCsvUpload('strategy-version-v2.csv', STRATEGY_HEADERS, [createStrategyRow({
    规则名称: '负荷率偏高提示第二版',
    规则版本: 'load-rate-high:v2',
    阈值: 85
  })]);
  const versionPreview = previewStrategyRuleImport(versionFile, baseOptions);
  await executeStrategyRuleImport(createExecuteBody(versionPreview), baseOptions);
  assert.deepStrictEqual(db.prepare(
    `SELECT rule_version AS ruleVersion, status FROM strategy_rules WHERE rule_code = 'LOAD-RATE-HIGH' ORDER BY rule_version`
  ).all(), [
    { ruleVersion: 'load-rate-high:v1', status: 'inactive' },
    { ruleVersion: 'load-rate-high:v2', status: 'active' }
  ]);
}

/** 验证固定确认、备份、风险确认、stale、文件和候选见证篡改。 */
async function testExecuteAuthorization(db, baseOptions) {
  const cases = [
    {
      name: '固定确认文本',
      expected: 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH',
      mutate: ({ body }) => { body.confirmText = '我已确认'; }
    },
    {
      name: 'requireBackup',
      expected: 'ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED',
      mutate: ({ body }) => { body.requireBackup = false; }
    },
    {
      name: '风险确认',
      expected: 'ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED',
      mutate: ({ body }) => { body.acknowledgeSkippedRisks = false; }
    },
    {
      name: '候选见证篡改',
      expected: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
      mutate: ({ body }) => { body.candidateRows[0].shiftName = '伪造名称'; }
    },
    {
      name: 'stale 批次',
      expected: 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID',
      mutate: ({ preview }) => { db.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(preview.batchId); }
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const file = writeCsvUpload(`shift-auth-${index}.csv`, SHIFT_HEADERS, [createShiftRow({
      班次编码: `SHIFT-AUTH-${index}`,
      版本: `shift-auth:${index}:v1`
    })]);
    const preview = previewShiftDefinitionImport(file, baseOptions);
    const body = createExecuteBody(preview);
    let backupCalls = 0;
    testCase.mutate({ body, preview });
    const beforeCount = countRecords(db, 'shift_definitions');
    const code = await captureErrorCode(() => executeShiftDefinitionImport(body, {
      ...baseOptions,
      createBackup: async (input) => {
        backupCalls += 1;
        return createBackupStub()(input);
      }
    }));
    assert.strictEqual(code, testCase.expected, `${testCase.name} 必须返回稳定错误码。`);
    assert.strictEqual(countRecords(db, 'shift_definitions'), beforeCount);
    assert.strictEqual(backupCalls, 0, `${testCase.name} 不得进入备份。`);
  }

  const tamperFile = writeCsvUpload('shift-file-tamper.csv', SHIFT_HEADERS, [createShiftRow({
    班次编码: 'SHIFT-FILE-TAMPER',
    版本: 'shift-file-tamper:v1'
  })]);
  const tamperPreview = previewShiftDefinitionImport(tamperFile, baseOptions);
  const tamperPath = path.join(process.env.UPLOADS_DIR, tamperFile.filename);
  const tamperedBuffer = fs.readFileSync(tamperPath);
  const markerIndex = tamperedBuffer.indexOf(Buffer.from('SHIFT-FILE-TAMPER'));
  assert(markerIndex >= 0, '原文件篡改测试必须定位班次编码。');
  tamperedBuffer[markerIndex] = tamperedBuffer[markerIndex] === 0x53 ? 0x73 : 0x53;
  fs.writeFileSync(tamperPath, tamperedBuffer);
  const beforeTamperCount = countRecords(db, 'shift_definitions');
  assert.strictEqual(
    await captureErrorCode(() => executeShiftDefinitionImport(createExecuteBody(tamperPreview), baseOptions)),
    'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH'
  );
  assert.strictEqual(countRecords(db, 'shift_definitions'), beforeTamperCount);
}

/** 验证任意候选或审计失败都会整体回滚业务写入。 */
async function testTransactionRollback(db, baseOptions) {
  const shiftFile = writeCsvUpload('shift-transaction-rollback.csv', SHIFT_HEADERS, [
    createShiftRow({ 班次编码: 'SHIFT-TX-A', 版本: 'shift-tx-a:v1' }),
    createShiftRow({ 班次编码: 'SHIFT-TX-B', 版本: 'shift-tx-b:v1' })
  ]);
  const shiftPreview = previewShiftDefinitionImport(shiftFile, baseOptions);
  const beforeShiftCount = countRecords(db, 'shift_definitions');
  const code = await captureErrorCode(() => executeShiftDefinitionImport(createExecuteBody(shiftPreview), {
    ...baseOptions,
    afterInsertCandidate: ({ index }) => {
      if (index === 0) throw new Error('注入事务中途失败');
    }
  }), 500);
  assert.strictEqual(code, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countRecords(db, 'shift_definitions'), beforeShiftCount, '候选中途失败必须回滚首条。');
  assert.strictEqual(getImportAuditBatchDetail(shiftPreview.batchId, { db }).status, 'failed');

  const strategyFile = writeCsvUpload('strategy-audit-rollback.csv', STRATEGY_HEADERS, [createStrategyRow({
    规则编码: 'STRATEGY-AUDIT-ROLLBACK',
    规则版本: 'strategy-audit-rollback:v1'
  })]);
  const strategyPreview = previewStrategyRuleImport(strategyFile, baseOptions);
  const beforeStrategyCount = countRecords(db, 'strategy_rules');
  const auditCode = await captureErrorCode(() => executeStrategyRuleImport(createExecuteBody(strategyPreview), {
    ...baseOptions,
    auditWriter() {
      throw new Error('注入配置操作审计失败');
    }
  }), 500);
  assert.strictEqual(auditCode, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countRecords(db, 'strategy_rules'), beforeStrategyCount, '操作审计失败必须回滚规则写入。');
}

(async () => {
  let db = null;
  try {
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    initDatabase();
    db = openDatabase();
    const baseOptions = {
      db,
      uploadsDir: process.env.UPLOADS_DIR,
      createBackup: createBackupStub(),
      actorUserId: getActorUserId(db),
      actorIp: '127.0.0.1'
    };

    await testShiftDefinitions(db, baseOptions);
    await testTouSchemes(db, baseOptions);
    await testStrategyRules(db, baseOptions);
    await testExecuteAuthorization(db, baseOptions);
    await testTransactionRollback(db, baseOptions);

    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
    console.log('energy analysis configuration import service tests passed');
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
