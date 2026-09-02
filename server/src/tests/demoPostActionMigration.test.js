'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 迁移测试始终使用隔离临时 SQLite，不读取或修改正式 data 数据库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-post-action-migration-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'default.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const {
  CANONICAL_SCHEMA_PREDECESSOR_VERSION,
  CANONICAL_SCHEMA_VERSION,
  buildDemoRunTurnoverPredecessorSqlOverrides,
  calculateSchemaFingerprint,
  getTableColumns,
  initDatabase,
  matchTrustedCanonicalSchemaProfile,
  migrateEnergyBalanceImportSourceColumns,
  openDatabase
} = require('../db/database');
const { listDemoPostActions } = require('../services/demoPostActionRegistry');

// 唯一 accepted predecessor 必须与 database.js 导出的精确 v3 合同保持一致。
const PREDECESSOR_VERSION = CANONICAL_SCHEMA_PREDECESSOR_VERSION;

/** 将目标版本隔离库精确还原为尚无 run 自动换代结构的唯一 v3 predecessor。 */
function prepareExactPredecessor(databasePath, fingerprintOverride) {
  initDatabase({ databasePath });
  const predecessorOverrides = buildDemoRunTurnoverPredecessorSqlOverrides();
  const db = openDatabase({ databasePath });
  const attachedRunTriggers = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'demo_dataset_runs' AND sql IS NOT NULL ORDER BY name`)
    .all().map((row) => row.sql);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TEMP TABLE demo_dataset_runs_v4_backup AS SELECT * FROM demo_dataset_runs ORDER BY run_id;
        CREATE TEMP TABLE demo_cleanup_runs_v4_backup AS SELECT * FROM demo_cleanup_runs ORDER BY cleanup_run_id;
        DROP TABLE demo_cleanup_runs;
        DROP TABLE demo_dataset_runs;`);
      db.exec(predecessorOverrides.get('table:demo_dataset_runs:demo_dataset_runs'));
      db.exec(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
          completed_at, cleanup_started_at, cleaned_at, failure_reason)
        SELECT run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
          completed_at, cleanup_started_at, cleaned_at, failure_reason
        FROM temp.demo_dataset_runs_v4_backup ORDER BY run_id`);
      db.exec(predecessorOverrides.get('table:demo_cleanup_runs:demo_cleanup_runs'));
      db.exec(`INSERT INTO demo_cleanup_runs
        (cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
          runtime_revision, registry_watermark, candidate_count, blocker_count, summary_json,
          confirmation_text, requested_by, status, backup_metadata_json, deleted_count,
          already_missing_count, created_at, started_at, completed_at, failure_reason)
        SELECT cleanup_run_id, run_id, client_request_id, preview_digest, preview_expires_at,
          runtime_revision, registry_watermark, candidate_count, blocker_count, summary_json,
          confirmation_text, requested_by, status, backup_metadata_json, deleted_count,
          already_missing_count, created_at, started_at, completed_at, failure_reason
        FROM temp.demo_cleanup_runs_v4_backup ORDER BY cleanup_run_id;
        DROP TABLE temp.demo_cleanup_runs_v4_backup;
        DROP TABLE temp.demo_dataset_runs_v4_backup;
        CREATE UNIQUE INDEX ux_demo_dataset_runs_active_dataset ON demo_dataset_runs(dataset_id)
          WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning');
        CREATE INDEX idx_demo_dataset_runs_status_created ON demo_dataset_runs(status, created_at DESC);
        CREATE INDEX idx_demo_cleanup_runs_status_created ON demo_cleanup_runs(status, created_at DESC);`);
      attachedRunTriggers.forEach((sql) => db.exec(sql));
      const fingerprint = calculateSchemaFingerprint(db);
      const trustedPredecessor = matchTrustedCanonicalSchemaProfile(db, PREDECESSOR_VERSION);
      assert.strictEqual(trustedPredecessor.fingerprint, fingerprint,
        'v3 fixture 必须命中 database.js run 自动换代 predecessor profile。');
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'").run(PREDECESSOR_VERSION);
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'").run(fingerprintOverride || fingerprint);
    }).immediate();
    return calculateSchemaFingerprint(db);
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }
}

/** 向精确 v3 predecessor 写入显式策略规则 ID 及其入向 hit 外键夹具。 */
function insertPopulatedStrategyRuleHitFixture(db, suffix) {
  const ruleId = 142;
  const ruleCode = `POST-ACTION-STRATEGY-${suffix}`;
  const ruleVersion = 'legacy:v2';
  db.prepare(`INSERT INTO strategy_rules
    (id, rule_code, rule_name, rule_version, formula_version, metric_code, threshold_operator,
     threshold_value, threshold_unit, reduction_rate, priority, evidence_requirements_json,
     recommendation_text, source, effective_start_utc, effective_end_utc, source_timezone,
     status, created_at, updated_at)
    VALUES (?, ?, '组合迁移规则', ?, 'strategy:v1', 'energy_intensity', 'gt', 1, 'kgce/t',
      0.1, 'medium', '{}', '组合迁移建议', '组合迁移测试',
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active',
      '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`)
    .run(ruleId, ruleCode, ruleVersion);
  const evaluationRunId = Number(db.prepare(`INSERT INTO strategy_evaluation_runs
    (run_code, scope_type, scope_reference, start_utc, end_utc, source_timezone,
     formula_version, status, reason_codes_json)
    VALUES (?, 'organization', 'post-action:migration', '2026-03-01T00:00:00Z',
      '2026-04-01T00:00:00Z', 'Asia/Shanghai', 'strategy:v1', 'completed', '["migration"]')`)
    .run(`POST-ACTION-STRATEGY-RUN-${suffix}`).lastInsertRowid);
  const hitId = Number(db.prepare(`INSERT INTO strategy_rule_hits
    (evaluation_run_id, strategy_rule_id, match_status, manual_status, actual_value,
     threshold_snapshot_json, evidence_json, reason_codes_json, coverage_rate, priority,
     estimated_saving, estimated_saving_unit, data_start_utc, data_end_utc, source_timezone)
    VALUES (?, ?, 'matched', 'accepted', 1.5, '{"operator":"gt","value":1}',
      '["post-action-migration"]', '["migration"]', 1, 'medium', 10, 'kgce',
      '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', 'Asia/Shanghai')`)
    .run(evaluationRunId, ruleId).lastInsertRowid);
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  return { ruleId, ruleCode, ruleVersion, evaluationRunId, hitId };
}

/** 将两张平衡表还原为来源列迁移前的 canonical 结构，并保留已有隔离夹具。 */
function rebuildBalanceTablesWithoutImportSources(db) {
  // 重建期间临时关闭外键，结束后恢复连接设置并检查隔离库引用完整性。
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS trg_energy_balance_boundaries_source_insert;
        DROP TRIGGER IF EXISTS trg_energy_balance_boundaries_source_update;
        DROP TRIGGER IF EXISTS trg_energy_balance_items_source_insert;
        DROP TRIGGER IF EXISTS trg_energy_balance_items_source_update;
        DROP TRIGGER IF EXISTS trg_energy_balance_import_batch_provenance_clear;
        DROP INDEX IF EXISTS idx_energy_balance_boundaries_source;
        DROP INDEX IF EXISTS idx_energy_balance_items_source;

        CREATE TEMP TABLE energy_balance_boundaries__fixture AS
          SELECT * FROM energy_balance_boundaries;
        CREATE TEMP TABLE energy_balance_items__fixture AS
          SELECT * FROM energy_balance_items;
        DROP TABLE energy_balance_items;
        DROP TABLE energy_balance_boundaries;

        CREATE TABLE energy_balance_boundaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          boundary_code TEXT NOT NULL,
          boundary_name TEXT NOT NULL,
          organization_unit_id INTEGER,
          source TEXT NOT NULL,
          document_no TEXT,
          version TEXT NOT NULL,
          effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
          effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
          source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
          generation_boundary_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (generation_boundary_confirmed IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
          UNIQUE (boundary_code, version),
          CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
        );

        CREATE TABLE energy_balance_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          energy_balance_boundary_id INTEGER NOT NULL,
          item_code TEXT NOT NULL,
          item_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('input', 'self_generation', 'inventory_decrease', 'adjustment_increase', 'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease')),
          energy_type_id INTEGER NOT NULL,
          original_unit TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'explicit_balance_value')),
          source_mapping_json TEXT NOT NULL,
          generation_anti_double_count_key TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (energy_balance_boundary_id) REFERENCES energy_balance_boundaries(id) ON DELETE CASCADE,
          FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
          UNIQUE (energy_balance_boundary_id, item_code),
          CHECK (
            CASE WHEN json_valid(source_mapping_json) = 1 THEN
              json_type(source_mapping_json) = 'object'
              AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
              AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
            ELSE 0 END
          )
        );

        INSERT INTO energy_balance_boundaries
          (id, boundary_code, boundary_name, organization_unit_id, source, document_no, version,
           effective_start_utc, effective_end_utc, source_timezone, generation_boundary_confirmed,
           status, created_at, updated_at)
        SELECT id, boundary_code, boundary_name, organization_unit_id, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone, generation_boundary_confirmed,
          status, created_at, updated_at
        FROM energy_balance_boundaries__fixture;

        INSERT INTO energy_balance_items
          (id, energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
           source_type, source_mapping_json, generation_anti_double_count_key, status, created_at, updated_at)
        SELECT id, energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
          source_type, source_mapping_json, generation_anti_double_count_key, status, created_at, updated_at
        FROM energy_balance_items__fixture;

        DROP TABLE energy_balance_items__fixture;
        DROP TABLE energy_balance_boundaries__fixture;
        CREATE INDEX idx_energy_balance_boundaries_effective
          ON energy_balance_boundaries(status, effective_start_utc, effective_end_utc);
        CREATE INDEX idx_energy_balance_items_boundary_role
          ON energy_balance_items(energy_balance_boundary_id, role, status);
      `);
    })();
  } finally {
    if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
  }
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
}

/** 构造平衡来源列经 ALTER 补齐的精确 v3 predecessor，并保留策略规则关联夹具。 */
function prepareAlteredEnergyBalancePredecessor(databasePath, options = {}) {
  prepareExactPredecessor(databasePath);
  const db = openDatabase({ databasePath });
  try {
    // 组合 profile 必须同时承载 populated strategy rule/hit 与历史平衡业务行。
    const strategyFixture = insertPopulatedStrategyRuleHitFixture(db, options.fixtureSuffix || 'alter');
    const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const boundaryId = Number(db.prepare(`INSERT INTO energy_balance_boundaries
      (boundary_code, boundary_name, source, version, effective_start_utc, effective_end_utc,
       source_timezone, generation_boundary_confirmed, status)
      VALUES ('POST-ACTION-ALTER', '后置动作 ALTER 兼容边界', 'manual', 'v1',
        '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai', 1, 'active')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO energy_balance_items
      (energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
       source_type, source_mapping_json, status)
      VALUES (?, 'POST-ACTION-ALTER-INPUT', '后置动作 ALTER 兼容输入项', 'input', ?, 'kWh',
        'explicit_balance_value', '{"reference":"post-action-alter-test"}', 'active')`).run(boundaryId, energyTypeId);

    rebuildBalanceTablesWithoutImportSources(db);
    assert.strictEqual(migrateEnergyBalanceImportSourceColumns(db), true);
    assert(getTableColumns(db, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(getTableColumns(db, 'energy_balance_items').includes('source_row_number'));
    if (options.addUnexpectedIndex) {
      db.exec(`CREATE INDEX idx_energy_balance_boundaries_unexpected_post_action
        ON energy_balance_boundaries(boundary_name);`);
    }
    // predecessor metadata 登记 ALTER 后实际指纹，避免负向场景误落入 metadata mismatch。
    const fingerprint = calculateSchemaFingerprint(db);
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'").run(fingerprint);
    return { fingerprint, boundaryId, strategyFixture };
  } finally {
    db.close();
  }
}

/** 向隔离库写入指定状态的后置动作运行，默认值与服务端 preview writer 一致。 */
function insertActionRun(db, overrides = {}) {
  const row = {
    actionRunId: `migration-action-${Math.random().toString(16).slice(2)}`,
    runId: 'migration-run',
    datasetId: 'migration-dataset',
    actionKey: 'energy-flow-analysis',
    registryVersion: 'demo-post-actions:v1',
    resolverVersion: 'energy-flow-resolver:v1',
    executorVersion: 'energy-flow-executor:v1',
    clientRequestId: `migration-request-${Math.random().toString(16).slice(2)}`,
    manifestVersion: 'manifest:v1',
    manifestDigest: 'a'.repeat(64),
    registryDigest: 'b'.repeat(64),
    runtimeEpoch: 1,
    runtimeRevision: 1,
    inputDigest: 'c'.repeat(64),
    previewDigest: 'd'.repeat(64),
    outputCount: 0,
    resultDigest: null,
    previewExpiresAt: '2026-08-28T00:00:00.000Z',
    inputJson: '{}',
    blockerJson: null,
    resultJson: null,
    requestedBy: 1,
    status: 'previewed',
    retryCount: 0,
    failureReason: null,
    createdAt: '2026-08-27T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides
  };
  db.prepare(`INSERT INTO demo_post_action_runs
    (action_run_id, run_id, dataset_id, action_key, registry_version, resolver_version,
     executor_version, client_request_id, manifest_version, manifest_digest, registry_digest,
     runtime_epoch, runtime_revision, input_digest, preview_digest, output_count, result_digest,
     preview_expires_at, input_json, blocker_json, result_json, requested_by, status, retry_count,
     failure_reason, created_at, started_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.actionRunId, row.runId, row.datasetId, row.actionKey, row.registryVersion,
    row.resolverVersion, row.executorVersion, row.clientRequestId, row.manifestVersion,
    row.manifestDigest, row.registryDigest, row.runtimeEpoch, row.runtimeRevision,
    row.inputDigest, row.previewDigest, row.outputCount, row.resultDigest, row.previewExpiresAt,
    row.inputJson, row.blockerJson, row.resultJson, row.requestedBy, row.status, row.retryCount,
    row.failureReason, row.createdAt, row.startedAt, row.completedAt, row.updatedAt
  );
  return row;
}

/** 断言 SQLite CHECK、触发器或外键合同拒绝指定写入。 */
function assertSqliteConstraint(operation) {
  assert.throws(operation, (error) => (
    String(error.code || '').startsWith('SQLITE_CONSTRAINT')
      || /constraint|mismatch|expiry/i.test(String(error.message || ''))
  ));
}

try {
  const freshPath = path.join(tmpDir, 'fresh.sqlite');
  initDatabase({ databasePath: freshPath });
  let db = openDatabase({ databasePath: freshPath });
  try {
    const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert(tableNames.has('demo_post_action_runs'));
    assert(tableNames.has('demo_post_action_outputs'));
    assert(db.prepare('PRAGMA table_info(demo_post_action_runs)').all().some((column) => column.name === 'output_count'));
    const requiredPermissionCodes = [...new Set(listDemoPostActions().flatMap((action) => [
      action.previewPermission,
      action.executePermission
    ]))].sort();
    const permissionPlaceholders = requiredPermissionCodes.map(() => '?').join(',');
    const postActionPermissions = db.prepare(`SELECT permission_code AS permissionCode
      FROM sys_menus WHERE permission_code IN (${permissionPlaceholders})
      ORDER BY permission_code`).all(...requiredPermissionCodes).map((row) => row.permissionCode);
    assert.deepStrictEqual(postActionPermissions, requiredPermissionCodes);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, CANONICAL_SCHEMA_VERSION);
  } finally {
    db.close();
  }

  // 目标版本重复初始化必须保持 schema fingerprint 稳定。
  initDatabase({ databasePath: freshPath });
  db = openDatabase({ databasePath: freshPath });
  const stableFingerprint = calculateSchemaFingerprint(db);
  db.close();
  initDatabase({ databasePath: freshPath });
  db = openDatabase({ databasePath: freshPath });
  assert.strictEqual(calculateSchemaFingerprint(db), stableFingerprint);
  db.close();

  const predecessorPath = path.join(tmpDir, 'predecessor.sqlite');
  prepareExactPredecessor(predecessorPath);
  initDatabase({ databasePath: predecessorPath });
  db = openDatabase({ databasePath: predecessorPath });
  try {
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_post_action_runs'").get());
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_post_action_outputs'").get());
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, CANONICAL_SCHEMA_VERSION);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value, calculateSchemaFingerprint(db));
  } finally {
    db.close();
  }

  // 平衡来源列经 ALTER 补齐的 predecessor 必须被精确接受，并保留夹具与物理 profile。
  const alteredBalancePath = path.join(tmpDir, 'altered-balance-predecessor.sqlite');
  const alteredBalanceFixture = prepareAlteredEnergyBalancePredecessor(alteredBalancePath);
  initDatabase({ databasePath: alteredBalancePath });
  db = openDatabase({ databasePath: alteredBalancePath });
  let alteredBalanceMigratedFingerprint;
  try {
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_post_action_runs'").get());
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'demo_post_action_outputs'").get());
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM energy_balance_boundaries WHERE boundary_code = 'POST-ACTION-ALTER'").get().count,
      1
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM energy_balance_items WHERE item_code = 'POST-ACTION-ALTER-INPUT'").get().count,
      1
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS count FROM strategy_rules WHERE id = ?').get(alteredBalanceFixture.strategyFixture.ruleId).count,
      1,
      'energy-balance ALTER + run turnover predecessor 组合迁移必须保留显式策略规则。'
    );
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS count FROM strategy_rule_hits WHERE strategy_rule_id = ?')
        .get(alteredBalanceFixture.strategyFixture.ruleId).count,
      1,
      'energy-balance ALTER + run turnover predecessor 组合迁移必须保留策略命中入向外键行。'
    );
    assert.deepStrictEqual(
      db.prepare('SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber FROM strategy_rules WHERE id = ?')
        .get(alteredBalanceFixture.strategyFixture.ruleId),
      { sourceBatchId: null, sourceRowNumber: null },
      '组合迁移后的历史策略规则 provenance 必须保持 NULL/NULL。'
    );
    const boundaryColumns = getTableColumns(db, 'energy_balance_boundaries');
    const itemColumns = getTableColumns(db, 'energy_balance_items');
    assert(boundaryColumns.indexOf('source_batch_id') > boundaryColumns.indexOf('updated_at'));
    assert(itemColumns.indexOf('source_batch_id') > itemColumns.indexOf('updated_at'));
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, CANONICAL_SCHEMA_VERSION);
    alteredBalanceMigratedFingerprint = calculateSchemaFingerprint(db);
    assert.strictEqual(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      alteredBalanceMigratedFingerprint
    );
    assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
  // ALTER 物理 profile 升级后重复初始化必须保持 fingerprint 稳定。
  assert.doesNotThrow(() => initDatabase({ databasePath: alteredBalancePath }));
  db = openDatabase({ databasePath: alteredBalancePath });
  try {
    assert.strictEqual(calculateSchemaFingerprint(db), alteredBalanceMigratedFingerprint);
    assert.deepStrictEqual(
      db.prepare(`SELECT id, rule_code AS ruleCode, rule_version AS ruleVersion,
        source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
        FROM strategy_rules WHERE id = ?`).get(alteredBalanceFixture.strategyFixture.ruleId),
      {
        id: alteredBalanceFixture.strategyFixture.ruleId,
        ruleCode: alteredBalanceFixture.strategyFixture.ruleCode,
        ruleVersion: alteredBalanceFixture.strategyFixture.ruleVersion,
        sourceBatchId: null,
        sourceRowNumber: null
      },
      '组合 profile 二次初始化后必须继续保留 populated 策略规则及 NULL/NULL provenance。'
    );
    assert.deepStrictEqual(
      db.prepare(`SELECT id, evaluation_run_id AS evaluationRunId, strategy_rule_id AS strategyRuleId
        FROM strategy_rule_hits WHERE id = ?`).get(alteredBalanceFixture.strategyFixture.hitId),
      {
        id: alteredBalanceFixture.strategyFixture.hitId,
        evaluationRunId: alteredBalanceFixture.strategyFixture.evaluationRunId,
        strategyRuleId: alteredBalanceFixture.strategyFixture.ruleId
      },
      '组合 profile 二次初始化后必须继续保留 strategy_rule_hits 入向外键行。'
    );
    assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }

  // ALTER predecessor 同步登记无关索引后仍必须 fail-closed，且不得放宽精确 v3 predecessor profile。
  const alteredBalanceDriftPath = path.join(tmpDir, 'altered-balance-drift.sqlite');
  const alteredBalanceDrift = prepareAlteredEnergyBalancePredecessor(
    alteredBalanceDriftPath,
    { addUnexpectedIndex: true, fixtureSuffix: 'alter-drift' }
  );
  assert.throws(
    () => initDatabase({ databasePath: alteredBalanceDriftPath }),
    (error) => error.code === 'SCHEMA_FINGERPRINT_MISMATCH'
      && error.details.schemaVersion === PREDECESSOR_VERSION
      && error.details.issues.some((issue) => issue.includes('unexpected:index:idx_energy_balance_boundaries_unexpected_post_action'))
  );
  db = openDatabase({ databasePath: alteredBalanceDriftPath });
  try {
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('demo_post_action_runs', 'demo_post_action_outputs')").get().count,
      2
    );
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, PREDECESSOR_VERSION);
    assert.strictEqual(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      alteredBalanceDrift.fingerprint
    );
    assert.strictEqual(calculateSchemaFingerprint(db), alteredBalanceDrift.fingerprint);
  } finally {
    db.close();
  }

  // predecessor 含孤儿外键时，迁移 DDL、RBAC seed 和 metadata 必须整体回滚。
  const fkViolationPath = path.join(tmpDir, 'fk-violation.sqlite');
  const predecessorFingerprint = prepareExactPredecessor(fkViolationPath);
  db = openDatabase({ databasePath: fkViolationPath });
  const orphanRole = {
    userId: 987654,
    roleId: 987655,
    createdAt: '2026-08-27T00:00:00.000Z'
  };
  const businessUnit = {
    unitCode: 'atomic-business-unit',
    unitName: '原业务数据',
    unitPath: '/atomic-business-unit',
    unitType: 'enterprise',
    remark: '完整性失败后必须保持不变'
  };
  try {
    db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, remark)
      VALUES (?, ?, ?, ?, ?)`)
      .run(businessUnit.unitCode, businessUnit.unitName, businessUnit.unitPath, businessUnit.unitType, businessUnit.remark);
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(orphanRole.userId, orphanRole.roleId, orphanRole.createdAt);
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: fkViolationPath }),
    (error) => error.code === 'SQLITE_FOREIGN_KEY_CHECK_FAILED'
  );
  db = openDatabase({ databasePath: fkViolationPath });
  try {
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('demo_post_action_runs', 'demo_post_action_outputs')").get().count,
      2,
      'v3 predecessor 原有后置动作表必须保持不变。'
    );
    assert(!getTableColumns(db, 'demo_dataset_runs').includes('superseded_at'),
      '完整性失败后 run 自动换代结构迁移必须回滚。');
    assert.strictEqual(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      PREDECESSOR_VERSION
    );
    assert.strictEqual(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      predecessorFingerprint
    );
    assert.deepStrictEqual(
      db.prepare('SELECT user_id AS userId, role_id AS roleId, created_at AS createdAt FROM sys_user_roles WHERE user_id = ? AND role_id = ?')
        .get(orphanRole.userId, orphanRole.roleId),
      orphanRole
    );
    assert.deepStrictEqual(
      db.prepare('SELECT unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, unit_type AS unitType, remark FROM organization_units WHERE unit_code = ?')
        .get(businessUnit.unitCode),
      businessUnit
    );
  } finally {
    db.close();
  }

  // pre-existing CHECK 违规也必须在提交前被 quick_check 捕获并整体回滚。
  const checkViolationPath = path.join(tmpDir, 'check-violation.sqlite');
  const checkViolationFingerprint = prepareExactPredecessor(checkViolationPath);
  db = openDatabase({ databasePath: checkViolationPath });
  try {
    db.pragma('ignore_check_constraints = ON');
    db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, area)
      VALUES ('invalid-check-unit', 'CHECK 违规数据', '/invalid-check-unit', 'enterprise', -1)`).run();
    db.pragma('ignore_check_constraints = OFF');
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: checkViolationPath }),
    (error) => error.code === 'SQLITE_QUICK_CHECK_FAILED'
  );
  db = openDatabase({ databasePath: checkViolationPath });
  try {
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('demo_post_action_runs', 'demo_post_action_outputs')").get().count,
      2
    );
    assert.strictEqual(db.prepare("SELECT area FROM organization_units WHERE unit_code = 'invalid-check-unit'").get().area, -1);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, PREDECESSOR_VERSION);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value, checkViolationFingerprint);
  } finally {
    db.close();
  }

  // RBAC seed 在事务中发生 canonical 碰撞时，前序 seed 写入与 DDL/metadata 必须一并回滚。
  const seedCollisionPath = path.join(tmpDir, 'seed-collision.sqlite');
  const seedCollisionFingerprint = prepareExactPredecessor(seedCollisionPath);
  db = openDatabase({ databasePath: seedCollisionPath });
  try {
    db.prepare("DELETE FROM sys_menus WHERE permission_code = 'system:demo:toggle'").run();
    db.prepare("UPDATE sys_menus SET sort_order = 999 WHERE permission_code = 'carbon:ghg-reports:view'").run();
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: seedCollisionPath }),
    (error) => error.code === 'GHG_REPORT_PERMISSION_MENU_COLLISION'
  );
  db = openDatabase({ databasePath: seedCollisionPath });
  try {
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('demo_post_action_runs', 'demo_post_action_outputs')").get().count,
      2
    );
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_menus WHERE permission_code = 'system:demo:toggle'").get().count, 0);
    assert.strictEqual(db.prepare("SELECT sort_order FROM sys_menus WHERE permission_code = 'carbon:ghg-reports:view'").get().sort_order, 999);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, PREDECESSOR_VERSION);
    assert.strictEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value, seedCollisionFingerprint);
  } finally {
    db.close();
  }

  // 状态、时间、摘要、JSON、dataset 和 output_count 合同的隔离矩阵。
  const contractPath = path.join(tmpDir, 'contract.sqlite');
  initDatabase({ databasePath: contractPath });
  db = openDatabase({ databasePath: contractPath });
  try {
    db.prepare(`INSERT INTO demo_dataset_runs
      (run_id, dataset_id, manifest_version, manifest_digest, status, created_by,
       created_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run('migration-run', 'migration-dataset', 'manifest:v1', 'e'.repeat(64), 1, '2026-08-27T00:00:00.000Z');

    const validRows = [
      { status: 'previewed' },
      { status: 'blocked', blockerJson: '{"code":"BLOCKED"}' },
      { status: 'executing', startedAt: '2026-08-27T00:01:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z' },
      {
        status: 'succeeded',
        startedAt: '2026-08-27T00:01:00.000Z',
        completedAt: '2026-08-27T00:02:00.000Z',
        updatedAt: '2026-08-27T00:02:00.000Z',
        resultDigest: 'e'.repeat(64),
        resultJson: '{"analysis":{},"outputCount":0}'
      },
      {
        status: 'failed',
        startedAt: '2026-08-27T00:01:00.000Z',
        completedAt: '2026-08-27T00:02:00.000Z',
        updatedAt: '2026-08-27T00:02:00.000Z',
        failureReason: 'test failure'
      },
      {
        status: 'expired',
        completedAt: '2026-08-27T00:02:00.000Z',
        updatedAt: '2026-08-27T00:02:00.000Z',
        failureReason: 'expired preview'
      }
    ];
    const insertedRows = validRows.map((row) => insertActionRun(db, row));
    assert.strictEqual(insertedRows.length, 6);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_runs').get().count, 6);
    assert.strictEqual(
      db.prepare("SELECT completed_at FROM demo_post_action_runs WHERE status = 'blocked'").get().completed_at,
      null
    );

    // dataset_id 不能跨父运行伪造，父 dataset_id 也不能破坏已有子行。
    assertSqliteConstraint(() => insertActionRun(db, { datasetId: 'other-dataset' }));
    assertSqliteConstraint(() => db.prepare('UPDATE demo_dataset_runs SET dataset_id = ? WHERE run_id = ?')
      .run('other-dataset', 'migration-run'));

    // 以前可写入的矛盾状态必须被状态 CHECK 拒绝。
    const invalidStates = [
      { status: 'previewed', blockerJson: '{"code":"BLOCKED"}' },
      { status: 'previewed', startedAt: '2026-08-27T00:01:00.000Z' },
      { status: 'previewed', resultDigest: 'e'.repeat(64), resultJson: '{}' },
      { status: 'blocked', resultDigest: 'e'.repeat(64), resultJson: '{}' },
      { status: 'blocked', blockerJson: '{"code":"BLOCKED"}', completedAt: '2026-08-27T00:02:00.000Z' },
      { status: 'executing', completedAt: '2026-08-27T00:02:00.000Z', startedAt: '2026-08-27T00:01:00.000Z' },
      { status: 'succeeded', startedAt: '2026-08-27T00:01:00.000Z', completedAt: '2026-08-27T00:02:00.000Z' },
      { status: 'failed', completedAt: '2026-08-27T00:02:00.000Z' },
      { status: 'expired', startedAt: '2026-08-27T00:01:00.000Z', completedAt: '2026-08-27T00:02:00.000Z', failureReason: 'expired' }
    ];
    invalidStates.forEach((row) => assertSqliteConstraint(() => insertActionRun(db, row)));

    // 摘要、JSON、UTC、时间顺序和预演过期边界必须拒绝。
    [
      { manifestDigest: 'A'.repeat(64) },
      { inputJson: '[]' },
      { resultDigest: 'e'.repeat(64) },
      { createdAt: '2026-08-27T00:00:00+08:00' },
      { updatedAt: '2026-08-26T23:59:59.000Z' },
      { startedAt: '2026-08-26T23:59:59.000Z' },
      { status: 'succeeded', startedAt: '2026-08-27T00:01:00.000Z', completedAt: '2026-08-27T00:00:30.000Z', resultDigest: 'e'.repeat(64), resultJson: '{}' },
      { previewExpiresAt: '2026-08-27T00:00:00.000Z' }
    ].forEach((row) => assertSqliteConstraint(() => insertActionRun(db, row)));

    const executing = insertedRows.find((row) => row.status === 'executing');
    db.prepare(`INSERT INTO demo_post_action_outputs
      (action_run_id, output_entity_type, output_entity_id, output_ref_json)
      VALUES (?, ?, ?, ?)`)
      .run(executing.actionRunId, 'energy-flow-record', 'executing-output', '{"id":"executing-output"}');
    assert.strictEqual(
      db.prepare('SELECT output_count FROM demo_post_action_runs WHERE action_run_id = ?').get(executing.actionRunId).output_count,
      1
    );
    db.prepare('DELETE FROM demo_post_action_outputs WHERE action_run_id = ?')
      .run(executing.actionRunId);
    assert.strictEqual(
      db.prepare('SELECT output_count FROM demo_post_action_runs WHERE action_run_id = ?').get(executing.actionRunId).output_count,
      0
    );

    const succeeded = insertedRows.find((row) => row.status === 'succeeded');
    db.prepare(`INSERT INTO demo_post_action_outputs
      (action_run_id, output_entity_type, output_entity_id, output_ref_json)
      VALUES (?, ?, ?, ?)`)
      .run(succeeded.actionRunId, 'energy-flow-record', 'output-1', '{"id":"output-1"}');
    assert.strictEqual(
      db.prepare('SELECT output_count FROM demo_post_action_runs WHERE action_run_id = ?').get(succeeded.actionRunId).output_count,
      1
    );
    assertSqliteConstraint(() => db.prepare('UPDATE demo_post_action_runs SET output_count = 0 WHERE action_run_id = ?')
      .run(succeeded.actionRunId));
    assertSqliteConstraint(() => db.prepare(`INSERT INTO demo_post_action_outputs
      (action_run_id, output_entity_type, output_entity_id, output_ref_json)
      VALUES (?, ?, ?, ?)`)
      .run(succeeded.actionRunId, 'energy-flow-record', 'output-2', '[]'));
    db.prepare('DELETE FROM demo_post_action_outputs WHERE action_run_id = ? AND output_entity_id = ?')
      .run(succeeded.actionRunId, 'output-1');
    assert.strictEqual(
      db.prepare('SELECT output_count FROM demo_post_action_runs WHERE action_run_id = ?').get(succeeded.actionRunId).output_count,
      0
    );
  } finally {
    db.close();
  }

  const unknownPath = path.join(tmpDir, 'unknown.sqlite');
  prepareExactPredecessor(unknownPath);
  db = openDatabase({ databasePath: unknownPath });
  try {
    db.exec('CREATE TABLE rogue_demo_post_action_object (id INTEGER PRIMARY KEY);');
    const fingerprint = calculateSchemaFingerprint(db);
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'").run(fingerprint);
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: unknownPath }),
    (error) => error.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );

  const partialPath = path.join(tmpDir, 'partial.sqlite');
  prepareExactPredecessor(partialPath);
  db = openDatabase({ databasePath: partialPath });
  try {
    // v2 已包含完整后置动作治理对象；删去其中一张表模拟不完整 predecessor。
    db.exec('DROP TABLE demo_post_action_outputs;');
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'")
      .run(calculateSchemaFingerprint(db));
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: partialPath }),
    (error) => error.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );

  const metadataMismatchPath = path.join(tmpDir, 'metadata-mismatch.sqlite');
  prepareExactPredecessor(metadataMismatchPath, 'a'.repeat(64));
  assert.throws(
    () => initDatabase({ databasePath: metadataMismatchPath }),
    (error) => error.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );

  console.log('demoPostActionMigration.test.js passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
