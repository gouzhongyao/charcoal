'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 迁移测试仅使用系统临时目录和隔离 SQLite，不访问真实业务数据库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-balance-identity-migration-'));
// 隔离数据库目录。
process.env.DATA_DIR = path.join(tmpDir, 'data');
// 隔离数据库文件。
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'balance-identity-migration.sqlite');
// 隔离上传目录。
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
// 隔离备份目录。
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
// 测试环境不输出内部错误详情。
process.env.NODE_ENV = 'test';
// 全新 canonical 隔离库初始化使用固定测试管理员密码。
process.env.CHARCOAL_ADMIN_PASSWORD = 'BalanceMigration123!';

const {
  calculateSchemaFingerprint,
  getTableColumns,
  initDatabase,
  migrateEnergyBalanceCalculationRuns,
  migrateEnergyBalanceImportSourceColumns,
  openDatabase
} = require('../db/database');

/**
 * 创建未包含计算运行和冻结标识列的旧版平衡最小结构。
 * @param {object} db SQLite 数据库连接。
 */
function createLegacyBalanceSchema(db) {
  db.exec(`
    CREATE TABLE sys_users (id INTEGER PRIMARY KEY);
    CREATE TABLE import_batches (id INTEGER PRIMARY KEY);
    CREATE TABLE energy_balance_boundaries (id INTEGER PRIMARY KEY);
    CREATE TABLE energy_balance_items (
      id INTEGER PRIMARY KEY,
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
      created_at TEXT NOT NULL
    );
    CREATE TABLE energy_balance_snapshot_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      energy_balance_snapshot_id INTEGER NOT NULL,
      energy_balance_item_id INTEGER NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE energy_balance_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      energy_balance_snapshot_id INTEGER NOT NULL,
      manual_status TEXT NOT NULL,
      priority TEXT NOT NULL
    );
  `);
}

/**
 * 插入迁移回填使用的旧版快照和主项目夹具。
 * @param {object} db SQLite 数据库连接。
 */
function insertLegacyFixture(db) {
  db.prepare('INSERT INTO import_batches (id) VALUES (9)').run();
  db.prepare('INSERT INTO energy_balance_boundaries (id) VALUES (1)').run();
  db.prepare(
    'INSERT INTO energy_balance_items (id, item_code, item_name) VALUES (1, ?, ?)'
  ).run('LEGACY-INPUT', '旧版输入项目');
  const snapshotId = Number(db.prepare(`INSERT INTO energy_balance_snapshots (
      energy_balance_boundary_id, start_utc, end_utc, source_timezone,
      source_data_digest, formula_version, created_at
    ) VALUES (1, ?, ?, 'Asia/Shanghai', ?, 'energy-balance:v1', ?)`)
    .run(
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      'a'.repeat(64),
      '2026-08-01T00:00:00.000Z'
    ).lastInsertRowid);
  db.prepare(`INSERT INTO energy_balance_snapshot_items (
    energy_balance_snapshot_id, energy_balance_item_id, role
  ) VALUES (?, 1, 'input')`).run(snapshotId);
}

/** 将全新库中的平衡主表还原为缺少来源列的上一版 canonical 结构。 */
function rebuildBalanceTablesWithoutImportSources(db) {
  // 重建期间临时关闭外键，完成后恢复原始连接设置并执行完整外键检查。
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

        CREATE TABLE energy_balance_boundaries__previous (
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

        CREATE TABLE energy_balance_items__previous (
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

        INSERT INTO energy_balance_boundaries__previous
          (id, boundary_code, boundary_name, organization_unit_id, source, document_no, version,
           effective_start_utc, effective_end_utc, source_timezone, generation_boundary_confirmed,
           status, created_at, updated_at)
        SELECT id, boundary_code, boundary_name, organization_unit_id, source, document_no, version,
          effective_start_utc, effective_end_utc, source_timezone, generation_boundary_confirmed,
          status, created_at, updated_at
        FROM energy_balance_boundaries;

        INSERT INTO energy_balance_items__previous
          (id, energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
           source_type, source_mapping_json, generation_anti_double_count_key, status, created_at, updated_at)
        SELECT id, energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
          source_type, source_mapping_json, generation_anti_double_count_key, status, created_at, updated_at
        FROM energy_balance_items;

        DROP TABLE energy_balance_items;
        DROP TABLE energy_balance_boundaries;
        ALTER TABLE energy_balance_boundaries__previous RENAME TO energy_balance_boundaries;
        ALTER TABLE energy_balance_items__previous RENAME TO energy_balance_items;
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

/** 验证 initDatabase 可在建来源索引前迁移上一版 canonical 平衡表，并保持重复启动幂等。 */
function assertCanonicalInitializationMigration() {
  // canonical 兼容迁移测试使用独立文件，不复用前一段最小结构测试库。
  const canonicalDatabasePath = path.join(tmpDir, 'canonical-balance-source-migration.sqlite');
  initDatabase({ databasePath: canonicalDatabasePath });
  // 预迁移数据库连接用于写入保留夹具并模拟上一版已登记 schema 指纹。
  let canonicalDb = openDatabase({ databasePath: canonicalDatabasePath });
  try {
    // 默认电力能源类型作为平衡项目外键夹具。
    const energyTypeId = canonicalDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    // 历史平衡边界用于确认迁移不会丢失已有记录。
    const boundaryId = Number(canonicalDb.prepare(`INSERT INTO energy_balance_boundaries
      (boundary_code, boundary_name, source, version, effective_start_utc, effective_end_utc,
       source_timezone, generation_boundary_confirmed, status)
      VALUES ('BALANCE-LEGACY', '历史平衡边界', 'manual', 'v1',
        '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai', 1, 'active')`).run().lastInsertRowid);
    canonicalDb.prepare(`INSERT INTO energy_balance_items
      (energy_balance_boundary_id, item_code, item_name, role, energy_type_id, original_unit,
       source_type, source_mapping_json, status)
      VALUES (?, 'LEGACY-INPUT', '历史输入项', 'input', ?, 'kWh',
        'explicit_balance_value', '{"reference":"legacy-balance-test"}', 'active')`).run(boundaryId, energyTypeId);

    rebuildBalanceTablesWithoutImportSources(canonicalDb);
    assert(!getTableColumns(canonicalDb, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(!getTableColumns(canonicalDb, 'energy_balance_items').includes('source_row_number'));
    // 上一版 canonical 身份登记其实际结构指纹，确保初始化先经过正常 admission 校验。
    const previousFingerprint = calculateSchemaFingerprint(canonicalDb);
    canonicalDb.prepare(`UPDATE app_meta
      SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'schema_fingerprint'`).run(previousFingerprint);
  } finally {
    canonicalDb.close();
  }

  initDatabase({ databasePath: canonicalDatabasePath });
  canonicalDb = openDatabase({ databasePath: canonicalDatabasePath });
  try {
    assert(getTableColumns(canonicalDb, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(getTableColumns(canonicalDb, 'energy_balance_boundaries').includes('source_row_number'));
    assert(getTableColumns(canonicalDb, 'energy_balance_items').includes('source_batch_id'));
    assert(getTableColumns(canonicalDb, 'energy_balance_items').includes('source_row_number'));
    assert(canonicalDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_balance_boundaries_source'").get());
    assert(canonicalDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_balance_items_source'").get());
    assert(canonicalDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_energy_balance_boundaries_source_insert'").get());
    assert.deepStrictEqual(
      canonicalDb.prepare(`SELECT boundary_code AS boundaryCode, boundary_name AS boundaryName,
          source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber
        FROM energy_balance_boundaries WHERE boundary_code = 'BALANCE-LEGACY'`).get(),
      { boundaryCode: 'BALANCE-LEGACY', boundaryName: '历史平衡边界', sourceBatchId: null, sourceRowNumber: null }
    );
    assert.strictEqual(canonicalDb.prepare("SELECT COUNT(*) AS total FROM energy_balance_items WHERE item_code = 'LEGACY-INPUT'").get().total, 1);
    // 迁移完成后登记指纹必须精确匹配实际结构，供后续启动继续 fail-closed 校验。
    const registeredFingerprint = canonicalDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value;
    assert.strictEqual(registeredFingerprint, calculateSchemaFingerprint(canonicalDb));
    assert.deepStrictEqual(
      canonicalDb.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]),
      ['ok']
    );
    assert.deepStrictEqual(
      canonicalDb.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]),
      ['ok']
    );
    assert.deepStrictEqual(canonicalDb.pragma('foreign_key_check'), []);
  } finally {
    canonicalDb.close();
  }
  assert.doesNotThrow(() => initDatabase({ databasePath: canonicalDatabasePath }));
}

/** 验证旧来源 profile 含无关索引或触发器时 fail-closed，且事务不留下部分迁移。 */
function assertCanonicalInitializationRejectsUnrelatedSchemaDrift() {
  // 负向场景使用独立隔离文件，避免影响正向迁移和幂等断言。
  const driftDatabasePath = path.join(tmpDir, 'canonical-balance-source-drift.sqlite');
  initDatabase({ databasePath: driftDatabasePath });
  // 漂移前连接用于构造已登记但不受信任的旧来源结构。
  let driftDb = openDatabase({ databasePath: driftDatabasePath });
  let driftFingerprint;
  try {
    rebuildBalanceTablesWithoutImportSources(driftDb);
    driftDb.exec(`ALTER TABLE energy_balance_boundaries ADD COLUMN unexpected_note TEXT;
      CREATE TABLE energy_balance_unexpected_object (id INTEGER PRIMARY KEY);
      CREATE INDEX idx_energy_balance_boundaries_unexpected
        ON energy_balance_boundaries(boundary_name);
      CREATE TRIGGER trg_energy_balance_boundaries_unexpected
      AFTER UPDATE ON energy_balance_boundaries
      BEGIN
        SELECT 1;
      END;`);
    // 同步登记漂移后的实际指纹，证明拒绝来自严格 profile 而非 admission 指纹不一致。
    driftFingerprint = calculateSchemaFingerprint(driftDb);
    driftDb.prepare(`UPDATE app_meta
      SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'schema_fingerprint'`).run(driftFingerprint);
  } finally {
    driftDb.close();
  }

  assert.throws(
    () => initDatabase({ databasePath: driftDatabasePath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
      && error?.details?.profileStage === 'legacy'
      && error.details.issues.some((issue) => issue.includes('changed:table:energy_balance_boundaries'))
      && error.details.issues.some((issue) => issue.includes('unexpected:table:energy_balance_unexpected_object'))
      && error.details.issues.some((issue) => issue.includes('unexpected:index:idx_energy_balance_boundaries_unexpected'))
      && error.details.issues.some((issue) => issue.includes('unexpected:trigger:trg_energy_balance_boundaries_unexpected'))
  );

  driftDb = openDatabase({ databasePath: driftDatabasePath });
  try {
    // 失败事务不得补列、建来源索引或重新登记 fingerprint。
    assert(!getTableColumns(driftDb, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(getTableColumns(driftDb, 'energy_balance_boundaries').includes('unexpected_note'));
    assert(driftDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'energy_balance_unexpected_object'").get());
    assert(!getTableColumns(driftDb, 'energy_balance_items').includes('source_row_number'));
    assert.strictEqual(
      driftDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_balance_boundaries_source'").get(),
      undefined
    );
    assert.strictEqual(
      driftDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_energy_balance_boundaries_source_insert'").get(),
      undefined
    );
    assert(driftDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_balance_boundaries_unexpected'").get());
    assert(driftDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_energy_balance_boundaries_unexpected'").get());
    const registeredFingerprint = driftDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value;
    assert.strictEqual(registeredFingerprint, driftFingerprint);
    assert.strictEqual(calculateSchemaFingerprint(driftDb), driftFingerprint);
  } finally {
    driftDb.close();
  }
}

/** 验证伪造 metadata fingerprint 不能绕过精确 legacy profile admission。 */
function assertCanonicalInitializationRejectsForgedMetadataFingerprint() {
  // metadata 负向场景使用独立隔离文件，避免污染其他迁移断言。
  const forgedDatabasePath = path.join(tmpDir, 'canonical-balance-source-forged-metadata.sqlite');
  initDatabase({ databasePath: forgedDatabasePath });
  // predecessor 连接用于记录实际结构指纹并写入一个不同的合法格式伪造值。
  let forgedDb = openDatabase({ databasePath: forgedDatabasePath });
  let actualFingerprint;
  let forgedFingerprint;
  try {
    rebuildBalanceTablesWithoutImportSources(forgedDb);
    actualFingerprint = calculateSchemaFingerprint(forgedDb);
    forgedFingerprint = actualFingerprint === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    forgedDb.prepare(`UPDATE app_meta
      SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'schema_fingerprint'`).run(forgedFingerprint);
  } finally {
    forgedDb.close();
  }

  assert.throws(
    () => initDatabase({ databasePath: forgedDatabasePath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
      && error?.details?.profileStage === 'legacy-admission'
      && error.details.metadataFingerprint === forgedFingerprint
      && error.details.actual === actualFingerprint
  );

  forgedDb = openDatabase({ databasePath: forgedDatabasePath });
  try {
    assert(!getTableColumns(forgedDb, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(!getTableColumns(forgedDb, 'energy_balance_items').includes('source_row_number'));
    assert.strictEqual(
      forgedDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      forgedFingerprint
    );
    assert.strictEqual(calculateSchemaFingerprint(forgedDb), actualFingerprint);
  } finally {
    forgedDb.close();
  }
}

/** 验证提交前外键检查故障会回滚补列、对象创建和 metadata 更新。 */
function assertCanonicalInitializationRollsBackMigrationFailure() {
  // 故障回滚场景使用独立隔离文件，并仅注入与平衡表无关的业务行外键违规。
  const rollbackDatabasePath = path.join(tmpDir, 'canonical-balance-source-rollback.sqlite');
  initDatabase({ databasePath: rollbackDatabasePath });
  // predecessor 连接用于构造可完成平衡迁移、但会在最终外键检查中失败的数据。
  let rollbackDb = openDatabase({ databasePath: rollbackDatabasePath });
  let predecessorFingerprint;
  try {
    rebuildBalanceTablesWithoutImportSources(rollbackDb);
    rollbackDb.pragma('foreign_keys = OFF');
    rollbackDb.prepare(`INSERT INTO sys_user_roles (user_id, role_id, created_at)
      VALUES (987654, 987655, '2026-08-28T00:00:00.000Z')`).run();
    rollbackDb.pragma('foreign_keys = ON');
    predecessorFingerprint = calculateSchemaFingerprint(rollbackDb);
    rollbackDb.prepare(`UPDATE app_meta
      SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'schema_fingerprint'`).run(predecessorFingerprint);
  } finally {
    rollbackDb.close();
  }

  assert.throws(
    () => initDatabase({ databasePath: rollbackDatabasePath }),
    (error) => error?.code === 'SQLITE_FOREIGN_KEY_CHECK_FAILED'
      && error.details.foreignKeyViolations.some((violation) => violation.table === 'sys_user_roles')
  );

  rollbackDb = openDatabase({ databasePath: rollbackDatabasePath });
  try {
    assert(!getTableColumns(rollbackDb, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(!getTableColumns(rollbackDb, 'energy_balance_items').includes('source_row_number'));
    assert.strictEqual(
      rollbackDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_balance_boundaries_source'").get(),
      undefined
    );
    assert.strictEqual(
      rollbackDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_energy_balance_boundaries_source_insert'").get(),
      undefined
    );
    assert.strictEqual(
      rollbackDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_fingerprint'").get().value,
      predecessorFingerprint
    );
    assert.strictEqual(calculateSchemaFingerprint(rollbackDb), predecessorFingerprint);
    assert.deepStrictEqual(
      rollbackDb.prepare(`SELECT user_id AS userId, role_id AS roleId, created_at AS createdAt
        FROM sys_user_roles WHERE user_id = 987654 AND role_id = 987655`).get(),
      { userId: 987654, roleId: 987655, createdAt: '2026-08-28T00:00:00.000Z' }
    );
  } finally {
    rollbackDb.close();
  }
}

/** 运行旧库补列、回填、幂等、初始化顺序和不可变约束验证。 */
function run() {
  const db = openDatabase();
  try {
    createLegacyBalanceSchema(db);
    insertLegacyFixture(db);
    assert.strictEqual(migrateEnergyBalanceCalculationRuns(db), true);
    assert.strictEqual(migrateEnergyBalanceImportSourceColumns(db), true);
    assert(getTableColumns(db, 'energy_balance_boundaries').includes('source_batch_id'));
    assert(getTableColumns(db, 'energy_balance_items').includes('source_row_number'));
    assert.deepStrictEqual(
      db.prepare('SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber FROM energy_balance_boundaries WHERE id = 1').get(),
      { sourceBatchId: null, sourceRowNumber: null }
    );
    db.prepare('UPDATE energy_balance_boundaries SET source_batch_id = 9, source_row_number = 3 WHERE id = 1').run();
    assert.throws(
      () => db.prepare('UPDATE energy_balance_boundaries SET source_row_number = NULL WHERE id = 1').run(),
      /energy balance boundary import source must contain batch and positive row together/
    );
    db.prepare('UPDATE energy_balance_boundaries SET source_batch_id = NULL, source_row_number = NULL WHERE id = 1').run();
    assert.throws(
      () => db.prepare('UPDATE energy_balance_boundaries SET source_batch_id = 9, source_row_number = 0 WHERE id = 1').run(),
      /energy balance boundary import source must contain batch and positive row together/
    );
    assert.strictEqual(migrateEnergyBalanceImportSourceColumns(db), false);
    const columns = getTableColumns(db, 'energy_balance_snapshot_items');
    assert(columns.includes('calculation_run_id'));
    assert(columns.includes('item_code'));
    assert(columns.includes('item_name'));
    const snapshotItem = db.prepare(`SELECT calculation_run_id AS calculationRunId,
        item_code AS itemCode, item_name AS itemName
      FROM energy_balance_snapshot_items WHERE id = 1`).get();
    assert.match(snapshotItem.calculationRunId, /^legacy-snapshot-/);
    assert.strictEqual(snapshotItem.itemCode, 'LEGACY-INPUT');
    assert.strictEqual(snapshotItem.itemName, '旧版输入项目');

    db.prepare(
      'UPDATE energy_balance_items SET item_code = ?, item_name = ? WHERE id = 1'
    ).run('MASTER-RENAMED', '主项目修改后名称');
    const frozenSnapshotItem = db.prepare(
      'SELECT item_code AS itemCode, item_name AS itemName FROM energy_balance_snapshot_items WHERE id = 1'
    ).get();
    assert.strictEqual(frozenSnapshotItem.itemCode, 'LEGACY-INPUT');
    assert.strictEqual(frozenSnapshotItem.itemName, '旧版输入项目');
    db.prepare('UPDATE energy_balance_boundaries SET source_batch_id = 9, source_row_number = 2 WHERE id = 1').run();
    db.prepare('UPDATE energy_balance_items SET source_batch_id = 9, source_row_number = 4 WHERE id = 1').run();
    assert.throws(
      () => db.prepare('UPDATE energy_balance_items SET source_row_number = 1.5 WHERE id = 1').run(),
      /energy balance item import source must contain batch and positive row together/
    );
    db.prepare('DELETE FROM import_batches WHERE id = 9').run();
    assert.deepStrictEqual(
      db.prepare('SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber FROM energy_balance_boundaries WHERE id = 1').get(),
      { sourceBatchId: null, sourceRowNumber: null }
    );
    assert.deepStrictEqual(
      db.prepare('SELECT source_batch_id AS sourceBatchId, source_row_number AS sourceRowNumber FROM energy_balance_items WHERE id = 1').get(),
      { sourceBatchId: null, sourceRowNumber: null }
    );
    assert.throws(
      () => db.prepare(
        'UPDATE energy_balance_snapshot_items SET item_name = ? WHERE id = 1'
      ).run('非法改写历史名称'),
      /energy balance snapshot item identity immutable/
    );
    assert.strictEqual(migrateEnergyBalanceCalculationRuns(db), false);
    assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
  assertCanonicalInitializationMigration();
  assertCanonicalInitializationRejectsUnrelatedSchemaDrift();
  assertCanonicalInitializationRejectsForgedMetadataFingerprint();
  assertCanonicalInitializationRollsBackMigrationFailure();
  console.log('energyBalanceSnapshotIdentityMigration tests passed');
}

try {
  run();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
