'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 服务测试只使用临时隔离 SQLite，不触碰项目真实数据库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-post-action-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { listDemoPostActions } = require('../services/demoPostActionRegistry');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = require('../services/demoOwnershipService');
const demoPostActionService = require('../services/demoPostActionService');
const {
  executeDemoPostAction,
  getDemoPostActionStatus,
  previewDemoPostAction
} = demoPostActionService;
const demoPostActionPrimitives = require('../services/demoPostActionServicePrimitives');
const {
  assertStrictBody,
  stableDigest
} = demoPostActionPrimitives;
const demoServiceTestHarness = require('./helpers/demoServiceTestHarness');
const {
  assertFixedDemoPostActionProductionWiring
} = demoServiceTestHarness;

assert.deepStrictEqual(Reflect.ownKeys(demoServiceTestHarness).map(String).sort(), [
  'assertFixedDemoPostActionProductionWiring',
  'fixedIsolatedChild',
  'runFixedDemoOwnershipTest'
].sort());
assert.deepStrictEqual(Reflect.ownKeys(demoPostActionPrimitives).sort(), [
  'assertStrictBody',
  'stableDigest'
].sort());
assert.strictEqual(Object.isFrozen(demoPostActionPrimitives), true,
  'post-action 共享 pure module exports 必须冻结。');
assert.strictEqual(Object.prototype.hasOwnProperty.call(demoServiceTestHarness, 'PRIVATE_ACTION_ADAPTERS'), false,
  'assertion-only harness 不得暴露私有 action adapter。');
assert.strictEqual(Object.prototype.hasOwnProperty.call(demoServiceTestHarness, 'PRIVATE_ACTION_EXECUTORS'), false,
  'assertion-only harness 不得暴露私有动作执行器。');
assert.deepStrictEqual(assertFixedDemoPostActionProductionWiring(), {
  commonJsIdentity: true,
  primitivesFrozen: true,
  serviceLoaded: true
});

// copy 即使复用相同函数值，也不能替代 production canonical core 真实依赖的 CommonJS record。
const postActionServicePath = require.resolve('../services/demoPostActionService');
const postActionCanonicalServicePath = require.resolve(
  '../services/demoPostActionCanonicalService'
);
const postActionPrimitivesPath = require.resolve('../services/demoPostActionServicePrimitives');
const productionServiceRecord = require.cache[postActionServicePath];
const productionCanonicalServiceRecord = require.cache[postActionCanonicalServicePath];
const productionPrimitivesRecord = require.cache[postActionPrimitivesPath];
const copiedPrimitives = require('./helpers/demoPostActionPrimitivesCopyFixture');
const copiedPrimitivesPath = require.resolve('./helpers/demoPostActionPrimitivesCopyFixture');
const copiedPrimitivesRecord = require.cache[copiedPrimitivesPath];
assert.notStrictEqual(copiedPrimitivesRecord, productionPrimitivesRecord);
assert.notStrictEqual(copiedPrimitives, demoPostActionPrimitives);
assert.strictEqual(copiedPrimitives.stableDigest, stableDigest,
  'copy canary 保持相同函数值以证明 module record identity 才是 wiring 边界。');
require.cache[postActionPrimitivesPath] = copiedPrimitivesRecord;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
require.cache[postActionPrimitivesPath] = productionPrimitivesRecord;
productionPrimitivesRecord.loaded = false;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
productionPrimitivesRecord.loaded = true;
const replacedCanonicalServiceRecord = {
  ...productionCanonicalServiceRecord,
  children: [...productionCanonicalServiceRecord.children],
  exports: productionCanonicalServiceRecord.exports,
  loaded: true
};
require.cache[postActionCanonicalServicePath] = replacedCanonicalServiceRecord;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
require.cache[postActionCanonicalServicePath] = productionCanonicalServiceRecord;
productionCanonicalServiceRecord.loaded = false;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
productionCanonicalServiceRecord.loaded = true;
const replacedServiceRecord = {
  ...productionServiceRecord,
  children: [...productionServiceRecord.children],
  exports: productionServiceRecord.exports,
  loaded: true
};
require.cache[postActionServicePath] = replacedServiceRecord;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
require.cache[postActionServicePath] = productionServiceRecord;
productionServiceRecord.loaded = false;
assert.throws(
  () => assertFixedDemoPostActionProductionWiring(),
  (error) => error?.code === 'DEMO_POST_ACTION_PRODUCTION_WIRING_INVALID'
);
productionServiceRecord.loaded = true;
assert.strictEqual(assertFixedDemoPostActionProductionWiring().commonJsIdentity, true);

/** 为动态非 QL 编码的能流模型建立完整 run/context/batch/ownership/relation 证据。 */
function seedOwnedEnergyFlow(db, run) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const bindingDefinitions = [
    ['22-energy-flow-models', 'primary', 'energy_flow_model', 'energy-flow-models-import'],
    ['23-energy-flow-nodes', 'primary', 'energy_flow_node', 'energy-flow-nodes-import'],
    ['24-energy-flow-edges', 'edge', 'energy_flow_edge', 'energy-flow-bundle-import'],
    ['24-energy-flow-edges', 'record', 'energy_flow_record', 'energy-flow-bundle-import']
  ];
  const batchByRole = new Map();
  bindingDefinitions.forEach(([artifactKey, batchRole, importType, handlerKey], index) => {
    const fileSha = String(index + 1).repeat(64);
    const batchId = Number(db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, file_type, file_size_bytes, file_sha256,
       status, audit_phase, total_rows, success_count, failure_count, skipped_count)
      VALUES (?, ?, 'xlsx', 128, ?, 'completed', 'execute', 4, 4, 0, 0)`).run(
      importType, `${artifactKey}-${batchRole}.xlsx`, fileSha
    ).lastInsertRowid);
    const contextId = `post-action-context-${index + 1}`;
    db.prepare(`INSERT INTO demo_import_contexts
      (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
       artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
       status, issued_at, expires_at, upload_file_sha256, preview_digest, previewed_at, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'executed', ?, ?, ?, ?, ?, ?)`).run(
      contextId,
      String.fromCharCode(97 + index).repeat(64),
      run.runId,
      run.datasetId,
      run.manifestVersion,
      run.manifestDigest,
      artifactKey,
      handlerKey,
      fileSha,
      run.runtimeEpoch,
      now,
      expiresAt,
      fileSha,
      `hmac-sha256:v1:audit:${['e', 'f', 'a', 'b'][index].repeat(64)}`,
      now,
      now
    );
    db.prepare(`INSERT INTO demo_run_import_batches
      (run_id, artifact_key, context_id, import_batch_id, batch_role)
      VALUES (?, ?, ?, ?, ?)`).run(run.runId, artifactKey, contextId, batchId, batchRole);
    batchByRole.set(`${artifactKey}/${batchRole}`, batchId);
  });
  const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
  const modelId = Number(db.prepare(`INSERT INTO energy_flow_models
    (source_batch_id, source_row_number, model_code, model_name, source, version,
     effective_start_wall_clock, effective_end_wall_clock, effective_start_utc,
     effective_end_utc, source_timezone, classification_status, source_mode, status)
    VALUES (?, 2, 'FLOW-DEMO-X', '动态非 QL 能流模型', '隔离测试', 'demo-v1',
      '2026-08-01T00:00', '2026-09-01T00:00', '2026-07-31T16:00:00Z',
      '2026-08-31T16:00:00Z', 'Asia/Shanghai', 'legacy_unclassified', 'legacy_explicit_sources', 'active')`).run(
    batchByRole.get('22-energy-flow-models/primary')
  ).lastInsertRowid);
  const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
    (source_batch_id, source_row_number, energy_flow_model_id, node_code, node_name, node_type, stage_code, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`);
  const nodeBatchId = batchByRole.get('23-energy-flow-nodes/primary');
  const sourceNodeId = Number(insertNode.run(nodeBatchId, 2, modelId, 'FLOW-SOURCE-X', '动态源节点', 'source', 'plant_entry').lastInsertRowid);
  const sinkNodeId = Number(insertNode.run(nodeBatchId, 3, modelId, 'FLOW-SINK-X', '动态汇节点', 'sink', 'boundary').lastInsertRowid);
  const edgeBatchId = batchByRole.get('24-energy-flow-edges/edge');
  const pathId = Number(db.prepare(`INSERT INTO energy_flow_paths
    (source_batch_id, source_row_number, energy_flow_model_id, path_code, path_name, status)
    VALUES (?, 2, ?, 'FLOW-PATH-X', '动态路径', 'active')`).run(edgeBatchId, modelId).lastInsertRowid);
  const edgeId = Number(db.prepare(`INSERT INTO energy_flow_edges
    (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_path_id,
     path_sequence, edge_code, from_node_id, to_node_id, energy_type_id, unit,
     source_type, source_reference, source_mapping_json, status)
    VALUES (?, 2, ?, ?, 1, 'FLOW-EDGE-X', ?, ?, ?, 'kWh', 'explicit_edge_value',
      '隔离显式边值', '{"reference":"隔离显式边值"}', 'active')`).run(
    edgeBatchId, modelId, pathId, sourceNodeId, sinkNodeId, energyTypeId
  ).lastInsertRowid);
  const recordBatchId = batchByRole.get('24-energy-flow-edges/record');
  const recordId = Number(db.prepare(`INSERT INTO energy_flow_records
    (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_edge_id,
     start_utc, end_utc, source_timezone, original_unit, original_value,
     source_type, source_mapping_json, formula_version, record_status)
    VALUES (?, 2, ?, ?, '2026-07-31T16:00:00Z', '2026-08-31T16:00:00Z',
      'Asia/Shanghai', 'kWh', 123.5, 'explicit_edge_value',
      '{"reference":"隔离显式记录"}', 'energy-flow:v1', 'active')`).run(
    recordBatchId, modelId, edgeId
  ).lastInsertRowid);
  const entityDefinitions = [
    ['22-energy-flow-models', 'energy_flow_model', modelId, batchByRole.get('22-energy-flow-models/primary'), 2],
    ['23-energy-flow-nodes', 'energy_flow_node', sourceNodeId, nodeBatchId, 2],
    ['23-energy-flow-nodes', 'energy_flow_node', sinkNodeId, nodeBatchId, 3],
    ['24-energy-flow-edges', 'energy_flow_edge', edgeId, edgeBatchId, 2],
    ['24-energy-flow-edges', 'energy_flow_record', recordId, recordBatchId, 2]
  ];
  const registryByEntity = new Map();
  entityDefinitions.forEach(([artifactKey, entityType, entityPk, sourceBatchId, sourceRowNumber]) => {
    const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
    const snapshotDigest = calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection);
    const registryId = Number(db.prepare(`INSERT INTO demo_data_registry
      (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
       snapshot_digest, source_batch_id, source_row_number, registered_by)
      VALUES (?, ?, ?, ?, 'imported', ?, ?, ?, ?, 1)`).run(
      run.runId,
      artifactKey,
      entityType,
      String(entityPk),
      calculateDemoEntityIdentityDigest(entityType, String(entityPk)),
      snapshotDigest,
      sourceBatchId,
      sourceRowNumber
    ).lastInsertRowid);
    registryByEntity.set(`${entityType}/${entityPk}`, registryId);
  });
  const modelRegistryId = registryByEntity.get(`energy_flow_model/${modelId}`);
  [
    registryByEntity.get(`energy_flow_node/${sourceNodeId}`),
    registryByEntity.get(`energy_flow_node/${sinkNodeId}`),
    registryByEntity.get(`energy_flow_edge/${edgeId}`),
    registryByEntity.get(`energy_flow_record/${recordId}`)
  ].forEach((registryId) => db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type)
    VALUES (?, ?, ?, 'contains')`).run(run.runId, modelRegistryId, registryId));
  db.prepare(`INSERT INTO demo_data_relations
    (run_id, from_registry_id, to_registry_id, relation_type)
    VALUES (?, ?, ?, 'contains')`).run(
    run.runId,
    registryByEntity.get(`energy_flow_edge/${edgeId}`),
    registryByEntity.get(`energy_flow_record/${recordId}`)
  );
  return { modelId, sourceNodeId, sinkNodeId, edgeId, recordId };
}

/** 摘要能流、能耗与碳业务表，验证只读动作不会产生任何业务写入。 */
function snapshotReadOnlyBusinessTables(db) {
  const tableNames = [
    'energy_flow_models',
    'energy_flow_nodes',
    'energy_flow_assets',
    'energy_flow_paths',
    'energy_flow_edges',
    'energy_flow_records',
    'energy_records',
    'carbon_factors',
    'carbon_emissions',
    'carbon_activity_records',
    'carbon_calculation_runs',
    'carbon_accounting_results',
    'carbon_emission_reports',
    'carbon_emission_report_boundaries',
    'carbon_emission_report_evidence',
    'carbon_emission_report_items',
    'carbon_emission_report_summaries'
  ];
  return stableDigest(Object.fromEntries(tableNames.map((tableName) => [
    tableName,
    db.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all()
  ])));
}

/** 断言公共动作运行 JSON 不包含 ownership、摘要、actor 或执行实现字段。 */
function assertSafePublicActionProjection(value) {
  const serialized = JSON.stringify(value);
  const blockedFields = [
    'inputDigest', 'resultDigest', 'manifestDigest', 'registryDigest', 'runtimeEpoch',
    'runtimeRevision', 'revision', 'requestedBy', 'importBatchId', 'contextId', 'fileSha',
    'fileSha256', 'registryId', 'sourceBatchId', 'sourceRowNumber', 'identityDigest',
    'snapshotDigest', 'fromRegistryId', 'toRegistryId', 'relationId', 'entityEvidence',
    'adapter', 'adapterName', 'bindings', 'handler', 'sql', 'modulePath', 'outputId'
  ];
  blockedFields.forEach((field) => {
    assert.strictEqual(serialized.includes(`"${field}"`), false, `公共投影不得包含 ${field}`);
  });
}

/** 重新计算指定 ownership 实体的真实静态 snapshot，供负向测试恢复隔离 fixture。 */
function refreshOwnedSnapshot(db, runId, entityType, entityPk) {
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS[entityType].readProjection(db, entityPk);
  db.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
    WHERE run_id = ? AND entity_type = ? AND entity_pk = ?`).run(
    calculateDemoEntitySnapshotDigest(entityType, String(entityPk), projection),
    runId,
    entityType,
    String(entityPk)
  );
}

/** 预演 connected 能流并断言指定 blocker，确保闭包异常不会继续正式执行。 */
function assertFlowPreviewBlocked(db, run, clientRequestId, expectedCode) {
  const result = previewDemoPostAction({
    runId: run.runId,
    actionKey: 'energy-flow-analysis',
    body: { clientRequestId },
    actorUserId: 1,
    db
  });
  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.blocker.code, expectedCode);
  assertSafePublicActionProjection(result);
  return result;
}

// 子进程仅通过正式服务出口执行同一 action run，不注入连接或私有执行器。
const CONCURRENT_EXECUTE_WORKER_SOURCE = String.raw`
'use strict';

const workerId = process.env.DEMO_POST_ACTION_WORKER_ID;
const payload = JSON.parse(process.env.DEMO_POST_ACTION_RACE_PAYLOAD);
const { executeDemoPostAction } = require(process.env.DEMO_POST_ACTION_SERVICE_MODULE);

/** 将子进程结果通过 IPC 完整发送后再断开，避免丢失竞态证据。 */
function finish(outcome) {
  process.send({ type: 'outcome', workerId, ...outcome }, () => process.disconnect());
}

/** 第二阶段 go 到达后立即进入公开 execute，并记录单调时钟调用区间。 */
function invokeExecute() {
  const executeStartNs = process.hrtime.bigint();
  // 不等待 IPC 回调，确保 call-start 与公开 execute 紧邻，父进程用数据库锁等待两端到位。
  process.send({ type: 'call-start', workerId, executeStartNs: executeStartNs.toString() });
  try {
    const result = executeDemoPostAction({
      actionRunId: payload.actionRunId,
      body: {
        clientRequestId: payload.clientRequestId,
        previewDigest: payload.previewDigest,
        confirmationText: payload.confirmationText
      },
      actorUserId: payload.actorUserId
    });
    finish({ ok: true, result, executeStartNs: executeStartNs.toString(), executeEndNs: process.hrtime.bigint().toString() });
  } catch (error) {
    finish({
      ok: false,
      executeStartNs: executeStartNs.toString(),
      executeEndNs: process.hrtime.bigint().toString(),
      error: {
        code: error && error.code,
        statusCode: error && error.statusCode,
        message: error && error.message,
        details: error && error.details
      }
    });
  }
}

process.send({ type: 'ready', workerId, pid: process.pid });
process.once('message', (message) => {
  if (!message || message.type !== 'start') return;
  // 第一阶段只报告已到达，不允许在 parent 第二阶段 go 前执行。
  const invokingAtNs = process.hrtime.bigint();
  process.send({ type: 'invoking', workerId, pid: process.pid, invokingAtNs: invokingAtNs.toString() });
  process.once('message', (goMessage) => {
    if (!goMessage || goMessage.type !== 'go') return;
    invokeExecute();
  });
});
`;

/**
 * 使用两个独立 Node 子进程和两阶段 IPC barrier 竞争同一个正式 execute 路径。
 * parent 在两个 worker 都报告调用起点后释放 SQLite 写锁，确定制造真实重叠等待窗口。
 */
function executePostActionInTwoProcesses(preview, clientRequestId, lockDb) {
  const workerCount = 2;
  const serviceModulePath = path.resolve(__dirname, '../services/demoPostActionService.js');
  const payload = JSON.stringify({
    actionRunId: preview.actionRunId,
    clientRequestId,
    previewDigest: preview.previewDigest,
    confirmationText: '确认执行能流分析',
    actorUserId: 1
  });
  const readyWorkerIds = new Set();
  const invokingWorkerIds = new Set();
  const callStartedWorkerIds = new Set();
  const invokingEvidence = new Map();
  const callStartEvidence = new Map();
  const exitedWorkerIds = new Set();
  const outcomes = new Map();
  const standardErrors = new Map();
  const workers = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let barrierReleased = false;
    let executeBarrierReleased = false;
    let databaseLockHeld = false;

    /** 释放测试持有的 RESERVED 锁，使两个已开始的公开 execute 继续完成。 */
    function releaseDatabaseLock() {
      if (!databaseLockHeld) return;
      lockDb.exec('COMMIT');
      databaseLockHeld = false;
    }

    try {
      lockDb.exec('BEGIN IMMEDIATE');
      databaseLockHeld = true;
    } catch (error) {
      reject(error);
      return;
    }

    const timeout = setTimeout(() => {
      fail(new Error(`双进程 execute 竞态在限定时间内未完成：${JSON.stringify({
        ready: [...readyWorkerIds],
        invoking: [...invokingWorkerIds],
        outcomes: [...outcomes.keys()],
        exited: [...exitedWorkerIds]
      })}`));
    }, 15000);

    /** 终止仍存活的子进程并返回唯一失败。 */
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        releaseDatabaseLock();
      } catch (_rollbackError) {
        // 原始竞态错误优先返回；隔离临时库会在 finally 中删除。
      }
      workers.forEach((worker) => {
        if (!worker.killed) worker.kill();
      });
      reject(error);
    }

    /** 两个结果均通过 IPC 返回且子进程退出后，生成确定的竞态证据。 */
    function completeIfPossible() {
      if (settled || outcomes.size !== workerCount || exitedWorkerIds.size !== workerCount) return;
      settled = true;
      clearTimeout(timeout);
      releaseDatabaseLock();
      resolve({
        barrierReleased,
        readyWorkerIds: [...readyWorkerIds].sort(),
        invokingWorkerIds: [...invokingWorkerIds].sort(),
        executeBarrierReleased,
        callStartedWorkerIds: [...callStartedWorkerIds].sort(),
        invokingEvidence: [...invokingEvidence.values()].sort((left, right) => left.workerId.localeCompare(right.workerId)),
        callStartEvidence: [...callStartEvidence.values()].sort((left, right) => left.workerId.localeCompare(right.workerId)),
        outcomes: [...outcomes.values()].sort((left, right) => left.workerId.localeCompare(right.workerId))
      });
    }

    for (let index = 0; index < workerCount; index += 1) {
      const workerId = `worker-${index + 1}`;
      const worker = spawn(process.execPath, ['-e', CONCURRENT_EXECUTE_WORKER_SOURCE], {
        env: {
          ...process.env,
          DEMO_POST_ACTION_WORKER_ID: workerId,
          DEMO_POST_ACTION_RACE_PAYLOAD: payload,
          DEMO_POST_ACTION_SERVICE_MODULE: serviceModulePath
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      workers.push(worker);
      standardErrors.set(workerId, '');
      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', (chunk) => {
        standardErrors.set(workerId, `${standardErrors.get(workerId)}${chunk}`);
      });
      worker.on('error', (error) => fail(error));
      worker.on('message', (message) => {
        if (!message || message.workerId !== workerId) return;
        if (message.type === 'ready') {
          readyWorkerIds.add(workerId);
          if (!barrierReleased && readyWorkerIds.size === workerCount) {
            barrierReleased = true;
            workers.forEach((readyWorker) => readyWorker.send({ type: 'start' }));
          }
          return;
        }
        if (message.type === 'invoking') {
          invokingWorkerIds.add(workerId);
          invokingEvidence.set(workerId, {
            workerId,
            pid: message.pid,
            invokingAtNs: message.invokingAtNs
          });
          if (!executeBarrierReleased && invokingWorkerIds.size === workerCount) {
            executeBarrierReleased = true;
            workers.forEach((invokingWorker) => invokingWorker.send({ type: 'go' }));
          }
          return;
        }
        if (message.type === 'call-start') {
          callStartedWorkerIds.add(workerId);
          callStartEvidence.set(workerId, {
            workerId,
            executeStartNs: message.executeStartNs
          });
          if (callStartedWorkerIds.size === workerCount) releaseDatabaseLock();
          return;
        }
        if (message.type === 'outcome') {
          outcomes.set(workerId, message);
          completeIfPossible();
        }
      });
      worker.on('exit', (code, signal) => {
        exitedWorkerIds.add(workerId);
        if (!outcomes.has(workerId)) {
          fail(new Error(`execute 子进程 ${workerId} 在返回结果前退出：${JSON.stringify({
            code,
            signal,
            stderr: standardErrors.get(workerId)
          })}`));
          return;
        }
        if (code !== 0) {
          fail(new Error(`execute 子进程 ${workerId} 异常退出：${JSON.stringify({
            code,
            signal,
            stderr: standardErrors.get(workerId)
          })}`));
          return;
        }
        completeIfPossible();
      });
    }
  });
}

async function runTest() {
try {
  initDatabase();
  toggleDemoRuntime({ enabled: true, actorUserId: 1 });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
  const unconnectedActions = listDemoPostActions()
    .filter((action) => action.implementationStatus === 'not-connected');
  assert.deepStrictEqual(unconnectedActions.map((action) => action.actionKey), [
    'benchmark-evaluation',
    'energy-balance-snapshot',
    'dashboard-refresh-check'
  ]);
  assert.deepStrictEqual(unconnectedActions.map((action) => action.dependencies), Array(3).fill([]));
  const blockedDefinition = unconnectedActions[0];
  const preview = previewDemoPostAction({
    runId: run.runId,
    actionKey: blockedDefinition.actionKey,
    body: { clientRequestId: 'service-blocked-1' },
    actorUserId: 1
  });
  assert.strictEqual(preview.status, 'blocked');
  assert.strictEqual(preview.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
  assert.deepStrictEqual(preview.input, {
    requiredArtifactBindings: blockedDefinition.requiredArtifactBindings
  });
  assert.deepStrictEqual(preview.blocker.requiredArtifactBindings, blockedDefinition.requiredArtifactBindings);
  assert.strictEqual(preview.outputCount, 0);
  assertSafePublicActionProjection(preview);
  const repeated = previewDemoPostAction({
    runId: run.runId,
    actionKey: blockedDefinition.actionKey,
    body: { clientRequestId: 'service-blocked-1' },
    actorUserId: 1
  });
  assert.strictEqual(repeated.actionRunId, preview.actionRunId);
  const db = openDatabase();
  try {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_runs').get().count, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.preview'").get().count, 1);
  } finally {
    db.close();
  }
  unconnectedActions.slice(1).forEach((action, index) => {
    const blockedAction = previewDemoPostAction({
      runId: run.runId,
      actionKey: action.actionKey,
      body: { clientRequestId: `service-not-connected-${index + 1}` },
      actorUserId: 1
    });
    assert.strictEqual(blockedAction.status, 'blocked', `${action.actionKey} 必须继续阻断预演。`);
    assert.strictEqual(blockedAction.blocker.code, 'ACTION_HANDLER_NOT_CONNECTED');
    assert.deepStrictEqual(blockedAction.input.requiredArtifactBindings, action.requiredArtifactBindings);
    assertSafePublicActionProjection(blockedAction);
  });
  assert.throws(
    () => executeDemoPostAction({
      actionRunId: preview.actionRunId,
      body: {
        clientRequestId: 'service-blocked-1',
        previewDigest: preview.previewDigest,
        confirmationText: blockedDefinition.confirmationText
      },
      actorUserId: 1
    }),
    (error) => error.code === 'ACTION_HANDLER_NOT_CONNECTED' && error.statusCode === 409
  );
  assert.throws(
    () => getDemoPostActionStatus({ actionRunId: preview.actionRunId, actorUserId: 2 }),
    (error) => error.code === 'NOT_FOUND' && error.details.code === 'DEMO_POST_ACTION_RUN_NOT_FOUND' && error.statusCode === 404
  );
  assert.throws(
    () => previewDemoPostAction({
      runId: run.runId,
      actionKey: 'prediction-run',
      body: {
        clientRequestId: 'service-body-1',
        modelId: 99,
        adapter: 'energy-flow-analysis',
        modulePath: '../services/unsafe-adapter',
        inputEntityIds: ['1'],
        sql: 'SELECT 1'
      },
      actorUserId: 1
    }),
    (error) => error.code === 'BAD_REQUEST'
      && error.details.code === 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN'
      && error.statusCode === 400
      && JSON.stringify(error.details.fields) === JSON.stringify(['adapter', 'inputEntityIds', 'modelId', 'modulePath', 'sql'])
  );
  assert.throws(
    () => assertStrictBody({ clientRequestId: 'x', sql: 'SELECT 1' }, ['clientRequestId'], 'preview'),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN'
  );
  assert.throws(
    () => executeDemoPostAction({
      actionRunId: preview.actionRunId,
      body: {
        clientRequestId: 'service-blocked-1',
        previewDigest: preview.previewDigest,
        confirmationText: blockedDefinition.confirmationText,
        outputIds: ['forbidden']
      },
      actorUserId: 1
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN'
  );
  const connectedDb = openDatabase();
  try {
    const originalManifestDigest = connectedDb.prepare('SELECT manifest_digest AS manifestDigest FROM demo_dataset_runs WHERE run_id = ?')
      .get(run.runId).manifestDigest;
    connectedDb.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
      .run('f'.repeat(64), run.runId);
    assert.throws(
      () => previewDemoPostAction({
        runId: run.runId,
        actionKey: 'prediction-run',
        body: { clientRequestId: 'service-manifest-stale-1' },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_RUN_INVALID' && error.statusCode === 409
    );
    connectedDb.prepare('UPDATE demo_dataset_runs SET manifest_digest = ? WHERE run_id = ?')
      .run(originalManifestDigest, run.runId);
    const ownedFlow = seedOwnedEnergyFlow(connectedDb, run);
    const businessBefore = snapshotReadOnlyBusinessTables(connectedDb);
    const recordContext = connectedDb.prepare(`SELECT context.context_id AS contextId,
        context.artifact_file_sha256 AS artifactFileSha256
      FROM demo_run_import_batches link
      JOIN demo_import_contexts context ON context.context_id = link.context_id
      WHERE link.run_id = ? AND link.artifact_key = '24-energy-flow-edges' AND link.batch_role = 'record'`).get(run.runId);
    connectedDb.prepare('UPDATE demo_import_contexts SET artifact_file_sha256 = ? WHERE context_id = ?')
      .run('f'.repeat(64), recordContext.contextId);
    const provenanceBlocked = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: 'service-provenance-blocked-1' },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(provenanceBlocked.status, 'blocked');
    assert.strictEqual(provenanceBlocked.blocker.code, 'DEMO_FLOW_FILE_SHA_MISMATCH');
    connectedDb.prepare('UPDATE demo_import_contexts SET artifact_file_sha256 = ? WHERE context_id = ?')
      .run(recordContext.artifactFileSha256, recordContext.contextId);

    const extraNodeId = Number(connectedDb.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, status)
      VALUES (?, 'FLOW-EXTRA-NODE-X', '额外 active 节点', 'process', 'active')`).run(ownedFlow.modelId).lastInsertRowid);
    assertFlowPreviewBlocked(connectedDb, run, 'service-extra-node-1', 'DEMO_FLOW_TOPOLOGY_NODE_SET_INVALID');
    connectedDb.prepare('DELETE FROM energy_flow_nodes WHERE id = ?').run(extraNodeId);

    const energyTypeId = connectedDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const extraEdgeId = Number(connectedDb.prepare(`INSERT INTO energy_flow_edges
      (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit,
       source_type, source_reference, source_mapping_json, status)
      VALUES (?, 'FLOW-EXTRA-EDGE-X', ?, ?, ?, 'kWh', 'explicit_edge_value',
        '额外显式边', '{"reference":"额外显式边"}', 'active')`).run(
      ownedFlow.modelId,
      ownedFlow.sourceNodeId,
      ownedFlow.sinkNodeId,
      energyTypeId
    ).lastInsertRowid);
    assertFlowPreviewBlocked(connectedDb, run, 'service-extra-edge-1', 'DEMO_FLOW_TOPOLOGY_EDGE_SET_INVALID');
    connectedDb.prepare('DELETE FROM energy_flow_edges WHERE id = ?').run(extraEdgeId);

    const extraRecordId = Number(connectedDb.prepare(`INSERT INTO energy_flow_records
      (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
       original_unit, original_value, source_type, source_mapping_json,
       formula_version, record_status)
      SELECT energy_flow_model_id, id, '2026-07-31T16:00:00Z', '2026-08-31T16:00:00Z',
        'Asia/Shanghai', unit, 1, 'explicit_edge_value', '{"reference":"额外显式记录"}',
        'energy-flow:v1', 'active'
      FROM energy_flow_edges WHERE id = ?`).run(ownedFlow.edgeId).lastInsertRowid);
    assertFlowPreviewBlocked(connectedDb, run, 'service-extra-record-1', 'DEMO_FLOW_TOPOLOGY_RECORD_SET_INVALID');
    connectedDb.prepare('DELETE FROM energy_flow_records WHERE id = ?').run(extraRecordId);

    connectedDb.prepare("UPDATE energy_flow_edges SET source_type = 'timeseries' WHERE id = ?").run(ownedFlow.edgeId);
    refreshOwnedSnapshot(connectedDb, run.runId, 'energy_flow_edge', ownedFlow.edgeId);
    assertFlowPreviewBlocked(connectedDb, run, 'service-non-explicit-edge-1', 'DEMO_FLOW_SOURCE_TYPE_INVALID');
    connectedDb.prepare("UPDATE energy_flow_edges SET source_type = 'explicit_edge_value' WHERE id = ?").run(ownedFlow.edgeId);
    refreshOwnedSnapshot(connectedDb, run.runId, 'energy_flow_edge', ownedFlow.edgeId);

    const relationIds = connectedDb.prepare(`SELECT model_relation.relation_id AS modelRecordRelationId,
        edge_relation.relation_id AS edgeRecordRelationId,
        model_registry.registry_id AS modelRegistryId,
        edge_registry.registry_id AS edgeRegistryId,
        record_registry.registry_id AS recordRegistryId,
        node_registry.registry_id AS nodeRegistryId
      FROM demo_data_registry model_registry
      JOIN demo_data_registry edge_registry ON edge_registry.run_id = model_registry.run_id
        AND edge_registry.entity_type = 'energy_flow_edge' AND edge_registry.entity_pk = ?
      JOIN demo_data_registry record_registry ON record_registry.run_id = model_registry.run_id
        AND record_registry.entity_type = 'energy_flow_record' AND record_registry.entity_pk = ?
      JOIN demo_data_registry node_registry ON node_registry.run_id = model_registry.run_id
        AND node_registry.entity_type = 'energy_flow_node' AND node_registry.entity_pk = ?
      JOIN demo_data_relations model_relation ON model_relation.from_registry_id = model_registry.registry_id
        AND model_relation.to_registry_id = record_registry.registry_id AND model_relation.relation_type = 'contains'
      JOIN demo_data_relations edge_relation ON edge_relation.from_registry_id = edge_registry.registry_id
        AND edge_relation.to_registry_id = record_registry.registry_id AND edge_relation.relation_type = 'contains'
      WHERE model_registry.run_id = ? AND model_registry.entity_type = 'energy_flow_model'
        AND model_registry.entity_pk = ?`).get(
      String(ownedFlow.edgeId),
      String(ownedFlow.recordId),
      String(ownedFlow.sourceNodeId),
      run.runId,
      String(ownedFlow.modelId)
    );
    connectedDb.prepare('DELETE FROM demo_data_relations WHERE relation_id = ?').run(relationIds.edgeRecordRelationId);
    assertFlowPreviewBlocked(connectedDb, run, 'service-relation-missing-1', 'DEMO_FLOW_RELATION_CLOSURE_INVALID');
    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );

    connectedDb.prepare('DELETE FROM demo_data_relations WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?')
      .run(relationIds.edgeRegistryId, relationIds.recordRegistryId, 'contains');
    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      relationIds.recordRegistryId,
      relationIds.edgeRegistryId
    );
    assertFlowPreviewBlocked(connectedDb, run, 'service-relation-reverse-1', 'DEMO_FLOW_RELATION_CLOSURE_INVALID');
    connectedDb.prepare('DELETE FROM demo_data_relations WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?')
      .run(relationIds.recordRegistryId, relationIds.edgeRegistryId, 'contains');
    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );

    connectedDb.prepare('DELETE FROM demo_data_relations WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?')
      .run(relationIds.edgeRegistryId, relationIds.recordRegistryId, 'contains');
    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'generated_from')`).run(
      run.runId,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );
    assertFlowPreviewBlocked(connectedDb, run, 'service-relation-type-1', 'DEMO_FLOW_RELATION_CLOSURE_INVALID');
    connectedDb.prepare('DELETE FROM demo_data_relations WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?')
      .run(relationIds.edgeRegistryId, relationIds.recordRegistryId, 'generated_from');
    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );

    connectedDb.prepare(`INSERT INTO demo_data_relations
      (run_id, from_registry_id, to_registry_id, relation_type) VALUES (?, ?, ?, 'contains')`).run(
      run.runId,
      relationIds.nodeRegistryId,
      relationIds.recordRegistryId
    );
    assertFlowPreviewBlocked(connectedDb, run, 'service-relation-extra-1', 'DEMO_FLOW_RELATION_CLOSURE_INVALID');
    connectedDb.prepare('DELETE FROM demo_data_relations WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = ?')
      .run(relationIds.nodeRegistryId, relationIds.recordRegistryId, 'contains');

    connectedDb.pragma('foreign_keys = OFF');
    connectedDb.prepare(`UPDATE demo_data_relations SET run_id = ?
      WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = 'contains'`).run(
      `${run.runId}-cross-run`,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );
    assertFlowPreviewBlocked(connectedDb, run, 'service-relation-cross-run-1', 'DEMO_FLOW_RELATION_CROSS_RUN');
    connectedDb.prepare(`UPDATE demo_data_relations SET run_id = ?
      WHERE from_registry_id = ? AND to_registry_id = ? AND relation_type = 'contains'`).run(
      run.runId,
      relationIds.edgeRegistryId,
      relationIds.recordRegistryId
    );
    connectedDb.pragma('foreign_keys = ON');

    connectedDb.prepare('UPDATE energy_flow_models SET model_name = ? WHERE id = ?')
      .run('修改后的模型名称', ownedFlow.modelId);
    assertFlowPreviewBlocked(connectedDb, run, 'service-model-snapshot-stale-1', 'DEMO_FLOW_SNAPSHOT_DIGEST_MISMATCH');
    connectedDb.prepare('UPDATE energy_flow_models SET model_name = ? WHERE id = ?')
      .run('动态非 QL 能流模型', ownedFlow.modelId);
    refreshOwnedSnapshot(connectedDb, run.runId, 'energy_flow_model', ownedFlow.modelId);

    connectedDb.prepare('UPDATE energy_flow_nodes SET node_name = ? WHERE id = ?')
      .run('修改后的源节点名称', ownedFlow.sourceNodeId);
    assertFlowPreviewBlocked(connectedDb, run, 'service-node-snapshot-stale-1', 'DEMO_FLOW_SNAPSHOT_DIGEST_MISMATCH');
    connectedDb.prepare('UPDATE energy_flow_nodes SET node_name = ? WHERE id = ?')
      .run('动态源节点', ownedFlow.sourceNodeId);
    refreshOwnedSnapshot(connectedDb, run.runId, 'energy_flow_node', ownedFlow.sourceNodeId);

    const connectedPreview = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: 'service-connected-1' },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(connectedPreview.status, 'previewed');
    assert.deepStrictEqual(Object.keys(connectedPreview.input).sort(), ['endUtc', 'modelId', 'startUtc']);
    assertSafePublicActionProjection(connectedPreview);
    connectedDb.prepare('UPDATE energy_flow_models SET model_name = ? WHERE id = ?')
      .run('预演后修改模型名称', ownedFlow.modelId);
    assert.throws(
      () => executeDemoPostAction({
        actionRunId: connectedPreview.actionRunId,
        body: {
          clientRequestId: 'service-connected-1',
          previewDigest: connectedPreview.previewDigest,
          confirmationText: '确认执行能流分析'
        },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE' && error.statusCode === 409
    );
    connectedDb.prepare('UPDATE energy_flow_models SET model_name = ? WHERE id = ?')
      .run('动态非 QL 能流模型', ownedFlow.modelId);
    connectedDb.prepare('UPDATE energy_flow_nodes SET node_name = ? WHERE id = ?')
      .run('预演后修改节点名称', ownedFlow.sourceNodeId);
    assert.throws(
      () => executeDemoPostAction({
        actionRunId: connectedPreview.actionRunId,
        body: {
          clientRequestId: 'service-connected-1',
          previewDigest: connectedPreview.previewDigest,
          confirmationText: '确认执行能流分析'
        },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE' && error.statusCode === 409
    );
    connectedDb.prepare('UPDATE energy_flow_nodes SET node_name = ? WHERE id = ?')
      .run('动态源节点', ownedFlow.sourceNodeId);
    const originalRecord = connectedDb.prepare('SELECT original_value FROM energy_flow_records WHERE id = ?')
      .get(ownedFlow.recordId);
    connectedDb.prepare('UPDATE energy_flow_records SET original_value = original_value + 1 WHERE id = ?')
      .run(ownedFlow.recordId);
    assert.throws(
      () => executeDemoPostAction({
        actionRunId: connectedPreview.actionRunId,
        body: {
          clientRequestId: 'service-connected-1',
          previewDigest: connectedPreview.previewDigest,
          confirmationText: '确认执行能流分析'
        },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE' && error.statusCode === 409
    );
    const staleInputRow = connectedDb.prepare('SELECT status FROM demo_post_action_runs WHERE action_run_id = ?')
      .get(connectedPreview.actionRunId);
    assert.strictEqual(staleInputRow.status, 'previewed', '输入漂移不得领取或伪造 terminal 状态。');
    connectedDb.prepare('UPDATE energy_flow_records SET original_value = ? WHERE id = ?')
      .run(originalRecord.original_value, ownedFlow.recordId);
    toggleDemoRuntime({ enabled: false, actorUserId: 1, db: connectedDb });
    toggleDemoRuntime({ enabled: true, actorUserId: 1, db: connectedDb });
    assert.throws(
      () => executeDemoPostAction({
        actionRunId: connectedPreview.actionRunId,
        body: {
          clientRequestId: 'service-connected-1',
          previewDigest: connectedPreview.previewDigest,
          confirmationText: '确认执行能流分析'
        },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_POST_ACTION_STALE' && error.statusCode === 409
    );
    const currentEpoch = connectedDb.prepare('SELECT runtime_epoch AS runtimeEpoch FROM demo_runtime_settings WHERE id = 1').get().runtimeEpoch;
    connectedDb.prepare("UPDATE demo_import_contexts SET runtime_epoch = ? WHERE status = 'executed'").run(currentEpoch);
    const freshPreview = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: 'service-connected-2' },
      actorUserId: 1,
      db: connectedDb
    });
    const connectedResult = executeDemoPostAction({
      actionRunId: freshPreview.actionRunId,
      body: {
        clientRequestId: 'service-connected-2',
        previewDigest: freshPreview.previewDigest,
        confirmationText: '确认执行能流分析'
      },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(connectedResult.status, 'succeeded');
    assert.strictEqual(connectedResult.outputCount, 0);
    assertSafePublicActionProjection(connectedResult);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(connectedResult, 'resultDigest'), false);
    const repeatedResult = executeDemoPostAction({
      actionRunId: freshPreview.actionRunId,
      body: {
        clientRequestId: 'service-connected-2',
        previewDigest: freshPreview.previewDigest,
        confirmationText: '确认执行能流分析'
      },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(repeatedResult.status, connectedResult.status);
    assert.deepStrictEqual(repeatedResult.result, connectedResult.result);
    assert.strictEqual(
      snapshotReadOnlyBusinessTables(connectedDb),
      businessBefore,
      '能流 preview/execute 不得写入任何能流、能耗或碳业务表。'
    );
    const connectedStored = connectedDb.prepare(`SELECT status, output_count AS outputCount
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(connectedResult.actionRunId);
    assert.deepStrictEqual(connectedStored, { status: 'succeeded', outputCount: 0 });
    const executeAudits = connectedDb.prepare(`SELECT detail_json AS detailJson
      FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.execute' AND target_id = ?
      ORDER BY id`).all(connectedResult.actionRunId);
    assert.strictEqual(executeAudits.length, 1, 'terminal 重复执行不得重复写审计。');
    const executeAuditDetail = JSON.parse(executeAudits[0].detailJson);
    assert.strictEqual(executeAuditDetail.status, 'succeeded');
    assert.strictEqual(executeAuditDetail.outputCount, '0');
    const serializedAudit = JSON.stringify(executeAuditDetail).toLowerCase();
    ['sql', 'modulepath', 'localpath', 'input_json'].forEach((unsafeField) => {
      assert.strictEqual(serializedAudit.includes(`"${unsafeField}"`), false, `审计不得包含 ${unsafeField}`);
    });
    assert.strictEqual(connectedDb.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs WHERE action_run_id = ?').get(connectedResult.actionRunId).count, 0);
    assert.strictEqual(connectedDb.prepare('SELECT COUNT(*) AS count FROM energy_records').get().count, 0);

    const raceBusinessBefore = snapshotReadOnlyBusinessTables(connectedDb);
    const raceClientRequestId = 'service-connected-cas-race-1';
    const racePreview = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: raceClientRequestId },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(racePreview.status, 'previewed');
    const raceEvidence = await executePostActionInTwoProcesses(racePreview, raceClientRequestId, connectedDb);
    assert.strictEqual(raceEvidence.barrierReleased, true, '两个子进程均 ready 后必须释放第一阶段 start barrier。');
    assert.strictEqual(raceEvidence.executeBarrierReleased, true, 'parent 必须等待两个 invoking 后才释放第二阶段 go barrier。');
    assert.deepStrictEqual(raceEvidence.readyWorkerIds, ['worker-1', 'worker-2']);
    assert.deepStrictEqual(raceEvidence.invokingWorkerIds, ['worker-1', 'worker-2']);
    assert.deepStrictEqual(raceEvidence.callStartedWorkerIds, ['worker-1', 'worker-2']);
    assert.strictEqual(new Set(raceEvidence.invokingEvidence.map((item) => item.pid)).size, 2, '竞态必须来自两个独立 Node 进程。');
    assert.strictEqual(raceEvidence.outcomes.length, 2);
    const raceIntervals = raceEvidence.outcomes.map((outcome) => ({
      workerId: outcome.workerId,
      startNs: BigInt(outcome.executeStartNs),
      endNs: BigInt(outcome.executeEndNs)
    }));
    raceIntervals.forEach((interval) => {
      assert(interval.endNs > interval.startNs, `${interval.workerId} 必须记录有效的公开 execute 调用区间。`);
    });
    const latestRaceStartNs = raceIntervals.reduce((latest, interval) => interval.startNs > latest ? interval.startNs : latest, raceIntervals[0].startNs);
    const earliestRaceEndNs = raceIntervals.reduce((earliest, interval) => interval.endNs < earliest ? interval.endNs : earliest, raceIntervals[0].endNs);
    const raceStartSkewNs = raceIntervals[0].startNs > raceIntervals[1].startNs
      ? raceIntervals[0].startNs - raceIntervals[1].startNs
      : raceIntervals[1].startNs - raceIntervals[0].startNs;
    // 两阶段 barrier 已将起点约束在同一调度窗口，允许 250ms 调度抖动但拒绝顺序执行假象。
    assert(raceStartSkewNs <= 250000000n, `两个 execute 调用起点偏差过大：${raceStartSkewNs}ns。`);
    assert(latestRaceStartNs < earliestRaceEndNs, '两个独立进程的公开 execute 调用区间必须真实重叠。');
    const raceSuccesses = raceEvidence.outcomes.filter((outcome) => outcome.ok);
    const raceConflicts = raceEvidence.outcomes.filter((outcome) => !outcome.ok);
    assert(raceSuccesses.length >= 1, '双进程竞争必须至少有一个 execute 成功完成 claim。');
    raceConflicts.forEach((outcome) => {
      assert.strictEqual(outcome.error.code, 'DEMO_POST_ACTION_CLAIM_CONFLICT');
      assert.strictEqual(outcome.error.statusCode, 409);
    });
    raceSuccesses.forEach((outcome) => {
      assert.strictEqual(outcome.result.actionRunId, racePreview.actionRunId);
      assert.strictEqual(outcome.result.status, 'succeeded');
      assert.strictEqual(outcome.result.previewDigest, racePreview.previewDigest);
      assert.strictEqual(outcome.result.outputCount, 0);
      assertSafePublicActionProjection(outcome.result);
    });
    if (raceSuccesses.length === 2) {
      assert.deepStrictEqual(raceSuccesses[1].result.result, raceSuccesses[0].result.result, 'terminal replay 必须返回相同结果。');
      assert.strictEqual(raceSuccesses[1].result.completedAt, raceSuccesses[0].result.completedAt);
    }
    const raceStatus = getDemoPostActionStatus({
      actionRunId: racePreview.actionRunId,
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(raceStatus.status, 'succeeded');
    assert.strictEqual(raceStatus.previewDigest, racePreview.previewDigest);
    assert.strictEqual(raceStatus.outputCount, 0);
    raceSuccesses.forEach((outcome) => {
      assert.deepStrictEqual(outcome.result.result, raceStatus.result);
    });
    const raceStored = connectedDb.prepare(`SELECT status, preview_digest AS previewDigest,
        result_json AS resultJson, output_count AS outputCount, started_at AS startedAt,
        completed_at AS completedAt
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(racePreview.actionRunId);
    assert.strictEqual(raceStored.status, 'succeeded');
    assert.strictEqual(raceStored.previewDigest, racePreview.previewDigest);
    assert.deepStrictEqual(JSON.parse(raceStored.resultJson), raceStatus.result);
    assert.strictEqual(raceStored.outputCount, 0);
    assert(raceStored.startedAt);
    assert(raceStored.completedAt);
    assert.strictEqual(connectedDb.prepare(`SELECT COUNT(*) AS count FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.execute' AND target_id = ?`).get(racePreview.actionRunId).count, 1,
    '双进程 CAS 只能产生一条 execute 审计。');
    assert.strictEqual(connectedDb.prepare(`SELECT COUNT(*) AS count FROM demo_post_action_outputs
      WHERE action_run_id = ?`).get(racePreview.actionRunId).count, 0,
    '双进程 CAS 不得产生重复 output。');
    assert.strictEqual(
      snapshotReadOnlyBusinessTables(connectedDb),
      raceBusinessBefore,
      '双进程 CAS 不得写入能流、能耗或碳业务事实表。'
    );
    // 输出最小稳定时序证据，便于连续运行时确认两个 worker 均越过 barrier。
    console.log(`demoPostActionService CAS race evidence: ${JSON.stringify({
      ready: raceEvidence.readyWorkerIds,
      invoking: raceEvidence.invokingWorkerIds,
      goReleasedAfterBothInvoking: raceEvidence.executeBarrierReleased,
      callStarted: raceEvidence.callStartedWorkerIds,
      startSkewNs: raceStartSkewNs.toString(),
      intervalsOverlap: latestRaceStartNs < earliestRaceEndNs,
      outcomes: raceEvidence.outcomes.map((outcome) => outcome.ok ? 'succeeded-or-replay' : outcome.error.code),
      executeAuditCount: 1,
      outputCount: raceStatus.outputCount
    })}`);

    const expiredPreview = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: 'service-expired-1' },
      actorUserId: 1,
      db: connectedDb
    });
    connectedDb.prepare('UPDATE demo_post_action_runs SET preview_expires_at = ? WHERE action_run_id = ?')
      .run('2000-01-01T00:00:00.000Z', expiredPreview.actionRunId);
    assert.throws(
      () => executeDemoPostAction({
        actionRunId: expiredPreview.actionRunId,
        body: {
          clientRequestId: 'service-expired-1',
          previewDigest: expiredPreview.previewDigest,
          confirmationText: '确认执行能流分析'
        },
        actorUserId: 1,
        db: connectedDb
      }),
      (error) => error.code === 'DEMO_POST_ACTION_PREVIEW_EXPIRED' && error.statusCode === 409
    );
    const expiredStored = connectedDb.prepare(`SELECT status, failure_reason AS failureReason
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(expiredPreview.actionRunId);
    assert.deepStrictEqual(expiredStored, {
      status: 'expired',
      failureReason: 'DEMO_POST_ACTION_PREVIEW_EXPIRED'
    });
    const failedPreview = previewDemoPostAction({
      runId: run.runId,
      actionKey: 'energy-flow-analysis',
      body: { clientRequestId: 'service-failed-1' },
      actorUserId: 1,
      db: connectedDb
    });
    connectedDb.exec(`CREATE TRIGGER demo_post_action_force_failure
      AFTER UPDATE OF status ON demo_post_action_runs
      WHEN NEW.action_run_id = '${failedPreview.actionRunId}' AND NEW.status = 'executing'
      BEGIN
        UPDATE demo_data_registry
        SET snapshot_digest = '${'0'.repeat(64)}'
        WHERE run_id = '${run.runId}'
          AND entity_type = 'energy_flow_record'
          AND entity_pk = '${ownedFlow.recordId}';
      END;`);
    const failedResult = executeDemoPostAction({
      actionRunId: failedPreview.actionRunId,
      body: {
        clientRequestId: 'service-failed-1',
        previewDigest: failedPreview.previewDigest,
        confirmationText: '确认执行能流分析'
      },
      actorUserId: 1,
      db: connectedDb
    });
    assert.strictEqual(failedResult.status, 'failed');
    assert.strictEqual(failedResult.failureReason, 'DEMO_FLOW_SNAPSHOT_DIGEST_MISMATCH');
    connectedDb.exec('DROP TRIGGER demo_post_action_force_failure;');
    const restoredRecord = connectedDb.prepare('SELECT * FROM energy_flow_records WHERE id = ?').get(ownedFlow.recordId);
    connectedDb.prepare(`UPDATE demo_data_registry SET snapshot_digest = ?
      WHERE run_id = ? AND entity_type = 'energy_flow_record' AND entity_pk = ?`).run(
      calculateDemoEntitySnapshotDigest('energy_flow_record', String(ownedFlow.recordId), restoredRecord),
      run.runId,
      String(ownedFlow.recordId)
    );
    const failedAudit = connectedDb.prepare(`SELECT detail_json AS detailJson FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.execute' AND target_id = ?`).get(failedPreview.actionRunId);
    assert(failedAudit);
    assert.strictEqual(JSON.parse(failedAudit.detailJson).status, 'failed');
  } finally {
    connectedDb.close();
  }
  console.log('demoPostActionService.test.js passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
}

runTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
