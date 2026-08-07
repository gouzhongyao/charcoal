const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const rootDir = path.resolve(__dirname, '..');
const integrationDataDir = path.join(rootDir, 'data', 'integration-smoke');
const specialRootDir = path.join(integrationDataDir, 'special-cases');
const defaultRunId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runId = sanitizeRunId(process.env.SPECIAL_VERIFY_RUN_ID || defaultRunId);
// 专项验证管理员密码：仅用于脚本生成的隔离 SQLite，不作用于真实业务数据库。
const specialVerificationAdminPassword = 'SpecialVerifyAdmin123!';

function sanitizeRunId(value) {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || defaultRunId;
}

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function assertPathInside(baseDir, targetPath, label) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  assert(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), `${label} 必须位于 ${base} 下。`, {
    base,
    target
  });
}

function ensureScenarioEnv(name) {
  const scenarioDir = path.join(specialRootDir, runId, name);
  const dataDir = path.join(scenarioDir, 'data');
  const uploadsDir = path.join(scenarioDir, 'uploads');
  const backupsDir = path.join(scenarioDir, 'backups');
  const sqlitePath = path.join(scenarioDir, `${name}.sqlite`);
  [scenarioDir, dataDir, uploadsDir, backupsDir].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  [scenarioDir, dataDir, uploadsDir, backupsDir, sqlitePath].forEach((target) => assertPathInside(specialRootDir, target, `${name} 路径`));
  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.BACKUPS_DIR = backupsDir;
  process.env.SQLITE_PATH = sqlitePath;
  process.env.CHARCOAL_ADMIN_PASSWORD = process.env.CHARCOAL_ADMIN_PASSWORD || specialVerificationAdminPassword;
  return { scenarioDir, dataDir, uploadsDir, backupsDir, sqlitePath };
}

function getSchemaSql() {
  return fs.readFileSync(path.join(rootDir, 'server', 'src', 'db', 'schema.sql'), 'utf8');
}

function replaceCarbonEmissionsWithLegacyCheck(db) {
  db.exec('DROP INDEX IF EXISTS ux_carbon_emissions_record_method');
  db.exec('DROP TABLE IF EXISTS carbon_emissions');
  db.exec(`CREATE TABLE carbon_emissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    energy_record_id INTEGER NOT NULL,
    carbon_factor_id INTEGER,
    calculation_method TEXT NOT NULL DEFAULT 'standard-factor',
    calculation_basis TEXT NOT NULL DEFAULT 'normalized_value * factor_value',
    factor_value REAL CHECK (factor_value IS NULL OR factor_value > 0),
    activity_value REAL NOT NULL CHECK (activity_value >= 0),
    activity_unit TEXT NOT NULL,
    emission_value REAL CHECK (emission_value IS NULL OR emission_value >= 0),
    emission_unit TEXT NOT NULL DEFAULT 'kgCO2e',
    status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'factor_missing', 'invalid_record')),
    calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    note TEXT,
    FOREIGN KEY (energy_record_id) REFERENCES energy_records(id) ON DELETE CASCADE,
    FOREIGN KEY (carbon_factor_id) REFERENCES carbon_factors(id) ON DELETE SET NULL,
    CHECK (status <> 'calculated' OR (carbon_factor_id IS NOT NULL AND factor_value IS NOT NULL AND emission_value IS NOT NULL))
  )`);
}

function insertEnergyRecord(db, duplicateKey, month = '2026-01') {
  const energyType = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  const result = db.prepare(`INSERT INTO energy_records (
    energy_type_id, original_month, normalized_month, original_unit, original_value,
    normalized_unit, normalized_value, organization, site, department, meter_code, duplicate_key, record_status
  ) VALUES (
    @energyTypeId, @month, @month, 'kWh', @value,
    'kWh', @value, '专项验证组织', '专项验证园区', '验证部', @meterCode, @duplicateKey, 'active'
  )`).run({
    energyTypeId: energyType.id,
    month,
    value: month === '2026-02' ? 200 : 100,
    meterCode: duplicateKey,
    duplicateKey
  });
  return result.lastInsertRowid;
}

function scenarioMigration() {
  const env = ensureScenarioEnv('migration');
  let db = new Database(env.sqlitePath);
  db.pragma('foreign_keys = ON');
  db.exec(getSchemaSql());
  replaceCarbonEmissionsWithLegacyCheck(db);
  const recordId = insertEnergyRecord(db, 'migration-record', '2026-01');
  const factorType = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  const factor = db.prepare(`INSERT INTO carbon_factors (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
    VALUES (?, 'default', 2026, 'kWh', 0.58, 'kgCO2e', 'legacy', 1)`).run(factorType.id);
  const emission = db.prepare(`INSERT INTO carbon_emissions (
    energy_record_id, carbon_factor_id, factor_value, activity_value, activity_unit, emission_value, emission_unit, status, note
  ) VALUES (?, ?, 0.58, 100, 'kWh', 58, 'kgCO2e', 'calculated', 'legacy row')`).run(recordId, factor.lastInsertRowid);
  db.close();

  const { initDatabase, openDatabase, carbonEmissionsStatusCheckAllowsSuperseded } = require('../server/src/db/database');
  initDatabase();
  db = openDatabase();
  try {
    const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'carbon_emissions'").get().sql;
    assert(carbonEmissionsStatusCheckAllowsSuperseded(createSql), '旧库初始化后 carbon_emissions.status CHECK 应允许 superseded。', { createSql });
    const row = db.prepare('SELECT id, status, emission_value AS emissionValue, note FROM carbon_emissions WHERE id = ?').get(emission.lastInsertRowid);
    assert(row && row.status === 'calculated' && row.emissionValue === 58, '旧库迁移后应保留既有排放数据。', row);
    db.prepare("UPDATE carbon_emissions SET status = 'superseded' WHERE id = ?").run(emission.lastInsertRowid);
    const migrated = db.prepare('SELECT status FROM carbon_emissions WHERE id = ?').get(emission.lastInsertRowid);
    assert(migrated.status === 'superseded', '旧库迁移后应可将既有结果标记为 superseded。', migrated);
    return { ok: true, scenario: 'migration', sqlitePath: env.sqlitePath, preservedEmissionId: emission.lastInsertRowid };
  } finally {
    db.close();
  }
}

function scenarioInactiveFactor() {
  const env = ensureScenarioEnv('inactive-factor');
  const { initDatabase, openDatabase } = require('../server/src/db/database');
  const { calculateCarbonEmissions, upsertCarbonFactor } = require('../server/src/services/carbonAccountingService');
  initDatabase();
  let db = openDatabase();
  try {
    insertEnergyRecord(db, 'inactive-factor-record', '2026-01');
  } finally {
    db.close();
  }

  const inactiveFactor = upsertCarbonFactor({
    energyTypeCode: 'electricity',
    region: 'default',
    factorYear: 2026,
    unit: 'kWh',
    factorValue: 0.58,
    factorUnit: 'kgCO2e',
    source: 'inactive-factor',
    isActive: false
  });
  assert(inactiveFactor.status === 'inactive', '测试碳因子应先处于停用状态。', inactiveFactor);

  const missing = calculateCarbonEmissions({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '2026-01', region: 'default' });
  assert(missing.calculatedCount === 0 && missing.missingFactorCount === 1, '只有停用因子时，碳核算应返回 factor_missing，不应使用停用因子计算。', missing);

  const activeFactor = upsertCarbonFactor({
    energyTypeCode: 'electricity',
    region: 'default',
    factorYear: 2026,
    unit: 'kWh',
    factorValue: 0.62,
    factorUnit: 'kgCO2e',
    source: 'active-factor',
    isActive: true
  });
  assert(activeFactor.status === 'active', '测试碳因子应可创建启用版本。', activeFactor);

  const calculated = calculateCarbonEmissions({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '2026-01', region: 'default' });
  assert(calculated.calculatedCount === 1 && calculated.missingFactorCount === 0, '存在启用因子时，碳核算应使用启用因子计算。', calculated);
  assert(calculated.calculated[0].carbonFactorId === activeFactor.id, '碳核算应匹配启用因子而不是停用因子。', { calculated, activeFactor, inactiveFactor });

  db = openDatabase();
  try {
    const rows = db.prepare('SELECT status, carbon_factor_id AS factorId FROM carbon_emissions ORDER BY id ASC').all();
    assert(rows.some((row) => row.status === 'superseded'), '启用因子重算后旧 factor_missing 结果应被 superseded。', rows);
    assert(rows.some((row) => row.status === 'calculated' && row.factorId === activeFactor.id), '当前 active 结果应为启用因子的 calculated。', rows);
    return { ok: true, scenario: 'inactive-factor', sqlitePath: env.sqlitePath, inactiveFactorId: inactiveFactor.id, activeFactorId: activeFactor.id };
  } finally {
    db.close();
  }
}

function removeSqliteSidecars(sqlitePath) {
  [`${sqlitePath}-wal`, `${sqlitePath}-shm`].forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  });
}

function scenarioBackupRestore() {
  const env = ensureScenarioEnv('backup-restore');
  const { initDatabase, openDatabase } = require('../server/src/db/database');
  initDatabase();
  let db = openDatabase();
  try {
    insertEnergyRecord(db, 'backup-before', '2026-01');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  const backupPath = path.join(env.backupsDir, `energy-carbon-${runId}.sqlite`);
  assertPathInside(env.backupsDir, backupPath, 'backupPath');
  fs.copyFileSync(env.sqlitePath, backupPath);

  db = openDatabase();
  try {
    insertEnergyRecord(db, 'backup-after', '2026-02');
    const beforeRestoreCount = db.prepare('SELECT COUNT(*) AS count FROM energy_records').get().count;
    assert(beforeRestoreCount === 2, '恢复前应包含备份前和备份后的两条记录。', { beforeRestoreCount });
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  removeSqliteSidecars(env.sqlitePath);
  fs.copyFileSync(backupPath, env.sqlitePath);

  db = openDatabase();
  try {
    const rows = db.prepare('SELECT duplicate_key AS duplicateKey, normalized_month AS month FROM energy_records ORDER BY id ASC').all();
    assert(rows.length === 1, '文件级恢复后应回到备份时的数据数量。', rows);
    assert(rows[0].duplicateKey === 'backup-before' && rows[0].month === '2026-01', '文件级恢复后应保留备份时数据并移除备份后数据。', rows);
    return { ok: true, scenario: 'backup-restore', sqlitePath: env.sqlitePath, backupPath, restoredRows: rows.length };
  } finally {
    db.close();
  }
}

async function scenarioMaintenanceState() {
  const { assertWritableAllowed, getMaintenanceState, runWithMaintenance } = require('../server/src/services/maintenanceState');
  const { requireWritable } = require('../server/src/middleware/maintenance');
  const { createImportBatchFromUpload, deleteImportBatch } = require('../server/src/services/importService');
  const { deleteBackup } = require('../server/src/services/backupService');

  assert(getMaintenanceState().active === false, '初始状态不应处于维护态。', getMaintenanceState());
  await runWithMaintenance('special:restore', async () => {
    const state = getMaintenanceState();
    assert(state.active === true && state.operation === 'special:restore', 'runWithMaintenance 应进入维护态。', state);
    let blocked = null;
    try {
      assertWritableAllowed('special:write');
    } catch (error) {
      blocked = error;
    }
    assert(blocked && blocked.code === 'MAINTENANCE_IN_PROGRESS' && blocked.statusCode === 423, '维护态应拒绝写操作并返回 MAINTENANCE_IN_PROGRESS。', blocked);

    const middleware = requireWritable('special:route-write');
    let middlewareError = null;
    middleware({ method: 'POST', originalUrl: '/api/imports/batches' }, {}, (error) => {
      middlewareError = error || null;
    });
    assert(middlewareError && middlewareError.code === 'MAINTENANCE_IN_PROGRESS', '维护态中受保护路由中间件应拒绝写请求。', middlewareError);

    let serviceCreateError = null;
    try {
      createImportBatchFromUpload(null);
    } catch (error) {
      serviceCreateError = error;
    }
    assert(serviceCreateError && serviceCreateError.code === 'MAINTENANCE_IN_PROGRESS', '维护态中导入创建服务入口应兜底拒绝写入。', serviceCreateError);

    let serviceDeleteError = null;
    try {
      deleteImportBatch('1');
    } catch (error) {
      serviceDeleteError = error;
    }
    assert(serviceDeleteError && serviceDeleteError.code === 'MAINTENANCE_IN_PROGRESS', '维护态中批次删除服务入口应兜底拒绝写入。', serviceDeleteError);

    let backupDeleteError = null;
    try {
      deleteBackup('energy-carbon-maintenance.sqlite');
    } catch (error) {
      backupDeleteError = error;
    }
    assert(backupDeleteError && backupDeleteError.code === 'MAINTENANCE_IN_PROGRESS' && backupDeleteError.statusCode === 423, '维护态中备份删除服务入口应兜底拒绝写入。', backupDeleteError);
  });
  assert(getMaintenanceState().active === false, '维护态完成后必须释放。', getMaintenanceState());
  return { ok: true, scenario: 'maintenance-state' };
}

async function listenLocal(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (!port) {
        server.close();
        reject(new Error('未能启动本地专项路由验证服务。'));
        return;
      }
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

// 维护态路由请求模块：统一发送隔离环境中的受保护写请求。
async function requestMaintenanceRoute(apiBase, route, token = null) {
  // 请求头：按请求体和有效会话分别附加内容类型与 Bearer Token。
  const headers = {
    ...(route.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  const response = await fetch(`${apiBase}${route.path}`, {
    method: route.method,
    headers,
    body: route.body ? JSON.stringify(route.body) : undefined
  });
  const body = await response.json();
  return { route: `${route.method} ${route.path}`, status: response.status, body };
}

// 未认证验证模块：确认认证中间件优先于维护态写保护执行。
async function requestUnauthenticatedWrite(apiBase, route) {
  const result = await requestMaintenanceRoute(apiBase, route);
  assert(result.status === 401 && result.body && result.body.success === false && result.body.error && result.body.error.code === 'UNAUTHENTICATED', '维护态中的未认证写请求应优先返回 401 / UNAUTHENTICATED。', { route, status: result.status, body: result.body });
  return { route: result.route, status: result.status, code: result.body.error.code };
}

// 已认证验证模块：确认有效会话通过认证后由维护态写保护返回 423。
async function requestMaintenanceBlocked(apiBase, route, token) {
  const result = await requestMaintenanceRoute(apiBase, route, token);
  assert(result.status === 423 && result.body && result.body.success === false && result.body.error && result.body.error.code === 'MAINTENANCE_IN_PROGRESS', '维护态中的已认证写请求应返回 423 / MAINTENANCE_IN_PROGRESS。', { route, status: result.status, body: result.body });
  return { route: result.route, status: result.status, code: result.body.error.code };
}

async function scenarioMaintenanceRoutes() {
  const env = ensureScenarioEnv('maintenance-routes');
  const { initDatabase } = require('../server/src/db/database');
  const { app } = require('../server/src/index');
  const { login } = require('../server/src/services/authService');
  const { runWithMaintenance } = require('../server/src/services/maintenanceState');
  initDatabase();
  // 管理员令牌：在进入维护态前由隔离数据库创建，用于验证认证后的写保护语义。
  const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
  const { server, port } = await listenLocal(app);
  const apiBase = `http://127.0.0.1:${port}/api`;
  const routes = [
    { method: 'POST', path: '/imports/batches' },
    { method: 'DELETE', path: '/imports/batches/1' },
    { method: 'POST', path: '/carbon/factors', body: { energyTypeCode: 'electricity' } },
    { method: 'PATCH', path: '/carbon/factors/1/status', body: { status: 'inactive' } },
    { method: 'POST', path: '/carbon/emissions/calculate', body: {} },
    { method: 'POST', path: '/predictions/runs', body: {} },
    { method: 'POST', path: '/system/backups' },
    { method: 'POST', path: '/system/backups/energy-carbon-missing.sqlite/restore' },
    { method: 'DELETE', path: '/system/backups/energy-carbon-missing.sqlite' }
  ];

  try {
    const results = await runWithMaintenance('special:route-matrix', async () => {
      // 未认证结果：先覆盖专项脚本列出的 9 条受保护写路由矩阵，锁定生产路由的认证优先顺序。
      const unauthenticated = [];
      for (const route of routes) {
        unauthenticated.push(await requestUnauthenticatedWrite(apiBase, route));
      }
      // 维护态结果：再使用有效 Bearer Token 验证受保护写路由统一返回 423。
      const blocked = [];
      for (const route of routes) {
        blocked.push(await requestMaintenanceBlocked(apiBase, route, adminToken));
      }
      return { unauthenticated, blocked };
    });
    return { ok: true, scenario: 'maintenance-routes', sqlitePath: env.sqlitePath, apiBase, results };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runScenarioInChild(scenario) {
  const scenarioDir = path.join(specialRootDir, runId, scenario);
  const env = {
    ...process.env,
    SPECIAL_VERIFY_RUN_ID: runId,
    SPECIAL_VERIFY_SCENARIO_DIR: scenarioDir
  };
  const result = spawnSync(process.execPath, [__filename, scenario], {
    cwd: rootDir,
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`专项验证场景 ${scenario} 失败。\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  return JSON.parse(lastLine);
}

async function main() {
  fs.mkdirSync(specialRootDir, { recursive: true });
  assertPathInside(integrationDataDir, specialRootDir, 'specialRootDir');

  const scenario = process.argv[2];
  if (scenario === 'migration') {
    console.log(JSON.stringify(scenarioMigration()));
    return;
  }
  if (scenario === 'inactive-factor') {
    console.log(JSON.stringify(scenarioInactiveFactor()));
    return;
  }
  if (scenario === 'backup-restore') {
    console.log(JSON.stringify(scenarioBackupRestore()));
    return;
  }
  if (scenario === 'maintenance-state') {
    console.log(JSON.stringify(await scenarioMaintenanceState()));
    return;
  }
  if (scenario === 'maintenance-routes') {
    console.log(JSON.stringify(await scenarioMaintenanceRoutes()));
    return;
  }

  const results = ['migration', 'inactive-factor', 'backup-restore', 'maintenance-state', 'maintenance-routes'].map(runScenarioInChild);
  console.log(JSON.stringify({
    ok: true,
    runId,
    specialRootDir: path.join(specialRootDir, runId),
    results
  }, null, 2));
}

main().catch((error) => {
  console.error('special cases verification failed');
  console.error(error.stack || error.message);
  if (error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
