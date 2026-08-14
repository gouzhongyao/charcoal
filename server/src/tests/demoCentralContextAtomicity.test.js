'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 中央导入原子性测试只使用系统临时目录和隔离 SQLite、上传及备份路径。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-central-atomicity-'));
const temporaryDataDir = path.join(temporaryRoot, 'data');
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
process.env.DATA_DIR = temporaryDataDir;
process.env.SQLITE_PATH = path.join(temporaryDataDir, 'demo-central-atomicity.sqlite');
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoCentralAtomicity123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'demo-central-atomicity-energy-analysis-secret';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { createDemoContext, sha256Buffer } = require('../services/demoContextService');
const { generateDemoParkArtifact } = require('../services/demoParkDatasetService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const {
  executeShiftDefinitionImport,
  previewShiftDefinitionImport
} = require('../services/energyAnalysisConfigurationImportService');
const {
  previewEnergyFlowBundleImport
} = require('../services/energyFlowImportService');
const {
  executeEnergyBalanceBundleImport,
  previewEnergyBalanceBundleImport
} = require('../services/energyBalanceImportService');

// 测试操作者固定使用隔离库内置管理员。
let actor = null;
// 所有 context 固定绑定同一真实 active demo run。
let demoRun = null;

/** 将 SQL 规范为便于精确识别语句形态的单行文本。 */
function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

/** 生成 artifact 并写入隔离上传目录，返回 Multer 风格文件对象。 */
function createArtifactUpload(artifactKey, suffix) {
  const generated = generateDemoParkArtifact(artifactKey, 'xlsx');
  const filename = `${artifactKey}-${suffix}.xlsx`;
  const filePath = path.join(temporaryUploadsDir, filename);
  fs.writeFileSync(filePath, generated.buffer);
  return {
    artifactKey,
    generated,
    file: {
      originalname: generated.fileName,
      filename,
      size: generated.buffer.length,
      path: filePath
    }
  };
}

/** 为真实生成文件创建与注册表绑定一致的 issued context。 */
function createArtifactContext(upload, handlerKey) {
  return createDemoContext({
    userId: actor.userId,
    runId: demoRun.runId,
    artifactKey: upload.artifactKey,
    handlerKey,
    artifactFileSha256: sha256Buffer(upload.generated.buffer)
  });
}

/** 构造服务只需要的 demo context 投影。 */
function projectDemoContext(context) {
  return {
    token: context.token,
    userId: actor.userId,
    artifactKey: context.artifactKey,
    handlerKey: context.handlerKey
  };
}

/** 构造真实 execute 见证，不自行生成摘要或签名。 */
function buildExecuteBody(preview, ids = {}) {
  return {
    ...ids,
    uploadGroupId: preview.uploadGroupId,
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    duplicateStrategy: preview.duplicateStrategy,
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

/** 返回不会访问真实备份目录的确定性备份结果。 */
async function createIsolatedBackup() {
  return {
    backupName: 'atomicity-test.sqlite',
    reason: 'energy-analysis-import',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    method: 'test-double',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

/** 查询表完整行快照，按主键稳定排序。 */
function snapshotTable(db, tableName, orderBy = 'id') {
  return db.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`).all();
}

/** 查询单个 context 完整行快照。 */
function snapshotContext(db, contextId) {
  return db.prepare('SELECT * FROM demo_import_contexts WHERE context_id = ?').get(contextId);
}

/** 查询指定批次完整行及其全部问题明细。 */
function snapshotAuditBatch(db, batchId) {
  return {
    batch: db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId),
    issues: db.prepare('SELECT * FROM import_errors WHERE batch_id = ? ORDER BY id').all(batchId)
  };
}

/** 查询 context 的全部批次角色 link。 */
function snapshotContextLinks(db, contextId) {
  return db.prepare('SELECT * FROM demo_run_import_batches WHERE context_id = ? ORDER BY id').all(contextId);
}

/** 包装 prepare，只对 context preview CAS 精确返回一次 changes=0。 */
function injectPreviewContextCasMiss(db) {
  const originalPrepare = db.prepare.bind(db);
  let faultCount = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("UPDATE demo_import_contexts SET status = 'previewed', upload_file_sha256 = ?, preview_digest = ?, previewed_at = ?")
      && normalized.includes("status = 'issued'")) {
      return {
        run(...params) {
          if (faultCount === 0) {
            faultCount += 1;
            return { changes: 0 };
          }
          return statement.run(...params);
        }
      };
    }
    return statement;
  };
  return {
    restore() { db.prepare = originalPrepare; },
    getFaultCount() { return faultCount; }
  };
}

/** 包装 prepare，只让第二条 import_batches INSERT 精确抛错一次。 */
function injectSecondAuditBatchInsertFailure(db, failureCode) {
  const originalPrepare = db.prepare.bind(db);
  let matchedInsertCount = 0;
  let faultCount = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('INSERT INTO import_batches ( import_type,')) {
      return {
        run(...params) {
          matchedInsertCount += 1;
          if (matchedInsertCount === 2 && faultCount === 0) {
            faultCount += 1;
            const error = new Error('injected second audit batch failure');
            error.code = failureCode;
            throw error;
          }
          return statement.run(...params);
        }
      };
    }
    return statement;
  };
  return {
    restore() { db.prepare = originalPrepare; },
    getFaultCount() { return faultCount; },
    getMatchedInsertCount() { return matchedInsertCount; }
  };
}

/** 包装 execute 连接，只对 context executed CAS 精确返回一次 changes=0，并阻断随后独立失败审计。 */
function injectExecuteContextCasMiss(db, captureAfterRollback, suppressFailureAudit = true) {
  const originalPrepare = db.prepare.bind(db);
  const originalExec = db.exec.bind(db);
  let contextCasFaultCount = 0;
  let failureAuditFaultCount = 0;
  let rollbackCount = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("UPDATE demo_import_contexts SET status = 'executed', executed_at = ?")
      && normalized.includes("status = 'previewed'")) {
      return {
        run(...params) {
          if (contextCasFaultCount === 0) {
            contextCasFaultCount += 1;
            return { changes: 0 };
          }
          return statement.run(...params);
        }
      };
    }
    if (suppressFailureAudit
      && contextCasFaultCount === 1
      && failureAuditFaultCount === 0
      && normalized.startsWith('UPDATE import_batches SET status = ?,')
      && normalized.includes("audit_phase = 'execute'")) {
      return {
        run() {
          failureAuditFaultCount += 1;
          throw new Error('injected failure audit rollback after context CAS');
        }
      };
    }
    return statement;
  };
  db.exec = (sql) => {
    const result = originalExec(sql);
    if (normalizeSql(sql) === 'ROLLBACK') {
      rollbackCount += 1;
      if (rollbackCount === 1) captureAfterRollback();
    }
    return result;
  };
  return {
    restore() {
      db.prepare = originalPrepare;
      db.exec = originalExec;
    },
    getContextCasFaultCount() { return contextCasFaultCount; },
    getFailureAuditFaultCount() { return failureAuditFaultCount; },
    getRollbackCount() { return rollbackCount; }
  };
}

/** 包装独立失败审计连接，只让首次 execute audit UPDATE 精确抛错。 */
function injectExecuteAuditUpdateFailure(db) {
  const originalPrepare = db.prepare.bind(db);
  let faultCount = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const normalized = normalizeSql(sql);
    if (faultCount === 0
      && normalized.startsWith('UPDATE import_batches SET status = ?,')
      && normalized.includes("audit_phase = 'execute'")) {
      return {
        run() {
          faultCount += 1;
          throw new Error('injected independent failure audit rollback');
        }
      };
    }
    return statement;
  };
  return {
    restore() { db.prepare = originalPrepare; },
    getFaultCount() { return faultCount; }
  };
}

/** 初始化能流 bundle preview 所需的真实模型、节点和组织主数据。 */
function seedEnergyFlowDependencies(db) {
  const now = new Date().toISOString();
  const parkId = db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
    VALUES ('QL-PARK', '青岚智造园区', '青岚智造园区', 'enterprise', 'active', ?, ?)`).run(now, now).lastInsertRowid;
  const workshopId = db.prepare(`INSERT INTO organization_units
    (parent_id, unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
    VALUES (?, 'QL-WORKSHOP-A', '精密制造一车间', '青岚智造园区/精密制造一车间', 'workshop', 'active', ?, ?)`).run(parkId, now, now).lastInsertRowid;
  const modelId = db.prepare(`INSERT INTO energy_flow_models
    (model_code, model_name, source, document_no, version, effective_start_utc,
      effective_end_utc, source_timezone, status)
    VALUES ('QL-FLOW-PARK', '青岚园区综合能流模型', '青岚园区能源审计', 'QL-FLOW-2026-01',
      'QL-FLOW:v1', '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO energy_flow_nodes
    (energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status)
    VALUES (?, 'QL-NODE-GRID', '电网输入', 'source', ?, 80, 120, 'active')`).run(modelId, parkId);
  db.prepare(`INSERT INTO energy_flow_nodes
    (energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status)
    VALUES (?, 'QL-NODE-WSA', '一车间负荷', 'sink', ?, 360, 120, 'active')`).run(modelId, workshopId);
  return { parkId, workshopId, modelId };
}

/** 初始化平衡 bundle preview 所需的组织、月度能耗和发电来源。 */
function seedEnergyBalanceDependencies(db) {
  const now = new Date().toISOString();
  const existingPark = db.prepare("SELECT id FROM organization_units WHERE unit_code = 'QL-PARK'").get();
  const parkId = existingPark
    ? existingPark.id
    : db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
      VALUES ('QL-PARK', '青岚智造园区', '青岚智造园区', 'enterprise', 'active', ?, ?)`).run(now, now).lastInsertRowid;
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  assert(electricity, '隔离库必须包含 electricity 能源类型。');
  db.prepare(`INSERT INTO energy_records
    (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status)
    VALUES (?, ?, '2026-07', '2026-07', 'kWh', 500000, 'kWh', 500000,
      '青岚智造园区', 'atomicity:energy:2026-07', 'active')`).run(electricity.id, parkId);
  db.prepare(`INSERT INTO generation_records
    (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh,
      self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark)
    VALUES (?, ?, '2026-07', 60000, 50000, 10000, 'upload', 'active', 'QL-GEN-PARK-202607')`).run(parkId, electricity.id);
  return { parkId, energyTypeId: electricity.id };
}

/** 验证单批次 preview context CAS 失败时审计、问题、link 与 context 全部回滚。 */
function testSinglePreviewContextCasRollback(db) {
  const upload = createArtifactUpload('13-shift-definitions', 'preview-cas');
  const context = createArtifactContext(upload, 'shift-definitions-import');
  const before = {
    batches: snapshotTable(db, 'import_batches'),
    issues: snapshotTable(db, 'import_errors'),
    links: snapshotTable(db, 'demo_run_import_batches'),
    context: snapshotContext(db, context.contextId)
  };
  const fault = injectPreviewContextCasMiss(db);
  try {
    assert.throws(
      () => previewShiftDefinitionImport(upload.file, {
        db,
        uploadsDir: temporaryUploadsDir,
        actorUserId: actor.userId,
        actorIp: actor.ip,
        demoContext: projectDemoContext(context)
      }),
      (error) => error.code === 'DEMO_CONTEXT_STATE_CONFLICT'
    );
  } finally {
    fault.restore();
  }
  assert.strictEqual(fault.getFaultCount(), 1, 'preview context CAS 必须只故障一次。');
  assert.deepStrictEqual(snapshotTable(db, 'import_batches'), before.batches);
  assert.deepStrictEqual(snapshotTable(db, 'import_errors'), before.issues);
  assert.deepStrictEqual(snapshotTable(db, 'demo_run_import_batches'), before.links);
  assert.deepStrictEqual(snapshotContext(db, context.contextId), before.context);
  assert.strictEqual(snapshotContext(db, context.contextId).status, 'issued');
}

/** 验证单批次 execute context CAS 失败时业务写入和事务内 execute 审计即时回滚。 */
async function testSingleExecuteContextCasRollback(db) {
  const upload = createArtifactUpload('13-shift-definitions', 'execute-cas');
  const context = createArtifactContext(upload, 'shift-definitions-import');
  const preview = previewShiftDefinitionImport(upload.file, {
    db,
    uploadsDir: temporaryUploadsDir,
    actorUserId: actor.userId,
    actorIp: actor.ip,
    demoContext: projectDemoContext(context)
  });
  const before = {
    business: snapshotTable(db, 'shift_definitions'),
    audit: snapshotAuditBatch(db, preview.batchId),
    links: snapshotContextLinks(db, context.contextId),
    context: snapshotContext(db, context.contextId)
  };
  let rollbackSnapshot = null;
  const fault = injectExecuteContextCasMiss(db, () => {
    rollbackSnapshot = {
      business: snapshotTable(db, 'shift_definitions'),
      audit: snapshotAuditBatch(db, preview.batchId),
      links: snapshotContextLinks(db, context.contextId),
      context: snapshotContext(db, context.contextId)
    };
  });
  try {
    await assert.rejects(
      () => executeShiftDefinitionImport(buildExecuteBody(preview), {
        db,
        uploadsDir: temporaryUploadsDir,
        actorUserId: actor.userId,
        actorIp: actor.ip,
        createBackup: createIsolatedBackup,
        demoContext: projectDemoContext(context)
      }),
      (error) => error.details?.code === 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
    );
  } finally {
    fault.restore();
  }
  assert.strictEqual(fault.getContextCasFaultCount(), 1, 'execute context CAS 必须只故障一次。');
  assert.strictEqual(fault.getFailureAuditFaultCount(), 1, 'CAS 后独立失败审计必须只阻断一次。');
  assert.strictEqual(fault.getRollbackCount(), 1, 'context CAS 失败必须触发一次真实主事务回滚。');
  assert(rollbackSnapshot, '必须在主事务 ROLLBACK 完成后捕获即时数据库快照。');
  assert.deepStrictEqual(rollbackSnapshot.business, before.business);
  assert.deepStrictEqual(rollbackSnapshot.audit, before.audit);
  assert.deepStrictEqual(rollbackSnapshot.links, before.links);
  assert.deepStrictEqual(rollbackSnapshot.context, before.context);
  assert.strictEqual(rollbackSnapshot.context.status, 'previewed');
  assert.strictEqual(rollbackSnapshot.audit.batch.status, preview.auditBatch.status);
  assert.strictEqual(rollbackSnapshot.audit.batch.audit_phase, 'preview');
  assert.deepStrictEqual(snapshotTable(db, 'shift_definitions'), before.business);
  assert.deepStrictEqual(snapshotAuditBatch(db, preview.batchId), before.audit);
  assert.deepStrictEqual(snapshotContextLinks(db, context.contextId), before.links);
  assert.deepStrictEqual(snapshotContext(db, context.contextId), before.context);
  assert.strictEqual(snapshotContext(db, context.contextId).status, 'previewed');
}

/** 验证 Flow bundle 第二批次 audit 创建失败不会留下第一批次、问题、link 或业务行。 */
function testFlowBundleSecondAuditRollback() {
  const db = openDatabase();
  try {
    seedEnergyFlowDependencies(db);
    const upload = createArtifactUpload('24-energy-flow-edges', 'second-audit');
    const context = createArtifactContext(upload, 'energy-flow-bundle-import');
    const before = {
      edges: snapshotTable(db, 'energy_flow_edges'),
      records: snapshotTable(db, 'energy_flow_records'),
      batches: snapshotTable(db, 'import_batches'),
      issues: snapshotTable(db, 'import_errors'),
      links: snapshotTable(db, 'demo_run_import_batches'),
      context: snapshotContext(db, context.contextId)
    };
    const fault = injectSecondAuditBatchInsertFailure(db, 'TEST_SECOND_FLOW_AUDIT_FAILURE');
    try {
      assert.throws(
        () => previewEnergyFlowBundleImport(upload.file, {
          db,
          uploadsDir: temporaryUploadsDir,
          demoContext: projectDemoContext(context)
        }),
        /injected second audit batch failure/
      );
    } finally {
      fault.restore();
    }
    assert.strictEqual(fault.getMatchedInsertCount(), 2, 'Flow preview 必须进入第二批次 audit 创建。');
    assert.strictEqual(fault.getFaultCount(), 1, 'Flow 第二批次 audit 必须只故障一次。');
    assert.deepStrictEqual(snapshotTable(db, 'energy_flow_edges'), before.edges);
    assert.deepStrictEqual(snapshotTable(db, 'energy_flow_records'), before.records);
    assert.deepStrictEqual(snapshotTable(db, 'import_batches'), before.batches);
    assert.deepStrictEqual(snapshotTable(db, 'import_errors'), before.issues);
    assert.deepStrictEqual(snapshotTable(db, 'demo_run_import_batches'), before.links);
    assert.deepStrictEqual(snapshotContext(db, context.contextId), before.context);
    assert.strictEqual(snapshotContext(db, context.contextId).status, 'issued');
  } finally {
    db.close();
  }
}

/** 验证 Balance bundle execute context CAS 失败时两类业务行、双审计和 context 同事务回滚。 */
async function testBalanceBundleExecuteContextCasRollback() {
  const setupDb = openDatabase();
  let context;
  let preview;
  try {
    seedEnergyBalanceDependencies(setupDb);
    const upload = createArtifactUpload('25-energy-balance-configs', 'execute-cas');
    context = createArtifactContext(upload, 'energy-balance-bundle-import');
    preview = previewEnergyBalanceBundleImport(upload.file, {
      db: setupDb,
      uploadsDir: temporaryUploadsDir,
      demoContext: projectDemoContext(context)
    });
    assert.strictEqual(preview.boundaryPreview.summary.blocked, 0);
    assert.strictEqual(preview.itemPreview.summary.blocked, 0);
  } finally {
    setupDb.close();
  }

  const inspectBeforeDb = openDatabase();
  const before = {
    boundaries: snapshotTable(inspectBeforeDb, 'energy_balance_boundaries'),
    items: snapshotTable(inspectBeforeDb, 'energy_balance_items'),
    boundaryAudit: snapshotAuditBatch(inspectBeforeDb, preview.boundaryBatchId),
    itemAudit: snapshotAuditBatch(inspectBeforeDb, preview.itemBatchId),
    links: snapshotContextLinks(inspectBeforeDb, context.contextId),
    context: snapshotContext(inspectBeforeDb, context.contextId)
  };
  inspectBeforeDb.close();

  let rollbackSnapshot = null;
  let executeDb = null;
  let contextFault = null;
  let failureAuditFault = null;
  let openCount = 0;
  const openExecuteDatabase = () => {
    const db = openDatabase();
    openCount += 1;
    if (openCount === 1) {
      executeDb = db;
      contextFault = injectExecuteContextCasMiss(db, () => {
        rollbackSnapshot = {
          boundaries: snapshotTable(db, 'energy_balance_boundaries'),
          items: snapshotTable(db, 'energy_balance_items'),
          boundaryAudit: snapshotAuditBatch(db, preview.boundaryBatchId),
          itemAudit: snapshotAuditBatch(db, preview.itemBatchId),
          links: snapshotContextLinks(db, context.contextId),
          context: snapshotContext(db, context.contextId)
        };
      }, false);
    } else if (openCount === 2) {
      failureAuditFault = injectExecuteAuditUpdateFailure(db);
    }
    return db;
  };

  await assert.rejects(
    () => executeEnergyBalanceBundleImport(buildExecuteBody(preview, {
      boundaryBatchId: preview.boundaryBatchId,
      itemBatchId: preview.itemBatchId
    }), {
      openDatabase: openExecuteDatabase,
      uploadsDir: temporaryUploadsDir,
      createBackup: createIsolatedBackup,
      actor,
      demoContext: projectDemoContext(context)
    }),
    (error) => error.code === 'DEMO_CONTEXT_STATE_CONFLICT'
  );
  assert(contextFault, 'Balance execute 必须打开并包装真实事务连接。');
  assert(failureAuditFault, 'Balance execute 失败后必须打开独立失败审计连接。');
  assert.strictEqual(contextFault.getContextCasFaultCount(), 1, 'Balance execute context CAS 必须只故障一次。');
  assert.strictEqual(contextFault.getFailureAuditFaultCount(), 0, 'Balance 主事务连接不得承担独立失败审计。');
  assert.strictEqual(contextFault.getRollbackCount(), 1, 'Balance context CAS 失败必须触发一次真实主事务回滚。');
  assert.strictEqual(failureAuditFault.getFaultCount(), 1, 'Balance 双批独立失败审计必须精确阻断一次。');
  assert(rollbackSnapshot, 'Balance execute 必须在主事务 ROLLBACK 后捕获即时快照。');
  assert.deepStrictEqual(rollbackSnapshot.boundaries, before.boundaries);
  assert.deepStrictEqual(rollbackSnapshot.items, before.items);
  assert.deepStrictEqual(rollbackSnapshot.boundaryAudit, before.boundaryAudit);
  assert.deepStrictEqual(rollbackSnapshot.itemAudit, before.itemAudit);
  assert.deepStrictEqual(rollbackSnapshot.links, before.links);
  assert.deepStrictEqual(rollbackSnapshot.context, before.context);
  assert.strictEqual(rollbackSnapshot.context.status, 'previewed');
  assert.strictEqual(rollbackSnapshot.boundaryAudit.batch.audit_phase, 'preview');
  assert.strictEqual(rollbackSnapshot.itemAudit.batch.audit_phase, 'preview');

  const finalDb = openDatabase();
  try {
    assert.deepStrictEqual(snapshotTable(finalDb, 'energy_balance_boundaries'), before.boundaries);
    assert.deepStrictEqual(snapshotTable(finalDb, 'energy_balance_items'), before.items);
    assert.deepStrictEqual(snapshotAuditBatch(finalDb, preview.boundaryBatchId), before.boundaryAudit);
    assert.deepStrictEqual(snapshotAuditBatch(finalDb, preview.itemBatchId), before.itemAudit);
    assert.deepStrictEqual(snapshotContextLinks(finalDb, context.contextId), before.links);
    assert.deepStrictEqual(snapshotContext(finalDb, context.contextId), before.context);
    assert.strictEqual(snapshotContext(finalDb, context.contextId).status, 'previewed');
  } finally {
    finalDb.close();
  }
}

(async () => {
  let sharedDb = null;
  try {
    fs.mkdirSync(temporaryDataDir, { recursive: true });
    fs.mkdirSync(temporaryUploadsDir, { recursive: true });
    fs.mkdirSync(temporaryBackupsDir, { recursive: true });
    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });
    sharedDb = openDatabase();
    const admin = sharedDb.prepare("SELECT id, username FROM sys_users WHERE username = 'admin'").get();
    assert(admin, '隔离库必须初始化内置管理员。');
    actor = { userId: Number(admin.id), username: admin.username, ip: '127.0.0.1' };
    demoRun = getOrCreateActiveDemoDatasetRun({ actorUserId: actor.userId });

    testSinglePreviewContextCasRollback(sharedDb);
    await testSingleExecuteContextCasRollback(sharedDb);
    sharedDb.close();
    sharedDb = null;

    testFlowBundleSecondAuditRollback();
    await testBalanceBundleExecuteContextCasRollback();

    console.log('demo central context atomicity tests passed');
  } finally {
    if (sharedDb) sharedDb.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
