'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

// 本测试始终使用系统临时目录和隔离 SQLite，禁止访问真实 data。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-import-'));
// 隔离上传目录。
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
// 隔离备份目录。
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
// 隔离数据库路径。
const temporaryDatabasePath = path.join(temporaryRoot, 'energy-flow-import.sqlite');
fs.mkdirSync(temporaryUploadsDir, { recursive: true });
fs.mkdirSync(temporaryBackupsDir, { recursive: true });
process.env.DATA_DIR = temporaryRoot;
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowTest123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-flow-import-test-secret-2026';

const { initDatabase, openDatabase } = require('../db/database');
const { createBackup, validateBackupFile } = require('../services/backupService');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY
} = require('../services/energyAnalysisImportCore');
const {
  getEnergyAnalysisTemplateDefinition
} = require('../services/energyAnalysisTemplateService');
const {
  ENERGY_FLOW_EDGE_BATCH_CONTRACT,
  ENERGY_FLOW_RECORD_BATCH_CONTRACT,
  buildEnergyFlowBundleImportPreview,
  executeEnergyFlowBundleImport,
  executeEnergyFlowNodeImport,
  previewEnergyFlowBundleImport,
  previewEnergyFlowNodeImport
} = require('../services/energyFlowImportService');

// 能流模型冻结测试数据。
const FLOW_MODEL = Object.freeze({
  modelCode: 'FLOW-IMPORT-001',
  modelName: '测试能流模型',
  modelSource: '隔离测试',
  modelDocumentNo: 'TEST-FLOW-2026',
  modelVersion: 'energy-flow:v1',
  modelEffectiveStartUtc: '2026-01-01T00:00:00Z',
  modelEffectiveEndUtc: '2027-01-01T00:00:00Z',
  sourceTimeZone: 'Asia/Shanghai'
});

// 双工作表名称由测试硬编码，避免测试只复述生产模板定义。
const HARD_CODED_FLOW_SHEET_NAMES = Object.freeze(['能流边', '显式边值']);
// 能流边中文表头顺序由验收契约硬编码。
const HARD_CODED_EDGE_HEADERS = Object.freeze([
  '模型编码', '模型版本', '边编码', '起点节点编码', '终点节点编码',
  '能源类型编码', '单位', '来源类型', '来源标识', '状态'
]);
// 显式边值中文表头顺序由验收契约硬编码。
const HARD_CODED_RECORD_HEADERS = Object.freeze([
  '模型编码', '模型版本', '边编码', '开始时间（UTC）', '结束时间（UTC）',
  '来源时区', '原始单位', '原始值', '来源标识', '公式版本', '记录状态'
]);
// 硬编码表头对应的内部取值顺序，不依赖生产模板列定义。
const HARD_CODED_EDGE_KEYS = Object.freeze([
  'modelCode', 'modelVersion', 'edgeCode', 'fromNodeCode', 'toNodeCode',
  'energyTypeCode', 'unit', 'sourceType', 'sourceReference', 'status'
]);
// 显式边值硬编码取值顺序。
const HARD_CODED_RECORD_KEYS = Object.freeze([
  'modelCode', 'modelVersion', 'edgeCode', 'startUtc', 'endUtc',
  'sourceTimeZone', 'originalUnit', 'originalValue', 'sourceReference', 'formulaVersion', 'recordStatus'
]);
// 双批次角色契约由测试独立硬编码。
const HARD_CODED_BATCH_CONTRACTS = Object.freeze({
  edge: Object.freeze({
    importType: 'energy_flow_edge',
    operation: 'energy-flow-edge-import',
    recordKind: 'energy_flow_edge',
    sheetName: '能流边'
  }),
  record: Object.freeze({
    importType: 'energy_flow_record',
    operation: 'energy-flow-record-import',
    recordKind: 'energy_flow_record',
    sheetName: '显式边值'
  })
});

/**
 * 把 camelCase 模板记录投影为中文表头数组。
 * @param {string} templateType 模板类型。
 * @param {string} sheetName 工作表名。
 * @param {object} record 模板记录。
 * @returns {Array<*>} 单行数据。
 */
function projectTemplateRecord(templateType, sheetName, record) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  const sheet = definition.sheets.find((item) => item.name === sheetName);
  return sheet.columns.map((column) => record[column.key] ?? '');
}

/**
 * 创建单工作表或双工作表 XLSX 上传对象，支持插入物理空白行。
 * @param {string} storedFilename 保存文件名。
 * @param {Array<object>} sheets 工作表定义。
 * @returns {object} Multer 风格文件对象。
 */
function createWorkbookUpload(storedFilename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheetDefinition) => {
    const definition = getEnergyAnalysisTemplateDefinition(sheetDefinition.templateType);
    const sheet = definition.sheets.find((item) => item.name === sheetDefinition.sheetName);
    const rows = [sheet.columns.map((column) => column.name)];
    (sheetDefinition.rows || []).forEach((row) => {
      if (row === null) rows.push([]);
      else rows.push(projectTemplateRecord(sheetDefinition.templateType, sheetDefinition.sheetName, row));
    });
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetDefinition.sheetName);
  });
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  XLSX.writeFile(workbook, filePath);
  const stat = fs.statSync(filePath);
  return {
    originalname: storedFilename,
    filename: storedFilename,
    size: stat.size,
    path: filePath
  };
}

/**
 * 使用测试内硬编码的中文工作表名和表头顺序创建双工作表 XLSX。
 * @param {string} storedFilename 保存文件名。
 * @param {object[]} edgeRows 边记录，null 表示物理空白行。
 * @param {object[]} recordRows 显式边值记录，null 表示物理空白行。
 * @returns {object} Multer 风格文件对象。
 */
function createHardCodedBundleUpload(storedFilename, edgeRows, recordRows) {
  const workbook = XLSX.utils.book_new();
  const appendSheet = (sheetName, headers, keys, records) => {
    const rows = [headers];
    records.forEach((record) => rows.push(record === null ? [] : keys.map((key) => record[key] ?? '')));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  };
  appendSheet(HARD_CODED_FLOW_SHEET_NAMES[0], HARD_CODED_EDGE_HEADERS, HARD_CODED_EDGE_KEYS, edgeRows);
  appendSheet(HARD_CODED_FLOW_SHEET_NAMES[1], HARD_CODED_RECORD_HEADERS, HARD_CODED_RECORD_KEYS, recordRows);
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  XLSX.writeFile(workbook, filePath);
  return {
    originalname: storedFilename,
    filename: storedFilename,
    size: fs.statSync(filePath).size,
    path: filePath
  };
}

/**
 * 创建 CSV 上传对象。
 * @param {string} storedFilename 保存文件名。
 * @param {string} content CSV 内容。
 * @returns {object} Multer 风格文件对象。
 */
function createCsvUpload(storedFilename, content) {
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    originalname: storedFilename,
    filename: storedFilename,
    size: fs.statSync(filePath).size,
    path: filePath
  };
}

/**
 * 创建统一安全 execute 请求体。
 * @param {object} preview preview 响应。
 * @param {object} ids 单批次或双批次 ID。
 * @returns {object} execute 请求体。
 */
function buildExecuteBody(preview, ids) {
  return {
    ...ids,
    uploadGroupId: preview.uploadGroupId,
    confirmText: preview.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
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
 * 创建不会访问真实备份文件的备份桩。
 * @param {object} counter 可变计数器。
 * @returns {Function} 备份函数。
 */
function createBackupStub(counter) {
  return async ({ reason, skipCheckpoint }) => {
    counter.count += 1;
    assert.strictEqual(reason, ENERGY_ANALYSIS_IMPORT_BACKUP_REASON);
    assert.strictEqual(skipCheckpoint, true, 'execute 锁内备份必须显式跳过 checkpoint。');
    return {
      backupName: `energy-flow-test-${counter.count}.sqlite`,
      reason,
      sizeBytes: 128,
      sha256: 'a'.repeat(64),
      method: 'test-stub',
      createdAt: '2026-08-06T00:00:00Z'
    };
  };
}

/**
 * 插入测试模型、组织和两个合法端点节点。
 * @returns {object} 测试主数据 ID。
 */
function seedFlowMasterData() {
  const db = openDatabase();
  try {
    const organizationId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('OU-FLOW-001', '能流测试单元', '/OU-FLOW-001', 'workshop', 'active')`
    ).run().lastInsertRowid);
    const modelId = Number(db.prepare(
      `INSERT INTO energy_flow_models (
         model_code, model_name, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).run(
      FLOW_MODEL.modelCode,
      FLOW_MODEL.modelName,
      FLOW_MODEL.modelSource,
      FLOW_MODEL.modelDocumentNo,
      FLOW_MODEL.modelVersion,
      FLOW_MODEL.modelEffectiveStartUtc,
      FLOW_MODEL.modelEffectiveEndUtc,
      FLOW_MODEL.sourceTimeZone
    ).lastInsertRowid);
    const insertNode = db.prepare(
      `INSERT INTO energy_flow_nodes (
         energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    );
    const sourceNodeId = Number(insertNode.run(modelId, 'SOURCE-A', '来源节点', 'source', organizationId, 10, 20).lastInsertRowid);
    const sinkNodeId = Number(insertNode.run(modelId, 'SINK-A', '去向节点', 'sink', organizationId, 200, 20).lastInsertRowid);
    return { organizationId, modelId, sourceNodeId, sinkNodeId };
  } finally {
    db.close();
  }
}

/**
 * 构造合法节点模板行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 节点模板行。
 */
function createNodeRow(overrides = {}) {
  return {
    ...FLOW_MODEL,
    nodeCode: 'PROCESS-IMPORT',
    nodeName: '导入加工节点',
    nodeType: 'process',
    organizationUnitCode: 'OU-FLOW-001',
    x: 80,
    y: 120,
    status: 'active',
    ...overrides
  };
}

/**
 * 构造合法边模板行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 边模板行。
 */
function createEdgeRow(overrides = {}) {
  return {
    modelCode: FLOW_MODEL.modelCode,
    modelVersion: FLOW_MODEL.modelVersion,
    edgeCode: 'EDGE-IMPORT-001',
    fromNodeCode: 'SOURCE-A',
    toNodeCode: 'SINK-A',
    energyTypeCode: 'electricity',
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceReference: 'explicit-edge:EDGE-IMPORT-001',
    status: 'active',
    ...overrides
  };
}

/**
 * 构造合法显式边值模板行。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 显式边值模板行。
 */
function createRecordRow(overrides = {}) {
  return {
    modelCode: FLOW_MODEL.modelCode,
    modelVersion: FLOW_MODEL.modelVersion,
    edgeCode: 'EDGE-IMPORT-001',
    startUtc: '2026-07-01T00:00:00Z',
    endUtc: '2026-08-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    originalUnit: 'kWh',
    originalValue: 1000,
    sourceReference: 'upload:explicit-edge:001',
    formulaVersion: 'energy-flow:v1',
    recordStatus: 'active',
    ...overrides
  };
}

/**
 * 读取隔离数据库中的计数。
 * @param {string} tableName 表名。
 * @returns {number} 表记录数。
 */
function countRows(tableName) {
  const db = openDatabase();
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count);
  } finally {
    db.close();
  }
}

/**
 * 断言错误码。
 * @param {Function} action 同步或异步动作。
 * @param {string} expectedCode 预期错误码。
 * @returns {Promise<Error>} 捕获错误。
 */
async function assertRejectsWithCode(action, expectedCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `预期抛出 ${expectedCode}`);
  assert.strictEqual(captured.details?.code || captured.code, expectedCode, captured.stack || captured.message);
  return captured;
}

/**
 * 验证测试硬编码的中文工作表、表头顺序和双批次角色契约没有漂移。
 */
function testHardCodedFlowContracts() {
  const definition = getEnergyAnalysisTemplateDefinition('energy-flow-edges');
  assert.deepStrictEqual(definition.sheets.map((sheet) => sheet.name), [...HARD_CODED_FLOW_SHEET_NAMES]);
  assert.deepStrictEqual(definition.sheets[0].columns.map((column) => column.name), [...HARD_CODED_EDGE_HEADERS]);
  assert.deepStrictEqual(definition.sheets[1].columns.map((column) => column.name), [...HARD_CODED_RECORD_HEADERS]);
  assert.deepStrictEqual(ENERGY_FLOW_EDGE_BATCH_CONTRACT, HARD_CODED_BATCH_CONTRACTS.edge);
  assert.deepStrictEqual(ENERGY_FLOW_RECORD_BATCH_CONTRACT, HARD_CODED_BATCH_CONTRACTS.record);
}

/**
 * 验证 BEGIN IMMEDIATE 锁内备份包含锁前提交、排除本次导入，并阻止第二连接穿越备份与提交边界。
 */
async function testLockedBundleBackupEpoch() {
  const preLockConnection = openDatabase();
  try {
    preLockConnection.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES ('energy_flow_lock_precommit', 'included-in-backup', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run();
  } finally {
    preLockConnection.close();
  }

  const edgeRow = createEdgeRow({
    edgeCode: 'EDGE-LOCK-EPOCH',
    sourceReference: 'explicit-edge:EDGE-LOCK-EPOCH'
  });
  const recordRow = createRecordRow({
    edgeCode: 'EDGE-LOCK-EPOCH',
    startUtc: '2026-11-01T00:00:00Z',
    endUtc: '2026-12-01T00:00:00Z',
    sourceReference: 'upload:explicit-edge:lock-epoch'
  });
  const file = createHardCodedBundleUpload('energy-flow-lock-epoch.xlsx', [edgeRow], [recordRow]);
  const preview = previewEnergyFlowBundleImport(file, { uploadsDir: temporaryUploadsDir });
  let competingWriteCode = null;
  const result = await executeEnergyFlowBundleImport(
    buildExecuteBody(preview, { edgeBatchId: preview.edgeBatchId, recordBatchId: preview.recordBatchId }),
    {
      uploadsDir: temporaryUploadsDir,
      createBackup: async (input) => {
        assert.strictEqual(input.skipCheckpoint, true, '锁内在线备份必须使用 skipCheckpoint。');
        const competingConnection = openDatabase();
        try {
          competingConnection.pragma('busy_timeout = 20');
          competingConnection.prepare(
            `INSERT INTO app_meta (key, value, updated_at)
             VALUES ('energy_flow_lock_competing', 'must-not-commit-during-lock', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
          ).run();
        } catch (error) {
          competingWriteCode = error.code;
        } finally {
          competingConnection.close();
        }
        return createBackup(input);
      }
    }
  );
  assert.strictEqual(competingWriteCode, 'SQLITE_BUSY', '第二写连接不得在能流锁事务中提交。');
  assert.strictEqual(result.edge.imported, 1);
  assert.strictEqual(result.record.imported, 1);

  const backupPath = path.join(temporaryBackupsDir, result.backup.backupName);
  assert.strictEqual(validateBackupFile(backupPath).quickCheck, 'ok');
  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assert.strictEqual(
      backupDb.prepare("SELECT value FROM app_meta WHERE key = 'energy_flow_lock_precommit'").get().value,
      'included-in-backup',
      '锁前已提交数据必须进入备份。'
    );
    assert.strictEqual(
      backupDb.prepare("SELECT COUNT(*) AS total FROM energy_flow_edges WHERE edge_code = 'EDGE-LOCK-EPOCH'").get().total,
      0,
      '本次尚未提交的能流边不得进入导入前备份。'
    );
    assert.strictEqual(
      backupDb.prepare("SELECT COUNT(*) AS total FROM app_meta WHERE key = 'energy_flow_lock_competing'").get().total,
      0,
      '锁期间失败的竞争写不得进入备份。'
    );
  } finally {
    backupDb.close();
  }

  const currentDb = openDatabase();
  try {
    assert.strictEqual(currentDb.prepare("SELECT COUNT(*) AS total FROM energy_flow_edges WHERE edge_code = 'EDGE-LOCK-EPOCH'").get().total, 1);
    assert.strictEqual(currentDb.prepare("SELECT COUNT(*) AS total FROM energy_flow_records AS record JOIN energy_flow_edges AS edge ON edge.id = record.energy_flow_edge_id WHERE edge.edge_code = 'EDGE-LOCK-EPOCH'").get().total, 1);
  } finally {
    currentDb.close();
  }
  const retryConnection = openDatabase();
  try {
    retryConnection.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES ('energy_flow_lock_competing', 'committed-after-lock', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run();
  } finally {
    retryConnection.close();
  }
}

/**
 * 运行能流导入服务隔离测试。
 */
async function run() {
  initDatabase();
  testHardCodedFlowContracts();
  const master = seedFlowMasterData();

  // 节点 preview 必须零业务写、保留 XLSX 空白物理行，execute 保存来源批次与行号。
  const initialNodeCount = countRows('energy_flow_nodes');
  const nodeFile = createWorkbookUpload('energy-flow-nodes-valid.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [null, createNodeRow()]
  }]);
  const nodePreview = previewEnergyFlowNodeImport(nodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(nodePreview.expectedWouldImport, 1);
  assert.strictEqual(nodePreview.candidateRows[0].sourceRowNumber, 3);
  assert.strictEqual(countRows('energy_flow_nodes'), initialNodeCount);
  const nodeBackupCounter = { count: 0 };
  const nodeExecute = await executeEnergyFlowNodeImport(
    buildExecuteBody(nodePreview, { batchId: nodePreview.batchId }),
    { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(nodeBackupCounter) }
  );
  assert.strictEqual(nodeExecute.imported, 1);
  assert.strictEqual(nodeBackupCounter.count, 1);
  const nodeDb = openDatabase();
  try {
    const importedNode = nodeDb.prepare(
      `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
              organization_unit_id AS organizationUnitId, x, y
       FROM energy_flow_nodes WHERE node_code = 'PROCESS-IMPORT'`
    ).get();
    assert.strictEqual(importedNode.sourceBatchId, nodePreview.batchId);
    assert.strictEqual(importedNode.sourceRowNumber, 3);
    assert.strictEqual(importedNode.organizationUnitId, master.organizationId);
    assert.strictEqual(importedNode.x, 80);
    assert.strictEqual(importedNode.y, 120);
  } finally {
    nodeDb.close();
  }

  // 数据库完全相同节点按 skip，冲突定义、非法模型/枚举/组织/坐标必须阻断。
  const duplicateNodePreview = previewEnergyFlowNodeImport(nodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(duplicateNodePreview.expectedWouldImport, 0);
  assert.strictEqual(duplicateNodePreview.summary.skipped, 1);
  const invalidNodeFile = createWorkbookUpload('energy-flow-nodes-invalid.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [
      createNodeRow({ x: 81 }),
      createNodeRow({ nodeCode: 'INVALID-TYPE', nodeType: 'unknown' }),
      createNodeRow({ nodeCode: 'INVALID-ORG', organizationUnitCode: 'OU-NOT-FOUND' }),
      createNodeRow({ nodeCode: 'INVALID-XY', x: 'not-number' }),
      createNodeRow({ nodeCode: 'INVALID-MODEL', modelCode: 'FLOW-NOT-FOUND' })
    ]
  }]);
  const invalidNodePreview = previewEnergyFlowNodeImport(invalidNodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(invalidNodePreview.summary.blocked, 5);
  const invalidNodeCodes = invalidNodePreview.items.flatMap((item) => item.issues.map((issue) => issue.code));
  assert(invalidNodeCodes.includes('CONFLICTING_ENERGY_FLOW_NODE'));
  assert(invalidNodeCodes.includes('INVALID_ENERGY_FLOW_NODE_TYPE'));
  assert(invalidNodeCodes.includes('ORGANIZATION_UNIT_NOT_FOUND'));
  assert(invalidNodeCodes.includes('INVALID_ENERGY_FLOW_NODE_COORDINATE'));
  assert(invalidNodeCodes.includes('ENERGY_FLOW_MODEL_NOT_FOUND'));

  // 双工作表 preview 创建两个不同批次，共享上传组、文件元数据、签名和摘要，且零业务写。
  const edgeCountBefore = countRows('energy_flow_edges');
  const recordCountBefore = countRows('energy_flow_records');
  const bundleFile = createHardCodedBundleUpload(
    'energy-flow-bundle-valid.xlsx',
    [null, createEdgeRow()],
    [null, createRecordRow()]
  );
  const bundlePreview = previewEnergyFlowBundleImport(bundleFile, { uploadsDir: temporaryUploadsDir, createUploadGroupId: () => 'flow-group-valid' });
  assert.notStrictEqual(bundlePreview.edgeBatchId, bundlePreview.recordBatchId);
  assert.strictEqual(bundlePreview.edgeBatch.fileSha256, bundlePreview.recordBatch.fileSha256);
  assert.strictEqual(bundlePreview.edgeBatch.previewSignature, bundlePreview.recordBatch.previewSignature);
  assert.strictEqual(bundlePreview.edgeBatch.previewAuditDigest, bundlePreview.recordBatch.previewAuditDigest);
  assert.strictEqual(bundlePreview.expectedWouldImport, 2);
  assert.strictEqual(bundlePreview.edgePreview.candidateRows[0].sourceRowNumber, 3);
  assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].sourceRowNumber, 3);
  assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].edgeReferenceKind, 'candidate');
  assert.strictEqual(countRows('energy_flow_edges'), edgeCountBefore);
  assert.strictEqual(countRows('energy_flow_records'), recordCountBefore);

  // execute 只备份一次，在同一事务中先边后记录并原子更新两个审计。
  const bundleBackupCounter = { count: 0 };
  const bundleExecute = await executeEnergyFlowBundleImport(
    buildExecuteBody(bundlePreview, { edgeBatchId: bundlePreview.edgeBatchId, recordBatchId: bundlePreview.recordBatchId }),
    { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(bundleBackupCounter) }
  );
  assert.strictEqual(bundleBackupCounter.count, 1);
  assert.strictEqual(bundleExecute.edge.imported, 1);
  assert.strictEqual(bundleExecute.record.imported, 1);
  const bundleDb = openDatabase();
  try {
    const importedEdge = bundleDb.prepare(
      `SELECT id, source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber,
              source_mapping_json AS sourceMappingJson
       FROM energy_flow_edges WHERE edge_code = 'EDGE-IMPORT-001'`
    ).get();
    const importedRecord = bundleDb.prepare(
      `SELECT energy_flow_edge_id AS edgeId, source_batch_id AS sourceBatchId,
              source_row_number AS sourceRowNumber
       FROM energy_flow_records WHERE energy_flow_edge_id = ?`
    ).get(importedEdge.id);
    assert.strictEqual(importedEdge.sourceBatchId, bundlePreview.edgeBatchId);
    assert.strictEqual(importedEdge.sourceRowNumber, 3);
    assert.deepStrictEqual(JSON.parse(importedEdge.sourceMappingJson), { reference: 'explicit-edge:EDGE-IMPORT-001' });
    assert.strictEqual(importedRecord.edgeId, importedEdge.id);
    assert.strictEqual(importedRecord.sourceBatchId, bundlePreview.recordBatchId);
    assert.strictEqual(importedRecord.sourceRowNumber, 3);
    const audits = bundleDb.prepare(
      `SELECT id, audit_phase AS auditPhase, status FROM import_batches WHERE id IN (?, ?) ORDER BY id`
    ).all(bundlePreview.edgeBatchId, bundlePreview.recordBatchId);
    assert(audits.every((batch) => batch.auditPhase === 'execute'));
    assert(audits.every((batch) => ['completed', 'completed_with_errors'].includes(batch.status)));
    assert.deepStrictEqual(bundleDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    bundleDb.close();
  }

  await testLockedBundleBackupEpoch();

  // 边和记录完全重复均按 skip；文件内完全重复边保留一个候选；同周期不同事实阻断。
  const duplicateBundlePreview = previewEnergyFlowBundleImport(bundleFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(duplicateBundlePreview.expectedWouldImport, 0);
  assert.strictEqual(duplicateBundlePreview.edgePreview.summary.skipped, 1);
  assert.strictEqual(duplicateBundlePreview.recordPreview.summary.skipped, 1);
  const inputDuplicateEdge = createEdgeRow({ edgeCode: 'EDGE-INPUT-DUPLICATE', sourceReference: 'explicit-edge:EDGE-INPUT-DUPLICATE' });
  const inputDuplicateFile = createWorkbookUpload('energy-flow-edge-input-duplicate.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [inputDuplicateEdge, { ...inputDuplicateEdge }] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]);
  const inputDuplicatePreview = previewEnergyFlowBundleImport(inputDuplicateFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(inputDuplicatePreview.edgePreview.candidateRows.length, 1);
  assert.strictEqual(inputDuplicatePreview.edgePreview.summary.skipped, 1);
  const conflictRecordFile = createWorkbookUpload('energy-flow-record-conflict.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [createRecordRow({ originalValue: 1001 })] }
  ]);
  const conflictRecordPreview = previewEnergyFlowBundleImport(conflictRecordFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(conflictRecordPreview.edgePreview.summary.totalRows, 0);
  assert.strictEqual(conflictRecordPreview.recordPreview.summary.blocked, 1);
  assert(conflictRecordPreview.recordPreview.auditIssues.some((issue) => issue.code === 'CONFLICTING_ENERGY_FLOW_RECORD_PERIOD'));

  // 单工作表 0 候选但另一工作表有候选允许执行；两工作表总候选为 0 时授权拒绝。
  const recordOnlyFile = createWorkbookUpload('energy-flow-record-only.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [createRecordRow({ startUtc: '2026-08-01T00:00:00Z', endUtc: '2026-09-01T00:00:00Z', originalValue: 1200 })] }
  ]);
  const recordOnlyPreview = previewEnergyFlowBundleImport(recordOnlyFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(recordOnlyPreview.edgePreview.candidateRows.length, 0);
  assert.strictEqual(recordOnlyPreview.recordPreview.candidateRows.length, 1);
  const recordOnlyBackupCounter = { count: 0 };
  const recordOnlyExecute = await executeEnergyFlowBundleImport(
    buildExecuteBody(recordOnlyPreview, { edgeBatchId: recordOnlyPreview.edgeBatchId, recordBatchId: recordOnlyPreview.recordBatchId }),
    { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(recordOnlyBackupCounter) }
  );
  assert.strictEqual(recordOnlyExecute.edge.imported, 0);
  assert.strictEqual(recordOnlyExecute.record.imported, 1);
  assert.strictEqual(recordOnlyBackupCounter.count, 1);
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(duplicateBundlePreview, { edgeBatchId: duplicateBundlePreview.edgeBatchId, recordBatchId: duplicateBundlePreview.recordBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub({ count: 0 }) }
    ),
    'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED'
  );

  // 自环、跨模型端点、来源类型、来源映射、单位和错误 JSON 必须阻断。
  const crossModelDb = openDatabase();
  try {
    const crossModelId = Number(crossModelDb.prepare(
      `INSERT INTO energy_flow_models (
         model_code, model_name, source, version, effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-IMPORT-CROSS', '跨模型测试', '隔离测试', 'energy-flow:v1',
                 '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`
    ).run().lastInsertRowid);
    crossModelDb.prepare(
      `INSERT INTO energy_flow_nodes (energy_flow_model_id, node_code, node_name, node_type, x, y, status)
       VALUES (?, 'CROSS-MODEL-NODE', '其他模型节点', 'sink', 20, 20, 'active')`
    ).run(crossModelId);
  } finally {
    crossModelDb.close();
  }
  const invalidBundleFile = createWorkbookUpload('energy-flow-bundle-invalid.xlsx', [
    {
      templateType: 'energy-flow-edges',
      sheetName: '能流边',
      rows: [
        createEdgeRow({ edgeCode: 'SELF-LOOP', toNodeCode: 'SOURCE-A' }),
        createEdgeRow({ edgeCode: 'CROSS-MODEL', toNodeCode: 'CROSS-MODEL-NODE' }),
        createEdgeRow({ edgeCode: 'BAD-SOURCE-TYPE', sourceType: 'unknown' }),
        createEdgeRow({ edgeCode: 'EMPTY-SOURCE', sourceReference: '' }),
        createEdgeRow({ edgeCode: 'BAD-SOURCE-JSON', sourceReference: '{"reference":' }),
        createEdgeRow({ edgeCode: 'BAD-UNIT', unit: 'GJ' })
      ]
    },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]);
  const invalidBundlePreview = previewEnergyFlowBundleImport(invalidBundleFile, { uploadsDir: temporaryUploadsDir });
  const invalidBundleCodes = invalidBundlePreview.edgePreview.auditIssues.map((issue) => issue.code);
  assert(invalidBundleCodes.includes('ENERGY_FLOW_SELF_LOOP_UNSUPPORTED'));
  assert(invalidBundleCodes.includes('ENERGY_FLOW_CROSS_MODEL_ENDPOINT'));
  assert(invalidBundleCodes.includes('INVALID_ENERGY_FLOW_SOURCE_TYPE'));
  assert(invalidBundleCodes.includes('TOPOLOGY_SOURCE_UNMAPPED'));
  assert(invalidBundleCodes.includes('INVALID_SOURCE_MAPPING_JSON'));
  assert(invalidBundleCodes.includes('ENERGY_FLOW_UNIT_INCOMPATIBLE'));

  // A.edge+B.record 和角色串换未形成可信配对，不得污染任一原 preview 批次。
  const pairAFile = createHardCodedBundleUpload(
    'energy-flow-pair-a.xlsx',
    [createEdgeRow({ edgeCode: 'EDGE-PAIR-A', sourceReference: 'explicit-edge:EDGE-PAIR-A' })],
    [createRecordRow({ edgeCode: 'EDGE-PAIR-A', startUtc: '2026-04-01T00:00:00Z', endUtc: '2026-05-01T00:00:00Z' })]
  );
  const pairBFile = createHardCodedBundleUpload(
    'energy-flow-pair-b.xlsx',
    [createEdgeRow({ edgeCode: 'EDGE-PAIR-B', sourceReference: 'explicit-edge:EDGE-PAIR-B' })],
    [createRecordRow({ edgeCode: 'EDGE-PAIR-B', startUtc: '2026-05-01T00:00:00Z', endUtc: '2026-06-01T00:00:00Z' })]
  );
  const pairAPreview = previewEnergyFlowBundleImport(pairAFile, { uploadsDir: temporaryUploadsDir });
  const pairBPreview = previewEnergyFlowBundleImport(pairBFile, { uploadsDir: temporaryUploadsDir });
  const untrustedBackupCounter = { count: 0 };
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(pairAPreview, { edgeBatchId: pairAPreview.edgeBatchId, recordBatchId: pairBPreview.recordBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(untrustedBackupCounter) }
    ),
    'ENERGY_FLOW_BUNDLE_STORED_FILE_MISMATCH'
  );
  assert.strictEqual(untrustedBackupCounter.count, 0);
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(pairAPreview, { edgeBatchId: pairAPreview.recordBatchId, recordBatchId: pairAPreview.edgeBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(untrustedBackupCounter) }
    ),
    'ENERGY_FLOW_BUNDLE_EDGE_OPERATION_MISMATCH'
  );
  const untrustedProbeDb = openDatabase();
  try {
    const probeIds = [
      pairAPreview.edgeBatchId,
      pairAPreview.recordBatchId,
      pairBPreview.edgeBatchId,
      pairBPreview.recordBatchId
    ];
    const placeholders = probeIds.map(() => '?').join(', ');
    const probeBatches = untrustedProbeDb.prepare(
      `SELECT id, audit_phase AS auditPhase, status FROM import_batches WHERE id IN (${placeholders}) ORDER BY id`
    ).all(...probeIds);
    assert.strictEqual(probeBatches.length, 4);
    assert(probeBatches.every((batch) => batch.auditPhase === 'preview'));
    assert(probeBatches.every((batch) => ['completed', 'completed_with_errors'].includes(batch.status)));
  } finally {
    untrustedProbeDb.close();
  }

  // 客户端候选见证和持久化角色元数据篡改必须拒绝，且拒绝发生在备份前。
  const tamperFile = createWorkbookUpload('energy-flow-bundle-tamper.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-TAMPER', sourceReference: 'explicit-edge:EDGE-TAMPER' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [createRecordRow({ edgeCode: 'EDGE-TAMPER', startUtc: '2026-09-01T00:00:00Z', endUtc: '2026-10-01T00:00:00Z' })] }
  ]);
  const tamperPreview = previewEnergyFlowBundleImport(tamperFile, { uploadsDir: temporaryUploadsDir });
  const tamperBody = buildExecuteBody(tamperPreview, { edgeBatchId: tamperPreview.edgeBatchId, recordBatchId: tamperPreview.recordBatchId });
  tamperBody.candidateRows = tamperBody.candidateRows.map((row, index) => index === 0 ? { ...row, edgeCode: 'FORGED' } : row);
  const tamperBackupCounter = { count: 0 };
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(tamperBody, { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub(tamperBackupCounter) }),
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'
  );
  assert.strictEqual(tamperBackupCounter.count, 0);

  const metadataFile = createWorkbookUpload('energy-flow-bundle-metadata.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-METADATA', sourceReference: 'explicit-edge:EDGE-METADATA' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]);
  const metadataPreview = previewEnergyFlowBundleImport(metadataFile, { uploadsDir: temporaryUploadsDir });
  const metadataDb = openDatabase();
  try {
    const batch = metadataDb.prepare('SELECT audit_context_json AS auditContextJson FROM import_batches WHERE id = ?').get(metadataPreview.edgeBatchId);
    const auditContext = JSON.parse(batch.auditContextJson);
    auditContext.operation = 'forged-operation';
    metadataDb.prepare('UPDATE import_batches SET audit_context_json = ? WHERE id = ?').run(JSON.stringify(auditContext), metadataPreview.edgeBatchId);
  } finally {
    metadataDb.close();
  }
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(metadataPreview, { edgeBatchId: metadataPreview.edgeBatchId, recordBatchId: metadataPreview.recordBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub({ count: 0 }) }
    ),
    'ENERGY_FLOW_BUNDLE_EDGE_OPERATION_MISMATCH'
  );
  const metadataProbeDb = openDatabase();
  try {
    const metadataBatches = metadataProbeDb.prepare(
      `SELECT audit_phase AS auditPhase, status FROM import_batches WHERE id IN (?, ?) ORDER BY id`
    ).all(metadataPreview.edgeBatchId, metadataPreview.recordBatchId);
    assert(metadataBatches.every((batch) => batch.auditPhase === 'preview'));
  } finally {
    metadataProbeDb.close();
  }

  // 备份失败时业务表不变；插入中途失败时边、记录和两个成功审计全部回滚。
  const backupFailFile = createWorkbookUpload('energy-flow-bundle-backup-fail.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-BACKUP-FAIL', sourceReference: 'explicit-edge:EDGE-BACKUP-FAIL' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]);
  const backupFailPreview = previewEnergyFlowBundleImport(backupFailFile, { uploadsDir: temporaryUploadsDir });
  const edgeCountBeforeBackupFailure = countRows('energy_flow_edges');
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(backupFailPreview, { edgeBatchId: backupFailPreview.edgeBatchId, recordBatchId: backupFailPreview.recordBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: async () => { throw new Error(`backup failed: ${temporaryRoot}`); } }
    ),
    'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED'
  );
  assert.strictEqual(countRows('energy_flow_edges'), edgeCountBeforeBackupFailure);
  const backupFailureDb = openDatabase();
  try {
    const failedBatches = backupFailureDb.prepare(
      `SELECT audit_phase AS auditPhase, status, execute_result_json AS executeResultJson
       FROM import_batches WHERE id IN (?, ?) ORDER BY id`
    ).all(backupFailPreview.edgeBatchId, backupFailPreview.recordBatchId);
    assert(failedBatches.every((batch) => batch.auditPhase === 'execute' && batch.status === 'failed'));
    assert(failedBatches.every((batch) => !String(batch.executeResultJson).includes(temporaryRoot)));
    assert(failedBatches.every((batch) => !String(batch.executeResultJson).includes('backup failed')));
  } finally {
    backupFailureDb.close();
  }

  const rollbackFile = createWorkbookUpload('energy-flow-bundle-rollback.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-ROLLBACK', sourceReference: 'explicit-edge:EDGE-ROLLBACK' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [createRecordRow({ edgeCode: 'EDGE-ROLLBACK', startUtc: '2026-10-01T00:00:00Z', endUtc: '2026-11-01T00:00:00Z' })] }
  ]);
  const rollbackPreview = previewEnergyFlowBundleImport(rollbackFile, { uploadsDir: temporaryUploadsDir });
  const edgeCountBeforeRollback = countRows('energy_flow_edges');
  const recordCountBeforeRollback = countRows('energy_flow_records');
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(rollbackPreview, { edgeBatchId: rollbackPreview.edgeBatchId, recordBatchId: rollbackPreview.recordBatchId }),
      {
        uploadsDir: temporaryUploadsDir,
        createBackup: createBackupStub({ count: 0 }),
        afterInsertRecord: () => { throw new Error(`force transaction rollback: ${temporaryRoot}`); }
      }
    ),
    'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
  );
  assert.strictEqual(countRows('energy_flow_edges'), edgeCountBeforeRollback);
  assert.strictEqual(countRows('energy_flow_records'), recordCountBeforeRollback);
  const rollbackDb = openDatabase();
  try {
    const rollbackAudits = rollbackDb.prepare(
      `SELECT audit_phase AS auditPhase, status, execute_result_json AS executeResultJson
       FROM import_batches WHERE id IN (?, ?) ORDER BY id`
    ).all(rollbackPreview.edgeBatchId, rollbackPreview.recordBatchId);
    assert.strictEqual(rollbackAudits.length, 2);
    assert(rollbackAudits.every((batch) => batch.auditPhase === 'execute' && batch.status === 'failed'));
    assert(rollbackAudits.every((batch) => !String(batch.executeResultJson).includes(temporaryRoot)));
    assert(rollbackAudits.every((batch) => !String(batch.executeResultJson).includes('force transaction rollback')));
    assert.deepStrictEqual(rollbackDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    rollbackDb.close();
  }

  // 并发数据库变化必须在事务内重算导致签名失效，不能使用旧客户端候选写入。
  const staleFile = createWorkbookUpload('energy-flow-bundle-stale.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-STALE', sourceReference: 'explicit-edge:EDGE-STALE' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]);
  const stalePreview = previewEnergyFlowBundleImport(staleFile, { uploadsDir: temporaryUploadsDir });
  const staleBackupCounter = { count: 0 };
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(stalePreview, { edgeBatchId: stalePreview.edgeBatchId, recordBatchId: stalePreview.recordBatchId }),
      {
        uploadsDir: temporaryUploadsDir,
        createBackup: createBackupStub(staleBackupCounter),
        beforeBundleBeginImmediate: () => {
          const staleDb = openDatabase();
          try {
            const energyTypeId = staleDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
            staleDb.prepare(
              `INSERT INTO energy_flow_edges (
                 energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
                 unit, source_type, source_mapping_json, status
               ) VALUES (?, 'EDGE-STALE', ?, ?, ?, 'kWh', 'explicit_edge_value', ?, 'active')`
            ).run(master.modelId, master.sourceNodeId, master.sinkNodeId, energyTypeId, JSON.stringify({ reference: 'explicit-edge:EDGE-STALE' }));
          } finally {
            staleDb.close();
          }
        }
      }
    ),
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH'
  );
  assert.strictEqual(staleBackupCounter.count, 0, '锁内 stale 重算必须在备份前回滚。');

  // 文件内容被替换、CSV、损坏和缺工作表均必须拒绝。
  const fileTamperPreview = previewEnergyFlowBundleImport(createWorkbookUpload('energy-flow-file-tamper.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-FILE-TAMPER', sourceReference: 'explicit-edge:EDGE-FILE-TAMPER' })] },
    { templateType: 'energy-flow-edges', sheetName: '显式边值', rows: [] }
  ]), { uploadsDir: temporaryUploadsDir });
  fs.appendFileSync(path.join(temporaryUploadsDir, 'energy-flow-file-tamper.xlsx'), Buffer.from([0]));
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(fileTamperPreview, { edgeBatchId: fileTamperPreview.edgeBatchId, recordBatchId: fileTamperPreview.recordBatchId }),
      { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub({ count: 0 }) }
    ),
    'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH'
  );

  const csvFile = createCsvUpload('energy-flow-bundle.csv', '模型编码,模型版本\nFLOW-IMPORT-001,energy-flow:v1\n');
  await assertRejectsWithCode(
    () => Promise.resolve(previewEnergyFlowBundleImport(csvFile, { uploadsDir: temporaryUploadsDir })),
    'ENERGY_FLOW_BUNDLE_XLSX_REQUIRED'
  );
  const corruptedFile = createCsvUpload('energy-flow-corrupted.xlsx', 'not-an-xlsx');
  await assertRejectsWithCode(
    () => Promise.resolve().then(() => previewEnergyFlowBundleImport(corruptedFile, { uploadsDir: temporaryUploadsDir })),
    'INVALID_TEMPLATE_WORKBOOK_FORMAT'
  );
  const missingSheetFile = createWorkbookUpload('energy-flow-missing-sheet.xlsx', [
    { templateType: 'energy-flow-edges', sheetName: '能流边', rows: [createEdgeRow({ edgeCode: 'EDGE-MISSING-SHEET' })] }
  ]);
  const missingSheetPreview = previewEnergyFlowBundleImport(missingSheetFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(missingSheetPreview.expectedWouldImport, 0);
  assert(missingSheetPreview.previewAudit.auditIssues.some((issue) => issue.code === 'MISSING_TEMPLATE_SHEET'));

  // 直接 build 仍保持 preview 零业务写，并支持数据库注入。
  const directBuildDb = openDatabase();
  try {
    const directBuffer = fs.readFileSync(bundleFile.path);
    const countBeforeDirectBuild = Number(directBuildDb.prepare('SELECT COUNT(*) AS count FROM energy_flow_records').get().count);
    buildEnergyFlowBundleImportPreview({ db: directBuildDb, buffer: directBuffer, originalFilename: bundleFile.originalname });
    assert.strictEqual(Number(directBuildDb.prepare('SELECT COUNT(*) AS count FROM energy_flow_records').get().count), countBeforeDirectBuild);
    assert.deepStrictEqual(directBuildDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    directBuildDb.close();
  }

  console.log('energyFlowImportService tests passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_error) {
      // Windows 下 SQLite 句柄异常时由系统临时目录后续清理。
    }
  });
