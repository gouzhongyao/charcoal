'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 正式 schema 入场测试只使用隔离 SQLite，禁止访问项目正式数据目录。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-supplier-migration-'));
process.env.DATA_DIR = path.join(tempDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'supplier-migration.sqlite');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tempDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'SupplierMigration123!';

const { initDatabase, openDatabase } = require('../db/database');

try {
  // 新库必须直接创建供应商 canonical 结构，并允许重复初始化。
  initDatabase();
  initDatabase();
  let db = openDatabase();
  try {
    const supplierSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'").get()?.sql || '';
    assert.match(supplierSql, /supplier_code_key TEXT NOT NULL UNIQUE/i);
    assert.match(supplierSql, /contact_phone TEXT/i);
    assert.match(supplierSql, /ON DELETE SET NULL/i);
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 已登记正式库出现旧供应商结构时必须按 fingerprint fail-closed，不再自动清洗或迁移。
  db = openDatabase();
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE suppliers;
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_code TEXT NOT NULL UNIQUE,
        supplier_name TEXT NOT NULL,
        contact_phone TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        source_batch_id INTEGER,
        source_row_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
      );`);
    db.prepare("INSERT INTO suppliers (supplier_code, supplier_name, contact_phone) VALUES ('  Sup-Legacy  ', '旧供应商', '0010-20')").run();
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }

  assert.throws(
    () => initDatabase(),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase();
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('suppliers') ORDER BY cid").all().map((column) => column.name);
    assert.strictEqual(columns.includes('supplier_code_key'), false, 'fail-closed 初始化不得改写旧供应商结构。');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM suppliers').get().total, 1, 'fail-closed 初始化不得删除旧供应商数据。');
    assert.strictEqual(db.prepare('SELECT supplier_code AS supplierCode FROM suppliers').get().supplierCode, '  Sup-Legacy  ');
  } finally {
    db.close();
  }

  console.log('供应商 canonical 新库与旧结构 fingerprint 拒绝测试通过。');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
