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

const {
  getTableColumns,
  migrateEnergyBalanceCalculationRuns,
  openDatabase
} = require('../db/database');

/**
 * 创建未包含计算运行和冻结标识列的旧版平衡最小结构。
 * @param {object} db SQLite 数据库连接。
 */
function createLegacyBalanceSchema(db) {
  db.exec(`
    CREATE TABLE sys_users (id INTEGER PRIMARY KEY);
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

/** 运行旧库补列、回填、幂等和不可变约束验证。 */
function run() {
  const db = openDatabase();
  try {
    createLegacyBalanceSchema(db);
    insertLegacyFixture(db);
    assert.strictEqual(migrateEnergyBalanceCalculationRuns(db), true);
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
    assert.throws(
      () => db.prepare(
        'UPDATE energy_balance_snapshot_items SET item_name = ? WHERE id = 1'
      ).run('非法改写历史名称'),
      /energy balance snapshot item identity immutable/
    );
    assert.strictEqual(migrateEnergyBalanceCalculationRuns(db), false);
    assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
    console.log('energyBalanceSnapshotIdentityMigration tests passed');
  } finally {
    db.close();
  }
}

try {
  run();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
