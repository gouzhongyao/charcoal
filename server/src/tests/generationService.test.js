const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-generation-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
delete process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET;
delete process.env.CHARCOAL_HMAC_SECRET;
delete process.env.APP_SECRET;

const {
  buildGenerationRecordsDataSourceMigrationSql,
  generationRecordsDataSourceCheckAllowsUpload,
  initDatabase,
  openDatabase
} = require('../db/database');
const {
  GENERATION_DATA_SOURCES,
  GENERATION_RECORD_EXPORT_FIELDS,
  GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY,
  MAX_GENERATION_RECORD_EXPORT_ROWS,
  buildGenerationMeta,
  buildGenerationRecordImportPreviewFromRows,
  buildGenerationRecordImportPreviewSignature,
  createGenerationRecord,
  createGenerationRecordImportPreviewFromUpload,
  exportGenerationRecords,
  getGenerationRecordImportHmacSecret,
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
  const expectedGenerationDataSourceCheck = `data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN (${GENERATION_DATA_SOURCES.map((value) => `'${value}'`).join(', ')}))`;
  assert(schemaSql.includes(expectedGenerationDataSourceCheck), 'generation_records.data_source schema CHECK 应与 GENERATION_DATA_SOURCES 保持一致。');
  assert(generationRecordsDataSourceCheckAllowsUpload(`CREATE TABLE generation_records (${expectedGenerationDataSourceCheck})`), '新 generation_records CHECK 应允许 upload。');
  assert(!generationRecordsDataSourceCheckAllowsUpload("CREATE TABLE generation_records (data_source TEXT CHECK (data_source IN ('manual', 'calculation')) )"), '旧 generation_records CHECK 应被识别为需迁移。');
  assert(buildGenerationRecordsDataSourceMigrationSql().some((sql) => sql.includes("'upload'")), '旧库迁移 SQL 应扩展 upload 数据来源。');
  assert(!serviceSql.includes('charcoal-local-development-generation-record-import-hmac-secret'), '发电 previewSignature 不得保留源码硬编码默认 HMAC secret。');
  assert(serviceSql.includes('GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY'), '未配置环境 secret 时应使用安装级 app_meta 随机 HMAC secret。');
  assert(serviceSql.includes('crypto.randomBytes(32)'), '安装级 HMAC secret 应使用随机值生成。');
  assert(serviceSql.includes("process.env.APP_SECRET"), '发电 previewSignature 应支持 APP_SECRET 环境变量。');
  assert(serviceSql.includes("FROM energy_records er"), '月度统计应只读 energy_records 作为外购电参考来源。');
  assert(serviceSql.includes("er.record_status = 'active'"), '外购电参考只能读取 active energy_records。');
  assert(serviceSql.includes("et.code = @electricityCode"), '外购电参考必须限定 electricity 能源类型。');
  assert(!/INSERT\s+INTO\s+energy_records|UPDATE\s+energy_records|DELETE\s+FROM\s+energy_records/i.test(serviceSql), '发电服务不得写入 energy_records。');
  assert(!/INSERT\s+INTO\s+carbon_emissions|UPDATE\s+carbon_emissions|DELETE\s+FROM\s+carbon_emissions/i.test(serviceSql), '发电服务不得写入 carbon_emissions。');
  assert(routeSql.includes("router.get('/contract'"), '应提供发电导入导出契约接口。');
  assert(routeSql.includes("router.get('/statistics/monthly'"), '应提供月度发电汇总接口。');
  assert(routeSql.includes("router.get('/records/export'"), '应提供发电记录当前筛选导出接口。');
  assert(routeSql.includes("X-Export-Row-Count"), '发电导出接口应返回 X-Export-Row-Count 行数响应头。');
  assert(routeSql.includes("Content-Disposition"), '发电导出接口应返回中文文件名 Content-Disposition 下载响应头。');
  assert(routeSql.includes("router.post('/records/import/preview', requireWritable('generation:records-import-preview')"), '发电记录导入 preview 接口应在上传落盘前挂维护态写保护。');
  assert(routeSql.includes('createGenerationRecordImportPreviewFromUpload'), '发电 preview 路由应调用上传解析预演服务。');
  assert(!routeSql.includes('.then((preview) => {\n        cleanupUploadedImportFile(req.file);'), '发电 preview 成功后应保留上传文件供审计批次追溯。');
  assert(routeSql.includes('cleanupUploadedImportFile(req.file);\n        next(error);'), '发电 preview 解析失败后仍应清理本次临时上传文件。');
  assert(routeSql.includes("router.post('/records/import/execute', requireWritable('generation:records-import-execute')"), '应提供发电记录导入 execute 接口且挂维护态写保护。');
  assert(routeSql.includes('executeGenerationRecordImport'), '发电 execute 路由应调用受控导入服务。');
  assert(!routeSql.includes("router.get('/records/export', requireWritable"), '发电导出接口是只读能力，不应挂 requireWritable。');
  assert(routeSql.includes("router.get('/records'"), '应提供发电记录列表接口。');
  assert(routeSql.includes("router.post('/records'"), '应提供发电记录新增接口。');
  assert(routeSql.includes("router.put('/records/:id'"), '应提供发电记录编辑接口。');
  assert(routeSql.includes("router.delete('/records/:id'"), '应提供发电记录作废接口。');
  assert(routeSql.includes("requireWritable('generation:create-record')"), '发电新增路由必须使用维护态写保护。');
  assert(indexSql.includes("const generationRoutes = require('./routes/generation')"), '路由入口应加载 generation 路由。');
  assert(indexSql.includes("app.use('/api/generation', generationRoutes)"), '路由入口应挂载 /api/generation。');

  const legacyDb = openDatabase();
  let migratedUnitId;
  let migratedPhotovoltaicId;
  try {
    migratedUnitId = legacyDb.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('GEN-MIGRATE', '发电迁移验收单元', '发电迁移验收单元', 'enterprise', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    migratedPhotovoltaicId = legacyDb.prepare("SELECT id FROM energy_types WHERE code = 'photovoltaic' AND is_active = 1").get().id;
    legacyDb.exec('DROP TABLE generation_records');
    legacyDb.exec(`CREATE TABLE generation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_unit_id INTEGER NOT NULL,
      energy_type_id INTEGER NOT NULL,
      normalized_month TEXT NOT NULL CHECK (
        normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
        AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      ),
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
    legacyDb.prepare("INSERT INTO generation_records (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, '2026-01', 10, 8, 2, 'manual', 'active', '旧约束迁移保留记录', datetime('now'), datetime('now'))").run(migratedUnitId, migratedPhotovoltaicId);
  } finally {
    legacyDb.close();
  }
  initDatabase();
  const migratedDb = openDatabase();
  try {
    const migratedCreateSql = migratedDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_records'").get().sql;
    assert(generationRecordsDataSourceCheckAllowsUpload(migratedCreateSql), 'initDatabase 应兼容升级旧 generation_records.data_source CHECK 以允许 upload。');
    assert.strictEqual(migratedDb.prepare("SELECT COUNT(*) AS total FROM generation_records WHERE remark = '旧约束迁移保留记录'").get().total, 1, 'generation_records 兼容升级应保留既有记录。');
    migratedDb.prepare("INSERT INTO generation_records (organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh, grid_export_value_kwh, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, '2026-02', 20, 15, 5, 'upload', 'active', '迁移后 upload 验证', datetime('now'), datetime('now'))").run(migratedUnitId, migratedPhotovoltaicId);
  } finally {
    migratedDb.close();
  }

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
  assert.strictEqual(buildGenerationMeta().importExportIncluded, true, '发电导入导出执行和前端入口已完成，常规发电 meta 应标记已包含导入导出。');
  assert.strictEqual(buildGenerationMeta().importExportStatus, 'ready', '发电 meta 应提供清晰导入导出能力状态，避免停留旧阶段。');
  assert.strictEqual(buildGenerationMeta().importExportCapabilities.importPreview, true);
  assert.strictEqual(buildGenerationMeta().importExportCapabilities.importExecute, true);
  assert.strictEqual(buildGenerationMeta().importExportCapabilities.exportCurrentFilters, true);
  assert.strictEqual(buildGenerationMeta().importExportCapabilities.frontendPanel, true);
  assert.strictEqual(buildGenerationMeta().importExportCapabilities.persistsImportBatch, true);
  assert(GENERATION_DATA_SOURCES.includes('upload'), '发电导入契约前置后 dataSource 应支持 upload。');
  const generatedHmacSecret = getGenerationRecordImportHmacSecret();
  assert.match(generatedHmacSecret, /^[0-9a-f]{64}$/, '未配置环境变量时应生成安装级随机 HMAC secret。');
  assert.strictEqual(getGenerationRecordImportHmacSecret(), generatedHmacSecret, '同一隔离实例内安装级 HMAC secret 应稳定复用。');
  const hmacMetaDb = openDatabase();
  try {
    assert.strictEqual(hmacMetaDb.prepare('SELECT value FROM app_meta WHERE key = ?').get(GENERATION_RECORD_IMPORT_HMAC_SECRET_META_KEY).value, generatedHmacSecret, '安装级 HMAC secret 应保存在 app_meta 中。');
  } finally {
    hmacMetaDb.close();
  }
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

  const recreated = createGenerationRecord({ organizationUnitId: rootUnitId, normalizedMonth: '2026-06', generationValueKwh: 200, selfUseValueKwh: 160, gridExportValueKwh: 40, dataSource: 'upload', remark: '作废后重建' });
  assert.notStrictEqual(recreated.id, created.id);
  assert.strictEqual(recreated.normalizedMonth, '2026-06');
  assert.strictEqual(recreated.dataSource, 'upload', '发电导入写入使用的 upload 数据来源应通过服务校验和数据库约束。');
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

  const exportActiveCsv = exportGenerationRecords({ format: 'csv', organizationUnitId: String(rootUnitId), monthStart: '2026-06', monthEnd: '2026-06', status: 'active' });
  const expectedExportHeaders = GENERATION_RECORD_EXPORT_FIELDS.map((field) => field.header);
  assert.strictEqual(exportActiveCsv.format, 'csv');
  assert.strictEqual(exportActiveCsv.contentType, 'text/csv; charset=utf-8');
  assert.strictEqual(exportActiveCsv.rowCount, 1, '发电 CSV 导出应复用列表筛选，仅导出当前 active 结果。');
  assert.strictEqual(exportActiveCsv.maxRows, MAX_GENERATION_RECORD_EXPORT_ROWS);
  assert.deepStrictEqual(exportActiveCsv.fields, expectedExportHeaders, '发电导出字段顺序应与 GENERATION_RECORD_EXPORT_FIELDS 一致。');
  const exportActiveCsvText = exportActiveCsv.body.toString('utf8');
  assert(exportActiveCsvText.startsWith('﻿'), '发电 CSV 导出必须带 UTF-8 BOM。');
  assert(exportActiveCsvText.includes(expectedExportHeaders.map((header) => `"${header}"`).join(',')), '发电 CSV 导出首行应为契约字段顺序。');
  assert(exportActiveCsvText.includes('"GEN-ROOT"'), '发电 CSV 导出应包含筛选内用能单元编码。');
  assert(exportActiveCsvText.includes('"2026-06"'), '发电 CSV 导出应包含筛选内月份。');
  assert(exportActiveCsvText.includes('"photovoltaic"'), '发电 CSV 导出应包含固定 photovoltaic 能源类型编码。');
  assert(exportActiveCsvText.includes('"upload"'), '发电 CSV 导出应包含记录数据来源。');
  assert(!exportActiveCsvText.includes('外购电抵扣'), '发电导出不得包含外购电抵扣字段。');
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const exportVoidCsv = exportGenerationRecords({ format: 'csv', organizationUnitId: String(rootUnitId), status: 'void' });
  assert.strictEqual(exportVoidCsv.rowCount, 1, '发电导出应支持 status=void 当前筛选。');
  assert(exportVoidCsv.body.toString('utf8').includes('"void"'), '作废筛选导出应包含 void 状态。');
  assert(exportVoidCsv.body.toString('utf8').includes('"更新后发电记录"'), '作废筛选导出应包含作废前最新记录备注。');
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const exportXlsx = exportGenerationRecords({ format: 'xlsx', organizationUnitId: String(rootUnitId), status: 'active' });
  assert.strictEqual(exportXlsx.format, 'xlsx');
  assert.strictEqual(exportXlsx.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(exportXlsx.rowCount, 1);
  assert(exportXlsx.fileName.endsWith('.xlsx'), '发电 xlsx 导出文件名应使用 xlsx 后缀。');
  const workbook = XLSX.read(exportXlsx.body, { type: 'buffer' });
  assert(workbook.SheetNames.includes('发电自用记录'), '发电 xlsx 导出应使用“发电自用记录”工作表。');
  const exportedRows = XLSX.utils.sheet_to_json(workbook.Sheets['发电自用记录'], { defval: '' });
  assert.strictEqual(exportedRows.length, 1, '发电 xlsx 导出应包含筛选后数据行。');
  assert.deepStrictEqual(Object.keys(exportedRows[0]), expectedExportHeaders, '发电 xlsx 导出列顺序应与契约一致。');
  assert.strictEqual(exportedRows[0]['用能单元编码'], 'GEN-ROOT');
  assert.strictEqual(exportedRows[0]['月份'], '2026-06');
  assert.strictEqual(exportedRows[0]['能源类型编码'], 'photovoltaic');
  assert.strictEqual(exportedRows[0]['状态'], 'active');
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const previewRows = [
    { organization_unit_code: 'GEN-ROOT', organization_unit_name: '发电验收总厂', month: '2026/08', generation_value_kwh: '300', self_use_value_kwh: '240', grid_export_value_kwh: '60', data_source: '', remark: '别名字段合法预演' },
    { '用能单元编码': 'GEN-ROOT', '月份': '2026-08', '发电量 kWh': '310', '自发自用 kWh': '250', '上网电量 kWh': '60', '数据来源': 'upload', '备注': '同文件重复后续行' },
    { '用能单元编码': 'GEN-ROOT', '用能单元名称': '发电验收总厂', '月份': '2026-06', '发电量 kWh': '200', '自发自用 kWh': '160', '上网电量 kWh': '40' },
    { '用能单元编码': 'GEN-ROOT', '用能单元名称': '不一致名称', '月份': '2026-09', '发电量 kWh': '100', '自发自用 kWh': '70', '上网电量 kWh': '20' },
    { '用能单元名称': '发电验收总厂', '月份': '2026-09', '发电量 kWh': '100', '自发自用 kWh': '70', '上网电量 kWh': '20' },
    { '用能单元编码': 'GEN-ROOT', '月份': '2026-10', '发电量 kWh': '100', '自发自用 kWh': '80', '上网电量 kWh': '30' },
    { '用能单元编码': 'GEN-ROOT', '月份': 'bad-month', '发电量 kWh': '-1', '自发自用 kWh': '0', '上网电量 kWh': '0' },
    { '用能单元编码': 'GEN-MISSING', '月份': '2026-11', '发电量 kWh': '100', '自发自用 kWh': '80', '上网电量 kWh': '20' },
    { '用能单元编码': 'GEN-INACTIVE', '用能单元名称': '停用发电单元', '月份': '2026-12', '发电量 kWh': '100', '自发自用 kWh': '80', '上网电量 kWh': '20' }
  ];
  const preview = buildGenerationRecordImportPreviewFromRows(previewRows);
  assert.strictEqual(preview.dryRun, true);
  assert.strictEqual(preview.previewOnly, true);
  assert.strictEqual(preview.writesGenerationRecords, false);
  assert.strictEqual(preview.persistsImportBatch, true);
  assert.strictEqual(preview.confirmText, '确认导入发电自用记录');
  assert.strictEqual(preview.summary.totalRows, 9);
  assert.strictEqual(preview.summary.wouldImport, 1, '仅第一条合法且无重复的行应成为候选。');
  assert.strictEqual(preview.summary.skipped, 2, '数据库已有 active 与同文件重复候选均应 skipped warning。');
  assert.strictEqual(preview.summary.blocked, 6, '格式、数值、平衡、未知/停用用能单元、名称不一致和缺少用能单元编码应 blocked。');
  assert(preview.summary.warnings >= 2, '重复 skip 应计入 warning。');
  assert(preview.summary.errors >= 5, '阻断校验应计入 error。');
  assert.deepStrictEqual(Object.keys(preview.fieldMapping).sort(), ['dataSource', 'generationValueKwh', 'gridExportValueKwh', 'normalizedMonth', 'organizationUnitCode', 'organizationUnitName', 'remark', 'selfUseValueKwh'].sort());
  assert.strictEqual(preview.items[0].status, 'wouldImport');
  assert.strictEqual(preview.items[0].values.normalizedMonth, '2026-08');
  assert.strictEqual(preview.items[0].dataSource, 'upload', '数据来源为空时 preview 默认 upload。');
  assert.strictEqual(preview.items[0].energyTypeCode, 'photovoltaic');
  assert.strictEqual(preview.items[1].status, 'skipped');
  assert(preview.items[1].reasonCodes.includes('DUPLICATE_IMPORT_CANDIDATE_SKIPPED'), '同文件重复候选后续行应 skipped warning。');
  assert.strictEqual(preview.items[2].status, 'skipped');
  assert(preview.items[2].reasonCodes.includes('DUPLICATE_ACTIVE_GENERATION_RECORD_SKIPPED'), '数据库已有 active 发电记录应 skipped warning。');
  assert(preview.items[3].reasonCodes.includes('ORGANIZATION_UNIT_NAME_MISMATCH'), '编码和名称都填且不一致时应阻断。');
  assert(preview.items[4].reasonCodes.includes('REQUIRED_FIELD_MISSING'), '缺少用能单元编码时即使名称唯一也应阻断。');
  assert(preview.items[5].reasonCodes.includes('GENERATION_BALANCE_EXCEEDED'), '自用 + 上网超过发电量时应阻断。');
  assert(preview.items[6].reasonCodes.includes('INVALID_MONTH'), '月份格式错误应阻断。');
  assert(preview.items[6].reasonCodes.includes('INVALID_NON_NEGATIVE_NUMBER'), '负数应阻断。');
  assert(preview.items[7].reasonCodes.includes('UNKNOWN_ORGANIZATION_UNIT'), '未知用能单元应阻断。');
  assert(preview.items[8].reasonCodes.includes('INACTIVE_ORGANIZATION_UNIT'), '停用用能单元应阻断。');
  assert.strictEqual(preview.candidateRows.length, 1, 'candidateRows 仅包含 wouldImport 候选。');
  assert.deepStrictEqual(preview.candidateRowIds, [2]);
  assert.strictEqual(preview.candidateRows[0].candidateRowId, `generation:${rootUnitId}:2026-08:photovoltaic`);
  assert.strictEqual(preview.candidateRows[0].organizationUnitId, rootUnitId);
  assert.strictEqual(preview.candidateRows[0].generationValueKwh, 300);
  assert(preview.previewSignature.startsWith('hmac-sha256:v1:'), 'previewSignature 应使用稳定 HMAC 前缀。');
  assert.strictEqual(preview.previewSignature, buildGenerationRecordImportPreviewFromRows(previewRows).previewSignature, '相同归一候选行和上下文应生成稳定 signature。');
  assert.strictEqual(preview.previewSignature, buildGenerationRecordImportPreviewSignature({
    candidateRows: preview.candidateRows,
    candidateRowIds: preview.candidateRowIds,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    writesGenerationRecords: preview.writesGenerationRecords,
    persistsImportBatch: preview.persistsImportBatch
  }), 'execute 仅凭 candidateRows/candidateRowIds 与关键上下文应可重算同一 signature。');
  assert.strictEqual(preview.previewSignature, buildGenerationRecordImportPreviewSignature({
    ...preview,
    previewSignature: 'ignored',
    summary: { totalRows: 999, wouldImport: 999, skipped: 999, blocked: 999, warnings: 999, errors: 999 },
    items: preview.items.map((item) => ({ ...item, status: 'blocked', reasonText: '展示字段不应影响签名' }))
  }), 'signature 不应依赖 summary/items 或 skipped/blocked 展示明细。');
  const tamperedCandidateRows = preview.candidateRows.map((row) => ({ ...row, generationValueKwh: row.generationValueKwh + 1 }));
  assert.notStrictEqual(preview.previewSignature, buildGenerationRecordImportPreviewSignature({
    candidateRows: tamperedCandidateRows,
    candidateRowIds: preview.candidateRowIds,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    writesGenerationRecords: preview.writesGenerationRecords,
    persistsImportBatch: preview.persistsImportBatch
  }), '改变候选行关键字段必须改变 signature。');
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const csvPath = path.join(tmpDir, 'generation-preview.csv');
  fs.writeFileSync(csvPath, `用能单元编码,用能单元名称,月份,发电量 kWh,自发自用 kWh,上网电量 kWh,数据来源,备注\nGEN-ROOT,发电验收总厂,2026-11,120,90,30,upload,CSV预演\n`, 'utf8');
  const csvPreview = createGenerationRecordImportPreviewFromUpload({ path: csvPath, originalname: 'generation-preview.csv' });
  assert.strictEqual(csvPreview.summary.wouldImport, 1, 'CSV 上传解析后合法行应 wouldImport。');
  assert.strictEqual(csvPreview.candidateRows[0].normalizedMonth, '2026-11');
  assert.strictEqual(csvPreview.candidateRows[0].generationValueKwh, 120);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const xlsxPath = path.join(tmpDir, 'generation-preview.xlsx');
  const importWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(importWorkbook, XLSX.utils.json_to_sheet([{ '用能单元编码': 'GEN-ROOT', '用能单元名称': '发电验收总厂', '月份': '2026.12', '发电量 kWh': 180, '自发自用 kWh': 120, '上网电量 kWh': 60, '数据来源': 'upload', '备注': 'XLSX预演' }]), '导入');
  XLSX.writeFile(importWorkbook, xlsxPath);
  const xlsxPreview = createGenerationRecordImportPreviewFromUpload({ path: xlsxPath, originalname: 'generation-preview.xlsx' });
  assert.strictEqual(xlsxPreview.summary.wouldImport, 1, 'xlsx 上传解析后合法行应 wouldImport。');
  assert.strictEqual(xlsxPreview.candidateRows[0].normalizedMonth, '2026-12');
  assert.strictEqual(xlsxPreview.candidateRows[0].selfUseValueKwh, 120);
  assertUnchangedEnergyAndCarbon(beforeCounts);

  const afterPreviewDb = openDatabase();
  try {
    const afterPreviewCounts = getCounts(afterPreviewDb);
    assert.strictEqual(afterPreviewCounts.generationRecords, beforeCounts.generationRecords + 2, '发电导入 preview 不得写入 generation_records。');
    assert.strictEqual(afterPreviewCounts.energyRecords, beforeCounts.energyRecords, '发电导入 preview 不得写入 energy_records。');
    assert.strictEqual(afterPreviewCounts.carbonEmissions, beforeCounts.carbonEmissions, '发电导入 preview 不得写入 carbon_emissions。');
  } finally {
    afterPreviewDb.close();
  }

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
