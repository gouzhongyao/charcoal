const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-generation-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');

const { initDatabase, openDatabase } = require('../db/database');
const {
  buildGenerationMeta,
  createGenerationRecord,
  getMonthlyGenerationStatistics,
  listGenerationRecords,
  normalizeGenerationPayload,
  updateGenerationRecord,
  voidGenerationRecord
} = require('../services/generationService');

function getCounts(db) {
  return {
    energyRecords: db.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total,
    carbonEmissions: db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total,
    generationRecords: db.prepare('SELECT COUNT(*) AS total FROM generation_records').get().total
  };
}

function assertUnchangedEnergyAndCarbon(before) {
  const db = openDatabase();
  try {
    const after = getCounts(db);
    assert.strictEqual(after.energyRecords, before.energyRecords, '发电记录服务不得 INSERT/UPDATE/DELETE energy_records。');
    assert.strictEqual(after.carbonEmissions, before.carbonEmissions, '发电记录服务不得 INSERT/UPDATE/DELETE carbon_emissions。');
  } finally {
    db.close();
  }
}

try {
  initDatabase();

  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const serviceSql = fs.readFileSync(path.join(__dirname, '..', 'services', 'generationService.js'), 'utf8');
  const routeSql = fs.readFileSync(path.join(__dirname, '..', 'routes', 'generation.js'), 'utf8');
  const indexSql = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert(schemaSql.includes('CREATE TABLE IF NOT EXISTS generation_records'), 'schema 应创建独立 generation_records 表。');
  assert(schemaSql.includes('ux_generation_records_active_org_month_energy'), 'schema 应包含 active 发电记录部分唯一索引。');
  assert(serviceSql.includes("FROM energy_records er"), '月度统计应只读 energy_records 作为外购电参考来源。');
  assert(serviceSql.includes("er.record_status = 'active'"), '外购电参考只能读取 active energy_records。');
  assert(serviceSql.includes("et.code = @electricityCode"), '外购电参考必须限定 electricity 能源类型。');
  assert(!/INSERT\s+INTO\s+energy_records|UPDATE\s+energy_records|DELETE\s+FROM\s+energy_records/i.test(serviceSql), '发电服务不得写入 energy_records。');
  assert(!/INSERT\s+INTO\s+carbon_emissions|UPDATE\s+carbon_emissions|DELETE\s+FROM\s+carbon_emissions/i.test(serviceSql), '发电服务不得写入 carbon_emissions。');
  assert(routeSql.includes("router.get('/statistics/monthly'"), '应提供月度发电汇总接口。');
  assert(routeSql.includes("router.get('/records'"), '应提供发电记录列表接口。');
  assert(routeSql.includes("router.post('/records'"), '应提供发电记录新增接口。');
  assert(routeSql.includes("router.put('/records/:id'"), '应提供发电记录编辑接口。');
  assert(routeSql.includes("router.delete('/records/:id'"), '应提供发电记录作废接口。');
  assert(routeSql.includes("requireWritable('generation:create-record')"), '发电新增路由必须使用维护态写保护。');
  assert(indexSql.includes("const generationRoutes = require('./routes/generation')"), '路由入口应加载 generation 路由。');
  assert(indexSql.includes("app.use('/api/generation', generationRoutes)"), '路由入口应挂载 /api/generation。');

  const db = openDatabase();
  let rootUnitId;
  let inactiveUnitId;
  let electricityId;
  let heatId;
  let carbonSeedEnergyRecordId;
  try {
    rootUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-ROOT', '发电验收总厂', '发电验收总厂', 'enterprise', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    inactiveUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-INACTIVE', '停用发电单元', '停用发电单元', 'workshop', 'inactive', datetime('now'), datetime('now'))").run().lastInsertRowid;
    const otherUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-OTHER', '其它单元', '其它单元', 'workshop', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity' AND is_active = 1").get().id;
    heatId = db.prepare("SELECT id FROM energy_types WHERE code = 'heat' AND is_active = 1").get().id;
    db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-06', '2026-06', 'kWh', 100, 'kWh', 100, '发电验收总厂', 'generation-reference-active-1', 'active', datetime('now'), datetime('now'))").run(electricityId, rootUnitId);
    db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-06', '2026-06', 'kWh', 50, 'kWh', 50, '发电验收总厂', 'generation-reference-active-2', 'active', datetime('now'), datetime('now'))").run(electricityId, rootUnitId);
    db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-06', '2026-06', 'kWh', 999, 'kWh', 999, '发电验收总厂', 'generation-reference-void', 'void', datetime('now'), datetime('now'))").run(electricityId, rootUnitId);
    db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-06', '2026-06', 'MJ', 888, 'MJ', 888, '发电验收总厂', 'generation-reference-heat', 'active', datetime('now'), datetime('now'))").run(heatId, rootUnitId);
    db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-06', '2026-06', 'kWh', 777, 'kWh', 777, '其它单元', 'generation-reference-other-org', 'active', datetime('now'), datetime('now'))").run(electricityId, otherUnitId);
    carbonSeedEnergyRecordId = db.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-07', '2026-07', 'kWh', 1, 'kWh', 1, '发电验收总厂', 'generation-carbon-seed-record', 'active', datetime('now'), datetime('now'))").run(electricityId, rootUnitId).lastInsertRowid;
    db.prepare("INSERT INTO carbon_emissions (energy_record_id, calculation_method, calculation_basis, activity_value, activity_unit, emission_unit, status, calculated_at, note) VALUES (?, 'test-seed', 'test-seed', 1, 'kWh', 'kgCO2e', 'factor_missing', datetime('now'), '发电测试种子')").run(carbonSeedEnergyRecordId);
  } finally {
    db.close();
  }

  const beforeCountsDb = openDatabase();
  let beforeCounts;
  try {
    beforeCounts = getCounts(beforeCountsDb);
  } finally {
    beforeCountsDb.close();
  }

  assert.strictEqual(buildGenerationMeta().writesEnergyRecords, false);
  assert.strictEqual(buildGenerationMeta().writesCarbonEmissions, false);
  assert.strictEqual(buildGenerationMeta().affectsProductionIntensity, false);
  assert.strictEqual(buildGenerationMeta().referenceOnly, true);
  assert.deepStrictEqual(normalizeGenerationPayload({ organizationUnitId: rootUnitId, normalizedMonth: '2026/6', generationValueKwh: '120', selfUseValueKwh: '90', gridExportValueKwh: '30' }), {
    organizationUnitId: rootUnitId,
    energyTypeId: null,
    normalizedMonth: '2026-06',
    generationValueKwh: 120,
    selfUseValueKwh: 90,
    gridExportValueKwh: 30,
    dataSource: 'manual',
    recordStatus: 'active',
    remark: null
  });
  assert.throws(
    () => normalizeGenerationPayload({ organizationUnitId: rootUnitId, normalizedMonth: '2026-06', generationValueKwh: '100', selfUseValueKwh: '80', gridExportValueKwh: '30' }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'GENERATION_BALANCE_EXCEEDED'
  );

  const created = createGenerationRecord({ organizationUnitId: rootUnitId, normalizedMonth: '2026/6', generationValueKwh: 120, selfUseValueKwh: 90, gridExportValueKwh: 30, remark: '首条发电记录' });
  assert.strictEqual(created.organizationUnitId, rootUnitId);
  assert.strictEqual(created.energyTypeCode, 'photovoltaic');
  assert.strictEqual(created.normalizedMonth, '2026-06');
  assert.strictEqual(created.generationValueKwh, 120);
  assert.strictEqual(created.selfUseRate, 0.75);
  assert.strictEqual(created.gridExportRate, 0.25);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  assert.throws(
    () => createGenerationRecord({ organizationUnitId: rootUnitId, normalizedMonth: '2026-06', generationValueKwh: 10, selfUseValueKwh: 8, gridExportValueKwh: 2 }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'DUPLICATE_ACTIVE_GENERATION_RECORD'
  );
  assert.throws(
    () => createGenerationRecord({ organizationUnitId: rootUnitId, normalizedMonth: '2026-07', energyTypeCode: 'electricity', generationValueKwh: 10, selfUseValueKwh: 8, gridExportValueKwh: 2 }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'GENERATION_ENERGY_TYPE_PHOTOVOLTAIC_ONLY'
  );
  assert.throws(
    () => createGenerationRecord({ organizationUnitId: inactiveUnitId, normalizedMonth: '2026-07', generationValueKwh: 10, selfUseValueKwh: 8, gridExportValueKwh: 2 }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INACTIVE_ORGANIZATION_UNIT'
  );

  const updated = updateGenerationRecord(created.id, { generationValueKwh: 150, selfUseValueKwh: 100, gridExportValueKwh: 40, remark: '更新后发电记录' });
  assert.strictEqual(updated.generationValueKwh, 150);
  assert.strictEqual(updated.selfUseValueKwh, 100);
  assert.strictEqual(updated.gridExportValueKwh, 40);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const activeList = listGenerationRecords({ organizationUnitId: String(rootUnitId), status: 'active' });
  assert.strictEqual(activeList.rows.length, 1);
  assert.strictEqual(activeList.rows[0].id, created.id);
  assert.strictEqual(activeList.pagination.total, 1);

  const summaryBeforeVoid = getMonthlyGenerationStatistics({ organizationUnitId: String(rootUnitId), monthStart: '2026-06', monthEnd: '2026-06' });
  assert.strictEqual(summaryBeforeVoid.rows.length, 1);
  assert.strictEqual(summaryBeforeVoid.rows[0].generationValueKwh, 150);
  assert.strictEqual(summaryBeforeVoid.rows[0].selfUseValueKwh, 100);
  assert.strictEqual(summaryBeforeVoid.rows[0].gridExportValueKwh, 40);
  assert.strictEqual(summaryBeforeVoid.rows[0].selfUseRate, 100 / 150);
  assert.strictEqual(summaryBeforeVoid.rows[0].gridExportRate, 40 / 150);
  assert.strictEqual(summaryBeforeVoid.rows[0].purchasedElectricityReferenceKwh, 150, '外购电参考应只汇总同用能单元同月 active electricity。');
  assert.strictEqual(summaryBeforeVoid.rows[0].purchasedElectricityReferenceRecordCount, 2);
  assert.strictEqual(summaryBeforeVoid.meta.referenceOnly, true);
  assert.strictEqual(summaryBeforeVoid.meta.writesEnergyRecords, false);
  assert.strictEqual(summaryBeforeVoid.meta.writesCarbonEmissions, false);
  assert.strictEqual(summaryBeforeVoid.meta.affectsProductionIntensity, false);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const voidResult = voidGenerationRecord(created.id, { voidReason: '测试作废' });
  assert.strictEqual(voidResult.voided, true);
  assert.strictEqual(voidResult.recordStatus, 'void');
  const summaryAfterVoid = getMonthlyGenerationStatistics({ organizationUnitId: String(rootUnitId), monthStart: '2026-06', monthEnd: '2026-06' });
  assert.strictEqual(summaryAfterVoid.rows.length, 0, '作废发电记录不应进入月度统计。');
  assert.strictEqual(summaryAfterVoid.summary.generationValueKwh, 0);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const recreated = createGenerationRecord({ organizationUnitId: rootUnitId, normalizedMonth: '2026-06', generationValueKwh: 200, selfUseValueKwh: 160, gridExportValueKwh: 40, remark: '作废后重建' });
  assert.notStrictEqual(recreated.id, created.id);
  assert.strictEqual(recreated.normalizedMonth, '2026-06');
  const summaryAfterRecreate = getMonthlyGenerationStatistics({ organizationUnitId: String(rootUnitId), monthStart: '2026-06', monthEnd: '2026-06' });
  assert.strictEqual(summaryAfterRecreate.rows.length, 1);
  assert.strictEqual(summaryAfterRecreate.rows[0].generationValueKwh, 200);
  assert.strictEqual(summaryAfterRecreate.rows[0].selfUseValueKwh, 160);
  assert.strictEqual(summaryAfterRecreate.rows[0].gridExportValueKwh, 40);
  assert.strictEqual(summaryAfterRecreate.rows[0].selfUseRate, 0.8);
  assert.strictEqual(summaryAfterRecreate.rows[0].gridExportRate, 0.2);
  assert.strictEqual(summaryAfterRecreate.rows[0].purchasedElectricityReferenceKwh, 150);
  assert.strictEqual(summaryAfterRecreate.summary.generationValueKwh, 200);
  assert.strictEqual(summaryAfterRecreate.summary.purchasedElectricityReferenceKwh, 150);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const finalCountsDb = openDatabase();
  try {
    const finalCounts = getCounts(finalCountsDb);
    assert.strictEqual(finalCounts.generationRecords, beforeCounts.generationRecords + 2, '发电服务只应写入独立 generation_records。');
  } finally {
    finalCountsDb.close();
  }

  console.log('generation service tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
