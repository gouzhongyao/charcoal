'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 迁移专项只操作临时 SQLite，禁止读取或修改正式 data 数据库。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-accounting-migration-'));
const databasePath = path.join(temporaryRoot, 'canonical.sqlite');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = databasePath;
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonAccountingMigration123!';

const {
  carbonAccountingTableIsCanonical,
  initDatabase,
  openDatabase
} = require('../db/database');

// N5-A 旧运行与结果空骨架用于验证可安全重建。
const LEGACY_EMPTY_SKELETON_SQL = `CREATE TABLE carbon_calculation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  activity_count INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE carbon_accounting_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calculation_run_id INTEGER NOT NULL,
  activity_record_id INTEGER NOT NULL,
  emission_unit TEXT NOT NULL DEFAULT 'kgCO2e'
);`;

/** 删除 canonical 运行结构并建立旧空骨架。 */
function replaceWithLegacySkeleton(targetDatabasePath, populate = false) {
  const db = openDatabase({ databasePath: targetDatabasePath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE carbon_accounting_results; DROP TABLE carbon_calculation_runs;');
    db.exec(LEGACY_EMPTY_SKELETON_SQL);
    if (populate) {
      const runId = db.prepare(`INSERT INTO carbon_calculation_runs
        (run_code, status, activity_count, result_count) VALUES ('LEGACY-RUN', 'completed', 1, 1)`)
        .run().lastInsertRowid;
      db.prepare(`INSERT INTO carbon_accounting_results
        (calculation_run_id, activity_record_id, emission_unit) VALUES (?, 1, 'kgCO2e')`).run(runId);
    }
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
}

/** 在字段和索引名称不变时弱化指定表定义，用于验证完整 canonical 指纹。 */
function weakenAccountingTable(targetDatabasePath, tableName, transformSql) {
  const db = openDatabase({ databasePath: targetDatabasePath });
  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName).sql;
    const indexSqlList = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`)
      .all(tableName).map((row) => row.sql);
    const weakenedSql = transformSql(tableSql);
    assert.notStrictEqual(weakenedSql, tableSql, `${tableName} 弱化 SQL 必须真实改变约束。`);
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE ${tableName}`);
    db.exec(weakenedSql);
    indexSqlList.forEach((indexSql) => db.exec(indexSql));
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }
}

/** 插入一条满足 canonical 运行约束的最小历史事实。 */
function insertCanonicalRun(db, overrides = {}) {
  const input = {
    runCode: `MIGRATION-RUN-${Date.now()}-${Math.random()}`,
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-02T00:00:00Z',
    activityCount: 0,
    resultCount: 0,
    calculatedCount: 0,
    factorMissingCount: 0,
    status: 'completed',
    ...overrides
  };
  return Number(db.prepare(`INSERT INTO carbon_calculation_runs
    (run_code, snapshot_schema_version, source_type, status, calculation_method, start_utc, end_utc,
     activity_filter_json, actor_snapshot_json, activity_snapshot_digest, activity_count, result_count,
     calculated_count, factor_missing_count, emission_totals_json, started_at, completed_at)
    VALUES (@runCode, 1, 'independent_activity', @status, 'standard-factor', @startUtc, @endUtc,
     '{"version":1}', '{"version":1,"actor":{}}', @digest, @activityCount, @resultCount,
     @calculatedCount, @factorMissingCount, '{"version":1,"totals":[]}',
     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')`)
    .run({ ...input, digest: 'a'.repeat(64) }).lastInsertRowid);
}

/** 构造一条 canonical calculated 结果，供约束和级联删除测试使用。 */
function insertCanonicalCalculatedResult(db, runId, overrides = {}) {
  const input = {
    calculationRunId: runId,
    activityRecordId: 1,
    status: 'calculated',
    carbonFactorId: 1,
    factorValue: 1,
    factorUnit: 'kgCO2e',
    emissionValue: 1,
    emissionUnit: 'kgCO2e',
    missingReason: null,
    matchPriority: 1,
    factorSnapshotJson: '{"version":1}',
    ...overrides
  };
  return db.prepare(`INSERT INTO carbon_accounting_results
    (calculation_run_id, snapshot_schema_version, source_type, activity_record_id, carbon_factor_id,
     emission_scope, activity_category, organization_unit_id, energy_type_id,
     activity_start_wall_clock, activity_end_wall_clock, activity_start_utc, activity_end_utc,
     activity_value, activity_unit, requested_region, factor_year, factor_value, factor_unit,
     emission_value, emission_unit, status, missing_reason, calculation_basis, match_priority,
     activity_snapshot_json, organization_snapshot_json, energy_type_snapshot_json,
     factor_snapshot_json, matching_snapshot_json, formula_snapshot_json)
    VALUES (@calculationRunId, 1, 'independent_activity', @activityRecordId, @carbonFactorId,
     'scope_1', '迁移约束测试', 1, 1, '0001-01-01T00:00', '0001-01-01T01:00',
     '0001-01-01T00:00:00Z', '0001-01-01T01:00:00Z', 1, 'unit', 'default', 1,
     @factorValue, @factorUnit, @emissionValue, @emissionUnit, @status, @missingReason,
     'activity_value * factor_value', @matchPriority, '{"version":1}', '{"version":1}',
     '{"version":1}', @factorSnapshotJson, '{"version":1}', '{"version":1}')`).run(input);
}

try {
  // 新库必须直接创建 canonical 表，重复初始化幂等且外键检查通过。
  initDatabase({ databasePath });
  initDatabase({ databasePath });
  let db = openDatabase({ databasePath });
  try {
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_calculation_runs'), true);
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_accounting_results'), true);
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // canonical CHECK 必须覆盖 5000、严格 UTC、start<end 和状态计数一致性。
    assert.throws(() => insertCanonicalRun(db, {
      activityCount: 5001,
      resultCount: 5001,
      factorMissingCount: 5001
    }));
    assert.throws(() => insertCanonicalRun(db, {
      startUtc: '2026-01-01 00:00:00',
      endUtc: '2026-01-02T00:00:00Z'
    }));
    assert.throws(() => insertCanonicalRun(db, {
      startUtc: '2026-01-02T00:00:00Z',
      endUtc: '2026-01-01T00:00:00Z'
    }));
    assert.throws(() => insertCanonicalRun(db, {
      activityCount: 1,
      resultCount: 1,
      calculatedCount: 0,
      factorMissingCount: 0
    }));

    // calculated/factor_missing 事实约束必须完整，结果删除行为固定为随 run 级联。
    const cascadeRunId = insertCanonicalRun(db, {
      activityCount: 1,
      resultCount: 1,
      calculatedCount: 1,
      factorMissingCount: 0
    });
    assert.throws(() => insertCanonicalCalculatedResult(db, cascadeRunId, {
      activityRecordId: 2,
      emissionValue: null
    }));
    assert.throws(() => insertCanonicalCalculatedResult(db, cascadeRunId, {
      activityRecordId: 3,
      status: 'factor_missing',
      carbonFactorId: 1,
      factorValue: null,
      factorUnit: null,
      emissionValue: null,
      emissionUnit: null,
      missingReason: 'NO_ACTIVE_EXACT_UNIT_FACTOR',
      matchPriority: null,
      factorSnapshotJson: null
    }));
    insertCanonicalCalculatedResult(db, cascadeRunId);
    db.prepare('DELETE FROM carbon_calculation_runs WHERE id = ?').run(cascadeRunId);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM carbon_accounting_results
      WHERE calculation_run_id = ?`).get(cascadeRunId).total, 0);

    // carbon_emissions 写入哨兵后重跑初始化，必须保持原行完整不变。
    const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const organizationUnitId = db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('CARBON-RUN-MIGRATION-OU', '核算运行迁移测试单元', '核算运行迁移测试单元', 'enterprise', 'active')`)
      .run().lastInsertRowid;
    const energyRecordId = db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value,
       normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2026-01', '2026-01', 'kWh', 10, 'kWh', 10, 'migration-energy', 'active')`)
      .run(energyTypeId, organizationUnitId).lastInsertRowid;
    db.prepare(`INSERT INTO carbon_emissions
      (energy_record_id, calculation_method, calculation_basis, activity_value, activity_unit,
       emission_value, emission_unit, status, note)
      VALUES (?, 'standard-factor', 'legacy-sentinel', 10, 'kWh', NULL, 'kgCO2e',
       'factor_missing', 'legacy-emission-must-stay')`).run(energyRecordId);
  } finally {
    db.close();
  }
  initDatabase({ databasePath });
  db = openDatabase({ databasePath });
  try {
    const legacyEmission = db.prepare(`SELECT calculation_basis AS calculationBasis, activity_value AS activityValue,
      emission_value AS emissionValue, emission_unit AS emissionUnit, status, note
      FROM carbon_emissions WHERE note = 'legacy-emission-must-stay'`).get();
    assert.deepStrictEqual(legacyEmission, {
      calculationBasis: 'legacy-sentinel',
      activityValue: 10,
      emissionValue: null,
      emissionUnit: 'kgCO2e',
      status: 'factor_missing',
      note: 'legacy-emission-must-stay'
    });
  } finally {
    db.close();
  }

  // 正式 canonical 库出现空的非 canonical N5-A 骨架时必须按 fingerprint fail-closed。
  replaceWithLegacySkeleton(databasePath, false);
  assert.throws(
    () => initDatabase({ databasePath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase({ databasePath });
  try {
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_calculation_runs'), false);
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_accounting_results'), false);
  } finally {
    db.close();
  }

  // 字段和命名索引相同但关键 CHECK/UNIQUE/FK 被弱化时，完整 canonical 指纹必须全部识别。
  const weakenedContracts = [
    {
      name: 'activity-limit',
      tableName: 'carbon_calculation_runs',
      transform: (sql) => sql.replace('activity_count BETWEEN 0 AND 5000', 'activity_count >= 0')
    },
    {
      name: 'strict-utc',
      tableName: 'carbon_calculation_runs',
      transform: (sql) => sql.replace(
        "is_strict_utc_iso(start_utc) = 1 AND instr(start_utc, '.') = 0",
        'length(start_utc) > 0'
      )
    },
    {
      name: 'period-order',
      tableName: 'carbon_calculation_runs',
      transform: (sql) => sql.replace(
        'CHECK (unixepoch(start_utc) < unixepoch(end_utc))',
        'CHECK (unixepoch(start_utc) <= unixepoch(end_utc))'
      )
    },
    {
      name: 'status-counts',
      tableName: 'carbon_calculation_runs',
      transform: (sql) => sql.replace(
        'CHECK (calculated_count + factor_missing_count = result_count)',
        'CHECK (calculated_count + factor_missing_count <= result_count)'
      )
    },
    {
      name: 'completed-status',
      tableName: 'carbon_calculation_runs',
      transform: (sql) => sql.replace(
        "DEFAULT 'completed' CHECK (status = 'completed')",
        "DEFAULT 'completed' CHECK (length(status) > 0)"
      )
    },
    {
      name: 'calculated-fact',
      tableName: 'carbon_accounting_results',
      transform: (sql) => sql.replace('AND emission_unit IS NOT NULL', 'AND 1 = 1')
    },
    {
      name: 'missing-fact',
      tableName: 'carbon_accounting_results',
      transform: (sql) => sql.replace('AND factor_snapshot_json IS NULL', 'AND 1 = 1')
    },
    {
      name: 'run-activity-unique',
      tableName: 'carbon_accounting_results',
      transform: (sql) => sql.replace(
        'UNIQUE (calculation_run_id, activity_record_id)',
        'CHECK (calculation_run_id > 0)'
      )
    },
    {
      name: 'cascade-foreign-key',
      tableName: 'carbon_accounting_results',
      transform: (sql) => sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')
    }
  ];
  for (const weakenedContract of weakenedContracts) {
    const weakenedPath = path.join(temporaryRoot, `weak-${weakenedContract.name}.sqlite`);
    initDatabase({ databasePath: weakenedPath });
    weakenAccountingTable(weakenedPath, weakenedContract.tableName, weakenedContract.transform);
    db = openDatabase({ databasePath: weakenedPath });
    try {
      assert.strictEqual(carbonAccountingTableIsCanonical(db, weakenedContract.tableName), false,
        `${weakenedContract.name} 弱化合同不得误判为 canonical。`);
    } finally {
      db.close();
    }
  }

  // 空弱表同样属于 fingerprint 漂移，正式初始化不得自动重建。
  const emptyWeakPath = path.join(temporaryRoot, 'weak-empty-rebuild.sqlite');
  initDatabase({ databasePath: emptyWeakPath });
  weakenAccountingTable(emptyWeakPath, 'carbon_calculation_runs', weakenedContracts[0].transform);
  assert.throws(
    () => initDatabase({ databasePath: emptyWeakPath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase({ databasePath: emptyWeakPath });
  try {
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_calculation_runs'), false);
    assert.strictEqual(carbonAccountingTableIsCanonical(db, 'carbon_accounting_results'), true);
  } finally {
    db.close();
  }

  // 非空弱表必须 fail-closed，禁止根据当前活动或因子伪造历史。
  const populatedWeakPath = path.join(temporaryRoot, 'weak-populated-blocked.sqlite');
  initDatabase({ databasePath: populatedWeakPath });
  weakenAccountingTable(populatedWeakPath, 'carbon_accounting_results', weakenedContracts[5].transform);
  db = openDatabase({ databasePath: populatedWeakPath });
  try {
    const runId = insertCanonicalRun(db, {
      activityCount: 1,
      resultCount: 1,
      calculatedCount: 1,
      factorMissingCount: 0
    });
    insertCanonicalCalculatedResult(db, runId);
  } finally {
    db.close();
  }
  assert.throws(
    () => initDatabase({ databasePath: populatedWeakPath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase({ databasePath: populatedWeakPath });
  try {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total, 1);
  } finally {
    db.close();
  }

  // 非空旧骨架不得用当前主数据伪造快照，初始化必须 fail-closed 并保留旧数据供人工处置。
  const blockedPath = path.join(temporaryRoot, 'blocked.sqlite');
  initDatabase({ databasePath: blockedPath });
  replaceWithLegacySkeleton(blockedPath, true);
  assert.throws(
    () => initDatabase({ databasePath: blockedPath }),
    (error) => error?.code === 'SCHEMA_FINGERPRINT_MISMATCH'
  );
  db = openDatabase({ databasePath: blockedPath });
  try {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total, 1);
  } finally {
    db.close();
  }

  console.log('carbonAccountingRunMigration tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
