'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 旧库迁移测试使用隔离 SQLite，并连续执行两次验证幂等性。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-supplier-migration-'));
process.env.DATA_DIR = path.join(tempDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'supplier-migration.sqlite');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tempDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'SupplierMigration123!';

const { initDatabase, openDatabase } = require('../db/database');

try {
  initDatabase();
  let db = openDatabase();
  try {
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS suppliers; DROP TABLE IF EXISTS import_errors; DROP TABLE IF EXISTS import_batches;');
    db.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading')),
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
      file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
      file_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
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
    );
    CREATE TABLE import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      error_code TEXT NOT NULL,
      error_reason TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
    );
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_code TEXT NOT NULL UNIQUE,
      supplier_name TEXT NOT NULL,
      address TEXT,
      contact_person TEXT,
      contact_phone TEXT,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      source_batch_id INTEGER,
      source_row_number INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
    );`);
    db.prepare("INSERT INTO import_batches (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count) VALUES ('energy_record', '旧批次.xlsx', 'legacy.xlsx', 'xlsx', 'completed', 1, 1)").run();
    db.prepare("INSERT INTO import_errors (batch_id, row_number, error_code, error_reason, severity) VALUES (1, 2, 'LEGACY_WARNING', '旧问题保留', 'warning')").run();
    db.prepare("INSERT INTO suppliers (supplier_code, supplier_name, contact_phone, status, source_batch_id, source_row_number) VALUES ('  Sup-Legacy  ', '迁移供应商', '0010-20', 'active', 1, 2)").run();
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }

  initDatabase();
  initDatabase();
  db = openDatabase();
  try {
    const supplierSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'").get()?.sql || '';
    assert.match(supplierSql, /contact_phone TEXT/i);
    assert.match(supplierSql, /supplier_code_key TEXT NOT NULL UNIQUE/i);
    assert.match(supplierSql, /status IN \('active', 'inactive'\)/i);
    assert.match(supplierSql, /ON DELETE SET NULL/i);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE id = 1').get().total, 1, '旧批次必须保留。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM import_errors WHERE error_code = 'LEGACY_WARNING'").get().total, 1, '旧问题必须保留。');
    const migratedSupplier = db.prepare("SELECT supplier_code AS supplierCode, supplier_code_key AS supplierCodeKey, contact_phone AS phone, source_batch_id AS batchId FROM suppliers WHERE id = 1").get();
    assert.deepStrictEqual(migratedSupplier, {
      supplierCode: 'Sup-Legacy',
      supplierCodeKey: 'SUP-LEGACY',
      phone: '0010-20',
      batchId: 1
    }, '旧库迁移必须清理显示编码首尾空白并生成规范键。');
    const supplierBatchId = Number(db.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES ('supplier', '供应商.xlsx', 'xlsx')").run().lastInsertRowid);
    assert.throws(
      () => db.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES ('bad_supplier_type', '非法.xlsx', 'xlsx')").run(),
      /CHECK constraint failed/
    );
    db.prepare("INSERT INTO suppliers (supplier_code, supplier_code_key, supplier_name, contact_phone, status, source_batch_id, source_row_number) VALUES ('SUP-BATCH', 'SUP-BATCH', '批次来源供应商', '+0010', 'active', ?, 2)").run(supplierBatchId);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(supplierBatchId);
    const retainedSupplier = db.prepare("SELECT source_batch_id AS batchId FROM suppliers WHERE supplier_code_key = 'SUP-BATCH'").get();
    assert.deepStrictEqual(retainedSupplier, { batchId: null }, '来源批次删除后供应商必须保留且来源批次置空。');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '供应商迁移和 SET NULL 后外键检查必须通过。');
    const ordinaryGrantCount = db.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
      JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
      WHERE r.role_code = 'user' AND m.permission_code LIKE 'ledger:suppliers:%'`).get().total;
    assert.strictEqual(ordinaryGrantCount, 0, '旧库迁移不得给普通角色自动扩权。');
  } finally {
    db.close();
  }

  // 只有完整单列唯一约束才算满足规范键结构，部分唯一索引必须触发安全重建。
  db = openDatabase();
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE suppliers;
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_code TEXT NOT NULL,
        supplier_code_key TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        address TEXT,
        contact_person TEXT,
        contact_phone TEXT,
        remarks TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        source_batch_id INTEGER,
        source_row_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX ux_suppliers_code_key_partial
        ON suppliers(supplier_code_key) WHERE status = 'active';`);
    db.prepare("INSERT INTO suppliers (supplier_code, supplier_code_key, supplier_name, status) VALUES ('Sup-Partial', 'SUP-PARTIAL', '部分索引供应商', 'active')").run();
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
  initDatabase();
  db = openDatabase();
  try {
    const uniqueIndexes = db.prepare("SELECT name, partial FROM pragma_index_list('suppliers') WHERE [unique] = 1").all();
    assert(uniqueIndexes.some((indexRow) => {
      if (Number(indexRow.partial || 0) !== 0) return false;
      const columns = db.prepare(`SELECT name FROM pragma_index_info('${String(indexRow.name).replace(/'/g, "''")}') ORDER BY seqno`).all();
      return columns.length === 1 && columns[0].name === 'supplier_code_key';
    }), '部分唯一索引必须重建为完整 supplier_code_key 单列唯一约束。');
    assert.strictEqual(db.prepare("SELECT supplier_code AS supplierCode FROM suppliers WHERE supplier_code_key = 'SUP-PARTIAL'").get().supplierCode, 'Sup-Partial');
  } finally {
    db.close();
  }

  // 历史大小写或 NFKC 碰撞必须 fail-closed，失败事务不得覆盖或合并旧数据。
  db = openDatabase();
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE suppliers;
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_code TEXT NOT NULL UNIQUE,
        supplier_name TEXT NOT NULL,
        address TEXT,
        contact_person TEXT,
        contact_phone TEXT,
        remarks TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        source_batch_id INTEGER,
        source_row_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
      );`);
    const insertLegacySupplier = db.prepare("INSERT INTO suppliers (supplier_code, supplier_name) VALUES (?, ?)");
    insertLegacySupplier.run('SUP-CASE', '规范编码一');
    insertLegacySupplier.run('ＳＵＰ-CASE', '规范编码二');
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase(),
    (error) => error.code === 'SUPPLIER_CODE_KEY_MIGRATION_CONFLICT'
      && error.details?.supplierCodeKey === 'SUP-CASE'
  );
  db = openDatabase();
  try {
    const collisionColumns = db.prepare("SELECT name FROM pragma_table_info('suppliers') ORDER BY cid").all().map((column) => column.name);
    assert.strictEqual(collisionColumns.includes('supplier_code_key'), false, '碰撞失败必须回滚表重建。');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM suppliers').get().total, 2, '碰撞失败必须保留全部历史供应商。');
  } finally {
    db.close();
  }

  console.log('供应商旧库幂等迁移、SET NULL 和规范键碰撞测试通过。');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
