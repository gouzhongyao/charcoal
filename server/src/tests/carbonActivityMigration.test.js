'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据库迁移测试始终使用隔离临时目录，禁止接触正式 data。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-activity-schema-'));
const databasePath = path.join(temporaryRoot, 'carbon-activity.sqlite');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.SQLITE_PATH = databasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const {
  IMPORT_BATCH_TYPES,
  ensureCarbonActivityTables,
  initDatabase,
  openDatabase
} = require('../db/database');

// N5-A 冻结的新表和关键索引。
const EXPECTED_TABLES = Object.freeze([
  'carbon_activity_records',
  'carbon_calculation_runs',
  'carbon_accounting_results'
]);
const EXPECTED_INDEXES = Object.freeze([
  'ux_carbon_activity_records_active_duplicate',
  'idx_carbon_activity_records_scope_range',
  'idx_carbon_activity_records_org_energy_range',
  'idx_carbon_activity_records_batch',
  'idx_carbon_activity_records_supersedes',
  'idx_carbon_calculation_runs_status_created',
  'idx_carbon_accounting_results_activity',
  'idx_carbon_accounting_results_run_status'
]);

/** 读取 SQLite 对象是否存在。 */
function sqliteObjectExists(db, type, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name));
}

/** 断言写入被数据库约束拒绝。 */
function assertConstraintFailure(action, message) {
  assert.throws(action, /(CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed)/, message);
}

try {
  initDatabase({ databasePath });
  let db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => {
      assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true, `${tableName} 必须存在。`);
    });
    EXPECTED_INDEXES.forEach((indexName) => {
      assert.strictEqual(sqliteObjectExists(db, 'index', indexName), true, `${indexName} 必须存在。`);
    });
    assert(IMPORT_BATCH_TYPES.includes('carbon_activity'), '数据库导入类型必须包含 carbon_activity。');
    const importBatchSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'").get().sql;
    assert(importBatchSql.includes("'carbon_activity'"), '新库 import_batches CHECK 必须允许 carbon_activity。');

    const functionRow = db.prepare("SELECT name, flags FROM pragma_function_list WHERE name = 'is_strict_wall_clock_minute'").get();
    assert(functionRow, '必须注册 is_strict_wall_clock_minute UDF。');
    assert((Number(functionRow.flags) & 0x800) === 0x800, '墙钟 UDF 必须标记 deterministic。');
    assert.strictEqual(db.prepare("SELECT is_strict_wall_clock_minute('2026-02-28T09:05') AS valid").get().valid, 1);
    assert.strictEqual(db.prepare("SELECT is_strict_wall_clock_minute('2026-02-29T09:05') AS valid").get().valid, 0);

    const organizationUnitId = db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('CA-OU-001', '碳活动测试单元', '/CA-OU-001', 'department', 'active')`).run().lastInsertRowid;
    const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const batchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_activity', 'carbon.xlsx', 'isolated-carbon.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const insertActivity = db.prepare(`INSERT INTO carbon_activity_records
      (source_type, source_batch_id, source_row_number, activity_code, activity_code_key,
       emission_scope, activity_category, activity_category_key, organization_unit_id,
       energy_type_id, start_wall_clock, end_wall_clock, source_timezone, start_utc,
       end_utc, activity_value, activity_unit, factor_region, source_reference,
       duplicate_key, record_status)
      VALUES ('independent_activity', ?, 2, 'CA-001', 'CA-001', 'scope_1', '购入电力',
       '购入电力', ?, ?, '2026-08-24T09:00', '2026-08-24T10:00', 'Asia/Shanghai',
       '2026-08-24T01:00:00Z', '2026-08-24T02:00:00Z', 10, 'kWh', 'default',
       'meter-001', ?, 'active')`);
    insertActivity.run(batchId, organizationUnitId, energyTypeId, 'a'.repeat(64));
    assertConstraintFailure(
      () => insertActivity.run(batchId, organizationUnitId, energyTypeId, 'a'.repeat(64)),
      'active duplicate_key 必须唯一。'
    );
    assertConstraintFailure(() => db.prepare(`INSERT INTO carbon_activity_records
      (source_type, activity_code, activity_code_key, emission_scope, activity_category,
       activity_category_key, organization_unit_id, energy_type_id, start_wall_clock,
       end_wall_clock, source_timezone, start_utc, end_utc, activity_value, activity_unit,
       source_reference, duplicate_key, record_status)
      VALUES ('independent_activity', 'CA-INVALID', 'CA-INVALID', 'scope_1', '测试', '测试',
       ?, ?, '2026-08-24T09:00:00', '2026-08-24T10:00', 'Asia/Shanghai',
       '2026-08-24T01:00:00Z', '2026-08-24T02:00:00Z', 1, 'kWh', 'source', ?, 'active')`)
      .run(organizationUnitId, energyTypeId, 'b'.repeat(64)), '带秒墙钟必须被 CHECK 拒绝。');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '新库外键检查必须为空。');
  } finally {
    db.close();
  }

  // 正式 canonical 库缺失 N5 表时必须按 fingerprint fail-closed，不再自动补建历史结构。
  db = openDatabase({ databasePath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE carbon_accounting_results;
      DROP TABLE carbon_calculation_runs;
      DROP TABLE carbon_activity_records;`);
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(sqliteObjectExists(db, 'table', tableName), false));
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'carbon_emissions'").get().total, 1);
  } finally {
    db.close();
  }

  // 独立确保函数在不完整片段失败时必须整体回滚，不留下第一张临时业务表。
  const rollbackPath = path.join(temporaryRoot, 'rollback.sqlite');
  db = openDatabase({ databasePath: rollbackPath });
  try {
    const invalidSchema = `-- CARBON_ACTIVITY_SCHEMA_START
      CREATE TABLE carbon_activity_records (id INTEGER PRIMARY KEY);
      CREATE TABLE broken_carbon_activity_table (
    -- CARBON_ACTIVITY_SCHEMA_END`;
    assert.throws(() => ensureCarbonActivityTables(db, invalidSchema));
    assert.strictEqual(sqliteObjectExists(db, 'table', 'carbon_activity_records'), false, '失败迁移必须回滚已创建表。');
  } finally {
    db.close();
  }

  console.log('carbonActivityMigration tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
