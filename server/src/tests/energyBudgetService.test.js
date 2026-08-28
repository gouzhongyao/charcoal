const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Excel 文件解析模块，用于校验预算模板首行和工作表名称。
const XLSX = require('xlsx');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-budget-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-budget.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { ensureEnergyBudgetsTable, initDatabase, openDatabase } = require('../db/database');
const {
  WHOLE_ORGANIZATION_SCOPE,
  getEnergyBudgetContract,
  buildEnergyBudgetImportPreviewFromRows,
  buildEnergyBudgetStats,
  ENERGY_BUDGET_EXPORT_FIELDS,
  ENERGY_BUDGET_IMPORT_CONFIRM_TEXT,
  ENERGY_BUDGET_IMPORT_HEADERS,
  executeEnergyBudgetImport,
  exportEnergyBudgets,
  getEnergyBudgetExecutionComparison,
  listEnergyBudgets,
  normalizeMonth,
  normalizeOrganizationScope,
  setEnergyBudgetStatus,
  updateEnergyBudget,
  upsertEnergyBudget
} = require('../services/energyBudgetService');
const { getTemplateCsv, getTemplateDefinition, getTemplateXlsx } = require('../services/templateService');

// 用能预算模板的独立中文标题契约，避免测试直接复用生产常量而同步改错。
const EXPECTED_ENERGY_BUDGET_TEMPLATE_HEADERS = Object.freeze([
  '预算月份', '能源类型编码', '组织范围', '预算值', '单位', '备注', '状态'
]);

// 重建隔离测试库，验证旧结构被拒绝后可以按正式 canonical schema 重新开始。
function resetIsolatedDatabase() {
  [process.env.SQLITE_PATH, `${process.env.SQLITE_PATH}-wal`, `${process.env.SQLITE_PATH}-shm`]
    .forEach((filePath) => fs.rmSync(filePath, { force: true }));
  initDatabase();
}

function seedBaseData() {
  const db = openDatabase();
  try {
    const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const heatId = db.prepare("SELECT id FROM energy_types WHERE code = 'heat'").get().id;
    const rootUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('BUD-ROOT', '预算总厂', '预算总厂', 'enterprise', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    const workshopUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('BUD-WS', '预算车间', '预算总厂/预算车间', 'workshop', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    const otherUnitId = db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('BUD-OTHER', '其它车间', '预算总厂/其它车间', 'workshop', 'active', datetime('now'), datetime('now'))").run().lastInsertRowid;
    const insertEnergy = db.prepare(`INSERT INTO energy_records (
      energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, duplicate_key, record_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);
    insertEnergy.run(electricityId, workshopUnitId, '2026-08', '2026-08', 'kWh', 40, 'kWh', 40, 'budget-electricity-1', 'active');
    insertEnergy.run(electricityId, workshopUnitId, '2026-08', '2026-08', 'kWh', 30, 'kWh', 30, 'budget-electricity-2', 'active');
    insertEnergy.run(electricityId, workshopUnitId, '2026-08', '2026-08', 'kWh', 999, 'kWh', 999, 'budget-electricity-void', 'void');
    insertEnergy.run(electricityId, otherUnitId, '2026-08', '2026-08', 'kWh', 20, 'kWh', 20, 'budget-electricity-other', 'active');
    insertEnergy.run(heatId, rootUnitId, '2026-08', '2026-08', 'MJ', 300, 'MJ', 300, 'budget-heat-1', 'active');
    return { electricityId, heatId, rootUnitId, workshopUnitId, otherUnitId };
  } finally {
    db.close();
  }
}

// 执行比较测试数据写入模块：显式控制月份、单位、组织和状态，覆盖单位安全与组织隔离场景。
function insertComparisonEnergyRecord(input) {
  const db = openDatabase();
  try {
    db.prepare(`INSERT INTO energy_records (
      energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, duplicate_key, record_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(
        input.energyTypeId,
        input.organizationUnitId,
        input.periodMonth,
        input.periodMonth,
        input.unit,
        input.value,
        input.unit,
        input.value,
        input.duplicateKey,
        input.recordStatus || 'active'
      );
  } finally {
    db.close();
  }
}

(async () => {
try {
  initDatabase();

  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const databaseSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');
  const serviceSql = fs.readFileSync(path.join(__dirname, '..', 'services', 'energyBudgetService.js'), 'utf8');
  const routeSql = fs.readFileSync(path.join(__dirname, '..', 'routes', 'energyBudgets.js'), 'utf8');
  const indexSql = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const contractSql = fs.readFileSync(path.join(__dirname, '..', 'services', 'contractService.js'), 'utf8');
  const packageJson = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8');

  assert(schemaSql.includes('CREATE TABLE IF NOT EXISTS energy_budgets'), 'schema 应创建 energy_budgets 表。');
  assert(schemaSql.includes('UNIQUE (period_month, energy_type_id, organization_scope)'), 'energy_budgets 应限制月份 + 能源类型 + 组织范围唯一。');
  assert(schemaSql.includes("status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))"), '预算应采用 active/inactive 软状态。');
  assert(databaseSql.includes('ensureEnergyBudgetsTable'), 'database 初始化应提供 energy_budgets 兼容建表逻辑。');
  assert.strictEqual(typeof ensureEnergyBudgetsTable, 'function', 'ensureEnergyBudgetsTable 应导出便于隔离迁移验证。');
  assert(routeSql.includes("router.get('/execution-comparison'"), '预算路由应提供执行对比接口。');
  assert(routeSql.includes("requireWritable('energy:budget:create')"), '预算创建路由应挂维护态写保护。');
  assert(routeSql.includes("authenticate, requirePermission('energy:budget:view')"), '预算读取路由应挂认证和预算查看权限。');
  assert(routeSql.includes("requirePermission('energy:budget:import')"), '预算导入路由应挂预算导入权限。');
  assert(indexSql.includes("const energyBudgetRoutes = require('./routes/energyBudgets')"), '服务入口应加载预算路由。');
  assert(indexSql.includes("app.use('/api/energy-budgets', energyBudgetRoutes)"), '服务入口应挂载 /api/energy-budgets。');
  assert(contractSql.includes('getEnergyBudgetContract'), '契约服务应导出用能预算契约。');
  assert(packageJson.includes('node server/src/tests/energyBudgetService.test.js'), '预算测试应纳入 test:logic 和 check 常规脚本。');
  assert(serviceSql.includes("er.record_status = 'active'"), '执行对比只能汇总 active energy_records。');
  assert(serviceSql.includes("status: 'active'"), '执行对比默认只读取 active 预算。');
  assert(serviceSql.includes('不做跨能源折标煤'), '预算执行对比应明确不做跨能源折标煤。');
  assert(!/INSERT\s+INTO\s+carbon_emissions|UPDATE\s+carbon_emissions|DELETE\s+FROM\s+carbon_emissions/i.test(serviceSql), '预算 P0 不得写入碳核算结果。');
  assert(!/prediction_runs|prediction_results/i.test(serviceSql), '预算 P0 不得联动预测。');

  const legacyDb = openDatabase();
  try {
    legacyDb.exec('DROP TABLE energy_budgets');
    assert.strictEqual(ensureEnergyBudgetsTable(legacyDb), true, '旧库缺少 energy_budgets 时应兼容补建。');
    assert.strictEqual(ensureEnergyBudgetsTable(legacyDb), false, '重复执行兼容建表应幂等。');
    assert.strictEqual(legacyDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'energy_budgets'").get().total, 1);

    legacyDb.exec('DROP TABLE energy_budgets');
    legacyDb.exec(`CREATE TABLE energy_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_month TEXT NOT NULL,
      energy_type_id INTEGER NOT NULL,
      organization_scope TEXT NOT NULL DEFAULT '整体',
      budget_value REAL NOT NULL CHECK (budget_value >= 0),
      unit TEXT NOT NULL,
      remark TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (period_month, energy_type_id, organization_scope)
    );
    CREATE INDEX idx_energy_budgets_month_type_status ON energy_budgets(period_month, energy_type_id, status);
    CREATE INDEX idx_energy_budgets_scope_status ON energy_budgets(organization_scope, status);`);
    const legacyElectricityId = legacyDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    legacyDb.prepare("INSERT INTO energy_budgets (period_month, energy_type_id, organization_scope, budget_value, unit, remark) VALUES ('2026-07', ?, '旧库预算范围', 66, 'kWh', '迁移保留')")
      .run(legacyElectricityId);
  } finally {
    legacyDb.close();
  }

  assert.throws(
    () => initDatabase(),
    (error) => error.code === 'SCHEMA_FINGERPRINT_MISMATCH',
    '正式 canonical 初始化必须拒绝被替换为旧结构的 energy_budgets，而不是自动补列迁移。'
  );
  resetIsolatedDatabase();
  initDatabase();
  const canonicalBudgetDb = openDatabase();
  try {
    const canonicalColumns = canonicalBudgetDb.prepare('PRAGMA table_info(energy_budgets)').all().map((column) => column.name);
    assert(canonicalColumns.includes('source_batch_id'));
    assert(canonicalColumns.includes('source_row_number'));
    assert.strictEqual(canonicalBudgetDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'index' AND name = 'idx_energy_budgets_batch'").get().total, 1);
  } finally {
    canonicalBudgetDb.close();
  }

  const ids = seedBaseData();
  assert.strictEqual(normalizeMonth('2026/8'), '2026-08');
  assert.strictEqual(normalizeOrganizationScope(''), WHOLE_ORGANIZATION_SCOPE);
  assert.throws(
    () => normalizeMonth('2026-13'),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH'
  );

  const created = upsertEnergyBudget({ periodMonth: '2026/08', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: '100', remark: '首条预算' });
  assert.strictEqual(created.periodMonth, '2026-08');
  assert.strictEqual(created.energyTypeCode, 'electricity');
  assert.strictEqual(created.organizationScope, '预算车间');
  assert.strictEqual(created.budgetValue, 100);
  assert.strictEqual(created.unit, 'kWh', '未传单位时应默认使用能源类型标准单位。');
  assert.strictEqual(created.status, 'active');

  const upserted = upsertEnergyBudget({ periodMonth: '2026-08', energyTypeId: ids.electricityId, organizationScope: '预算车间', budgetValue: 87.5, unit: 'kWh', remark: '重复 key 更新' });
  assert.strictEqual(upserted.id, created.id, '重复月份 + 能源类型 + 组织范围应更新既有预算。');
  assert.strictEqual(upserted.budgetValue, 87.5);
  assert.strictEqual(listEnergyBudgets({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '预算车间' }).pagination.total, 1);

  const wholeBudget = upsertEnergyBudget({ periodMonth: '2026-08', energyTypeCode: 'heat', budgetValue: 500, unit: 'MJ' });
  assert.strictEqual(wholeBudget.organizationScope, WHOLE_ORGANIZATION_SCOPE);

  const activeComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(activeComparison.rows.length, 1);
  assert.strictEqual(activeComparison.rows[0].budgetId, created.id);
  assert.strictEqual(activeComparison.rows[0].budgetValue, 87.5);
  assert.strictEqual(activeComparison.rows[0].actualValue, 70, '执行对比应汇总同月同能源同组织范围 active 能耗，不含 void。');
  assert.strictEqual(activeComparison.rows[0].actualRecordCount, 2);
  assert.strictEqual(activeComparison.rows[0].budgetUnit, 'kWh');
  assert.strictEqual(activeComparison.rows[0].actualUnit, 'kWh');
  assert.strictEqual(activeComparison.rows[0].comparisonStatus, 'comparable');
  assert.strictEqual(activeComparison.rows[0].isComparable, true);
  assert.strictEqual(activeComparison.rows[0].variance, -17.5);
  assert.strictEqual(activeComparison.rows[0].usageRate, 0.8);
  assert.strictEqual(activeComparison.rows[0].overBudget, false);
  assert.strictEqual(activeComparison.rows[0].warningLevel, 'nearing', '80% 边界应触发接近预算预警。');
  assert.strictEqual(activeComparison.rows[0].warningLabel, '接近预算');
  assert(activeComparison.rows[0].warningReason.includes('80%'));
  assert.strictEqual(activeComparison.summary.nearingCount, 1);
  assert.strictEqual(activeComparison.summary.exceededCount, 0);
  assert.strictEqual(activeComparison.summary.missingBudgetCount, 0);
  assert.strictEqual(activeComparison.summary.warningThreshold.nearingPercent, 80);

  const wholeComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-08', energyTypeCode: 'heat' });
  assert.strictEqual(wholeComparison.rows.length, 1);
  assert.strictEqual(wholeComparison.rows[0].organizationScope, WHOLE_ORGANIZATION_SCOPE);
  assert.strictEqual(wholeComparison.rows[0].actualValue, 300, '整体预算不限制组织范围。');
  assert.strictEqual(wholeComparison.summary.totalBudgetValue, 500);
  assert.strictEqual(wholeComparison.summary.totalActualValue, 300);
  assert.strictEqual(wholeComparison.meta.actualRecordStatus, 'active');
  assert.strictEqual(wholeComparison.meta.warningThreshold.exceededPercent, 100);
  assert.strictEqual(wholeComparison.rows[0].warningLevel, 'normal', '60% 使用率应保持 normal。');
  assert.strictEqual(wholeComparison.summary.nearingCount, 0);
  assert.strictEqual(wholeComparison.summary.exceededCount, 0);

  const exceededBudget = upsertEnergyBudget({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '其它车间', budgetValue: 20, unit: 'kWh' });
  const exceededComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '其它车间' });
  assert.strictEqual(exceededComparison.rows[0].budgetId, exceededBudget.id);
  assert.strictEqual(exceededComparison.rows[0].actualValue, 20);
  assert.strictEqual(exceededComparison.rows[0].usageRate, 1);
  assert.strictEqual(exceededComparison.rows[0].overBudget, true, '100% 边界应按超预算处理。');
  assert.strictEqual(exceededComparison.rows[0].warningLevel, 'exceeded');
  assert.strictEqual(exceededComparison.rows[0].warningLabel, '超预算');
  assert.strictEqual(exceededComparison.summary.exceededCount, 1);

  const inactive = setEnergyBudgetStatus(created.id, { status: 'inactive' });
  assert.strictEqual(inactive.status, 'inactive');
  const inactiveComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(inactiveComparison.rows.length, 1, '无 active 预算但有精确筛选时应返回无预算边界行。');
  assert.strictEqual(inactiveComparison.rows[0].budgetId, null);
  assert.strictEqual(inactiveComparison.rows[0].budgetStatus, 'none');
  assert.strictEqual(inactiveComparison.rows[0].actualValue, 70, '停用预算不参与对比，但实际值仍可作为无预算边界展示。');
  assert.strictEqual(inactiveComparison.rows[0].usageRate, null);
  assert.strictEqual(inactiveComparison.rows[0].warningLevel, 'missing_budget');
  assert.strictEqual(inactiveComparison.rows[0].warningLabel, '未配置预算');
  assert.strictEqual(inactiveComparison.summary.missingBudgetCount, 1);

  const noActualBudget = upsertEnergyBudget({ periodMonth: '2026-09', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: 50, unit: 'kWh' });
  const noActualComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-09', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(noActualComparison.rows[0].budgetId, noActualBudget.id);
  assert.strictEqual(noActualComparison.rows[0].actualValue, 0);
  assert.strictEqual(noActualComparison.rows[0].actualRecordCount, 0);
  assert.strictEqual(noActualComparison.rows[0].usageRate, 0);
  assert.strictEqual(noActualComparison.rows[0].warningLevel, 'normal', '有预算但无实际值不应触发接近或超预算。');
  assert.strictEqual(noActualComparison.summary.nearingCount, 0);
  assert.strictEqual(noActualComparison.summary.exceededCount, 0);

  const noBudgetNoActual = getEnergyBudgetExecutionComparison({ periodMonth: '2026-10', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(noBudgetNoActual.rows.length, 1);
  assert.strictEqual(noBudgetNoActual.rows[0].budgetId, null);
  assert.strictEqual(noBudgetNoActual.rows[0].actualValue, 0);
  assert.strictEqual(noBudgetNoActual.rows[0].comparisonStatus, 'no_data');
  assert.strictEqual(noBudgetNoActual.rows[0].warningLevel, 'normal', '无预算且无实际值不应误报未配置预算。');
  assert.strictEqual(noBudgetNoActual.summary.budgetRowCount, 0);
  assert.strictEqual(noBudgetNoActual.summary.missingBudgetCount, 0);

  // 全年无预算但存在实际用能时，年度范围必须从实际组合生成 missing_budget 行。
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2030-01',
    unit: 'kWh',
    value: 12,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-annual-no-budget'
  });
  const annualMissingBudget = getEnergyBudgetExecutionComparison({ monthStart: '2030-01', monthEnd: '2030-12', energyTypeCode: 'electricity' });
  assert.strictEqual(annualMissingBudget.rows.length, 1, '全年没有 active 预算时也必须返回实际用能组合。');
  assert.strictEqual(annualMissingBudget.rows[0].organizationScope, '预算车间');
  assert.strictEqual(annualMissingBudget.rows[0].actualValue, 12);
  assert.strictEqual(annualMissingBudget.rows[0].actualUnit, 'kWh');
  assert.strictEqual(annualMissingBudget.rows[0].comparisonStatus, 'missing_budget');
  assert.strictEqual(annualMissingBudget.rows[0].warningLevel, 'missing_budget');
  assert.strictEqual(annualMissingBudget.summary.missingBudgetCount, 1);

  // 部分月份有预算时，未配置预算的月份仍应独立进入并集结果。
  upsertEnergyBudget({ periodMonth: '2031-01', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: 100, unit: 'kWh' });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2031-01',
    unit: 'kWh',
    value: 40,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-partial-budget-january'
  });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2031-02',
    unit: 'kWh',
    value: 25,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-partial-budget-february'
  });
  const partialBudgetComparison = getEnergyBudgetExecutionComparison({ monthStart: '2031-01', monthEnd: '2031-12', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.deepStrictEqual(partialBudgetComparison.rows.map((row) => row.periodMonth), ['2031-01', '2031-02']);
  assert.strictEqual(partialBudgetComparison.rows[0].comparisonStatus, 'comparable');
  assert.strictEqual(partialBudgetComparison.rows[0].usageRate, 0.4);
  assert.strictEqual(partialBudgetComparison.rows[1].comparisonStatus, 'missing_budget');
  assert.strictEqual(partialBudgetComparison.summary.missingBudgetCount, 1);

  // 同能源混合 kWh/MWh 时必须拆成两行，且不同单位行不得计算使用率或伪装单位。
  upsertEnergyBudget({ periodMonth: '2032-01', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: 100, unit: 'kWh' });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2032-01',
    unit: 'kWh',
    value: 40,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-mixed-unit-kwh'
  });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2032-01',
    unit: 'MWh',
    value: 2,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-mixed-unit-mwh'
  });
  const mixedUnitComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2032-01', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(mixedUnitComparison.rows.length, 2);
  const comparableKwhRow = mixedUnitComparison.rows.find((row) => row.actualUnit === 'kWh');
  const mismatchMwhRow = mixedUnitComparison.rows.find((row) => row.actualUnit === 'MWh');
  assert.strictEqual(comparableKwhRow.budgetUnit, 'kWh');
  assert.strictEqual(comparableKwhRow.comparisonStatus, 'comparable');
  assert.strictEqual(comparableKwhRow.actualValue, 40);
  assert.strictEqual(comparableKwhRow.usageRate, 0.4);
  assert.strictEqual(mismatchMwhRow.unit, 'kWh', '兼容 unit 字段继续表示预算单位。');
  assert.strictEqual(mismatchMwhRow.budgetUnit, 'kWh');
  assert.strictEqual(mismatchMwhRow.actualUnit, 'MWh');
  assert.strictEqual(mismatchMwhRow.actualValue, 2);
  assert.strictEqual(mismatchMwhRow.comparisonStatus, 'unit_mismatch');
  assert.strictEqual(mismatchMwhRow.isComparable, false);
  assert.strictEqual(mismatchMwhRow.usageRate, null);
  assert.strictEqual(mismatchMwhRow.variance, null);
  assert.strictEqual(mismatchMwhRow.warningLevel, 'unit_mismatch');
  assert.strictEqual(mixedUnitComparison.summary.unitMismatchCount, 1);
  assert.strictEqual(mixedUnitComparison.summary.totalBudgetValue, null, '多单位摘要不得直接输出跨单位标量合计。');
  assert.strictEqual(mixedUnitComparison.summary.totalActualValue, null, '多单位摘要不得直接输出跨单位标量合计。');
  assert.deepStrictEqual(mixedUnitComparison.summary.totalsByUnit.map((row) => row.unit).sort(), ['MWh', 'kWh']);

  // 预算单位与唯一实际单位不一致时，也必须返回明确的不可比较状态。
  upsertEnergyBudget({ periodMonth: '2033-01', energyTypeCode: 'heat', organizationScope: '预算车间', budgetValue: 1, unit: 'GJ' });
  insertComparisonEnergyRecord({
    energyTypeId: ids.heatId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2033-01',
    unit: 'MJ',
    value: 300,
    organization: '预算总厂',
    site: 'A园区',
    department: '预算车间',
    duplicateKey: 'budget-unit-mismatch-heat'
  });
  const unitMismatchComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2033-01', energyTypeCode: 'heat', organizationScope: '预算车间' });
  assert.strictEqual(unitMismatchComparison.rows.length, 1);
  assert.strictEqual(unitMismatchComparison.rows[0].budgetUnit, 'GJ');
  assert.strictEqual(unitMismatchComparison.rows[0].actualUnit, 'MJ');
  assert.strictEqual(unitMismatchComparison.rows[0].comparisonStatus, 'unit_mismatch');
  assert.strictEqual(unitMismatchComparison.rows[0].usageRate, null);
  assert.strictEqual(unitMismatchComparison.rows[0].overBudget, false);
  assert.strictEqual(unitMismatchComparison.summary.unitMismatchCount, 1);

  // 组织范围筛选必须隔离其它组织的同月同能源实际记录。
  upsertEnergyBudget({ periodMonth: '2034-01', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: 100, unit: 'kWh' });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.workshopUnitId,
    periodMonth: '2034-01',
    unit: 'kWh',
    value: 30,
    duplicateKey: 'budget-scope-workshop'
  });
  insertComparisonEnergyRecord({
    energyTypeId: ids.electricityId,
    organizationUnitId: ids.otherUnitId,
    periodMonth: '2034-01',
    unit: 'kWh',
    value: 70,
    duplicateKey: 'budget-scope-other'
  });
  const isolatedScopeComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2034-01', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(isolatedScopeComparison.rows.length, 1);
  assert.strictEqual(isolatedScopeComparison.rows[0].actualValue, 30);
  assert.strictEqual(isolatedScopeComparison.rows[0].actualRecordCount, 1);
  assert.strictEqual(isolatedScopeComparison.rows[0].usageRate, 0.3);

  const zeroBudget = upsertEnergyBudget({ periodMonth: '2026-11', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: 0, unit: 'kWh' });
  const zeroActualDb = openDatabase();
  try {
    zeroActualDb.prepare(`INSERT INTO energy_records (
      energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, duplicate_key, record_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(ids.electricityId, ids.workshopUnitId, '2026-11', '2026-11', 'kWh', 10, 'kWh', 10, 'budget-zero-actual', 'active');
  } finally {
    zeroActualDb.close();
  }
  const zeroBudgetComparison = getEnergyBudgetExecutionComparison({ periodMonth: '2026-11', energyTypeCode: 'electricity', organizationScope: '预算车间' });
  assert.strictEqual(zeroBudgetComparison.rows[0].budgetId, zeroBudget.id);
  assert.strictEqual(zeroBudgetComparison.rows[0].budgetValue, 0);
  assert.strictEqual(zeroBudgetComparison.rows[0].actualValue, 10);
  assert.strictEqual(zeroBudgetComparison.rows[0].usageRate, null, '预算值为 0 时避免除零，使用率保持 null。');
  assert.strictEqual(zeroBudgetComparison.rows[0].overBudget, true);
  assert.strictEqual(zeroBudgetComparison.rows[0].warningLevel, 'exceeded', '预算值为 0 且有实际值按超预算预警处理。');
  assert(zeroBudgetComparison.rows[0].warningReason.includes('预算值为 0'));
  assert.strictEqual(zeroBudgetComparison.summary.exceededCount, 1);

  const updated = updateEnergyBudget(noActualBudget.id, { periodMonth: '2026-09', energyTypeCode: 'electricity', organizationScope: '预算总厂', budgetValue: 60, status: 'active', remark: '改组织范围' });
  assert.strictEqual(updated.organizationScope, '预算总厂');
  assert.strictEqual(updated.budgetValue, 60);
  assert.throws(
    () => updateEnergyBudget(updated.id, { periodMonth: '2026-08', energyTypeCode: 'heat', organizationScope: WHOLE_ORGANIZATION_SCOPE, budgetValue: 100 }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'DUPLICATE_ENERGY_BUDGET'
  );
  assert.throws(
    () => upsertEnergyBudget({ periodMonth: '2026-08', energyTypeCode: 'electricity', organizationScope: '预算车间', budgetValue: -1 }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_NON_NEGATIVE_NUMBER'
  );
  assert.throws(
    () => setEnergyBudgetStatus(wholeBudget.id, { status: 'deleted' }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_ENERGY_BUDGET_VALUE'
  );

  // 统一列表：关键字、组合筛选和分页均复用当前查询口径。
  upsertEnergyBudget({ periodMonth: '2026-12', energyTypeCode: 'heat', organizationScope: '预算车间', budgetValue: 20, unit: 'MJ', remark: '关键字命中' });
  const filtered = listEnergyBudgets({ periodMonth: '2026-12', energyTypeCode: 'heat', organizationScope: '预算车间', keyword: '关键字', page: 1, pageSize: 1 });
  assert.strictEqual(filtered.pagination.total, 1);
  assert.strictEqual(filtered.rows.length, 1);
  assert.strictEqual(filtered.rows[0].remark, '关键字命中');
  const paged = listEnergyBudgets({ page: 2, pageSize: 2 });
  assert.strictEqual(paged.pagination.page, 2);
  assert(paged.pagination.total >= 2 && paged.rows.length <= 2);

  const stats = buildEnergyBudgetStats({ periodMonth: '2026-12', keyword: '关键字' });
  assert.strictEqual(stats.totalBudgets, 1);
  assert.strictEqual(stats.activeCount, 1);
  assert.strictEqual(stats.inactiveCount, 0);
  assert.strictEqual(stats.byEnergyType[0].energyTypeCode, 'heat');
  assert.strictEqual(stats.byOrganizationScope[0].organizationScope, '预算车间');
  assert.strictEqual(stats.monthlyTrend[0].periodMonth, '2026-12');

  const exported = exportEnergyBudgets({ format: 'csv', periodMonth: '2026-12', keyword: '关键字' });
  assert.strictEqual(exported.rowCount, 1);
  assert.deepStrictEqual(exported.fields, ENERGY_BUDGET_EXPORT_FIELDS.map((field) => field.header));
  assert(exported.body.toString('utf8').includes('关键字命中'));
  assert(!exported.body.toString('utf8').includes('首条预算'));
  const exportedXlsx = exportEnergyBudgets({ format: 'xlsx', periodMonth: '2026-12', keyword: '关键字' });
  assert(exportedXlsx.body.length > 0 && exportedXlsx.rowCount === 1);

  const budgetTemplate = getTemplateDefinition('energy-budgets');
  assert(budgetTemplate, '应注册 energy-budgets 模板。');
  assert.deepStrictEqual(budgetTemplate.headers, EXPECTED_ENERGY_BUDGET_TEMPLATE_HEADERS);
  assert.deepStrictEqual(ENERGY_BUDGET_IMPORT_HEADERS, EXPECTED_ENERGY_BUDGET_TEMPLATE_HEADERS);
  assert.strictEqual(new Set(budgetTemplate.headers).size, budgetTemplate.headers.length, '用能预算模板表头不得重复。');
  const budgetTemplateCsv = getTemplateCsv('energy-budgets').csv;
  assert.strictEqual(
    budgetTemplateCsv.replace(/^﻿/, '').split(/\r?\n/, 1)[0],
    EXPECTED_ENERGY_BUDGET_TEMPLATE_HEADERS.map((header) => `"${header}"`).join(','),
    '用能预算 CSV 模板首行必须完整使用中文标题并保持固定顺序。'
  );
  assert(!budgetTemplateCsv.includes('energyTypeCode') && !budgetTemplateCsv.includes('energy_type_code'), '新预算模板不得暴露历史英文技术标题。');
  const budgetTemplateXlsx = getTemplateXlsx('energy-budgets');
  const budgetTemplateWorkbook = XLSX.read(budgetTemplateXlsx.buffer, { type: 'buffer' });
  assert.deepStrictEqual(budgetTemplateWorkbook.SheetNames, ['用能预算导入模板']);
  assert.deepStrictEqual(
    XLSX.utils.sheet_to_json(budgetTemplateWorkbook.Sheets['用能预算导入模板'], { header: 1, blankrows: false })[0],
    EXPECTED_ENERGY_BUDGET_TEMPLATE_HEADERS,
    '用能预算 Excel 模板首行必须完整使用中文标题并保持固定顺序。'
  );

  const importRows = [
    { periodMonth: '2027/01', energyTypeCode: 'electricity', organizationScope: '预算导入车间', budgetValue: '88', unit: 'kWh', remark: '待导入预算', status: 'active' },
    { periodMonth: '2027-01', energyTypeCode: 'electricity', organizationScope: '预算导入车间', budgetValue: '99', unit: 'kWh', remark: '重复候选', status: 'active' },
    { periodMonth: 'bad-month', energyTypeCode: 'heat', organizationScope: '整体', budgetValue: '3', unit: 'MJ', remark: '错误行', status: 'active' }
  ];
  const importPreview = buildEnergyBudgetImportPreviewFromRows(importRows);
  assert.strictEqual(importPreview.dryRun, true);
  assert.strictEqual(importPreview.writesEnergyBudgets, false);
  assert.strictEqual(importPreview.summary.wouldImport, 1);
  assert.strictEqual(importPreview.summary.skipped, 1);
  assert.strictEqual(importPreview.summary.blocked, 1);
  assert.strictEqual(listEnergyBudgets({ periodMonth: '2027-01' }).pagination.total, 0, 'preview 不得写入预算记录。');
  const buildImportBody = (overrides = {}) => ({
    confirmText: ENERGY_BUDGET_IMPORT_CONFIRM_TEXT,
    previewSignature: importPreview.previewSignature,
    expectedWouldImport: importPreview.summary.wouldImport,
    candidateRowIds: importPreview.candidateRowIds,
    candidateRows: importPreview.candidateRows,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    ...overrides
  });
  await assert.rejects(executeEnergyBudgetImport(buildImportBody({ confirmText: '错误确认文本' })), (error) => error.details?.code === 'ENERGY_BUDGET_IMPORT_CONFIRM_TEXT_MISMATCH');
  await assert.rejects(executeEnergyBudgetImport(buildImportBody({ previewSignature: `${importPreview.previewSignature}-tampered` })), (error) => error.details?.code === 'ENERGY_BUDGET_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
  const importResult = await executeEnergyBudgetImport(buildImportBody());
  assert.strictEqual(importResult.executed, true);
  assert.strictEqual(importResult.imported, 1);
  assert.strictEqual(importResult.writesEnergyBudgets, true);
  assert.strictEqual(listEnergyBudgets({ periodMonth: '2027-01', organizationScope: '预算导入车间' }).pagination.total, 1);
  const duplicatePreview = buildEnergyBudgetImportPreviewFromRows(importRows);
  assert.strictEqual(duplicatePreview.summary.wouldImport, 0);
  assert.strictEqual(duplicatePreview.summary.skipped, 2, '已存在预算与同文件重复均应保留 skip warning。');

  const contract = getEnergyBudgetContract();
  assert.strictEqual(contract.status, 'unified-management-api-ready');
  assert(contract.executionComparisonPolicy.includes('停用预算不参与'));
  assert(contract.executionComparisonPolicy.includes('80% 接近预算'));
  assert(contract.executionComparisonPolicy.includes('100% 超预算'));
  assert(contract.executionComparisonPolicy.includes('unit_mismatch'));
  assert(contract.executionComparisonPolicy.includes('不做单位换算'));
  assert(contract.executionComparisonPolicy.includes('跨能源折标煤'));
  assert.deepStrictEqual(contract.comparisonStatuses, ['comparable', 'no_actual', 'missing_budget', 'unit_mismatch', 'no_data']);
  assert.deepStrictEqual(contract.warningLevels, ['normal', 'nearing', 'exceeded', 'missing_budget', 'unit_mismatch']);

  console.log('energy budget service tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
