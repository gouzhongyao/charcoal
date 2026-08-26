'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-ghg-report-schema-'));
const databasePath = path.join(temporaryRoot, 'ghg-report.sqlite');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.SQLITE_PATH = databasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'GhgReportMigration123!';

const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const {
  IMPORT_BATCH_TYPES,
  ensureGhgReportTables,
  ghgReportTableIsCanonical,
  initDatabase,
  openDatabase
} = require('../db/database');

// N7 六张独立表和九个显式索引构成 canonical 新库合同。
const EXPECTED_TABLES = Object.freeze([
  'ghg_reports',
  'ghg_report_organization_boundaries',
  'ghg_report_operational_boundaries',
  'ghg_report_evidence',
  'ghg_report_items',
  'ghg_report_summaries'
]);
const EXPECTED_INDEXES = Object.freeze([
  'idx_ghg_reports_period',
  'idx_ghg_reports_organization',
  'idx_ghg_reports_batch',
  'idx_ghg_report_organization_boundaries_report',
  'idx_ghg_report_operational_boundaries_report',
  'idx_ghg_report_evidence_report',
  'idx_ghg_report_items_filters',
  'idx_ghg_report_items_evidence',
  'idx_ghg_report_summaries_report'
]);
const PERMISSIONS = Object.freeze([
  'carbon:ghg-reports:view',
  'carbon:ghg-reports:import:preview',
  'carbon:ghg-reports:import:execute',
  'carbon:ghg-reports:export'
]);

/** 判断指定 SQLite 对象是否存在。 */
function sqliteObjectExists(db, type, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name));
}

/** 按外键依赖逆序删除 N7 六表。 */
function dropGhgReportTables(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS ghg_report_summaries;
    DROP TABLE IF EXISTS ghg_report_items;
    DROP TABLE IF EXISTS ghg_report_evidence;
    DROP TABLE IF EXISTS ghg_report_operational_boundaries;
    DROP TABLE IF EXISTS ghg_report_organization_boundaries;
    DROP TABLE IF EXISTS ghg_reports;`);
  db.pragma('foreign_keys = ON');
}

try {
  initDatabase({ databasePath });
  let db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => {
      assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true);
      assert.strictEqual(ghgReportTableIsCanonical(db, tableName), true, `${tableName} 必须匹配 canonical 指纹。`);
    });
    EXPECTED_INDEXES.forEach((indexName) => assert.strictEqual(sqliteObjectExists(db, 'index', indexName), true));
    assert.deepStrictEqual(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (${EXPECTED_TABLES.map(() => '?').join(', ')})`).all(...EXPECTED_TABLES), []);
    assert(IMPORT_BATCH_TYPES.includes('ghg_report'));
    const importBatchSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'").get().sql;
    assert(importBatchSql.includes("'ghg_report'"));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // 四项权限只种给超级管理员，普通角色重复初始化也不得自动扩权。
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
      assert(superAdminGrant, '超级管理员必须默认获得 N7-A 权限。');
      const ordinaryGrant = db.prepare(`SELECT 1 FROM sys_role_menus role_menu
        JOIN sys_roles role ON role.id = role_menu.role_id
        JOIN sys_menus granted_menu ON granted_menu.id = role_menu.menu_id
        WHERE role.role_code = 'user' AND granted_menu.permission_code = ?`).get(permissionCode);
      assert.strictEqual(ordinaryGrant, undefined, '普通角色不得自动获得 N7-A 权限。');
    });

    const adminId = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id;
    const batchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('ghg_report', 'ghg.xlsx', 'stored-ghg.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const reportId = db.prepare(`INSERT INTO ghg_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number, created_by)
      VALUES ('GHG-MIGRATION-001', 'GHG-MIGRATION-001', '迁移约束报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2, ?)`).run(batchId, adminId).lastInsertRowid;
    db.prepare(`INSERT INTO ghg_report_organization_boundaries
      (report_id, boundary_code, boundary_code_key, organization_unit, inclusion_method, boundary_description, source_row_number)
      VALUES (?, 'ORG-1', 'ORG-1', '测试组织', '运营控制法', '全部受控设施', 2)`).run(reportId);
    db.prepare(`INSERT INTO ghg_report_operational_boundaries
      (report_id, emission_scope, category, category_key, boundary_description, source_row_number)
      VALUES (?, 'scope_1', '固定燃烧', '固定燃烧', '天然气锅炉', 2)`).run(reportId);
    const evidenceId = db.prepare(`INSERT INTO ghg_report_evidence
      (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type, evidence_description, source_row_number)
      VALUES (?, 'EVID-1', 'EVID-1', '证据一', '原始凭证', '证据说明', 2)`).run(reportId).lastInsertRowid;
    db.prepare(`INSERT INTO ghg_report_items
      (report_id, item_code, item_code_key, record_type, emission_scope, category, greenhouse_gas,
       source_or_sink, activity_value, activity_unit, gas_amount, gwp, co2e_value, co2e_unit,
       accounting_method, evidence_id, source_row_number)
      VALUES (?, 'ITEM-1', 'ITEM-1', 'emission', 'scope_1', '固定燃烧', 'CO2',
       '天然气锅炉', 1, 'm3', 1, 1, 1, 'tCO2e', '活动数据法', ?, 2)`)
      .run(reportId, evidenceId);
    db.prepare(`INSERT INTO ghg_report_summaries
      (report_id, summary_code, summary_code_key, summary_dimension, summary_value,
       emission_co2e, removal_co2e, net_co2e, co2e_unit, source_row_number)
      VALUES (?, 'TOTAL-1', 'TOTAL-1', 'total', '全部', 1, 2, -1, 'tCO2e', 2)`).run(reportId);

    // 清除必须通过 record_type 显式表达，数值字段不接受负数或未知记录类型。
    assert.throws(() => db.prepare(`INSERT INTO ghg_report_items
      (report_id, item_code, item_code_key, record_type, emission_scope, category, greenhouse_gas,
       source_or_sink, activity_value, activity_unit, gas_amount, gwp, co2e_value, co2e_unit,
       accounting_method, evidence_id, source_row_number)
      VALUES (?, 'ITEM-BAD-TYPE', 'ITEM-BAD-TYPE', 'negative_emission', 'scope_1', '固定燃烧', 'CO2',
       '非法事实', 1, 'm3', 1, 1, 1, 'tCO2e', '测试', ?, 3)`)
      .run(reportId, evidenceId), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO ghg_report_items
      (report_id, item_code, item_code_key, record_type, emission_scope, category, greenhouse_gas,
       source_or_sink, activity_value, activity_unit, gas_amount, gwp, co2e_value, co2e_unit,
       accounting_method, evidence_id, source_row_number)
      VALUES (?, 'ITEM-NEGATIVE', 'ITEM-NEGATIVE', 'removal', 'scope_1', '固定燃烧', 'CO2',
       '碳汇', 1, 'tCO2', -1, 1, 1, 'tCO2e', '测试', ?, 4)`)
      .run(reportId, evidenceId), /CHECK constraint failed/);

    // 复合外键必须阻断跨报告证据引用。
    const secondBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('ghg_report', 'ghg-2.xlsx', 'stored-ghg-2.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const secondReportId = db.prepare(`INSERT INTO ghg_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('GHG-MIGRATION-002', 'GHG-MIGRATION-002', '第二份报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2)`).run(secondBatchId).lastInsertRowid;
    const secondEvidenceId = db.prepare(`INSERT INTO ghg_report_evidence
      (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type, evidence_description, source_row_number)
      VALUES (?, 'EVID-2', 'EVID-2', '证据二', '原始凭证', '证据说明', 2)`).run(secondReportId).lastInsertRowid;
    assert.throws(() => db.prepare(`INSERT INTO ghg_report_items
      (report_id, item_code, item_code_key, record_type, emission_scope, category, greenhouse_gas,
       source_or_sink, activity_value, activity_unit, gas_amount, gwp, co2e_value, co2e_unit,
       accounting_method, evidence_id, source_row_number)
      VALUES (?, 'ITEM-CROSS', 'ITEM-CROSS', 'emission', 'scope_1', '固定燃烧', 'CO2',
       '跨报告引用', 1, 'm3', 1, 1, 1, 'tCO2e', '测试', ?, 3)`)
      .run(reportId, secondEvidenceId), /FOREIGN KEY constraint failed/);
    const itemForeignKeys = db.prepare("PRAGMA foreign_key_list('ghg_report_items')").all();
    assert(itemForeignKeys.some((row) => row.from === 'report_id' && row.to === 'report_id'
      && row.table === 'ghg_report_evidence'));
    assert(itemForeignKeys.some((row) => row.from === 'evidence_id' && row.to === 'id'
      && row.table === 'ghg_report_evidence'));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 空的非 canonical 旧骨架允许整体重建，且重复初始化保持幂等。
  db = openDatabase({ databasePath });
  try {
    db.exec('DELETE FROM ghg_reports');
    dropGhgReportTables(db);
    db.exec(`CREATE TABLE ghg_reports (id INTEGER PRIMARY KEY, legacy_payload TEXT);
      CREATE TRIGGER trg_empty_ghg_report_cross_domain
      AFTER INSERT ON ghg_reports
      BEGIN
        DELETE FROM carbon_factors;
      END;`);
    assert.strictEqual(sqliteObjectExists(db, 'trigger', 'trg_empty_ghg_report_cross_domain'), true);
  } finally {
    db.close();
  }
  initDatabase({ databasePath });
  initDatabase({ databasePath });
  db = openDatabase({ databasePath });
  try {
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(ghgReportTableIsCanonical(db, tableName), true));
    EXPECTED_INDEXES.forEach((indexName) => assert.strictEqual(sqliteObjectExists(db, 'index', indexName), true));
    assert.strictEqual(sqliteObjectExists(db, 'trigger', 'trg_empty_ghg_report_cross_domain'), false,
      '空非 canonical 骨架重建必须连带清除未知 N7 触发器。');
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 有业务数据的未知旧结构必须 fail-closed，禁止猜测列语义。
  const populatedPath = path.join(temporaryRoot, 'populated.sqlite');
  db = openDatabase({ databasePath: populatedPath });
  try {
    db.exec('CREATE TABLE ghg_reports (id INTEGER PRIMARY KEY, legacy_payload TEXT)');
    db.prepare("INSERT INTO ghg_reports (legacy_payload) VALUES ('legacy')").run();
    assert.throws(
      () => ensureGhgReportTables(db),
      (error) => error?.code === 'GHG_REPORT_NON_CANONICAL_DATA'
        && error.details.populatedTables.includes('ghg_reports')
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM ghg_reports').get().total, 1);
  } finally {
    db.close();
  }

  // canonical N7 表只要挂载未知触发器且已有业务行就必须 fail-closed，禁止隐式改写 N6 或碳因子。
  const triggerCollisionPath = path.join(temporaryRoot, 'trigger-collision.sqlite');
  fs.copyFileSync(databasePath, triggerCollisionPath);
  db = openDatabase({ databasePath: triggerCollisionPath });
  try {
    const energyTypeId = db.prepare('SELECT id FROM energy_types ORDER BY id LIMIT 1').get().id;
    const factorId = db.prepare(`INSERT INTO carbon_factors
      (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source)
      VALUES (?, 'default', 2026, 'kWh', 0.5, 'kgCO2e', 'N7触发器保护因子')`).run(energyTypeId).lastInsertRowid;
    const n6BatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('carbon_emission_report', 'n6-trigger.xlsx', 'n6-trigger.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    const n6ReportId = db.prepare(`INSERT INTO carbon_emission_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('N6-TRIGGER-GUARD', 'N6-TRIGGER-GUARD', 'N6触发器保护报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2)`).run(n6BatchId).lastInsertRowid;
    const ghgBatchId = db.prepare(`INSERT INTO import_batches
      (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
      VALUES ('ghg_report', 'ghg-trigger.xlsx', 'ghg-trigger.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO ghg_reports
      (report_code, report_code_key, report_name, report_organization, period_start, period_end,
       source_batch_id, source_row_number)
      VALUES ('GHG-TRIGGER-GUARD', 'GHG-TRIGGER-GUARD', 'N7触发器保护报告', '测试组织',
       '2026-01-01', '2026-12-31', ?, 2)`).run(ghgBatchId);
    db.exec(`CREATE TRIGGER trg_populated_ghg_report_cross_domain
      AFTER UPDATE ON ghg_reports
      BEGIN
        UPDATE carbon_factors SET source = '被未知触发器改写' WHERE id = ${Number(factorId)};
        UPDATE carbon_emission_reports SET report_name = '被未知触发器改写' WHERE id = ${Number(n6ReportId)};
      END;`);
    assert.strictEqual(ghgReportTableIsCanonical(db, 'ghg_reports'), false);
    assert.throws(
      () => ensureGhgReportTables(db),
      (error) => error?.code === 'GHG_REPORT_NON_CANONICAL_DATA'
        && error.details.unknownTriggers.some((trigger) => (
          trigger.tableName === 'ghg_reports'
          && trigger.triggerName === 'trg_populated_ghg_report_cross_domain'
        ))
    );
    assert.strictEqual(db.prepare('SELECT source FROM carbon_factors WHERE id = ?').get(factorId).source, 'N7触发器保护因子');
    assert.strictEqual(db.prepare('SELECT report_name AS reportName FROM carbon_emission_reports WHERE id = ?').get(n6ReportId).reportName, 'N6触发器保护报告');
    assert.strictEqual(sqliteObjectExists(db, 'trigger', 'trg_populated_ghg_report_cross_domain'), true);
  } finally {
    db.close();
  }

  // 同权限码非 canonical 行必须 fail-closed，不得静默修正后继承普通角色授权。
  const permissionCollisionCases = [
    {
      name: 'custom-parent-with-ordinary-grant',
      permissionCode: 'carbon:ghg-reports:view',
      expectedInvalidField: 'parent_id',
      mutate(collisionDb, menuId) {
        const now = new Date().toISOString();
        const parentId = collisionDb.prepare(`INSERT INTO sys_menus
          (menu_type, menu_name, route_path, sort_order, visible, status, is_builtin, created_at, updated_at)
          VALUES ('directory', '自定义温室气体目录', '/custom-ghg', 999, 1, 'active', 0, ?, ?)`).run(now, now).lastInsertRowid;
        collisionDb.prepare('UPDATE sys_menus SET parent_id = ? WHERE id = ?').run(parentId, menuId);
        const userRoleId = collisionDb.prepare("SELECT id FROM sys_roles WHERE role_code = 'user'").get().id;
        collisionDb.prepare(`INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at)
          VALUES (?, ?, ?)`).run(userRoleId, menuId, now);
      }
    },
    {
      name: 'inactive',
      permissionCode: 'carbon:ghg-reports:import:preview',
      expectedInvalidField: 'status',
      mutate(collisionDb, menuId) {
        collisionDb.prepare("UPDATE sys_menus SET status = 'inactive' WHERE id = ?").run(menuId);
      }
    },
    {
      name: 'wrong-menu-type',
      permissionCode: 'carbon:ghg-reports:import:execute',
      expectedInvalidField: 'menu_type',
      mutate(collisionDb, menuId) {
        collisionDb.prepare("UPDATE sys_menus SET menu_type = 'menu' WHERE id = ?").run(menuId);
      }
    },
    {
      name: 'wrong-fixed-identity',
      permissionCode: 'carbon:ghg-reports:export',
      expectedInvalidField: 'menu_name',
      mutate(collisionDb, menuId) {
        collisionDb.prepare("UPDATE sys_menus SET menu_name = '自定义导出', sort_order = 999 WHERE id = ?").run(menuId);
      }
    }
  ];
  permissionCollisionCases.forEach((collisionCase) => {
    const collisionPath = path.join(temporaryRoot, `permission-${collisionCase.name}.sqlite`);
    fs.copyFileSync(databasePath, collisionPath);
    const collisionDb = openDatabase({ databasePath: collisionPath });
    let menuId;
    try {
      menuId = collisionDb.prepare('SELECT id FROM sys_menus WHERE permission_code = ?')
        .get(collisionCase.permissionCode).id;
      collisionCase.mutate(collisionDb, menuId);
    } finally {
      collisionDb.close();
    }
    assert.throws(
      () => initDatabase({ databasePath: collisionPath }),
      (error) => error?.code === 'GHG_REPORT_PERMISSION_MENU_COLLISION'
        && error.details.permissionCode === collisionCase.permissionCode
        && error.details.invalidFields.includes(collisionCase.expectedInvalidField)
    );
    const verifyDb = openDatabase({ databasePath: collisionPath });
    try {
      const collidedMenu = verifyDb.prepare('SELECT status, menu_type AS menuType FROM sys_menus WHERE id = ?').get(menuId);
      if (collisionCase.name === 'inactive') assert.strictEqual(collidedMenu.status, 'inactive');
      if (collisionCase.name === 'wrong-menu-type') assert.strictEqual(collidedMenu.menuType, 'menu');
      if (collisionCase.name === 'custom-parent-with-ordinary-grant') {
        const ordinaryGrant = verifyDb.prepare(`SELECT 1 FROM sys_role_menus role_menu
          JOIN sys_roles role ON role.id = role_menu.role_id
          WHERE role.role_code = 'user' AND role_menu.menu_id = ?`).get(menuId);
        assert(ordinaryGrant, '碰撞初始化失败后必须保留原库，不得静默迁移普通角色授权。');
      }
    } finally {
      verifyDb.close();
    }
  });

  // 未知外部子表指向 N7 父表的孤儿引用也必须在迁移前 fail-closed。
  const incomingViolationPath = path.join(temporaryRoot, 'incoming-violation.sqlite');
  fs.copyFileSync(databasePath, incomingViolationPath);
  db = openDatabase({ databasePath: incomingViolationPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE external_ghg_report_links (
      id INTEGER PRIMARY KEY,
      report_id INTEGER NOT NULL,
      FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE RESTRICT
    )`);
    db.prepare('INSERT INTO external_ghg_report_links (id, report_id) VALUES (1, 999999)').run();
    db.pragma('foreign_keys = ON');
    assert.throws(
      () => ensureGhgReportTables(db),
      (error) => error?.code === 'GHG_REPORT_FOREIGN_KEY_CHECK_FAILED'
        && error.details.foreignKeyViolations.some((violation) => (
          violation.childTable === 'external_ghg_report_links'
          && violation.parentTable === 'ghg_reports'
        ))
    );
    assert.strictEqual(db.prepare('SELECT report_id AS reportId FROM external_ghg_report_links WHERE id = 1').get().reportId, 999999);
    EXPECTED_TABLES.forEach((tableName) => assert.strictEqual(sqliteObjectExists(db, 'table', tableName), true));
  } finally {
    db.close();
  }

  // 迁移片段语法失败必须整体回滚，不留下部分新表。
  const rollbackPath = path.join(temporaryRoot, 'rollback.sqlite');
  db = openDatabase({ databasePath: rollbackPath });
  try {
    const invalidSchema = `-- GHG_REPORT_SCHEMA_START
      CREATE TABLE ghg_reports (id INTEGER PRIMARY KEY);
      CREATE TABLE broken_ghg_report_table (
      -- GHG_REPORT_SCHEMA_END`;
    assert.throws(() => ensureGhgReportTables(db, invalidSchema));
    assert.strictEqual(sqliteObjectExists(db, 'table', 'ghg_reports'), false);
  } finally {
    db.close();
  }

  console.log('ghgReportMigration tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
