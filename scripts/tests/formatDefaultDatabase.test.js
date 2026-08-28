'use strict';

/**
 * 默认数据库格式化 CLI 的隔离验证。
 * 所有 SQLite、uploads、backups 和故障注入均位于系统临时目录，不启动或停止项目服务。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-format-default-test-'));
const dataDir = path.join(isolationRoot, 'data');
const databasePath = path.join(dataDir, 'energy-carbon.sqlite');
const uploadsDir = path.join(dataDir, 'uploads');
const backupsDir = path.join(dataDir, 'backups');
const skippedCapabilities = [];
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(backupsDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT = isolationRoot;
process.env.DATA_DIR = dataDir;
process.env.SQLITE_PATH = databasePath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.BACKUPS_DIR = backupsDir;
process.env.CHARCOAL_ADMIN_PASSWORD = 'isolated-test-password';

const Database = require('better-sqlite3');
const formatter = require('../format-default-database');
const {
  initDatabase,
  openDatabase,
  calculateSchemaFingerprint,
  matchTrustedCanonicalSchemaProfile,
  CANONICAL_SCHEMA_VERSION
} = require('../../server/src/db/database');

/** 对文件建立测试基线，确保 dry-run 未产生 mutation。 */
function fileState(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const stat = fs.statSync(targetPath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex') };
}

/** 对隔离目录完成当前代码的真实 schema/RBAC 初始化。 */
function resetDatabase() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  initDatabase({ databasePath });
}

/** 从 schema.sql 精确提取指定 CREATE TABLE 语句，避免 predecessor 夹具复制 SQL 漂移。 */
function extractCreateTableStatement(schemaText, tableName) {
  const prefix = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\b`, 'i');
  const match = prefix.exec(schemaText);
  assert(match, `schema.sql 缺少 ${tableName} 建表语句。`);
  let depth = 0;
  let quote = null;
  for (let index = match.index; index < schemaText.length; index += 1) {
    const character = schemaText[index];
    if (quote) {
      if (character === quote) {
        if (schemaText[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (["'", '"', '`'].includes(character)) quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ';' && depth === 0) return schemaText.slice(match.index, index + 1);
  }
  throw new Error(`${tableName} 建表语句未闭合。`);
}

/** 按顶层逗号拆分策略规则字段和表级约束，保留嵌套 CHECK 表达式。 */
function splitSqlDefinitionClauses(definitionSql) {
  const clauses = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < definitionSql.length; index += 1) {
    const character = definitionSql[index];
    if (quote) {
      if (character === quote) {
        if (definitionSql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (["'", '"', '`'].includes(character)) quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      clauses.push(definitionSql.slice(start, index).trim());
      start = index + 1;
    }
  }
  clauses.push(definitionSql.slice(start).trim());
  return clauses.filter(Boolean);
}

/** 判断策略规则字段或表级约束是否属于 v3 新增 provenance 合同。 */
function isStrategyRulesProvenanceClause(clause) {
  const normalized = clause.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(source_batch_id|source_row_number)\b/i.test(clause)
    || /^foreign key\s*\(\s*source_batch_id\s*\)/i.test(clause)
    || (normalized.startsWith('check (')
      && normalized.includes('source_batch_id')
      && normalized.includes('source_row_number'));
}

/** 从当前 schema 精确生成 strategy_rules v2 predecessor 建表 SQL。 */
function buildStrategyRulesPredecessorSql() {
  const schemaText = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'src', 'db', 'schema.sql'), 'utf8');
  const canonicalSql = extractCreateTableStatement(schemaText, 'strategy_rules');
  const bodyStart = canonicalSql.indexOf('(');
  const bodyEnd = canonicalSql.lastIndexOf(')');
  const clauses = splitSqlDefinitionClauses(canonicalSql.slice(bodyStart + 1, bodyEnd));
  const removed = clauses.filter(isStrategyRulesProvenanceClause);
  const predecessorClauses = clauses.filter((clause) => !isStrategyRulesProvenanceClause(clause));
  assert.strictEqual(removed.length, 4, 'strategy_rules v3 provenance 必须恰好包含四个新增片段。');
  assert(!predecessorClauses.some((clause) => /source_batch_id|source_row_number/i.test(clause)),
    'strategy_rules v2 predecessor 不得残留 provenance 字段或约束。');
  return `CREATE TABLE strategy_rules (\n  ${predecessorClauses.join(',\n  ')}\n);`;
}

/** 将 v3 strategy_rules 精确还原为唯一 v2 predecessor，保留历史行、索引、触发器和序列。 */
function rebuildStrategyRulesWithoutProvenance(db) {
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  const oldColumns = [
    'id', 'rule_code', 'rule_name', 'rule_version', 'formula_version', 'metric_code',
    'threshold_operator', 'threshold_value', 'threshold_min', 'threshold_max',
    'threshold_unit', 'reduction_rate', 'priority', 'evidence_requirements_json',
    'recommendation_text', 'source', 'effective_start_utc', 'effective_end_utc',
    'source_timezone', 'status', 'created_at', 'updated_at'
  ];
  const oldRows = db.prepare(`SELECT ${oldColumns.join(', ')} FROM strategy_rules ORDER BY id`).all();
  const sequenceRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'strategy_rules'").get();
  const oldMaxId = oldRows.reduce((maximum, row) => Math.max(maximum, Number(row.id)), 0);
  const preservedIndexes = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'strategy_rules' AND sql IS NOT NULL ORDER BY name"
  ).all().map((row) => row.sql);
  const preservedTriggers = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'strategy_rules' AND sql IS NOT NULL ORDER BY name"
  ).all().map((row) => row.sql);
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('DROP TABLE IF EXISTS temp.strategy_rules__fixture');
    db.exec('CREATE TEMP TABLE strategy_rules__fixture AS SELECT * FROM strategy_rules ORDER BY id');
    db.exec('DROP TABLE strategy_rules');
    db.exec(buildStrategyRulesPredecessorSql());
    db.exec(`INSERT INTO strategy_rules (${oldColumns.join(', ')})
      SELECT ${oldColumns.join(', ')} FROM temp.strategy_rules__fixture ORDER BY id`);
    preservedIndexes.forEach((sql) => db.exec(sql));
    preservedTriggers.forEach((sql) => db.exec(sql));
    const targetSequence = Math.max(Number(sequenceRow?.seq || 0), oldMaxId);
    if (sequenceRow) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'strategy_rules'").run(targetSequence);
    else if (targetSequence > 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('strategy_rules', ?)").run(targetSequence);
    db.exec('DROP TABLE temp.strategy_rules__fixture');
  } finally {
    if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
  }
  assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
  assert.deepStrictEqual(
    db.prepare(`SELECT ${oldColumns.join(', ')} FROM strategy_rules ORDER BY id`).all(),
    oldRows,
    'strategy_rules predecessor 夹具必须逐值保留历史业务行。'
  );
}

/** 将当前隔离库精确还原为唯一 v2 predecessor，用于验证 v2 来源到 fresh v3 candidate。 */
function prepareExactPredecessor() {
  const db = openDatabase({ databasePath });
  try {
    rebuildStrategyRulesWithoutProvenance(db);
    const fingerprint = calculateSchemaFingerprint(db);
    const trustedPredecessor = matchTrustedCanonicalSchemaProfile(db, formatter.PREDECESSOR_VERSION);
    assert.strictEqual(trustedPredecessor.fingerprint, fingerprint,
      'v2 fixture 必须命中 database.js strategy_rules provenance predecessor profile。');
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'").run(formatter.PREDECESSOR_VERSION);
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'").run(fingerprint);
    return fingerprint;
  } finally {
    db.close();
  }
}

/** 读取业务数据和 runtime 快照，避免使用宽泛 SQL 清空来掩盖格式化行为。 */
function businessSnapshot() {
  const db = openDatabase({ databasePath });
  try {
    return {
      energy: db.prepare('SELECT COUNT(*) AS count FROM energy_records').get().count,
      organization: db.prepare('SELECT COUNT(*) AS count FROM organization_units').get().count,
      runtime: db.prepare('SELECT enabled, runtime_epoch AS epoch, revision, change_reason AS reason FROM demo_runtime_settings').get()
    };
  } finally {
    db.close();
  }
}

/** 为测试准备可识别的业务事实、开启 runtime 并留下上传文件。 */
function seedDirtyState() {
  const db = openDatabase({ databasePath });
  try {
    const energyTypeId = db.prepare('SELECT id FROM energy_types ORDER BY id LIMIT 1').get().id;
    const unitId = db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type) VALUES ('TEST-UNIT', '测试单元', '/', 'enterprise')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key)
      VALUES (?, ?, '2026-01', '2026-01', 'kWh', 12, 'kWh', 12, 'test-dirty-record')`).run(energyTypeId, unitId);
    db.prepare(`UPDATE demo_runtime_settings
      SET enabled = 1, runtime_epoch = 12, revision = 12, updated_by = NULL, change_reason = 'test_dirty' WHERE id = 1`).run();
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(uploadsDir, 'dirty-upload.txt'), 'dirty');
}

/** 通过真实 parser 与 request builder 注入“无写入者”结果，不查询或停止任何真实进程。 */
const safeWriterHook = async (paths) => formatter._test.inspectWindowsWriters(paths, {
  runtimeEnvironment: { backendPort: 3002, frontendPort: 7777 },
  runWriterInspection: () => ({ locked: [], listeners: [], projectProcesses: [] })
});

/** 断言异步函数以指定错误码 fail-closed。 */
async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

/** 构造纯 lstat 描述对象，保证无 symlink 权限时仍覆盖链接安全分支。 */
function buildStatDescriptor(overrides = {}) {
  return {
    isSymbolicLink: false,
    isReparsePoint: false,
    isFile: true,
    isDirectory: false,
    nlink: 1,
    ...overrides
  };
}

/** 注入第二次 fsync（父目录）故障，第一次 marker 文件内容 fsync 仍真实执行。 */
function buildParentFsyncFailureOperations(errorCode) {
  let fsyncCount = 0;
  const fakeDirectoryDescriptor = 424242;
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (targetPath, flags, ...rest) => flags === 'r'
          ? fakeDirectoryDescriptor
          : target.openSync(targetPath, flags, ...rest);
      }
      if (property === 'fsyncSync') {
        return (descriptor) => {
          fsyncCount += 1;
          if (fsyncCount === 2) {
            const error = new Error(`injected directory fsync ${errorCode}`);
            error.code = errorCode;
            throw error;
          }
          if (descriptor === fakeDirectoryDescriptor) return undefined;
          return target.fsyncSync(descriptor);
        };
      }
      if (property === 'closeSync') {
        return (descriptor) => {
          if (descriptor === fakeDirectoryDescriptor) return undefined;
          return target.closeSync(descriptor);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** 主测试流程，覆盖成功、回滚、marker 诊断和零副作用检查。 */
async function run() {
  resetDatabase();
  assert.strictEqual(formatter.CANONICAL_VERSION, CANONICAL_SCHEMA_VERSION,
    'formatter current 必须直接跟随 database.js 的 canonical v3。');
  assert.strictEqual(formatter.PREDECESSOR_VERSION, '2026-08-27-formal-canonical-v2',
    'formatter 唯一 predecessor 必须是 strategy_rules provenance v2。');
  assert.throws(
    () => formatter.validateDatabaseFile(
      require('../../server/src/db/database'),
      databasePath,
      '2026-08-26-formal-canonical-v1'
    ),
    (error) => error && error.code === 'SCHEMA_IDENTITY_INVALID',
    'v1 不得作为 formatter accepted predecessor。'
  );
  fs.writeFileSync(path.join(backupsDir, 'keep-existing.bin'), 'keep me');
  seedDirtyState();
  const predecessorFingerprint = prepareExactPredecessor();
  const beforeDb = fileState(databasePath);
  const beforeWal = fileState(`${databasePath}-wal`);
  const beforeShm = fileState(`${databasePath}-shm`);
  const beforeUploads = formatter.snapshotTree(uploadsDir);
  const beforeBackups = formatter.snapshotTree(backupsDir);
  const beforeReadOnlyBoundary = formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir });

  const checkResult = await formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } });
  assert.equal(checkResult.mode, 'check');
  assert.equal(checkResult.schemaVersion, formatter.PREDECESSOR_VERSION);
  assert.equal(checkResult.schemaFingerprint, predecessorFingerprint);
  assert.deepEqual(fileState(databasePath), beforeDb, 'dry-run 不得修改主数据库');
  assert.deepEqual(fileState(`${databasePath}-wal`), beforeWal, 'dry-run 不得修改 WAL');
  assert.deepEqual(fileState(`${databasePath}-shm`), beforeShm, 'dry-run 不得修改 SHM');
  assert.deepEqual(formatter.snapshotTree(uploadsDir), beforeUploads, 'dry-run 不得修改 uploads');
  assert.deepEqual(formatter.snapshotTree(backupsDir), beforeBackups, 'dry-run 不得修改 backups');
  assert.deepEqual(
    formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir }),
    beforeReadOnlyBoundary,
    'check 前后 data、DB sidecar、uploads 和 backups 的存在性、mtime、大小、摘要必须不变'
  );

  // data 递归快照必须覆盖 marker、marker temp、candidate、旧库 sidecar 和 uploads staging 的嵌套内容。
  const residualFixturePaths = [
    path.join(dataDir, formatter.MARKER_NAME),
    path.join(dataDir, `${formatter.MARKER_NAME}.tmp-4242`),
    path.join(dataDir, '.format-candidate-snapshot.sqlite'),
    path.join(dataDir, '.format-old-snapshot.sqlite'),
    path.join(dataDir, '.format-old-snapshot.sqlite-wal'),
    path.join(dataDir, '.format-old-snapshot.sqlite-shm')
  ];
  residualFixturePaths.forEach((targetPath) => fs.writeFileSync(targetPath, path.basename(targetPath)));
  const uploadsStagingFixture = path.join(dataDir, '.format-uploads-snapshot');
  fs.mkdirSync(path.join(uploadsStagingFixture, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(uploadsStagingFixture, 'nested', 'payload.bin'), 'nested residual');
  const residualBoundary = formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir });
  const residualRelativePaths = residualBoundary.dataTree.entries.map((item) => item.relative);
  residualFixturePaths.forEach((targetPath) => assert(residualRelativePaths.includes(path.basename(targetPath))));
  assert(residualRelativePaths.includes('.format-uploads-snapshot/nested/payload.bin'));
  const concurrentResidualPath = path.join(dataDir, '.format-candidate-snapshot.sqlite');
  await assertCode(formatter._test.runWithReadOnlyBoundary(
    { dataDir, databasePath, uploadsDir, backupsDir },
    async () => {
      fs.appendFileSync(concurrentResidualPath, 'concurrent mutation');
      return { checked: true };
    }
  ), 'READ_ONLY_STATE_CHANGED');
  fs.rmSync(path.join(dataDir, formatter.MARKER_NAME), { force: true });
  fs.rmSync(path.join(dataDir, `${formatter.MARKER_NAME}.tmp-4242`), { force: true });
  fs.rmSync(path.join(dataDir, '.format-candidate-snapshot.sqlite'), { force: true });
  fs.rmSync(path.join(dataDir, '.format-old-snapshot.sqlite'), { force: true });
  fs.rmSync(path.join(dataDir, '.format-old-snapshot.sqlite-wal'), { force: true });
  fs.rmSync(path.join(dataDir, '.format-old-snapshot.sqlite-shm'), { force: true });
  fs.rmSync(uploadsStagingFixture, { recursive: true, force: true });

  assert.equal(formatter.parseArgs([]).mode, 'check');
  assert.equal(formatter.parseArgs(['--check']).mode, 'check');
  assert.equal(formatter.parseArgs(['--verify']).mode, 'verify');
  assert.equal(formatter.parseArgs(['--execute', formatter.CONFIRM_TEXT]).confirmation, formatter.CONFIRM_TEXT);
  assert.equal(formatter.parseArgs(['--execute', 'FORMAT data/energy-carbon.sqlite']).mode, 'execute');
  assert.throws(() => formatter.parseArgs(['--force']), (error) => error.code === 'INVALID_ARGUMENTS');
  await assertCode(formatter.execute({ testIsolationRoot: isolationRoot, confirmation: 'bad', hooks: { inspectWriters: safeWriterHook } }), 'CONFIRMATION_REQUIRED');
  assert.throws(() => formatter.resolveContext({ testIsolationRoot: path.resolve(projectRootForTestOutside()) }), (error) => error.code === 'TEST_ROOT_OUTSIDE_TEMP');
  const mismatchedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-format-mismatched-root-'));
  try {
    assert.throws(() => formatter.resolveContext({ testIsolationRoot: mismatchedRoot }), (error) => error.code === 'TEST_PATH_NOT_ISOLATED');
  } finally {
    fs.rmSync(mismatchedRoot, { recursive: true, force: true });
  }
  const originalIsolationEnvironmentRoot = process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT;
  delete process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT;
  assert.throws(() => formatter.resolveContext(), (error) => error.code === 'TEST_ROOT_REQUIRED');
  process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT = originalIsolationEnvironmentRoot;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => formatter.resolveContext({ testIsolationRoot: isolationRoot }), (error) => error.code === 'TEST_GATE_REQUIRED');
  process.env.NODE_ENV = originalNodeEnv;

  // 保持一个独立 SQLite 连接制造 WAL 快照；afterBackupValidated 关闭它，测试不启动服务。
  const walWriter = new Database(databasePath);
  walWriter.pragma('journal_mode = WAL');
  walWriter.pragma('wal_autocheckpoint = 0');
  walWriter.prepare(`INSERT INTO energy_records
    (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
     original_value, normalized_unit, normalized_value, duplicate_key)
    SELECT energy_type_id, organization_unit_id, '2026-02', '2026-02', 'kWh', 13, 'kWh', 13, 'wal-dirty-record'
    FROM energy_records WHERE duplicate_key = 'test-dirty-record'`).run();
  assert(fs.existsSync(`${databasePath}-wal`), 'WAL 场景必须真实产生 sidecar');
  const success = await formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      afterBackupValidated: async ({ backup }) => {
        const backupDb = new Database(backup.path, { readonly: true, fileMustExist: true });
        try { assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM energy_records WHERE duplicate_key = 'wal-dirty-record'").get().count, 1); } finally { backupDb.close(); }
        [`${backup.path}-wal`, `${backup.path}-shm`].forEach((target) => fs.rmSync(target, { force: true }));
        walWriter.close();
      }
    }
  });
  assert.equal(success.status, 'completed');
  assert.equal(success.schemaVersion, CANONICAL_SCHEMA_VERSION);
  assert.equal(success.backupsAfter, success.backupsBefore + 1);
  assert.equal(success.uploadsCleared, true);
  assert.equal(formatter.snapshotTree(uploadsDir).length, 0);
  assert.equal(businessSnapshot().energy, 0);
  assert.deepEqual(businessSnapshot().runtime, { enabled: 0, epoch: 1, revision: 1, reason: 'schema_default' });
  assert.equal(formatter.snapshotTree(backupsDir).find((item) => item.relative === 'keep-existing.bin').sha256, crypto.createHash('sha256').update('keep me').digest('hex'));
  assert.equal(formatter.snapshotTree(backupsDir).length, beforeBackups.length + 1);
  const verifyBoundaryBefore = formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir });
  assert.equal((await formatter.verify({ testIsolationRoot: isolationRoot })).marker, null);
  const verifyBoundaryAfter = formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir });
  assert.deepEqual(verifyBoundaryAfter, verifyBoundaryBefore, 'verify 前后 data、DB sidecar、uploads 和 backups 的存在性、mtime、大小、摘要必须不变');
  const firstVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
  const secondVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert.deepEqual(firstVerify, secondVerify, '重复 verify 必须幂等且只读');
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  const missingUploadsBoundaryBefore = formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir });
  const missingUploadsVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert.deepEqual(formatter._test.snapshotReadOnlyBoundary({ dataDir, databasePath, uploadsDir, backupsDir }), missingUploadsBoundaryBefore, 'uploads 缺失时 verify 不得创建目录');
  assert.equal(missingUploadsVerify.uploadsState, 'missing');
  assert.match(missingUploadsVerify.nextAction, /uploads 目录缺失/);
  fs.mkdirSync(uploadsDir, { recursive: true });

  // 新增表、索引或触发器后伪造 app_meta fingerprint，仍必须被可信 profile 拒绝。
  for (const forgedObjectSql of [
    'CREATE TABLE forged_schema_table (id INTEGER PRIMARY KEY)',
    'CREATE INDEX forged_schema_index ON energy_types(code)',
    "CREATE TRIGGER forged_schema_trigger AFTER INSERT ON energy_types BEGIN SELECT 1; END"
  ]) {
    resetDatabase();
    prepareExactPredecessor();
    const forgedDb = openDatabase({ databasePath });
    try {
      forgedDb.exec(forgedObjectSql);
      const forgedFingerprint = calculateSchemaFingerprint(forgedDb);
      forgedDb.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_fingerprint'").run(forgedFingerprint);
    } finally {
      forgedDb.close();
    }
    await assertCode(formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } }), 'SCHEMA_FINGERPRINT_INVALID');
  }
  // candidate seed 必须精确核对菜单合同、super_admin grant 集合和能源类型单位内容。
  resetDatabase();
  let candidateDb = openDatabase({ databasePath });
  try {
    candidateDb.prepare("UPDATE sys_menus SET route_path = '/tampered-dashboard' WHERE permission_code = 'dashboard:view'").run();
  } finally {
    candidateDb.close();
  }
  await assertCode(Promise.resolve().then(() => formatter.validateCandidate(require('../../server/src/db/database'), databasePath)), 'CANDIDATE_MENU_INVALID');
  resetDatabase();
  candidateDb = openDatabase({ databasePath });
  try {
    candidateDb.prepare(`DELETE FROM sys_role_menus WHERE role_id = (
      SELECT id FROM sys_roles WHERE role_code = 'super_admin'
    ) AND menu_id = (
      SELECT id FROM sys_menus WHERE permission_code = 'dashboard:view'
    )`).run();
  } finally {
    candidateDb.close();
  }
  await assertCode(Promise.resolve().then(() => formatter.validateCandidate(require('../../server/src/db/database'), databasePath)), 'CANDIDATE_RBAC_INVALID');
  resetDatabase();
  candidateDb = openDatabase({ databasePath });
  try {
    candidateDb.prepare("UPDATE energy_types SET default_unit = 'Wh', standard_unit = 'Wh' WHERE code = 'electricity'").run();
  } finally {
    candidateDb.close();
  }
  await assertCode(Promise.resolve().then(() => formatter.validateCandidate(require('../../server/src/db/database'), databasePath)), 'CANDIDATE_REFERENCE_INVALID');

  resetDatabase();
  seedDirtyState();

  // manual backup 生成后、验证前失败时，本次未验证备份必须被清理，旧状态不变。
  resetDatabase();
  seedDirtyState();
  const beforeUnverifiedBackup = formatter.snapshotTree(backupsDir);
  const beforeUnverifiedState = businessSnapshot();
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      afterBackupCreated: () => { throw new Error('injected backup validation failure'); }
    }
  }), 'FORMAT_FAILED');
  assert.deepEqual(formatter.snapshotTree(backupsDir), beforeUnverifiedBackup, '未验证备份不得残留');
  assert.deepEqual(businessSnapshot(), beforeUnverifiedState, '备份验证失败不得切换数据库');

  // manual backup 文件真实损坏时必须由 SQLite 验证拒绝并清理本次未验证备份。
  resetDatabase();
  seedDirtyState();
  const beforeCorruptedBackup = formatter.snapshotTree(backupsDir);
  const beforeCorruptedBackupState = businessSnapshot();
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      afterBackupCreated: ({ backup }) => { fs.writeFileSync(backup.path, 'corrupted-backup'); }
    }
  }), 'SQLITE_VALIDATION_FAILED');
  assert.deepEqual(formatter.snapshotTree(backupsDir), beforeCorruptedBackup, '损坏的未验证备份不得残留');
  assert.deepEqual(businessSnapshot(), beforeCorruptedBackupState, '备份内容校验失败不得切换数据库');

  // checkpoint 无法完整执行时必须在 backup/candidate/切换前 fail-closed。
  resetDatabase();
  seedDirtyState();
  const beforeCheckpointFailure = businessSnapshot();
  const beforeCheckpointBackups = formatter.snapshotTree(backupsDir);
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      checkpointOfficial: () => { throw new Error('injected checkpoint failure'); }
    }
  }), 'FORMAT_FAILED');
  assert.deepEqual(businessSnapshot(), beforeCheckpointFailure, 'checkpoint 失败不得切换数据库');
  assert.deepEqual(formatter.snapshotTree(backupsDir), beforeCheckpointBackups, 'checkpoint 失败不得新增备份');

  // candidate 安装 rename 失败时必须恢复旧数据库和 uploads，已验证备份可以保留。
  resetDatabase();
  seedDirtyState();
  const beforeInstallFailure = businessSnapshot();
  const beforeInstallUploads = formatter.snapshotTree(uploadsDir);
  const beforeInstallBackups = formatter.snapshotTree(backupsDir);
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      installCandidate: () => { throw new Error('injected candidate install failure'); }
    }
  }), 'FORMAT_FAILED');
  assert.deepEqual(businessSnapshot(), beforeInstallFailure);
  assert.deepEqual(formatter.snapshotTree(uploadsDir), beforeInstallUploads);
  assert.equal(formatter.snapshotTree(backupsDir).length, beforeInstallBackups.length + 1, '已验证 manual backup 应保留');
  assert.equal((await formatter.verify({ testIsolationRoot: isolationRoot })).marker, null);

  // candidate 初始化失败同样只能回滚可逆阶段。
  resetDatabase();
  seedDirtyState();
  const beforeCandidateFailure = businessSnapshot();
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      initializeCandidate: () => { throw new Error('injected candidate initialization failure'); }
    }
  }), 'FORMAT_FAILED');
  assert.deepEqual(businessSnapshot(), beforeCandidateFailure);
  assert.equal((await formatter.verify({ testIsolationRoot: isolationRoot })).marker, null);

  // 磁盘空间无法确认时必须在任何写入前 fail-closed。
  resetDatabase();
  seedDirtyState();
  const beforeDiskGate = businessSnapshot();
  await assertCode(formatter.check({
    testIsolationRoot: isolationRoot,
    hooks: {
      inspectWriters: safeWriterHook,
      assertDiskSpace: () => { throw new formatter._test.FormatError('DISK_SPACE_INSUFFICIENT', 'test disk gate'); }
    }
  }), 'DISK_SPACE_INSUFFICIENT');
  assert.deepEqual(businessSnapshot(), beforeDiskGate);

  // 正式路径重开验证失败必须回滚旧数据库和 uploads。
  resetDatabase();
  seedDirtyState();
  const beforeRollback = businessSnapshot();
  const beforeRollbackUpload = formatter.snapshotTree(uploadsDir);
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: { inspectWriters: safeWriterHook, verifyInstalled: () => { throw new Error('injected installed verification failure'); } }
  }), 'FORMAT_FAILED');
  assert.deepEqual(businessSnapshot(), beforeRollback);
  assert.deepEqual(formatter.snapshotTree(uploadsDir), beforeRollbackUpload);
  assert.equal((await formatter.verify({ testIsolationRoot: isolationRoot })).marker, null);

  // 自动回滚自身失败时必须留下 rollback_failed marker 和 old staging 诊断。
  resetDatabase();
  seedDirtyState();
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: {
      inspectWriters: safeWriterHook,
      installCandidate: () => { throw new Error('injected install failure before rollback'); },
      restoreOfficial: () => { throw new Error('injected rollback failure'); }
    }
  }), 'ROLLBACK_FAILED');
  const rollbackFailed = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert.equal(rollbackFailed.marker.phase, 'rollback_failed');
  assert(rollbackFailed.artifacts.oldDatabases.length >= 1);
  assert.match(rollbackFailed.nextAction, /保持服务停止/);

  // uploads 永久清理开始后故障只留下可诊断 marker，不伪造回滚。
  resetDatabase();
  seedDirtyState();
  resetDatabase();
  seedDirtyState();
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: { inspectWriters: safeWriterHook, removeUploadsStaging: () => { throw new Error('injected uploads cleanup failure'); } }
  }), 'UPLOADS_CLEANUP_INTERRUPTED');
  const pending = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert.equal(pending.marker.phase, 'cleanup_pending');
  assert.equal(pending.marker.uploadsState, 'permanent_delete_interrupted');
  assert(pending.residuals.includes(formatter.MARKER_NAME));
  assert.equal(pending.residualDetails.marker.includes(formatter.MARKER_NAME), true);
  assert.equal(formatter.snapshotTree(uploadsDir).length, 0);
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: { inspectWriters: safeWriterHook }
  }), 'RESIDUAL_STATE');

  // marker 临时文件固定前缀同样属于 fail-closed 残留，并由 verify 分类诊断。
  resetDatabase();
  const markerTempPath = path.join(dataDir, `${formatter.MARKER_NAME}.tmp-99999`);
  fs.writeFileSync(markerTempPath, '{"partial":true}');
  const markerTempVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert(markerTempVerify.residuals.includes(path.basename(markerTempPath)));
  assert(markerTempVerify.residualDetails.markerTemps.includes(path.basename(markerTempPath)));
  assert(markerTempVerify.artifacts.markerTemps.includes(path.basename(markerTempPath)));
  await assertCode(formatter.execute({
    testIsolationRoot: isolationRoot,
    confirmation: formatter.CONFIRM_TEXT,
    hooks: { inspectWriters: safeWriterHook }
  }), 'RESIDUAL_STATE');
  fs.rmSync(markerTempPath, { force: true });

  // 父目录 fsync 仅对白名单 unsupported 错误 fallback；权限/I/O 等异常必须阻断并保留可诊断 marker。
  resetDatabase();
  const fsyncMarkerPath = path.join(dataDir, formatter.MARKER_NAME);
  const fsyncMarker = {
    schema: 'charcoal-format-default-database-marker',
    version: 1,
    phase: 'prepared',
    operationId: 'fsync-fault-injection',
    databaseState: 'old',
    uploadsState: 'original'
  };
  formatter._test.writeMarker(fsyncMarkerPath, fsyncMarker, {
    fileOperations: buildParentFsyncFailureOperations('EINVAL')
  });
  const unsupportedFsyncVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
  assert.equal(unsupportedFsyncVerify.marker.phase, 'prepared');
  assert(unsupportedFsyncVerify.residuals.includes(formatter.MARKER_NAME));
  fs.rmSync(fsyncMarkerPath, { force: true });
  assert.equal(
    formatter._test.isUnsupportedDirectoryFsyncError({ code: 'EPERM', syscall: 'fsync' }),
    process.platform === 'win32',
    'EPERM 仅在 Windows 目录 fsync 明确不支持时允许 fallback'
  );
  assert.equal(
    formatter._test.isUnsupportedDirectoryFsyncError({ code: 'EPERM', syscall: 'open' }),
    false,
    '目录打开阶段的 EPERM 必须按权限错误阻断'
  );
  for (const unexpectedCode of ['EACCES', 'EIO']) {
    assert.equal(
      formatter._test.isUnsupportedDirectoryFsyncError({ code: unexpectedCode }),
      false,
      `${unexpectedCode} 不得伪装为 unsupported fallback`
    );
    assert.throws(
      () => formatter._test.writeMarker(fsyncMarkerPath, fsyncMarker, {
        fileOperations: buildParentFsyncFailureOperations(unexpectedCode)
      }),
      (error) => error.code === 'PARENT_DIRECTORY_FSYNC_FAILED'
    );
    const unexpectedFsyncVerify = await formatter.verify({ testIsolationRoot: isolationRoot });
    assert.equal(unexpectedFsyncVerify.marker.phase, 'prepared');
    assert(unexpectedFsyncVerify.residuals.includes(formatter.MARKER_NAME));
    fs.rmSync(fsyncMarkerPath, { force: true });
  }

  // 链接、sidecar 和管理员布尔门禁的错误合同只做隔离对象验证。
  resetDatabase();
  const linkRoot = path.join(isolationRoot, 'link-check');
  fs.mkdirSync(linkRoot, { recursive: true });
  const linkTarget = path.join(linkRoot, 'target');
  const linkPath = path.join(linkRoot, 'link');
  fs.mkdirSync(linkTarget);
  let junctionCreated = false;
  try {
    fs.symlinkSync(linkTarget, linkPath, 'junction');
    junctionCreated = true;
  } catch (error) {
    skippedCapabilities.push(`junction 创建不可用：${error && error.code ? error.code : 'unknown'}`);
  }
  if (junctionCreated) {
    assert.throws(() => formatter._test.assertOrdinaryPath(linkPath, 'directory', '链接目录'), (error) => error.code === 'LINK_NOT_ALLOWED');
  }
  const hardlinkSource = path.join(linkRoot, 'ordinary.sqlite');
  const hardlinkPath = path.join(linkRoot, 'hardlink.sqlite');
  fs.writeFileSync(hardlinkSource, 'hardlink-test');
  let hardlinkCreated = false;
  try {
    fs.linkSync(hardlinkSource, hardlinkPath);
    hardlinkCreated = true;
  } catch (error) {
    skippedCapabilities.push(`硬链接创建不可用：${error && error.code ? error.code : 'unknown'}`);
  }
  if (hardlinkCreated) {
    assert.throws(() => formatter._test.assertOrdinaryPath(hardlinkPath, 'file', '硬链接文件'), (error) => error.code === 'HARDLINK_NOT_ALLOWED');
  }

  // DB-wal / DB-shm sidecar 的符号链接和硬链接均需在 checkpoint/快照前拒绝。
  resetDatabase();
  const sidecarSource = path.join(linkRoot, 'sidecar-source');
  fs.writeFileSync(sidecarSource, 'sidecar');
  const walSidecarPath = `${databasePath}-wal`;
  let walSymlinkCreated = false;
  try {
    fs.symlinkSync(sidecarSource, walSidecarPath, 'file');
    walSymlinkCreated = true;
  } catch (error) {
    skippedCapabilities.push(`WAL sidecar 符号链接创建不可用：${error && error.code ? error.code : 'unknown'}`);
  }
  if (walSymlinkCreated) {
    await assertCode(formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } }), 'LINK_NOT_ALLOWED');
    fs.rmSync(walSidecarPath, { force: true });
  }
  let shmHardlinkCreated = false;
  const shmSidecarPath = `${databasePath}-shm`;
  try {
    fs.linkSync(sidecarSource, shmSidecarPath);
    shmHardlinkCreated = true;
  } catch (error) {
    skippedCapabilities.push(`SHM sidecar 硬链接创建不可用：${error && error.code ? error.code : 'unknown'}`);
  }
  if (shmHardlinkCreated) {
    await assertCode(formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } }), 'HARDLINK_NOT_ALLOWED');
    fs.rmSync(shmSidecarPath, { force: true });
  }
  // 无 symlink 创建权限时，使用纯 lstat 判定对象确定性覆盖 symlink/reparse/hardlink 拒绝分支。
  assert.throws(
    () => formatter._test.assertOrdinaryStat(buildStatDescriptor({ isSymbolicLink: true }), 'file', '注入符号链接'),
    (error) => error.code === 'LINK_NOT_ALLOWED'
  );
  assert.throws(
    () => formatter._test.assertOrdinaryStat(buildStatDescriptor({ isReparsePoint: true }), 'file', '注入重解析点'),
    (error) => error.code === 'LINK_NOT_ALLOWED'
  );
  assert.throws(
    () => formatter._test.assertOrdinaryStat(buildStatDescriptor({ nlink: 2 }), 'file', '注入硬链接'),
    (error) => error.code === 'HARDLINK_NOT_ALLOWED'
  );

  // writer parser 与 runner injection：JSON 形状、PID 元素、动态端口和相对启动命令均受控。
  await assertCode(Promise.resolve().then(() => formatter._test.parseWriterInspectionPayload('{bad-json')), 'WRITER_CHECK_UNAVAILABLE');
  await assertCode(Promise.resolve().then(() => formatter._test.parseWriterInspectionPayload('{"locked":[]}')), 'WRITER_CHECK_UNAVAILABLE');
  await assertCode(Promise.resolve().then(() => formatter._test.parseWriterInspectionPayload('{"locked":[],"listeners":["3002"],"projectProcesses":[]}')), 'WRITER_CHECK_UNAVAILABLE');
  const customWriterRequest = formatter._test.buildWriterInspectionRequest(
    { databasePath, dataDir },
    { backendPort: 4312, frontendPort: 9123 }
  );
  assert.deepEqual(customWriterRequest.ports, [4312, 9123]);
  let injectedWriterRequest = null;
  const injectedWriterResult = formatter._test.inspectWindowsWriters(
    { databasePath, dataDir },
    {
      runtimeEnvironment: { backendPort: 4312, frontendPort: 9123 },
      runWriterInspection: (request) => {
        injectedWriterRequest = request;
        return { locked: [], listeners: [], projectProcesses: [] };
      }
    }
  );
  assert.equal(injectedWriterResult.checked, true);
  assert.deepEqual(injectedWriterRequest.ports, [4312, 9123]);
  const writerScript = formatter._test.buildWriterInspectionScript(customWriterRequest).script;
  assert.equal(writerScript.includes('dev:(?:server|client)'), true, 'writer 脚本必须识别相对 npm dev 启动命令');
  assert.match(writerScript, /server\[.*src/, 'writer 脚本必须识别相对 server/src/index.js 命令');
  if (process.platform === 'win32') {
    const isolatedPowerShellRequest = {
      files: [],
      ports: [65431, 65432],
      projectRoot: path.join(isolationRoot, 'writer-process-sentinel'),
      projectRootName: 'writer-process-sentinel'
    };
    const builtPowerShell = formatter._test.buildWriterInspectionScript(isolatedPowerShellRequest);
    const encodedPowerShell = Buffer.from(builtPowerShell.script, 'utf16le').toString('base64');
    const powerShellExecution = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, CHARCOAL_FORMAT_TARGETS: builtPowerShell.payload },
        timeout: 30000
      }
    );
    assert.equal(
      powerShellExecution.status,
      0,
      `PowerShell writer parser/执行必须以 0 退出：${String(powerShellExecution.stderr || '').trim()}`
    );
    const actualPowerShellPayload = formatter._test.parseWriterInspectionPayload(powerShellExecution.stdout);
    assert(Array.isArray(actualPowerShellPayload.lockedFiles));
    assert(Array.isArray(actualPowerShellPayload.listeningPids));
    assert(Array.isArray(actualPowerShellPayload.projectPids));
  } else {
    skippedCapabilities.push('PowerShell writer parser/执行仅在 Windows 验证');
  }

  const originalPassword = process.env.CHARCOAL_ADMIN_PASSWORD;
  process.env.CHARCOAL_ADMIN_PASSWORD = 'short';
  await assertCode(formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } }), 'ADMIN_PASSWORD_REQUIRED');
  delete process.env.CHARCOAL_ADMIN_PASSWORD;
  await assertCode(formatter.check({ testIsolationRoot: isolationRoot, hooks: { inspectWriters: safeWriterHook } }), 'ADMIN_PASSWORD_REQUIRED');
  process.env.CHARCOAL_ADMIN_PASSWORD = originalPassword;
}

/** 返回临时目录外路径，验证测试双门不允许项目或任意生产路径。 */
function projectRootForTestOutside() {
  return path.resolve(__dirname, '..', '..');
}

run()
  .then(() => {
    fs.rmSync(isolationRoot, { recursive: true, force: true });
    skippedCapabilities.forEach((reason) => process.stdout.write(`formatDefaultDatabase.test skipped capability: ${reason}\n`));
    process.stdout.write('formatDefaultDatabase.test passed\n');
  })
  .catch((error) => {
    try { fs.rmSync(isolationRoot, { recursive: true, force: true }); } catch (_cleanupError) { /* 保留原始失败 */ }
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
