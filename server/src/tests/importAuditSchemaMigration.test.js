const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-import-audit-schema-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'import-audit-schema.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const {
  IMPORT_BATCH_TYPES,
  buildImportBatchesImportTypeMigrationSql,
  getDatabaseInfo,
  getTableColumns,
  importBatchesHasAuditColumns,
  importBatchesImportTypeCheckAllowsAuditTypes,
  initDatabase,
  migrateImportBatchesImportTypeCheck,
  openDatabase
} = require('../db/database');

function getCreateSql(db, tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName).sql;
}

function getIndexNames(db, tableName) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(tableName).map((row) => row.name);
}

try {
  initDatabase();
  assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, 'Schema 迁移测试必须使用隔离 SQLite 文件。');

  const expectedConfigurationImportTypes = Object.freeze([
    'shift_definition',
    'tou_scheme',
    'strategy_rule',
    'energy_flow_model',
    'energy_balance_boundary',
    'energy_balance_item'
  ]);
  expectedConfigurationImportTypes.forEach((importType) => {
    assert(IMPORT_BATCH_TYPES.includes(importType), `统一 import type 白名单缺少 ${importType}。`);
  });

  const newDb = openDatabase();
  let productionUnitId;
  let organizationUnitId;
  let photovoltaicId;
  try {
    const importBatchCreateSql = getCreateSql(newDb, 'import_batches');
    assert(importBatchesImportTypeCheckAllowsAuditTypes(importBatchCreateSql), '新库 import_batches.import_type CHECK 应允许 production_output/generation_record。');
    assert(importBatchesHasAuditColumns(getTableColumns(newDb, 'import_batches')), '新库 import_batches 应包含审计字段。');
    ['audit_phase', 'preview_signature', 'preview_audit_digest', 'audit_context_json', 'execute_result_json', 'backup_json'].forEach((columnName) => {
      assert(getTableColumns(newDb, 'import_batches').includes(columnName), `新库 import_batches 缺少 ${columnName}。`);
    });
    assert(getTableColumns(newDb, 'production_units').includes('source_batch_id'), '新库 production_units 应包含 source_batch_id。');
    assert(getTableColumns(newDb, 'production_units').includes('source_row_number'), '新库 production_units 应包含 source_row_number。');
    assert(getTableColumns(newDb, 'production_output_records').includes('source_batch_id'), '新库 production_output_records 应包含 source_batch_id。');
    assert(getTableColumns(newDb, 'production_output_records').includes('source_row_number'), '新库 production_output_records 应包含 source_row_number。');
    assert(getTableColumns(newDb, 'generation_records').includes('source_batch_id'), '新库 generation_records 应包含 source_batch_id。');
    assert(getTableColumns(newDb, 'generation_records').includes('source_row_number'), '新库 generation_records 应包含 source_row_number。');
    assert(getIndexNames(newDb, 'production_units').includes('idx_production_units_batch'), '新库应创建 production unit source batch 索引。');
    assert(getIndexNames(newDb, 'production_output_records').includes('idx_production_output_records_batch'), '新库应创建 production source batch 索引。');
    assert(getIndexNames(newDb, 'generation_records').includes('idx_generation_records_batch'), '新库应创建 generation source batch 索引。');

    newDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type, status, audit_phase, preview_signature, preview_audit_digest, audit_context_json, execute_result_json, backup_json, total_rows, success_count, failure_count, skipped_count) VALUES ('production_output', 'production.xlsx', 'xlsx', 'completed', 'execute', 'sig', 'digest', '{\"phase\":\"preview\"}', '{\"imported\":1}', '{\"backupName\":\"b1\"}', 1, 1, 0, 0)").run();
    newDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type, status, audit_phase, total_rows, success_count, failure_count, skipped_count) VALUES ('generation_record', 'generation.csv', 'csv', 'completed_with_errors', 'preview', 2, 1, 0, 1)").run();
    expectedConfigurationImportTypes.forEach((importType) => {
      newDb.prepare('INSERT INTO import_batches (import_type, original_filename, file_type) VALUES (?, ?, ?)')
        .run(importType, `${importType}.xlsx`, 'xlsx');
    });
    assert.strictEqual(
      newDb.prepare(`SELECT COUNT(*) AS total FROM import_batches WHERE import_type IN (${expectedConfigurationImportTypes.map(() => '?').join(', ')})`).get(...expectedConfigurationImportTypes).total,
      expectedConfigurationImportTypes.length,
      '新库 CHECK 必须允许六类配置导入批次。'
    );
    assert.throws(
      () => newDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type) VALUES ('bad_type', 'bad.csv', 'csv')").run(),
      /CHECK constraint failed/,
      '非法 import_type 仍应被 CHECK 拦截。'
    );

    organizationUnitId = newDb.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('AUD-OU-NEW', '审计新库单元', '审计新库单元', 'enterprise', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    productionUnitId = newDb.prepare("INSERT INTO production_units (unit_code, unit_name, organization_unit_id, product_name, output_unit, status, created_at, updated_at) VALUES ('AUD-PU-NEW', '审计产能单元', ?, '产品A', 't', 'active', datetime('now'), datetime('now'))").run(organizationUnitId).lastInsertRowid;
    photovoltaicId = newDb.prepare("SELECT id FROM energy_types WHERE code = 'photovoltaic'").get().id;

    newDb.prepare("INSERT INTO production_output_records (production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, created_at, updated_at) VALUES (?, '2026-01', 10, 't', 'manual', 'active', datetime('now'), datetime('now'))").run(productionUnitId);
    const productionBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'production_output' LIMIT 1").get().id;
    newDb.prepare("INSERT INTO production_output_records (source_batch_id, source_row_number, production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, created_at, updated_at) VALUES (?, 2, ?, '2026-02', 12, 't', 'upload', 'active', datetime('now'), datetime('now'))").run(productionBatchId, productionUnitId);
    assert.throws(
      () => newDb.prepare("INSERT INTO production_output_records (source_batch_id, source_row_number, production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, created_at, updated_at) VALUES (?, 0, ?, '2026-03', 12, 't', 'upload', 'active', datetime('now'), datetime('now'))").run(productionBatchId, productionUnitId),
      /CHECK constraint failed/,
      'production source_row_number 小于 1 应被 CHECK 拦截。'
    );

    newDb.prepare("INSERT INTO generation_records (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, created_at, updated_at) VALUES (?, ?, '2026-01', 100, 80, 20, 'manual', 'active', datetime('now'), datetime('now'))").run(organizationUnitId, photovoltaicId);
    const generationBatchId = newDb.prepare("SELECT id FROM import_batches WHERE import_type = 'generation_record' LIMIT 1").get().id;
    newDb.prepare("INSERT INTO generation_records (source_batch_id, source_row_number, organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, created_at, updated_at) VALUES (?, 3, ?, ?, '2026-02', 120, 90, 30, 'upload', 'active', datetime('now'), datetime('now'))").run(generationBatchId, organizationUnitId, photovoltaicId);
    assert.throws(
      () => newDb.prepare("INSERT INTO generation_records (source_batch_id, source_row_number, organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, created_at, updated_at) VALUES (?, 0, ?, ?, '2026-03', 120, 90, 30, 'upload', 'active', datetime('now'), datetime('now'))").run(generationBatchId, organizationUnitId, photovoltaicId),
      /CHECK constraint failed/,
      'generation source_row_number 小于 1 应被 CHECK 拦截。'
    );
  } finally {
    newDb.close();
  }

  const legacyDb = openDatabase();
  let legacyProductionUnitId;
  let legacyOrganizationUnitId;
  let legacyPhotovoltaicId;
  try {
    legacyDb.pragma('foreign_keys = OFF');
    legacyDb.exec('DROP TABLE IF EXISTS import_errors');
    legacyDb.exec('DROP TABLE IF EXISTS import_batches');
    legacyDb.exec(`CREATE TABLE import_batches (
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
    )`);
    legacyDb.prepare("INSERT INTO import_batches (import_type, original_filename, stored_filename, file_type, file_size_bytes, file_sha256, status, total_rows, success_count, failure_count, skipped_count, duplicate_strategy, field_mapping_json, error_summary) VALUES ('energy_record', 'legacy-energy.xlsx', 'legacy-energy-stored.xlsx', 'xlsx', 123, 'sha-legacy', 'completed_with_errors', 3, 1, 1, 1, 'skip', '{\"a\":1}', '旧批次保留')").run();
    legacyDb.exec(`CREATE TABLE import_errors (
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
    )`);
    legacyDb.prepare("INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (1, 2, 'energyType', '煤', 'LEGACY_ERROR_RETAINED', '旧批次错误明细应在 import_batches 重建后保留。', 'warning')").run();
    legacyDb.exec('DROP TABLE IF EXISTS production_output_records');
    legacyDb.exec('DROP TABLE IF EXISTS generation_records');
    legacyDb.exec('DROP TABLE IF EXISTS production_units');
    legacyDb.exec(`CREATE TABLE production_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_code TEXT NOT NULL UNIQUE,
      unit_name TEXT NOT NULL,
      organization_unit_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      output_unit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_production_units_org_status ON production_units(organization_unit_id, status);
    CREATE INDEX idx_production_units_product_status ON production_units(product_name, status);`);
    legacyOrganizationUnitId = legacyDb.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('AUD-OU-LEGACY', '审计旧库单元', '审计旧库单元', 'enterprise', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    legacyProductionUnitId = legacyDb.prepare("INSERT INTO production_units (unit_code, unit_name, organization_unit_id, product_name, output_unit, status, remark, created_at, updated_at) VALUES ('AUD-PU-LEGACY', '审计旧库产能单元', ?, '产品B', '件', 'active', '旧产能单元保留', datetime('now'), datetime('now'))").run(legacyOrganizationUnitId).lastInsertRowid;
    legacyPhotovoltaicId = legacyDb.prepare("SELECT id FROM energy_types WHERE code = 'photovoltaic'").get().id;
    legacyDb.exec(`CREATE TABLE production_output_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      production_unit_id INTEGER NOT NULL,
      normalized_month TEXT NOT NULL CHECK (normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12),
      output_value REAL NOT NULL CHECK (output_value > 0),
      output_unit TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'upload', 'calculation')),
      record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (production_unit_id) REFERENCES production_units(id) ON DELETE RESTRICT
    )`);
    legacyDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_production_output_records_active_unit_month ON production_output_records(production_unit_id, normalized_month) WHERE record_status = 'active'");
    legacyDb.prepare("INSERT INTO production_output_records (production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, remark, created_at, updated_at) VALUES (?, '2026-04', 5, '件', 'manual', 'active', '旧产量保留', datetime('now'), datetime('now'))").run(legacyProductionUnitId);
    legacyDb.exec(`CREATE TABLE generation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_unit_id INTEGER NOT NULL,
      energy_type_id INTEGER NOT NULL,
      normalized_month TEXT NOT NULL CHECK (normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12),
      generation_value_kwh REAL NOT NULL CHECK (generation_value_kwh >= 0),
      self_use_value_kwh REAL NOT NULL DEFAULT 0 CHECK (self_use_value_kwh >= 0),
      grid_export_value_kwh REAL NOT NULL DEFAULT 0 CHECK (grid_export_value_kwh >= 0),
      data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'calculation')),
      record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
      remark TEXT,
      void_reason TEXT,
      voided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT,
      FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
      CHECK (self_use_value_kwh + grid_export_value_kwh <= generation_value_kwh + 0.000001)
    )`);
    legacyDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_active_org_month_energy ON generation_records(organization_unit_id, normalized_month, energy_type_id) WHERE record_status = 'active'");
    legacyDb.prepare("INSERT INTO generation_records (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, '2026-04', 50, 30, 20, 'manual', 'active', '旧发电保留', datetime('now'), datetime('now'))").run(legacyOrganizationUnitId, legacyPhotovoltaicId);
    legacyDb.pragma('foreign_keys = ON');
  } finally {
    legacyDb.close();
  }

  initDatabase();
  initDatabase();

  const upgradedDb = openDatabase();
  try {
    assert(importBatchesImportTypeCheckAllowsAuditTypes(getCreateSql(upgradedDb, 'import_batches')), '旧库 import_type CHECK 应升级到 production/generation 新类型。');
    assert(importBatchesHasAuditColumns(getTableColumns(upgradedDb, 'import_batches')), '旧库升级后应包含审计字段。');
    const legacyBatch = upgradedDb.prepare("SELECT * FROM import_batches WHERE original_filename = 'legacy-energy.xlsx'").get();
    assert(legacyBatch, '旧 import_batches 数据应保留。');
    assert.strictEqual(legacyBatch.import_type, 'energy_record');
    assert.strictEqual(legacyBatch.status, 'completed_with_errors');
    assert.strictEqual(legacyBatch.audit_phase, null, '旧批次新增 audit_phase 默认 NULL。');
    assert.strictEqual(legacyBatch.backup_json, null, '旧批次新增 backup_json 默认 NULL。');
    const retainedLegacyError = upgradedDb.prepare("SELECT * FROM import_errors WHERE batch_id = ? AND error_code = 'LEGACY_ERROR_RETAINED'").get(legacyBatch.id);
    assert(retainedLegacyError, 'import_batches 重建后既有 import_errors 明细应保留。');
    assert.strictEqual(retainedLegacyError.severity, 'warning');
    const productionBatchId = upgradedDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type, status, audit_phase, total_rows, success_count, failure_count, skipped_count) VALUES ('production_output', 'legacy-production.csv', 'csv', 'completed', 'execute', 1, 1, 0, 0)").run().lastInsertRowid;
    const generationBatchId = upgradedDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type, status, audit_phase, total_rows, success_count, failure_count, skipped_count) VALUES ('generation_record', 'legacy-generation.csv', 'csv', 'completed', 'execute', 1, 1, 0, 0)").run().lastInsertRowid;
    expectedConfigurationImportTypes.forEach((importType) => {
      upgradedDb.prepare('INSERT INTO import_batches (import_type, original_filename, file_type) VALUES (?, ?, ?)')
        .run(importType, `legacy-${importType}.xlsx`, 'xlsx');
    });
    assert.strictEqual(
      upgradedDb.prepare(`SELECT COUNT(*) AS total FROM import_batches WHERE import_type IN (${expectedConfigurationImportTypes.map(() => '?').join(', ')})`).get(...expectedConfigurationImportTypes).total,
      expectedConfigurationImportTypes.length,
      '旧库迁移后 CHECK 必须允许六类配置导入批次。'
    );
    assert.strictEqual(migrateImportBatchesImportTypeCheck(upgradedDb), false, '升级完成后再次执行 import type 迁移必须幂等。');
    assert(getTableColumns(upgradedDb, 'production_units').includes('source_batch_id'), '旧 production_units 应补充 source_batch_id。');
    assert(getTableColumns(upgradedDb, 'production_units').includes('source_row_number'), '旧 production_units 应补充 source_row_number。');
    assert.strictEqual(upgradedDb.prepare("SELECT COUNT(*) AS total FROM production_units WHERE remark = '旧产能单元保留' AND source_batch_id IS NULL AND source_row_number IS NULL").get().total, 1, '旧 production_units 数据应保留且 source 默认 NULL。');
    assert.strictEqual(upgradedDb.prepare("SELECT COUNT(*) AS total FROM production_output_records WHERE remark = '旧产量保留' AND source_batch_id IS NULL AND source_row_number IS NULL").get().total, 1, '旧 production_output_records 应保留且 source 默认 NULL。');
    assert.strictEqual(upgradedDb.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE remark = '旧发电保留' AND source_batch_id IS NULL AND source_row_number IS NULL").get().total, 1, '旧 generation_records 应保留且 source 默认 NULL。');
    upgradedDb.prepare("INSERT INTO production_output_records (source_batch_id, source_row_number, production_unit_id, normalized_month, output_value, output_unit, data_source, record_status, created_at, updated_at) VALUES (?, 8, ?, '2026-05', 6, '件', 'upload', 'active', datetime('now'), datetime('now'))").run(productionBatchId, legacyProductionUnitId);
    upgradedDb.prepare("INSERT INTO generation_records (source_batch_id, source_row_number, organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, created_at, updated_at) VALUES (?, 9, ?, ?, '2026-05', 70, 50, 20, 'upload', 'active', datetime('now'), datetime('now'))").run(generationBatchId, legacyOrganizationUnitId, legacyPhotovoltaicId);
    assert(getIndexNames(upgradedDb, 'import_batches').includes('idx_import_batches_type_status_created'), '重建 import_batches 后应保留 type/status 索引。');
    assert(getIndexNames(upgradedDb, 'production_units').includes('idx_production_units_batch'), '旧库升级后应在补列后创建 production unit source batch 索引。');
    assert(getIndexNames(upgradedDb, 'production_output_records').includes('idx_production_output_records_batch'), '旧库升级后应创建 production source batch 索引。');
    assert(getIndexNames(upgradedDb, 'generation_records').includes('idx_generation_records_batch'), '旧库升级后应创建 generation source batch 索引。');
    assert.deepStrictEqual(upgradedDb.prepare('PRAGMA foreign_key_check').all(), [], '隔离库升级后 foreign_key_check 应通过。');
  } finally {
    upgradedDb.close();
  }

  assert(buildImportBatchesImportTypeMigrationSql().some((sql) => sql.includes("'production_output'")), '旧库迁移 SQL 应扩展 production_output。');
  assert(buildImportBatchesImportTypeMigrationSql().some((sql) => sql.includes("'generation_record'")), '旧库迁移 SQL 应扩展 generation_record。');
  expectedConfigurationImportTypes.forEach((importType) => {
    assert(
      buildImportBatchesImportTypeMigrationSql().some((sql) => sql.includes(`'${importType}'`)),
      `旧库迁移 SQL 应扩展 ${importType}。`
    );
  });

  const rollbackDbPath = path.join(tmpDir, 'rollback-check.sqlite');
  const rollbackDb = new Database(rollbackDbPath);
  try {
    rollbackDb.pragma('foreign_keys = ON');
    rollbackDb.exec(`CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL,
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
    )`);
    rollbackDb.prepare("INSERT INTO import_batches (import_type, original_filename, file_type, status, total_rows, success_count, failure_count, skipped_count) VALUES ('legacy_bad_type', 'bad.csv', 'csv', 'completed', 1, 1, 0, 0)").run();
    assert.throws(
      () => migrateImportBatchesImportTypeCheck(rollbackDb),
      /CHECK constraint failed/,
      '非法旧 import_type 应导致重建失败并触发事务回滚。'
    );
    assert.strictEqual(rollbackDb.prepare("SELECT COUNT(*) AS total FROM import_batches WHERE import_type = 'legacy_bad_type'").get().total, 1, '迁移失败后旧 import_batches 数据应仍保留。');
    assert(!getTableColumns(rollbackDb, 'import_batches').includes('audit_phase'), '迁移失败后不应半新增 audit_phase 列。');
    assert.strictEqual(rollbackDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'import_batches__migration_new'").get().total, 0, '迁移失败后临时表不应残留。');
    assert.strictEqual(rollbackDb.pragma('foreign_keys', { simple: true }), 1, '迁移失败后应恢复 foreign_keys。');
  } finally {
    rollbackDb.close();
  }

  console.log('import audit schema migration tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
