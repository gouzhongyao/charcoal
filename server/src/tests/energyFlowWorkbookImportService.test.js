'use strict';

const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 本测试只使用系统临时目录、隔离 SQLite、隔离上传目录和备份桩。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-workbook-'));
const databasePath = path.join(temporaryRoot, 'energy-flow-workbook.sqlite');
const uploadsDir = path.join(temporaryRoot, 'uploads');
const backupsDir = path.join(temporaryRoot, 'backups');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = databasePath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.BACKUPS_DIR = backupsDir;
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowWorkbook123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-flow-workbook-test-secret-2026';
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const { initDatabase, openDatabase } = require('../db/database');
const {
  ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
  ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS,
  ENERGY_FLOW_WORKBOOK_SHEETS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION
} = require('../services/energyFlowWorkbookContracts');
const {
  buildWorkbookDomainPreview,
  executeEnergyFlowWorkbookImport,
  parseEnergyFlowWorkbookXlsx,
  previewEnergyFlowWorkbookImport,
  validateEnergyFlowWorkbookXlsxArchive
} = require('../services/energyFlowWorkbookImportService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { normalizeError } = require('../utils/errors');

// canonical 九表是本工作簿唯一允许写入的领域事实。
const CANONICAL_TABLES = Object.freeze([
  'energy_flow_models',
  'energy_flow_assets',
  'energy_flow_paths',
  'energy_flow_nodes',
  'energy_flow_edges',
  'energy_flow_records',
  'energy_flow_waste_heat_facts',
  'energy_flow_loss_facts',
  'energy_flow_loss_evidence'
]);

// N8-A2 执行前后必须保持不变的跨领域事实表。
const PROTECTED_TABLES = Object.freeze([
  'energy_records',
  'generation_records',
  'carbon_activity_records',
  'carbon_emissions',
  'carbon_calculation_runs',
  'carbon_accounting_results',
  'carbon_emission_reports',
  'ghg_reports'
]);

// 测试 ZIP 生成器使用的 CRC32 查找表。
const TEST_CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, tableIndex) => {
  let crc = tableIndex;
  for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
}));

/** 深拷贝工作簿二维数据，防止测试案例互相污染。 */
function cloneRows(rows) {
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.map((row) => [...row])]));
}

/** 构造一份覆盖 canonical 九表的合法六表业务数据。 */
function buildWorkbookRows(modelCode) {
  return {
    models: [[
      ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
      ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION,
      modelCode,
      `模型 ${modelCode}`,
      '隔离服务测试来源',
      `DOC-${modelCode}`,
      'v1',
      '2026-01-01T00:00',
      '2027-01-01T00:00',
      'Asia/Shanghai',
      'workbook_facts',
      'workbook_facts_only',
      'active'
    ]],
    assetsNodes: [
      ['asset', modelCode, 'ASSET-01', '一号设备', 'production_device', '', '', '', '', '', '', '', '', 'active'],
      ['node', modelCode, '', '', '', 'NODE-IN', '入口节点', 'source', 'ASSET-01', 'plant_entry', '', 0, 0, 'active'],
      ['node', modelCode, '', '', '', 'NODE-OUT', '出口节点', 'sink', 'ASSET-01', 'useful_output', '', 100, 0, 'active']
    ],
    edges: [[
      modelCode, 'PATH-01', '主路径', 1, 'EDGE-01', 'NODE-IN', 'NODE-OUT',
      'electricity', 'kWh', 'workbook_fact', 'edge:01', 'active'
    ]],
    records: [
      ['REC-WASTE', modelCode, 'edge_flow', 'EDGE-01', '', 'PATH-01', 'ASSET-01', 'waste_heat', '2026-07-01T00:00', '2026-07-01T01:00', 'Asia/Shanghai', 'electricity', 10, 'kWh', 'record:waste'],
      ['REC-LOSS', modelCode, 'edge_flow', 'EDGE-01', '', 'PATH-01', 'ASSET-01', 'loss', '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', 'electricity', 1, 'kWh', 'record:loss']
    ],
    wasteHeat: [[
      'WASTE-01', modelCode, 'REC-WASTE', 'generation', 'waste:01', 'active'
    ]],
    lossEvidence: [
      ['loss_fact', modelCode, 'LOSS-01', 'REC-LOSS', 'device_loss', '', '', '', '', '', '', '', '', '', '', 'active', ''],
      ['evidence', modelCode, 'LOSS-01', '', '', 'EVIDENCE-01', 'fact_evidence', '损耗计量证据', 'meter_record', 'evidence:01', '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', '', '', 'active', '']
    ]
  };
}

/** 生成真实 SheetJS XLSX，并允许修改二维数据或工作表元数据。 */
function buildWorkbookBuffer(modelCode, options = {}) {
  const workbook = XLSX.utils.book_new();
  const rows = cloneRows(buildWorkbookRows(modelCode));
  if (typeof options.mutateRows === 'function') options.mutateRows(rows);
  ENERGY_FLOW_WORKBOOK_SHEETS.forEach((contract, sheetIndex) => {
    const worksheet = XLSX.utils.aoa_to_sheet([contract.headers, ...(rows[contract.key] || [])]);
    if (typeof options.mutateWorksheet === 'function') {
      options.mutateWorksheet({ workbook, worksheet, contract, sheetIndex });
    }
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      options.sheetNames?.[sheetIndex] || contract.name
    );
  });
  if (options.hiddenSheetIndex !== undefined) {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = workbook.SheetNames.map((name, index) => ({
      name,
      Hidden: index === options.hiddenSheetIndex ? (options.hiddenValue ?? 1) : 0
    }));
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 计算测试 ZIP 条目实际内容的 CRC32。 */
function calculateTestCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = TEST_CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造低报声明大小的 deflate ZIP，用于实际解压资源门禁测试。 */
function buildSyntheticDeflateZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  entries.forEach(({ name, payload, declaredSize = 1 }) => {
    const filename = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(payload);
    const crc32 = calculateTestCrc32(payload);
    const local = Buffer.alloc(30 + filename.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    filename.copy(local, 30);
    compressed.copy(local, 30 + filename.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    filename.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  });
  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localData, centralDirectory, end]);
}

/** 定位 ZIP EOCD。 */
function findZipEndOffset(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error('测试 XLSX 缺少 EOCD。');
}

/** 读取中央目录测试元数据。 */
function readZipCentralEntries(buffer, endOffset = findZipEndOffset(buffer)) {
  const entries = [];
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const count = buffer.readUInt16LE(endOffset + 10);
  for (let index = 0; index < count; index += 1) {
    assert.strictEqual(buffer.readUInt32LE(cursor), 0x02014b50);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    entries.push({
      offset: cursor,
      filenameStart: cursor + 46,
      filenameLength: fileNameLength,
      name: buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8'),
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize,
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset,
      localDataStart: localOffset + 30 + localNameLength + localExtraLength,
      localDataEnd: localOffset + 30 + localNameLength + localExtraLength + compressedSize
    });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

/** 克隆并定点篡改 ZIP。 */
function mutateXlsxArchive(buffer, mutator) {
  const clone = Buffer.from(buffer);
  const endOffset = findZipEndOffset(clone);
  const entries = readZipCentralEntries(clone, endOffset);
  mutator(clone, endOffset, entries);
  return clone;
}

/** 为最后一个本地条目添加标准 data descriptor。 */
function addDataDescriptor(buffer, corrupt = false) {
  const endOffset = findZipEndOffset(buffer);
  const entries = readZipCentralEntries(buffer, endOffset);
  const target = [...entries].sort((left, right) => right.localOffset - left.localOffset)[0];
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  assert.strictEqual(target.localDataEnd, centralOffset, '最后一个本地条目必须紧邻中央目录。');
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(corrupt ? ((target.crc32 + 1) >>> 0) : target.crc32, 4);
  descriptor.writeUInt32LE(target.compressedSize, 8);
  descriptor.writeUInt32LE(target.uncompressedSize, 12);
  const next = Buffer.concat([
    buffer.subarray(0, centralOffset),
    descriptor,
    buffer.subarray(centralOffset)
  ]);
  const nextEnd = endOffset + descriptor.length;
  next.writeUInt32LE(centralOffset + descriptor.length, nextEnd + 16);
  const nextEntries = readZipCentralEntries(next, nextEnd);
  const nextTarget = nextEntries.find((entry) => entry.localOffset === target.localOffset);
  next.writeUInt16LE(target.flags | 0x0008, target.localOffset + 6);
  next.writeUInt32LE(0, target.localOffset + 14);
  next.writeUInt32LE(0, target.localOffset + 18);
  next.writeUInt32LE(0, target.localOffset + 22);
  next.writeUInt16LE(nextTarget.flags | 0x0008, nextTarget.offset + 8);
  return next;
}

/** 将 Buffer 落入隔离上传目录并返回 Multer 形状。 */
function storeUpload(storedFilename, buffer, originalname = '完整能流工作簿.xlsx') {
  const filePath = path.join(uploadsDir, storedFilename);
  fs.writeFileSync(filePath, buffer);
  return {
    path: filePath,
    filename: storedFilename,
    originalname,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length
  };
}

/** 创建隔离数据库连接。 */
function openTestDatabase() {
  return openDatabase({ databasePath });
}

/** 构造工作簿服务依赖。 */
function buildServiceOptions(overrides = {}) {
  return {
    uploadsDir,
    openDatabase: openTestDatabase,
    env: { ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET },
    actorUserId: 1,
    actorIp: '127.0.0.1',
    createBackup: async () => ({
      backupName: 'stub.sqlite',
      reason: 'energy-flow-workbook-import',
      method: 'test-stub',
      sizeBytes: 1,
      createdAt: '2026-08-26T00:00:00Z'
    }),
    ...overrides
  };
}

/** 查询表行数。 */
function countRows(tableName) {
  const db = openTestDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
  } finally {
    db.close();
  }
}

/** 查询指定工作簿批次写入的表行数。 */
function countBatchRows(tableName, batchId) {
  const db = openTestDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName} WHERE source_batch_id = ?`).get(batchId).total || 0);
  } finally {
    db.close();
  }
}

/** 快照跨领域事实行数。 */
function snapshotProtectedTables() {
  return Object.fromEntries(PROTECTED_TABLES.map((tableName) => [tableName, countRows(tableName)]));
}

/** 断言同步错误码与状态。 */
function assertWorkbookError(action, expectedCode, expectedStatus = null) {
  assert.throws(action, (error) => (
    (error?.code === expectedCode || error?.details?.code === expectedCode)
      && (expectedStatus === null || error.statusCode === expectedStatus)
  ));
}

/** 断言异步错误码；非应用异常按统一 HTTP 错误合同归一为 INTERNAL_ERROR。 */
async function assertAsyncCode(action, expectedCodes, expectedStatus = null) {
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  await assert.rejects(action, (error) => {
    const normalized = normalizeError(error);
    const matchesCode = codes.includes(error?.code)
      || codes.includes(error?.details?.code)
      || codes.includes(normalized.code)
      || codes.includes(normalized.details?.code);
    const actualStatus = error?.statusCode || normalized.statusCode;
    return matchesCode && (expectedStatus === null || actualStatus === expectedStatus);
  });
}

/** 断言资源失败不新增批次、问题或 canonical 九表事实。 */
async function assertResourcePreviewRejected(storedFilename, buffer, expectedCode) {
  const batchCount = countRows('import_batches');
  const issueCount = countRows('import_errors');
  const canonicalCounts = Object.fromEntries(
    CANONICAL_TABLES.map((tableName) => [tableName, countRows(tableName)])
  );
  const upload = storeUpload(storedFilename, buffer);
  await assertAsyncCode(
    async () => previewEnergyFlowWorkbookImport(upload, buildServiceOptions()),
    expectedCode,
    413
  );
  assert.strictEqual(countRows('import_batches'), batchCount);
  assert.strictEqual(countRows('import_errors'), issueCount);
  CANONICAL_TABLES.forEach((tableName) => {
    assert.strictEqual(countRows(tableName), canonicalCounts[tableName]);
  });
}

/** 从真实 XLSX 构建领域预演。 */
function buildDomainPreview(modelCode, options = {}) {
  const buffer = buildWorkbookBuffer(modelCode, options);
  const parsed = parseEnergyFlowWorkbookXlsx(buffer, `${modelCode}.xlsx`);
  const db = openTestDatabase();
  try {
    return buildWorkbookDomainPreview(db, parsed);
  } finally {
    db.close();
  }
}

/** 返回问题码集合。 */
function issueCodes(preview) {
  return new Set((preview.issues || []).map((issue) => issue.code));
}

/** 插入同身份 legacy 模型制造数据库 stale。 */
function insertCollidingModel(modelCode) {
  const db = openTestDatabase();
  try {
    db.prepare(`INSERT INTO energy_flow_models (
      model_code, model_name, source, version, effective_start_utc, effective_end_utc,
      source_timezone, classification_status, source_mode, status
    ) VALUES (?, '并发冲突模型', '隔离测试', 'v1', '2026-01-01T00:00:00Z',
      '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'legacy_unclassified',
      'legacy_explicit_sources', 'active')`).run(modelCode);
  } finally {
    db.close();
  }
}

(async () => {
  try {
    initDatabase({ databasePath });
    const validBuffer = buildWorkbookBuffer('FLOW-VALID');
    const archiveSummary = validateEnergyFlowWorkbookXlsxArchive(validBuffer);
    assert(archiveSummary.entryCount > 0);
    assert(archiveSummary.totalUncompressedBytes > 0);
    assert.strictEqual(buildDomainPreview('FLOW-DOMAIN').summary.wouldImport, 1);

    // 新用户墙钟格式在完整能流领域预演边界归一化为内部分钟合同，来源时区转换仍产生同一 UTC 结果。
    const visibleWallClockPreview = buildDomainPreview('FLOW-VISIBLE-WALL-CLOCK', {
      mutateRows(rows) {
        rows.models[0][7] = '2026-01-01 00:00:00';
        rows.models[0][8] = '2027-01-01 00:00:00';
        rows.records[0][8] = '2026-07-01 09:00:00';
        rows.records[0][9] = '2026-07-01 10:00:00';
        rows.lossEvidence[1][10] = '2026-07-01 01:00:00';
        rows.lossEvidence[1][11] = '2026-07-01 02:00:00';
      }
    });
    assert.strictEqual(
      visibleWallClockPreview.summary.wouldImport,
      1,
      JSON.stringify(visibleWallClockPreview.issues)
    );
    assert.strictEqual(visibleWallClockPreview.candidateRows[0].model.startWallClock, '2026-01-01T00:00');
    assert.strictEqual(visibleWallClockPreview.candidateRows[0].model.endWallClock, '2027-01-01T00:00');
    assert.strictEqual(visibleWallClockPreview.candidateRows[0].records[0].startWallClock, '2026-07-01T09:00');
    assert.strictEqual(visibleWallClockPreview.candidateRows[0].records[0].startUtc, '2026-07-01T01:00:00Z');
    assert.strictEqual(visibleWallClockPreview.candidateRows[0].lossEvidence[0].startWallClock, '2026-07-01T01:00');
    const nonZeroWallClockPreview = buildDomainPreview('FLOW-NONZERO-WALL-CLOCK', {
      mutateRows(rows) { rows.records[0][8] = '2026-07-01 09:00:01'; }
    });
    assert.strictEqual(nonZeroWallClockPreview.summary.wouldImport, 0);
    assert.strictEqual(nonZeroWallClockPreview.summary.blocked, 1);
    assert(issueCodes(nonZeroWallClockPreview).has('ENERGY_FLOW_WORKBOOK_WALL_CLOCK_SECOND_MUST_BE_ZERO'));

    // ZIP/OOXML 门禁必须覆盖 ZIP64、分卷、加密、路径、重复、压缩、CRC 和 descriptor。
    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    const validEnd = findZipEndOffset(validBuffer);
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(Buffer.concat([
      validBuffer.subarray(0, validEnd), zip64Locator, validBuffer.subarray(validEnd)
    ])), 'ENERGY_FLOW_WORKBOOK_ZIP64_REJECTED');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
      buffer.writeUInt16LE(1, endOffset + 4);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_MULTIDISK_REJECTED');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, endOffset) => {
      buffer.writeUInt16LE(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntries + 1, endOffset + 8);
      buffer.writeUInt16LE(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntries + 1, endOffset + 10);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_LIMIT_EXCEEDED', 413);
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      assert(entries.length >= 3);
      buffer.writeUInt32LE(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes, entries[0].offset + 24);
      buffer.writeUInt32LE(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes, entries[1].offset + 24);
      buffer.writeUInt32LE(1, entries[2].offset + 24);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_TOTAL_SIZE_EXCEEDED', 413);
    const actualEntryOverflowPayload = Buffer.alloc(
      ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1
    );
    const actualEntryOverflowArchive = buildSyntheticDeflateZip([{
      name: 'xl/worksheets/sheet1.xml',
      payload: actualEntryOverflowPayload,
      declaredSize: 1
    }]);
    assertWorkbookError(
      () => validateEnergyFlowWorkbookXlsxArchive(actualEntryOverflowArchive),
      'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED',
      413
    );
    const actualTotalEntryBytes = Math.floor(
      ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipTotalUncompressedBytes / 3
    ) + 1;
    const actualTotalPayload = Buffer.alloc(actualTotalEntryBytes);
    const actualTotalOverflowArchive = buildSyntheticDeflateZip([
      { name: 'xl/worksheets/sheet1.xml', payload: actualTotalPayload, declaredSize: 1 },
      { name: 'xl/worksheets/sheet2.xml', payload: actualTotalPayload, declaredSize: 1 },
      { name: 'xl/worksheets/sheet3.xml', payload: actualTotalPayload, declaredSize: 1 }
    ]);
    assertWorkbookError(
      () => validateEnergyFlowWorkbookXlsxArchive(actualTotalOverflowArchive),
      'ENERGY_FLOW_WORKBOOK_ZIP_TOTAL_SIZE_EXCEEDED',
      413
    );
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      buffer.writeUInt16LE(entries[0].flags | 1, entries[0].offset + 8);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENCRYPTED_REJECTED');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      Buffer.from('../', 'utf8').copy(buffer, entries[0].filenameStart);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_PATH_INVALID');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      const target = entries.find((entry) => entry.name.includes('/_rels/'));
      assert(target);
      const nextName = target.name.replace('/_rels/', '//rels/');
      assert.strictEqual(Buffer.byteLength(nextName), target.filenameLength);
      Buffer.from(nextName, 'utf8').copy(buffer, target.filenameStart);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_PATH_INVALID');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      const source = entries.find((entry, index) => entries.slice(index + 1)
        .some((candidate) => candidate.filenameLength === entry.filenameLength));
      const target = entries.slice(entries.indexOf(source) + 1)
        .find((entry) => entry.filenameLength === source.filenameLength);
      assert(source && target);
      buffer.copy(buffer, target.filenameStart, source.filenameStart, source.filenameStart + source.filenameLength);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_DUPLICATED');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      const entry = entries[0];
      buffer.writeUInt16LE(12, entry.offset + 10);
      buffer.writeUInt16LE(12, entry.localOffset + 8);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_COMPRESSION_REJECTED');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      const entry = entries[0];
      const wrongCrc = (entry.crc32 + 1) >>> 0;
      buffer.writeUInt32LE(wrongCrc, entry.offset + 16);
      buffer.writeUInt32LE(wrongCrc, entry.localOffset + 14);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_CRC_MISMATCH');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      buffer.writeUInt32LE(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1, entries[0].offset + 24);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED', 413);
    assert.doesNotThrow(() => validateEnergyFlowWorkbookXlsxArchive(addDataDescriptor(validBuffer)));
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(addDataDescriptor(validBuffer, true)), 'ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID');
    assertWorkbookError(() => validateEnergyFlowWorkbookXlsxArchive(mutateXlsxArchive(validBuffer, (buffer, _endOffset, entries) => {
      buffer.writeUInt32LE(entries[0].localOffset, entries[1].offset + 42);
    })), 'ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID');

    // 工作表固定结构必须拒绝公式、合并、hidden/veryHidden、重命名、缺表和表头漂移。
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-FORMULA', {
      mutateWorksheet: ({ worksheet, contract }) => {
        if (contract.key === 'records') worksheet.M2 = { t: 'n', f: 'SUM(1,1)', v: 2 };
      }
    }), 'formula.xlsx'), 'ENERGY_FLOW_WORKBOOK_FORMULA_CELL_REJECTED');
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-MERGE', {
      mutateWorksheet: ({ worksheet, contract }) => {
        if (contract.key === 'models') worksheet['!merges'] = [XLSX.utils.decode_range('A2:B2')];
      }
    }), 'merge.xlsx'), 'ENERGY_FLOW_WORKBOOK_MERGED_CELLS_REJECTED');
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-HIDDEN', { hiddenSheetIndex: 1 }), 'hidden.xlsx'), 'ENERGY_FLOW_WORKBOOK_SHEET_CONTRACT_INVALID');
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-VERY-HIDDEN', { hiddenSheetIndex: 1, hiddenValue: 2 }), 'very-hidden.xlsx'), 'ENERGY_FLOW_WORKBOOK_SHEET_CONTRACT_INVALID');
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-RENAME', {
      sheetNames: ['模型', '设备资产及节点', '有向边', '期间流量', '余热事实', '损耗证据']
    }), 'renamed.xlsx'), 'ENERGY_FLOW_WORKBOOK_SHEET_CONTRACT_INVALID');
    assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(buildWorkbookBuffer('FLOW-HEADER', {
      mutateWorksheet: ({ worksheet, contract }) => {
        if (contract.key === 'edges') worksheet.A1.v = 'modelCode';
      }
    }), 'header.xlsx'), 'ENERGY_FLOW_WORKBOOK_HEADERS_MISMATCH');

    // 领域 blocker 覆盖规范键碰撞、active 引用、路径、自环、时间、显式分面与子事实。
    const collision = buildDomainPreview('FLOW-COLLISION', {
      mutateRows(rows) {
        rows.assetsNodes.splice(1, 0, ['asset', 'FLOW-COLLISION', 'asset-01', '重复设备', 'other', '', '', '', '', '', '', '', '', 'active']);
      }
    });
    assert(issueCodes(collision).has('ENERGY_FLOW_WORKBOOK_NORMALIZED_KEY_COLLISION'));
    const inactiveModel = buildDomainPreview('FLOW-INACTIVE-MODEL', {
      mutateRows(rows) { rows.models[0][12] = 'inactive'; }
    });
    assert(issueCodes(inactiveModel).has('ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID'));
    const inactiveAsset = buildDomainPreview('FLOW-INACTIVE-ASSET', {
      mutateRows(rows) { rows.assetsNodes[0][13] = 'inactive'; }
    });
    assert(issueCodes(inactiveAsset).has('ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID'));
    const selfLoop = buildDomainPreview('FLOW-SELF-LOOP', {
      mutateRows(rows) { rows.edges[0][6] = 'NODE-IN'; }
    });
    assert(issueCodes(selfLoop).has('ENERGY_FLOW_WORKBOOK_SELF_LOOP_REJECTED'));
    const brokenPath = buildDomainPreview('FLOW-BROKEN-PATH', {
      mutateRows(rows) {
        rows.assetsNodes.push(['node', 'FLOW-BROKEN-PATH', '', '', '', 'NODE-THIRD', '第三节点', 'process', '', 'distribution', '', 50, 50, 'active']);
        rows.edges.push(['FLOW-BROKEN-PATH', 'PATH-01', '主路径', 3, 'EDGE-02', 'NODE-THIRD', 'NODE-OUT', 'electricity', 'kWh', 'workbook_fact', 'edge:02', 'active']);
      }
    });
    assert(issueCodes(brokenPath).has('ENERGY_FLOW_WORKBOOK_PATH_SEQUENCE_INVALID'));
    assert(issueCodes(brokenPath).has('ENERGY_FLOW_WORKBOOK_PATH_DISCONTINUITY'));
    const outsideModel = buildDomainPreview('FLOW-OUTSIDE', {
      mutateRows(rows) {
        rows.records[0][8] = '2027-01-01T00:00';
        rows.records[0][9] = '2027-01-01T01:00';
      }
    });
    assert(issueCodes(outsideModel).has('ENERGY_FLOW_WORKBOOK_PERIOD_OUTSIDE_MODEL'));
    const overlap = buildDomainPreview('FLOW-OVERLAP', {
      mutateRows(rows) {
        rows.records[1][8] = '2026-07-01T00:30';
        rows.records[1][9] = '2026-07-01T01:30';
      }
    });
    assert(issueCodes(overlap).has('ENERGY_FLOW_WORKBOOK_PERIOD_OVERLAP'));
    const gap = buildDomainPreview('FLOW-DST-GAP', {
      mutateRows(rows) {
        rows.records[0][8] = '2026-03-08T02:30';
        rows.records[0][9] = '2026-03-08T03:30';
        rows.records[0][10] = 'America/New_York';
      }
    });
    assert([...issueCodes(gap)].some((code) => /WALL_CLOCK|TIMEZONE|DST|NONEXISTENT/iu.test(code)));
    const fold = buildDomainPreview('FLOW-DST-FOLD', {
      mutateRows(rows) {
        rows.records[0][8] = '2026-11-01T01:15';
        rows.records[0][9] = '2026-11-01T01:45';
        rows.records[0][10] = 'America/New_York';
      }
    });
    assert([...issueCodes(fold)].some((code) => /WALL_CLOCK|TIMEZONE|DST|AMBIGUOUS/iu.test(code)));
    const inactiveLoss = buildDomainPreview('FLOW-INACTIVE-LOSS', {
      mutateRows(rows) { rows.lossEvidence[0][15] = 'inactive'; }
    });
    assert(issueCodes(inactiveLoss).has('ENERGY_FLOW_WORKBOOK_ACTIVE_REFERENCE_INVALID'));

    // 图和证据质量只产生 warning，不得静默改写拓扑或损耗事实。
    const graphWarnings = buildDomainPreview('FLOW-GRAPH-WARNING', {
      mutateRows(rows) {
        rows.assetsNodes.push(['node', 'FLOW-GRAPH-WARNING', '', '', '', 'NODE-ISO', '孤立节点', 'process', '', 'distribution', '', 200, 0, 'active']);
        rows.edges.push(['FLOW-GRAPH-WARNING', 'PATH-01', '主路径', 2, 'EDGE-RETURN', 'NODE-OUT', 'NODE-IN', 'electricity', 'kWh', 'workbook_fact', 'edge:return', 'active']);
        rows.lossEvidence = [rows.lossEvidence[0]];
      }
    });
    assert(issueCodes(graphWarnings).has('ENERGY_FLOW_WORKBOOK_DIRECTED_CYCLE_WARNING'));
    assert(issueCodes(graphWarnings).has('ENERGY_FLOW_WORKBOOK_ISOLATED_NODE_WARNING'));
    assert(issueCodes(graphWarnings).has('ENERGY_FLOW_WORKBOOK_MULTIPLE_COMPONENTS_WARNING'));
    assert(issueCodes(graphWarnings).has('ENERGY_FLOW_WORKBOOK_LOSS_EVIDENCE_MISSING'));

    // 非资源结构失败必须形成 failed preview、保留原文件且零领域事实。
    const failedUpload = storeUpload('failed-preview.xlsx', Buffer.from('fake-xlsx'));
    const failedPreview = previewEnergyFlowWorkbookImport(failedUpload, buildServiceOptions());
    assert.strictEqual(failedPreview.summary.blocked, 1);
    assert.strictEqual(failedPreview.summary.wouldImport, 0);
    assert.strictEqual(failedPreview.workbook, undefined);
    assert.strictEqual(fs.existsSync(failedUpload.path), true);
    const failedBatch = getImportAuditBatchDetail(failedPreview.batchId, { openDatabase: openTestDatabase });
    assert.strictEqual(failedBatch.status, 'failed');
    assert.strictEqual(failedBatch.issueCounts.error, 1);
    CANONICAL_TABLES.forEach((tableName) => assert.strictEqual(countRows(tableName), 0));
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({
      batchId: failedPreview.batchId,
      confirmText: ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, buildServiceOptions()), 'ENERGY_FLOW_WORKBOOK_BATCH_NOT_EXECUTABLE');

    // 资源失败统一 413，并且保持零新增批次、零问题、零领域事实。
    const batchCountBeforeResource = countRows('import_batches');
    const issueCountBeforeResource = countRows('import_errors');
    const oversizedUpload = storeUpload('oversized.xlsx', Buffer.alloc(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes + 1));
    await assertAsyncCode(async () => previewEnergyFlowWorkbookImport(oversizedUpload, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_UPLOAD_SIZE_EXCEEDED', 413);
    assert.strictEqual(countRows('import_batches'), batchCountBeforeResource);
    assert.strictEqual(countRows('import_errors'), issueCountBeforeResource);
    CANONICAL_TABLES.forEach((tableName) => assert.strictEqual(countRows(tableName), 0));
    await assertResourcePreviewRejected(
      'actual-entry-overflow.xlsx',
      actualEntryOverflowArchive,
      'ENERGY_FLOW_WORKBOOK_ZIP_ENTRY_SIZE_EXCEEDED'
    );
    await assertResourcePreviewRejected(
      'actual-total-overflow.xlsx',
      actualTotalOverflowArchive,
      'ENERGY_FLOW_WORKBOOK_ZIP_TOTAL_SIZE_EXCEEDED'
    );

    // 成功 preview 只能写一个统一审计批次，公共 DTO 不得泄漏候选或安全链。
    const protectedBefore = snapshotProtectedTables();
    const successUpload = storeUpload('success.xlsx', buildWorkbookBuffer('FLOW-SUCCESS'));
    const successPreview = previewEnergyFlowWorkbookImport(successUpload, buildServiceOptions());
    assert.strictEqual(successPreview.summary.wouldImport, 1);
    assert.strictEqual(successPreview.auditBatch.status, 'completed');
    assert.strictEqual(successPreview.workbook, undefined);
    const previewText = JSON.stringify(successPreview);
    ['candidateRows', 'candidateRowIds', 'candidateRowId', 'previewSignature', 'previewAuditDigest', 'fileSha256', 'storedFilename', 'sourceRowNumber'].forEach((field) => {
      assert(!previewText.includes(`"${field}"`), `preview 公共 DTO 不得包含 ${field}。`);
    });
    CANONICAL_TABLES.forEach((tableName) => assert.strictEqual(countRows(tableName), 0));
    assert.deepStrictEqual(snapshotProtectedTables(), protectedBefore);
    const persistedSuccessPreview = getImportAuditBatchDetail(successPreview.batchId, { openDatabase: openTestDatabase, includeIssues: false });
    assert.strictEqual(persistedSuccessPreview.importType, 'energy_flow_workbook');
    assert.strictEqual(persistedSuccessPreview.auditPhase, 'preview');
    assert.strictEqual(Array.isArray(persistedSuccessPreview.auditContext.candidateRows), true);
    assert.strictEqual(persistedSuccessPreview.auditContext.candidateRows.length, 1);

    // execute 请求体只能接受固定四字段，且所有确认条件必须精确匹配。
    const validExecuteBody = {
      batchId: successPreview.batchId,
      confirmText: ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    };
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, previewSignature: 'client' }, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_EXECUTE_EXTRA_FIELDS_REJECTED');
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, confirmText: '确认导入' }, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT_MISMATCH');
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, requireBackup: false }, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_BACKUP_REQUIRED');
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, acknowledgeSkippedRisks: false }, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_SKIPPED_RISKS_ACK_REQUIRED');
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport(validExecuteBody, buildServiceOptions({ actorUserId: 0 })),
      'ENERGY_FLOW_WORKBOOK_ACTOR_REQUIRED');

    // SHA、签名、audit digest、candidate witness、数据库 stale 均必须 fail-closed。
    const tamperedFileUpload = storeUpload('tampered-file.xlsx', buildWorkbookBuffer('FLOW-TAMPER-FILE'));
    const tamperedFilePreview = previewEnergyFlowWorkbookImport(tamperedFileUpload, buildServiceOptions());
    fs.writeFileSync(tamperedFileUpload.path, Buffer.from('tampered-after-preview'));
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: tamperedFilePreview.batchId }, buildServiceOptions()), [
      'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH',
      'ENERGY_FLOW_WORKBOOK_FILE_SHA256_MISMATCH'
    ]);

    const signatureUpload = storeUpload('tampered-signature.xlsx', buildWorkbookBuffer('FLOW-TAMPER-SIGNATURE'));
    const signaturePreview = previewEnergyFlowWorkbookImport(signatureUpload, buildServiceOptions());
    let db = openTestDatabase();
    try { db.prepare('UPDATE import_batches SET preview_signature = ? WHERE id = ?').run('tampered-signature', signaturePreview.batchId); } finally { db.close(); }
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: signaturePreview.batchId }, buildServiceOptions()), [
      'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID',
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_WITNESS_INVALID'
    ]);

    const digestUpload = storeUpload('tampered-digest.xlsx', buildWorkbookBuffer('FLOW-TAMPER-DIGEST'));
    const digestPreview = previewEnergyFlowWorkbookImport(digestUpload, buildServiceOptions());
    db = openTestDatabase();
    try { db.prepare('UPDATE import_batches SET preview_audit_digest = ? WHERE id = ?').run('tampered-digest', digestPreview.batchId); } finally { db.close(); }
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: digestPreview.batchId }, buildServiceOptions()), 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID');

    const witnessUpload = storeUpload('tampered-witness.xlsx', buildWorkbookBuffer('FLOW-TAMPER-WITNESS'));
    const witnessPreview = previewEnergyFlowWorkbookImport(witnessUpload, buildServiceOptions());
    db = openTestDatabase();
    try {
      const batch = db.prepare('SELECT audit_context_json AS auditContextJson FROM import_batches WHERE id = ?').get(witnessPreview.batchId);
      const auditContext = JSON.parse(batch.auditContextJson);
      auditContext.candidateRows[0].model.modelName = '被篡改候选';
      db.prepare('UPDATE import_batches SET audit_context_json = ? WHERE id = ?')
        .run(JSON.stringify(auditContext), witnessPreview.batchId);
    } finally { db.close(); }
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: witnessPreview.batchId }, buildServiceOptions()), [
      'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID',
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_WITNESS_INVALID'
    ]);

    const staleUpload = storeUpload('stale.xlsx', buildWorkbookBuffer('FLOW-STALE'));
    const stalePreview = previewEnergyFlowWorkbookImport(staleUpload, buildServiceOptions());
    insertCollidingModel('FLOW-STALE');
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: stalePreview.batchId }, buildServiceOptions()), [
      'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'
    ]);

    // 备份、事实、操作审计或统一 import execute 审计失败均必须回滚九表事实。
    const rollbackCases = [
      {
        name: 'backup',
        code: 'FLOW-ROLLBACK-BACKUP',
        options: {
          createBackup: async () => { throw new Error(`sensitive ${backupsDir}`); }
        },
        expectedCodes: ['ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED']
      },
      {
        name: 'fact',
        code: 'FLOW-ROLLBACK-FACT',
        beforeExecute(batchId) {
          const triggerDb = openTestDatabase();
          try {
            triggerDb.exec(`CREATE TRIGGER fail_workbook_fact_${batchId}
              BEFORE INSERT ON energy_flow_records
              BEGIN SELECT RAISE(ABORT, 'forced fact failure'); END;`);
          } finally { triggerDb.close(); }
        },
        afterExecute(batchId) {
          const triggerDb = openTestDatabase();
          try { triggerDb.exec(`DROP TRIGGER fail_workbook_fact_${batchId}`); } finally { triggerDb.close(); }
        },
        expectedCodes: ['INTERNAL_ERROR', 'SQLITE_CONSTRAINT_TRIGGER']
      },
      {
        name: 'operation-audit',
        code: 'FLOW-ROLLBACK-OP-AUDIT',
        options: {
          auditWriter() { throw new Error('forced operation audit failure'); }
        },
        expectedCodes: ['INTERNAL_ERROR']
      },
      {
        name: 'import-audit',
        code: 'FLOW-ROLLBACK-IMPORT-AUDIT',
        beforeExecute(batchId) {
          const triggerDb = openTestDatabase();
          try {
            triggerDb.exec(`CREATE TRIGGER fail_workbook_import_audit_${batchId}
              BEFORE UPDATE ON import_batches
              WHEN OLD.id = ${Number(batchId)}
              BEGIN SELECT RAISE(ABORT, 'forced import audit failure'); END;`);
          } finally { triggerDb.close(); }
        },
        afterExecute(batchId) {
          const triggerDb = openTestDatabase();
          try { triggerDb.exec(`DROP TRIGGER fail_workbook_import_audit_${batchId}`); } finally { triggerDb.close(); }
        },
        expectedCodes: ['INTERNAL_ERROR', 'SQLITE_CONSTRAINT_TRIGGER']
      }
    ];
    for (const testCase of rollbackCases) {
      const upload = storeUpload(`${testCase.name}.xlsx`, buildWorkbookBuffer(testCase.code));
      const preview = previewEnergyFlowWorkbookImport(upload, buildServiceOptions());
      const countsBefore = Object.fromEntries(CANONICAL_TABLES.map((tableName) => [tableName, countRows(tableName)]));
      if (testCase.beforeExecute) testCase.beforeExecute(preview.batchId);
      try {
        await assertAsyncCode(
          () => executeEnergyFlowWorkbookImport({ ...validExecuteBody, batchId: preview.batchId }, buildServiceOptions(testCase.options)),
          testCase.expectedCodes,
          testCase.expectedStatus || null
        );
      } finally {
        if (testCase.afterExecute) testCase.afterExecute(preview.batchId);
      }
      CANONICAL_TABLES.forEach((tableName) => {
        assert.strictEqual(countRows(tableName), countsBefore[tableName], `${testCase.name} 失败后 ${tableName} 必须回滚。`);
      });
      const rollbackBatch = getImportAuditBatchDetail(preview.batchId, { openDatabase: openTestDatabase, includeIssues: false });
      assert.strictEqual(rollbackBatch.auditPhase, 'preview');
    }

    // 成功 execute 必须锁内重读一次、只备份一次，并原子提交九表与两类审计。
    let backupCount = 0;
    let lockReadCount = 0;
    const executed = await executeEnergyFlowWorkbookImport(validExecuteBody, buildServiceOptions({
      afterExecuteLockFileOpen() { lockReadCount += 1; },
      createBackup: async () => {
        backupCount += 1;
        return {
          backupName: 'success.sqlite',
          reason: 'energy-flow-workbook-import',
          method: 'test-stub',
          sizeBytes: 1,
          createdAt: '2026-08-26T00:00:00Z'
        };
      }
    }));
    assert.strictEqual(executed.executed, true);
    assert.strictEqual(backupCount, 1);
    assert.strictEqual(lockReadCount, 1);
    assert.deepStrictEqual(executed.importedFactCounts, {
      models: 1,
      assets: 1,
      nodes: 2,
      paths: 1,
      edges: 1,
      records: 2,
      wasteHeat: 1,
      lossFacts: 1,
      lossEvidence: 1
    });
    CANONICAL_TABLES.forEach((tableName) => {
      assert.strictEqual(countBatchRows(tableName, successPreview.batchId), tableName === 'energy_flow_records' || tableName === 'energy_flow_nodes' ? 2 : 1);
    });
    assert.deepStrictEqual(snapshotProtectedTables(), protectedBefore);
    db = openTestDatabase();
    try {
      CANONICAL_TABLES.forEach((tableName) => {
        const rows = db.prepare(`SELECT source_batch_id AS batchId, source_row_number AS rowNumber FROM ${tableName} WHERE source_batch_id = ?`).all(successPreview.batchId);
        rows.forEach((row) => {
          assert.strictEqual(row.batchId, successPreview.batchId);
          assert(Number.isSafeInteger(row.rowNumber) && row.rowNumber >= 2);
        });
      });
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
        WHERE operation = 'energy-flow-workbook.import.execute' AND target_type = 'energy_flow_model'`).get().total, 1);
      const model = db.prepare('SELECT classification_status AS classificationStatus, source_mode AS sourceMode FROM energy_flow_models WHERE source_batch_id = ?').get(successPreview.batchId);
      assert.deepStrictEqual(model, { classificationStatus: 'workbook_facts', sourceMode: 'workbook_facts_only' });
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_flow_edges WHERE source_type = 'workbook_fact'").get().total, 1);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_flow_records WHERE source_type = 'workbook_fact'").get().total, 2);
    } finally { db.close(); }
    const executedBatch = getImportAuditBatchDetail(successPreview.batchId, { openDatabase: openTestDatabase, includeIssues: false });
    assert.strictEqual(executedBatch.auditPhase, 'execute');
    assert.strictEqual(executedBatch.status, 'completed');
    assert.strictEqual(executedBatch.executeResult.executed, true);
    assert.strictEqual(executedBatch.backup.reason, 'energy-flow-workbook-import');

    // 重复 execute 必须稳定拒绝，不能重复备份或写入事实。
    await assertAsyncCode(() => executeEnergyFlowWorkbookImport(validExecuteBody, buildServiceOptions()),
      'ENERGY_FLOW_WORKBOOK_BATCH_NOT_EXECUTABLE');
    CANONICAL_TABLES.forEach((tableName) => {
      assert.strictEqual(countBatchRows(tableName, successPreview.batchId), tableName === 'energy_flow_records' || tableName === 'energy_flow_nodes' ? 2 : 1);
    });

    console.log('energyFlowWorkbookImportService tests passed');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
