'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-emission-report-schema-'));
const databasePath = path.join(temporaryRoot, 'carbon-emission-report.sqlite');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.SQLITE_PATH = databasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const {
  IMPORT_BATCH_TYPES,
  ensureCarbonEmissionReportTables,
  initDatabase,
  openDatabase
} = require('../db/database');

const EXPECTED_TABLES = Object.freeze([
  'carbon_emission_reports',
  'carbon_emission_report_boundaries',
  'carbon_emission_report_evidence',
  'carbon_emission_report_items',
  'carbon_emission_report_summaries'
]);
const EXPECTED_INDEXES = Object.freeze([
  'idx_carbon_emission_reports_period',
  'idx_carbon_emission_reports_organization',
  'idx_carbon_emission_reports_batch',
  'idx_carbon_emission_report_boundaries_report',
  'idx_carbon_emission_report_evidence_report',
  'idx_carbon_emission_report_items_filters',
  'idx_carbon_emission_report_items_evidence',
  'idx_carbon_emission_report_summaries_report'
]);
const PERMISSIONS = Object.freeze([
  'carbon:emission-reports:view',
  'carbon:emission-reports:import:preview',
  'carbon:emission-reports:import:execute',
  'carbon:emission-reports:export'
]);

function sqliteObjectExists(db, type, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name));
}

function dropReportTables(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS carbon_emission_report_summaries;
    DROP TABLE IF EXISTS carbon_emission_report_items;
    DROP TABLE IF EXISTS carbon_emission_report_evidence;
    DROP TABLE IF EXISTS carbon_emission_report_boundaries;
    DROP TABLE IF EXISTS carbon_emission_reports;`);
  db.pragma('foreign_keys = ON');
}

try {
  initDatabase({ databasePath });
  let db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true));
    EXPECTED_INDEXES.forEach((indexName) => assert.strictEqual(sqliteObjectExists(db, 'index', indexName), true));
    assert(IMPORT_BATCH_TYPES.includes('carbon_emission_report'));
    const importBatchSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'").get().sql;
    assert(importBatchSql.includes("'carbon_emission_report'"));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    PERMISSIONS.forEach((permissionCode) => {
      const menu = db.prepare(`SELECT menu_type AS menuType, parent_id AS parentId, status
        FROM sys_menus WHERE permission_code = ?`).get(permissionCode);
      assert(menu, `${permissionCode} 必须注册。`);
      assert.strictEqual(menu.menuType, 'button');
      assert.strictEqual(menu.status, 'active');
      const parent = db.prepare('SELECT route_path AS routePath FROM sys_menus WHERE id = ?').get(menu.parentId);
      assert.strictEqual(parent.routePath, '/carbon');
      const superAdminGrant = db.prepare(`SELECT 1 FROM sys_role_menus role_menu
        JOIN sys_roles role ON role.id = role_menu.role_id
        JOIN sys_menus granted_menu ON granted_menu.id = role_menu.menu_id
        WHERE role.role_code = 'super_admin' AND granted_menu.permission_code = ?`).get(permissionCode);
      assert(superAdminGrant, '超级管理员必须默认获得 N6-A 权限。');
      const ordinaryGrant = db.prepare(`SELECT 1 FROM sys_role_menus role_menu
        JOIN sys_roles role ON role.id = role_menu.role_id
        JOIN sys_menus granted_menu ON granted_menu.id = role_menu.menu_id
        WHERE role.role_code = 'user' AND granted_menu.permission_code = ?`).get(permissionCode);
      assert.strictEqual(ordinaryGrant, undefined, '普通角色不得自动扩权。');
    });

    const adminId = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id;
    const batchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_emission_report', 'report.xlsx', 'stored-report.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const reportId = db.prepare(`INSERT INTO carbon_emission_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number, created_by)
      VALUES ('CER-MIGRATION-001', 'CER-MIGRATION-001', '迁移约束报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2, ?)`).run(batchId, adminId).lastInsertRowid;
    db.prepare(`INSERT INTO carbon_emission_report_boundaries
      (report_id, boundary_type, boundary_name, boundary_description, source_row_number)
      VALUES (?, 'organization', '组织边界', '边界说明', 2)`).run(reportId);
    assert.throws(() => db.prepare(`INSERT INTO carbon_emission_report_boundaries
      (report_id, boundary_type, boundary_name, boundary_description, source_row_number)
      VALUES (?, 'organization', '重复组织边界', '边界说明', 3)`).run(reportId), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO carbon_emission_report_summaries
      (report_id, summary_code, summary_code_key, summary_dimension, summary_value, emission_value, co2e_unit, source_row_number)
      VALUES (?, 'BAD', 'BAD', 'unknown', '全部', 1, 'tCO2e', 2)`).run(reportId), /CHECK constraint failed/);
    const evidenceId = db.prepare(`INSERT INTO carbon_emission_report_evidence
      (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type, evidence_description, source_row_number)
      VALUES (?, 'EVID-1', 'EVID-1', '证据一', '原始凭证', '证据说明', 2)`).run(reportId).lastInsertRowid;
    const secondBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_emission_report', 'report-2.xlsx', 'stored-report-2.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const secondReportId = db.prepare(`INSERT INTO carbon_emission_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number, created_by)
      VALUES ('CER-MIGRATION-002', 'CER-MIGRATION-002', '第二份报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2, ?)`).run(secondBatchId, adminId).lastInsertRowid;
    const secondEvidenceId = db.prepare(`INSERT INTO carbon_emission_report_evidence
      (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type, evidence_description, source_row_number)
      VALUES (?, 'EVID-2', 'EVID-2', '证据二', '原始凭证', '证据说明', 2)`).run(secondReportId).lastInsertRowid;
    db.prepare(`INSERT INTO carbon_emission_report_items
      (report_id, item_code, item_code_key, emission_scope, category, emission_source, activity_value,
       activity_unit, factor_value, factor_unit, emission_value, co2e_unit, evidence_id, source_row_number)
      VALUES (?, 'ITEM-1', 'ITEM-1', 'scope_1', '固定燃烧', '天然气', 1, 'm3', 1, 'tCO2e/m3', 1, 'tCO2e', ?, 2)`)
      .run(reportId, evidenceId);
    assert.throws(() => db.prepare(`INSERT INTO carbon_emission_report_items
      (report_id, item_code, item_code_key, emission_scope, category, emission_source, activity_value,
       activity_unit, factor_value, factor_unit, emission_value, co2e_unit, evidence_id, source_row_number)
      VALUES (?, 'ITEM-CROSS', 'ITEM-CROSS', 'scope_1', '固定燃烧', '天然气', 1, 'm3', 1, 'tCO2e/m3', 1, 'tCO2e', ?, 3)`)
      .run(reportId, secondEvidenceId), /FOREIGN KEY constraint failed/);
    const itemForeignKeys = db.prepare("PRAGMA foreign_key_list('carbon_emission_report_items')").all();
    assert(itemForeignKeys.some((row) => row.from === 'report_id' && row.to === 'report_id'
      && row.table === 'carbon_emission_report_evidence'));
    assert(itemForeignKeys.some((row) => row.from === 'evidence_id' && row.to === 'id'
      && row.table === 'carbon_emission_report_evidence'));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 模拟空的非 canonical 旧骨架，重复初始化必须整体重建为 canonical 五表。
  db = openDatabase({ databasePath });
  try {
    db.exec('DELETE FROM carbon_emission_reports');
    dropReportTables(db);
    db.exec('CREATE TABLE carbon_emission_reports (id INTEGER PRIMARY KEY, legacy_payload TEXT)');
  } finally {
    db.close();
  }
  initDatabase({ databasePath });
  initDatabase({ databasePath });
  db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true));
    EXPECTED_INDEXES.forEach((indexName) => assert.strictEqual(sqliteObjectExists(db, 'index', indexName), true));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 非 canonical 骨架存在历史业务行时禁止猜测迁移。
  const populatedPath = path.join(temporaryRoot, 'populated.sqlite');
  db = openDatabase({ databasePath: populatedPath });
  try {
    db.exec('CREATE TABLE carbon_emission_reports (id INTEGER PRIMARY KEY, legacy_payload TEXT)');
    db.prepare("INSERT INTO carbon_emission_reports (legacy_payload) VALUES ('legacy')").run();
    assert.throws(
      () => ensureCarbonEmissionReportTables(db),
      (error) => error?.code === 'CARBON_EMISSION_REPORT_NON_CANONICAL_DATA'
        && error.details.populatedTables.includes('carbon_emission_reports')
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_emission_reports').get().total, 1);
  } finally {
    db.close();
  }

  // 未知外部子表指向 N6 父表的孤儿引用也必须在迁移事务内 fail-closed，且不得破坏原数据。
  const incomingViolationPath = path.join(temporaryRoot, 'incoming-violation.sqlite');
  fs.copyFileSync(databasePath, incomingViolationPath);
  db = openDatabase({ databasePath: incomingViolationPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE external_report_links (
      id INTEGER PRIMARY KEY,
      report_id INTEGER NOT NULL,
      FOREIGN KEY (report_id) REFERENCES carbon_emission_reports(id) ON DELETE RESTRICT
    )`);
    db.prepare('INSERT INTO external_report_links (id, report_id) VALUES (1, 999999)').run();
    db.pragma('foreign_keys = ON');
    assert.throws(
      () => ensureCarbonEmissionReportTables(db),
      (error) => error?.code === 'CARBON_EMISSION_REPORT_FOREIGN_KEY_CHECK_FAILED'
        && error.details.foreignKeyViolations.some((violation) => (
          violation.childTable === 'external_report_links'
          && violation.parentTable === 'carbon_emission_reports'
        ))
    );
    assert.strictEqual(db.prepare('SELECT report_id AS reportId FROM external_report_links WHERE id = 1').get().reportId, 999999);
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true));
  } finally {
    db.close();
  }

  // 迁移片段失败必须整体回滚，不留下第一张临时表。
  const rollbackPath = path.join(temporaryRoot, 'rollback.sqlite');
  db = openDatabase({ databasePath: rollbackPath });
  try {
    const invalidSchema = `-- CARBON_EMISSION_REPORT_SCHEMA_START
      CREATE TABLE carbon_emission_reports (id INTEGER PRIMARY KEY);
      CREATE TABLE broken_report_table (
      -- CARBON_EMISSION_REPORT_SCHEMA_END`;
    assert.throws(() => ensureCarbonEmissionReportTables(db, invalidSchema));
    assert.strictEqual(sqliteObjectExists(db, 'table', 'carbon_emission_reports'), false);
  } finally {
    db.close();
  }

  console.log('carbonEmissionReportMigration tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
