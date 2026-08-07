'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

// 测试数据库、上传目录和所有原文件均隔离到系统临时目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-timeseries-import-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-timeseries-import.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-timeseries-import-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { createBackup, validateBackupFile } = require('../services/backupService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { listImportBatches } = require('../services/importService');
const {
  executeEnergyTimeseriesImport,
  previewEnergyTimeseriesImport
} = require('../services/energyTimeseriesImportService');

// 冻结模板的中文列顺序。
const TIMESERIES_HEADERS = Object.freeze([
  '能源类型编码',
  '用能单元编码',
  '计量器具编码',
  '开始时间（UTC）',
  '结束时间（UTC）',
  '来源时区',
  '粒度（分钟）',
  '原始单位',
  '原始值',
  '来源标识',
  '数据来源'
]);

/**
 * 创建合法时序 CSV 行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 中文标题数据行。
 */
function createValidRow(overrides = {}) {
  return {
    能源类型编码: 'electricity',
    用能单元编码: 'OU-001',
    计量器具编码: 'M-001',
    '开始时间（UTC）': '2026-07-14T16:00:00Z',
    '结束时间（UTC）': '2026-07-14T16:15:00Z',
    来源时区: 'Asia/Shanghai',
    '粒度（分钟）': 15,
    原始单位: 'kWh',
    原始值: 25.5,
    来源标识: 'upload:timeseries:001',
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
 * @param {object[]} rows 中文标题数据行。
 * @param {string[]} extraHeaders 可选附加标题。
 * @returns {object} Multer 文件对象。
 */
function writeCsvUpload(storedFilename, rows, extraHeaders = []) {
  const headers = [...TIMESERIES_HEADERS, ...extraHeaders];
  const content = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))
  ].join('\n');
  const buffer = Buffer.from(`﻿${content}\n`, 'utf8');
  const filePath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.writeFileSync(filePath, buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/**
 * 写入表头后含空白物理行的 CSV 原文件。
 * @param {string} storedFilename 保存文件名。
 * @param {object} row 数据行。
 * @returns {object} Multer 文件对象。
 */
function writeCsvUploadWithBlankLines(storedFilename, row) {
  const headerText = TIMESERIES_HEADERS.map(escapeCsvCell).join(',');
  const rowText = TIMESERIES_HEADERS.map((header) => escapeCsvCell(row[header])).join(',');
  const buffer = Buffer.from(`﻿${headerText}\n\n\n${rowText}\n`, 'utf8');
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), buffer);
  return { originalname: storedFilename, filename: storedFilename, size: buffer.length };
}

/**
 * 写入包含空白物理行的 XLSX 原文件。
 * @param {string} storedFilename 保存文件名。
 * @param {object} row 数据行。
 * @returns {object} Multer 文件对象。
 */
function writeXlsxUpload(storedFilename, row) {
  const workbook = XLSX.utils.book_new();
  const headers = [...TIMESERIES_HEADERS, '备注扩展列'];
  const values = headers.map((header) => row[header] ?? (header === '备注扩展列' ? '仅产生 warning' : ''));
  const worksheet = XLSX.utils.aoa_to_sheet([headers, [], [], values]);
  XLSX.utils.book_append_sheet(workbook, worksheet, '能耗时序');
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
    confirmText: '确认导入时序能耗记录',
    backupReason: 'energy-analysis-import',
    duplicateStrategy: 'skip',
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows
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
 * 统计时序业务记录。
 * @param {object} db SQLite 连接。
 * @returns {number} 记录数。
 */
function countTimeseriesRecords(db) {
  return db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total;
}

/**
 * 断言审计或列表序列化结果不包含路径、UNC、secret 或 token 片段。
 * @param {*} value 待检查值。
 * @param {string} label 断言标签。
 */
function assertNoSensitiveFragments(value, label) {
  const serialized = JSON.stringify(value).replace(/\\\\/g, '\\');
  [
    'C:\\private',
    '/var/private',
    '\\\\server\\share',
    'secret-token',
    'token=super-secret',
    'super-secret-value'
  ].forEach((fragment) => {
    assert(!serialized.includes(fragment), `${label} 不得包含敏感片段 ${fragment}。`);
  });
}

/**
 * 初始化组织和表计主数据。
 * @param {object} db SQLite 连接。
 */
function seedMasterData(db) {
  const organizationResult = db.prepare(
    `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('OU-001', '一号车间', '/OU-001', 'workshop', 'active')`
  ).run();
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  db.prepare(
    `INSERT INTO meter_devices (
       meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status
     ) VALUES ('M-001', '一号电表', 'electricity', ?, ?, 'active')`
  ).run(electricity.id, organizationResult.lastInsertRowid);
}

/**
 * 验证 preview、合法 execute、来源追溯和成功审计。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 */
async function testPreviewAndExecute(db, options) {
  const file = writeXlsxUpload('valid-physical-row.xlsx', createValidRow());
  const beforeCount = countTimeseriesRecords(db);
  const preview = previewEnergyTimeseriesImport(file, options);
  assert.strictEqual(countTimeseriesRecords(db), beforeCount, 'preview 不得写业务事实表。');
  assert.strictEqual(preview.summary.wouldImport, 1);
  assert.strictEqual(preview.candidateRows[0].sourceRowNumber, 4, 'XLSX 中间空白行后必须保留真实物理行号。');
  assert.strictEqual(preview.auditBatch.importType, 'energy_timeseries');
  assert.strictEqual(preview.auditBatch.auditPhase, 'preview');
  const previewAudit = getImportAuditBatchDetail(preview.batchId, { db });
  assert.strictEqual(previewAudit.issueCounts.warning, 1, '未知扩展标题 warning 必须进入 preview issues。');
  assert.strictEqual(previewAudit.issueCounts.error, 0);

  const result = await executeEnergyTimeseriesImport(createExecuteBody(preview), options);
  assert.strictEqual(result.imported, 1);
  const inserted = db.prepare(
    `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
            record_status AS recordStatus
     FROM energy_timeseries_records`
  ).get();
  assert.strictEqual(inserted.sourceBatchId, preview.batchId);
  assert.strictEqual(inserted.sourceRowNumber, 4);
  assert.strictEqual(inserted.recordStatus, 'active');
  const executeAudit = getImportAuditBatchDetail(preview.batchId, { db });
  assert.strictEqual(executeAudit.auditPhase, 'execute');
  assert.strictEqual(executeAudit.status, 'completed');
  assert.strictEqual(executeAudit.backup.reason, 'energy-analysis-import');
  assert.strictEqual(executeAudit.executeResult.imported, 1);
  assert.strictEqual(executeAudit.executeResult.previewSignature, preview.previewSignature);
  assert.strictEqual(executeAudit.executeResult.previewAuditDigest, preview.previewAuditDigest);
  assert.deepStrictEqual(executeAudit.executeResult.candidateRowIds, preview.candidateRowIds);
  assert(!JSON.stringify(executeAudit.executeResult).includes(tmpDir), 'execute 审计不得泄漏本机临时目录绝对路径。');

  const csvFile = writeCsvUploadWithBlankLines('valid-csv-physical-row.csv', createValidRow({
    '开始时间（UTC）': '2026-08-01T00:00:00Z',
    '结束时间（UTC）': '2026-08-01T00:15:00Z',
    来源标识: 'csv-physical-row'
  }));
  const csvPreview = previewEnergyTimeseriesImport(csvFile, options);
  assert.strictEqual(csvPreview.candidateRows[0].sourceRowNumber, 4, 'CSV 空白行后也必须保留真实物理起始行号。');
}

/**
 * 验证 BEGIN IMMEDIATE 锁内真实备份覆盖锁前提交且排除本次未提交导入。
 * @param {object} db execute 专用写连接。
 * @param {object} baseOptions 基础服务选项。
 */
async function testLockedBackupEpoch(db, baseOptions) {
  const preLockConnection = openDatabase();
  try {
    preLockConnection.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES ('timeseries_lock_precommit', 'included-in-backup', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run();
  } finally {
    preLockConnection.close();
  }

  const file = writeCsvUpload('locked-backup-epoch.csv', [createValidRow({
    '开始时间（UTC）': '2026-08-02T00:00:00Z',
    '结束时间（UTC）': '2026-08-02T00:15:00Z',
    来源标识: 'locked-backup-epoch'
  })]);
  const preview = previewEnergyTimeseriesImport(file, baseOptions);
  let competingWriteCode = null;
  const result = await executeEnergyTimeseriesImport(createExecuteBody(preview), {
    ...baseOptions,
    createBackup: async (input) => {
      assert.strictEqual(db.inTransaction, true, '创建备份时 execute 写连接必须仍持有 BEGIN IMMEDIATE 事务。');
      assert.strictEqual(input.skipCheckpoint, true, '锁内备份必须跳过会冲突的 checkpoint。');
      const competingConnection = openDatabase();
      try {
        competingConnection.pragma('busy_timeout = 20');
        competingConnection.prepare(
          `INSERT INTO app_meta (key, value, updated_at)
           VALUES ('timeseries_lock_competing', 'must-not-commit-during-lock', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
        ).run();
      } catch (error) {
        competingWriteCode = error.code;
      } finally {
        competingConnection.close();
      }
      return createBackup(input);
    }
  });
  assert.strictEqual(competingWriteCode, 'SQLITE_BUSY', '第二写连接在 RESERVED 锁期间必须等待失败或安全失败。');
  assert.strictEqual(result.imported, 1);

  const backupPath = path.join(process.env.BACKUPS_DIR, result.backup.backupName);
  const validation = validateBackupFile(backupPath);
  assert.strictEqual(validation.quickCheck, 'ok');
  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assert.strictEqual(
      backupDb.prepare("SELECT value FROM app_meta WHERE key = 'timeseries_lock_precommit'").get().value,
      'included-in-backup',
      '锁前已提交数据必须进入备份。'
    );
    assert.strictEqual(
      backupDb.prepare("SELECT COUNT(*) AS total FROM energy_timeseries_records WHERE source_reference = 'locked-backup-epoch'").get().total,
      0,
      '本次尚未提交的导入不得进入导入前备份。'
    );
    assert.strictEqual(
      backupDb.prepare("SELECT COUNT(*) AS total FROM app_meta WHERE key = 'timeseries_lock_competing'").get().total,
      0,
      '锁期间失败的并发写不得进入备份。'
    );
  } finally {
    backupDb.close();
  }
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS total FROM energy_timeseries_records WHERE source_reference = 'locked-backup-epoch'").get().total,
    1,
    '成功提交后当前库必须包含本次导入。'
  );

  const retryConnection = openDatabase();
  try {
    retryConnection.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES ('timeseries_lock_competing', 'committed-after-lock', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run();
  } finally {
    retryConnection.close();
  }
  assert.strictEqual(
    db.prepare("SELECT value FROM app_meta WHERE key = 'timeseries_lock_competing'").get().value,
    'committed-after-lock',
    '锁释放后并发写重试必须能够提交。'
  );
}

/**
 * 验证客户端完整性见证、固定确认和持久化批次状态全部参与授权。
 * @param {object} db SQLite 连接。
 * @param {object} baseOptions 服务选项。
 */
async function testAuthorizationRejections(db, baseOptions) {
  const cases = [
    {
      name: '文件 SHA',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH',
      mutate: ({ body }) => { body.fileSha256 = '0'.repeat(64); }
    },
    {
      name: 'preview 签名',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID',
      mutate: ({ body }) => { body.previewSignature = 'hmac-sha256:v1:' + '0'.repeat(64); }
    },
    {
      name: '审计摘要',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID',
      mutate: ({ body }) => { body.previewAuditDigest = 'hmac-sha256:v1:audit:' + '0'.repeat(64); }
    },
    {
      name: '候选见证',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
      mutate: ({ body }) => { body.candidateRows[0].originalValue = 999999; }
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
      name: 'stale 状态',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID',
      mutate: ({ preview }) => { db.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(preview.batchId); }
    },
    {
      name: 'stale phase',
      expectedCode: 'ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH',
      mutate: ({ preview }) => { db.prepare("UPDATE import_batches SET audit_phase = 'execute' WHERE id = ?").run(preview.batchId); }
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const day = 20 + index;
    const start = `2026-07-${String(day).padStart(2, '0')}T00:00:00Z`;
    const end = `2026-07-${String(day).padStart(2, '0')}T00:15:00Z`;
    const file = writeCsvUpload(`reject-${index}.csv`, [createValidRow({
      '开始时间（UTC）': start,
      '结束时间（UTC）': end,
      来源标识: `reject:${index}`
    })]);
    const preview = previewEnergyTimeseriesImport(file, baseOptions);
    const body = createExecuteBody(preview);
    const forgedRows = body.candidateRows.map((row) => ({ ...row }));
    body.candidateRows = forgedRows;
    let backupCalls = 0;
    const options = {
      ...baseOptions,
      createBackup: async (input) => {
        backupCalls += 1;
        return createBackupStub()(input);
      }
    };
    testCase.mutate({ body, preview });
    const beforeCount = countTimeseriesRecords(db);
    const errorCode = await captureErrorCode(() => executeEnergyTimeseriesImport(body, options));
    assert.strictEqual(errorCode, testCase.expectedCode, `${testCase.name} 必须返回预期稳定错误码。`);
    assert.strictEqual(countTimeseriesRecords(db), beforeCount, `${testCase.name} 失配必须零业务写入。`);
    assert.strictEqual(backupCalls, 0, `${testCase.name} 失配不得进入备份。`);
    if (index <= 6) {
      const unchangedAudit = getImportAuditBatchDetail(preview.batchId, { db });
      assert.strictEqual(unchangedAudit.auditPhase, 'preview', `${testCase.name} 在请求信任建立前不得污染合法 preview 批次。`);
      assert.strictEqual(unchangedAudit.status, preview.auditBatch.status, `${testCase.name} 在请求信任建立前不得改写批次状态。`);
      assert.strictEqual(unchangedAudit.executeResult, null, `${testCase.name} 在请求信任建立前不得写失败 execute 审计。`);
      assertNoSensitiveFragments(unchangedAudit, `${testCase.name} 未污染批次详情`);
    }
  }
}

/**
 * 验证数据库重复、文件内/数据库内重叠以及不同原始单位的数据流边界。
 * @param {object} db SQLite 连接。
 * @param {object} options 服务选项。
 */
function testDuplicateAndOverlapRules(db, options) {
  const duplicateFile = writeCsvUpload('exact-duplicate.csv', [createValidRow()]);
  const duplicatePreview = previewEnergyTimeseriesImport(duplicateFile, options);
  assert.strictEqual(duplicatePreview.summary.skipped, 1);
  assert(duplicatePreview.items[0].issues.some((issue) => issue.code === 'DUPLICATE_TIMESERIES_RECORD_SKIPPED'));

  const inputOverlapFile = writeCsvUpload('input-overlap.csv', [
    createValidRow({
      '开始时间（UTC）': '2026-07-16T00:00:00Z',
      '结束时间（UTC）': '2026-07-16T00:15:00Z',
      来源标识: 'input-overlap:1'
    }),
    createValidRow({
      '开始时间（UTC）': '2026-07-16T00:05:00Z',
      '结束时间（UTC）': '2026-07-16T00:20:00Z',
      来源标识: 'input-overlap:2'
    })
  ]);
  const inputOverlapPreview = previewEnergyTimeseriesImport(inputOverlapFile, options);
  assert.strictEqual(inputOverlapPreview.summary.blocked, 2, '文件内重叠双方都必须阻断。');
  assert(inputOverlapPreview.items.every((item) => item.issues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE')));

  const databaseOverlapFile = writeCsvUpload('database-overlap.csv', [createValidRow({
    '开始时间（UTC）': '2026-07-14T16:05:00Z',
    '结束时间（UTC）': '2026-07-14T16:20:00Z',
    来源标识: 'database-overlap'
  })]);
  const databaseOverlapPreview = previewEnergyTimeseriesImport(databaseOverlapFile, options);
  assert.strictEqual(databaseOverlapPreview.summary.blocked, 1);
  assert(databaseOverlapPreview.items[0].issues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE'));

  const differentUnitFile = writeCsvUpload('different-unit.csv', [createValidRow({
    原始单位: 'MWh',
    原始值: 0.0255,
    来源标识: 'different-unit'
  })]);
  const differentUnitPreview = previewEnergyTimeseriesImport(differentUnitFile, options);
  assert.strictEqual(differentUnitPreview.summary.wouldImport, 1, '不同原始单位不得直接判定为同一数据流。');
}

/**
 * 验证主数据、UTC、时区、粒度、值和单位错误均形成行级阻断。
 * @param {object} options 服务选项。
 */
function testRowValidation(options) {
  const rows = [
    createValidRow({ 用能单元编码: 'OU-NOT-FOUND', 来源标识: 'invalid-org' }),
    createValidRow({ 能源类型编码: 'not_found', 来源标识: 'invalid-energy' }),
    createValidRow({ 计量器具编码: 'M-NOT-FOUND', 来源标识: 'invalid-meter' }),
    createValidRow({ '开始时间（UTC）': '2026-07-14T16:00:00+08:00', 来源标识: 'invalid-utc' }),
    createValidRow({ 来源时区: 'Mars/Base', 来源标识: 'invalid-timezone' }),
    createValidRow({ '粒度（分钟）': 20, 来源标识: 'invalid-granularity' }),
    createValidRow({ 原始值: -1, 来源标识: 'invalid-value' }),
    createValidRow({ 原始单位: 'GJ', 来源标识: 'invalid-unit' })
  ].map((row, index) => ({
    ...row,
    '开始时间（UTC）': row['开始时间（UTC）'] === '2026-07-14T16:00:00Z'
      ? `2026-07-17T${String(index).padStart(2, '0')}:00:00Z`
      : row['开始时间（UTC）'],
    '结束时间（UTC）': `2026-07-17T${String(index).padStart(2, '0')}:15:00Z`
  }));
  const file = writeCsvUpload('invalid-rows.csv', rows);
  const preview = previewEnergyTimeseriesImport(file, options);
  const codes = new Set(preview.auditIssues.map((issue) => issue.code));
  [
    'ORGANIZATION_UNIT_NOT_FOUND',
    'ENERGY_TYPE_NOT_FOUND',
    'METER_DEVICE_NOT_FOUND',
    'INVALID_START_UTC',
    'INVALID_SOURCE_TIME_ZONE',
    'UNSUPPORTED_GRANULARITY_MINUTES',
    'INVALID_ORIGINAL_VALUE',
    'UNSUPPORTED_UNIT'
  ].forEach((code) => assert(codes.has(code), `行级校验必须包含 ${code}。`));
  assert.strictEqual(preview.summary.blocked, rows.length);
}

/**
 * 验证备份失败和事务中途失败均不留下业务事实，且审计不虚假成功。
 * @param {object} db SQLite 连接。
 * @param {object} baseOptions 服务选项。
 */
async function testRollbackBoundaries(db, baseOptions) {
  const backupFailureFile = writeCsvUpload('backup-failure.csv', [createValidRow({
    '开始时间（UTC）': '2026-07-18T00:00:00Z',
    '结束时间（UTC）': '2026-07-18T00:15:00Z',
    来源标识: 'backup-failure'
  })]);
  const backupFailurePreview = previewEnergyTimeseriesImport(backupFailureFile, baseOptions);
  const beforeBackupFailure = countTimeseriesRecords(db);
  const backupErrorCode = await captureErrorCode(() => executeEnergyTimeseriesImport(
    createExecuteBody(backupFailurePreview),
    {
      ...baseOptions,
      createBackup: async () => {
        const error = new Error('备份失败 C:\\private\\secret-token.sqlite /var/private/secret-token.sqlite \\\\server\\share\\secret-token.sqlite token=super-secret');
        error.details = { code: 'TEST_BACKUP_FAILED', secret: 'super-secret-value' };
        throw error;
      }
    }
  ), 503);
  assert.strictEqual(backupErrorCode, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(countTimeseriesRecords(db), beforeBackupFailure);
  const backupFailureAudit = getImportAuditBatchDetail(backupFailurePreview.batchId, { db });
  assert.strictEqual(backupFailureAudit.status, 'failed');
  assert.strictEqual(backupFailureAudit.executeResult.errorCode, 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED');
  assert.strictEqual(backupFailureAudit.errorSummary, '能源分析导入备份失败，未写入业务数据。');
  assertNoSensitiveFragments(backupFailureAudit, '备份失败批次详情');
  const backupFailureListRow = listImportBatches({ importType: 'energy_timeseries', pageSize: 100 }).rows
    .find((row) => row.id === backupFailurePreview.batchId);
  assert(backupFailureListRow, '中央批次列表必须返回备份失败批次。');
  assertNoSensitiveFragments(backupFailureListRow, '备份失败批次列表');

  const transactionFile = writeCsvUpload('transaction-rollback.csv', [
    createValidRow({
      '开始时间（UTC）': '2026-07-19T00:00:00Z',
      '结束时间（UTC）': '2026-07-19T00:15:00Z',
      来源标识: 'transaction:1'
    }),
    createValidRow({
      '开始时间（UTC）': '2026-07-19T00:15:00Z',
      '结束时间（UTC）': '2026-07-19T00:30:00Z',
      来源标识: 'transaction:2'
    })
  ]);
  const transactionPreview = previewEnergyTimeseriesImport(transactionFile, baseOptions);
  const beforeTransaction = countTimeseriesRecords(db);
  const transactionErrorCode = await captureErrorCode(() => executeEnergyTimeseriesImport(
    createExecuteBody(transactionPreview),
    {
      ...baseOptions,
      createBackup: createBackupStub(),
      afterInsertCandidate: ({ index }) => {
        if (index === 0) {
          const error = new Error('事务失败 C:\\private\\secret-token.sqlite /var/private/secret-token.sqlite \\\\server\\share\\secret-token.sqlite token=super-secret');
          error.details = { code: 'TEST_TRANSACTION_FAILED', secret: 'super-secret-value' };
          throw error;
        }
      }
    }
  ), 500);
  assert.strictEqual(transactionErrorCode, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(countTimeseriesRecords(db), beforeTransaction, '事务中途失败必须回滚首条插入。');
  const failedAudit = getImportAuditBatchDetail(transactionPreview.batchId, { db });
  assert.strictEqual(failedAudit.status, 'failed');
  assert.strictEqual(failedAudit.executeResult.errorCode, 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED');
  assert.strictEqual(failedAudit.errorSummary, '能源分析导入事务失败，业务数据已回滚。');
  assert.notStrictEqual(failedAudit.executeResult?.executed, true, '事务失败审计不得虚假标记成功。');
  assertNoSensitiveFragments(failedAudit, '事务失败批次详情');
  const transactionFailureListRow = listImportBatches({ importType: 'energy_timeseries', pageSize: 100 }).rows
    .find((row) => row.id === transactionPreview.batchId);
  assert(transactionFailureListRow, '中央批次列表必须返回事务失败批次。');
  assertNoSensitiveFragments(transactionFailureListRow, '事务失败批次列表');
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
    await testLockedBackupEpoch(db, baseOptions);
    await testAuthorizationRejections(db, baseOptions);
    testDuplicateAndOverlapRules(db, baseOptions);
    testRowValidation(baseOptions);
    await testRollbackBoundaries(db, baseOptions);

    const foreignKeyViolations = db.pragma('foreign_key_check');
    assert.deepStrictEqual(foreignKeyViolations, [], 'PRAGMA foreign_key_check 必须为空。');
    console.log('energy timeseries import service tests passed');
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
