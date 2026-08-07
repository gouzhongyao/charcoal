'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 测试数据库、上传目录和所有原文件均隔离到系统临时目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-operations-import-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-operations-import.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-operations-import-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const {
  executeDeviceStateImport,
  executeShiftScheduleImport,
  previewDeviceStateImport,
  previewShiftScheduleImport
} = require('../services/energyOperationsImportService');

// 排班冻结模板的中文列顺序。
const SHIFT_HEADERS = Object.freeze([
  '班次编码',
  '班次名称',
  '班次开始分钟',
  '班次结束分钟',
  '是否跨日',
  '来源时区',
  '定义来源',
  '定义版本',
  '定义生效开始时间（UTC）',
  '定义生效结束时间（UTC）',
  '用能单元编码',
  '排班开始时间（UTC）',
  '排班结束时间（UTC）',
  '来源标识',
  '数据来源',
  '状态'
]);

// 设备状态冻结模板的中文列顺序。
const DEVICE_HEADERS = Object.freeze([
  '计量器具编码',
  '用能单元编码',
  '设备状态',
  '开始时间（UTC）',
  '结束时间（UTC）',
  '来源时区',
  '来源标识',
  '数据来源'
]);

/**
 * 创建合法排班数据行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 中文标题数据行。
 */
function createValidShiftRow(overrides = {}) {
  return {
    班次编码: 'DAY',
    班次名称: '白班',
    班次开始分钟: 360,
    班次结束分钟: 840,
    是否跨日: 0,
    来源时区: 'Asia/Shanghai',
    定义来源: '企业排班制度',
    定义版本: 'shift:v1',
    '定义生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '定义生效结束时间（UTC）': '2027-01-01T00:00:00Z',
    用能单元编码: 'W-001',
    '排班开始时间（UTC）': '2026-07-14T22:00:00Z',
    '排班结束时间（UTC）': '2026-07-15T06:00:00Z',
    来源标识: 'upload:shift:001',
    数据来源: 'upload',
    状态: 'active',
    ...overrides
  };
}

/**
 * 创建合法跨午夜排班数据行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 中文标题数据行。
 */
function createValidNightShiftRow(overrides = {}) {
  return createValidShiftRow({
    班次编码: 'NIGHT',
    班次名称: '夜班',
    班次开始分钟: 1320,
    班次结束分钟: 360,
    是否跨日: 1,
    '排班开始时间（UTC）': '2026-07-15T14:00:00Z',
    '排班结束时间（UTC）': '2026-07-15T22:00:00Z',
    来源标识: 'upload:shift:night',
    ...overrides
  });
}

/**
 * 创建合法设备状态数据行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 中文标题数据行。
 */
function createValidDeviceRow(overrides = {}) {
  return {
    计量器具编码: 'M-001',
    用能单元编码: 'E-001',
    设备状态: 'running',
    '开始时间（UTC）': '2026-07-14T16:00:00Z',
    '结束时间（UTC）': '2026-07-14T17:00:00Z',
    来源时区: 'Asia/Shanghai',
    来源标识: 'upload:device-state:001',
    数据来源: 'upload',
    ...overrides
  };
}

/**
 * 转义 CSV 单元格。
 * @param {*} value 原始值。
 * @returns {string} CSV 文本。
 */
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 写入 CSV 原文件并返回 Multer 风格文件对象。
 * @param {string} storedFilename 保存文件名。
 * @param {string[]} headers 中文标题。
 * @param {object[]} rows 中文标题数据行。
 * @param {number} blankLineCount 表头后空白物理行数。
 * @returns {object} Multer 文件对象。
 */
function writeCsvUpload(storedFilename, headers, rows, blankLineCount = 0) {
  const contentRows = [
    headers.map(escapeCsvCell).join(','),
    ...Array.from({ length: blankLineCount }, () => ''),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))
  ];
  const buffer = Buffer.from(`﻿${contentRows.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/**
 * 写入 XLSX 原文件并返回 Multer 风格文件对象。
 * @param {string} storedFilename 保存文件名。
 * @param {string} sheetName 工作表名称。
 * @param {string[]} headers 中文标题。
 * @param {object[]} rows 中文标题数据行。
 * @param {number} blankLineCount 表头后空白物理行数。
 * @param {string[]} extraHeaders 附加 warning 标题。
 * @returns {object} Multer 文件对象。
 */
function writeXlsxUpload(storedFilename, sheetName, headers, rows, blankLineCount = 0, extraHeaders = []) {
  const allHeaders = [...headers, ...extraHeaders];
  const matrix = [
    allHeaders,
    ...Array.from({ length: blankLineCount }, () => []),
    ...rows.map((row) => allHeaders.map((header) => row[header] ?? (extraHeaders.includes(header) ? '仅产生 warning' : '')))
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheetName);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/**
 * 构造与 preview 完全绑定的 execute 请求。
 * @param {object} preview 安全 preview。
 * @returns {object} execute 请求体。
 */
function createExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: 'energy-analysis-import',
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

/**
 * 创建不访问真实数据目录的备份桩。
 * @returns {Function} 异步备份函数。
 */
function createBackupStub() {
  return async ({ reason }) => ({
    backupName: `test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    reason,
    sizeBytes: 128,
    sha256: 'a'.repeat(64),
    method: 'test-stub'
  });
}

/**
 * 捕获稳定业务错误码，并按需校验 HTTP 状态语义。
 * @param {Function} callback 异步操作。
 * @param {number|undefined} expectedStatusCode 预期 HTTP 状态码。
 * @returns {Promise<string>} details.code。
 */
async function captureErrorCode(callback, expectedStatusCode) {
  try {
    await callback();
  } catch (error) {
    assert(error.details && error.details.code, `错误必须包含稳定 details.code，实际为 ${error.stack || error}`);
    if (expectedStatusCode !== undefined) {
      assert.strictEqual(error.statusCode, expectedStatusCode);
    }
    return error.details.code;
  }
  assert.fail('预期操作失败，但实际成功。');
}

/**
 * 统计指定业务表记录数。
 * @param {object} db SQLite 连接。
 * @param {string} tableName 白名单业务表名。
 * @returns {number} 记录数。
 */
function countRecords(db, tableName) {
  assert(['shift_schedule_records', 'device_state_records', 'shift_definitions'].includes(tableName));
  return db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total;
}

/**
 * 直接写入隔离测试库中的既有 active 排班事实。
 * @param {object} db SQLite 连接。
 * @param {object} input 排班事实覆盖值。
 */
function insertExistingShiftRecord(db, input) {
  const organization = db.prepare('SELECT id FROM organization_units WHERE unit_code = ?').get(input.organizationCode || 'W-001');
  const definition = db.prepare('SELECT id FROM shift_definitions WHERE shift_code = ?').get(input.shiftCode || 'DAY');
  db.prepare(
    `INSERT INTO shift_schedule_records (
       shift_definition_id, organization_unit_id, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status
     ) VALUES (?, ?, ?, ?, ?, ?, 'upload', 'active')`
  ).run(
    definition.id,
    organization.id,
    input.startUtc,
    input.endUtc,
    input.sourceTimeZone || 'Asia/Shanghai',
    input.sourceReference
  );
}

/**
 * 直接写入隔离测试库中的既有 active 设备状态事实。
 * @param {object} db SQLite 连接。
 * @param {object} input 设备状态事实覆盖值。
 */
function insertExistingDeviceStateRecord(db, input) {
  const organization = db.prepare('SELECT id FROM organization_units WHERE unit_code = ?').get(input.organizationCode || 'E-001');
  const meter = db.prepare('SELECT id FROM meter_devices WHERE meter_code = ?').get(input.meterCode || 'M-001');
  db.prepare(
    `INSERT INTO device_state_records (
       meter_device_id, organization_unit_id, device_state, start_utc, end_utc,
       source_timezone, source_reference, data_source, record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', 'active')`
  ).run(
    meter.id,
    organization.id,
    input.deviceState || 'running',
    input.startUtc,
    input.endUtc,
    input.sourceTimeZone || 'Asia/Shanghai',
    input.sourceReference
  );
}

/**
 * 初始化组织、表计和 active 班次定义主数据。
 * @param {object} db SQLite 连接。
 */
function seedMasterData(db) {
  const workshopId = Number(db.prepare(
    `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('W-001', '一号车间', '/W-001', 'workshop', 'active')`
  ).run().lastInsertRowid);
  const equipmentOneId = Number(db.prepare(
    `INSERT INTO organization_units (parent_id, unit_code, unit_name, unit_path, unit_type, status)
     VALUES (?, 'E-001', '一号设备', '/W-001/E-001', 'equipment', 'active')`
  ).run(workshopId).lastInsertRowid);
  const equipmentTwoId = Number(db.prepare(
    `INSERT INTO organization_units (parent_id, unit_code, unit_name, unit_path, unit_type, status)
     VALUES (?, 'E-002', '二号设备', '/W-001/E-002', 'equipment', 'active')`
  ).run(workshopId).lastInsertRowid);
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  db.prepare(
    `INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES ('M-001', '一号设备电表', 'electricity', ?, ?, 'active')`
  ).run(electricity.id, equipmentOneId);
  db.prepare(
    `INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES ('M-002', '二号设备电表', 'electricity', ?, ?, 'active')`
  ).run(electricity.id, equipmentTwoId);

  const insertShift = db.prepare(
    `INSERT INTO shift_definitions (
       shift_code, shift_name, start_minute, end_minute, crosses_midnight,
       source_timezone, source, version, effective_start_utc, effective_end_utc, status
     ) VALUES (?, ?, ?, ?, ?, 'Asia/Shanghai', '企业排班制度', 'shift:v1',
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active')`
  );
  insertShift.run('DAY', '白班', 360, 840, 0);
  insertShift.run('NIGHT', '夜班', 1320, 360, 1);
  insertShift.run('SWING', '中班', 720, 1200, 0);
  db.prepare(
    `INSERT INTO shift_definitions (
       shift_code, shift_name, start_minute, end_minute, crosses_midnight,
       source_timezone, source, version, effective_start_utc, effective_end_utc, status
     ) VALUES ('DST-DAY', '夏令时日班', 90, 210, 0, 'America/New_York', '企业排班制度',
       'shift:v1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active')`
  ).run();
}

/**
 * 验证两类 preview 零业务写入、物理行号、合法 execute 来源追溯和成功审计。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 */
async function testPreviewAndExecute(db, options) {
  const shiftFile = writeXlsxUpload(
    'valid-shift-physical-row.xlsx',
    '排班计划',
    SHIFT_HEADERS,
    [createValidShiftRow()],
    2,
    ['备注扩展列']
  );
  const shiftDefinitionCount = countRecords(db, 'shift_definitions');
  const shiftPreview = previewShiftScheduleImport(shiftFile, options);
  assert.strictEqual(countRecords(db, 'shift_schedule_records'), 0, '排班 preview 不得写业务事实表。');
  assert.strictEqual(countRecords(db, 'shift_definitions'), shiftDefinitionCount, '排班 preview 不得隐式创建班次定义。');
  assert.strictEqual(shiftPreview.summary.wouldImport, 1);
  assert.strictEqual(shiftPreview.candidateRows[0].sourceRowNumber, 4, 'XLSX 中间空白行后必须保留真实物理行号。');
  assert.strictEqual(shiftPreview.auditBatch.importType, 'shift_schedule');
  assert.strictEqual(shiftPreview.auditBatch.auditPhase, 'preview');
  assert.strictEqual(getImportAuditBatchDetail(shiftPreview.batchId, { db }).issueCounts.warning, 1);

  const shiftResult = await executeShiftScheduleImport(createExecuteBody(shiftPreview), options);
  assert.strictEqual(shiftResult.imported, 1);
  const insertedShift = db.prepare(
    `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
            record_status AS recordStatus
     FROM shift_schedule_records WHERE id = ?`
  ).get(shiftResult.importedIds[0]);
  assert.deepStrictEqual(insertedShift, {
    sourceBatchId: shiftPreview.batchId,
    sourceRowNumber: 4,
    recordStatus: 'active'
  });
  const shiftAudit = getImportAuditBatchDetail(shiftPreview.batchId, { db });
  assert.strictEqual(shiftAudit.auditPhase, 'execute');
  assert.strictEqual(shiftAudit.status, 'completed');
  assert.strictEqual(shiftAudit.backup.reason, 'energy-analysis-import');
  assert(!JSON.stringify(shiftAudit).includes(tmpDir), '排班审计不得泄漏本机临时目录绝对路径。');

  const deviceFile = writeCsvUpload(
    'valid-device-physical-row.csv',
    DEVICE_HEADERS,
    [createValidDeviceRow()],
    2
  );
  const devicePreview = previewDeviceStateImport(deviceFile, options);
  assert.strictEqual(countRecords(db, 'device_state_records'), 0, '设备状态 preview 不得写业务事实表。');
  assert.strictEqual(devicePreview.summary.wouldImport, 1);
  assert.strictEqual(devicePreview.candidateRows[0].sourceRowNumber, 4, 'CSV 空白行后必须保留真实物理起始行号。');
  assert.strictEqual(devicePreview.auditBatch.importType, 'device_state');
  assert.strictEqual(devicePreview.auditBatch.auditPhase, 'preview');

  const deviceResult = await executeDeviceStateImport(createExecuteBody(devicePreview), options);
  assert.strictEqual(deviceResult.imported, 1);
  const insertedDevice = db.prepare(
    `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
            record_status AS recordStatus, device_state AS deviceState
     FROM device_state_records WHERE id = ?`
  ).get(deviceResult.importedIds[0]);
  assert.deepStrictEqual(insertedDevice, {
    sourceBatchId: devicePreview.batchId,
    sourceRowNumber: 4,
    recordStatus: 'active',
    deviceState: 'running'
  });
  const deviceAudit = getImportAuditBatchDetail(devicePreview.batchId, { db });
  assert.strictEqual(deviceAudit.auditPhase, 'execute');
  assert.strictEqual(deviceAudit.status, 'completed');
  assert.strictEqual(deviceAudit.executeResult.imported, 1);
  assert(!JSON.stringify(deviceAudit).includes(tmpDir), '设备状态审计不得泄漏本机临时目录绝对路径。');
}

/**
 * 验证 CSV 原始标题数组在零数据行和重复、规范化、同义别名场景下都不会被对象键覆盖。
 * @param {object} options 服务选项。
 */
function testCsvHeaderSafety(options) {
  const templateCases = [
    {
      name: 'shift',
      headers: SHIFT_HEADERS,
      createRow: createValidShiftRow,
      preview: previewShiftScheduleImport
    },
    {
      name: 'device',
      headers: DEVICE_HEADERS,
      createRow: createValidDeviceRow,
      preview: previewDeviceStateImport
    }
  ];

  templateCases.forEach((templateCase) => {
    const duplicateRawFile = writeCsvUpload(
      `${templateCase.name}-duplicate-raw-header.csv`,
      [...templateCase.headers, '用能单元编码'],
      [templateCase.createRow()]
    );
    const duplicateRawPreview = templateCase.preview(duplicateRawFile, options);
    assert.strictEqual(duplicateRawPreview.summary.blocked, 1);
    assert(duplicateRawPreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_RAW_HEADER'));

    const normalizedDuplicateRow = templateCase.createRow({ '用能 单元编码': templateCase.name === 'shift' ? 'W-001' : 'E-001' });
    const normalizedDuplicateFile = writeCsvUpload(
      `${templateCase.name}-duplicate-normalized-header.csv`,
      [...templateCase.headers, '用能 单元编码'],
      [normalizedDuplicateRow]
    );
    const normalizedDuplicatePreview = templateCase.preview(normalizedDuplicateFile, options);
    assert.strictEqual(normalizedDuplicatePreview.summary.blocked, 1);
    assert(normalizedDuplicatePreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_NORMALIZED_HEADER'));

    const aliasConflictRow = templateCase.createRow({ 组织编码: templateCase.name === 'shift' ? 'E-001' : 'W-001' });
    const aliasConflictFile = writeCsvUpload(
      `${templateCase.name}-alias-conflict.csv`,
      [...templateCase.headers, '组织编码'],
      [aliasConflictRow]
    );
    const aliasConflictPreview = templateCase.preview(aliasConflictFile, options);
    assert.strictEqual(aliasConflictPreview.summary.blocked, 1);
    assert(aliasConflictPreview.auditIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_MAPPING'));
    assert(aliasConflictPreview.auditIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_VALUE'));

    const missingOrganizationHeaders = templateCase.headers.filter((header) => header !== '用能单元编码');
    const missingHeaderFile = writeCsvUpload(
      `${templateCase.name}-missing-header-without-rows.csv`,
      missingOrganizationHeaders,
      []
    );
    const missingHeaderPreview = templateCase.preview(missingHeaderFile, options);
    assert.strictEqual(missingHeaderPreview.summary.blocked, 1, '零数据行也必须把缺失必需标题投影为阻断项。');
    assert(missingHeaderPreview.auditIssues.some((issue) => issue.code === 'MISSING_REQUIRED_HEADER'));

    const headerOnlyFile = writeCsvUpload(
      `${templateCase.name}-valid-header-only.csv`,
      templateCase.headers,
      []
    );
    const headerOnlyPreview = templateCase.preview(headerOnlyFile, options);
    assert.deepStrictEqual(headerOnlyPreview.summary, {
      totalRows: 0,
      wouldImport: 0,
      skipped: 0,
      blocked: 0,
      warnings: 0,
      errors: 0
    });
  });
}

/**
 * 验证公共授权门槛、原文件重算和描述器绑定均在写入前拒绝。
 * @param {object} db SQLite 连接。
 * @param {object} baseOptions 服务选项。
 */
async function testAuthorizationAndDescriptorBinding(db, baseOptions) {
  const cases = [
    {
      name: '文件 SHA',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH',
      mutate: ({ body }) => { body.fileSha256 = '0'.repeat(64); }
    },
    {
      name: 'preview 签名',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID',
      mutate: ({ body }) => { body.previewSignature = `hmac-sha256:v1:${'0'.repeat(64)}`; }
    },
    {
      name: '审计摘要',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID',
      mutate: ({ body }) => { body.previewAuditDigest = `hmac-sha256:v1:audit:${'0'.repeat(64)}`; }
    },
    {
      name: '候选见证',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
      mutate: ({ body }) => { body.candidateRows[0].sourceReference = 'forged-client-value'; }
    },
    {
      name: '固定确认文本',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH',
      mutate: ({ body }) => { body.confirmText = '我已确认'; }
    },
    {
      name: '风险确认',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED',
      mutate: ({ body }) => { body.acknowledgeSkippedRisks = false; }
    },
    {
      name: '备份要求',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED',
      mutate: ({ body }) => { body.requireBackup = false; }
    },
    {
      name: 'stale batch 状态',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID',
      mutate: ({ preview }) => { db.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(preview.batchId); }
    },
    {
      name: 'stale batch 阶段',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH',
      mutate: ({ preview }) => { db.prepare("UPDATE import_batches SET audit_phase = 'execute' WHERE id = ?").run(preview.batchId); }
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const day = 20 + index;
    const file = writeCsvUpload(`shift-auth-reject-${index}.csv`, SHIFT_HEADERS, [createValidShiftRow({
      '排班开始时间（UTC）': `2026-08-${String(day).padStart(2, '0')}T22:00:00Z`,
      '排班结束时间（UTC）': `2026-08-${String(day + 1).padStart(2, '0')}T06:00:00Z`,
      来源标识: `shift-auth-reject:${index}`
    })]);
    const preview = previewShiftScheduleImport(file, baseOptions);
    const body = createExecuteBody(preview);
    let backupCalls = 0;
    const options = {
      ...baseOptions,
      createBackup: async (input) => {
        backupCalls += 1;
        return createBackupStub()(input);
      }
    };
    testCase.mutate({ body, preview });
    const beforeCount = countRecords(db, 'shift_schedule_records');
    const errorCode = await captureErrorCode(() => executeShiftScheduleImport(body, options));
    assert.strictEqual(errorCode, testCase.expectedCode, `${testCase.name} 必须返回预期稳定错误码。`);
    assert.strictEqual(countRecords(db, 'shift_schedule_records'), beforeCount, `${testCase.name} 失配必须零业务写入。`);
    assert.strictEqual(backupCalls, 0, `${testCase.name} 失配不得进入备份。`);
  }

  const deviceFile = writeCsvUpload('device-witness-reject.csv', DEVICE_HEADERS, [createValidDeviceRow({
    '开始时间（UTC）': '2026-09-01T00:00:00Z',
    '结束时间（UTC）': '2026-09-01T01:00:00Z',
    来源标识: 'device-witness-reject'
  })]);
  const devicePreview = previewDeviceStateImport(deviceFile, baseOptions);
  const deviceBody = createExecuteBody(devicePreview);
  deviceBody.confirmText = '确认导入排班记录';
  assert.strictEqual(
    await captureErrorCode(() => executeDeviceStateImport(deviceBody, baseOptions)),
    'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH',
    '设备状态描述器必须绑定自己的固定中文确认文本。'
  );

  const crossFile = writeCsvUpload('descriptor-cross-use.csv', SHIFT_HEADERS, [createValidShiftRow({
    '排班开始时间（UTC）': '2026-10-01T22:00:00Z',
    '排班结束时间（UTC）': '2026-10-02T06:00:00Z',
    来源标识: 'descriptor-cross-use'
  })]);
  const shiftPreview = previewShiftScheduleImport(crossFile, baseOptions);
  let crossBackupCalls = 0;
  const crossCode = await captureErrorCode(() => executeDeviceStateImport(createExecuteBody(shiftPreview), {
    ...baseOptions,
    createBackup: async (input) => {
      crossBackupCalls += 1;
      return createBackupStub()(input);
    }
  }));
  assert([
    'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'
  ].includes(crossCode), `跨描述器执行必须被底座拒绝，实际错误码为 ${crossCode}。`);
  assert.strictEqual(crossBackupCalls, 0, '跨描述器执行不得进入备份。');
  assert.strictEqual(getImportAuditBatchDetail(shiftPreview.batchId, { db }).auditPhase, 'preview', '错误描述器不得篡改其他类型批次审计。');
}

/**
 * 验证排班只引用既有定义、跨午夜、重复与重叠规则。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 */
function testShiftDomainRules(db, options) {
  const definitionCount = countRecords(db, 'shift_definitions');
  const invalidFile = writeCsvUpload('shift-invalid-master.csv', SHIFT_HEADERS, [
    createValidShiftRow({ 班次编码: 'NOT-FOUND', 来源标识: 'missing-shift' }),
    createValidShiftRow({
      用能单元编码: 'ORG-NOT-FOUND',
      '排班开始时间（UTC）': '2026-11-01T22:00:00Z',
      '排班结束时间（UTC）': '2026-11-02T06:00:00Z',
      来源标识: 'missing-org'
    })
  ]);
  const invalidPreview = previewShiftScheduleImport(invalidFile, options);
  const invalidCodes = new Set(invalidPreview.auditIssues.map((issue) => issue.code));
  assert(invalidCodes.has('SHIFT_DEFINITION_NOT_FOUND'));
  assert(invalidCodes.has('ORGANIZATION_UNIT_NOT_FOUND'));
  assert.strictEqual(countRecords(db, 'shift_definitions'), definitionCount, '不存在班次时不得隐式创建定义。');

  const nightFile = writeCsvUpload('shift-night-valid.csv', SHIFT_HEADERS, [createValidNightShiftRow({
    '排班开始时间（UTC）': '2026-11-03T14:00:00Z',
    '排班结束时间（UTC）': '2026-11-03T22:00:00Z',
    来源标识: 'night-valid'
  })]);
  const nightPreview = previewShiftScheduleImport(nightFile, options);
  assert.strictEqual(nightPreview.summary.wouldImport, 1, '跨午夜班次按本地起止和跨日语义应合法。');
  assert(!nightPreview.auditIssues.some((issue) => issue.code === 'SHIFT_SCHEDULE_DEFINITION_ALIGNMENT_MISMATCH'));

  const dstFile = writeCsvUpload('shift-dst-wall-clock-valid.csv', SHIFT_HEADERS, [createValidShiftRow({
    班次编码: 'DST-DAY',
    班次名称: '夏令时日班',
    班次开始分钟: 90,
    班次结束分钟: 210,
    来源时区: 'America/New_York',
    '排班开始时间（UTC）': '2026-03-08T06:30:00Z',
    '排班结束时间（UTC）': '2026-03-08T07:30:00Z',
    来源标识: 'dst-wall-clock-valid'
  })]);
  const dstPreview = previewShiftScheduleImport(dstFile, options);
  assert.strictEqual(dstPreview.summary.wouldImport, 1, 'DST 跳时日只比较本地日历和墙钟，不强制固定 UTC 时长。');

  const alignmentInvalidFile = writeCsvUpload('shift-alignment-invalid.csv', SHIFT_HEADERS, [
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-08T22:00:01Z',
      '排班结束时间（UTC）': '2026-11-09T06:00:00Z',
      来源标识: 'alignment-second-offset'
    }),
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-09T22:00:00.500Z',
      '排班结束时间（UTC）': '2026-11-10T06:00:00Z',
      来源标识: 'alignment-millisecond-offset'
    }),
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-10T22:00:00Z',
      '排班结束时间（UTC）': '2026-11-12T06:00:00Z',
      来源标识: 'alignment-noncross-next-day'
    }),
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-13T00:00:00Z',
      '排班结束时间（UTC）': '2026-11-13T01:00:00Z',
      来源标识: 'alignment-unrelated-wall-clock'
    }),
    createValidNightShiftRow({
      '排班开始时间（UTC）': '2026-11-14T14:00:00Z',
      '排班结束时间（UTC）': '2026-11-16T22:00:00Z',
      来源标识: 'alignment-cross-multiple-days'
    })
  ]);
  const alignmentInvalidPreview = previewShiftScheduleImport(alignmentInvalidFile, options);
  assert.strictEqual(alignmentInvalidPreview.summary.blocked, 5, '秒、毫秒、错误自然日、无关墙钟和跨多日都必须阻断。');
  assert.strictEqual(
    alignmentInvalidPreview.items.filter((item) => item.issues.some((issue) => issue.code === 'SHIFT_SCHEDULE_DEFINITION_ALIGNMENT_MISMATCH')).length,
    5
  );

  const exactFile = writeCsvUpload('shift-file-exact.csv', SHIFT_HEADERS, [
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-04T22:00:00Z',
      '排班结束时间（UTC）': '2026-11-05T06:00:00Z',
      来源标识: 'file-exact'
    }),
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-04T22:00:00Z',
      '排班结束时间（UTC）': '2026-11-05T06:00:00Z',
      来源标识: 'file-exact'
    })
  ]);
  const exactPreview = previewShiftScheduleImport(exactFile, options);
  assert.strictEqual(exactPreview.summary.wouldImport, 1);
  assert.strictEqual(exactPreview.summary.skipped, 1, '文件内完全相同排班事实必须 skip 一条。');

  const overlapFile = writeCsvUpload('shift-file-overlap.csv', SHIFT_HEADERS, [
    createValidShiftRow({
      '排班开始时间（UTC）': '2026-11-06T22:00:00Z',
      '排班结束时间（UTC）': '2026-11-07T06:00:00Z',
      来源标识: 'shift-overlap-day'
    }),
    createValidShiftRow({
      班次编码: 'SWING',
      班次名称: '中班',
      班次开始分钟: 720,
      班次结束分钟: 1200,
      '排班开始时间（UTC）': '2026-11-07T04:00:00Z',
      '排班结束时间（UTC）': '2026-11-07T12:00:00Z',
      来源标识: 'shift-overlap-swing'
    })
  ]);
  const overlapPreview = previewShiftScheduleImport(overlapFile, options);
  assert.strictEqual(overlapPreview.summary.blocked, 2, '同组织不同班次重叠双方都必须阻断。');
  assert(overlapPreview.items.every((item) => item.issues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE')));

  const databaseDuplicate = writeXlsxUpload(
    'shift-database-duplicate.xlsx',
    '排班计划',
    SHIFT_HEADERS,
    [createValidShiftRow()],
    0
  );
  const duplicatePreview = previewShiftScheduleImport(databaseDuplicate, options);
  assert.strictEqual(duplicatePreview.summary.skipped, 1, '数据库完全相同排班事实必须 skip。');
  assert(duplicatePreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_SHIFT_SCHEDULE_SKIPPED'));

  const databaseOverlap = writeCsvUpload('shift-database-overlap.csv', SHIFT_HEADERS, [createValidShiftRow({
    班次编码: 'SWING',
    班次名称: '中班',
    班次开始分钟: 720,
    班次结束分钟: 1200,
    '排班开始时间（UTC）': '2026-07-15T04:00:00Z',
    '排班结束时间（UTC）': '2026-07-15T12:00:00Z',
    来源标识: 'database-overlap-different-shift'
  })]);
  const databaseOverlapPreview = previewShiftScheduleImport(databaseOverlap, options);
  assert.strictEqual(databaseOverlapPreview.summary.blocked, 1, '数据库同组织不同班次重叠必须阻断。');
  assert(databaseOverlapPreview.auditIssues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE'));

  insertExistingShiftRecord(db, {
    startUtc: '2026-11-20T21:00:00.500Z',
    endUtc: '2026-11-20T22:00:00.500Z',
    sourceReference: 'shift-db-500ms-existing'
  });
  const millisecondOverlapFile = writeCsvUpload('shift-database-500ms-overlap.csv', SHIFT_HEADERS, [createValidShiftRow({
    '排班开始时间（UTC）': '2026-11-20T22:00:00Z',
    '排班结束时间（UTC）': '2026-11-21T06:00:00Z',
    来源标识: 'shift-db-500ms-candidate'
  })]);
  const millisecondOverlapPreview = previewShiftScheduleImport(millisecondOverlapFile, options);
  assert.strictEqual(millisecondOverlapPreview.summary.blocked, 1, '数据库真实重叠 500ms 必须被保留毫秒的比较阻断。');

  insertExistingShiftRecord(db, {
    startUtc: '2026-11-21T21:00:00.000Z',
    endUtc: '2026-11-21T22:00:00.000Z',
    sourceReference: 'shift-db-adjacent-existing'
  });
  const adjacentFile = writeCsvUpload('shift-database-adjacent.csv', SHIFT_HEADERS, [createValidShiftRow({
    '排班开始时间（UTC）': '2026-11-21T22:00:00Z',
    '排班结束时间（UTC）': '2026-11-22T06:00:00Z',
    来源标识: 'shift-db-adjacent-candidate'
  })]);
  const adjacentPreview = previewShiftScheduleImport(adjacentFile, options);
  assert.strictEqual(adjacentPreview.summary.wouldImport, 1, '左闭右开区间刚好相邻不得误判重叠。');
  assert.strictEqual(adjacentPreview.candidateRows[0].startUtc, '2026-11-21T22:00:00.000Z', '候选时间必须统一规范化为 ISO Z。');

  insertExistingShiftRecord(db, {
    startUtc: '2026-11-22T22:00:00.000Z',
    endUtc: '2026-11-23T06:00:00.000Z',
    sourceReference: 'shift-db-exact-millisecond'
  });
  const exactMillisecondFile = writeCsvUpload('shift-database-exact-millisecond.csv', SHIFT_HEADERS, [createValidShiftRow({
    '排班开始时间（UTC）': '2026-11-22T22:00:00Z',
    '排班结束时间（UTC）': '2026-11-23T06:00:00Z',
    来源标识: 'shift-db-exact-millisecond'
  })]);
  const exactMillisecondPreview = previewShiftScheduleImport(exactMillisecondFile, options);
  assert.strictEqual(exactMillisecondPreview.summary.skipped, 1, '等价 Z 与 .000Z 的完全重复必须 skip。');
}

/**
 * 验证设备组织、表计、状态、时间、显式 unknown、缺口与重叠规则。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 */
async function testDeviceDomainRules(db, options) {
  const invalidRows = [
    createValidDeviceRow({ 用能单元编码: 'W-001', 来源标识: 'not-equipment' }),
    createValidDeviceRow({
      用能单元编码: 'E-001',
      计量器具编码: 'M-002',
      '开始时间（UTC）': '2026-12-01T01:00:00Z',
      '结束时间（UTC）': '2026-12-01T02:00:00Z',
      来源标识: 'meter-mismatch'
    }),
    createValidDeviceRow({
      设备状态: 'fault',
      '开始时间（UTC）': '2026-12-01T02:00:00Z',
      '结束时间（UTC）': '2026-12-01T03:00:00Z',
      来源标识: 'fault-invalid'
    }),
    createValidDeviceRow({
      '开始时间（UTC）': '2026-12-01T04:00:00+08:00',
      '结束时间（UTC）': '2026-12-01T04:00:00Z',
      来源标识: 'time-invalid'
    }),
    createValidDeviceRow({
      计量器具编码: '',
      '开始时间（UTC）': '2026-12-01T05:00:00Z',
      '结束时间（UTC）': '2026-12-01T06:00:00Z',
      来源标识: 'meter-required-by-schema'
    })
  ];
  const invalidFile = writeCsvUpload('device-invalid.csv', DEVICE_HEADERS, invalidRows);
  const invalidPreview = previewDeviceStateImport(invalidFile, options);
  const invalidCodes = new Set(invalidPreview.auditIssues.map((issue) => issue.code));
  [
    'DEVICE_ORGANIZATION_TYPE_INVALID',
    'METER_ORGANIZATION_MISMATCH',
    'INVALID_DEVICE_STATE',
    'INVALID_START_UTC',
    'METER_DEVICE_REQUIRED_BY_SCHEMA'
  ].forEach((code) => assert(invalidCodes.has(code), `设备状态校验必须包含 ${code}。`));
  assert.strictEqual(invalidPreview.summary.blocked, invalidRows.length);

  const sameDatabaseSecondFile = writeCsvUpload('device-same-database-second.csv', DEVICE_HEADERS, [createValidDeviceRow({
    '开始时间（UTC）': '2026-12-05T00:00:00.100Z',
    '结束时间（UTC）': '2026-12-05T00:00:00.900Z',
    来源标识: 'device-same-database-second'
  })]);
  const beforeSameSecondCount = countRecords(db, 'device_state_records');
  const sameDatabaseSecondPreview = previewDeviceStateImport(sameDatabaseSecondFile, options);
  assert.strictEqual(sameDatabaseSecondPreview.summary.blocked, 1, '同一 Unix 整秒内的设备状态区间必须在 preview 阶段阻断。');
  assert.strictEqual(sameDatabaseSecondPreview.candidateRows.length, 0, '数据库秒级无效区间不得进入候选。');
  assert(sameDatabaseSecondPreview.auditIssues.some(
    (issue) => issue.code === 'DEVICE_STATE_INTERVAL_EMPTY_AT_DATABASE_SECOND_PRECISION'
  ));
  let sameSecondBackupCalls = 0;
  const sameSecondExecuteCode = await captureErrorCode(() => executeDeviceStateImport(
    createExecuteBody(sameDatabaseSecondPreview),
    {
      ...options,
      createBackup: async (input) => {
        sameSecondBackupCalls += 1;
        return createBackupStub()(input);
      }
    }
  ));
  assert.strictEqual(sameSecondExecuteCode, 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED');
  assert.strictEqual(sameSecondBackupCalls, 0, '无有效候选的秒级区间不得进入备份。');
  assert.strictEqual(countRecords(db, 'device_state_records'), beforeSameSecondCount, '秒级无效区间必须零业务写入。');

  const crossDatabaseSecondFile = writeCsvUpload('device-cross-database-second.csv', DEVICE_HEADERS, [createValidDeviceRow({
    '开始时间（UTC）': '2026-12-05T00:00:00.900Z',
    '结束时间（UTC）': '2026-12-05T00:00:01.100Z',
    来源标识: 'device-cross-database-second'
  })]);
  const crossDatabaseSecondPreview = previewDeviceStateImport(crossDatabaseSecondFile, options);
  assert.strictEqual(crossDatabaseSecondPreview.summary.wouldImport, 1, '跨 Unix 整秒且实际不足一秒的区间必须与 schema 一致保持可导入。');
  const crossDatabaseSecondResult = await executeDeviceStateImport(createExecuteBody(crossDatabaseSecondPreview), options);
  assert.strictEqual(crossDatabaseSecondResult.imported, 1);
  const insertedCrossSecond = db.prepare(
    `SELECT start_utc AS startUtc, end_utc AS endUtc
     FROM device_state_records WHERE source_batch_id = ?`
  ).get(crossDatabaseSecondPreview.batchId);
  assert.deepStrictEqual(insertedCrossSecond, {
    startUtc: '2026-12-05T00:00:00.900Z',
    endUtc: '2026-12-05T00:00:01.100Z'
  });

  const explicitUnknownWithGap = writeCsvUpload('device-explicit-unknown-gap.csv', DEVICE_HEADERS, [
    createValidDeviceRow({
      设备状态: 'unknown',
      '开始时间（UTC）': '2026-12-02T00:00:00Z',
      '结束时间（UTC）': '2026-12-02T01:00:00Z',
      来源标识: 'explicit-unknown'
    }),
    createValidDeviceRow({
      设备状态: 'running',
      '开始时间（UTC）': '2026-12-02T02:00:00Z',
      '结束时间（UTC）': '2026-12-02T03:00:00Z',
      来源标识: 'after-gap'
    })
  ]);
  const gapPreview = previewDeviceStateImport(explicitUnknownWithGap, options);
  assert.strictEqual(gapPreview.summary.wouldImport, 2, '显式 unknown 合法且状态缺口不阻断。');
  const beforeGapCount = countRecords(db, 'device_state_records');
  const gapResult = await executeDeviceStateImport(createExecuteBody(gapPreview), options);
  assert.strictEqual(gapResult.imported, 2);
  assert.strictEqual(countRecords(db, 'device_state_records'), beforeGapCount + 2, '一小时缺口不得自动补第三条 unknown。');
  const importedStates = db.prepare(
    `SELECT device_state AS deviceState, start_utc AS startUtc, end_utc AS endUtc
     FROM device_state_records WHERE source_batch_id = ? ORDER BY start_utc`
  ).all(gapPreview.batchId);
  assert.deepStrictEqual(importedStates, [
    { deviceState: 'unknown', startUtc: '2026-12-02T00:00:00.000Z', endUtc: '2026-12-02T01:00:00.000Z' },
    { deviceState: 'running', startUtc: '2026-12-02T02:00:00.000Z', endUtc: '2026-12-02T03:00:00.000Z' }
  ]);

  const fileOverlap = writeCsvUpload('device-file-overlap.csv', DEVICE_HEADERS, [
    createValidDeviceRow({
      设备状态: 'idle',
      '开始时间（UTC）': '2026-12-03T00:00:00Z',
      '结束时间（UTC）': '2026-12-03T02:00:00Z',
      来源标识: 'device-overlap-idle'
    }),
    createValidDeviceRow({
      设备状态: 'stopped',
      '开始时间（UTC）': '2026-12-03T01:00:00Z',
      '结束时间（UTC）': '2026-12-03T03:00:00Z',
      来源标识: 'device-overlap-stopped'
    })
  ]);
  const fileOverlapPreview = previewDeviceStateImport(fileOverlap, options);
  assert.strictEqual(fileOverlapPreview.summary.blocked, 2, '文件内同设备非完全重叠必须双向阻断。');

  const fileExact = writeCsvUpload('device-file-exact.csv', DEVICE_HEADERS, [
    createValidDeviceRow({
      设备状态: 'offline',
      '开始时间（UTC）': '2026-12-04T00:00:00Z',
      '结束时间（UTC）': '2026-12-04T01:00:00Z',
      来源标识: 'device-file-exact'
    }),
    createValidDeviceRow({
      设备状态: 'offline',
      '开始时间（UTC）': '2026-12-04T00:00:00Z',
      '结束时间（UTC）': '2026-12-04T01:00:00Z',
      来源标识: 'device-file-exact'
    })
  ]);
  const fileExactPreview = previewDeviceStateImport(fileExact, options);
  assert.strictEqual(fileExactPreview.summary.wouldImport, 1);
  assert.strictEqual(fileExactPreview.summary.skipped, 1);

  const databaseDuplicate = writeCsvUpload('device-database-duplicate.csv', DEVICE_HEADERS, [createValidDeviceRow()]);
  const databaseDuplicatePreview = previewDeviceStateImport(databaseDuplicate, options);
  assert.strictEqual(databaseDuplicatePreview.summary.skipped, 1, '数据库完全相同设备状态事实必须 skip。');
  assert(databaseDuplicatePreview.auditIssues.some((issue) => issue.code === 'DUPLICATE_DEVICE_STATE_SKIPPED'));

  const databaseOverlap = writeCsvUpload('device-database-overlap.csv', DEVICE_HEADERS, [createValidDeviceRow({
    设备状态: 'idle',
    '开始时间（UTC）': '2026-07-14T16:30:00Z',
    '结束时间（UTC）': '2026-07-14T17:30:00Z',
    来源标识: 'device-database-overlap'
  })]);
  const databaseOverlapPreview = previewDeviceStateImport(databaseOverlap, options);
  assert.strictEqual(databaseOverlapPreview.summary.blocked, 1, '数据库同设备其他重叠必须阻断。');
  assert(databaseOverlapPreview.auditIssues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE'));

  insertExistingDeviceStateRecord(db, {
    startUtc: '2026-12-20T00:00:00.500Z',
    endUtc: '2026-12-20T01:00:00.500Z',
    sourceReference: 'device-db-500ms-existing'
  });
  const millisecondOverlapFile = writeCsvUpload('device-database-500ms-overlap.csv', DEVICE_HEADERS, [createValidDeviceRow({
    设备状态: 'idle',
    '开始时间（UTC）': '2026-12-20T01:00:00Z',
    '结束时间（UTC）': '2026-12-20T02:00:00Z',
    来源标识: 'device-db-500ms-candidate'
  })]);
  const millisecondOverlapPreview = previewDeviceStateImport(millisecondOverlapFile, options);
  assert.strictEqual(millisecondOverlapPreview.summary.blocked, 1, '设备状态真实重叠 500ms 必须阻断。');

  insertExistingDeviceStateRecord(db, {
    startUtc: '2026-12-21T00:00:00.000Z',
    endUtc: '2026-12-21T01:00:00.000Z',
    sourceReference: 'device-db-adjacent-existing'
  });
  const adjacentFile = writeCsvUpload('device-database-adjacent.csv', DEVICE_HEADERS, [createValidDeviceRow({
    '开始时间（UTC）': '2026-12-21T01:00:00Z',
    '结束时间（UTC）': '2026-12-21T02:00:00Z',
    来源标识: 'device-db-adjacent-candidate'
  })]);
  const adjacentPreview = previewDeviceStateImport(adjacentFile, options);
  assert.strictEqual(adjacentPreview.summary.wouldImport, 1, '设备状态左闭右开区间刚好相邻不得误判重叠。');
  assert.strictEqual(adjacentPreview.candidateRows[0].startUtc, '2026-12-21T01:00:00.000Z');

  insertExistingDeviceStateRecord(db, {
    startUtc: '2026-12-22T00:00:00.000Z',
    endUtc: '2026-12-22T01:00:00.000Z',
    sourceReference: 'device-db-exact-millisecond'
  });
  const exactMillisecondFile = writeCsvUpload('device-database-exact-millisecond.csv', DEVICE_HEADERS, [createValidDeviceRow({
    '开始时间（UTC）': '2026-12-22T00:00:00Z',
    '结束时间（UTC）': '2026-12-22T01:00:00Z',
    来源标识: 'device-db-exact-millisecond'
  })]);
  const exactMillisecondPreview = previewDeviceStateImport(exactMillisecondFile, options);
  assert.strictEqual(exactMillisecondPreview.summary.skipped, 1, '设备状态等价 Z 与 .000Z 完全重复必须 skip。');
}

/**
 * 验证备份失败零写、事务失败回滚以及失败审计真实。
 * @param {object} db SQLite 连接。
 * @param {object} baseOptions 服务选项。
 */
async function testRollbackBoundaries(db, baseOptions) {
  const backupFailureFile = writeCsvUpload('shift-backup-failure.csv', SHIFT_HEADERS, [createValidShiftRow({
    '排班开始时间（UTC）': '2026-12-10T22:00:00Z',
    '排班结束时间（UTC）': '2026-12-11T06:00:00Z',
    来源标识: 'shift-backup-failure'
  })]);
  const backupFailurePreview = previewShiftScheduleImport(backupFailureFile, baseOptions);
  const beforeBackupFailure = countRecords(db, 'shift_schedule_records');
  const backupErrorCode = await captureErrorCode(() => executeShiftScheduleImport(
    createExecuteBody(backupFailurePreview),
    {
      ...baseOptions,
      createBackup: async () => {
        const error = new Error('备份桩失败');
        error.details = { code: 'TEST_BACKUP_FAILED' };
        throw error;
      }
    }
  ), 503);
  assert.strictEqual(backupErrorCode, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(countRecords(db, 'shift_schedule_records'), beforeBackupFailure);
  const backupFailedAudit = getImportAuditBatchDetail(backupFailurePreview.batchId, { db });
  assert.strictEqual(backupFailedAudit.status, 'failed');
  assert.notStrictEqual(backupFailedAudit.executeResult?.executed, true);

  const transactionFile = writeCsvUpload('device-transaction-rollback.csv', DEVICE_HEADERS, [
    createValidDeviceRow({
      '开始时间（UTC）': '2026-12-12T00:00:00Z',
      '结束时间（UTC）': '2026-12-12T01:00:00Z',
      来源标识: 'device-transaction:1'
    }),
    createValidDeviceRow({
      '开始时间（UTC）': '2026-12-12T01:00:00Z',
      '结束时间（UTC）': '2026-12-12T02:00:00Z',
      来源标识: 'device-transaction:2'
    })
  ]);
  const transactionPreview = previewDeviceStateImport(transactionFile, baseOptions);
  const beforeTransaction = countRecords(db, 'device_state_records');
  const transactionErrorCode = await captureErrorCode(() => executeDeviceStateImport(
    createExecuteBody(transactionPreview),
    {
      ...baseOptions,
      createBackup: createBackupStub(),
      afterInsertCandidate: ({ index }) => {
        if (index === 0) {
          const error = new Error('事务中途失败');
          error.details = { code: 'TEST_TRANSACTION_FAILED' };
          throw error;
        }
      }
    }
  ), 500);
  assert.strictEqual(transactionErrorCode, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countRecords(db, 'device_state_records'), beforeTransaction, '事务中途失败必须回滚首条插入。');
  const transactionAudit = getImportAuditBatchDetail(transactionPreview.batchId, { db });
  assert.strictEqual(transactionAudit.status, 'failed');
  assert.notStrictEqual(transactionAudit.executeResult?.executed, true, '事务失败审计不得虚假标记成功。');
}

(async () => {
  let db = null;
  try {
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    initDatabase();
    db = openDatabase();
    seedMasterData(db);
    const baseOptions = { db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub() };

    await testPreviewAndExecute(db, baseOptions);
    testCsvHeaderSafety(baseOptions);
    await testAuthorizationAndDescriptorBinding(db, baseOptions);
    testShiftDomainRules(db, baseOptions);
    await testDeviceDomainRules(db, baseOptions);
    await testRollbackBoundaries(db, baseOptions);

    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
    console.log('energy operations import service tests passed');
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
