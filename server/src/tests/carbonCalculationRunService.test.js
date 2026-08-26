'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 计算服务专项始终使用隔离临时 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-run-service-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-run-service.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonRunService123!';

const { initDatabase, openDatabase } = require('../db/database');
const {
  CARBON_ACCOUNTING_ACTIVITY_LIMIT,
  createCarbonCalculationRun
} = require('../services/carbonCalculationRunService');

// 测试操作者快照固定值。
const TEST_ACTOR = Object.freeze({
  userId: 1,
  username: 'admin',
  displayName: '系统管理员',
  ip: '127.0.0.1'
});

/** 创建隔离能源类型。 */
function insertEnergyType(db, code, unit = 'unit') {
  return Number(db.prepare(`INSERT INTO energy_types
    (code, name, category, default_unit, standard_unit, carbon_factor_required, is_active, display_order)
    VALUES (?, ?, 'other', ?, ?, 1, 1, 900)`).run(code, `测试能源-${code}`, unit, unit).lastInsertRowid);
}

/** 创建 independent_activity 活动事实。 */
function insertActivity(db, input) {
  const code = input.code;
  return Number(db.prepare(`INSERT INTO carbon_activity_records
    (source_type, energy_record_id, activity_code, activity_code_key, superseded_by_activity_id,
     emission_scope, activity_category, activity_category_key, organization_unit_id, energy_type_id,
     start_wall_clock, end_wall_clock, source_timezone, start_utc, end_utc, activity_value,
     activity_unit, factor_region, source_reference, evidence_reference, note, duplicate_key,
     record_status, void_reason, voided_at)
    VALUES (@sourceType, @energyRecordId, @code, @codeKey, @supersededByActivityId,
      @scope, @category, @categoryKey, @organizationUnitId, @energyTypeId,
      @startWallClock, @endWallClock, 'Asia/Shanghai', @startUtc, @endUtc, @activityValue,
      @activityUnit, @factorRegion, @sourceReference, @evidenceReference, @note, @duplicateKey,
      @recordStatus, @voidReason, @voidedAt)`)
    .run({
      sourceType: input.sourceType || 'independent_activity',
      energyRecordId: input.energyRecordId || null,
      code,
      codeKey: code.toLowerCase(),
      supersededByActivityId: input.supersededByActivityId || null,
      scope: input.scope || 'scope_1',
      category: input.category || `类别-${code}`,
      categoryKey: (input.category || `类别-${code}`).toLowerCase(),
      organizationUnitId: input.organizationUnitId,
      energyTypeId: input.energyTypeId,
      startWallClock: input.startWallClock || '2026-01-01T08:00',
      endWallClock: input.endWallClock || '2026-01-01T09:00',
      startUtc: input.startUtc || '2026-01-01T00:00:00Z',
      endUtc: input.endUtc || '2026-01-01T01:00:00Z',
      activityValue: input.activityValue ?? 1,
      activityUnit: input.activityUnit || 'unit',
      factorRegion: input.factorRegion || 'cn-test',
      sourceReference: input.sourceReference || `source-${code}`,
      evidenceReference: input.evidenceReference || null,
      note: input.note || null,
      duplicateKey: require('crypto').createHash('sha256').update(`duplicate-${code}`).digest('hex'),
      recordStatus: input.recordStatus || 'active',
      voidReason: input.recordStatus === 'void' ? '测试作废' : null,
      voidedAt: input.recordStatus === 'void' ? new Date().toISOString() : null
    }).lastInsertRowid);
}

/** 插入启用或停用因子。 */
function insertFactor(db, input) {
  return Number(db.prepare(`INSERT INTO carbon_factors
    (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source,
     effective_from, effective_to, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.energyTypeId, input.region, input.factorYear ?? null, input.unit || 'unit',
      input.factorValue, input.factorUnit || 'kgCO2e', input.source,
      input.effectiveFrom || '2000-01-01', input.effectiveTo || '2099-12-31',
      input.isActive === false ? 0 : 1)
    .lastInsertRowid);
}

/** 读取运行结果快照。 */
function getRunResults(db, runCode) {
  return db.prepare(`SELECT result.*, run.run_code AS runCode
    FROM carbon_accounting_results result
    JOIN carbon_calculation_runs run ON run.id = result.calculation_run_id
    WHERE run.run_code = ? ORDER BY result.activity_record_id`).all(runCode);
}

try {
  initDatabase();
  let db = openDatabase();
  let organizationUnitId;
  const energyTypeIds = {};
  const activityIds = {};
  let expectedHighestExactFactorId;
  try {
    organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('RUN-OU', '=运行测试组织', '/RUN-OU', 'department', 'active')`).run().lastInsertRowid);
    ['p1', 'p2', 'p3', 'p4', 'missing'].forEach((code) => {
      energyTypeIds[code] = insertEnergyType(db, `run-${code}`);
    });

    // p1 同级两个因子必须选择 ID 较大者；effective 区间只冻结不参与匹配。
    insertFactor(db, { energyTypeId: energyTypeIds.p1, region: 'cn-test', factorYear: 2026, factorValue: 0.1, source: 'p1-low' });
    expectedHighestExactFactorId = insertFactor(db, {
      energyTypeId: energyTypeIds.p1,
      region: 'cn-test',
      factorYear: 2026,
      factorValue: 0.12345678,
      source: 'p1-high',
      effectiveFrom: '1990-01-01',
      effectiveTo: '1991-12-31'
    });
    insertFactor(db, { energyTypeId: energyTypeIds.p1, region: 'default', factorYear: 2026, factorValue: 0.2, source: 'p1-default-year' });
    insertFactor(db, { energyTypeId: energyTypeIds.p1, region: 'cn-test', factorValue: 0.3, source: 'p1-region-generic' });
    insertFactor(db, { energyTypeId: energyTypeIds.p1, region: 'default', factorValue: 0.4, source: 'p1-default-generic' });
    insertFactor(db, { energyTypeId: energyTypeIds.p2, region: 'default', factorYear: 2026, factorValue: 2, source: 'p2' });
    insertFactor(db, { energyTypeId: energyTypeIds.p3, region: 'cn-test', factorValue: 3, source: 'p3' });
    insertFactor(db, { energyTypeId: energyTypeIds.p4, region: 'default', factorValue: 4, source: 'p4' });
    insertFactor(db, { energyTypeId: energyTypeIds.missing, region: 'cn-test', factorYear: 2026, unit: 'other', factorValue: 5, source: 'unit-mismatch' });
    insertFactor(db, { energyTypeId: energyTypeIds.missing, region: 'cn-test', factorYear: 2026, factorValue: 6, source: 'inactive', isActive: false });

    activityIds.p1 = insertActivity(db, { code: 'RUN-P1', organizationUnitId, energyTypeId: energyTypeIds.p1, activityValue: 1, note: '=snapshot-formula' });
    activityIds.zero = insertActivity(db, { code: 'RUN-ZERO', organizationUnitId, energyTypeId: energyTypeIds.p1, activityValue: 0 });
    activityIds.p2 = insertActivity(db, {
      code: 'RUN-P2',
      organizationUnitId,
      energyTypeId: energyTypeIds.p2,
      startWallClock: '2026-01-01T00:30',
      endWallClock: '2026-01-01T08:30',
      startUtc: '2025-12-31T16:30:00Z',
      endUtc: '2026-01-01T00:30:00Z'
    });
    activityIds.p3 = insertActivity(db, { code: 'RUN-P3', organizationUnitId, energyTypeId: energyTypeIds.p3 });
    activityIds.p4 = insertActivity(db, { code: 'RUN-P4', organizationUnitId, energyTypeId: energyTypeIds.p4 });
    activityIds.missing = insertActivity(db, { code: 'RUN-MISSING', organizationUnitId, energyTypeId: energyTypeIds.missing });
    insertActivity(db, {
      code: 'RUN-VOID', organizationUnitId, energyTypeId: energyTypeIds.p1, recordStatus: 'void'
    });
    const supersedingActivityId = insertActivity(db, {
      code: 'RUN-SUPERSEDING', organizationUnitId, energyTypeId: energyTypeIds.p1,
      startWallClock: '2027-01-01T08:00', endWallClock: '2027-01-01T09:00',
      startUtc: '2027-01-01T00:00:00Z', endUtc: '2027-01-01T01:00:00Z'
    });
    insertActivity(db, {
      code: 'RUN-SUPERSEDED', organizationUnitId, energyTypeId: energyTypeIds.p1,
      recordStatus: 'superseded', supersededByActivityId: supersedingActivityId
    });
    // 两个半开边界活动与运行区间没有正长度重叠，必须排除。
    insertActivity(db, {
      code: 'RUN-ENDS-AT-START', organizationUnitId, energyTypeId: energyTypeIds.p1,
      startWallClock: '2025-12-31T07:00', endWallClock: '2025-12-31T08:00',
      startUtc: '2025-12-31T23:00:00Z', endUtc: '2026-01-01T00:00:00Z'
    });
    insertActivity(db, {
      code: 'RUN-STARTS-AT-END', organizationUnitId, energyTypeId: energyTypeIds.p1,
      startWallClock: '2026-01-01T10:00', endWallClock: '2026-01-01T11:00',
      startUtc: '2026-01-01T02:00:00Z', endUtc: '2026-01-01T03:00:00Z'
    });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total, 0,
      '首次独立计算前 energy_records 必须为空。');
  } finally {
    db.close();
  }

  const period = { startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-01T02:00:00Z' };
  const firstRun = createCarbonCalculationRun(period, TEST_ACTOR);
  assert.strictEqual(firstRun.status, 'completed');
  assert.strictEqual(firstRun.startUtc, '2026-01-01T00:00:00Z');
  assert.strictEqual(firstRun.activityCount, 6);
  assert.strictEqual(firstRun.resultCount, 6);
  assert.strictEqual(firstRun.calculatedCount, 5);
  assert.strictEqual(firstRun.factorMissingCount, 1);
  assert.strictEqual(firstRun.actorSnapshot.actor.username, 'admin');
  assert.strictEqual(Object.hasOwn(firstRun.actorSnapshot.actor, 'ip'), false,
    '公开运行 DTO 不得包含 actor IP。');

  db = openDatabase();
  let firstResults;
  let legacyEmissionSnapshot;
  try {
    firstResults = getRunResults(db, firstRun.runCode);
    const persistedActorSnapshot = JSON.parse(db.prepare(`SELECT actor_snapshot_json AS actorSnapshotJson
      FROM carbon_calculation_runs WHERE run_code = ?`).get(firstRun.runCode).actorSnapshotJson);
    assert.strictEqual(persistedActorSnapshot.actor.ip, TEST_ACTOR.ip,
      'actor IP 必须继续保留在内部持久化快照。');
    const byActivityId = new Map(firstResults.map((row) => [Number(row.activity_record_id), row]));
    assert.strictEqual(Number(byActivityId.get(activityIds.p1).carbon_factor_id), expectedHighestExactFactorId);
    assert.strictEqual(Number(byActivityId.get(activityIds.p1).match_priority), 1);
    assert.strictEqual(Number(byActivityId.get(activityIds.p1).emission_value), 0.123457);
    assert.strictEqual(Number(byActivityId.get(activityIds.zero).emission_value), 0);
    assert.strictEqual(Number(byActivityId.get(activityIds.p2).factor_year), 2026,
      '因子年份必须取来源墙钟年份，不能取 UTC 开始年份。');
    assert.strictEqual(Number(byActivityId.get(activityIds.p2).match_priority), 2);
    assert.strictEqual(Number(byActivityId.get(activityIds.p3).match_priority), 3);
    assert.strictEqual(Number(byActivityId.get(activityIds.p4).match_priority), 4);
    const missing = byActivityId.get(activityIds.missing);
    assert.strictEqual(missing.status, 'factor_missing');
    assert.strictEqual(missing.emission_value, null);
    assert.strictEqual(missing.emission_unit, null);
    assert.strictEqual(missing.missing_reason, 'NO_ACTIVE_EXACT_UNIT_FACTOR');
    assert.strictEqual(missing.factor_snapshot_json, null);
    const p1FactorSnapshot = JSON.parse(byActivityId.get(activityIds.p1).factor_snapshot_json);
    assert.strictEqual(p1FactorSnapshot.factor.effectiveFrom, '1990-01-01');
    assert.strictEqual(p1FactorSnapshot.factor.effectiveTo, '1991-12-31');
    assert.strictEqual(JSON.parse(byActivityId.get(activityIds.p1).formula_snapshot_json).usesFullActivityValue, true);

    // 增加 energy_record 来源活动后再次独立计算，结果数量不得变化。
    const energyRecordId = Number(db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2026-01', '2026-01', 'unit', 10, 'unit', 10, 'run-energy-source', 'active')`)
      .run(energyTypeIds.p1, organizationUnitId).lastInsertRowid);
    insertActivity(db, {
      code: 'RUN-ENERGY-SOURCE', sourceType: 'energy_record', energyRecordId,
      organizationUnitId, energyTypeId: energyTypeIds.p1
    });
    db.prepare(`INSERT INTO carbon_emissions
      (energy_record_id, carbon_factor_id, calculation_method, calculation_basis, activity_value,
       activity_unit, factor_value, emission_value, emission_unit, status, note)
      VALUES (?, ?, 'standard-factor', 'legacy-unchanged', 10, 'unit', 0.12345678,
       9, 'kgCO2e', 'calculated', 'legacy-result')`)
      .run(energyRecordId, expectedHighestExactFactorId);
    legacyEmissionSnapshot = db.prepare(`SELECT * FROM carbon_emissions WHERE note = 'legacy-result'`).get();
  } finally {
    db.close();
  }

  const secondRun = createCarbonCalculationRun(period, TEST_ACTOR);
  assert.strictEqual(secondRun.activityCount, 6, 'energy_record 来源活动不得进入独立运行。');
  assert.notStrictEqual(secondRun.runCode, firstRun.runCode, '重复运行必须追加新 run。');

  // 后续修改活动和因子只能影响新运行，不能改写旧快照；旧 carbon_emissions 保持逐列不变。
  db = openDatabase();
  try {
    db.prepare(`UPDATE carbon_activity_records SET activity_category = '后续变更类别',
      activity_category_key = '后续变更类别', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), activityIds.p1);
    db.prepare('UPDATE carbon_factors SET factor_value = 0.5, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), expectedHighestExactFactorId);
  } finally {
    db.close();
  }
  const thirdRun = createCarbonCalculationRun(period, TEST_ACTOR);
  db = openDatabase();
  try {
    const oldP1 = getRunResults(db, firstRun.runCode).find((row) => Number(row.activity_record_id) === activityIds.p1);
    const newP1 = getRunResults(db, thirdRun.runCode).find((row) => Number(row.activity_record_id) === activityIds.p1);
    assert.strictEqual(oldP1.activity_category, '类别-RUN-P1');
    assert.strictEqual(Number(oldP1.factor_value), 0.12345678);
    assert.strictEqual(Number(oldP1.emission_value), 0.123457);
    assert.strictEqual(newP1.activity_category, '后续变更类别');
    assert.strictEqual(Number(newP1.factor_value), 0.5);
    assert.strictEqual(Number(newP1.emission_value), 0.5);
    assert.deepStrictEqual(db.prepare(`SELECT * FROM carbon_emissions WHERE note = 'legacy-result'`).get(), legacyEmissionSnapshot);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.accounting.run.create'`).get().total, 3);
  } finally {
    db.close();
  }

  // 零活动也必须追加 completed 运行和成功审计。
  const zeroRun = createCarbonCalculationRun({
    startUtc: '2028-01-01T00:00:00Z', endUtc: '2028-01-02T00:00:00Z'
  }, TEST_ACTOR);
  assert.strictEqual(zeroRun.activityCount, 0);
  assert.strictEqual(zeroRun.resultCount, 0);
  assert.deepStrictEqual(zeroRun.emissionTotals.totals, []);

  // N5-A 合法 0001—9999 来源墙钟年份必须使用请求年份，并回退通用年份因子。
  const genericYearCases = [1, 99, 1899, 2201, 9999];
  db = openDatabase();
  const genericYearActivityIds = new Map();
  try {
    genericYearCases.forEach((year) => {
      const yearText = String(year).padStart(4, '0');
      const energyTypeId = insertEnergyType(db, `run-generic-year-${yearText}`);
      insertFactor(db, {
        energyTypeId,
        region: 'default',
        factorYear: null,
        factorValue: 2,
        source: `generic-year-${yearText}`
      });
      genericYearActivityIds.set(year, insertActivity(db, {
        code: `RUN-GENERIC-YEAR-${yearText}`,
        organizationUnitId,
        energyTypeId,
        factorRegion: 'default',
        startWallClock: `${yearText}-01-01T08:00`,
        endWallClock: `${yearText}-01-01T09:00`,
        startUtc: `${yearText}-01-01T00:00:00Z`,
        endUtc: `${yearText}-01-01T01:00:00Z`
      }));
    });
  } finally {
    db.close();
  }
  for (const year of genericYearCases) {
    const yearText = String(year).padStart(4, '0');
    const genericRun = createCarbonCalculationRun({
      startUtc: `${yearText}-01-01T00:00:00Z`,
      endUtc: `${yearText}-01-01T02:00:00Z`
    }, TEST_ACTOR);
    db = openDatabase();
    try {
      const genericResult = getRunResults(db, genericRun.runCode)
        .find((row) => Number(row.activity_record_id) === genericYearActivityIds.get(year));
      assert(genericResult, `${yearText} 活动必须进入独立计算运行。`);
      assert.strictEqual(Number(genericResult.factor_year), year,
        '结果 factor_year 必须保存活动请求年份，而不是命中通用因子的 NULL 年份。');
      assert.strictEqual(JSON.parse(genericResult.activity_snapshot_json).activity.startWallClock.slice(0, 4), yearText);
      assert.strictEqual(JSON.parse(genericResult.factor_snapshot_json).factor.factorYear, null);
      assert.strictEqual(Number(genericResult.match_priority), 3);
    } finally {
      db.close();
    }
  }

  // 结果或审计阶段故障必须整体回滚，不残留 run、结果或成功审计。
  for (const failurePoint of ['before-results', 'before-audit']) {
    db = openDatabase();
    const before = {
      runs: db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total,
      results: db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total,
      audits: db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
        WHERE operation = 'carbon.accounting.run.create'`).get().total
    };
    db.close();
    assert.throws(() => createCarbonCalculationRun(period, TEST_ACTOR, {
      faultInjector(point) {
        if (point === failurePoint) throw new Error(`injected-${failurePoint}-${process.env.SQLITE_PATH}`);
      }
    }), (error) => error?.code === 'CARBON_ACCOUNTING_INTERNAL_ERROR'
      && error?.details === null
      && !String(error?.message || '').includes(process.env.SQLITE_PATH));
    db = openDatabase();
    try {
      assert.deepStrictEqual({
        runs: db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total,
        results: db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total,
        audits: db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
          WHERE operation = 'carbon.accounting.run.create'`).get().total
      }, before);
    } finally {
      db.close();
    }
  }

  // 非有限乘积必须回滚整次运行。
  db = openDatabase();
  try {
    const overflowEnergyTypeId = insertEnergyType(db, 'run-overflow');
    insertFactor(db, {
      energyTypeId: overflowEnergyTypeId,
      region: 'cn-test',
      factorYear: 2040,
      factorValue: 1e308,
      source: 'overflow-factor'
    });
    insertActivity(db, {
      code: 'RUN-OVERFLOW', organizationUnitId, energyTypeId: overflowEnergyTypeId,
      startWallClock: '2040-01-01T08:00', endWallClock: '2040-01-01T09:00',
      startUtc: '2040-01-01T00:00:00Z', endUtc: '2040-01-01T01:00:00Z',
      activityValue: 1000000000000000
    });
  } finally {
    db.close();
  }
  assert.throws(
    () => createCarbonCalculationRun({
      startUtc: '2040-01-01T00:00:00Z', endUtc: '2040-01-01T02:00:00Z'
    }, TEST_ACTOR),
    (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_RESULT'
  );

  // 单条结果有限但 18 条约 1e301 累计后六位舍入缩放溢出时，运行必须整体回滚。
  db = openDatabase();
  try {
    const totalOverflowEnergyTypeId = insertEnergyType(db, 'run-total-overflow');
    insertFactor(db, {
      energyTypeId: totalOverflowEnergyTypeId,
      region: 'cn-test',
      factorYear: 2041,
      factorValue: 1e286,
      factorUnit: 'overflowTotalUnit',
      source: 'total-overflow-factor'
    });
    db.transaction(() => {
      for (let index = 1; index <= 18; index += 1) {
        insertActivity(db, {
          code: `RUN-TOTAL-OVERFLOW-${index}`,
          organizationUnitId,
          energyTypeId: totalOverflowEnergyTypeId,
          startWallClock: '2041-01-01T08:00',
          endWallClock: '2041-01-01T09:00',
          startUtc: '2041-01-01T00:00:00Z',
          endUtc: '2041-01-01T01:00:00Z',
          activityValue: 1e15
        });
      }
    })();
  } finally {
    db.close();
  }
  db = openDatabase();
  const beforeTotalOverflow = {
    runs: db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total,
    results: db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total,
    audits: db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'carbon.accounting.run.create'`).get().total
  };
  db.close();
  assert.throws(
    () => createCarbonCalculationRun({
      startUtc: '2041-01-01T00:00:00Z', endUtc: '2041-01-01T02:00:00Z'
    }, TEST_ACTOR),
    (error) => error?.code === 'CARBON_ACCOUNTING_NON_FINITE_TOTAL'
  );
  db = openDatabase();
  try {
    assert.deepStrictEqual({
      runs: db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total,
      results: db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total,
      audits: db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
        WHERE operation = 'carbon.accounting.run.create'`).get().total
    }, beforeTotalOverflow);
  } finally {
    db.close();
  }

  // LIMIT 5001 必须识别 5001 条活动并整体拒绝，禁止静默截断。
  db = openDatabase();
  try {
    const bulkEnergyTypeId = insertEnergyType(db, 'run-bulk');
    const insertBulk = db.transaction(() => {
      for (let index = 1; index <= CARBON_ACCOUNTING_ACTIVITY_LIMIT + 1; index += 1) {
        insertActivity(db, {
          code: `RUN-BULK-${index}`, organizationUnitId, energyTypeId: bulkEnergyTypeId,
          startWallClock: '2030-01-01T08:00', endWallClock: '2030-01-01T09:00',
          startUtc: '2030-01-01T00:00:00Z', endUtc: '2030-01-01T01:00:00Z'
        });
      }
    });
    insertBulk();
  } finally {
    db.close();
  }
  const beforeLimitFailureDb = openDatabase();
  const runsBeforeLimitFailure = beforeLimitFailureDb.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total;
  beforeLimitFailureDb.close();
  assert.throws(
    () => createCarbonCalculationRun({
      startUtc: '2030-01-01T00:00:00Z', endUtc: '2030-01-01T02:00:00Z'
    }, TEST_ACTOR),
    (error) => error?.code === 'CARBON_ACCOUNTING_ACTIVITY_LIMIT_EXCEEDED'
  );
  db = openDatabase();
  try {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, runsBeforeLimitFailure);
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  console.log('carbonCalculationRunService tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
