const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-production-unit-schema-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'production-unit-legacy.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { getTableColumns, initDatabase, openDatabase } = require('../db/database');

try {
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const legacyDb = new Database(process.env.SQLITE_PATH);
  try {
    legacyDb.pragma('foreign_keys = OFF');
    legacyDb.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_output', 'generation_record', 'energy_budget', 'carbon_factor')),
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
      file_size_bytes INTEGER,
      file_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      audit_phase TEXT,
      preview_signature TEXT,
      preview_audit_digest TEXT,
      audit_context_json TEXT,
      execute_result_json TEXT,
      backup_json TEXT,
      total_rows INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      duplicate_strategy TEXT NOT NULL DEFAULT 'skip',
      field_mapping_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      error_summary TEXT
    );
    CREATE TABLE organization_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      unit_code TEXT NOT NULL UNIQUE,
      unit_name TEXT NOT NULL,
      unit_path TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      area REAL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (parent_id) REFERENCES organization_units(id) ON DELETE RESTRICT
    );
    CREATE TABLE production_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_code TEXT NOT NULL UNIQUE,
      unit_name TEXT NOT NULL,
      organization_unit_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      output_unit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      remark TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT
    );`);
    const organizationUnitId = legacyDb.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status) VALUES ('LEGACY-ORG', '旧用能单元', '旧用能单元', 'enterprise', 'active')").run().lastInsertRowid;
    legacyDb.prepare("INSERT INTO production_units (unit_code, unit_name, organization_unit_id, product_name, output_unit, status, remark) VALUES ('LEGACY-PU', '旧产能单元', ?, '旧产品', 't', 'active', '迁移保留')").run(organizationUnitId);
  } finally {
    legacyDb.close();
  }

  assert.throws(
    () => initDatabase(),
    (error) => error?.code === 'UNKNOWN_EXISTING_SCHEMA'
  );
  const db = openDatabase();
  try {
    assert.strictEqual(getTableColumns(db, 'production_units').includes('source_batch_id'), false,
      '未知旧库被拒绝时不得自动补充来源字段。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM production_units WHERE unit_code = 'LEGACY-PU'").get().total, 1,
      '未知旧库被拒绝时不得删除旧产能单元。');
  } finally {
    db.close();
  }
  console.log('production unit unknown schema rejection tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
