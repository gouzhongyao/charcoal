'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// 测试只使用系统临时目录，禁止接触真实业务 SQLite。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-analysis-schema-'));
const dataDir = path.join(tmpDir, 'data');
process.env.DATA_DIR = dataDir;
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

// current canonical 初始化身份为 v4；历史能流 predecessor fixture 继续保留业务模型 v1。
const CURRENT_CANONICAL_SCHEMA_VERSION = '2026-08-30-formal-canonical-v4';
const HISTORICAL_ENERGY_FLOW_PREDECESSOR_MODEL_VERSION = 'legacy:v1';

// 能源分析底座与 N8 canonical v2 必须创建的二十七张业务表。
const EXPECTED_TABLES = [
  'energy_timeseries_records',
  'shift_definitions',
  'shift_schedule_records',
  'device_state_records',
  'tou_schemes',
  'tou_period_rules',
  'energy_conversion_factors',
  'strategy_rules',
  'strategy_evaluation_runs',
  'strategy_rule_hits',
  'benchmark_definitions',
  'benchmark_targets',
  'energy_flow_models',
  'energy_flow_assets',
  'energy_flow_paths',
  'energy_flow_nodes',
  'energy_flow_edges',
  'energy_flow_records',
  'energy_flow_waste_heat_facts',
  'energy_flow_loss_facts',
  'energy_flow_loss_evidence',
  'energy_balance_boundaries',
  'energy_balance_items',
  'energy_balance_calculation_runs',
  'energy_balance_snapshots',
  'energy_balance_snapshot_items',
  'energy_balance_suggestions'
];

// import_batches 保留历史、能源分析配置、供应商、独立碳活动、N6 碳排放报告和 N7 温室气体报告导入值。
const EXPECTED_IMPORT_TYPES = [
  'energy_record',
  'meter_reading',
  'organization_unit',
  'meter_device',
  'production_unit',
  'production_output',
  'generation_record',
  'energy_budget',
  'carbon_factor',
  'prediction_config',
  'energy_timeseries',
  'shift_schedule',
  'device_state',
  'energy_conversion_factor',
  'energy_benchmark',
  'energy_flow_node',
  'energy_flow_edge',
  'energy_flow_record',
  'shift_definition',
  'tou_scheme',
  'strategy_rule',
  'energy_flow_model',
  'energy_balance_boundary',
  'energy_balance_item',
  'energy_flow_workbook',
  'supplier',
  'carbon_activity',
  'carbon_emission_report',
  'ghg_report'
];

// 关键候选查询索引覆盖重叠事务校验、来源追溯和结果查询。
const EXPECTED_INDEXES = [
  'idx_energy_timeseries_stream_range',
  'idx_shift_schedule_scope_range',
  'idx_device_state_meter_range',
  'idx_conversion_factors_match',
  'idx_strategy_hits_run_status',
  'idx_benchmark_definitions_match',
  'idx_energy_flow_records_edge_range',
  'idx_energy_balance_runs_boundary_created',
  'idx_energy_balance_snapshots_run',
  'idx_energy_balance_snapshots_boundary_range',
  'idx_energy_balance_suggestions_run_status',
  'idx_energy_balance_suggestions_snapshot_status'
];

/**
 * 针对指定隔离 SQLite 路径重新加载数据库模块。
 * @param {string} databaseFilePath 隔离数据库路径。
 * @returns {object} 数据库模块。
 */
function loadDatabaseModule(databaseFilePath) {
  process.env.SQLITE_PATH = databaseFilePath;
  const modulePath = require.resolve('../db/database');
  delete require.cache[modulePath];
  return require('../db/database');
}

/**
 * 为 SQLite 标识符添加双引号转义。
 * @param {string} identifier 标识符。
 * @returns {string} 可安全拼接到测试 SQL 的标识符。
 */
function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * 读取表的建表 SQL。
 * @param {object} db SQLite 连接。
 * @param {string} tableName 表名。
 * @returns {string} 建表 SQL。
 */
function getCreateSql(db, tableName) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return row ? row.sql || '' : '';
}

/**
 * 读取数据库全部显式索引名称。
 * @param {object} db SQLite 连接。
 * @returns {string[]} 索引名称。
 */
function getIndexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
}

/**
 * 将治理运行表替换为字段完整但摘要 CHECK 较弱的旧表，并可替换指定运行摘要。
 * @param {object} db SQLite 连接。
 * @param {string} runId 待替换摘要的运行 ID。
 * @param {string} weakManifestDigest 不可信旧摘要。
 */
function weakenDemoDatasetRunsSha256Contract(db, runId, weakManifestDigest) {
  // 表替换前拆除所有引用父表的 post-action 触发器，替换后按原 SQL 恢复，保持测试夹具与生产迁移相同的生命周期。
  const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger'
      AND (tbl_name = 'demo_dataset_runs'
        OR instr(lower(COALESCE(sql, '')), 'demo_dataset_runs') > 0)
    ORDER BY name`).all();
  dependentTriggers.forEach((trigger) => db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`));

  db.pragma('foreign_keys = OFF');
  db.exec(`DROP INDEX IF EXISTS ux_demo_dataset_runs_active_dataset;
    DROP INDEX IF EXISTS idx_demo_dataset_runs_status_created;
    DROP TABLE IF EXISTS demo_dataset_runs_sha256_weak;
    CREATE TABLE demo_dataset_runs_sha256_weak (
      run_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      manifest_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cleanup_pending', 'cleaning', 'cleaned', 'failed', 'superseded')),
      created_by INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      cleanup_started_at TEXT,
      cleaned_at TEXT,
      failure_reason TEXT,
      superseded_at TEXT,
      successor_run_id TEXT,
      superseded_by INTEGER,
      supersede_reason TEXT,
      supersede_trigger TEXT,
      FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
      FOREIGN KEY (successor_run_id) REFERENCES demo_dataset_runs_sha256_weak(run_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (superseded_by) REFERENCES sys_users(id) ON DELETE SET NULL,
      CHECK (length(trim(run_id)) BETWEEN 1 AND 128),
      CHECK (length(trim(dataset_id)) BETWEEN 1 AND 128),
      CHECK (length(trim(manifest_version)) BETWEEN 1 AND 64),
      CHECK ((status = 'cleaned' AND cleaned_at IS NOT NULL)
        OR (status <> 'cleaned' AND cleaned_at IS NULL)),
      CHECK (successor_run_id IS NULL OR successor_run_id <> run_id),
      CHECK (
        (status = 'superseded' AND superseded_at IS NOT NULL AND successor_run_id IS NOT NULL
          AND supersede_reason IS NOT NULL AND supersede_trigger IS NOT NULL)
        OR (status <> 'superseded' AND superseded_at IS NULL AND successor_run_id IS NULL
          AND superseded_by IS NULL AND supersede_reason IS NULL AND supersede_trigger IS NULL)
      )
    );
    INSERT INTO demo_dataset_runs_sha256_weak
      (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
       completed_at, cleanup_started_at, cleaned_at, failure_reason, superseded_at,
       successor_run_id, superseded_by, supersede_reason, supersede_trigger)
    SELECT run_id, dataset_id, manifest_version,
      CASE WHEN run_id = '${runId}' THEN '${weakManifestDigest}' ELSE manifest_digest END,
      status, created_by, created_at, completed_at, cleanup_started_at, cleaned_at, failure_reason,
      superseded_at, successor_run_id, superseded_by, supersede_reason, supersede_trigger
    FROM demo_dataset_runs;
    DROP TABLE demo_dataset_runs;
    ALTER TABLE demo_dataset_runs_sha256_weak RENAME TO demo_dataset_runs;
    CREATE UNIQUE INDEX ux_demo_dataset_runs_active_dataset
      ON demo_dataset_runs(dataset_id)
      WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning');
    CREATE INDEX idx_demo_dataset_runs_status_created
      ON demo_dataset_runs(status, created_at DESC);`);
  dependentTriggers.forEach((trigger) => db.exec(trigger.sql));
  db.pragma('foreign_keys = ON');
}

/**
 * 将 context 表替换为字段完整但 SHA CHECK 较弱的旧表。
 * @param {object} db SQLite 连接。
 */
function weakenDemoImportContextsSha256Contract(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS demo_run_import_batches;
    DROP TABLE demo_import_contexts;
    CREATE TABLE demo_import_contexts (
      context_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      run_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      manifest_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
      artifact_key TEXT NOT NULL,
      handler_key TEXT NOT NULL,
      artifact_file_sha256 TEXT NOT NULL CHECK (length(artifact_file_sha256) = 64),
      issued_to_user_id INTEGER NOT NULL,
      runtime_epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      upload_file_sha256 TEXT,
      preview_digest TEXT,
      previewed_at TEXT,
      executed_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT,
      reassociated_from_context_id TEXT,
      replacement_context_id TEXT,
      reassociated_at TEXT,
      FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
      FOREIGN KEY (issued_to_user_id) REFERENCES sys_users(id) ON DELETE RESTRICT,
      UNIQUE (context_id, run_id, artifact_key)
    );`);
  db.pragma('foreign_keys = ON');
}

/**
 * 写入可验证迁移行为的运行和预演 context。
 * @param {object} db SQLite 连接。
 * @param {object} input 测试身份与摘要。
 */
function seedDemoSha256MigrationContext(db, input) {
  const admin = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get();
  assert(admin, 'SHA 迁移测试需要隔离库内置管理员。');
  db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at)
    VALUES (?, ?, '1.0.0', ?, 'failed', ?, '2026-08-13T00:00:00.000Z')`)
    .run(input.runId, input.datasetId, input.runManifestDigest, admin.id);
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
     artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
     status, issued_at, expires_at, upload_file_sha256, preview_digest, previewed_at)
    VALUES (?, ?, ?, ?, '1.0.0', ?, ?, 'energy-analysis:shift-definition', ?, ?, 1,
      'previewed', '2026-08-13T00:00:00.000Z', '2026-08-13T01:00:00.000Z', ?,
      ?, '2026-08-13T00:10:00.000Z')`)
    .run(input.contextId, input.tokenHash, input.runId, input.datasetId,
      input.contextManifestDigest, input.artifactKey, input.artifactFileSha256,
      admin.id, input.uploadFileSha256, `hmac-sha256:v1:audit:${'f'.repeat(64)}`);
}

/**
 * 断言执行 SQL 被 CHECK 或外键约束拒绝。
 * @param {Function} action 待执行写入。
 * @param {string} message 断言说明。
 */
function assertConstraintFailure(action, message) {
  assert.throws(
    action,
    /(CHECK constraint failed|FOREIGN KEY constraint failed|benchmark target import source must contain batch and positive row together|energy flow (?:edge|record) import source must contain batch and positive row together)/,
    message
  );
}

/**
 * 断言正式初始化按稳定错误码拒绝现有 SQLite。
 * @param {Function} action 初始化动作。
 * @param {string} expectedCode 预期错误码。
 * @param {string} message 断言说明。
 */
function assertInitializationRejected(action, expectedCode, message) {
  assert.throws(
    action,
    (error) => error?.code === expectedCode,
    message
  );
}

/**
 * 断言带未知持久 schema 对象的未登记库在首次初始化时即被拒绝且不写 metadata。
 * @param {string} databaseFilePath 隔离 SQLite 路径。
 * @param {string} setupSql 未知 schema 对象建表语句。
 * @param {string[]} expectedObjectNames 应完整保留的对象名称。
 */
function assertUnknownSchemaObjectsRejected(databaseFilePath, setupSql, expectedObjectNames) {
  const seedDb = new Database(databaseFilePath);
  try {
    seedDb.exec(setupSql);
  } finally {
    seedDb.close();
  }
  const beforeDb = new Database(databaseFilePath, { readonly: true });
  const beforeObjects = beforeDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`).all();
  beforeDb.close();
  assert.deepStrictEqual(
    beforeObjects.map((schemaObject) => schemaObject.name).sort(),
    [...expectedObjectNames].sort(),
    '未知 schema 对象测试夹具必须精确建立预期对象。'
  );

  const databaseModule = loadDatabaseModule(databaseFilePath);
  assertInitializationRejected(
    () => databaseModule.initDatabase(),
    'UNKNOWN_EXISTING_SCHEMA',
    '任一未知持久 schema 对象都必须在首次初始化时 fail-closed。'
  );

  const afterDb = new Database(databaseFilePath, { readonly: true });
  try {
    assert.deepStrictEqual(
      afterDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`).all(),
      beforeObjects,
      '未知 schema 对象被拒绝后不得改写原始结构。'
    );
    assert.strictEqual(
      afterDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get().total,
      0,
      '未知 schema 对象被拒绝后不得污染 app_meta metadata。'
    );
  } finally {
    afterDb.close();
  }
}

/**
 * 断言对标目标来源列、外键和写入约束完整有效。
 * @param {object} db SQLite 连接。
 * @param {number} benchmarkDefinitionId 人工基准定义 ID。
 * @param {number} sourceBatchId 有效导入批次 ID。
 * @param {string} versionPrefix 测试版本前缀。
 */
function assertBenchmarkTargetImportSourceConstraints(db, benchmarkDefinitionId, sourceBatchId, versionPrefix) {
  const columns = new Map(db.prepare('PRAGMA table_info(benchmark_targets)').all().map((column) => [column.name, column]));
  assert(columns.has('source_batch_id'), 'benchmark_targets 必须包含 source_batch_id。');
  assert(columns.has('source_row_number'), 'benchmark_targets 必须包含 source_row_number。');
  assert.strictEqual(columns.get('source_batch_id').notnull, 0, 'source_batch_id 必须可空。');
  assert.strictEqual(columns.get('source_row_number').notnull, 0, 'source_row_number 必须可空。');

  const sourceForeignKey = db.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
    .find((foreignKey) => foreignKey.from === 'source_batch_id');
  assert(sourceForeignKey, 'benchmark_targets.source_batch_id 必须声明外键。');
  assert.strictEqual(sourceForeignKey.table, 'import_batches');
  assert.strictEqual(sourceForeignKey.to, 'id');
  assert.strictEqual(sourceForeignKey.on_delete, 'NO ACTION', '删除导入批次不得级联删除或置空对标目标。');

  const insertTarget = db.prepare(`INSERT INTO benchmark_targets
    (source_batch_id, source_row_number, benchmark_definition_id, target_value, version, internal_revision)
    VALUES (?, ?, ?, 12, ?, ?)`);
  let nextInternalRevision = Number(db.prepare(`SELECT COALESCE(MAX(internal_revision), 0) + 1 AS nextRevision
    FROM benchmark_targets WHERE benchmark_definition_id = ?`).get(benchmarkDefinitionId).nextRevision);
  const insertWithRevision = (batchId, rowNumber, versionSuffix) => insertTarget.run(
    batchId,
    rowNumber,
    benchmarkDefinitionId,
    `${versionPrefix}:${versionSuffix}`,
    nextInternalRevision++
  );
  const validTargetId = insertWithRevision(sourceBatchId, 2, 'valid').lastInsertRowid;
  assert(validTargetId, '有效导入来源必须可写入对标目标。');
  assertConstraintFailure(
    () => insertWithRevision(999999999, 3, 'orphan'),
    '孤儿导入批次必须被外键拒绝。'
  );
  assertConstraintFailure(
    () => insertWithRevision(sourceBatchId, null, 'batch-only'),
    '只填写导入批次必须被成对约束拒绝。'
  );
  assertConstraintFailure(
    () => insertWithRevision(null, 4, 'row-only'),
    '只填写来源行号必须被成对约束拒绝。'
  );
  assertConstraintFailure(
    () => insertWithRevision(sourceBatchId, 0, 'zero-row'),
    '来源行号必须大于零。'
  );
  assertConstraintFailure(
    () => insertWithRevision(sourceBatchId, -1, 'negative-row'),
    '来源行号不得为负数。'
  );
  assertConstraintFailure(
    () => insertWithRevision(sourceBatchId, 1.5, 'fraction-row'),
    '来源行号必须是整数。'
  );
  assertConstraintFailure(
    () => db.prepare('UPDATE benchmark_targets SET source_batch_id = NULL WHERE id = ?').run(validTargetId),
    '更新时只清空来源批次必须被成对约束拒绝。'
  );
  assertConstraintFailure(
    () => db.prepare('UPDATE benchmark_targets SET source_row_number = NULL WHERE id = ?').run(validTargetId),
    '更新时只清空来源行号必须被成对约束拒绝。'
  );
  [0, -1, 1.5].forEach((invalidRowNumber) => {
    assertConstraintFailure(
      () => db.prepare('UPDATE benchmark_targets SET source_row_number = ? WHERE id = ?').run(invalidRowNumber, validTargetId),
      '更新来源行号时必须拒绝零、负数和小数。'
    );
  });
  assertConstraintFailure(
    () => db.prepare('DELETE FROM import_batches WHERE id = ?').run(sourceBatchId),
    '被对标目标引用的导入批次不得通用物理删除。'
  );
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM benchmark_targets WHERE id = ?').get(validTargetId).total, 1);
}

/**
 * 向 strategy_rules 写入一条可重复构造的测试规则。
 * @param {object} db SQLite 连接。
 * @param {number|string|null} sourceBatchId 来源批次值。
 * @param {number|string|null} sourceRowNumber 来源行号值。
 * @param {string} suffix 规则编码和版本后缀。
 * @returns {object} 插入结果。
 */
function insertStrategyRule(db, sourceBatchId, sourceRowNumber, suffix) {
  return db.prepare(`INSERT INTO strategy_rules
    (source_batch_id, source_row_number, rule_code, rule_name, rule_version, formula_version,
     metric_code, threshold_operator, threshold_value, threshold_unit, reduction_rate, priority,
     evidence_requirements_json, recommendation_text, source, effective_start_utc, effective_end_utc,
     source_timezone)
    VALUES (?, ?, ?, '策略规则', ?, 'strategy:v1', 'energy_intensity', 'gt', 1, 'kgce/t',
      0.1, 'medium', '{}', '测试建议', '测试来源', '2026-01-01T00:00:00Z',
      '2027-01-01T00:00:00Z', 'Asia/Shanghai')`)
    .run(sourceBatchId, sourceRowNumber, `TEST-RULE-${suffix}`, `test:${suffix}`);
}

/**
 * 创建只含历史导入审计表的旧库样例。
 * @param {string} databaseFilePath 隔离数据库路径。
 */
/**
 * 将隔离 canonical 库替换为精确已知、edge/record 尚无 provenance 的 populated 能流 v1。
 * @param {object} db 已注册项目 SQLite 函数的隔离连接。
 * @returns {{sourceBatchId:number,before:object}} 历史来源批次和四表业务快照。
 */
function installPopulatedEnergyFlowV1WithoutEdgeRecordProvenance(db) {
  const sourceBatchId = Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type)
    VALUES ('energy_flow_node', 'legacy-flow-nodes.xlsx', 'xlsx')`).run().lastInsertRowid);
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS energy_flow_loss_evidence;
      DROP TABLE IF EXISTS energy_flow_loss_facts;
      DROP TABLE IF EXISTS energy_flow_waste_heat_facts;
      DROP TABLE IF EXISTS energy_flow_records;
      DROP TABLE IF EXISTS energy_flow_edges;
      DROP TABLE IF EXISTS energy_flow_nodes;
      DROP TABLE IF EXISTS energy_flow_paths;
      DROP TABLE IF EXISTS energy_flow_assets;
      DROP TABLE IF EXISTS energy_flow_models;

      CREATE TABLE energy_flow_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_code TEXT NOT NULL,
        model_name TEXT NOT NULL,
        source TEXT NOT NULL,
        document_no TEXT,
        version TEXT NOT NULL,
        effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
        effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
        source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (model_code, version),
        CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
      );
      CREATE TABLE energy_flow_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_batch_id INTEGER,
        source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
        energy_flow_model_id INTEGER NOT NULL,
        node_code TEXT NOT NULL,
        node_name TEXT NOT NULL,
        node_type TEXT NOT NULL CHECK (node_type IN ('source', 'process', 'storage', 'sink', 'loss', 'boundary')),
        organization_unit_id INTEGER,
        x REAL NOT NULL,
        y REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
        FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
        UNIQUE (energy_flow_model_id, node_code),
        UNIQUE (energy_flow_model_id, id)
      );
      CREATE TABLE energy_flow_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        energy_flow_model_id INTEGER NOT NULL,
        edge_code TEXT NOT NULL,
        from_node_id INTEGER NOT NULL,
        to_node_id INTEGER NOT NULL,
        energy_type_id INTEGER NOT NULL,
        unit TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value')),
        source_mapping_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
        FOREIGN KEY (energy_flow_model_id, from_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (energy_flow_model_id, to_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
        UNIQUE (energy_flow_model_id, edge_code),
        UNIQUE (energy_flow_model_id, id),
        CHECK (from_node_id <> to_node_id),
        CHECK (
          CASE WHEN json_valid(source_mapping_json) = 1 THEN
            json_type(source_mapping_json) = 'object'
            AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
            AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
          ELSE 0 END
        )
      );
      CREATE TABLE energy_flow_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        energy_flow_model_id INTEGER NOT NULL,
        energy_flow_edge_id INTEGER NOT NULL,
        start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
        end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
        source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
        original_unit TEXT NOT NULL,
        original_value REAL NOT NULL CHECK (original_value >= 0),
        source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value')),
        source_mapping_json TEXT NOT NULL,
        formula_version TEXT NOT NULL,
        record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
        void_reason TEXT,
        voided_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE RESTRICT,
        FOREIGN KEY (energy_flow_model_id, energy_flow_edge_id) REFERENCES energy_flow_edges(energy_flow_model_id, id) ON DELETE RESTRICT,
        CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
        CHECK (
          CASE WHEN json_valid(source_mapping_json) = 1 THEN
            json_type(source_mapping_json) = 'object'
            AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
            AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
          ELSE 0 END
        ),
        CHECK (
          (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
          OR (
            record_status = 'void'
            AND trim(COALESCE(void_reason, '')) <> ''
            AND is_strict_utc_iso(voided_at) = 1
          )
        )
      );
      CREATE INDEX idx_energy_flow_models_effective ON energy_flow_models(status, effective_start_utc, effective_end_utc);
      CREATE INDEX idx_energy_flow_nodes_model_type ON energy_flow_nodes(energy_flow_model_id, node_type, status);
      CREATE INDEX idx_energy_flow_nodes_batch ON energy_flow_nodes(source_batch_id);
      CREATE INDEX idx_energy_flow_edges_model_type ON energy_flow_edges(energy_flow_model_id, source_type, status);
      CREATE INDEX idx_energy_flow_records_edge_range ON energy_flow_records(energy_flow_edge_id, record_status, start_utc, end_utc);`);

    const energyTypeId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
    db.prepare(`INSERT INTO energy_flow_models
      (id, model_code, model_name, source, document_no, version, effective_start_utc,
       effective_end_utc, source_timezone, status, created_at, updated_at)
      VALUES (101, 'LEGACY-FLOW', '历史能流模型', '历史人工配置', 'LEGACY-FLOW-DOC', 'legacy:v1',
       '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active',
       '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run();
    const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
      (id, source_batch_id, source_row_number, energy_flow_model_id, node_code, node_name,
       node_type, organization_unit_id, x, y, status, created_at, updated_at)
      VALUES (?, ?, ?, 101, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`);
    insertNode.run(201, sourceBatchId, 2, 'LEGACY-SOURCE', '历史源节点', 'source', 12.5, 20.25,
      'active', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    insertNode.run(202, sourceBatchId, 3, 'LEGACY-SINK', '历史汇节点', 'sink', 312.5, 20.25,
      'inactive', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    db.prepare(`INSERT INTO energy_flow_edges
      (id, energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
       unit, source_type, source_mapping_json, status, created_at, updated_at)
      VALUES (301, 101, 'LEGACY-EDGE', 201, 202, ?, 'kWh', 'explicit_edge_value',
       '{"reference":"legacy-edge:LEGACY-EDGE"}', 'active',
       '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run(energyTypeId);
    db.prepare(`INSERT INTO energy_flow_records
      (id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
       original_unit, original_value, source_type, source_mapping_json, formula_version,
       record_status, void_reason, voided_at, created_at, updated_at)
      VALUES (401, 101, 301, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z',
       'Asia/Shanghai', 'kWh', 1234.5, 'explicit_edge_value',
       '{"reference":"legacy-record:LEGACY-EDGE:202606"}', 'legacy-formula:v1',
       'active', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run();
  } finally {
    if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
  }
  const before = {
    models: db.prepare(`SELECT id, model_code, model_name, source, document_no, version,
      effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
      FROM energy_flow_models ORDER BY id`).all(),
    nodes: db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id, node_code,
      node_name, node_type, organization_unit_id, x, y, status, created_at, updated_at
      FROM energy_flow_nodes ORDER BY id`).all(),
    edges: db.prepare(`SELECT id, energy_flow_model_id, edge_code, from_node_id, to_node_id,
      energy_type_id, unit, source_type, source_mapping_json, status, created_at, updated_at
      FROM energy_flow_edges ORDER BY id`).all(),
    records: db.prepare(`SELECT id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc,
      source_timezone, original_unit, original_value, source_type, source_mapping_json,
      formula_version, record_status, void_reason, voided_at, created_at, updated_at
      FROM energy_flow_records ORDER BY id`).all()
  };
  return { sourceBatchId, before };
}

/**
 * 创建只含历史导入审计表的旧库样例。
 * @param {string} databaseFilePath 隔离数据库路径。
 */
function createLegacyDatabase(databaseFilePath) {
  const db = new Database(databaseFilePath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device')),
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
      file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
      file_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
      total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
      success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
      duplicate_strategy TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_strategy = 'skip'),
      field_mapping_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_summary TEXT,
      CHECK (success_count + failure_count + skipped_count <= total_rows OR status IN ('pending', 'processing'))
    );
    CREATE TABLE import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      row_number INTEGER NOT NULL CHECK (row_number >= 1),
      field_name TEXT,
      raw_value TEXT,
      error_code TEXT NOT NULL,
      error_reason TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
    );
    CREATE TABLE benchmark_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_batch_id INTEGER,
      source_row_number INTEGER,
      benchmark_code TEXT NOT NULL,
      benchmark_name TEXT NOT NULL,
      benchmark_type TEXT NOT NULL,
      metric_code TEXT NOT NULL,
      unit TEXT NOT NULL,
      period_type TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_reference TEXT NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL,
      document_no TEXT,
      version TEXT NOT NULL,
      effective_start_utc TEXT NOT NULL,
      effective_end_utc TEXT NOT NULL,
      source_timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (benchmark_code, version)
    );
    CREATE TABLE benchmark_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_definition_id INTEGER NOT NULL,
      target_value REAL,
      lower_bound REAL,
      upper_bound REAL,
      reference_start_utc TEXT,
      reference_end_utc TEXT,
      frozen_value REAL,
      frozen_at TEXT,
      sample_count INTEGER,
      production_summary_json TEXT,
      source_data_digest TEXT,
      is_frozen INTEGER NOT NULL DEFAULT 0,
      auto_refresh INTEGER NOT NULL DEFAULT 0,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (benchmark_definition_id) REFERENCES benchmark_definitions(id) ON DELETE CASCADE,
      UNIQUE (benchmark_definition_id, version)
    );`);
    db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count, error_summary)
      VALUES ('energy_record', 'legacy-energy.csv', 'legacy-energy-stored.csv', 'csv', 'completed_with_errors', 2, 1, 0, 1, '旧批次必须保留')`).run();
    db.prepare(`INSERT INTO import_errors
      (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
      VALUES (1, 2, 'energyType', '旧值', 'LEGACY_WARNING', '旧错误明细必须保留', 'warning')`).run();
    const legacyBenchmarkDefinitionId = db.prepare(`INSERT INTO benchmark_definitions
      (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
       direction, source, document_no, version, effective_start_utc, effective_end_utc, source_timezone)
      VALUES ('LEGACY-BENCHMARK', '旧库人工基准', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month',
       'organization', 'LEGACY-ORG', 'lower_better', '旧库测试', 'LEGACY-DOC-001',
       'benchmark-definition-internal-revision:v3',
       '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO benchmark_definitions
      (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
       direction, source, document_no, version, effective_start_utc, effective_end_utc, source_timezone, status)
      VALUES ('LEGACY-BENCHMARK', '旧库人工基准修订', 'manual_benchmark', 'energy_intensity', 'kgce/t', 'month',
       'organization', 'LEGACY-ORG', 'lower_better', '旧库测试', 'LEGACY-DOC-002',
       'benchmark-definition-internal-revision:v4',
       '2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z', 'Asia/Shanghai', 'inactive')`).run();
    db.prepare(`INSERT INTO benchmark_targets
      (benchmark_definition_id, target_value, version, status)
      VALUES (?, 15, 'benchmark-target-internal-revision:v3', 'inactive')`).run(legacyBenchmarkDefinitionId);
    db.prepare(`INSERT INTO benchmark_targets
      (benchmark_definition_id, target_value, version, status)
      VALUES (?, 14, 'benchmark-target-internal-revision:v4', 'inactive')`).run(legacyBenchmarkDefinitionId);
  } finally {
    db.close();
  }
}

/**
 * 为对标目标迁移场景写入人工目标、内部固化目标和有效来源批次。
 * @param {object} db SQLite 连接。
 * @param {string} prefix 唯一编码前缀。
 * @returns {{sourceBatchId: number, manualDefinitionId: number, internalTargetId: number, sourcedTargetId: number}} 场景主键。
 */
function seedBenchmarkTargetMigrationScenario(db, prefix) {
  const sourceBatchId = db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type)
    VALUES ('energy_benchmark', ?, 'csv')`).run(`${prefix}.csv`).lastInsertRowid;
  const insertDefinition = db.prepare(`INSERT INTO benchmark_definitions
    (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
     direction, source, document_no, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone)
    VALUES (?, ?, ?, 'energy_intensity', 'kgce/t', 'month', 'organization', ?,
     'lower_better', '迁移测试', ?, 'benchmark:v1', 1, '2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai')`);
  const manualDefinitionId = insertDefinition.run(
    `${prefix}-MANUAL`,
    `${prefix}人工基准`,
    'manual_benchmark',
    `${prefix}-ORG`,
    null
  ).lastInsertRowid;
  const internalDefinitionId = insertDefinition.run(
    `${prefix}-INTERNAL`,
    `${prefix}内部基准`,
    'internal_history_baseline',
    `${prefix}-ORG`,
    null
  ).lastInsertRowid;
  const sourcedTargetId = db.prepare(`INSERT INTO benchmark_targets
    (source_batch_id, source_row_number, benchmark_definition_id, target_value, version, internal_revision)
    VALUES (?, 2, ?, 11, 'preserved:v1', 1)`).run(sourceBatchId, manualDefinitionId).lastInsertRowid;
  const internalTargetId = db.prepare(`INSERT INTO benchmark_targets
    (benchmark_definition_id, target_value, reference_start_utc, reference_end_utc, frozen_value, frozen_at,
     production_summary_json, source_data_digest, is_frozen, auto_refresh, version, internal_revision)
    VALUES (?, 10, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 10, '2026-01-02T00:00:00Z',
     '{"output":100}', 'sha256:preserved', 1, 0, 'internal-preserved:v1', 1)`).run(internalDefinitionId).lastInsertRowid;
  return { sourceBatchId, manualDefinitionId, internalTargetId, sourcedTargetId };
}

/**
 * 将完整 benchmark_targets 降级为缺失或错误来源外键，并安装同名弱触发器。
 * @param {object} db SQLite 连接。
 * @param {object} databaseModule 数据库模块。
 * @param {string|null} sourceForeignKeyClause 替代来源外键；null 表示无来源外键。
 */
function degradeBenchmarkTargetSourceContract(db, databaseModule, sourceForeignKeyClause = null) {
  const originalCreateSql = getCreateSql(db, 'benchmark_targets');
  let degradedCreateSql = originalCreateSql.replace(
    /FOREIGN KEY\s*\(\s*source_batch_id\s*\)\s*REFERENCES\s+import_batches\s*\(\s*id\s*\)\s*,?/i,
    ''
  );
  if (sourceForeignKeyClause) {
    const closingParenthesisIndex = degradedCreateSql.lastIndexOf(')');
    degradedCreateSql = `${degradedCreateSql.slice(0, closingParenthesisIndex)},\n  ${sourceForeignKeyClause}\n${degradedCreateSql.slice(closingParenthesisIndex)}`;
  }
  degradedCreateSql = degradedCreateSql.replace(
    /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?benchmark_targets/i,
    'CREATE TABLE benchmark_targets__scenario'
  );

  const columnNames = db.prepare('PRAGMA table_info(benchmark_targets)').all().map((column) => column.name);
  const quotedColumns = columnNames.map((columnName) => `"${columnName}"`).join(', ');
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DROP TABLE IF EXISTS benchmark_targets__scenario');
    db.exec(degradedCreateSql);
    db.exec(`INSERT INTO benchmark_targets__scenario (${quotedColumns}) SELECT ${quotedColumns} FROM benchmark_targets`);
    db.exec('DROP TRIGGER IF EXISTS trg_benchmark_definitions_internal_update');
    db.exec('DROP TABLE benchmark_targets');
    db.exec('ALTER TABLE benchmark_targets__scenario RENAME TO benchmark_targets');
  } finally {
    if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
  }

  databaseModule.ensureEnergyAnalysisTables(db);
  db.exec(`DROP TRIGGER IF EXISTS trg_benchmark_targets_source_insert;
    DROP TRIGGER IF EXISTS trg_benchmark_targets_source_update;
    CREATE TRIGGER trg_benchmark_targets_source_insert
    BEFORE INSERT ON benchmark_targets
    FOR EACH ROW WHEN 0
    BEGIN
      SELECT RAISE(ABORT, 'weak insert trigger must be replaced');
    END;
    CREATE TRIGGER trg_benchmark_targets_source_update
    BEFORE UPDATE OF source_batch_id, source_row_number ON benchmark_targets
    FOR EACH ROW WHEN 0
    BEGIN
      SELECT RAISE(ABORT, 'weak update trigger must be replaced');
    END;
    CREATE INDEX IF NOT EXISTS idx_benchmark_targets_preserved_probe ON benchmark_targets(status, version);`);
}

try {
  fs.mkdirSync(dataDir, { recursive: true });

  // 新库初始化必须一次性建立完整表、索引和全部 import_type CHECK。
  const newDatabasePath = path.join(dataDir, 'energy-analysis-new.sqlite');
  const newDatabaseModule = loadDatabaseModule(newDatabasePath);
  newDatabaseModule.initDatabase();
  assert.strictEqual(newDatabaseModule.getDatabaseInfo().databasePath, newDatabasePath, '新库测试必须使用隔离 SQLite。');
  assert.deepStrictEqual(newDatabaseModule.IMPORT_BATCH_TYPES, EXPECTED_IMPORT_TYPES, '导入类型白名单必须精确匹配历史、能源分析配置、供应商、独立碳活动与碳排放报告导入类型。');

  const newDb = newDatabaseModule.openDatabase();
  try {
    const tableNames = new Set(newDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    EXPECTED_TABLES.forEach((tableName) => assert(tableNames.has(tableName), `新库缺少 ${tableName}。`));
    const indexNames = new Set(getIndexNames(newDb));
    EXPECTED_INDEXES.forEach((indexName) => assert(indexNames.has(indexName), `新库缺少 ${indexName}。`));

    assert.strictEqual(newDatabaseModule.CANONICAL_SCHEMA_VERSION, CURRENT_CANONICAL_SCHEMA_VERSION,
      '数据库模块导出的 current canonical 版本必须保持 v4。');
    assert.strictEqual(newDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_stage'").get().value, 'formal-canonical');
    assert.strictEqual(newDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      CURRENT_CANONICAL_SCHEMA_VERSION, 'current 初始化必须写入 formal-canonical v4。');
    const freshSchemaFingerprint = newDatabaseModule.calculateSchemaFingerprint(newDb);
    const freshTrustedProfile = newDatabaseModule.matchTrustedCanonicalSchemaProfile(
      newDb,
      CURRENT_CANONICAL_SCHEMA_VERSION
    );
    assert.strictEqual(freshTrustedProfile.profileName, 'canonical',
      'fresh schema 必须命中代码控制的 current canonical profile。');
    assert.strictEqual(freshTrustedProfile.fingerprint, freshSchemaFingerprint,
      'fresh schema 实际 fingerprint 必须等于 trusted canonical fingerprint。');
    assert.strictEqual(newDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      freshSchemaFingerprint, 'fresh metadata 必须记录经过 trusted profile 验证的实际 fingerprint。');

    const importBatchSql = getCreateSql(newDb, 'import_batches');
    EXPECTED_IMPORT_TYPES.forEach((importType) => {
      assert(importBatchSql.includes(`'${importType}'`), `import_batches CHECK 缺少 ${importType}。`);
    });
    EXPECTED_IMPORT_TYPES.slice(10).forEach((importType) => {
      newDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES (?, ?, 'csv')")
        .run(importType, `${importType}.csv`);
    });
    assertConstraintFailure(
      () => newDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES ('unsupported_type', 'bad.csv', 'csv')").run(),
      '非法 import_type 必须被 CHECK 拦截。'
    );

    // 新库不得自动生成正式系数、标准、规则、拓扑或平衡边界。
    [
      'shift_definitions',
      'tou_schemes',
      'energy_conversion_factors',
      'strategy_rules',
      'benchmark_definitions',
      'energy_flow_models',
      'energy_balance_boundaries'
    ].forEach((tableName) => {
      assert.strictEqual(newDb.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total, 0, `${tableName} 不得自动生成正式配置。`);
    });

    const organizationUnitId = newDb.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('EA-ORG', '能源分析隔离单元', '能源分析隔离单元', 'enterprise', 'active')`).run().lastInsertRowid;
    const energyTypeId = newDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const meterDeviceId = newDb.prepare(`INSERT INTO meter_devices
      (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
      VALUES ('EA-METER', '能源分析隔离表计', 'electricity', ?, ?, 'active')`).run(energyTypeId, organizationUnitId).lastInsertRowid;
    const timeseriesBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'energy_timeseries'").get().id;

    const insertTimeseries = newDb.prepare(`INSERT INTO energy_timeseries_records
      (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc,
       source_timezone, granularity_minutes, original_unit, original_value, normalized_unit, normalized_value, source_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', ?, 'kWh', ?, 'kWh', ?, ?)`);
    insertTimeseries.run(timeseriesBatchId, 2, organizationUnitId, meterDeviceId, energyTypeId,
      '2026-07-14T16:00:00.000Z', '2026-07-14T16:30:00.000Z', 30, 10, 10, 'test:timeseries:1');
    // 普通 UNIQUE 无法表达任意区间重叠；数据库允许重叠，后续服务必须借助候选索引在事务内拒绝。
    insertTimeseries.run(timeseriesBatchId, 3, organizationUnitId, meterDeviceId, energyTypeId,
      '2026-07-14T16:15:00.000Z', '2026-07-14T16:45:00.000Z', 30, 8, 8, 'test:timeseries:overlap');
    assert.strictEqual(newDb.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total, 2);
    assertConstraintFailure(
      () => insertTimeseries.run(timeseriesBatchId, 4, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T17:00:00.000Z', '2026-07-14T17:00:00.000Z', 30, 1, 1, 'test:bad-range'),
      '时序 start_utc 必须小于 end_utc。'
    );
    assertConstraintFailure(
      () => insertTimeseries.run(timeseriesBatchId, 5, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T17:00:00.000Z', '2026-07-14T17:10:00.000Z', 10, 1, 1, 'test:bad-granularity'),
      '时序粒度必须限定为 15/30/60。'
    );
    assertConstraintFailure(
      () => insertTimeseries.run(timeseriesBatchId, 6, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T17:00:00.000Z', '2026-07-14T17:30:00.000Z', 15, 1, 1, 'test:duration-mismatch'),
      '时序持续时间必须与粒度一致。'
    );
    assertConstraintFailure(
      () => insertTimeseries.run(timeseriesBatchId, 7, organizationUnitId, meterDeviceId, 999999,
        '2026-07-14T17:00:00.000Z', '2026-07-14T17:15:00.000Z', 15, 1, 1, 'test:bad-fk'),
      '时序能源类型外键必须有效。'
    );

    // 严格 UTC、整分钟边界和 IANA 时区必须由数据库连接函数统一校验。
    const insertTimeseriesWithTimezone = newDb.prepare(`INSERT INTO energy_timeseries_records
      (source_batch_id, source_row_number, organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc,
       source_timezone, granularity_minutes, original_unit, original_value, normalized_unit, normalized_value, source_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 15, 'kWh', 1, 'kWh', 1, ?)`);
    insertTimeseriesWithTimezone.run(timeseriesBatchId, 8, organizationUnitId, meterDeviceId, energyTypeId,
      '2026-07-14T18:00:00Z', '2026-07-14T18:15:00Z', 'Asia/Kathmandu', 'test:kathmandu');
    assertConstraintFailure(
      () => insertTimeseriesWithTimezone.run(timeseriesBatchId, 9, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14 18:30:00Z', '2026-07-14T18:45:00Z', 'Asia/Shanghai', 'test:space-format'),
      'UTC 字段必须拒绝空格分隔格式。'
    );
    assertConstraintFailure(
      () => insertTimeseriesWithTimezone.run(timeseriesBatchId, 10, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-02-30T18:30:00Z', '2026-02-30T18:45:00Z', 'Asia/Shanghai', 'test:invalid-date'),
      'UTC 字段必须拒绝不存在的日期。'
    );
    assertConstraintFailure(
      () => insertTimeseriesWithTimezone.run(timeseriesBatchId, 11, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T19:00:01Z', '2026-07-14T19:15:01Z', 'Asia/Shanghai', 'test:second-offset'),
      '时序边界的秒必须为零。'
    );
    assertConstraintFailure(
      () => insertTimeseriesWithTimezone.run(timeseriesBatchId, 12, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T19:00:00.001Z', '2026-07-14T19:15:00.001Z', 'Asia/Shanghai', 'test:millisecond-offset'),
      '时序边界的毫秒必须为零。'
    );
    assertConstraintFailure(
      () => insertTimeseriesWithTimezone.run(timeseriesBatchId, 13, organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T19:30:00Z', '2026-07-14T19:45:00Z', 'Not/AZone', 'test:invalid-timezone'),
      '来源时区必须是可识别的 IANA 时区。'
    );

    // 时序 active/void 字段必须保持一致，合法作废记录保留审计。
    const insertTimeseriesWithVoidAudit = newDb.prepare(`INSERT INTO energy_timeseries_records
      (organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc, source_timezone,
       granularity_minutes, original_unit, original_value, normalized_unit, normalized_value, source_reference,
       record_status, void_reason, voided_at)
      VALUES (?, ?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', 1, 'kWh', 1, ?, ?, ?, ?)`);
    insertTimeseriesWithVoidAudit.run(organizationUnitId, meterDeviceId, energyTypeId,
      '2026-07-14T20:00:00Z', '2026-07-14T20:15:00Z', 'test:void:valid', 'void', '人工更正', '2026-07-14T21:00:00Z');
    assertConstraintFailure(
      () => insertTimeseriesWithVoidAudit.run(organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T20:15:00Z', '2026-07-14T20:30:00Z', 'test:active-with-void', 'active', '不应存在', '2026-07-14T21:00:00Z'),
      'active 时序记录不得携带作废审计字段。'
    );
    assertConstraintFailure(
      () => insertTimeseriesWithVoidAudit.run(organizationUnitId, meterDeviceId, energyTypeId,
        '2026-07-14T20:30:00Z', '2026-07-14T20:45:00Z', 'test:void-no-reason', 'void', ' ', '2026-07-14T21:00:00Z'),
      'void 时序记录必须填写非空原因。'
    );

    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO device_state_records
        (meter_device_id, device_state, start_utc, end_utc, source_timezone, source_reference)
        VALUES (?, 'fault', '2026-07-14T16:00:00.000Z', '2026-07-14T17:00:00.000Z', 'Asia/Shanghai', 'test:state')`).run(meterDeviceId),
      '设备状态不得扩展 fault。'
    );

    // 排班和设备状态事实同样必须执行 active/void 一致性约束。
    const shiftDefinitionId = newDb.prepare(`INSERT INTO shift_definitions
      (shift_code, shift_name, start_minute, end_minute, source_timezone, source, version, effective_start_utc, effective_end_utc)
      VALUES ('DAY', '白班', 480, 960, 'Asia/Shanghai', '测试人工配置', 'shift:v1',
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`).run().lastInsertRowid;
    const insertShiftSchedule = newDb.prepare(`INSERT INTO shift_schedule_records
      (shift_definition_id, organization_unit_id, start_utc, end_utc, source_timezone, source_reference,
       record_status, void_reason, voided_at)
      VALUES (?, ?, ?, ?, 'Asia/Shanghai', ?, ?, ?, ?)`);
    insertShiftSchedule.run(shiftDefinitionId, organizationUnitId, '2026-07-15T00:00:00Z', '2026-07-15T08:00:00Z',
      'test:shift:void', 'void', '排班更正', '2026-07-15T09:00:00Z');
    assertConstraintFailure(
      () => insertShiftSchedule.run(shiftDefinitionId, organizationUnitId, '2026-07-15T08:00:00Z', '2026-07-15T16:00:00Z',
        'test:shift:bad', 'void', null, '2026-07-15T17:00:00Z'),
      'void 排班记录必须填写非空原因。'
    );

    const insertDeviceState = newDb.prepare(`INSERT INTO device_state_records
      (meter_device_id, organization_unit_id, device_state, start_utc, end_utc, source_timezone, source_reference,
       record_status, void_reason, voided_at)
      VALUES (?, ?, 'running', ?, ?, 'Asia/Shanghai', ?, ?, ?, ?)`);
    insertDeviceState.run(meterDeviceId, organizationUnitId, '2026-07-15T00:00:00Z', '2026-07-15T01:00:00Z',
      'test:device:void', 'void', '状态更正', '2026-07-15T02:00:00Z');
    assertConstraintFailure(
      () => insertDeviceState.run(meterDeviceId, organizationUnitId, '2026-07-15T01:00:00Z', '2026-07-15T02:00:00Z',
        'test:device:bad', 'void', '状态更正', '2026-07-15 03:00:00Z'),
      'void 设备状态记录必须使用严格 UTC 作废时间。'
    );

    const flowModelId = newDb.prepare(`INSERT INTO energy_flow_models
      (model_code, model_name, source, version, effective_start_utc, effective_end_utc, source_timezone)
      VALUES ('EA-FLOW', '隔离能流模型', '测试人工配置', 'energy-flow:v1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai')`).run().lastInsertRowid;
    const sourceNodeId = newDb.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, x, y)
      VALUES (?, 'source', '源节点', 'source', 10, 20)`).run(flowModelId).lastInsertRowid;
    const sinkNodeId = newDb.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, x, y)
      VALUES (?, 'sink', '汇节点', 'sink', 100, 20)`).run(flowModelId).lastInsertRowid;
    const secondFlowModelId = newDb.prepare(`INSERT INTO energy_flow_models
      (model_code, model_name, source, version, effective_start_utc, effective_end_utc, source_timezone)
      VALUES ('EA-FLOW-2', '第二隔离能流模型', '测试人工配置', 'energy-flow:v1',
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Kathmandu')`).run().lastInsertRowid;
    const secondModelNodeId = newDb.prepare(`INSERT INTO energy_flow_nodes
      (energy_flow_model_id, node_code, node_name, node_type, x, y)
      VALUES (?, 'source-2', '第二模型源节点', 'source', 0, 0)`).run(secondFlowModelId).lastInsertRowid;
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_nodes
        (energy_flow_model_id, node_code, node_name, node_type, x, y)
        VALUES (?, 'bad', '非法节点', 'device', 0, 0)`).run(flowModelId),
      '能流节点类型必须使用阶段 1 枚举。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_edges
        (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json)
        VALUES (?, 'self-loop', ?, ?, ?, 'kWh', 'timeseries', '{"reference":"test"}')`).run(flowModelId, sourceNodeId, sourceNodeId, energyTypeId),
      '能流边必须禁止自环。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_edges
        (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json)
        VALUES (?, 'cross-model', ?, ?, ?, 'kWh', 'timeseries', '{"reference":"test:cross"}')`)
        .run(flowModelId, sourceNodeId, secondModelNodeId, energyTypeId),
      '能流边两端节点必须属于声明模型。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_edges
        (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json)
        VALUES (?, 'bad-json', ?, ?, ?, 'kWh', 'timeseries', 'not-json')`)
        .run(flowModelId, sourceNodeId, sinkNodeId, energyTypeId),
      '能流来源映射必须是有效 JSON object。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_edges
        (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json)
        VALUES (?, 'empty-reference', ?, ?, ?, 'kWh', 'timeseries', '{"reference":" "}')`)
        .run(flowModelId, sourceNodeId, sinkNodeId, energyTypeId),
      '能流来源映射 reference 必须是非空文本。'
    );
    const flowEdgeId = newDb.prepare(`INSERT INTO energy_flow_edges
      (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json)
      VALUES (?, 'source-sink', ?, ?, ?, 'kWh', 'explicit_edge_value', '{"reference":"test:edge"}')`).run(flowModelId, sourceNodeId, sinkNodeId, energyTypeId).lastInsertRowid;
    const flowEdgeBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'energy_flow_edge' ORDER BY id LIMIT 1").get().id;
    const flowRecordBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'energy_flow_record' ORDER BY id LIMIT 1").get().id;
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_edges
        (source_batch_id, energy_flow_model_id, edge_code, from_node_id, to_node_id,
         energy_type_id, unit, source_type, source_mapping_json)
        VALUES (?, ?, 'bad-edge-source-pair', ?, ?, ?, 'kWh', 'explicit_edge_value', '{"reference":"test:bad-edge-source"}')`)
        .run(flowEdgeBatchId, flowModelId, sourceNodeId, sinkNodeId, energyTypeId),
      '能流边 imported provenance 必须同时提供批次和正整数来源行。'
    );
    assertConstraintFailure(
      () => newDb.prepare('UPDATE energy_flow_edges SET source_row_number = 1 WHERE id = ?').run(flowEdgeId),
      '能流边 UPDATE 不得把正式 NULL/NULL provenance 改成单边来源。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_records
        (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone, original_unit, original_value,
         source_type, source_mapping_json, formula_version)
        VALUES (?, ?, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai', 'kWh', 1,
         'implicit_guess', '{"reference":"bad"}', 'energy-flow:v1')`).run(flowModelId, flowEdgeId),
      '能流记录来源类型必须使用显式来源枚举。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_records
        (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone, original_unit, original_value,
         source_type, source_mapping_json, formula_version)
        VALUES (?, ?, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai', 'kWh', 1,
         'explicit_edge_value', '{"reference":"test:mismatch"}', 'energy-flow:v1')`).run(secondFlowModelId, flowEdgeId),
      '能流记录引用的边必须属于声明模型。'
    );
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_records
        (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone, original_unit, original_value,
         source_type, source_mapping_json, formula_version)
        VALUES (?, ?, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai', 'kWh', 1,
         'explicit_edge_value', '{}', 'energy-flow:v1')`).run(flowModelId, flowEdgeId),
      '能流记录来源映射必须包含非空 reference。'
    );
    const insertFlowRecord = newDb.prepare(`INSERT INTO energy_flow_records
      (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone, original_unit, original_value,
       source_type, source_mapping_json, formula_version, record_status, void_reason, voided_at)
      VALUES (?, ?, ?, ?, 'Asia/Shanghai', 'kWh', 1, 'explicit_edge_value', '{"reference":"test:flow"}',
       'energy-flow:v1', ?, ?, ?)`);
    insertFlowRecord.run(flowModelId, flowEdgeId, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
      'void', '来源更正', '2026-08-02T00:00:00Z');
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_flow_records
        (source_batch_id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc,
         source_timezone, original_unit, original_value, source_type, source_mapping_json, formula_version)
        VALUES (?, ?, ?, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z',
         'Asia/Shanghai', 'kWh', 1, 'explicit_edge_value', '{"reference":"test:bad-record-source"}', 'energy-flow:v1')`)
        .run(flowRecordBatchId, flowModelId, flowEdgeId),
      '显式边值 imported provenance 必须同时提供批次和正整数来源行。'
    );
    assertConstraintFailure(
      () => insertFlowRecord.run(flowModelId, flowEdgeId, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
        'active', '不应存在', null),
      'active 能流记录不得携带作废原因。'
    );

    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO benchmark_definitions
        (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
         direction, source, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone)
        VALUES ('EA-BAD', '非法方向', 'manual_benchmark', 'metric', '%', 'month', 'organization', 'EA-ORG',
         'smaller', '测试', 'benchmark:v1', 1, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'Asia/Shanghai')`).run(),
      '对标方向必须使用 lower_better/higher_better/range。'
    );

    // 内部历史基准必须固化，外部标准和人工基准保持可正常写入。
    const insertBenchmarkDefinition = newDb.prepare(`INSERT INTO benchmark_definitions
      (benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type, scope_type, scope_reference,
       direction, source, document_no, version, internal_revision, effective_start_utc, effective_end_utc, source_timezone)
      VALUES (?, ?, ?, 'energy_intensity', 'kgce/t', 'month', 'organization', 'EA-ORG',
       'lower_better', '测试', ?, ?, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai')`);
    const internalBenchmarkId = insertBenchmarkDefinition.run('EA-INTERNAL', '内部历史基准',
      'internal_history_baseline', null, 'benchmark-internal:v1').lastInsertRowid;
    const manualBenchmarkId = insertBenchmarkDefinition.run('EA-MANUAL', '人工基准',
      'manual_benchmark', null, 'benchmark-manual:v1').lastInsertRowid;
    const externalBenchmarkId = insertBenchmarkDefinition.run('EA-EXTERNAL', '外部标准',
      'external_standard', null, 'benchmark-external:v1').lastInsertRowid;
    assert.strictEqual(newDb.prepare('SELECT document_no AS documentNo FROM benchmark_definitions WHERE id = ?')
      .get(externalBenchmarkId).documentNo, null, '新库外部标准必须允许不填写文号。');
    const benchmarkTargetSql = getCreateSql(newDb, 'benchmark_targets');
    assert(benchmarkTargetSql.includes('source_batch_id'), '新库 benchmark_targets 建表定义必须包含 source_batch_id。');
    assert(benchmarkTargetSql.includes("typeof(source_row_number) = 'integer'"), '新库来源行号必须声明正整数 CHECK。');
    assert(benchmarkTargetSql.includes('source_batch_id IS NULL AND source_row_number IS NULL'), '新库必须声明来源字段成对 CHECK。');
    const benchmarkBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'energy_benchmark'").get().id;
    assertBenchmarkTargetImportSourceConstraints(newDb, manualBenchmarkId, benchmarkBatchId, 'new-source');

    const insertBenchmarkTarget = newDb.prepare(`INSERT INTO benchmark_targets
      (benchmark_definition_id, target_value, reference_start_utc, reference_end_utc, frozen_value, frozen_at,
       production_summary_json, source_data_digest, is_frozen, auto_refresh, version, internal_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    assert.throws(
      () => insertBenchmarkTarget.run(internalBenchmarkId, 10, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        10, '2026-01-02T00:00:00Z', '{"output":100}', 'sha256:internal', 0, 0, 'target:v1', 1),
      /internal history baseline target must be frozen and complete/,
      '内部历史基准 INSERT 必须拒绝未固化目标。'
    );
    const internalTargetId = insertBenchmarkTarget.run(internalBenchmarkId, 10,
      '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 10, '2026-01-02T00:00:00Z',
      '{"output":100}', 'sha256:internal', 1, 0, 'target:v1', 1).lastInsertRowid;
    assert.throws(
      () => newDb.prepare('UPDATE benchmark_targets SET auto_refresh = 1 WHERE id = ?').run(internalTargetId),
      /internal history baseline target must remain frozen and complete/,
      '内部历史基准 UPDATE 后仍须保持 auto_refresh=0。'
    );
    insertBenchmarkTarget.run(manualBenchmarkId, 12, null, null, null, null, null, null, 0, 1, 'target:v1', 2);
    insertBenchmarkTarget.run(externalBenchmarkId, 8, null, null, null, null, null, null, 0, 0, 'target:v1', 1);
    assert.throws(
      () => newDb.prepare("UPDATE benchmark_definitions SET benchmark_type = 'internal_history_baseline' WHERE id = ?")
        .run(manualBenchmarkId),
      /existing targets must be frozen before changing benchmark type/,
      '定义切换为内部历史基准时不得遗留非法目标。'
    );

    const boundaryId = newDb.prepare(`INSERT INTO energy_balance_boundaries
      (boundary_code, boundary_name, organization_unit_id, source, version, effective_start_utc, effective_end_utc, source_timezone)
      VALUES ('EA-BAL', '隔离平衡边界', ?, '测试人工配置', 'energy-balance:v1',
       '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'Asia/Shanghai')`).run(organizationUnitId).lastInsertRowid;
    const calculationRunId = 'schema-new-run-1';
    newDb.prepare(`INSERT INTO energy_balance_calculation_runs
      (calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
       source_timezone, source_data_digest, formula_version, conversion_formula_version)
      VALUES (?, ?, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
       'Asia/Shanghai', 'sha256:test', 'energy-balance:v1', 'standard-coal-conversion:v1')`)
      .run(calculationRunId, boundaryId);
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_balance_items
        (energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit, source_type, source_mapping_json)
        VALUES (?, 'bad-role', '非法角色', 'unexplained', ?, 'kWh', 'explicit_balance_value', '{"reference":"test"}')`).run(boundaryId, energyTypeId),
      '不可解释差额不得作为第十种可配置平衡角色。'
    );
    const balanceItemId = newDb.prepare(`INSERT INTO energy_balance_items
      (energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit, source_type, source_mapping_json)
      VALUES (?, 'input', '输入', 'input', ?, 'kWh', 'explicit_balance_value', '{"reference":"test:balance"}')`).run(boundaryId, energyTypeId).lastInsertRowid;
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_balance_items
        (energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit, source_type, source_mapping_json)
        VALUES (?, 'bad-mapping', '非法映射', 'output', ?, 'kWh', 'explicit_balance_value', '[]')`).run(boundaryId, energyTypeId),
      '平衡项目来源映射必须是带非空 reference 的 JSON object。'
    );

    // 任一 kgce 汇总存在时必须记录有效且非空的实际系数版本集合。
    const factorCalculationRunId = 'schema-factor-run';
    newDb.prepare(`INSERT INTO energy_balance_calculation_runs
      (calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
       source_timezone, source_data_digest, formula_version, conversion_formula_version)
      VALUES (?, ?, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z',
       'Asia/Shanghai', 'sha256:factor-test', 'energy-balance:v1', 'standard-coal-conversion:v1')`)
      .run(factorCalculationRunId, boundaryId);
    const insertBalanceSnapshot = newDb.prepare(`INSERT INTO energy_balance_snapshots
      (calculation_run_id, energy_balance_boundary_id, energy_type_id, start_utc, end_utc, source_timezone, original_unit,
       input_total_original, output_total_original, unexplained_original, input_total_kgce, output_total_kgce,
       unexplained_kgce, actual_factor_versions_json, formula_version, completeness_rate, source_data_digest)
      VALUES (?, ?, ?, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', 'Asia/Shanghai', 'kWh',
       10, 8, 2, ?, ?, ?, ?, 'energy-balance:v1', 1, ?)`);
    const invalidFactorVersionsJsonValues = [
      null,
      '[]',
      '{}',
      'not-json',
      '[null]',
      '[""]',
      '["  "]',
      '{"factor":null}',
      '{"factor":""}',
      '{"":"v1"}',
      '{"factor":{"version":"v1"}}',
      '[1]',
      '{"factor":1}'
    ];
    invalidFactorVersionsJsonValues.forEach((factorVersionsJson) => {
      assertConstraintFailure(
        () => insertBalanceSnapshot.run(factorCalculationRunId, boundaryId, energyTypeId, 1, 0.8, 0.2, factorVersionsJson, 'sha256:factor-test'),
        'kgce 汇总必须拒绝缺失、空白、嵌套或非字符串的实际系数版本 JSON。'
      );
    });
    const objectFactorSnapshotId = insertBalanceSnapshot.run(factorCalculationRunId, boundaryId, energyTypeId,
      1, 0.8, 0.2, '{"electricity":"v1"}', 'sha256:factor-test').lastInsertRowid;
    assert(objectFactorSnapshotId, '非空字符串键值对象应作为合法系数版本集合。');
    const originalOnlySnapshotId = insertBalanceSnapshot.run(factorCalculationRunId, boundaryId, energyTypeId,
      null, null, null, null, 'sha256:factor-test').lastInsertRowid;
    assert(originalOnlySnapshotId, '纯原单位快照不得强制要求折标系数版本。');

    const snapshotId = newDb.prepare(`INSERT INTO energy_balance_snapshots
      (calculation_run_id, energy_balance_boundary_id, energy_type_id, start_utc, end_utc, source_timezone, original_unit,
       input_total_original, output_total_original, unexplained_original, input_total_kgce, output_total_kgce, unexplained_kgce,
       actual_factor_versions_json, formula_version, utilization_rate, loss_rate, completeness_rate, confirmation_status, source_data_digest)
      VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'Asia/Shanghai', 'kWh',
       100, 90, 10, 12.29, 11.061, 1.229, '["electricity:v1"]', 'energy-balance:v1', 0.8, 0.1, 1, 'unconfirmed', 'sha256:test')`)
      .run(calculationRunId, boundaryId, energyTypeId).lastInsertRowid;
    const insertBalanceSnapshotItem = newDb.prepare(`INSERT INTO energy_balance_snapshot_items
      (calculation_run_id, energy_balance_snapshot_id, energy_balance_item_id, item_code, item_name,
       role, energy_type_id, original_unit, original_value, actual_factor_version, actual_factor_value,
       kgce_value, formula_version, source_mapping_json)
      VALUES (?, ?, ?, 'SCHEMA-INPUT', 'Schema 输入项目', 'input', ?, 'kWh', 100, ?, ?, ?,
       'energy-balance:v1', '{"reference":"test:balance"}')`);
    assertConstraintFailure(
      () => insertBalanceSnapshotItem.run(calculationRunId, snapshotId, balanceItemId, energyTypeId, null, 0.1229, 12.29),
      '快照项目 kgce_value 非空时必须记录实际系数版本。'
    );
    assertConstraintFailure(
      () => insertBalanceSnapshotItem.run(calculationRunId, snapshotId, balanceItemId, energyTypeId, 'electricity-factor:v1', null, 12.29),
      '快照项目 kgce_value 非空时必须记录正数实际系数值。'
    );
    insertBalanceSnapshotItem.run(factorCalculationRunId, originalOnlySnapshotId, balanceItemId, energyTypeId, null, null, null);
    insertBalanceSnapshotItem.run(calculationRunId, snapshotId, balanceItemId, energyTypeId, 'electricity-factor:v1', 0.1229, 12.29);
    assertConstraintFailure(
      () => newDb.prepare(`INSERT INTO energy_balance_suggestions
        (calculation_run_id, energy_balance_snapshot_id, suggestion_code, title, content, priority, evidence_json, manual_status)
        VALUES (?, ?, 'EA-SUG', '建议', '仅供人工核查', 'high', '["snapshot"]', 'pending')`)
        .run(calculationRunId, snapshotId),
      '建议人工状态必须使用 unconfirmed/accepted/rejected/resolved。'
    );

    // 快照、快照项目和建议必须绑定同一一等运行身份，内容摘要不能替代运行分组。
    const secondCalculationRunId = 'schema-new-run-2';
    newDb.prepare(`INSERT INTO energy_balance_calculation_runs
      (calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
       source_timezone, source_data_digest, formula_version, conversion_formula_version)
      VALUES (?, ?, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
       'Asia/Shanghai', 'sha256:test', 'energy-balance:v1', 'standard-coal-conversion:v1')`)
      .run(secondCalculationRunId, boundaryId);
    const snapshotColumns = new Map(newDb.prepare('PRAGMA table_info(energy_balance_snapshots)').all()
      .map((column) => [column.name, column]));
    const snapshotItemColumns = new Map(newDb.prepare('PRAGMA table_info(energy_balance_snapshot_items)').all()
      .map((column) => [column.name, column]));
    const suggestionColumns = new Map(newDb.prepare('PRAGMA table_info(energy_balance_suggestions)').all()
      .map((column) => [column.name, column]));
    assert.strictEqual(snapshotColumns.get('calculation_run_id').notnull, 1);
    assert.strictEqual(snapshotItemColumns.get('calculation_run_id').notnull, 1);
    assert.strictEqual(snapshotItemColumns.get('item_code').notnull, 1);
    assert.strictEqual(snapshotItemColumns.get('item_name').notnull, 1);
    assert.strictEqual(suggestionColumns.get('calculation_run_id').notnull, 1);
    assert(suggestionColumns.has('reviewed_by_user_id'));
    assert.throws(
      () => newDb.prepare("UPDATE energy_balance_calculation_runs SET source_data_digest = 'sha256:changed' WHERE calculation_run_id = ?")
        .run(calculationRunId),
      /energy balance calculation run immutable/,
      '计算运行创建后不得修改身份或来源元数据。'
    );
    assert.throws(
      () => newDb.prepare("UPDATE energy_balance_snapshots SET source_data_digest = 'sha256:changed' WHERE id = ?")
        .run(snapshotId),
      /energy balance snapshot run metadata mismatch/,
      '快照更新后仍须与所属计算运行保持元数据一致。'
    );
    assert.throws(
      () => newDb.prepare(`INSERT INTO energy_balance_snapshots
        (calculation_run_id, energy_balance_boundary_id, energy_type_id, start_utc, end_utc,
         source_timezone, original_unit, input_total_original, output_total_original,
         unexplained_original, formula_version, completeness_rate, source_data_digest)
        VALUES (?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
         'Asia/Shanghai', 'kWh', 10, 8, 2, 'energy-balance:v1', 1, 'sha256:mismatch')`)
        .run(calculationRunId, boundaryId, energyTypeId),
      /energy balance snapshot run metadata mismatch/,
      '快照插入时必须与所属计算运行保持元数据一致。'
    );
    assert.throws(
      () => newDb.prepare('UPDATE energy_balance_snapshots SET calculation_run_id = ? WHERE id = ?')
        .run(secondCalculationRunId, snapshotId),
      /energy balance snapshot (run immutable|run metadata mismatch)/,
      '快照创建后不得换绑到其他运行并使既有项目或建议失配。'
    );
    assert.throws(
      () => insertBalanceSnapshotItem.run(
        secondCalculationRunId,
        snapshotId,
        balanceItemId,
        energyTypeId,
        'electricity-factor:v1',
        0.1229,
        12.29
      ),
      /energy balance snapshot item run mismatch/,
      '快照项目不得绑定到所属快照之外的其他运行。'
    );
    assert.throws(
      () => newDb.prepare(`INSERT INTO energy_balance_suggestions
        (calculation_run_id, energy_balance_snapshot_id, suggestion_code, title, content, priority,
         evidence_json, manual_status)
        VALUES (?, ?, 'EA-RUN-MISMATCH', '建议', '仅供人工核查', 'high', '["snapshot"]', 'unconfirmed')`)
        .run(secondCalculationRunId, snapshotId),
      /energy balance suggestion run mismatch/,
      '建议不得绑定到所属快照之外的其他运行。'
    );

    const tableSqlAssertions = [
      ['device_state_records', "'running'", "'unknown'"],
      ['tou_period_rules', "'peak'", "'flat'", "'valley'"],
      ['strategy_rule_hits', "'matched'", "'not_evaluable'", "'resolved'"],
      ['energy_flow_nodes', "'boundary'", "'storage'", "'loss'"],
      ['energy_balance_items', "'self_generation'", "'known_loss'", "'adjustment_decrease'"]
    ];
    tableSqlAssertions.forEach(([tableName, ...tokens]) => {
      const createSql = getCreateSql(newDb, tableName);
      tokens.forEach((token) => assert(createSql.includes(token), `${tableName} CHECK 缺少 ${token}。`));
    });
    assert.strictEqual(newDb.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'trg_energy_flow_edges_source_insert', 'trg_energy_flow_edges_source_update',
        'trg_energy_flow_records_source_insert', 'trg_energy_flow_records_source_update'
      )`).get().total, 4, '新库必须安装四个 canonical 能流 provenance 触发器。');
    assert.deepStrictEqual(newDb.prepare('PRAGMA foreign_key_check').all(), [], '新库外键检查必须通过。');
  } finally {
    newDb.close();
  }

  // strategy_rules 来源批次必须与来源行号一样，只允许可空或正安全整数，并保留受限外键。
  const strategyProvenancePath = path.join(dataDir, 'energy-analysis-strategy-provenance.sqlite');
  const strategyProvenanceModule = loadDatabaseModule(strategyProvenancePath);
  strategyProvenanceModule.initDatabase();
  const strategyProvenanceDb = strategyProvenanceModule.openDatabase();
  try {
    const strategyRulesSql = getCreateSql(strategyProvenanceDb, 'strategy_rules');
    assert(strategyRulesSql.includes("typeof(source_batch_id) = 'integer'"),
      'strategy_rules.source_batch_id 必须声明整数类型约束。');
    assert(strategyRulesSql.includes('source_batch_id >= 1'),
      'strategy_rules.source_batch_id 必须声明正整数约束。');
    assert(strategyRulesSql.includes('source_batch_id IS NULL AND source_row_number IS NULL'),
      'strategy_rules 必须保留来源字段成对可空约束。');
    const strategySourceForeignKey = strategyProvenanceDb.prepare('PRAGMA foreign_key_list(strategy_rules)').all()
      .find((foreignKey) => foreignKey.from === 'source_batch_id');
    assert(strategySourceForeignKey, 'strategy_rules.source_batch_id 必须声明导入批次外键。');
    assert.strictEqual(strategySourceForeignKey.table, 'import_batches');
    assert.strictEqual(strategySourceForeignKey.to, 'id');
    assert.strictEqual(String(strategySourceForeignKey.on_delete).toUpperCase(), 'RESTRICT');

    strategyProvenanceDb.exec(`INSERT INTO import_batches
      (id, import_type, original_filename, file_type)
      VALUES (-1, 'strategy_rule', 'strategy-negative.csv', 'csv'),
        (0, 'strategy_rule', 'strategy-zero.csv', 'csv'),
        (2, 'strategy_rule', 'strategy-valid.csv', 'csv')`);
    assert(insertStrategyRule(strategyProvenanceDb, null, null, 'null-null').lastInsertRowid,
      'strategy_rules 必须允许 NULL/NULL provenance。');
    const integerSourceRuleId = insertStrategyRule(strategyProvenanceDb, 2, 1, 'integer').lastInsertRowid;
    assert(integerSourceRuleId, 'strategy_rules 必须允许正整数来源批次和行号。');
    const textSourceRuleId = insertStrategyRule(strategyProvenanceDb, '2', 2, 'text-number').lastInsertRowid;
    assert.strictEqual(
      strategyProvenanceDb.prepare('SELECT source_batch_id, typeof(source_batch_id) AS sourceType FROM strategy_rules WHERE id = ?')
        .get(textSourceRuleId).sourceType,
      'integer',
      'SQLite INTEGER affinity 应将可规范化的文本数字来源批次保存为 integer。'
    );
    const decimalTextSourceRuleId = insertStrategyRule(strategyProvenanceDb, '2.0', 3, 'text-decimal-number').lastInsertRowid;
    assert.strictEqual(
      strategyProvenanceDb.prepare('SELECT source_batch_id, typeof(source_batch_id) AS sourceType FROM strategy_rules WHERE id = ?')
        .get(decimalTextSourceRuleId).sourceType,
      'integer',
      'SQLite INTEGER affinity 应将可规范化的文本 2.0 来源批次保存为 integer。'
    );
    const realSourceRuleId = insertStrategyRule(strategyProvenanceDb, 2.0, 4, 'real-number').lastInsertRowid;
    assert.strictEqual(
      strategyProvenanceDb.prepare('SELECT source_batch_id, typeof(source_batch_id) AS sourceType FROM strategy_rules WHERE id = ?')
        .get(realSourceRuleId).sourceType,
      'integer',
      'SQLite INTEGER affinity 应将可规范化的 2.0 来源批次保存为 integer。'
    );
    assertConstraintFailure(
      () => insertStrategyRule(strategyProvenanceDb, 2, null, 'row-null'),
      'strategy_rules 只填写来源批次时必须被成对约束拒绝。'
    );
    assertConstraintFailure(
      () => insertStrategyRule(strategyProvenanceDb, null, 5, 'batch-null'),
      'strategy_rules 只填写来源行号时必须被成对约束拒绝。'
    );
    assertConstraintFailure(
      () => insertStrategyRule(strategyProvenanceDb, 0, 6, 'zero-batch'),
      '显式合法的 import_batches id=0 也必须被 strategy_rules 正整数约束拒绝。'
    );
    assertConstraintFailure(
      () => insertStrategyRule(strategyProvenanceDb, -1, 7, 'negative-batch'),
      '显式合法的 import_batches id=-1 也必须被 strategy_rules 正整数约束拒绝。'
    );
    [0, -1, 1.5].forEach((invalidRowNumber) => {
      assertConstraintFailure(
        () => insertStrategyRule(strategyProvenanceDb, 2, invalidRowNumber, `invalid-row-${String(invalidRowNumber).replace('.', '-')}`),
        'strategy_rules 来源行号必须拒绝零、负数和小数。'
      );
    });
    assertConstraintFailure(
      () => strategyProvenanceDb.prepare('DELETE FROM import_batches WHERE id = 2').run(),
      '被 strategy_rules 引用的导入批次必须继续受 ON DELETE RESTRICT 保护。'
    );
    assert.deepStrictEqual(strategyProvenanceDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    strategyProvenanceDb.close();
  }

  // strategy_rules v2 已退出唯一 predecessor 白名单，初始化必须原子拒绝且不改写历史结构。
  const strategyMigrationPath = path.join(dataDir, 'energy-analysis-strategy-migration.sqlite');
  const strategyMigrationModule = loadDatabaseModule(strategyMigrationPath);
  const legacyStrategyRuleId = 42;
  const legacyStrategySequenceHighWater = 200;
  strategyMigrationModule.initDatabase();
  const strategyMigrationSeedDb = strategyMigrationModule.openDatabase();
  try {
    strategyMigrationSeedDb.pragma('foreign_keys = OFF');
    strategyMigrationSeedDb.exec('DROP TABLE strategy_rules');
    strategyMigrationSeedDb.exec(`CREATE TABLE strategy_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_code TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      metric_code TEXT NOT NULL,
      threshold_operator TEXT NOT NULL CHECK (threshold_operator IN ('gt', 'gte', 'lt', 'lte', 'between')),
      threshold_value REAL,
      threshold_min REAL,
      threshold_max REAL,
      threshold_unit TEXT NOT NULL,
      reduction_rate REAL CHECK (reduction_rate IS NULL OR (reduction_rate > 0 AND reduction_rate <= 1)),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
      evidence_requirements_json TEXT NOT NULL,
      recommendation_text TEXT NOT NULL,
      source TEXT NOT NULL,
      effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
      effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
      source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (rule_code, rule_version),
      CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc)),
      CHECK (
        (threshold_operator = 'between' AND threshold_min IS NOT NULL AND threshold_max IS NOT NULL
          AND threshold_min <= threshold_max AND threshold_value IS NULL)
        OR (threshold_operator <> 'between' AND threshold_value IS NOT NULL
          AND threshold_min IS NULL AND threshold_max IS NULL)
      )
    );
    CREATE INDEX idx_strategy_rules_status_metric ON strategy_rules(status, metric_code, rule_code)`);
    strategyMigrationSeedDb.prepare(`INSERT INTO strategy_rules
      (id, rule_code, rule_name, rule_version, formula_version, metric_code, threshold_operator,
       threshold_value, threshold_unit, reduction_rate, priority, evidence_requirements_json,
       recommendation_text, source, effective_start_utc, effective_end_utc, source_timezone,
       status, created_at, updated_at)
      VALUES (?, 'MIGRATION-RULE', '迁移规则', 'legacy:v2', 'strategy:v1', 'energy_intensity', 'gt',
       1, 'kgce/t', 0.1, 'medium', '{}', '迁移建议', '迁移测试',
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active',
       '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`).run(legacyStrategyRuleId);
    assert.strictEqual(
      strategyMigrationSeedDb.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'strategy_rules'")
        .run(legacyStrategySequenceHighWater).changes,
      1,
      'v2 predecessor 夹具必须显式建立高于历史 ID 的 sqlite_sequence 高水位。'
    );
    strategyMigrationSeedDb.pragma('foreign_keys = ON');
    const legacyEvaluationRunId = Number(strategyMigrationSeedDb.prepare(`INSERT INTO strategy_evaluation_runs
      (run_code, scope_type, scope_reference, start_utc, end_utc, source_timezone,
       formula_version, status, reason_codes_json)
      VALUES ('MIGRATION-RUN', 'organization', 'migration:organization',
       '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', 'Asia/Shanghai',
       'strategy:v1', 'completed', '["migration"]')`).run().lastInsertRowid);
    strategyMigrationSeedDb.prepare(`INSERT INTO strategy_rule_hits
      (evaluation_run_id, strategy_rule_id, match_status, manual_status, actual_value,
       threshold_snapshot_json, evidence_json, reason_codes_json, coverage_rate, priority,
       estimated_saving, estimated_saving_unit, data_start_utc, data_end_utc, source_timezone,
       reviewed_at, review_note)
      VALUES (?, ?, 'matched', 'accepted', 1.5, '{"operator":"gt","value":1}',
       '["migration-evidence"]', '["migration"]', 0.95, 'medium', 12, 'kgce',
       '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', 'Asia/Shanghai',
       '2026-04-02T00:00:00Z', '迁移后必须保留入向外键行')`)
      .run(legacyEvaluationRunId, legacyStrategyRuleId);
    assert(
      strategyMigrationSeedDb.prepare(
        'SELECT id FROM strategy_rule_hits WHERE strategy_rule_id = ?'
      ).get(legacyStrategyRuleId),
      'v2 历史夹具必须建立引用显式规则 ID 的 strategy_rule_hits 行。'
    );
    assert.deepStrictEqual(strategyMigrationSeedDb.prepare('PRAGMA foreign_key_check').all(), []);
    const predecessorFingerprint = strategyMigrationModule.calculateSchemaFingerprint(strategyMigrationSeedDb);
    strategyMigrationSeedDb.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'")
      .run('2026-08-27-formal-canonical-v2');
    strategyMigrationSeedDb.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'")
      .run(predecessorFingerprint);
  } finally {
    strategyMigrationSeedDb.close();
  }
  assert.throws(
    () => strategyMigrationModule.initDatabase(),
    (error) => error.code === 'INCOMPATIBLE_EXISTING_SCHEMA'
      && error.details.actualVersion === '2026-08-27-formal-canonical-v2',
    '历史 strategy_rules v2 不再是唯一 predecessor，必须 fail-closed。'
  );
  const rejectedStrategyMigrationDb = strategyMigrationModule.openDatabase();
  try {
    assert.strictEqual(
      rejectedStrategyMigrationDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      '2026-08-27-formal-canonical-v2'
    );
    assert(!new Set(rejectedStrategyMigrationDb.prepare('PRAGMA table_info(strategy_rules)').all()
      .map((column) => column.name)).has('source_batch_id'),
    '拒绝历史 v2 后不得半途改写 strategy_rules。');
    assert.deepStrictEqual(rejectedStrategyMigrationDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    rejectedStrategyMigrationDb.close();
  }
  // 触发器名称包含双引号、分号和 SQL 元字符时，拆装必须只作用于目标触发器。
  const specialTriggerPath = path.join(dataDir, 'energy-analysis-trigger-identifier.sqlite');
  const specialTriggerModule = loadDatabaseModule(specialTriggerPath);
  specialTriggerModule.initDatabase();
  const specialTriggerDb = specialTriggerModule.openDatabase();
  try {
    const specialTriggerName = 'rf-p1-032"; DROP TABLE trigger_identifier_probe; --';
    const quoteBreakoutCompanionTriggerName = 'rf-p1-032\\';
    specialTriggerDb.exec(`CREATE TABLE trigger_identifier_probe (
      id INTEGER PRIMARY KEY,
      marker TEXT NOT NULL
    );
    INSERT INTO trigger_identifier_probe (id, marker) VALUES (1, 'preserved');
    CREATE TRIGGER trg_rf_p1_032_unrelated
    AFTER UPDATE ON trigger_identifier_probe
    FOR EACH ROW
    BEGIN
      SELECT 1;
    END;
    CREATE TRIGGER ${quoteSqlIdentifier(quoteBreakoutCompanionTriggerName)}
    AFTER UPDATE ON demo_dataset_runs
    FOR EACH ROW
    BEGIN
      SELECT 1;
    END;
    CREATE TRIGGER ${quoteSqlIdentifier(specialTriggerName)}
    AFTER UPDATE ON demo_dataset_runs
    FOR EACH ROW
    BEGIN
      SELECT 1;
    END;`);
    const canonicalTriggerNames = [
      'trg_demo_post_action_runs_dataset_insert',
      'trg_demo_post_action_runs_dataset_update',
      'trg_demo_dataset_runs_post_action_dataset_update'
    ];
    const beforeCanonicalTriggers = specialTriggerDb.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${canonicalTriggerNames.map(() => '?').join(', ')})
      ORDER BY name`).all(...canonicalTriggerNames);
    assert.deepStrictEqual(
      beforeCanonicalTriggers.map((trigger) => trigger.name),
      [...canonicalTriggerNames].sort(),
      '特殊名称回归场景必须保留 canonical 三个演示触发器作为拆装基线。'
    );
    const beforeSpecialTrigger = specialTriggerDb.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
    ).get(specialTriggerName);
    const beforeQuoteBreakoutCompanionTrigger = specialTriggerDb.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
    ).get(quoteBreakoutCompanionTriggerName);
    const beforeUnrelatedTrigger = specialTriggerDb.prepare(
      'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
    ).get('trg_rf_p1_032_unrelated');
    assert(beforeSpecialTrigger, '特殊名称触发器必须创建成功。');
    assert(beforeQuoteBreakoutCompanionTrigger, '引号突破配套触发器必须创建成功。');
    assert(beforeUnrelatedTrigger, '无关触发器必须创建成功。');

    weakenDemoDatasetRunsSha256Contract(specialTriggerDb, 'trigger-identifier-run', 'a'.repeat(64));

    assert.deepStrictEqual(
      specialTriggerDb.prepare('SELECT id, marker FROM trigger_identifier_probe ORDER BY id').all(),
      [{ id: 1, marker: 'preserved' }],
      '特殊触发器名称不得注入删除无关表或改写无关数据的附加 SQL。'
    );
    assert.deepStrictEqual(
      specialTriggerDb.prepare(
        'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
      ).get(specialTriggerName),
      beforeSpecialTrigger,
      '特殊名称触发器拆装后必须按原名称和 SQL 恢复。'
    );
    assert.deepStrictEqual(
      specialTriggerDb.prepare(
        'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
      ).get(quoteBreakoutCompanionTriggerName),
      beforeQuoteBreakoutCompanionTrigger,
      '引号突破配套触发器不得被附加 SQL 提前删除，且必须按原 SQL 恢复。'
    );
    assert.deepStrictEqual(
      specialTriggerDb.prepare(
        'SELECT name, sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?'
      ).get('trg_rf_p1_032_unrelated'),
      beforeUnrelatedTrigger,
      '与 demo_dataset_runs 无关的触发器不得被拆装或改写。'
    );
    assert.deepStrictEqual(
      specialTriggerDb.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name IN (${canonicalTriggerNames.map(() => '?').join(', ')})
        ORDER BY name`).all(...canonicalTriggerNames),
      beforeCanonicalTriggers,
      'canonical 三个演示触发器拆装后必须按原 SQL 恢复。'
    );
  } finally {
    specialTriggerDb.close();
  }

  // 新库二次初始化必须幂等，不新增正式配置或重复结构。
  newDatabaseModule.initDatabase();
  const reinitializedDb = newDatabaseModule.openDatabase();
  try {
    assert.strictEqual(reinitializedDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN (" + EXPECTED_TABLES.map(() => '?').join(',') + ')').get(...EXPECTED_TABLES).total, EXPECTED_TABLES.length);
    assert.strictEqual(reinitializedDb.prepare('SELECT COUNT(*) AS total FROM energy_flow_models').get().total, 2, '二次初始化不得复制人工插入的两个模型。');
    assert.strictEqual(reinitializedDb.prepare("SELECT COUNT(*) AS total FROM benchmark_targets WHERE version = 'new-source:valid'").get().total, 1, '二次初始化不得丢失或复制来源对标目标。');
    assert.strictEqual(reinitializedDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_benchmark_targets_source_insert', 'trg_benchmark_targets_source_update')").get().total, 2, '二次初始化必须幂等保留两个来源约束触发器。');
    assert.strictEqual(reinitializedDb.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'trg_energy_flow_edges_source_insert', 'trg_energy_flow_edges_source_update',
        'trg_energy_flow_records_source_insert', 'trg_energy_flow_records_source_update'
      )`).get().total, 4, '二次初始化必须幂等保留四个能流 provenance 触发器。');
    assert.deepStrictEqual(reinitializedDb.prepare('PRAGMA foreign_key_check').all(), [], '二次初始化后外键检查必须通过。');
  } finally {
    reinitializedDb.close();
  }

  // 精确已知 populated 能流 v1 即使 edge/record 完全没有 provenance，也必须机械迁移到 canonical v2。
  const noProvenanceV1Path = path.join(dataDir, 'energy-flow-v1-no-provenance.sqlite');
  const noProvenanceV1Module = loadDatabaseModule(noProvenanceV1Path);
  noProvenanceV1Module.initDatabase();
  const noProvenanceV1Db = noProvenanceV1Module.openDatabase();
  let noProvenanceScenario;
  let migratedFlowSnapshot;
  try {
    noProvenanceScenario = installPopulatedEnergyFlowV1WithoutEdgeRecordProvenance(noProvenanceV1Db);
    assert.strictEqual(noProvenanceScenario.before.models[0].version,
      HISTORICAL_ENERGY_FLOW_PREDECESSOR_MODEL_VERSION,
      '历史 predecessor fixture 必须继续保留能流模型 v1，不能被 current schema 版本机械替换。');
    ['energy_flow_edges', 'energy_flow_records'].forEach((tableName) => {
      const legacyColumns = noProvenanceV1Db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((column) => column.name);
      assert(!legacyColumns.includes('source_batch_id'), `${tableName} 场景迁移前不得存在 source_batch_id。`);
      assert(!legacyColumns.includes('source_row_number'), `${tableName} 场景迁移前不得存在 source_row_number。`);
    });
    assert.strictEqual(noProvenanceV1Db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'index' AND name IN ('idx_energy_flow_edges_batch', 'idx_energy_flow_records_batch')`).get().total, 0);
    assert.strictEqual(noProvenanceV1Db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN ('energy_flow_edges', 'energy_flow_records')`).get().total, 0);

    assert.strictEqual(noProvenanceV1Module.ensureEnergyAnalysisTables(noProvenanceV1Db), false,
      '已有能源分析底座上的精确 v1 迁移不应误报首次建表。');
    const migratedBusiness = {
      models: noProvenanceV1Db.prepare(`SELECT id, model_code, model_name, source, document_no, version,
        effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
        FROM energy_flow_models ORDER BY id`).all(),
      nodes: noProvenanceV1Db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id, node_code,
        node_name, node_type, organization_unit_id, x, y, status, created_at, updated_at
        FROM energy_flow_nodes ORDER BY id`).all(),
      edges: noProvenanceV1Db.prepare(`SELECT id, energy_flow_model_id, edge_code, from_node_id, to_node_id,
        energy_type_id, unit, source_type, source_mapping_json, status, created_at, updated_at
        FROM energy_flow_edges ORDER BY id`).all(),
      records: noProvenanceV1Db.prepare(`SELECT id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc,
        source_timezone, original_unit, original_value, source_type, source_mapping_json,
        formula_version, record_status, void_reason, voided_at, created_at, updated_at
        FROM energy_flow_records ORDER BY id`).all()
    };
    assert.deepStrictEqual(migratedBusiness, noProvenanceScenario.before,
      '精确 v1 迁移必须逐值保留全部历史业务字段和历史行。');
    ['energy_flow_edges', 'energy_flow_records'].forEach((tableName) => {
      const columns = noProvenanceV1Db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((column) => column.name);
      assert(columns.includes('source_batch_id'), `${tableName} 迁移后必须安装 source_batch_id。`);
      assert(columns.includes('source_row_number'), `${tableName} 迁移后必须安装 source_row_number。`);
      const sourceForeignKey = noProvenanceV1Db.prepare(`PRAGMA foreign_key_list(${tableName})`).all()
        .find((foreignKey) => foreignKey.from === 'source_batch_id');
      assert(sourceForeignKey, `${tableName} 迁移后必须安装来源批次外键。`);
      assert.strictEqual(sourceForeignKey.table, 'import_batches');
      assert.strictEqual(sourceForeignKey.to, 'id');
      assert.strictEqual(String(sourceForeignKey.on_delete).toUpperCase(), 'RESTRICT');
      const sourceRows = noProvenanceV1Db.prepare(`SELECT source_batch_id AS sourceBatchId,
        source_row_number AS sourceRowNumber FROM ${tableName} ORDER BY id`).all();
      assert(sourceRows.every((row) => row.sourceBatchId === null && row.sourceRowNumber === null),
        `${tableName} 历史行必须补为 NULL/NULL provenance。`);
    });
    ['idx_energy_flow_edges_batch', 'idx_energy_flow_records_batch'].forEach((indexName) => {
      assert(noProvenanceV1Db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName),
        `精确 v1 迁移后缺少 ${indexName}。`);
    });
    const expectedFlowSourceTriggers = [
      'trg_energy_flow_edges_source_insert',
      'trg_energy_flow_edges_source_update',
      'trg_energy_flow_records_source_insert',
      'trg_energy_flow_records_source_update'
    ];
    assert.deepStrictEqual(noProvenanceV1Db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${expectedFlowSourceTriggers.map(() => '?').join(', ')})
      ORDER BY name`).all(...expectedFlowSourceTriggers).map((row) => row.name), [...expectedFlowSourceTriggers].sort());
    assert.deepStrictEqual(noProvenanceV1Db.prepare('PRAGMA foreign_key_check').all(), []);

    assertConstraintFailure(
      () => noProvenanceV1Db.prepare('UPDATE energy_flow_edges SET source_row_number = 7 WHERE id = 301').run(),
      '迁移后 edge UPDATE 不得接受单边 provenance。'
    );
    assertConstraintFailure(
      () => noProvenanceV1Db.prepare('UPDATE energy_flow_records SET source_row_number = 8 WHERE id = 401').run(),
      '迁移后 record UPDATE 不得接受单边 provenance。'
    );
    const energyTypeId = noProvenanceV1Db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    assertConstraintFailure(
      () => noProvenanceV1Db.prepare(`INSERT INTO energy_flow_edges
        (source_row_number, energy_flow_model_id, edge_code, from_node_id, to_node_id,
         energy_type_id, unit, source_type, source_mapping_json)
        VALUES (9, 101, 'LEGACY-EDGE-INVALID', 201, 202, ?, 'kWh', 'explicit_edge_value',
         '{"reference":"legacy-edge:invalid"}')`).run(energyTypeId),
      '迁移后 edge INSERT 不得接受单边 provenance。'
    );
    assertConstraintFailure(
      () => noProvenanceV1Db.prepare(`INSERT INTO energy_flow_records
        (source_batch_id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc,
         source_timezone, original_unit, original_value, source_type, source_mapping_json, formula_version)
        VALUES (?, 101, 301, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
         'Asia/Shanghai', 'kWh', 1, 'explicit_edge_value',
         '{"reference":"legacy-record:invalid"}', 'legacy-formula:v1')`)
        .run(noProvenanceScenario.sourceBatchId),
      '迁移后 record INSERT 不得接受单边 provenance。'
    );

    migratedFlowSnapshot = {
      schema: noProvenanceV1Db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
        WHERE name LIKE 'energy_flow_%' OR name LIKE 'trg_energy_flow_%'
        ORDER BY type, name`).all(),
      business: migratedBusiness
    };
    assert.strictEqual(noProvenanceV1Module.ensureEnergyAnalysisTables(noProvenanceV1Db), false);
    assert.deepStrictEqual({
      schema: noProvenanceV1Db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
        WHERE name LIKE 'energy_flow_%' OR name LIKE 'trg_energy_flow_%'
        ORDER BY type, name`).all(),
      business: {
        models: noProvenanceV1Db.prepare(`SELECT id, model_code, model_name, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone, status, created_at, updated_at
          FROM energy_flow_models ORDER BY id`).all(),
        nodes: noProvenanceV1Db.prepare(`SELECT id, source_batch_id, source_row_number, energy_flow_model_id, node_code,
          node_name, node_type, organization_unit_id, x, y, status, created_at, updated_at
          FROM energy_flow_nodes ORDER BY id`).all(),
        edges: noProvenanceV1Db.prepare(`SELECT id, energy_flow_model_id, edge_code, from_node_id, to_node_id,
          energy_type_id, unit, source_type, source_mapping_json, status, created_at, updated_at
          FROM energy_flow_edges ORDER BY id`).all(),
        records: noProvenanceV1Db.prepare(`SELECT id, energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc,
          source_timezone, original_unit, original_value, source_type, source_mapping_json,
          formula_version, record_status, void_reason, voided_at, created_at, updated_at
          FROM energy_flow_records ORDER BY id`).all()
      }
    }, migratedFlowSnapshot, '精确 v1 迁移重复执行必须幂等。');
  } finally {
    noProvenanceV1Db.close();
  }
  noProvenanceV1Module.initDatabase();
  const reinitializedNoProvenanceV1Db = noProvenanceV1Module.openDatabase();
  try {
    assert.strictEqual(reinitializedNoProvenanceV1Db.prepare("SELECT value FROM app_meta WHERE key = 'schema_stage'").get().value,
      'formal-canonical', '精确 v1 迁移后正式初始化身份必须继续保持 formal-canonical。');
    assert.deepStrictEqual(reinitializedNoProvenanceV1Db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.strictEqual(reinitializedNoProvenanceV1Db.prepare('SELECT COUNT(*) AS total FROM energy_flow_edges').get().total, 1);
    assert.strictEqual(reinitializedNoProvenanceV1Db.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total, 1);
  } finally {
    reinitializedNoProvenanceV1Db.close();
  }

  // 单边补列并携带未知索引的 populated 漂移结构不得命中精确 profile，也不得被通用补列修复。
  const driftedNoProvenanceV1Path = path.join(dataDir, 'energy-flow-v1-no-provenance-drift.sqlite');
  const driftedNoProvenanceV1Module = loadDatabaseModule(driftedNoProvenanceV1Path);
  driftedNoProvenanceV1Module.initDatabase();
  const driftedNoProvenanceV1Db = driftedNoProvenanceV1Module.openDatabase();
  try {
    installPopulatedEnergyFlowV1WithoutEdgeRecordProvenance(driftedNoProvenanceV1Db);
    driftedNoProvenanceV1Db.exec(`ALTER TABLE energy_flow_edges ADD COLUMN source_batch_id INTEGER;
      CREATE INDEX idx_energy_flow_edges_batch ON energy_flow_edges(source_batch_id);
      CREATE TRIGGER test_energy_flow_unknown_trigger BEFORE UPDATE ON energy_flow_records
      FOR EACH ROW WHEN 0 BEGIN SELECT RAISE(ABORT, 'unknown trigger'); END;`);
    const beforeDriftReject = {
      schema: driftedNoProvenanceV1Db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
        WHERE name LIKE 'energy_flow_%' OR name LIKE 'idx_energy_flow_%' OR name LIKE 'test_energy_flow_%'
        ORDER BY type, name`).all(),
      edges: driftedNoProvenanceV1Db.prepare('SELECT * FROM energy_flow_edges ORDER BY id').all(),
      records: driftedNoProvenanceV1Db.prepare('SELECT * FROM energy_flow_records ORDER BY id').all()
    };
    assertInitializationRejected(
      () => driftedNoProvenanceV1Module.ensureEnergyAnalysisTables(driftedNoProvenanceV1Db),
      'N8_ENERGY_FLOW_NON_CANONICAL_DATA',
      '单边 provenance、未知索引或未知触发器漂移必须 fail-closed。'
    );
    assert.deepStrictEqual({
      schema: driftedNoProvenanceV1Db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
        WHERE name LIKE 'energy_flow_%' OR name LIKE 'idx_energy_flow_%' OR name LIKE 'test_energy_flow_%'
        ORDER BY type, name`).all(),
      edges: driftedNoProvenanceV1Db.prepare('SELECT * FROM energy_flow_edges ORDER BY id').all(),
      records: driftedNoProvenanceV1Db.prepare('SELECT * FROM energy_flow_records ORDER BY id').all()
    }, beforeDriftReject, '漂移结构被拒绝后不得改写 schema 或历史业务行。');
  } finally {
    driftedNoProvenanceV1Db.close();
  }

  // 字段完整但 SHA CHECK 较弱的旧治理表必须替换不可信摘要、撤销 context、清绑定并保持幂等。
  const weakShaDatabasePath = path.join(dataDir, 'demo-sha256-weak-contract.sqlite');
  const weakShaDatabaseModule = loadDatabaseModule(weakShaDatabasePath);
  weakShaDatabaseModule.initDatabase();
  const weakShaDb = weakShaDatabaseModule.openDatabase();
  const weakRunManifestDigest = 'A'.repeat(64);
  const weakTokenHash = 'B'.repeat(64);
  const weakArtifactSha = `${'c'.repeat(63)}Z`;
  const weakUploadSha = `${'d'.repeat(63)}!`;
  try {
    weakenDemoImportContextsSha256Contract(weakShaDb);
    seedDemoSha256MigrationContext(weakShaDb, {
      runId: 'sha-weak-run',
      datasetId: 'sha-weak-dataset',
      runManifestDigest: 'a'.repeat(64),
      contextId: 'sha-weak-context',
      tokenHash: weakTokenHash,
      contextManifestDigest: weakRunManifestDigest,
      artifactKey: '13-shift-definitions',
      artifactFileSha256: weakArtifactSha,
      uploadFileSha256: weakUploadSha
    });
    weakenDemoDatasetRunsSha256Contract(weakShaDb, 'sha-weak-run', weakRunManifestDigest);
  } finally {
    weakShaDb.close();
  }
  assertInitializationRejected(
    () => weakShaDatabaseModule.initDatabase(),
    'SCHEMA_FINGERPRINT_MISMATCH',
    '已登记 canonical 库的 SHA 约束漂移必须在任何自动修补前被拒绝。'
  );
  const migratedWeakShaDb = weakShaDatabaseModule.openDatabase();
  try {
    migratedWeakShaDb.pragma('foreign_keys = OFF');
    weakShaDatabaseModule.prepareDemoGovernanceTablesForMigration(migratedWeakShaDb);
    migratedWeakShaDb.pragma('foreign_keys = ON');
    const migratedRun = migratedWeakShaDb.prepare(`SELECT manifest_digest AS manifestDigest
      FROM demo_dataset_runs WHERE run_id = 'sha-weak-run'`).get();
    const migratedContext = migratedWeakShaDb.prepare(`SELECT token_hash AS tokenHash,
        manifest_digest AS manifestDigest, artifact_file_sha256 AS artifactFileSha256,
        status, upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
        previewed_at AS previewedAt, revoked_at AS revokedAt, revoke_reason AS revokeReason
      FROM demo_import_contexts WHERE context_id = 'sha-weak-context'`).get();
    assert.match(migratedRun.manifestDigest, /^[a-f0-9]{64}$/);
    assert.notStrictEqual(migratedRun.manifestDigest, weakRunManifestDigest,
      '专用迁移 helper 不得继续保留不可信 run manifest。');
    assert.match(migratedContext.tokenHash, /^[a-f0-9]{64}$/);
    assert.notStrictEqual(migratedContext.tokenHash, weakTokenHash,
      '专用迁移 helper 必须替换不可信旧 token hash。');
    assert.strictEqual(migratedWeakShaDb.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts WHERE token_hash = ?')
      .get(weakTokenHash).total, 0, '原不可信 token hash 不得继续命中 context。');
    assert.match(migratedContext.artifactFileSha256, /^[a-f0-9]{64}$/);
    assert.notStrictEqual(migratedContext.artifactFileSha256, weakArtifactSha,
      '专用迁移 helper 必须替换不可信 artifact 摘要。');
    assert.strictEqual(migratedContext.manifestDigest, migratedRun.manifestDigest,
      'context 必须改绑到迁移后的 canonical run manifest。');
    assert.strictEqual(migratedContext.status, 'revoked');
    assert.strictEqual(migratedContext.uploadFileSha256, null);
    assert.strictEqual(migratedContext.previewDigest, null);
    assert.strictEqual(migratedContext.previewedAt, null);
    assert.match(migratedContext.revokedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(migratedContext.revokeReason, 'invalid_sha256_migration');
    assert.match(getCreateSql(migratedWeakShaDb, 'demo_dataset_runs'), /NOT GLOB '\*\[\^a-f0-9\]\*'/i);
    assert.match(getCreateSql(migratedWeakShaDb, 'demo_import_contexts'), /NOT GLOB '\*\[\^a-f0-9\]\*'/i);
    const migratedWeakShaSnapshot = { run: migratedRun, context: migratedContext };
    weakShaDatabaseModule.prepareDemoGovernanceTablesForMigration(migratedWeakShaDb);
    assert.deepStrictEqual(
      migratedWeakShaDb.prepare(`SELECT manifest_digest AS manifestDigest
        FROM demo_dataset_runs WHERE run_id = 'sha-weak-run'`).get(),
      migratedWeakShaSnapshot.run,
      '专用迁移 helper 重复运行不得再次替换已 canonical 的 run 摘要。'
    );
    assert.deepStrictEqual(
      migratedWeakShaDb.prepare(`SELECT token_hash AS tokenHash,
          manifest_digest AS manifestDigest, artifact_file_sha256 AS artifactFileSha256,
          status, upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
          previewed_at AS previewedAt, revoked_at AS revokedAt, revoke_reason AS revokeReason
        FROM demo_import_contexts WHERE context_id = 'sha-weak-context'`).get(),
      migratedWeakShaSnapshot.context,
      '专用迁移 helper 重复运行不得再次改写已撤销 context 或迁移时间。'
    );
    assert.deepStrictEqual(migratedWeakShaDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migratedWeakShaDb.close();
  }

  // run 摘要弱化时，即使 context 表自身已 canonical，也必须强制撤销关联 context 并清绑定。
  const canonicalContextUnsafeRunPath = path.join(dataDir, 'demo-sha256-canonical-context.sqlite');
  const canonicalContextUnsafeRunModule = loadDatabaseModule(canonicalContextUnsafeRunPath);
  canonicalContextUnsafeRunModule.initDatabase();
  const canonicalContextUnsafeRunDb = canonicalContextUnsafeRunModule.openDatabase();
  try {
    seedDemoSha256MigrationContext(canonicalContextUnsafeRunDb, {
      runId: 'sha-canonical-context-run',
      datasetId: 'sha-canonical-context-dataset',
      runManifestDigest: '1'.repeat(64),
      contextId: 'sha-canonical-context',
      tokenHash: '2'.repeat(64),
      contextManifestDigest: '1'.repeat(64),
      artifactKey: '13-shift-definitions',
      artifactFileSha256: '3'.repeat(64),
      uploadFileSha256: '4'.repeat(64)
    });
    weakenDemoDatasetRunsSha256Contract(
      canonicalContextUnsafeRunDb,
      'sha-canonical-context-run',
      'E'.repeat(64)
    );
  } finally {
    canonicalContextUnsafeRunDb.close();
  }
  assertInitializationRejected(
    () => canonicalContextUnsafeRunModule.initDatabase(),
    'SCHEMA_FINGERPRINT_MISMATCH',
    '仅 run 摘要约束漂移也必须阻断正式初始化。'
  );
  const migratedCanonicalContextDb = canonicalContextUnsafeRunModule.openDatabase();
  try {
    migratedCanonicalContextDb.pragma('foreign_keys = OFF');
    canonicalContextUnsafeRunModule.prepareDemoGovernanceTablesForMigration(migratedCanonicalContextDb);
    migratedCanonicalContextDb.pragma('foreign_keys = ON');
    const run = migratedCanonicalContextDb.prepare(`SELECT manifest_digest AS manifestDigest
      FROM demo_dataset_runs WHERE run_id = 'sha-canonical-context-run'`).get();
    const context = migratedCanonicalContextDb.prepare(`SELECT manifest_digest AS manifestDigest,
        status, upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
        previewed_at AS previewedAt, revoke_reason AS revokeReason
      FROM demo_import_contexts WHERE context_id = 'sha-canonical-context'`).get();
    assert.match(run.manifestDigest, /^[a-f0-9]{64}$/);
    assert.strictEqual(context.manifestDigest, run.manifestDigest);
    assert.strictEqual(context.status, 'revoked');
    assert.strictEqual(context.uploadFileSha256, null);
    assert.strictEqual(context.previewDigest, null);
    assert.strictEqual(context.previewedAt, null);
    assert.strictEqual(context.revokeReason, 'invalid_sha256_migration');
    assert.deepStrictEqual(migratedCanonicalContextDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migratedCanonicalContextDb.close();
  }

  // 未登记旧库必须 fail-closed，专用导入审计迁移 helper 仍在隔离库中单独验证。
  const legacyDatabasePath = path.join(dataDir, 'energy-analysis-legacy.sqlite');
  createLegacyDatabase(legacyDatabasePath);
  const legacyDatabaseModule = loadDatabaseModule(legacyDatabasePath);
  const legacyBeforeDb = new Database(legacyDatabasePath, { readonly: true });
  const legacyBeforeSchema = legacyBeforeDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const legacyBeforeBatch = legacyBeforeDb.prepare('SELECT * FROM import_batches ORDER BY id').all();
  const legacyBeforeErrors = legacyBeforeDb.prepare('SELECT * FROM import_errors ORDER BY id').all();
  legacyBeforeDb.close();
  assertInitializationRejected(
    () => legacyDatabaseModule.initDatabase(),
    'UNKNOWN_EXISTING_SCHEMA',
    '没有 app_meta schema 身份的旧库必须拒绝自动升级。'
  );
  const rejectedLegacyDb = new Database(legacyDatabasePath, { readonly: true });
  try {
    assert.deepStrictEqual(rejectedLegacyDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all(), legacyBeforeSchema,
    '未知旧库被拒绝后不得改写结构。');
    assert.deepStrictEqual(rejectedLegacyDb.prepare('SELECT * FROM import_batches ORDER BY id').all(), legacyBeforeBatch,
      '未知旧库被拒绝后不得改写导入批次。');
    assert.deepStrictEqual(rejectedLegacyDb.prepare('SELECT * FROM import_errors ORDER BY id').all(), legacyBeforeErrors,
      '未知旧库被拒绝后不得改写导入错误。');
  } finally {
    rejectedLegacyDb.close();
  }

  // 旧平衡库相同摘要的历史快照必须逐条回填独立运行 ID，子记录按所属快照绑定且迁移幂等。
  const legacyBalancePath = path.join(dataDir, 'energy-balance-run-legacy.sqlite');
  const legacyBalanceModule = loadDatabaseModule(legacyBalancePath);
  const legacyBalanceDb = legacyBalanceModule.openDatabase();
  try {
    legacyBalanceDb.exec(`CREATE TABLE sys_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE energy_balance_boundaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE energy_balance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL
    );
    CREATE TABLE energy_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      energy_balance_boundary_id INTEGER NOT NULL,
      start_utc TEXT NOT NULL,
      end_utc TEXT NOT NULL,
      source_timezone TEXT NOT NULL,
      source_data_digest TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (energy_balance_boundary_id) REFERENCES energy_balance_boundaries(id) ON DELETE RESTRICT
    );
    CREATE TABLE energy_balance_snapshot_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      energy_balance_snapshot_id INTEGER NOT NULL,
      energy_balance_item_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      FOREIGN KEY (energy_balance_snapshot_id) REFERENCES energy_balance_snapshots(id) ON DELETE CASCADE
    );
    CREATE TABLE energy_balance_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      energy_balance_snapshot_id INTEGER NOT NULL,
      manual_status TEXT NOT NULL,
      priority TEXT NOT NULL,
      FOREIGN KEY (energy_balance_snapshot_id) REFERENCES energy_balance_snapshots(id) ON DELETE CASCADE
    );
    INSERT INTO energy_balance_boundaries (id) VALUES (1);
    INSERT INTO energy_balance_items (id, item_code, item_name)
    VALUES (1, 'LEGACY-INPUT', '旧输入项目'), (2, 'LEGACY-OUTPUT', '旧输出项目');
    INSERT INTO energy_balance_snapshots
      (id, energy_balance_boundary_id, start_utc, end_utc, source_timezone,
       source_data_digest, formula_version, created_at)
    VALUES
      (1, 1, '2026-06-30T16:00:00.000Z', '2026-07-31T16:00:00.000Z',
       'Asia/Shanghai', 'sha256:legacy-same-input', 'energy-balance:v1', '2026-08-01T00:00:00.000Z'),
      (2, 1, '2026-06-30T16:00:00.000Z', '2026-07-31T16:00:00.000Z',
       'Asia/Shanghai', 'sha256:legacy-same-input', 'energy-balance:v1', '2026-08-01T00:00:00.000Z');
    INSERT INTO energy_balance_snapshot_items
      (id, energy_balance_snapshot_id, energy_balance_item_id, role)
    VALUES (1, 1, 1, 'input'), (2, 2, 2, 'output');
    INSERT INTO energy_balance_suggestions
      (id, energy_balance_snapshot_id, manual_status, priority)
    VALUES (1, 1, 'unconfirmed', 'high'), (2, 2, 'accepted', 'medium');`);

    assert.strictEqual(
      legacyBalanceModule.migrateEnergyBalanceCalculationRuns(legacyBalanceDb),
      true,
      '首次旧平衡迁移必须补列并回填运行身份。'
    );
    const migratedSnapshots = legacyBalanceDb.prepare(`SELECT id,
        calculation_run_id AS calculationRunId, source_data_digest AS sourceDataDigest
      FROM energy_balance_snapshots ORDER BY id`).all();
    assert.deepStrictEqual(migratedSnapshots, [
      { id: 1, calculationRunId: 'legacy-snapshot-1', sourceDataDigest: 'sha256:legacy-same-input' },
      { id: 2, calculationRunId: 'legacy-snapshot-2', sourceDataDigest: 'sha256:legacy-same-input' }
    ]);
    assert.notStrictEqual(
      migratedSnapshots[0].calculationRunId,
      migratedSnapshots[1].calculationRunId,
      '相同内容摘要的两次历史计算不得被合并为同一运行。'
    );
    assert.deepStrictEqual(
      legacyBalanceDb.prepare(`SELECT energy_balance_snapshot_id AS snapshotId,
          calculation_run_id AS calculationRunId, item_code AS itemCode, item_name AS itemName
        FROM energy_balance_snapshot_items ORDER BY id`).all(),
      [
        {
          snapshotId: 1,
          calculationRunId: 'legacy-snapshot-1',
          itemCode: 'LEGACY-INPUT',
          itemName: '旧输入项目'
        },
        {
          snapshotId: 2,
          calculationRunId: 'legacy-snapshot-2',
          itemCode: 'LEGACY-OUTPUT',
          itemName: '旧输出项目'
        }
      ]
    );
    assert.deepStrictEqual(
      legacyBalanceDb.prepare(`SELECT energy_balance_snapshot_id AS snapshotId,
          calculation_run_id AS calculationRunId, reviewed_by_user_id AS reviewedByUserId
        FROM energy_balance_suggestions ORDER BY id`).all(),
      [
        { snapshotId: 1, calculationRunId: 'legacy-snapshot-1', reviewedByUserId: null },
        { snapshotId: 2, calculationRunId: 'legacy-snapshot-2', reviewedByUserId: null }
      ]
    );
    assert.strictEqual(
      legacyBalanceDb.prepare("SELECT COUNT(*) AS total FROM energy_balance_calculation_runs WHERE source_data_digest = 'sha256:legacy-same-input'").get().total,
      2,
      '内容摘要只能作为指纹，必须保留两条独立运行。'
    );
    const expectedBalanceTriggerNames = [
      'trg_energy_balance_calculation_runs_immutable_update',
      'trg_energy_balance_snapshots_run_insert',
      'trg_energy_balance_snapshots_run_update',
      'trg_energy_balance_snapshots_metadata_insert',
      'trg_energy_balance_snapshots_metadata_update',
      'trg_energy_balance_snapshot_items_run_insert',
      'trg_energy_balance_snapshot_items_run_update',
      'trg_energy_balance_snapshot_items_identity_insert',
      'trg_energy_balance_snapshot_items_identity_update',
      'trg_energy_balance_suggestions_run_insert',
      'trg_energy_balance_suggestions_run_update'
    ];
    expectedBalanceTriggerNames.forEach((triggerName) => {
      assert(
        legacyBalanceDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName),
        `旧库迁移后缺少 ${triggerName}。`
      );
    });
    ['idx_energy_balance_runs_boundary_created', 'idx_energy_balance_runs_digest',
      'idx_energy_balance_snapshots_run', 'idx_energy_balance_snapshot_items_run',
      'idx_energy_balance_suggestions_run_status'].forEach((indexName) => {
      assert(
        legacyBalanceDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName),
        `旧库迁移后缺少 ${indexName}。`
      );
    });
    assert.throws(
      () => legacyBalanceDb.prepare('UPDATE energy_balance_snapshots SET calculation_run_id = ? WHERE id = 1')
        .run('legacy-snapshot-2'),
      /energy balance snapshot (run immutable|run metadata mismatch)/,
      '旧库迁移后快照运行身份必须保持不可变。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare("UPDATE energy_balance_calculation_runs SET formula_version = 'changed' WHERE calculation_run_id = 'legacy-snapshot-1'").run(),
      /energy balance calculation run immutable/,
      '旧库迁移后计算运行身份和元数据必须不可修改。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare("UPDATE energy_balance_snapshots SET source_data_digest = 'sha256:changed' WHERE id = 1").run(),
      /energy balance snapshot run metadata mismatch/,
      '旧库迁移后快照元数据必须继续匹配所属运行。'
    );
    legacyBalanceDb.prepare(
      "UPDATE energy_balance_items SET item_code = 'MASTER-RENAMED', item_name = '主项目新名称' WHERE id = 1"
    ).run();
    assert.deepStrictEqual(
      legacyBalanceDb.prepare(
        'SELECT item_code AS itemCode, item_name AS itemName FROM energy_balance_snapshot_items WHERE id = 1'
      ).get(),
      { itemCode: 'LEGACY-INPUT', itemName: '旧输入项目' },
      '旧库迁移后主项目变更不得污染历史快照标识。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare(
        "UPDATE energy_balance_snapshot_items SET item_name = '非法历史改写' WHERE id = 1"
      ).run(),
      /energy balance snapshot item identity immutable/,
      '旧库迁移后快照项目标识必须保持不可变。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare(`INSERT INTO energy_balance_snapshot_items
        (energy_balance_snapshot_id, energy_balance_item_id, item_code, item_name, role, calculation_run_id)
        VALUES (1, 1, 'LEGACY-INPUT', '旧输入项目', 'input', 'legacy-snapshot-2')`).run(),
      /energy balance snapshot item run mismatch/,
      '旧库迁移后快照项目不得跨运行绑定。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare(`INSERT INTO energy_balance_suggestions
        (energy_balance_snapshot_id, manual_status, priority, calculation_run_id)
        VALUES (1, 'unconfirmed', 'high', 'legacy-snapshot-2')`).run(),
      /energy balance suggestion run mismatch/,
      '旧库迁移后建议不得跨运行绑定。'
    );
    assert.throws(
      () => legacyBalanceDb.prepare(`INSERT INTO energy_balance_snapshots
        (energy_balance_boundary_id, start_utc, end_utc, source_timezone,
         source_data_digest, formula_version, created_at)
        VALUES (1, '2026-07-31T16:00:00.000Z', '2026-08-31T16:00:00.000Z',
         'Asia/Shanghai', 'sha256:no-run', 'energy-balance:v1', '2026-09-01T00:00:00.000Z')`).run(),
      /energy balance snapshot (run required|run metadata mismatch)/,
      '旧库补列后新增快照必须显式绑定运行。'
    );
    assert.strictEqual(
      legacyBalanceModule.migrateEnergyBalanceCalculationRuns(legacyBalanceDb),
      false,
      '二次运行身份迁移不得重复回填或新增运行。'
    );
    assert.strictEqual(legacyBalanceDb.prepare('SELECT COUNT(*) AS total FROM energy_balance_calculation_runs').get().total, 2);
    assert.deepStrictEqual(legacyBalanceDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    legacyBalanceDb.close();
  }

  // 已有来源两列但缺少外键的部分迁移库必须安全重建，并替换同名弱触发器。
  const partialBenchmarkPath = path.join(dataDir, 'energy-analysis-benchmark-partial.sqlite');
  const partialBenchmarkModule = loadDatabaseModule(partialBenchmarkPath);
  partialBenchmarkModule.initDatabase();
  const partialBenchmarkDb = partialBenchmarkModule.openDatabase();
  try {
    const scenario = seedBenchmarkTargetMigrationScenario(partialBenchmarkDb, 'PARTIAL');
    degradeBenchmarkTargetSourceContract(partialBenchmarkDb, partialBenchmarkModule);
    const originalColumns = partialBenchmarkDb.prepare('PRAGMA table_info(benchmark_targets)').all().map((column) => column.name);
    const originalTargets = partialBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all();
    assert.strictEqual(
      partialBenchmarkDb.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
        .filter((foreignKey) => foreignKey.from === 'source_batch_id').length,
      0,
      '场景必须模拟已有来源列但没有来源外键。'
    );
    const weakInsertTrigger = partialBenchmarkDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_benchmark_targets_source_insert'"
    ).get().sql;
    assert(/WHEN 0/i.test(weakInsertTrigger), '场景必须安装同名弱 INSERT 触发器。');

    assert.strictEqual(partialBenchmarkModule.migrateBenchmarkTargetsImportSourceColumns(partialBenchmarkDb), true);
    assert.deepStrictEqual(
      partialBenchmarkDb.prepare('PRAGMA table_info(benchmark_targets)').all().map((column) => column.name),
      originalColumns,
      '安全重建不得丢失或增加既有业务字段。'
    );
    assert.deepStrictEqual(
      partialBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all(),
      originalTargets,
      '安全重建不得修改既有 target 数据。'
    );
    const repairedForeignKey = partialBenchmarkDb.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
      .find((foreignKey) => foreignKey.from === 'source_batch_id');
    assert(repairedForeignKey, '缺失来源外键的部分迁移库必须补建外键。');
    assert.strictEqual(repairedForeignKey.table, 'import_batches');
    assert.strictEqual(repairedForeignKey.to, 'id');
    assert.strictEqual(repairedForeignKey.on_delete, 'NO ACTION');
    const repairedTargetSql = getCreateSql(partialBenchmarkDb, 'benchmark_targets');
    assert(repairedTargetSql.includes("status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))"));
    assert(repairedTargetSql.includes('target_value IS NOT NULL AND lower_bound IS NULL AND upper_bound IS NULL'));
    assert(partialBenchmarkDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_benchmark_targets_definition_status'").get());
    assert(partialBenchmarkDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_benchmark_targets_preserved_probe'").get());
    assert(partialBenchmarkDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_benchmark_targets_internal_update'").get());
    const repairedInsertTrigger = partialBenchmarkDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_benchmark_targets_source_insert'"
    ).get().sql;
    assert(!/WHEN 0/i.test(repairedInsertTrigger), '同名弱 INSERT 触发器必须被规范定义替换。');
    assert(repairedInsertTrigger.includes("typeof(NEW.source_row_number) = 'integer'"));
    assert.throws(
      () => partialBenchmarkDb.prepare('UPDATE benchmark_targets SET auto_refresh = 1 WHERE id = ?').run(scenario.internalTargetId),
      /internal history baseline target must remain frozen and complete/,
      '安全重建后内部历史固化触发器必须继续生效。'
    );
    assert.throws(
      () => partialBenchmarkDb.prepare(`INSERT INTO benchmark_targets
        (benchmark_definition_id, target_value, version, internal_revision, status)
        VALUES (?, 1, 'bad-status:v1', 2, 'deleted')`).run(scenario.manualDefinitionId),
      /CHECK constraint failed/,
      '安全重建后原 status CHECK 必须保留。'
    );
    assert.throws(
      () => partialBenchmarkDb.prepare(`INSERT INTO benchmark_targets
        (benchmark_definition_id, target_value, version, internal_revision)
        VALUES (?, 1, 'preserved:v1', 2)`).run(scenario.manualDefinitionId),
      /UNIQUE constraint failed/,
      '安全重建后原唯一约束必须保留。'
    );
    assertBenchmarkTargetImportSourceConstraints(
      partialBenchmarkDb,
      scenario.manualDefinitionId,
      scenario.sourceBatchId,
      'partial-source'
    );
    assert.strictEqual(
      partialBenchmarkModule.migrateBenchmarkTargetsImportSourceColumns(partialBenchmarkDb),
      false,
      '修复完成后二次迁移不得重复重建表或触发器。'
    );
    assert.deepStrictEqual(partialBenchmarkDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    partialBenchmarkDb.close();
  }

  // 错误指向 benchmark_definitions 且级联删除的来源外键必须被重建为受限 import_batches 外键。
  const wrongBenchmarkForeignKeyPath = path.join(dataDir, 'energy-analysis-benchmark-wrong-fk.sqlite');
  const wrongBenchmarkForeignKeyModule = loadDatabaseModule(wrongBenchmarkForeignKeyPath);
  wrongBenchmarkForeignKeyModule.initDatabase();
  const wrongBenchmarkForeignKeyDb = wrongBenchmarkForeignKeyModule.openDatabase();
  try {
    const scenario = seedBenchmarkTargetMigrationScenario(wrongBenchmarkForeignKeyDb, 'WRONG-FK');
    degradeBenchmarkTargetSourceContract(
      wrongBenchmarkForeignKeyDb,
      wrongBenchmarkForeignKeyModule,
      'FOREIGN KEY (source_batch_id) REFERENCES benchmark_definitions(id) ON DELETE CASCADE'
    );
    const wrongForeignKey = wrongBenchmarkForeignKeyDb.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
      .find((foreignKey) => foreignKey.from === 'source_batch_id');
    assert.strictEqual(wrongForeignKey.table, 'benchmark_definitions');
    assert.strictEqual(wrongForeignKey.on_delete, 'CASCADE');

    assert.strictEqual(wrongBenchmarkForeignKeyModule.migrateBenchmarkTargetsImportSourceColumns(wrongBenchmarkForeignKeyDb), true);
    const repairedForeignKey = wrongBenchmarkForeignKeyDb.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
      .find((foreignKey) => foreignKey.from === 'source_batch_id');
    assert.strictEqual(repairedForeignKey.table, 'import_batches');
    assert.strictEqual(repairedForeignKey.to, 'id');
    assert.strictEqual(repairedForeignKey.on_delete, 'NO ACTION');
    assert.strictEqual(
      wrongBenchmarkForeignKeyDb.prepare('SELECT COUNT(*) AS total FROM benchmark_targets WHERE id = ?').get(scenario.sourcedTargetId).total,
      1,
      '错误外键重建不得丢失既有来源目标。'
    );
    assert.deepStrictEqual(wrongBenchmarkForeignKeyDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    wrongBenchmarkForeignKeyDb.close();
  }

  // foreign_keys=OFF 遗留的孤儿来源必须阻止迁移，并完整保留原表、弱触发器、索引和数据。
  const orphanBenchmarkPath = path.join(dataDir, 'energy-analysis-benchmark-orphan.sqlite');
  const orphanBenchmarkModule = loadDatabaseModule(orphanBenchmarkPath);
  orphanBenchmarkModule.initDatabase();
  const orphanBenchmarkDb = orphanBenchmarkModule.openDatabase();
  try {
    const scenario = seedBenchmarkTargetMigrationScenario(orphanBenchmarkDb, 'ORPHAN');
    degradeBenchmarkTargetSourceContract(orphanBenchmarkDb, orphanBenchmarkModule);
    orphanBenchmarkDb.pragma('foreign_keys = OFF');
    orphanBenchmarkDb.prepare(`INSERT INTO benchmark_targets
      (source_batch_id, source_row_number, benchmark_definition_id, target_value, version, internal_revision)
      VALUES (999999999, 9, ?, 13, 'orphan:v1', 2)`).run(scenario.manualDefinitionId);
    const beforeCreateSql = getCreateSql(orphanBenchmarkDb, 'benchmark_targets');
    const beforeTriggerSql = orphanBenchmarkDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_benchmark_targets_source_insert'"
    ).get().sql;
    const beforeIndexes = orphanBenchmarkDb.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'benchmark_targets' ORDER BY name"
    ).all();
    const beforeTargets = orphanBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all();

    assert.throws(
      () => orphanBenchmarkModule.migrateBenchmarkTargetsImportSourceColumns(orphanBenchmarkDb),
      /孤儿导入批次引用/,
      '孤儿来源必须阻止外键重建。'
    );
    assert.strictEqual(getCreateSql(orphanBenchmarkDb, 'benchmark_targets'), beforeCreateSql);
    assert.strictEqual(
      orphanBenchmarkDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_benchmark_targets_source_insert'"
      ).get().sql,
      beforeTriggerSql,
      '孤儿迁移失败后同名弱触发器不得被半替换。'
    );
    assert.deepStrictEqual(
      orphanBenchmarkDb.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'benchmark_targets' ORDER BY name"
      ).all(),
      beforeIndexes,
      '孤儿迁移失败后索引必须完整回滚。'
    );
    assert.deepStrictEqual(orphanBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all(), beforeTargets);
    assert.strictEqual(
      orphanBenchmarkDb.prepare("SELECT COUNT(*) AS total FROM benchmark_targets WHERE version = 'orphan:v1'").get().total,
      1,
      '孤儿迁移失败后既有数据必须完整保留。'
    );
  } finally {
    orphanBenchmarkDb.close();
  }

  // 需重建时若存在任意删除动作的扩展子表，必须在修改前安全失败，禁止 DROP 触发级联副作用。
  const inboundBenchmarkPath = path.join(dataDir, 'energy-analysis-benchmark-inbound.sqlite');
  const inboundBenchmarkModule = loadDatabaseModule(inboundBenchmarkPath);
  inboundBenchmarkModule.initDatabase();
  const inboundBenchmarkDb = inboundBenchmarkModule.openDatabase();
  try {
    const scenario = seedBenchmarkTargetMigrationScenario(inboundBenchmarkDb, 'INBOUND');
    degradeBenchmarkTargetSourceContract(inboundBenchmarkDb, inboundBenchmarkModule);
    inboundBenchmarkDb.exec(`CREATE TABLE benchmark_target_child_cascade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE CASCADE
    );
    CREATE TABLE benchmark_target_child_set_null (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER,
      note TEXT,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE SET NULL
    );
    CREATE TABLE benchmark_target_child_no_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE NO ACTION
    );
    CREATE TABLE sqliteX_benchmark_child (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE CASCADE
    );
    CREATE TABLE sqlite1_child (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE NO ACTION
    );`);
    inboundBenchmarkDb.prepare('INSERT INTO benchmark_target_child_cascade (benchmark_target_id, note) VALUES (?, ?)')
      .run(scenario.sourcedTargetId, 'cascade-child');
    inboundBenchmarkDb.prepare('INSERT INTO benchmark_target_child_set_null (benchmark_target_id, note) VALUES (?, ?)')
      .run(scenario.sourcedTargetId, 'set-null-child');
    inboundBenchmarkDb.prepare('INSERT INTO benchmark_target_child_no_action (benchmark_target_id, note) VALUES (?, ?)')
      .run(scenario.sourcedTargetId, 'no-action-child');
    inboundBenchmarkDb.prepare('INSERT INTO sqliteX_benchmark_child (benchmark_target_id, note) VALUES (?, ?)')
      .run(scenario.sourcedTargetId, 'sqlite-x-child');
    inboundBenchmarkDb.prepare('INSERT INTO sqlite1_child (benchmark_target_id, note) VALUES (?, ?)')
      .run(scenario.sourcedTargetId, 'sqlite-one-child');

    const inboundTableNames = [
      'benchmark_target_child_cascade',
      'benchmark_target_child_no_action',
      'benchmark_target_child_set_null',
      'sqlite1_child',
      'sqliteX_benchmark_child'
    ];
    const inboundTablePlaceholders = inboundTableNames.map(() => '?').join(', ');
    const beforeSchema = inboundBenchmarkDb.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE tbl_name = 'benchmark_targets'
         OR name IN (${inboundTablePlaceholders})
         OR tbl_name IN (${inboundTablePlaceholders})
      ORDER BY type, name`).all(...inboundTableNames, ...inboundTableNames);
    const beforeTargets = inboundBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all();
    const beforeChildren = inboundTableNames.map((tableName) => ({
      tableName,
      rows: inboundBenchmarkDb.prepare(`SELECT * FROM "${tableName}" ORDER BY id`).all()
    }));
    const beforeForeignKeysPragma = inboundBenchmarkDb.pragma('foreign_keys', { simple: true });

    assert.throws(
      () => inboundBenchmarkModule.migrateBenchmarkTargetsImportSourceColumns(inboundBenchmarkDb),
      (error) => error.message === 'benchmark_targets 存在入向外键引用，禁止自动重建；引用表：["benchmark_target_child_cascade","benchmark_target_child_no_action","benchmark_target_child_set_null","sqlite1_child","sqliteX_benchmark_child"]',
      '存在扩展子表时必须返回稳定且安全列出引用表名，并且不得把 sqliteX 或 sqlite1 前缀误判为系统表。'
    );
    assert.deepStrictEqual(
      inboundBenchmarkDb.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE tbl_name = 'benchmark_targets'
           OR name IN (${inboundTablePlaceholders})
           OR tbl_name IN (${inboundTablePlaceholders})
        ORDER BY type, name`).all(...inboundTableNames, ...inboundTableNames),
      beforeSchema,
      '安全失败后目标表、子表、索引和触发器 schema 必须完全不变。'
    );
    assert.deepStrictEqual(inboundBenchmarkDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all(), beforeTargets);
    inboundTableNames.forEach((tableName, index) => {
      assert.deepStrictEqual(
        inboundBenchmarkDb.prepare(`SELECT * FROM "${tableName}" ORDER BY id`).all(),
        beforeChildren[index].rows,
        `${tableName} 子记录不得被级联删除、置空或改写。`
      );
    });
    assert.strictEqual(
      inboundBenchmarkDb.pragma('foreign_keys', { simple: true }),
      beforeForeignKeysPragma,
      '安全失败不得改变 foreign_keys pragma。'
    );
  } finally {
    inboundBenchmarkDb.close();
  }

  // 外键和来源触发器已规范时，即使有入向 FK，也不得误判为需要重建。
  const canonicalInboundPath = path.join(dataDir, 'energy-analysis-benchmark-canonical-inbound.sqlite');
  const canonicalInboundModule = loadDatabaseModule(canonicalInboundPath);
  canonicalInboundModule.initDatabase();
  const canonicalInboundDb = canonicalInboundModule.openDatabase();
  try {
    const scenario = seedBenchmarkTargetMigrationScenario(canonicalInboundDb, 'CANONICAL-INBOUND');
    canonicalInboundDb.exec(`CREATE TABLE benchmark_target_child_canonical (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_target_id INTEGER NOT NULL,
      FOREIGN KEY (benchmark_target_id) REFERENCES benchmark_targets(id) ON DELETE NO ACTION
    )`);
    canonicalInboundDb.prepare('INSERT INTO benchmark_target_child_canonical (benchmark_target_id) VALUES (?)')
      .run(scenario.sourcedTargetId);
    const beforeTargetRows = canonicalInboundDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all();
    const beforeChildRows = canonicalInboundDb.prepare('SELECT * FROM benchmark_target_child_canonical ORDER BY id').all();
    assert.strictEqual(
      canonicalInboundModule.migrateBenchmarkTargetsImportSourceColumns(canonicalInboundDb),
      false,
      '无需重建时入向外键不得阻断正常幂等迁移。'
    );
    assert.deepStrictEqual(canonicalInboundDb.prepare('SELECT * FROM benchmark_targets ORDER BY id').all(), beforeTargetRows);
    assert.deepStrictEqual(
      canonicalInboundDb.prepare('SELECT * FROM benchmark_target_child_canonical ORDER BY id').all(),
      beforeChildRows
    );
    assert.deepStrictEqual(canonicalInboundDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    canonicalInboundDb.close();
  }

  // import_batches 重建失败必须回滚旧数据、临时表和外键开关。
  const importRollbackPath = path.join(dataDir, 'energy-analysis-import-rollback.sqlite');
  const importRollbackDb = new Database(importRollbackPath);
  try {
    importRollbackDb.pragma('foreign_keys = ON');
    importRollbackDb.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
      file_size_bytes INTEGER,
      file_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      total_rows INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      duplicate_strategy TEXT NOT NULL DEFAULT 'skip',
      field_mapping_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_summary TEXT
    )`);
    importRollbackDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES ('legacy_bad_type', 'bad.csv', 'csv')").run();
    assert.throws(
      () => legacyDatabaseModule.migrateImportBatchesImportTypeCheck(importRollbackDb),
      /CHECK constraint failed/,
      '非法历史 import_type 必须触发安全重建回滚。'
    );
    assert.strictEqual(importRollbackDb.prepare("SELECT COUNT(*) AS total FROM import_batches WHERE import_type = 'legacy_bad_type'").get().total, 1);
    assert.strictEqual(importRollbackDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'import_batches__migration_new'").get().total, 0);
    assert.strictEqual(importRollbackDb.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    importRollbackDb.close();
  }

  // 对标目标来源补列或触发器创建失败时必须整体回滚，不得残留半迁移列或丢失既有数据。
  const benchmarkRollbackPath = path.join(dataDir, 'energy-analysis-benchmark-rollback.sqlite');
  const benchmarkRollbackDb = new Database(benchmarkRollbackPath);
  try {
    benchmarkRollbackDb.pragma('foreign_keys = ON');
    benchmarkRollbackDb.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE benchmark_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_definition_id INTEGER NOT NULL,
      target_value REAL,
      version TEXT NOT NULL
    );
    INSERT INTO benchmark_targets (benchmark_definition_id, target_value, version)
    VALUES (1, 20, 'rollback:v1');`);
    assert.throws(
      () => legacyDatabaseModule.migrateBenchmarkTargetsImportSourceColumns(
        benchmarkRollbackDb,
        'CREATE TRIGGER invalid_benchmark_source_trigger BEFORE INSERT ON benchmark_targets BEGIN'
      ),
      /syntax error|incomplete input/i,
      '对标目标来源迁移失败必须抛出错误。'
    );
    const rollbackColumns = new Set(benchmarkRollbackDb.prepare('PRAGMA table_info(benchmark_targets)').all().map((column) => column.name));
    assert(!rollbackColumns.has('source_batch_id'), '迁移失败后不得残留 source_batch_id。');
    assert(!rollbackColumns.has('source_row_number'), '迁移失败后不得残留 source_row_number。');
    assert.strictEqual(benchmarkRollbackDb.prepare("SELECT COUNT(*) AS total FROM benchmark_targets WHERE version = 'rollback:v1'").get().total, 1);
    assert.strictEqual(benchmarkRollbackDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name = 'invalid_benchmark_source_trigger'").get().total, 0);
    assert.deepStrictEqual(benchmarkRollbackDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    benchmarkRollbackDb.close();
  }

  // 独立能源分析 DDL 事务失败时不得残留半创建表。
  const schemaRollbackPath = path.join(dataDir, 'energy-analysis-schema-rollback.sqlite');
  const schemaRollbackDb = new Database(schemaRollbackPath);
  try {
    const invalidSchema = `-- ENERGY_ANALYSIS_SCHEMA_START
      CREATE TABLE energy_analysis_probe (id INTEGER PRIMARY KEY);
      CREATE TABLE invalid_sql (
    -- ENERGY_ANALYSIS_SCHEMA_END`;
    assert.throws(
      () => legacyDatabaseModule.ensureEnergyAnalysisTables(schemaRollbackDb, invalidSchema),
      /syntax error|incomplete input/i,
      '能源分析建表片段失败必须触发事务回滚。'
    );
    assert.strictEqual(schemaRollbackDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'energy_analysis_probe'").get().total, 0);
    const duplicateMarkerSchema = `-- ENERGY_ANALYSIS_SCHEMA_START
      -- ENERGY_ANALYSIS_SCHEMA_START
      CREATE TABLE duplicate_marker_probe (id INTEGER PRIMARY KEY);
      -- ENERGY_ANALYSIS_SCHEMA_END`;
    assert.throws(
      () => legacyDatabaseModule.ensureEnergyAnalysisTables(schemaRollbackDb, duplicateMarkerSchema),
      /标记缺失、重复或顺序错误/,
      '能源分析 schema 开始或结束标记重复时必须明确失败。'
    );
    assert.strictEqual(schemaRollbackDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'duplicate_marker_probe'").get().total, 0);
  } finally {
    schemaRollbackDb.close();
  }

  // 已登记 canonical 库出现 SHA 治理结构漂移时，正式初始化必须先拒绝且不得改写任何结构或绑定。
  const shaRollbackPath = path.join(dataDir, 'demo-sha256-init-rollback.sqlite');
  const shaRollbackModule = loadDatabaseModule(shaRollbackPath);
  shaRollbackModule.initDatabase();
  const shaRollbackSeedDb = shaRollbackModule.openDatabase();
  try {
    weakenDemoImportContextsSha256Contract(shaRollbackSeedDb);
    seedDemoSha256MigrationContext(shaRollbackSeedDb, {
      runId: 'sha-rollback-run',
      datasetId: 'sha-rollback-dataset',
      runManifestDigest: 'f'.repeat(64),
      contextId: 'sha-rollback-context',
      tokenHash: 'a'.repeat(64),
      contextManifestDigest: 'f'.repeat(64),
      artifactKey: '13-shift-definitions',
      artifactFileSha256: 'b'.repeat(64),
      uploadFileSha256: 'c'.repeat(64)
    });
    weakenDemoDatasetRunsSha256Contract(
      shaRollbackSeedDb,
      'sha-rollback-run',
      'F'.repeat(64)
    );
    shaRollbackSeedDb.prepare(`UPDATE demo_import_contexts
      SET token_hash = ?, manifest_digest = ?, artifact_file_sha256 = ?, upload_file_sha256 = ?
      WHERE context_id = 'sha-rollback-context'`)
      .run('A'.repeat(64), 'F'.repeat(64), 'B'.repeat(64), 'C'.repeat(64));
    shaRollbackSeedDb.prepare("UPDATE sys_users SET status = 'inactive' WHERE username = 'admin'").run();
  } finally {
    shaRollbackSeedDb.close();
  }
  const shaRollbackBeforeDb = new Database(shaRollbackPath, { readonly: true });
  const shaRollbackBefore = {
    runSql: getCreateSql(shaRollbackBeforeDb, 'demo_dataset_runs'),
    contextSql: getCreateSql(shaRollbackBeforeDb, 'demo_import_contexts'),
    run: shaRollbackBeforeDb.prepare(`SELECT * FROM demo_dataset_runs
      WHERE run_id = 'sha-rollback-run'`).get(),
    context: shaRollbackBeforeDb.prepare(`SELECT * FROM demo_import_contexts
      WHERE context_id = 'sha-rollback-context'`).get()
  };
  shaRollbackBeforeDb.close();
  assertInitializationRejected(
    () => shaRollbackModule.initDatabase(),
    'SCHEMA_FINGERPRINT_MISMATCH',
    'SHA 治理结构漂移必须在管理员恢复或任何迁移动作前被拒绝。'
  );
  const shaRollbackAfterDb = new Database(shaRollbackPath, { readonly: true });
  try {
    assert.strictEqual(getCreateSql(shaRollbackAfterDb, 'demo_dataset_runs'), shaRollbackBefore.runSql,
      '初始化后段失败必须恢复弱 run 表结构。');
    assert.strictEqual(getCreateSql(shaRollbackAfterDb, 'demo_import_contexts'), shaRollbackBefore.contextSql,
      '初始化后段失败必须恢复弱 context 表结构。');
    assert.deepStrictEqual(
      shaRollbackAfterDb.prepare(`SELECT * FROM demo_dataset_runs
        WHERE run_id = 'sha-rollback-run'`).get(),
      shaRollbackBefore.run,
      '初始化后段失败不得保留 run 安全替代摘要。'
    );
    assert.deepStrictEqual(
      shaRollbackAfterDb.prepare(`SELECT * FROM demo_import_contexts
        WHERE context_id = 'sha-rollback-context'`).get(),
      shaRollbackBefore.context,
      '初始化后段失败不得提前撤销 context 或清除 preview/upload 绑定。'
    );
    assert.strictEqual(
      shaRollbackAfterDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name LIKE '%sha256_%'").get().total,
      0,
      '初始化后段失败不得残留 SHA 迁移临时表或索引。'
    );
  } finally {
    shaRollbackAfterDb.close();
  }

  // 管理员初始化失败时不得提前写入能源分析完成标记。
  const noAdminDatabasePath = path.join(dataDir, 'energy-analysis-no-admin.sqlite');
  const configuredAdminPassword = process.env.CHARCOAL_ADMIN_PASSWORD;
  delete process.env.CHARCOAL_ADMIN_PASSWORD;
  const noAdminDatabaseModule = loadDatabaseModule(noAdminDatabasePath);
  try {
    assert.throws(
      () => noAdminDatabaseModule.initDatabase(),
      /缺少 CHARCOAL_ADMIN_PASSWORD/,
      '缺少管理员密码时新库初始化必须失败。'
    );
  } finally {
    process.env.CHARCOAL_ADMIN_PASSWORD = configuredAdminPassword;
  }
  const noAdminDb = new Database(noAdminDatabasePath, { readonly: true });
  try {
    const schemaObjects = noAdminDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
    assert.deepStrictEqual(schemaObjects, [], 'RBAC 后段失败时初始化前空库结构必须整体不变。');
    assert.strictEqual(noAdminDb.pragma('user_version', { simple: true }), 0);
  } finally {
    noAdminDb.close();
  }

  // 无 schema 身份的既有库必须优先按 UNKNOWN_EXISTING_SCHEMA 拒绝，并保持结构与数据不变。
  const existingNoAdminDatabasePath = path.join(dataDir, 'energy-analysis-existing-no-admin.sqlite');
  const existingNoAdminDb = new Database(existingNoAdminDatabasePath);
  try {
    existingNoAdminDb.exec(`CREATE TABLE preserved_probe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX idx_preserved_probe_value ON preserved_probe(value);
    INSERT INTO preserved_probe (id, value) VALUES (1, 'preserved');`);
  } finally {
    existingNoAdminDb.close();
  }
  const beforeFailedInitDb = new Database(existingNoAdminDatabasePath, { readonly: true });
  const beforeFailedInitSnapshot = beforeFailedInitDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const beforeFailedInitData = beforeFailedInitDb.prepare('SELECT id, value FROM preserved_probe ORDER BY id').all();
  beforeFailedInitDb.close();
  delete process.env.CHARCOAL_ADMIN_PASSWORD;
  const existingNoAdminModule = loadDatabaseModule(existingNoAdminDatabasePath);
  try {
    assertInitializationRejected(
      () => existingNoAdminModule.initDatabase(),
      'UNKNOWN_EXISTING_SCHEMA',
      '没有 app_meta 身份的既有库必须拒绝初始化，不得因管理员密码分支进入自动迁移。'
    );
  } finally {
    process.env.CHARCOAL_ADMIN_PASSWORD = configuredAdminPassword;
  }
  const afterFailedInitDb = new Database(existingNoAdminDatabasePath, { readonly: true });
  try {
    assert.deepStrictEqual(afterFailedInitDb.prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all(), beforeFailedInitSnapshot,
    '未知既有库被拒绝后结构必须整体不变。');
    assert.deepStrictEqual(afterFailedInitDb.prepare('SELECT id, value FROM preserved_probe ORDER BY id').all(), beforeFailedInitData,
      '未知既有库被拒绝后数据必须整体不变。');
  } finally {
    afterFailedInitDb.close();
  }

  // 全新数据库仅含未知 view 时也不得被误判为 fresh，且第一次初始化不得写入 metadata。
  assertUnknownSchemaObjectsRejected(
    path.join(dataDir, 'energy-analysis-unknown-view.sqlite'),
    `CREATE VIEW unknown_fresh_view AS SELECT 1 AS marker`,
    ['unknown_fresh_view']
  );

  // 全新数据库仅含未知 trigger 及其承载表时必须拒绝，不能只检查业务 table 白名单。
  assertUnknownSchemaObjectsRejected(
    path.join(dataDir, 'energy-analysis-unknown-trigger.sqlite'),
    `CREATE TABLE unknown_trigger_base (id INTEGER PRIMARY KEY);
     CREATE TRIGGER unknown_fresh_trigger
     AFTER INSERT ON unknown_trigger_base
     FOR EACH ROW BEGIN
       SELECT 1;
     END`,
    ['unknown_trigger_base', 'unknown_fresh_trigger']
  );

  // 显式未知 index 同样属于持久 schema 对象，必须在首次初始化前被拒绝。
  assertUnknownSchemaObjectsRejected(
    path.join(dataDir, 'energy-analysis-unknown-index.sqlite'),
    `CREATE TABLE unknown_index_base (id INTEGER PRIMARY KEY, marker TEXT);
     CREATE INDEX unknown_fresh_index ON unknown_index_base(marker)`,
    ['unknown_index_base', 'unknown_fresh_index']
  );

  console.log('energy analysis schema migration tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
