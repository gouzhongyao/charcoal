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
  executeStrategyRuleImport,
  previewShiftDefinitionImport,
  previewStrategyRuleImport
} = require('../services/energyAnalysisConfigurationImportService');
const {
  executeEnergyFlowBundleImport,
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
    VALUES ('QL-PARK', '天坤集团', '天坤集团', 'enterprise', 'active', ?, ?)`).run(now, now).lastInsertRowid;
  const workshopId = db.prepare(`INSERT INTO organization_units
    (parent_id, unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
    VALUES (?, 'QL-WORKSHOP-A', '精密制造一车间', '天坤集团/精密制造一车间', 'workshop', 'active', ?, ?)`).run(parkId, now, now).lastInsertRowid;
  const modelId = db.prepare(`INSERT INTO energy_flow_models
    (model_code, model_name, source, document_no, version, effective_start_utc,
      effective_end_utc, source_timezone, status)
    VALUES ('QL-FLOW-PARK', '天坤集团综合能流模型', '天坤集团能源审计', 'QL-FLOW-2026-01',
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
      VALUES ('QL-PARK', '天坤集团', '天坤集团', 'enterprise', 'active', ?, ?)`).run(now, now).lastInsertRowid;
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  assert(electricity, '隔离库必须包含 electricity 能源类型。');
  db.prepare(`INSERT INTO energy_records
    (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, duplicate_key, record_status)
    VALUES (?, ?, '2026-07', '2026-07', 'kWh', 500000, 'kWh', 500000,
      'atomicity:energy:2026-07', 'active')`).run(electricity.id, parkId);
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

/** 验证单批次 execute context CAS 失败时业务写入和事务内 execute 审计全部回滚。 */
async function testSingleExecuteContextCasRollback(db) {
  db.prepare(`INSERT INTO shift_definitions
    (shift_code, shift_name, start_minute, end_minute, crosses_midnight, source_timezone,
      source, version, effective_start_utc, effective_end_utc, status, created_at, updated_at)
    VALUES ('QL-SHIFT-DAY', '天坤集团旧白班', 480, 1200, 0, 'Asia/Shanghai',
      '原子性测试既有正式版本', 'QL-SHIFT:v0', '2024-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z', 'active', '2026-08-27T00:00:00.000Z',
      '2026-08-27T00:00:00.000Z')`).run();
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
    context: snapshotContext(db, context.contextId),
    registry: snapshotTable(db, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(db, 'demo_data_relations', 'relation_id'),
    operationLogs: snapshotTable(db, 'sys_operation_logs')
  };
  const triggerDb = openDatabase();
  triggerDb.exec(`CREATE TRIGGER test_shift_context_cas_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW
    WHEN NEW.status = 'executed' AND OLD.context_id = '${context.contextId.replace(/'/g, "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'injected shift context cas failure');
    END`);
  triggerDb.close();

  const failureAuditFault = injectExecuteAuditUpdateFailure(db);
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
    failureAuditFault.restore();
    const cleanupDb = openDatabase();
    cleanupDb.exec('DROP TRIGGER IF EXISTS test_shift_context_cas_failure');
    cleanupDb.close();
  }
  assert.strictEqual(failureAuditFault.getFaultCount(), 1, 'CAS 后独立失败审计必须只阻断一次。');
  assert.deepStrictEqual(snapshotTable(db, 'shift_definitions'), before.business);
  assert.deepStrictEqual(snapshotAuditBatch(db, preview.batchId), before.audit);
  assert.deepStrictEqual(snapshotContextLinks(db, context.contextId), before.links);
  assert.deepStrictEqual(snapshotContext(db, context.contextId), before.context);
  assert.deepStrictEqual(snapshotTable(db, 'demo_data_registry', 'registry_id'), before.registry);
  assert.deepStrictEqual(snapshotTable(db, 'demo_data_relations', 'relation_id'), before.relations);
  assert.deepStrictEqual(snapshotTable(db, 'sys_operation_logs'), before.operationLogs);
  assert.strictEqual(snapshotContext(db, context.contextId).status, 'previewed');
  assert.strictEqual(snapshotAuditBatch(db, preview.batchId).batch.audit_phase, 'preview');
  assert.strictEqual(db.prepare("SELECT status FROM shift_definitions WHERE shift_code = 'QL-SHIFT-DAY' AND version = 'QL-SHIFT:v0'").get().status,
    'active', 'context CAS 失败必须回滚 active sibling 停用。');
}

/** 查询 artifact 13 单批次 execute 后置失败需要比较的完整状态。 */
function snapshotSingleShiftExecuteState(db, preview, context) {
  return {
    business: snapshotTable(db, 'shift_definitions'),
    audit: snapshotAuditBatch(db, preview.batchId),
    links: snapshotContextLinks(db, context.contextId),
    context: snapshotContext(db, context.contextId),
    registry: snapshotTable(db, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(db, 'demo_data_relations', 'relation_id'),
    operationLogs: snapshotTable(db, 'sys_operation_logs')
  };
}

/** 使用真实 SQLite 触发器验证 artifact 13 指定后置写入失败时 ownership 主事务完整回滚。 */
async function assertSingleShiftPostInsertFailureRollback(db, input) {
  const upload = createArtifactUpload('13-shift-definitions', input.suffix);
  const context = createArtifactContext(upload, 'shift-definitions-import');
  const preview = previewShiftDefinitionImport(upload.file, {
    db,
    uploadsDir: temporaryUploadsDir,
    actorUserId: actor.userId,
    actorIp: actor.ip,
    demoContext: projectDemoContext(context)
  });
  if (input.removePreviewLink === true) {
    const removed = db.prepare('DELETE FROM demo_run_import_batches WHERE context_id = ?').run(context.contextId);
    assert.strictEqual(removed.changes, 1, `${input.label} 必须先移除 preview link 以精确进入 link 重建路径。`);
  }
  const before = snapshotSingleShiftExecuteState(db, preview, context);
  const triggerDb = openDatabase();
  triggerDb.exec(input.createTriggerSql({ context, preview }));
  triggerDb.close();
  const failureAuditFault = input.triggerAlsoBlocksFailureAudit === true
    ? null
    : injectExecuteAuditUpdateFailure(db);
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
      (error) => {
        assert.strictEqual(
          error.details?.code,
          input.expectedErrorCode || 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
        );
        if (input.expectedCauseCode) {
          assert.strictEqual(error.details?.causeCode, input.expectedCauseCode);
        }
        return true;
      }
    );
  } finally {
    if (failureAuditFault) failureAuditFault.restore();
    const cleanupDb = openDatabase();
    cleanupDb.exec(`DROP TRIGGER IF EXISTS ${input.triggerName}`);
    cleanupDb.close();
  }
  if (failureAuditFault) {
    assert.strictEqual(failureAuditFault.getFaultCount(), 1,
      `${input.label} 后独立失败审计必须只阻断一次。`);
  }
  assert.deepStrictEqual(snapshotSingleShiftExecuteState(db, preview, context), before,
    `${input.label} 必须回滚业务 INSERT、sibling 状态、operation audit、batch link、registry、execute audit 与 context。`);
  assert.strictEqual(snapshotContext(db, context.contextId).status, 'previewed');
  assert.strictEqual(db.prepare("SELECT status FROM shift_definitions WHERE shift_code = 'QL-SHIFT-DAY' AND version = 'QL-SHIFT:v0'").get().status,
    'active', `${input.label} 必须回滚 active sibling 停用。`);
}

/** 验证 artifact 13 操作审计失败时业务 INSERT 与 sibling 停用整体回滚。 */
async function testSingleExecuteOperationAuditRollback(db) {
  await assertSingleShiftPostInsertFailureRollback(db, {
    label: 'artifact 13 operation audit 失败',
    suffix: 'operation-audit-failure',
    triggerName: 'test_shift_operation_audit_failure',
    createTriggerSql: () => `CREATE TRIGGER test_shift_operation_audit_failure
      BEFORE INSERT ON sys_operation_logs
      FOR EACH ROW WHEN NEW.operation = 'energy.shift.configuration.import'
      BEGIN SELECT RAISE(ABORT, 'injected shift operation audit failure'); END`
  });
}

/** 验证 artifact 18 策略配置操作审计失败时业务、ownership、link 与 context 整体回滚。 */
async function testStrategyRuleOperationAuditRollback(db) {
  const upload = createArtifactUpload('18-strategy-rules', 'operation-audit-failure');
  const context = createArtifactContext(upload, 'strategy-rules-import');
  const preview = previewStrategyRuleImport(upload.file, {
    db,
    uploadsDir: temporaryUploadsDir,
    actorUserId: actor.userId,
    actorIp: actor.ip,
    demoContext: projectDemoContext(context)
  });
  assert.strictEqual(preview.expectedWouldImport, 1, 'artifact 18 原子性测试必须使用真实策略候选。');
  const before = {
    business: snapshotTable(db, 'strategy_rules'),
    audit: snapshotAuditBatch(db, preview.batchId),
    links: snapshotContextLinks(db, context.contextId),
    context: snapshotContext(db, context.contextId),
    registry: snapshotTable(db, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(db, 'demo_data_relations', 'relation_id'),
    operationLogs: snapshotTable(db, 'sys_operation_logs')
  };
  const triggerDb = openDatabase();
  triggerDb.exec(`CREATE TRIGGER test_strategy_operation_audit_failure
    BEFORE INSERT ON sys_operation_logs
    FOR EACH ROW WHEN NEW.operation = 'energy.strategy.rule.configuration.import'
    BEGIN SELECT RAISE(ABORT, 'injected strategy operation audit failure'); END`);
  triggerDb.close();

  const failureAuditFault = injectExecuteAuditUpdateFailure(db);
  try {
    await assert.rejects(
      () => executeStrategyRuleImport(buildExecuteBody(preview), {
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
    failureAuditFault.restore();
    const cleanupDb = openDatabase();
    cleanupDb.exec('DROP TRIGGER IF EXISTS test_strategy_operation_audit_failure');
    cleanupDb.close();
  }
  assert.strictEqual(failureAuditFault.getFaultCount(), 1,
    'artifact 18 失败后独立失败审计必须只阻断一次。');
  assert.deepStrictEqual({
    business: snapshotTable(db, 'strategy_rules'),
    audit: snapshotAuditBatch(db, preview.batchId),
    links: snapshotContextLinks(db, context.contextId),
    context: snapshotContext(db, context.contextId),
    registry: snapshotTable(db, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(db, 'demo_data_relations', 'relation_id'),
    operationLogs: snapshotTable(db, 'sys_operation_logs')
  }, before, 'artifact 18 操作审计失败必须整体回滚业务、ownership 与 execute 状态。');
  assert.strictEqual(snapshotContext(db, context.contextId).status, 'previewed');
  assert.strictEqual(snapshotAuditBatch(db, preview.batchId).batch.audit_phase, 'preview');
}

/** 验证 artifact 13 preview batch link 缺失时 fail-closed 且不尝试重建或写业务。 */
async function testSingleExecuteBatchLinkRollback(db) {
  await assertSingleShiftPostInsertFailureRollback(db, {
    label: 'artifact 13 batch link 缺失',
    suffix: 'batch-link-failure',
    triggerName: 'test_shift_batch_link_failure',
    removePreviewLink: true,
    expectedCauseCode: 'DEMO_OWNERSHIP_IMPORT_BATCH_CONFLICT',
    createTriggerSql: ({ context }) => `CREATE TRIGGER test_shift_batch_link_failure
      BEFORE INSERT ON demo_run_import_batches
      FOR EACH ROW WHEN NEW.context_id = '${context.contextId.replace(/'/g, "''")}'
      BEGIN SELECT RAISE(ABORT, 'injected shift batch link failure'); END`
  });
}

/** 验证 artifact 13 registry 写入失败时业务、操作审计与 link 整体回滚。 */
async function testSingleExecuteRegistryRollback(db) {
  await assertSingleShiftPostInsertFailureRollback(db, {
    label: 'artifact 13 registry 失败',
    suffix: 'registry-failure',
    triggerName: 'test_shift_registry_failure',
    expectedCauseCode: 'DEMO_OWNERSHIP_REGISTRY_WRITE_FAILED',
    createTriggerSql: () => `CREATE TRIGGER test_shift_registry_failure
      BEFORE INSERT ON demo_data_registry
      FOR EACH ROW WHEN NEW.artifact_key = '13-shift-definitions'
      BEGIN SELECT RAISE(ABORT, 'injected shift registry failure'); END`
  });
}

/** 验证 artifact 13 execute audit 失败时 registry 及全部先行写入整体回滚。 */
async function testSingleExecuteAuditRollback(db) {
  await assertSingleShiftPostInsertFailureRollback(db, {
    label: 'artifact 13 execute audit 失败',
    suffix: 'execute-audit-failure',
    triggerName: 'test_shift_execute_audit_failure',
    triggerAlsoBlocksFailureAudit: true,
    createTriggerSql: ({ preview }) => `CREATE TRIGGER test_shift_execute_audit_failure
      BEFORE UPDATE ON import_batches
      FOR EACH ROW WHEN OLD.id = ${Number(preview.batchId)} AND NEW.audit_phase = 'execute'
      BEGIN SELECT RAISE(ABORT, 'injected shift execute audit failure'); END`
  });
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

/** 验证 Flow bundle execute context CAS 失败时双角色业务、ownership、审计与 context 全部即时回滚。 */
async function testFlowBundleExecuteContextCasRollback() {
  const setupDb = openDatabase();
  let context;
  let preview;
  try {
    const upload = createArtifactUpload('24-energy-flow-edges', 'execute-cas');
    context = createArtifactContext(upload, 'energy-flow-bundle-import');
    preview = previewEnergyFlowBundleImport(upload.file, {
      db: setupDb,
      uploadsDir: temporaryUploadsDir,
      demoContext: projectDemoContext(context)
    });
    assert.strictEqual(preview.edgePreview.summary.blocked, 0);
    assert.strictEqual(preview.recordPreview.summary.blocked, 0);
    assert(preview.edgePreview.candidateRows.length > 0, 'Flow execute CAS 测试必须使用真实 edge 候选。');
    assert(preview.recordPreview.candidateRows.length > 0, 'Flow execute CAS 测试必须使用真实 record 候选。');
  } finally {
    setupDb.close();
  }

  const snapshotFlowState = (db) => ({
    edges: snapshotTable(db, 'energy_flow_edges'),
    records: snapshotTable(db, 'energy_flow_records'),
    edgeAudit: snapshotAuditBatch(db, preview.edgeBatchId),
    recordAudit: snapshotAuditBatch(db, preview.recordBatchId),
    allIssues: snapshotTable(db, 'import_errors'),
    links: snapshotTable(db, 'demo_run_import_batches'),
    context: snapshotContext(db, context.contextId),
    registry: snapshotTable(db, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(db, 'demo_data_relations', 'relation_id'),
    operationLogs: snapshotTable(db, 'sys_operation_logs')
  });
  const inspectBeforeDb = openDatabase();
  const before = snapshotFlowState(inspectBeforeDb);
  inspectBeforeDb.close();
  assert.strictEqual(before.context.status, 'previewed');
  assert.deepStrictEqual(before.links.filter((link) => link.context_id === context.contextId)
    .map((link) => link.batch_role).sort(), ['edge', 'record']);

  const triggerDb = openDatabase();
  triggerDb.exec(`CREATE TRIGGER test_flow_context_cas_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW
    WHEN NEW.status = 'executed' AND OLD.context_id = '${context.contextId.replace(/'/g, "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'injected flow context cas failure');
    END`);
  triggerDb.close();

  let rollbackSnapshot = null;
  let failureAuditFault = null;
  let openCount = 0;
  const openExecuteDatabase = () => {
    const db = openDatabase();
    openCount += 1;
    if (openCount === 2) {
      rollbackSnapshot = snapshotFlowState(db);
      failureAuditFault = injectExecuteAuditUpdateFailure(db);
    }
    return db;
  };
  try {
    await assert.rejects(
      () => executeEnergyFlowBundleImport(buildExecuteBody(preview, {
        edgeBatchId: preview.edgeBatchId,
        recordBatchId: preview.recordBatchId
      }), {
        openDatabase: openExecuteDatabase,
        uploadsDir: temporaryUploadsDir,
        createBackup: createIsolatedBackup,
        actor,
        demoContext: projectDemoContext(context)
      }),
      (error) => error.details?.code === 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
    );
  } finally {
    const cleanupDb = openDatabase();
    cleanupDb.exec('DROP TRIGGER IF EXISTS test_flow_context_cas_failure');
    cleanupDb.close();
  }
  assert.strictEqual(openCount, 2,
    'Flow execute 必须先打开校验连接，并在主 ownership 事务回滚后另开失败审计连接。');
  assert(rollbackSnapshot, 'Flow 主 ownership 事务回滚后、失败审计前必须捕获即时快照。');
  assert(failureAuditFault, 'Flow execute 失败后必须打开独立失败审计连接。');
  assert.strictEqual(failureAuditFault.getFaultCount(), 1,
    'Flow 双批次独立失败审计必须精确阻断一次，避免覆盖原 preview 证据。');
  assert.deepStrictEqual(rollbackSnapshot, before,
    'Flow context CAS 失败后主事务即时快照必须完整回到 execute 前 preview 状态。');
  assert.strictEqual(rollbackSnapshot.context.status, 'previewed');
  assert.strictEqual(rollbackSnapshot.edgeAudit.batch.audit_phase, 'preview');
  assert.strictEqual(rollbackSnapshot.recordAudit.batch.audit_phase, 'preview');

  const finalDb = openDatabase();
  try {
    assert.deepStrictEqual(snapshotFlowState(finalDb), before,
      '失败审计回滚后不得覆盖或掩盖 Flow 主事务的原始 preview 状态。');
    assert.strictEqual(snapshotContext(finalDb, context.contextId).status, 'previewed');
  } finally {
    finalDb.close();
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
    context: snapshotContext(inspectBeforeDb, context.contextId),
    registry: snapshotTable(inspectBeforeDb, 'demo_data_registry', 'registry_id'),
    relations: snapshotTable(inspectBeforeDb, 'demo_data_relations', 'relation_id')
  };
  inspectBeforeDb.close();

  const triggerDb = openDatabase();
  triggerDb.exec(`CREATE TRIGGER test_balance_context_cas_failure
    BEFORE UPDATE ON demo_import_contexts
    FOR EACH ROW
    WHEN NEW.status = 'executed'
    BEGIN
      SELECT RAISE(ABORT, 'injected balance context cas failure');
    END`);
  triggerDb.close();

  let failureAuditFault = null;
  let openCount = 0;
  const openExecuteDatabase = () => {
    const db = openDatabase();
    openCount += 1;
    if (openCount === 2) failureAuditFault = injectExecuteAuditUpdateFailure(db);
    return db;
  };
  try {
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
      /injected balance context cas failure/
    );
  } finally {
    const cleanupDb = openDatabase();
    cleanupDb.exec('DROP TRIGGER IF EXISTS test_balance_context_cas_failure');
    cleanupDb.close();
  }
  assert.strictEqual(openCount, 2, 'Balance execute 主事务必须使用私有连接，失败审计另开外部连接。');
  assert(failureAuditFault, 'Balance execute 失败后必须打开独立失败审计连接。');
  assert.strictEqual(failureAuditFault.getFaultCount(), 1, 'Balance 双批独立失败审计必须精确阻断一次。');

  const finalDb = openDatabase();
  try {
    assert.deepStrictEqual(snapshotTable(finalDb, 'energy_balance_boundaries'), before.boundaries);
    assert.deepStrictEqual(snapshotTable(finalDb, 'energy_balance_items'), before.items);
    assert.deepStrictEqual(snapshotAuditBatch(finalDb, preview.boundaryBatchId), before.boundaryAudit);
    assert.deepStrictEqual(snapshotAuditBatch(finalDb, preview.itemBatchId), before.itemAudit);
    assert.deepStrictEqual(snapshotTable(finalDb, 'demo_data_registry', 'registry_id'), before.registry);
    assert.deepStrictEqual(snapshotTable(finalDb, 'demo_data_relations', 'relation_id'), before.relations);
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
    await testSingleExecuteOperationAuditRollback(sharedDb);
    await testStrategyRuleOperationAuditRollback(sharedDb);
    await testSingleExecuteBatchLinkRollback(sharedDb);
    await testSingleExecuteRegistryRollback(sharedDb);
    await testSingleExecuteAuditRollback(sharedDb);
    sharedDb.close();
    sharedDb = null;

    testFlowBundleSecondAuditRollback();
    await testFlowBundleExecuteContextCasRollback();
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
