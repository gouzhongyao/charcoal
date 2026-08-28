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
const { createDemoContext, sha256Buffer } = require('../services/demoContextService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY
} = require('../services/energyAnalysisImportCore');
const {
  getEnergyAnalysisTemplateDefinition
} = require('../services/energyAnalysisTemplateService');
const {
  ENERGY_FLOW_EDGE_BATCH_CONTRACT,
  ENERGY_FLOW_MODEL_IMPORT_DESCRIPTOR,
  ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR,
  ENERGY_FLOW_RECORD_BATCH_CONTRACT,
  buildEnergyFlowBundleImportPreview,
  executeEnergyFlowBundleImport,
  executeEnergyFlowModelImport,
  executeEnergyFlowNodeImport,
  previewEnergyFlowBundleImport,
  previewEnergyFlowModelImport,
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
 * 创建模型和节点使用的客户端最小 execute 请求体。
 * @param {object} preview 单批次 preview 响应。
 * @returns {object} 最小 execute 请求体。
 */
function buildSingleBatchExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 为隔离上传文件创建同一 active run 下的托管演示 context。 */
function createManagedDemoContext(input) {
  const context = createDemoContext({
    userId: input.actorUserId,
    runId: input.runId,
    artifactKey: input.artifactKey,
    handlerKey: input.handlerKey,
    artifactFileSha256: sha256Buffer(fs.readFileSync(input.file.path))
  });
  return {
    token: context.token,
    userId: input.actorUserId,
    artifactKey: input.artifactKey,
    handlerKey: input.handlerKey
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
function createModelRow(overrides = {}) {
  return {
    modelCode: 'FLOW-MODEL-IMPORT',
    modelName: '批量导入模型',
    source: '隔离测试导入',
    documentNo: 'FLOW-MODEL-DOC-2026',
    version: 'v1',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active',
    ...overrides
  };
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
  assert.deepStrictEqual(ENERGY_FLOW_MODEL_IMPORT_DESCRIPTOR.demoOwnership, {
    artifactKey: '22-energy-flow-models',
    entityType: 'energy_flow_model',
    batchRole: 'primary',
    expectedImportType: 'energy_flow_model'
  });
  assert.deepStrictEqual(ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR.demoOwnership, {
    artifactKey: '23-energy-flow-nodes',
    entityType: 'energy_flow_node',
    batchRole: 'primary',
    expectedImportType: 'energy_flow_node'
  });
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

  // 空库中节点必须因模型缺失而阻断；模型 preview 零写入，execute 后节点可正常 preview。
  const importedModelRow = createModelRow();
  const dependentNodeRow = createNodeRow({
    modelCode: importedModelRow.modelCode,
    modelName: importedModelRow.modelName,
    modelSource: importedModelRow.source,
    modelDocumentNo: importedModelRow.documentNo,
    modelVersion: importedModelRow.version,
    modelEffectiveStartUtc: importedModelRow.effectiveStartUtc,
    modelEffectiveEndUtc: importedModelRow.effectiveEndUtc,
    sourceTimeZone: importedModelRow.sourceTimeZone,
    nodeCode: 'MODEL-DEPENDENT-NODE',
    organizationUnitCode: ''
  });
  const dependentNodeFile = createWorkbookUpload('energy-flow-node-before-model.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [dependentNodeRow]
  }]);
  const missingModelNodePreview = previewEnergyFlowNodeImport(dependentNodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(missingModelNodePreview.summary.blocked, 1);
  assert(missingModelNodePreview.items[0].issues.some((issue) => issue.code === 'ENERGY_FLOW_MODEL_NOT_FOUND'));

  // 模型编码必须在 preview 使用 CRUD/SQLite 共享 ASCII 合同阻断全角、非法字符、内部空格、空值和超长值。
  const invalidModelCodes = [
    ['fullwidth', 'ＦＬＯＷ-MODEL-IMPORT', 'INVALID_ENERGY_FLOW_IDENTITY'],
    ['character', 'FLOW/MODEL/IMPORT', 'INVALID_ENERGY_FLOW_IDENTITY'],
    ['space', 'FLOW MODEL IMPORT', 'INVALID_ENERGY_FLOW_IDENTITY'],
    ['blank', '   ', 'REQUIRED_FIELD_MISSING'],
    ['too-long', `M${'A'.repeat(128)}`, 'INVALID_ENERGY_FLOW_IDENTITY']
  ];
  invalidModelCodes.forEach(([name, modelCode, expectedIssueCode]) => {
    const invalidModelFile = createWorkbookUpload(`energy-flow-model-${name}.xlsx`, [{
      templateType: 'energy-flow-models',
      sheetName: '能流模型',
      rows: [createModelRow({ modelCode })]
    }]);
    const invalidModelPreview = previewEnergyFlowModelImport(invalidModelFile, { uploadsDir: temporaryUploadsDir });
    assert.strictEqual(invalidModelPreview.expectedWouldImport, 0);
    assert.strictEqual(invalidModelPreview.summary.blocked, 1);
    assert.strictEqual(invalidModelPreview.candidateRows.length, 0);
    assert(invalidModelPreview.items[0].issues.some((issue) => issue.code === expectedIssueCode));
  });

  const maxLengthVersionFile = createWorkbookUpload('energy-flow-model-version-64.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({
      modelCode: 'FLOW-MODEL-VERSION-64',
      version: `V${'1'.repeat(63)}`
    })]
  }]);
  const maxLengthVersionPreview = previewEnergyFlowModelImport(maxLengthVersionFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(maxLengthVersionPreview.expectedWouldImport, 1);
  assert.strictEqual(maxLengthVersionPreview.candidateRows[0].version.length, 64);

  const overLengthVersionFile = createWorkbookUpload('energy-flow-model-version-65.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({
      modelCode: 'FLOW-MODEL-VERSION-65',
      version: `V${'1'.repeat(64)}`
    })]
  }]);
  const overLengthVersionPreview = previewEnergyFlowModelImport(overLengthVersionFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(overLengthVersionPreview.expectedWouldImport, 0);
  assert.strictEqual(overLengthVersionPreview.summary.blocked, 1);
  assert.strictEqual(overLengthVersionPreview.candidateRows.length, 0);
  assert(overLengthVersionPreview.items[0].issues.some((issue) => issue.code === 'INVALID_ENERGY_FLOW_MODEL_VERSION'));

  const modelFile = createWorkbookUpload('energy-flow-models-valid.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [importedModelRow]
  }]);
  const initialModelCount = countRows('energy_flow_models');
  const modelPreview = previewEnergyFlowModelImport(modelFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(modelPreview.confirmText, '确认导入能流模型');
  assert.strictEqual(modelPreview.expectedWouldImport, 1);
  assert.strictEqual(countRows('energy_flow_models'), initialModelCount, '模型 preview 不得写业务表。');
  const actorDb = openDatabase();
  let actorUserId;
  try {
    actorUserId = Number(actorDb.prepare('SELECT id FROM sys_users ORDER BY id LIMIT 1').get().id);
  } finally {
    actorDb.close();
  }
  const blockedVersionBackupCounter = { count: 0 };
  const modelCountBeforeBlockedVersionExecute = countRows('energy_flow_models');
  await assertRejectsWithCode(
    () => executeEnergyFlowModelImport(
      buildSingleBatchExecuteBody(overLengthVersionPreview),
      {
        uploadsDir: temporaryUploadsDir,
        actorUserId,
        actorIp: '127.0.0.1',
        createBackup: createBackupStub(blockedVersionBackupCounter)
      }
    ),
    'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED'
  );
  assert.strictEqual(blockedVersionBackupCounter.count, 0, '65 字符模型版本 execute 必须在备份前拒绝。');
  assert.strictEqual(countRows('energy_flow_models'), modelCountBeforeBlockedVersionExecute, '65 字符模型版本不得写业务数据。');

  const modelBackupCounter = { count: 0 };
  const modelExecute = await executeEnergyFlowModelImport(
    buildSingleBatchExecuteBody(modelPreview),
    {
      uploadsDir: temporaryUploadsDir,
      actorUserId,
      actorIp: '127.0.0.1',
      createBackup: createBackupStub(modelBackupCounter)
    }
  );
  assert.strictEqual(modelExecute.imported, 1);
  assert.strictEqual(modelBackupCounter.count, 1);
  assert.strictEqual(countRows('energy_flow_models'), initialModelCount + 1);
  const importedModelProvenanceDb = openDatabase();
  try {
    const importedModelProvenance = importedModelProvenanceDb.prepare(
      `SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
       FROM energy_flow_models WHERE id = ?`
    ).get(modelExecute.importedIds[0]);
    assert.strictEqual(importedModelProvenance.sourceBatchId, modelPreview.batchId,
      '正式 22 execute 必须把服务端当前批次写入 source_batch_id。');
    assert.strictEqual(importedModelProvenance.sourceRowNumber, modelPreview.candidateRows[0].sourceRowNumber,
      '正式 22 execute 必须把候选物理来源行写入 source_row_number。');
    assert.strictEqual(importedModelProvenanceDb.prepare(
      `SELECT COUNT(*) AS total FROM demo_data_registry
       WHERE entity_type = 'energy_flow_model' AND entity_pk = ?`
    ).get(String(modelExecute.importedIds[0])).total, 0,
    '无 demoContext 的正式 22 execute 不得写入 demo registry。');
  } finally {
    importedModelProvenanceDb.close();
  }

  // 备份前原文件摘要失败不得污染 preview 批次；恢复原文件后同一批次必须可重试成功。
  const retryModelFile = createWorkbookUpload('energy-flow-models-retry.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({ modelCode: 'FLOW-MODEL-RETRY', modelName: '原文件恢复重试模型' })]
  }]);
  const retryModelPreview = previewEnergyFlowModelImport(retryModelFile, { uploadsDir: temporaryUploadsDir });
  const originalRetryModelBuffer = fs.readFileSync(retryModelFile.path);
  fs.writeFileSync(retryModelFile.path, Buffer.alloc(originalRetryModelBuffer.length, 0x78));
  const retryBackupCounter = { count: 0 };
  await assertRejectsWithCode(
    () => executeEnergyFlowModelImport(
      buildSingleBatchExecuteBody(retryModelPreview),
      {
        uploadsDir: temporaryUploadsDir,
        actorUserId,
        actorIp: '127.0.0.1',
        createBackup: createBackupStub(retryBackupCounter)
      }
    ),
    'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH'
  );
  assert.strictEqual(retryBackupCounter.count, 0, '原文件摘要失败不得进入备份。');
  const retryPreviewDb = openDatabase();
  try {
    const batch = retryPreviewDb.prepare(
      'SELECT audit_phase AS auditPhase, status FROM import_batches WHERE id = ?'
    ).get(retryModelPreview.batchId);
    assert.strictEqual(batch.auditPhase, 'preview');
    assert(['completed', 'completed_with_errors'].includes(batch.status));
  } finally {
    retryPreviewDb.close();
  }
  fs.writeFileSync(retryModelFile.path, originalRetryModelBuffer);
  const retryModelExecute = await executeEnergyFlowModelImport(
    buildSingleBatchExecuteBody(retryModelPreview),
    {
      uploadsDir: temporaryUploadsDir,
      actorUserId,
      actorIp: '127.0.0.1',
      createBackup: createBackupStub(retryBackupCounter)
    }
  );
  assert.strictEqual(retryModelExecute.imported, 1);
  assert.strictEqual(retryBackupCounter.count, 1);

  const dependentNodePreview = previewEnergyFlowNodeImport(dependentNodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(dependentNodePreview.expectedWouldImport, 1);
  const duplicateModelPreview = previewEnergyFlowModelImport(modelFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(duplicateModelPreview.expectedWouldImport, 0);
  assert.strictEqual(duplicateModelPreview.summary.skipped, 1);
  const canonicalModelFile = createWorkbookUpload('energy-flow-models-canonical-skip.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({ modelCode: 'flow-model-import', version: 'V1' })]
  }]);
  const canonicalModelPreview = previewEnergyFlowModelImport(canonicalModelFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalModelPreview.expectedWouldImport, 0);
  assert.strictEqual(canonicalModelPreview.summary.skipped, 1);
  const nfkcModelDb = openDatabase();
  try {
    nfkcModelDb.prepare(
      `INSERT INTO energy_flow_models (
         model_code, model_name, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-MODEL-NFKC-EXISTING', '批量导入模型', '隔离测试导入',
         'FLOW-MODEL-DOC-2026', 'V１', '2026-01-01T00:00:00Z',
         '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`
    ).run();
  } finally {
    nfkcModelDb.close();
  }
  const nfkcModelFile = createWorkbookUpload('energy-flow-models-nfkc-skip.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({ modelCode: 'flow-model-nfkc-existing', version: 'V1' })]
  }]);
  const nfkcModelPreview = previewEnergyFlowModelImport(nfkcModelFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(nfkcModelPreview.expectedWouldImport, 0);
  assert.strictEqual(nfkcModelPreview.summary.skipped, 1);
  const canonicalModelConflictFile = createWorkbookUpload('energy-flow-models-canonical-conflict.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [
      createModelRow({ modelCode: 'FLOW-MODEL-CANONICAL-CONFLICT', version: 'v1' }),
      createModelRow({ modelCode: 'flow-model-canonical-conflict', version: 'V1', modelName: '规范键冲突名称' })
    ]
  }]);
  const canonicalModelConflictPreview = previewEnergyFlowModelImport(canonicalModelConflictFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalModelConflictPreview.summary.blocked, 2);
  assert(canonicalModelConflictPreview.auditIssues.some((issue) => issue.code === 'CONFLICTING_ENERGY_FLOW_MODEL_VERSION'));
  const conflictingModelFile = createWorkbookUpload('energy-flow-models-conflict.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [createModelRow({ modelName: '冲突名称' })]
  }]);
  const conflictingModelPreview = previewEnergyFlowModelImport(conflictingModelFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(conflictingModelPreview.summary.blocked, 1);
  assert(conflictingModelPreview.items[0].issues.some((issue) => issue.code === 'CONFLICTING_ENERGY_FLOW_MODEL_VERSION'));
  const modelAuditDb = openDatabase();
  try {
    assert.strictEqual(modelAuditDb.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'energy-flow-model-import'").get().total, 2);
  } finally {
    modelAuditDb.close();
  }

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
    buildSingleBatchExecuteBody(nodePreview),
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
    assert.strictEqual(nodeDb.prepare(
      `SELECT COUNT(*) AS total FROM demo_data_registry
       WHERE entity_type = 'energy_flow_node' AND entity_pk = ?`
    ).get(String(nodeExecute.importedIds[0])).total, 0,
    '无 demoContext 的正式 23 execute 不得写入 demo registry。');
  } finally {
    nodeDb.close();
  }

  // 22/23/24 演示链路必须在同一 run 原子登记 ownership，并由服务端生成完整 contains 关系。
  toggleDemoRuntime({ enabled: true, actorUserId, actorIp: '127.0.0.1' });
  const demoRun = getOrCreateActiveDemoDatasetRun({ actorUserId, actorIp: '127.0.0.1' });
  const demoModelRow = createModelRow({
    modelCode: 'FLOW-DEMO-OWNERSHIP',
    modelName: '演示 ownership 能流模型',
    source: '演示 ownership 隔离测试',
    documentNo: 'FLOW-DEMO-OWNERSHIP-2026',
    version: 'energy-flow:v1'
  });
  const demoModelFile = createWorkbookUpload('energy-flow-demo-model.xlsx', [{
    templateType: 'energy-flow-models',
    sheetName: '能流模型',
    rows: [demoModelRow]
  }]);
  const demoModelContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '22-energy-flow-models',
    handlerKey: 'energy-flow-models-import',
    file: demoModelFile
  });
  const demoModelPreview = previewEnergyFlowModelImport(demoModelFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: demoModelContext
  });
  const demoModelExecute = await executeEnergyFlowModelImport(
    buildSingleBatchExecuteBody(demoModelPreview),
    {
      uploadsDir: temporaryUploadsDir,
      actorUserId,
      actorIp: '127.0.0.1',
      demoContext: demoModelContext,
      createBackup: createBackupStub({ count: 0 })
    }
  );
  assert.strictEqual(demoModelExecute.ownership.registrationCount, 1);
  const demoModelId = demoModelExecute.importedIds[0];

  const demoNodeRows = [
    createNodeRow({
      modelCode: demoModelRow.modelCode,
      modelName: demoModelRow.modelName,
      modelSource: demoModelRow.source,
      modelDocumentNo: demoModelRow.documentNo,
      modelVersion: demoModelRow.version,
      modelEffectiveStartUtc: demoModelRow.effectiveStartUtc,
      modelEffectiveEndUtc: demoModelRow.effectiveEndUtc,
      sourceTimeZone: demoModelRow.sourceTimeZone,
      nodeCode: 'DEMO-SOURCE',
      nodeName: '演示源节点',
      nodeType: 'source',
      organizationUnitCode: '',
      x: 10,
      y: 20
    }),
    createNodeRow({
      modelCode: demoModelRow.modelCode,
      modelName: demoModelRow.modelName,
      modelSource: demoModelRow.source,
      modelDocumentNo: demoModelRow.documentNo,
      modelVersion: demoModelRow.version,
      modelEffectiveStartUtc: demoModelRow.effectiveStartUtc,
      modelEffectiveEndUtc: demoModelRow.effectiveEndUtc,
      sourceTimeZone: demoModelRow.sourceTimeZone,
      nodeCode: 'DEMO-SINK',
      nodeName: '演示汇节点',
      nodeType: 'sink',
      organizationUnitCode: '',
      x: 30,
      y: 40
    })
  ];
  const demoNodeFile = createWorkbookUpload('energy-flow-demo-nodes.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: demoNodeRows
  }]);
  const demoNodeContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '23-energy-flow-nodes',
    handlerKey: 'energy-flow-nodes-import',
    file: demoNodeFile
  });
  const demoNodePreview = previewEnergyFlowNodeImport(demoNodeFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: demoNodeContext
  });
  const demoNodeExecute = await executeEnergyFlowNodeImport(
    buildSingleBatchExecuteBody(demoNodePreview),
    {
      uploadsDir: temporaryUploadsDir,
      demoContext: demoNodeContext,
      createBackup: createBackupStub({ count: 0 })
    }
  );
  assert.strictEqual(demoNodeExecute.ownership.registrationCount, 2);

  const demoBundleFile = createHardCodedBundleUpload(
    'energy-flow-demo-bundle.xlsx',
    [createEdgeRow({
      modelCode: demoModelRow.modelCode,
      modelVersion: demoModelRow.version,
      edgeCode: 'DEMO-EDGE',
      fromNodeCode: 'DEMO-SOURCE',
      toNodeCode: 'DEMO-SINK',
      sourceReference: 'demo:edge:DEMO-EDGE'
    })],
    [createRecordRow({
      modelCode: demoModelRow.modelCode,
      modelVersion: demoModelRow.version,
      edgeCode: 'DEMO-EDGE',
      sourceReference: 'demo:record:DEMO-EDGE'
    })]
  );
  const demoBundleContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '24-energy-flow-edges',
    handlerKey: 'energy-flow-bundle-import',
    file: demoBundleFile
  });
  const demoBundlePreview = previewEnergyFlowBundleImport(demoBundleFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: demoBundleContext,
    createUploadGroupId: () => 'flow-demo-ownership-group'
  });
  const demoBundleBody = buildExecuteBody(demoBundlePreview, {
    edgeBatchId: demoBundlePreview.edgeBatchId,
    recordBatchId: demoBundlePreview.recordBatchId
  });
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      { ...demoBundleBody, relations: [] },
      {
        uploadsDir: temporaryUploadsDir,
        demoContext: demoBundleContext,
        createBackup: createBackupStub({ count: 0 })
      }
    ),
    'ENERGY_FLOW_BUNDLE_CLIENT_RELATIONS_FORBIDDEN'
  );
  const demoBundleExecute = await executeEnergyFlowBundleImport(
    demoBundleBody,
    {
      uploadsDir: temporaryUploadsDir,
      demoContext: demoBundleContext,
      createBackup: createBackupStub({ count: 0 })
    }
  );
  assert.strictEqual(demoBundleExecute.edge.ownership.registrationCount, 2);
  assert.strictEqual(demoBundleExecute.edge.ownership.relationCount, 5);
  const demoOwnedEdgeId = demoBundleExecute.edge.importedIds[0];
  const demoOwnedRecordId = demoBundleExecute.record.importedIds[0];
  const demoOwnershipDb = openDatabase();
  try {
    const modelRegistry = demoOwnershipDb.prepare(`SELECT entity_pk AS entityPk, source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '22-energy-flow-models' AND entity_type = 'energy_flow_model'`).get(demoRun.runId);
    assert(modelRegistry, 'artifact 22 必须登记真实 energy_flow_model ownership。');
    assert.strictEqual(Number(modelRegistry.entityPk), demoModelId);
    assert.strictEqual(Number(modelRegistry.sourceBatchId), demoModelPreview.batchId);
    assert.strictEqual(Number(modelRegistry.sourceRowNumber), demoModelPreview.candidateRows[0].sourceRowNumber);
    const modelBusinessRow = demoOwnershipDb.prepare(`SELECT source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM energy_flow_models WHERE id = ?`).get(demoModelId);
    assert.strictEqual(modelBusinessRow.sourceBatchId, demoModelPreview.batchId);
    assert.strictEqual(modelBusinessRow.sourceRowNumber, demoModelPreview.candidateRows[0].sourceRowNumber);

    const nodeRegistry = demoOwnershipDb.prepare(`SELECT entity_pk AS entityPk, source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '23-energy-flow-nodes' AND entity_type = 'energy_flow_node'
      ORDER BY registry_id`).all(demoRun.runId);
    assert.strictEqual(nodeRegistry.length, 2);
    assert(nodeRegistry.every((row) => Number(row.sourceBatchId) === demoNodePreview.batchId));
    assert.deepStrictEqual(nodeRegistry.map((row) => Number(row.sourceRowNumber)), [2, 3]);

    const relations = demoOwnershipDb.prepare(`SELECT parent.entity_type AS fromEntityType,
        parent.entity_pk AS fromEntityPk, child.entity_type AS toEntityType,
        child.entity_pk AS toEntityPk, relation.relation_type AS relationType
      FROM demo_data_relations relation
      JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
      JOIN demo_data_registry child ON child.registry_id = relation.to_registry_id
      WHERE relation.run_id = ? ORDER BY parent.entity_type, parent.entity_pk, child.entity_type, child.entity_pk`
    ).all(demoRun.runId);
    assert.deepStrictEqual(relations, [
      { fromEntityType: 'energy_flow_edge', fromEntityPk: String(demoOwnedEdgeId), toEntityType: 'energy_flow_record', toEntityPk: String(demoOwnedRecordId), relationType: 'contains' },
      { fromEntityType: 'energy_flow_model', fromEntityPk: String(demoModelId), toEntityType: 'energy_flow_edge', toEntityPk: String(demoOwnedEdgeId), relationType: 'contains' },
      { fromEntityType: 'energy_flow_model', fromEntityPk: String(demoModelId), toEntityType: 'energy_flow_node', toEntityPk: String(nodeRegistry[0].entityPk), relationType: 'contains' },
      { fromEntityType: 'energy_flow_model', fromEntityPk: String(demoModelId), toEntityType: 'energy_flow_node', toEntityPk: String(nodeRegistry[1].entityPk), relationType: 'contains' },
      { fromEntityType: 'energy_flow_model', fromEntityPk: String(demoModelId), toEntityType: 'energy_flow_record', toEntityPk: String(demoOwnedRecordId), relationType: 'contains' }
    ]);
  } finally {
    demoOwnershipDb.close();
  }

  // managed record-only 必须为同 run 已 owned existing edge 生成 edge→record；model→record 也必须同事务登记。
  const demoRecordOnlyFile = createHardCodedBundleUpload(
    'energy-flow-demo-record-only-owned.xlsx',
    [],
    [createRecordRow({
      modelCode: demoModelRow.modelCode,
      modelVersion: demoModelRow.version,
      edgeCode: 'DEMO-EDGE',
      startUtc: '2027-01-01T00:00:00Z',
      endUtc: '2027-02-01T00:00:00Z',
      originalValue: 1300,
      sourceReference: 'demo:record:DEMO-EDGE:record-only-owned'
    })]
  );
  const demoRecordOnlyContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '24-energy-flow-edges',
    handlerKey: 'energy-flow-bundle-import',
    file: demoRecordOnlyFile
  });
  const demoRecordOnlyPreview = previewEnergyFlowBundleImport(demoRecordOnlyFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: demoRecordOnlyContext,
    createUploadGroupId: () => 'flow-demo-record-only-owned'
  });
  assert.strictEqual(demoRecordOnlyPreview.edgePreview.candidateRows.length, 0);
  assert.strictEqual(demoRecordOnlyPreview.recordPreview.candidateRows.length, 1);
  assert.strictEqual(demoRecordOnlyPreview.recordPreview.candidateRows[0].edgeReferenceKind, 'existing');
  assert.strictEqual(demoRecordOnlyPreview.recordPreview.candidateRows[0].existingEdgeId, demoOwnedEdgeId);
  const demoRecordOnlyExecute = await executeEnergyFlowBundleImport(
    buildExecuteBody(demoRecordOnlyPreview, {
      edgeBatchId: demoRecordOnlyPreview.edgeBatchId,
      recordBatchId: demoRecordOnlyPreview.recordBatchId
    }),
    {
      uploadsDir: temporaryUploadsDir,
      demoContext: demoRecordOnlyContext,
      createBackup: createBackupStub({ count: 0 })
    }
  );
  assert.strictEqual(demoRecordOnlyExecute.edge.imported, 0);
  assert.strictEqual(demoRecordOnlyExecute.record.imported, 1);
  assert.strictEqual(demoRecordOnlyExecute.record.ownership.registrationCount, 1);
  assert.strictEqual(demoRecordOnlyExecute.record.ownership.relationCount, 4,
    'record-only 关系输入应包含已有 model→nodes、model→record 和 existing edge→record。');
  const demoRecordOnlyId = demoRecordOnlyExecute.record.importedIds[0];
  const ownedRecordRelationDb = openDatabase();
  try {
    assert.strictEqual(ownedRecordRelationDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
      JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
      JOIN demo_data_registry child ON child.registry_id = relation.to_registry_id
      WHERE relation.run_id = ? AND relation.relation_type = 'contains'
        AND parent.entity_type = 'energy_flow_edge' AND parent.entity_pk = ?
        AND child.entity_type = 'energy_flow_record' AND child.entity_pk = ?`).get(
      demoRun.runId, String(demoOwnedEdgeId), String(demoRecordOnlyId)
    ).total, 1, '同 run existing edge 必须生成 edge→record contains。');
    assert.strictEqual(ownedRecordRelationDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations relation
      JOIN demo_data_registry parent ON parent.registry_id = relation.from_registry_id
      JOIN demo_data_registry child ON child.registry_id = relation.to_registry_id
      WHERE relation.run_id = ? AND relation.relation_type = 'contains'
        AND parent.entity_type = 'energy_flow_model' AND parent.entity_pk = ?
        AND child.entity_type = 'energy_flow_record' AND child.entity_pk = ?`).get(
      demoRun.runId, String(demoModelId), String(demoRecordOnlyId)
    ).total, 1, '同 run record-only 必须生成 model→record contains。');
    assert.strictEqual(ownedRecordRelationDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'energy_flow_record' AND entity_pk = ?`).get(
      demoRun.runId, String(demoRecordOnlyId)
    ).total, 1);
  } finally {
    ownedRecordRelationDb.close();
  }

  // 未纳管正式 edge 不得被接管；record、registry、relation 必须随 ownership 端点失败整体回滚。
  const unownedEdgeDb = openDatabase();
  let unownedEdgeId;
  try {
    const sourceNodeId = Number(unownedEdgeDb.prepare(`SELECT id FROM energy_flow_nodes
      WHERE energy_flow_model_id = ? AND node_code = 'DEMO-SOURCE'`).get(demoModelId).id);
    const sinkNodeId = Number(unownedEdgeDb.prepare(`SELECT id FROM energy_flow_nodes
      WHERE energy_flow_model_id = ? AND node_code = 'DEMO-SINK'`).get(demoModelId).id);
    const energyTypeId = Number(unownedEdgeDb.prepare(
      `SELECT id FROM energy_types WHERE code = 'electricity' ORDER BY id LIMIT 1`
    ).get().id);
    unownedEdgeId = Number(unownedEdgeDb.prepare(`INSERT INTO energy_flow_edges (
      energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit,
      source_type, source_mapping_json, status
    ) VALUES (?, 'DEMO-UNOWNED-EDGE', ?, ?, ?, 'kWh', 'explicit_edge_value', ?, 'active')`).run(
      demoModelId,
      sourceNodeId,
      sinkNodeId,
      energyTypeId,
      JSON.stringify({ reference: 'formal:DEMO-UNOWNED-EDGE' })
    ).lastInsertRowid);
  } finally {
    unownedEdgeDb.close();
  }
  const unownedRecordFile = createHardCodedBundleUpload(
    'energy-flow-demo-record-only-unowned.xlsx',
    [],
    [createRecordRow({
      modelCode: demoModelRow.modelCode,
      modelVersion: demoModelRow.version,
      edgeCode: 'DEMO-UNOWNED-EDGE',
      startUtc: '2028-01-01T00:00:00Z',
      endUtc: '2028-02-01T00:00:00Z',
      originalValue: 1400,
      sourceReference: 'demo:record:DEMO-UNOWNED-EDGE'
    })]
  );
  const unownedRecordContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '24-energy-flow-edges',
    handlerKey: 'energy-flow-bundle-import',
    file: unownedRecordFile
  });
  const unownedRecordPreview = previewEnergyFlowBundleImport(unownedRecordFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: unownedRecordContext,
    createUploadGroupId: () => 'flow-demo-record-only-unowned'
  });
  assert.strictEqual(unownedRecordPreview.edgePreview.candidateRows.length, 0);
  assert.strictEqual(unownedRecordPreview.recordPreview.candidateRows.length, 1);
  const unownedRecordCountBefore = countRows('energy_flow_records');
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(unownedRecordPreview, {
        edgeBatchId: unownedRecordPreview.edgeBatchId,
        recordBatchId: unownedRecordPreview.recordBatchId
      }),
      {
        uploadsDir: temporaryUploadsDir,
        demoContext: unownedRecordContext,
        createBackup: createBackupStub({ count: 0 })
      }
    ),
    'ENERGY_FLOW_OWNERSHIP_RELATION_ENDPOINT_NOT_OWNED'
  );
  assert.strictEqual(countRows('energy_flow_records'), unownedRecordCountBefore);
  const unownedRollbackDb = openDatabase();
  try {
    assert.strictEqual(unownedRollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'energy_flow_edge' AND entity_pk = ?`).get(
      demoRun.runId, String(unownedEdgeId)
    ).total, 0, '未纳管正式 edge 不得被接管。');
    assert.strictEqual(unownedRollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'energy_flow_record'
        AND source_batch_id = ?`).get(demoRun.runId, unownedRecordPreview.recordBatchId).total, 0,
    'ownership 端点失败后 record registry 必须回滚。');
    assert.strictEqual(unownedRollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations
      WHERE run_id = ? AND relation_type = 'contains'
        AND to_registry_id IN (SELECT registry_id FROM demo_data_registry WHERE source_batch_id = ?)`).get(
      demoRun.runId, unownedRecordPreview.recordBatchId
    ).total, 0, 'ownership 端点失败后 relation 必须回滚。');
  } finally {
    unownedRollbackDb.close();
  }

  // 其它 run 已拥有的 edge 只能返回跨 run 稳定错误码，不能被当前 run 接管或留下孤立 record。
  const crossRunId = 'demo-run-rf-p1-007-cross-run';
  const crossRunDb = openDatabase();
  try {
    const currentRun = crossRunDb.prepare(`SELECT dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, created_by AS createdBy, created_at AS createdAt
      FROM demo_dataset_runs WHERE run_id = ?`).get(demoRun.runId);
    crossRunDb.prepare(`INSERT INTO demo_dataset_runs
      (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run(
      crossRunId,
      currentRun.datasetId,
      currentRun.manifestVersion,
      currentRun.manifestDigest,
      currentRun.createdBy,
      currentRun.createdAt
    );
    crossRunDb.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest, registered_by)
      VALUES (?, '24-energy-flow-edges', 'energy_flow_edge', ?, 'imported', ?, ?, ?)`).run(
      crossRunId,
      String(unownedEdgeId),
      '1'.repeat(64),
      '2'.repeat(64),
      actorUserId
    );
  } finally {
    crossRunDb.close();
  }
  const crossRunRecordFile = createHardCodedBundleUpload(
    'energy-flow-demo-record-only-cross-run.xlsx',
    [],
    [createRecordRow({
      modelCode: demoModelRow.modelCode,
      modelVersion: demoModelRow.version,
      edgeCode: 'DEMO-UNOWNED-EDGE',
      startUtc: '2029-01-01T00:00:00Z',
      endUtc: '2029-02-01T00:00:00Z',
      originalValue: 1500,
      sourceReference: 'demo:record:DEMO-UNOWNED-EDGE:cross-run'
    })]
  );
  const crossRunRecordContext = createManagedDemoContext({
    actorUserId,
    runId: demoRun.runId,
    artifactKey: '24-energy-flow-edges',
    handlerKey: 'energy-flow-bundle-import',
    file: crossRunRecordFile
  });
  const crossRunRecordPreview = previewEnergyFlowBundleImport(crossRunRecordFile, {
    uploadsDir: temporaryUploadsDir,
    demoContext: crossRunRecordContext,
    createUploadGroupId: () => 'flow-demo-record-only-cross-run'
  });
  const crossRunRecordCountBefore = countRows('energy_flow_records');
  await assertRejectsWithCode(
    () => executeEnergyFlowBundleImport(
      buildExecuteBody(crossRunRecordPreview, {
        edgeBatchId: crossRunRecordPreview.edgeBatchId,
        recordBatchId: crossRunRecordPreview.recordBatchId
      }),
      {
        uploadsDir: temporaryUploadsDir,
        demoContext: crossRunRecordContext,
        createBackup: createBackupStub({ count: 0 })
      }
    ),
    'ENERGY_FLOW_OWNERSHIP_RELATION_CROSS_RUN'
  );
  assert.strictEqual(countRows('energy_flow_records'), crossRunRecordCountBefore);
  const crossRunRollbackDb = openDatabase();
  try {
    assert.strictEqual(crossRunRollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'energy_flow_record'
        AND source_batch_id = ?`).get(demoRun.runId, crossRunRecordPreview.recordBatchId).total, 0);
    assert.strictEqual(crossRunRollbackDb.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'energy_flow_edge' AND entity_pk = ?`).get(
      demoRun.runId, String(unownedEdgeId)
    ).total, 0, '跨 run edge ownership 不得被当前 run 接管。');
    assert.strictEqual(crossRunRollbackDb.prepare(`SELECT run_id AS runId FROM demo_data_registry
      WHERE entity_type = 'energy_flow_edge' AND entity_pk = ?`).get(String(unownedEdgeId)).runId, crossRunId);
  } finally {
    crossRunRollbackDb.close();
  }

  // 数据库完全相同节点按 skip，冲突定义、非法模型/枚举/组织/坐标必须阻断。
  const duplicateNodePreview = previewEnergyFlowNodeImport(nodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(duplicateNodePreview.expectedWouldImport, 0);
  assert.strictEqual(duplicateNodePreview.summary.skipped, 1);
  const canonicalNodeFile = createWorkbookUpload('energy-flow-nodes-canonical-skip.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [createNodeRow({
      modelCode: FLOW_MODEL.modelCode.toLowerCase(),
      modelVersion: FLOW_MODEL.modelVersion.toUpperCase(),
      nodeCode: 'process-import'
    })]
  }]);
  const canonicalNodePreview = previewEnergyFlowNodeImport(canonicalNodeFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalNodePreview.expectedWouldImport, 0);
  assert.strictEqual(canonicalNodePreview.summary.skipped, 1);
  const invalidIdentityNodeFile = createWorkbookUpload('energy-flow-nodes-invalid-identity.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [
      createNodeRow({ nodeCode: 'ＮＯＤＥ-FULLWIDTH' }),
      createNodeRow({ nodeCode: 'NODE/INVALID' }),
      createNodeRow({ nodeCode: 'NODE INTERNAL SPACE' }),
      createNodeRow({ nodeCode: `N${'O'.repeat(128)}` })
    ]
  }]);
  const invalidIdentityNodePreview = previewEnergyFlowNodeImport(
    invalidIdentityNodeFile,
    { uploadsDir: temporaryUploadsDir }
  );
  assert.strictEqual(invalidIdentityNodePreview.expectedWouldImport, 0);
  assert.strictEqual(invalidIdentityNodePreview.summary.blocked, 4);
  assert.strictEqual(invalidIdentityNodePreview.candidateRows.length, 0);
  assert(invalidIdentityNodePreview.items.every((item) => (
    item.issues.some((issue) => issue.code === 'INVALID_ENERGY_FLOW_IDENTITY')
  )));
  const canonicalNodeConflictFile = createWorkbookUpload('energy-flow-nodes-canonical-conflict.xlsx', [{
    templateType: 'energy-flow-nodes',
    sheetName: '能流节点',
    rows: [
      createNodeRow({ nodeCode: 'NODE-CANONICAL-CONFLICT' }),
      createNodeRow({ nodeCode: 'node-canonical-conflict', x: 81 })
    ]
  }]);
  const canonicalNodeConflictPreview = previewEnergyFlowNodeImport(canonicalNodeConflictFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalNodeConflictPreview.summary.blocked, 2);
  assert(canonicalNodeConflictPreview.auditIssues.some((issue) => issue.code === 'CONFLICTING_ENERGY_FLOW_NODE'));
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
    [null, createRecordRow({
      startUtc: '2026-07-01T00:00:00.000Z',
      endUtc: '2026-08-01T00:00:00.000Z'
    })]
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
  assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].startUtc, '2026-07-01T00:00:00Z');
  assert.strictEqual(bundlePreview.recordPreview.candidateRows[0].endUtc, '2026-08-01T00:00:00Z');
  assert.strictEqual(countRows('energy_flow_edges'), edgeCountBefore);
  assert.strictEqual(countRows('energy_flow_records'), recordCountBefore);

  const invalidMillisecondBundleFile = createHardCodedBundleUpload(
    'energy-flow-bundle-invalid-millisecond.xlsx',
    [createEdgeRow({
      edgeCode: 'EDGE-INVALID-MILLISECOND',
      sourceReference: 'explicit-edge:EDGE-INVALID-MILLISECOND'
    })],
    [createRecordRow({
      edgeCode: 'EDGE-INVALID-MILLISECOND',
      startUtc: '2026-09-01T00:00:00.001Z',
      endUtc: '2026-10-01T00:00:00Z',
      sourceReference: 'upload:explicit-edge:invalid-millisecond'
    })]
  );
  const invalidMillisecondPreview = previewEnergyFlowBundleImport(
    invalidMillisecondBundleFile,
    { uploadsDir: temporaryUploadsDir }
  );
  assert.strictEqual(invalidMillisecondPreview.recordPreview.summary.blocked, 1);
  assert(invalidMillisecondPreview.recordPreview.auditIssues.some(
    (issue) => issue.code === 'INVALID_START_UTC'
  ));
  assert.strictEqual(invalidMillisecondPreview.recordPreview.candidateRows.length, 0);

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
              source_row_number AS sourceRowNumber, start_utc AS startUtc, end_utc AS endUtc
       FROM energy_flow_records WHERE energy_flow_edge_id = ?`
    ).get(importedEdge.id);
    assert.strictEqual(importedEdge.sourceBatchId, bundlePreview.edgeBatchId);
    assert.strictEqual(importedEdge.sourceRowNumber, 3);
    assert.deepStrictEqual(JSON.parse(importedEdge.sourceMappingJson), { reference: 'explicit-edge:EDGE-IMPORT-001' });
    assert.strictEqual(importedRecord.edgeId, importedEdge.id);
    assert.strictEqual(importedRecord.sourceBatchId, bundlePreview.recordBatchId);
    assert.strictEqual(importedRecord.sourceRowNumber, 3);
    assert.strictEqual(importedRecord.startUtc, '2026-07-01T00:00:00Z');
    assert.strictEqual(importedRecord.endUtc, '2026-08-01T00:00:00Z');
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
  const canonicalBundleFile = createHardCodedBundleUpload(
    'energy-flow-bundle-canonical-skip.xlsx',
    [createEdgeRow({
      modelCode: FLOW_MODEL.modelCode.toLowerCase(),
      modelVersion: FLOW_MODEL.modelVersion.toUpperCase(),
      edgeCode: 'edge-import-001',
      fromNodeCode: 'source-a',
      toNodeCode: 'sink-a'
    })],
    [createRecordRow({
      modelCode: FLOW_MODEL.modelCode.toLowerCase(),
      modelVersion: FLOW_MODEL.modelVersion.toUpperCase(),
      edgeCode: 'edge-import-001'
    })]
  );
  const canonicalBundlePreview = previewEnergyFlowBundleImport(canonicalBundleFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalBundlePreview.expectedWouldImport, 0);
  assert.strictEqual(canonicalBundlePreview.edgePreview.summary.skipped, 1);
  assert.strictEqual(canonicalBundlePreview.recordPreview.summary.skipped, 1);
  const invalidIdentityBundleFile = createHardCodedBundleUpload(
    'energy-flow-bundle-invalid-identity.xlsx',
    [
      createEdgeRow({ edgeCode: 'ＥＤＧＥ-FULLWIDTH' }),
      createEdgeRow({ edgeCode: 'EDGE/INVALID' }),
      createEdgeRow({ edgeCode: 'EDGE INTERNAL SPACE' }),
      createEdgeRow({ edgeCode: `E${'D'.repeat(128)}` })
    ],
    []
  );
  const invalidIdentityBundlePreview = previewEnergyFlowBundleImport(
    invalidIdentityBundleFile,
    { uploadsDir: temporaryUploadsDir }
  );
  assert.strictEqual(invalidIdentityBundlePreview.expectedWouldImport, 0);
  assert.strictEqual(invalidIdentityBundlePreview.edgePreview.summary.blocked, 4);
  assert.strictEqual(invalidIdentityBundlePreview.edgePreview.candidateRows.length, 0);
  assert(invalidIdentityBundlePreview.edgePreview.items.every((item) => (
    item.issues.some((issue) => issue.code === 'INVALID_ENERGY_FLOW_IDENTITY')
  )));
  const canonicalBundleConflictFile = createHardCodedBundleUpload(
    'energy-flow-bundle-canonical-conflict.xlsx',
    [
      createEdgeRow({ edgeCode: 'EDGE-CANONICAL-CONFLICT', sourceReference: 'canonical:edge:first' }),
      createEdgeRow({ edgeCode: 'edge-canonical-conflict', sourceReference: 'canonical:edge:second' })
    ],
    []
  );
  const canonicalBundleConflictPreview = previewEnergyFlowBundleImport(canonicalBundleConflictFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalBundleConflictPreview.edgePreview.summary.blocked, 2);
  assert(canonicalBundleConflictPreview.edgePreview.auditIssues.some((issue) => issue.code === 'CONFLICTING_ENERGY_FLOW_EDGE'));
  const canonicalCandidateFile = createHardCodedBundleUpload(
    'energy-flow-bundle-canonical-candidate.xlsx',
    [createEdgeRow({
      modelCode: FLOW_MODEL.modelCode.toLowerCase(),
      modelVersion: FLOW_MODEL.modelVersion.toUpperCase(),
      edgeCode: 'EDGE-CANONICAL-CANDIDATE',
      fromNodeCode: 'source-a',
      toNodeCode: 'sink-a',
      sourceReference: 'canonical:candidate:edge'
    })],
    [createRecordRow({
      modelCode: FLOW_MODEL.modelCode.toLowerCase(),
      modelVersion: FLOW_MODEL.modelVersion.toUpperCase(),
      edgeCode: 'edge-canonical-candidate',
      startUtc: '2026-12-01T00:00:00Z',
      endUtc: '2027-01-01T00:00:00Z',
      sourceReference: 'canonical:candidate:record'
    })]
  );
  const canonicalCandidatePreview = previewEnergyFlowBundleImport(canonicalCandidateFile, { uploadsDir: temporaryUploadsDir });
  assert.strictEqual(canonicalCandidatePreview.expectedWouldImport, 2);
  assert.strictEqual(canonicalCandidatePreview.recordPreview.candidateRows[0].edgeReferenceKind, 'candidate');
  const canonicalCandidateExecute = await executeEnergyFlowBundleImport(
    buildExecuteBody(canonicalCandidatePreview, {
      edgeBatchId: canonicalCandidatePreview.edgeBatchId,
      recordBatchId: canonicalCandidatePreview.recordBatchId
    }),
    { uploadsDir: temporaryUploadsDir, createBackup: createBackupStub({ count: 0 }) }
  );
  assert.strictEqual(canonicalCandidateExecute.edge.imported, 1);
  assert.strictEqual(canonicalCandidateExecute.record.imported, 1);
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
