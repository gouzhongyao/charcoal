const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// 本测试仅使用隔离临时目录，不读取或修改项目真实 data、uploads 与 backups。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-governance-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-governance.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const {
  blockDatabaseAdmission,
  getDatabaseAdmissionState,
  initDatabase,
  migrateDemoRunImportBatchRole,
  openDatabase,
  poisonDatabaseAdmission,
  unblockDatabaseAdmission
} = require('../db/database');
const { app } = require('../index');
const { createBackup, restoreBackup, validateBackupFile, _test: backupServiceTest } = require('../services/backupService');
const {
  CLEANUP_CONFIRMATION_TEXT,
  DATABASE_RESTORE_SAFETY_REASON,
  LEGACY_CLAIM_CONFIRMATION_TEXT,
  getDemoRuntimeStatus,
  toggleDemoRuntime,
  _test: demoRuntimeTest
} = require('../services/demoRuntimeService');
const { runWithMaintenance } = require('../services/maintenanceState');
const { toPublicRestoreResult } = require('../routes/backups');

// 生产 server/src 仅数据库基础层可加载 SQLite driver；backupService 仅允许只读备份验证例外。
function assertProductionSqliteDriverBoundary() {
  const serverSourceDir = path.resolve(__dirname, '..');
  const allowedFiles = new Set([
    path.join(serverSourceDir, 'db', 'database.js'),
    path.join(serverSourceDir, 'services', 'backupService.js')
  ].map((filePath) => path.resolve(filePath)));
  const sourceFiles = [];
  const visitDirectory = (directoryPath) => {
    fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') visitDirectory(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        sourceFiles.push(entryPath);
      }
    });
  };
  visitDirectory(serverSourceDir);
  sourceFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    if (/require\(['"]better-sqlite3['"]\)/.test(source)) {
      assert(allowedFiles.has(path.resolve(filePath)), `生产源码不得绕过 openDatabase 直连 SQLite：${filePath}`);
      if (path.basename(filePath) === 'backupService.js') {
        assert(source.includes("new Database(backupPath, { readonly: true, fileMustExist: true })"),
          'backupService 的 SQLite driver 例外只能用于只读且要求文件存在的备份验证。');
      }
    }
  });
}

// 阶段 1 必须创建的全部治理表。
const GOVERNANCE_TABLES = [
  'demo_runtime_settings',
  'demo_dataset_runs',
  'demo_import_contexts',
  'demo_run_import_batches',
  'demo_data_registry',
  'demo_data_relations',
  'demo_legacy_claim_runs',
  'demo_cleanup_runs'
];
// 阶段 1 新增的五项后端权限。
const DEMO_PERMISSIONS = [
  'system:demo:view',
  'system:demo:toggle',
  'system:demo:download',
  'system:demo:cleanup:preview',
  'system:demo:cleanup:execute'
];
// 全部显式治理索引契约，用于验证同名弱索引不会绕过初始化。
const GOVERNANCE_INDEX_CONTRACTS = {
  ux_demo_dataset_runs_active_dataset: {
    tableName: 'demo_dataset_runs', unique: true, columns: ['dataset_id'],
    where: "status IN ('active', 'completed', 'cleanup_pending', 'cleaning')", weakColumn: 'run_id'
  },
  idx_demo_dataset_runs_status_created: {
    tableName: 'demo_dataset_runs', unique: false, columns: ['status', 'created_at'], weakColumn: 'run_id'
  },
  idx_demo_import_contexts_run_artifact: {
    tableName: 'demo_import_contexts', unique: false, columns: ['run_id', 'artifact_key', 'status'], weakColumn: 'context_id'
  },
  idx_demo_import_contexts_user_expiry: {
    tableName: 'demo_import_contexts', unique: false, columns: ['issued_to_user_id', 'expires_at', 'status'], weakColumn: 'context_id'
  },
  idx_demo_legacy_claim_runs_status_created: {
    tableName: 'demo_legacy_claim_runs', unique: false, columns: ['status', 'created_at'], weakColumn: 'claim_run_id'
  },
  idx_demo_cleanup_runs_status_created: {
    tableName: 'demo_cleanup_runs', unique: false, columns: ['status', 'created_at'], weakColumn: 'cleanup_run_id'
  },
  ux_demo_data_registry_active_entity: {
    tableName: 'demo_data_registry', unique: true, columns: ['entity_type', 'entity_pk'],
    where: 'cleaned_at IS NULL', weakColumn: 'registry_id'
  },
  idx_demo_data_registry_run_artifact: {
    tableName: 'demo_data_registry', unique: false, columns: ['run_id', 'artifact_key', 'cleaned_at'], weakColumn: 'registry_id'
  },
  idx_demo_data_registry_batch: {
    tableName: 'demo_data_registry', unique: false, columns: ['source_batch_id'], weakColumn: 'registry_id'
  },
  idx_demo_data_registry_cleanup: {
    tableName: 'demo_data_registry', unique: false, columns: ['cleanup_run_id', 'cleanup_result'], weakColumn: 'registry_id'
  },
  idx_demo_data_relations_run_type: {
    tableName: 'demo_data_relations', unique: false, columns: ['run_id', 'relation_type'], weakColumn: 'relation_id'
  },
  idx_demo_data_relations_target: {
    tableName: 'demo_data_relations', unique: false, columns: ['to_registry_id', 'relation_type'], weakColumn: 'relation_id'
  },
  idx_demo_run_import_batches_batch: {
    tableName: 'demo_run_import_batches', unique: false, columns: ['import_batch_id'], weakColumn: 'id'
  },
  idx_demo_run_import_batches_run_artifact: {
    tableName: 'demo_run_import_batches', unique: false, columns: ['run_id', 'artifact_key', 'batch_role'], weakColumn: 'id'
  },
  ux_demo_run_import_batches_primary_context: {
    tableName: 'demo_run_import_batches', unique: true, columns: ['context_id'],
    where: "batch_role = 'primary'", weakColumn: 'id'
  }
};

/**
 * 发起隔离 HTTP 请求并解析统一 JSON 响应。
 * @param {object} server HTTP 服务实例。
 * @param {string} method 请求方法。
 * @param {string} pathname 请求路径。
 * @param {object|null} body JSON 请求体。
 * @param {string|null} token 登录令牌。
 * @returns {Promise<object>} 状态码和响应正文。
 */
function request(server, method, pathname, body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = body === null ? '' : JSON.stringify(body);
    const headers = rawBody ? {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(rawBody),
      ...extraHeaders
    } : { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const contentType = String(res.headers['content-type'] || '');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text && contentType.includes('application/json') ? JSON.parse(text) : text
        });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}

/**
 * 创建普通测试用户、角色并按权限编码精确授权。
 * @param {string} roleCode 角色编码。
 * @param {string} username 用户名。
 * @param {string[]} permissionCodes 授权权限编码。
 * @returns {number} 新用户 ID。
 */
function createUserWithPermissions(roleCode, username, permissionCodes = []) {
  const bcrypt = require('bcryptjs');
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?)`).run(roleCode, roleCode, now, now).lastInsertRowid;
    const userId = db.prepare(`INSERT INTO sys_users
      (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?)`).run(
      username,
      username,
      bcrypt.hashSync('Password123!', 10),
      now,
      now
    ).lastInsertRowid;
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
    const grant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `测试授权缺少权限菜单 ${permissionCode}`);
      grant.run(roleId, menu.id, now);
    });
    return userId;
  } finally {
    db.close();
  }
}

/**
 * 将隔离库转换为不含阶段 1 治理表和权限的旧版本备份。
 * @param {string} backupPath 旧版本备份路径。
 */
function createLegacyBackupWithoutDemoGovernance(backupPath) {
  const sourceDb = openDatabase();
  try {
    sourceDb.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    sourceDb.close();
  }
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(process.env.SQLITE_PATH, backupPath);
  const legacyDb = new Database(backupPath);
  try {
    legacyDb.pragma('foreign_keys = OFF');
    legacyDb.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM sys_role_menus WHERE menu_id IN (
        SELECT id FROM sys_menus WHERE permission_code LIKE 'system:demo:%'
      );
      DELETE FROM sys_menus WHERE permission_code LIKE 'system:demo:%';
      DROP TABLE IF EXISTS demo_data_relations;
      DROP TABLE IF EXISTS demo_run_import_batches;
      DROP TABLE IF EXISTS demo_data_registry;
      DROP TABLE IF EXISTS demo_import_contexts;
      DROP TABLE IF EXISTS demo_cleanup_runs;
      DROP TABLE IF EXISTS demo_legacy_claim_runs;
      DROP TABLE IF EXISTS demo_dataset_runs;
      DROP TABLE IF EXISTS demo_runtime_settings;
      UPDATE app_meta SET value = 'energy-analysis-foundation' WHERE key = 'schema_stage';
      UPDATE app_meta SET value = '2026-08-06-energy-analysis-foundation' WHERE key = 'schema_version';
      COMMIT;
    `);
    legacyDb.pragma('foreign_keys = ON');
  } finally {
    legacyDb.close();
  }
}

/**
 * 临时写入单个 runtime 字段并断言状态读取严格 fail-closed，随后恢复原值。
 * @param {string} columnName 字段名。
 * @param {unknown} invalidValue 非法字段值。
 */
function assertRuntimeFieldFailsClosed(fieldName, invalidValue) {
  const canonicalRow = {
    enabled: 1,
    runtimeEpoch: 4,
    revision: 4,
    updatedBy: null,
    updatedAt: '2026-08-13T00:00:00.000Z',
    changeReason: 'test-repair'
  };
  assert(Object.prototype.hasOwnProperty.call(canonicalRow, fieldName), `不允许测试未知 runtime 字段 ${fieldName}`);
  const state = demoRuntimeTest.mapRuntimeStatus({ ...canonicalRow, [fieldName]: invalidValue });
  assert.strictEqual(state.available, false, `${fieldName} 非法时必须 unavailable。`);
  assert.strictEqual(state.enabled, false, `${fieldName} 非法时必须 fail-closed。`);
}

/**
 * 将三个关键治理索引替换为同名弱索引，用于验证 initDatabase 按完整契约修复。
 */
function degradeCriticalGovernanceIndexes() {
  const db = openDatabase();
  try {
    db.exec(`DROP INDEX ux_demo_dataset_runs_active_dataset;
      CREATE INDEX ux_demo_dataset_runs_active_dataset ON demo_dataset_runs(dataset_id);
      DROP INDEX ux_demo_data_registry_active_entity;
      CREATE UNIQUE INDEX ux_demo_data_registry_active_entity
        ON demo_data_registry(entity_type, entity_pk) WHERE cleanup_run_id IS NULL;
      DROP INDEX ux_demo_run_import_batches_primary_context;
      CREATE INDEX ux_demo_run_import_batches_primary_context
        ON demo_run_import_batches(context_id) WHERE batch_role = 'secondary';`);
  } finally {
    db.close();
  }
}

/** 将全部治理显式索引替换为同名错误列索引。 */
function degradeAllGovernanceIndexes() {
  const db = openDatabase();
  try {
    Object.entries(GOVERNANCE_INDEX_CONTRACTS).forEach(([indexName, contract]) => {
      db.exec(`DROP INDEX ${indexName}; CREATE INDEX ${indexName}
        ON ${contract.tableName}(${contract.weakColumn});`);
    });
  } finally {
    db.close();
  }
}

/** 断言全部治理索引的 unique、列顺序和 WHERE 条件符合 canonical contract。 */
function assertAllGovernanceIndexesCanonical(db) {
  Object.entries(GOVERNANCE_INDEX_CONTRACTS).forEach(([indexName, contract]) => {
    const indexListRow = db.prepare(`PRAGMA index_list(${contract.tableName})`).all()
      .find((index) => index.name === indexName);
    assert(indexListRow, `缺少治理索引 ${indexName}`);
    assert.strictEqual(Boolean(indexListRow.unique), contract.unique, `${indexName} unique 不符合契约。`);
    const columns = db.prepare(`PRAGMA index_info(${indexName})`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name);
    assert.deepStrictEqual(columns, contract.columns, `${indexName} 列顺序不符合契约。`);
    const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName).sql;
    const whereMatch = String(indexSql).match(/\bWHERE\b([\s\S]*)$/i);
    const actualWhere = whereMatch ? whereMatch[1].replace(/\s+/g, ' ').trim().toLowerCase() : null;
    const expectedWhere = contract.where ? contract.where.replace(/\s+/g, ' ').trim().toLowerCase() : null;
    assert.strictEqual(actualWhere, expectedWhere, `${indexName} WHERE 条件不符合契约。`);
  });
}

/** 断言新库 SHA-256 字段严格拒绝长度和字符集边界，并保留 upload NULL 语义。 */
function assertDemoSha256Constraints(db) {
  const now = '2026-08-13T00:00:00.000Z';
  const expiresAt = '2026-08-13T01:00:00.000Z';
  const valid = 'a'.repeat(64);
  const insertRun = db.prepare(`INSERT INTO demo_dataset_runs
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_at)
    VALUES (?, ?, 'v1', ?, 'failed', ?)`);
  ['b'.repeat(63), 'b'.repeat(65), 'B'.repeat(64), `${'b'.repeat(63)}Z`, `${'b'.repeat(63)}!`]
    .forEach((digest, index) => assert.throws(
      () => insertRun.run(`sha-run-bad-${index}`, `sha-dataset-bad-${index}`, digest, now),
      /CHECK constraint failed/
    ));
  insertRun.run('sha-run-valid', 'sha-dataset-valid', valid, now);

  const insertContext = db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
      artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
      status, issued_at, expires_at, upload_file_sha256)
    VALUES (?, ?, 'sha-run-valid', 'sha-dataset-valid', 'v1', ?, ?, 'handler', ?, 1, 1,
      'issued', ?, ?, ?)`);
  insertContext.run('sha-context-valid-null', 'b'.repeat(64), valid, 'artifact-null', 'c'.repeat(64), now, expiresAt, null);
  assert.strictEqual(db.prepare("SELECT upload_file_sha256 AS uploadSha FROM demo_import_contexts WHERE context_id = 'sha-context-valid-null'").get().uploadSha, null);
  const invalidShaValues = ['d'.repeat(63), 'd'.repeat(65), 'D'.repeat(64), `${'d'.repeat(63)}Z`, `${'d'.repeat(63)}!`];
  invalidShaValues.forEach((digest, index) => {
    assert.throws(() => insertContext.run(`sha-token-bad-${index}`, digest, valid,
      `artifact-token-${index}`, 'c'.repeat(64), now, expiresAt, null), /CHECK constraint failed/);
    assert.throws(() => insertContext.run(`sha-manifest-bad-${index}`, `9${String(index).padStart(63, '0')}`,
      digest, `artifact-manifest-${index}`, 'c'.repeat(64), now, expiresAt, null), /CHECK constraint failed/);
    assert.throws(() => insertContext.run(`sha-artifact-bad-${index}`, `e${String(index).padStart(63, '0')}`,
      valid, `artifact-artifact-${index}`, digest, now, expiresAt, null), /CHECK constraint failed/);
    assert.throws(() => insertContext.run(`sha-upload-bad-${index}`, `f${String(index).padStart(63, '0')}`,
      valid, `artifact-upload-${index}`, 'c'.repeat(64), now, expiresAt, digest), /CHECK constraint failed/);
  });
}

(async () => {
  let server;
  try {
    assertProductionSqliteDriverBoundary();
    initDatabase();

    backupServiceTest.assertCheckpointComplete([{ busy: 0, log: 7, checkpointed: 7 }], 'TEST_CHECKPOINT');
    assert.throws(
      () => backupServiceTest.assertCheckpointComplete([{ busy: 0, log: 7, checkpointed: 3 }], 'TEST_CHECKPOINT_INCOMPLETE'),
      (error) => error.details && error.details.code === 'TEST_CHECKPOINT_INCOMPLETE',
      'checkpoint log frame 未全部写回时必须拒绝。'
    );
    assert.throws(
      () => backupServiceTest.assertCheckpointComplete([{ busy: 1, log: 7, checkpointed: 7 }], 'TEST_CHECKPOINT_BUSY'),
      (error) => error.details && error.details.code === 'TEST_CHECKPOINT_BUSY',
      'checkpoint busy 时必须拒绝。'
    );
    const corruptBackupPath = path.join(process.env.BACKUPS_DIR, 'corrupt.sqlite');
    fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(corruptBackupPath, 'not a sqlite database');
    assert.throws(() => validateBackupFile(corruptBackupPath), (error) => {
      assert.deepStrictEqual(error.details, { code: 'BACKUP_SQLITE_OPEN_OR_READ_FAILED' });
      assert(!JSON.stringify(error.details).includes('file is not a database'));
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    fs.rmSync(corruptBackupPath, { force: true });

    const closeProbeDb = openDatabase();
    const closeProbeIterator = closeProbeDb.prepare('SELECT name FROM sqlite_master').iterate();
    closeProbeIterator.next();
    assert.throws(() => closeProbeDb.close(), /busy|statements/i, '未结束 iterator 必须使 close 失败。');
    assert.strictEqual(getDatabaseAdmissionState().activeConnections, 1, 'close 失败不得提前减少活动连接计数。');
    for (const _row of closeProbeIterator) {
      // 消耗剩余 iterator，使 SQLite statement 真正结束。
    }
    closeProbeDb.close();
    assert.strictEqual(getDatabaseAdmissionState().activeConnections, 0);
    closeProbeDb.close();
    assert.strictEqual(getDatabaseAdmissionState().activeConnections, 0, '重复 close 不得重复减少计数。');

    const delayedDrainDb = openDatabase();
    const delayedDrainPermit = blockDatabaseAdmission();
    assert.throws(() => openDatabase(), /正在切换/, 'barrier 后普通连接必须稳定拒绝。');
    assert.throws(() => openDatabase({ allowBlocked: true }), /正在切换/, '旧布尔绕过参数不得继续生效。');
    const delayedClose = setTimeout(() => delayedDrainDb.close(), 60);
    await backupServiceTest.waitForOfficialDatabaseDrain(500);
    clearTimeout(delayedClose);
    unblockDatabaseAdmission(delayedDrainPermit);
    assert.strictEqual(getDatabaseAdmissionState().activeConnections, 0, '有限等待应允许既有连接自然排空。');
    const stuckDrainDb = openDatabase();
    const stuckDrainPermit = blockDatabaseAdmission();
    await assert.rejects(() => backupServiceTest.waitForOfficialDatabaseDrain(40), (error) => (
      error.details && error.details.code === 'DATABASE_DRAIN_TIMEOUT'
    ));
    stuckDrainDb.close();
    unblockDatabaseAdmission(stuckDrainPermit);

    const newDb = openDatabase();
    try {
      const tableNames = new Set(newDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      GOVERNANCE_TABLES.forEach((tableName) => assert(tableNames.has(tableName), `新库缺少治理表 ${tableName}`));
      const defaultSetting = newDb.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch, revision, change_reason AS changeReason
        FROM demo_runtime_settings WHERE id = 1`).get();
      assert.deepStrictEqual(defaultSetting, {
        enabled: 0,
        runtimeEpoch: 1,
        revision: 1,
        changeReason: 'schema_default'
      });
      assert.strictEqual(newDb.prepare('SELECT COUNT(*) AS total FROM demo_runtime_settings').get().total, 1);
      assert.strictEqual(newDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_stage'").get().value, 'demo-context-foundation');
      assert.strictEqual(newDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, '2026-08-13-demo-context-v4');

      const activeRegistryIndex = newDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_data_registry_active_entity'").get();
      assert(activeRegistryIndex && /WHERE cleaned_at IS NULL/i.test(activeRegistryIndex.sql), 'active registry 必须使用部分唯一索引。');
      const activeRunIndex = newDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_dataset_runs_active_dataset'").get();
      assert(activeRunIndex && /WHERE status IN/i.test(activeRunIndex.sql), 'active run 必须使用状态部分唯一索引。');
      const batchRelationColumns = new Set(newDb.prepare('PRAGMA table_info(demo_run_import_batches)').all().map((column) => column.name));
      assert(batchRelationColumns.has('batch_role'), '批次关系必须支持同 artifact 多 batch role。');
      const primaryContextIndex = newDb.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'ux_demo_run_import_batches_primary_context'`).get();
      assert(primaryContextIndex && /UNIQUE INDEX/i.test(primaryContextIndex.sql)
        && /context_id/i.test(primaryContextIndex.sql) && /batch_role = 'primary'/i.test(primaryContextIndex.sql),
      '每个 context 只允许一个 primary batch。');
      const contextColumns = new Set(newDb.prepare('PRAGMA table_info(demo_import_contexts)').all().map((column) => column.name));
      ['artifact_key', 'handler_key', 'issued_to_user_id', 'runtime_epoch', 'upload_file_sha256', 'preview_digest']
        .forEach((columnName) => assert(contextColumns.has(columnName), `演示 context 缺少绑定字段 ${columnName}`));
      assertDemoSha256Constraints(newDb);
      const registryColumns = new Set(newDb.prepare('PRAGMA table_info(demo_data_registry)').all().map((column) => column.name));
      ['run_id', 'artifact_key', 'entity_type', 'entity_pk', 'source_batch_id', 'source_row_number']
        .forEach((columnName) => assert(registryColumns.has(columnName), `registry 缺少原子登记字段 ${columnName}`));

      const demoMenu = newDb.prepare(`SELECT id, parent_id AS parentId, menu_name AS menuName, route_path AS routePath,
          component, permission_code AS permissionCode, sort_order AS sortOrder
        FROM sys_menus WHERE permission_code = 'system:demo:view'`).get();
      const systemMenu = newDb.prepare("SELECT id FROM sys_menus WHERE route_path = '/system' AND menu_type = 'directory'").get();
      assert.deepStrictEqual({
        menuName: demoMenu.menuName,
        routePath: demoMenu.routePath,
        component: demoMenu.component,
        permissionCode: demoMenu.permissionCode,
        sortOrder: demoMenu.sortOrder
      }, {
        menuName: '演示数据管理',
        routePath: '/system/demo-data',
        component: 'system/demo-data/index',
        permissionCode: 'system:demo:view',
        sortOrder: 150
      });
      assert.strictEqual(demoMenu.parentId, systemMenu.id);
      DEMO_PERMISSIONS.forEach((permissionCode) => {
        assert.strictEqual(newDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1);
      });
      const adminGrantCount = newDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = 'super_admin'
          AND menu.permission_code IN (${DEMO_PERMISSIONS.map(() => '?').join(', ')})`).get(...DEMO_PERMISSIONS).total;
      assert.strictEqual(adminGrantCount, 0, '五项演示权限不得自动关联 super_admin 角色。');
      const userGrantCount = newDb.prepare(`SELECT COUNT(*) AS total
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = 'user' AND menu.permission_code LIKE 'system:demo:%'`).get().total;
      assert.strictEqual(userGrantCount, 0, '普通内置角色不得自动获得演示权限。');
    } finally {
      newDb.close();
    }

    const batchShapeDb = openDatabase();
    try {
      const now = new Date().toISOString();
      batchShapeDb.prepare(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_at)
        VALUES ('shape-run', 'qinglan-park-v1', '1.0.0', ?, 'active', ?)`)
        .run('a'.repeat(64), now);
      batchShapeDb.prepare(`INSERT INTO demo_import_contexts
        (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
          artifact_key, handler_key, artifact_file_sha256, issued_to_user_id,
          runtime_epoch, status, issued_at, expires_at, upload_file_sha256,
          preview_digest, previewed_at)
        VALUES ('shape-context', ?, 'shape-run', 'qinglan-park-v1', '1.0.0', ?,
          'artifact-24', 'handler-24', ?, 1, 1, 'previewed', ?, ?, ?, ?, ?)`)
        .run('1'.repeat(64), 'a'.repeat(64), 'c'.repeat(64), now,
          new Date(Date.now() + 60000).toISOString(), 'c'.repeat(64), `hmac-sha256:v1:audit:${'d'.repeat(64)}`, now);
      const insertBatch = batchShapeDb.prepare(`INSERT INTO import_batches
        (import_type, original_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
        VALUES ('energy_flow_record', ?, 'xlsx', 'completed', 1, 1, 0, 0)`);
      const firstBatchId = insertBatch.run('artifact-24-a.xlsx').lastInsertRowid;
      const secondBatchId = insertBatch.run('artifact-24-b.xlsx').lastInsertRowid;
      const linkBatch = batchShapeDb.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES ('shape-run', 'artifact-24', 'shape-context', ?, ?)`);
      linkBatch.run(firstBatchId, 'node_records');
      linkBatch.run(secondBatchId, 'edge_records');
      const primaryContextId = batchShapeDb.prepare(`INSERT INTO demo_import_contexts
        (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
          artifact_key, handler_key, artifact_file_sha256, issued_to_user_id,
          runtime_epoch, status, issued_at, expires_at)
        VALUES ('shape-primary-context', ?, 'shape-run', 'qinglan-park-v1', '1.0.0', ?,
          'artifact-03', 'handler-03', ?, 1, 1, 'issued', ?, ?)`)
        .run('e'.repeat(64), 'a'.repeat(64), 'f'.repeat(64), now,
          new Date(Date.now() + 60000).toISOString());
      assert(primaryContextId);
      const primaryBatchId = insertBatch.run('artifact-03-primary.xlsx').lastInsertRowid;
      const duplicatePrimaryBatchId = insertBatch.run('artifact-03-duplicate-primary.xlsx').lastInsertRowid;
      batchShapeDb.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES ('shape-run', 'artifact-03', 'shape-primary-context', ?, 'primary')`).run(primaryBatchId);
      assert.throws(() => batchShapeDb.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES ('shape-run', 'artifact-03', 'shape-primary-context', ?, 'primary')`).run(duplicatePrimaryBatchId),
      /UNIQUE constraint failed: demo_run_import_batches.context_id/,
      '同一 context 不得关联第二个 primary batch。');
      assert.strictEqual(batchShapeDb.prepare(`SELECT COUNT(*) AS total FROM demo_run_import_batches
        WHERE run_id = 'shape-run' AND artifact_key = 'artifact-24'`).get().total, 2,
      '同 artifact 必须允许关联多个具有不同 role 且 import_type 可重复的批次。');
      batchShapeDb.exec(`DROP INDEX idx_demo_run_import_batches_batch;
        DROP INDEX idx_demo_run_import_batches_run_artifact;
        ALTER TABLE demo_run_import_batches RENAME TO demo_run_import_batches_current;
        CREATE TABLE demo_run_import_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          artifact_key TEXT NOT NULL,
          context_id TEXT NOT NULL,
          import_batch_id INTEGER NOT NULL,
          linked_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
          FOREIGN KEY (context_id) REFERENCES demo_import_contexts(context_id) ON DELETE RESTRICT,
          FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
          UNIQUE (run_id, artifact_key, context_id, import_batch_id)
        );
        INSERT INTO demo_run_import_batches
          (id, run_id, artifact_key, context_id, import_batch_id, linked_at)
        SELECT id, run_id, artifact_key, context_id, import_batch_id, linked_at
        FROM demo_run_import_batches_current;
        DROP TABLE demo_run_import_batches_current;`);
      assert.strictEqual(migrateDemoRunImportBatchRole(batchShapeDb), true);
      const migratedLinks = batchShapeDb.prepare(`SELECT batch_role AS batchRole FROM demo_run_import_batches
        WHERE run_id = 'shape-run' ORDER BY id`).all();
      assert.deepStrictEqual(migratedLinks, [
        { batchRole: 'primary' },
        { batchRole: 'legacy_batch_2' },
        { batchRole: 'primary' }
      ]);
      const migratedPrimaryIndex = batchShapeDb.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'ux_demo_run_import_batches_primary_context'`).get();
      assert(migratedPrimaryIndex && /WHERE batch_role = 'primary'/i.test(migratedPrimaryIndex.sql));
      assert.strictEqual(migrateDemoRunImportBatchRole(batchShapeDb), false, 'batch role 迁移必须幂等。');
      const secondRunNow = new Date().toISOString();
      batchShapeDb.prepare(`INSERT INTO demo_dataset_runs
        (run_id, dataset_id, manifest_version, manifest_digest, status, created_at)
        VALUES ('shape-run-2', 'qinglan-park-v2', 'v1', ?, 'active', ?)`)
        .run('f'.repeat(64), secondRunNow);
      assert.throws(() => batchShapeDb.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES ('shape-run-2', 'artifact-24', 'shape-context', ?, 'cross-run')`).run(firstBatchId),
      /FOREIGN KEY constraint failed/, '批次 link 不得跨 run。');
      assert.throws(() => batchShapeDb.prepare(`INSERT INTO demo_run_import_batches
        (run_id, artifact_key, context_id, import_batch_id, batch_role)
        VALUES ('shape-run', 'artifact-other', 'shape-context', ?, 'cross-artifact')`).run(firstBatchId),
      /FOREIGN KEY constraint failed/, '批次 link 不得跨 artifact。');
      batchShapeDb.prepare(`INSERT INTO demo_data_registry
        (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest)
        VALUES ('shape-run', 'artifact-24', 'entity', '1', 'imported', ?, ?)`).run('1'.repeat(64), '2'.repeat(64));
      batchShapeDb.prepare(`INSERT INTO demo_data_registry
        (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest, snapshot_digest)
        VALUES ('shape-run-2', 'artifact-24', 'entity', '2', 'imported', ?, ?)`).run('3'.repeat(64), '4'.repeat(64));
      assert.throws(() => batchShapeDb.prepare(`INSERT INTO demo_data_relations
        (run_id, from_registry_id, to_registry_id, relation_type)
        VALUES ('shape-run', 1, 2, 'generated_from')`).run(),
      /FOREIGN KEY constraint failed/, 'registry relation 两端必须属于 relation.run_id。');
    } finally {
      batchShapeDb.close();
    }

    assert.throws(() => toggleDemoRuntime({ enabled: 1, actorUserId: 1 }), /enabled 必须为布尔值/);
    const invalidActorBeforeDb = openDatabase();
    let invalidActorBefore;
    try {
      invalidActorBefore = {
        runtime: invalidActorBeforeDb.prepare('SELECT * FROM demo_runtime_settings WHERE id = 1').get(),
        auditCount: invalidActorBeforeDb.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.toggle'").get().total
      };
    } finally {
      invalidActorBeforeDb.close();
    }
    for (const invalidActorUserId of [true, '1']) {
      assert.throws(
        () => toggleDemoRuntime({ enabled: true, actorUserId: invalidActorUserId }),
        (error) => error.details && error.details.code === 'INVALID_DEMO_RUNTIME_ACTOR_USER_ID',
        'toggle actor 必须拒绝布尔值和数字字符串。'
      );
    }
    const invalidActorAfterDb = openDatabase();
    try {
      assert.deepStrictEqual(invalidActorAfterDb.prepare('SELECT * FROM demo_runtime_settings WHERE id = 1').get(), invalidActorBefore.runtime);
      assert.strictEqual(invalidActorAfterDb.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.toggle'").get().total, invalidActorBefore.auditCount);
    } finally {
      invalidActorAfterDb.close();
    }
    const enabledState = toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });
    assert.strictEqual(enabledState.enabled, true);
    assert.strictEqual(enabledState.runtimeEpoch, 2);
    assert.strictEqual(enabledState.revision, 2);
    const disabledState = toggleDemoRuntime({ enabled: false, actorUserId: 1, actorIp: '127.0.0.1' });
    assert.strictEqual(disabledState.enabled, false);
    assert.strictEqual(disabledState.runtimeEpoch, 3);
    assert.strictEqual(disabledState.revision, 3);
    const reenabledState = toggleDemoRuntime({ enabled: true, actorUserId: 1, actorIp: '127.0.0.1' });
    assert.strictEqual(reenabledState.runtimeEpoch, 4, '重复设置相同值也必须递增 epoch。');
    assert.strictEqual(reenabledState.revision, 4, '重复设置相同值也必须递增 revision。');

    initDatabase();
    const persistedState = getDemoRuntimeStatus();
    assert.strictEqual(persistedState.enabled, true, '普通 initDatabase 不得改变已保存开关。');
    assert.strictEqual(persistedState.runtimeEpoch, 4);
    assert.strictEqual(persistedState.revision, 4);

    const failClosedDb = openDatabase();
    try {
      failClosedDb.exec('ALTER TABLE demo_runtime_settings RENAME TO demo_runtime_settings_unavailable');
    } finally {
      failClosedDb.close();
    }
    const failClosedState = getDemoRuntimeStatus();
    assert.strictEqual(failClosedState.available, false);
    assert.strictEqual(failClosedState.enabled, false);
    const restoreStatusTableDb = openDatabase();
    try {
      restoreStatusTableDb.exec('ALTER TABLE demo_runtime_settings_unavailable RENAME TO demo_runtime_settings');
      restoreStatusTableDb.exec(`DROP TABLE demo_runtime_settings;
        CREATE TABLE demo_runtime_settings (
          id INTEGER PRIMARY KEY,
          enabled INTEGER,
          runtime_epoch INTEGER,
          revision INTEGER,
          updated_by INTEGER,
          updated_at TEXT,
          change_reason TEXT
        );
        INSERT INTO demo_runtime_settings VALUES (1, 2, NULL, 0, NULL, '2026-08-13T00:00:00.000Z', 'invalid');`);
    } finally {
      restoreStatusTableDb.close();
    }
    const invalidCanonicalState = getDemoRuntimeStatus();
    assert.strictEqual(invalidCanonicalState.available, false);
    assert.strictEqual(invalidCanonicalState.enabled, false);
    const repairRuntimeDb = openDatabase();
    try {
      repairRuntimeDb.exec(`DROP TABLE demo_runtime_settings;
        CREATE TABLE demo_runtime_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          runtime_epoch INTEGER NOT NULL DEFAULT 1 CHECK (runtime_epoch >= 1),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          updated_by INTEGER,
          updated_at TEXT NOT NULL,
          change_reason TEXT NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
          FOREIGN KEY (updated_by) REFERENCES sys_users(id) ON DELETE SET NULL
        );
        INSERT INTO demo_runtime_settings VALUES (1, 1, 4, 4, NULL, '2026-08-13T00:00:00.000Z', 'test-repair');`);
    } finally {
      repairRuntimeDb.close();
    }
    assertRuntimeFieldFailsClosed('enabled', 2);
    assertRuntimeFieldFailsClosed('enabled', '1');
    assertRuntimeFieldFailsClosed('enabled', true);
    assertRuntimeFieldFailsClosed('runtimeEpoch', null);
    assertRuntimeFieldFailsClosed('runtimeEpoch', '4');
    assertRuntimeFieldFailsClosed('runtimeEpoch', true);
    assertRuntimeFieldFailsClosed('revision', 0);
    assertRuntimeFieldFailsClosed('revision', '4');
    assertRuntimeFieldFailsClosed('revision', true);
    assertRuntimeFieldFailsClosed('updatedBy', 0);
    assertRuntimeFieldFailsClosed('updatedBy', '1');
    assertRuntimeFieldFailsClosed('updatedBy', true);
    assertRuntimeFieldFailsClosed('updatedBy', Number.MAX_SAFE_INTEGER + 1);
    assertRuntimeFieldFailsClosed('updatedAt', 'not-a-timestamp');
    assertRuntimeFieldFailsClosed('updatedAt', '2026-02-30T00:00:00.000Z');
    assertRuntimeFieldFailsClosed('changeReason', 123);
    assertRuntimeFieldFailsClosed('changeReason', '   ');
    assertRuntimeFieldFailsClosed('changeReason', 'x'.repeat(501));

    const weakTextRuntimeDb = openDatabase();
    try {
      weakTextRuntimeDb.exec(`DROP TABLE demo_runtime_settings;
        CREATE TABLE demo_runtime_settings (
          id INTEGER PRIMARY KEY,
          enabled TEXT,
          runtime_epoch TEXT,
          revision TEXT,
          updated_by TEXT,
          updated_at TEXT,
          change_reason TEXT
        );
        INSERT INTO demo_runtime_settings VALUES
          (1, '1', '4', '4', '1', '2026-08-13T00:00:00.000Z', 'weak-text-row');`);
    } finally {
      weakTextRuntimeDb.close();
    }
    const weakTextRuntimeState = getDemoRuntimeStatus();
    assert.strictEqual(weakTextRuntimeState.available, false, '弱 TEXT 数值列不得被 Number 转换为可用状态。');
    assert.strictEqual(weakTextRuntimeState.enabled, false);
    const weakToggleBeforeDb = openDatabase();
    let weakToggleBefore;
    try {
      weakToggleBefore = {
        runtime: weakToggleBeforeDb.prepare('SELECT * FROM demo_runtime_settings WHERE id = 1').get(),
        auditCount: weakToggleBeforeDb.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.toggle'").get().total
      };
    } finally {
      weakToggleBeforeDb.close();
    }
    assert.throws(
      () => toggleDemoRuntime({ enabled: false, actorUserId: 1 }),
      /不是严格 canonical 行/,
      '弱 TEXT runtime 必须在 UPDATE 前拒绝。'
    );
    const weakToggleAfterDb = openDatabase();
    try {
      assert.deepStrictEqual(weakToggleAfterDb.prepare('SELECT * FROM demo_runtime_settings WHERE id = 1').get(), weakToggleBefore.runtime,
        '弱 TEXT runtime toggle 拒绝后不得修改设置。');
      assert.strictEqual(weakToggleAfterDb.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.toggle'").get().total,
        weakToggleBefore.auditCount, '弱 TEXT runtime toggle 拒绝后不得写审计。');
    } finally {
      weakToggleAfterDb.close();
    }
    const restoreCanonicalRuntimeDb = openDatabase();
    try {
      restoreCanonicalRuntimeDb.exec(`DROP TABLE demo_runtime_settings;
        CREATE TABLE demo_runtime_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          runtime_epoch INTEGER NOT NULL DEFAULT 1 CHECK (runtime_epoch >= 1),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          updated_by INTEGER,
          updated_at TEXT NOT NULL,
          change_reason TEXT NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
          FOREIGN KEY (updated_by) REFERENCES sys_users(id) ON DELETE SET NULL
        );
        INSERT INTO demo_runtime_settings VALUES
          (1, 1, 4, 4, NULL, '2026-08-13T00:00:00.000Z', 'test-repair');`);
    } finally {
      restoreCanonicalRuntimeDb.close();
    }

    degradeCriticalGovernanceIndexes();
    initDatabase();
    const repairedIndexDb = openDatabase();
    try {
      const activeRun = repairedIndexDb.prepare("PRAGMA index_list(demo_dataset_runs)").all()
        .find((index) => index.name === 'ux_demo_dataset_runs_active_dataset');
      assert.strictEqual(activeRun.unique, 1, 'active dataset 同名普通索引必须替换为唯一索引。');
      const activeRunSql = repairedIndexDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_dataset_runs_active_dataset'").get().sql;
      assert(/WHERE status IN \('active', 'completed', 'cleanup_pending', 'cleaning'\)/i.test(activeRunSql));
      const activeRegistrySql = repairedIndexDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_data_registry_active_entity'").get().sql;
      assert(/WHERE cleaned_at IS NULL/i.test(activeRegistrySql), 'active registry 错误 WHERE 必须替换。');
      const primaryIndex = repairedIndexDb.prepare("PRAGMA index_list(demo_run_import_batches)").all()
        .find((index) => index.name === 'ux_demo_run_import_batches_primary_context');
      assert.strictEqual(primaryIndex.unique, 1, 'primary context 同名普通索引必须替换为唯一索引。');
      const primarySql = repairedIndexDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_run_import_batches_primary_context'").get().sql;
      assert(/WHERE batch_role = 'primary'/i.test(primarySql));
    } finally {
      repairedIndexDb.close();
    }

    degradeAllGovernanceIndexes();
    initDatabase();
    const allIndexContractDb = openDatabase();
    try {
      assertAllGovernanceIndexesCanonical(allIndexContractDb);
    } finally {
      allIndexContractDb.close();
    }

    const duplicateIndexConflictDb = openDatabase();
    try {
      duplicateIndexConflictDb.exec(`DROP INDEX ux_demo_dataset_runs_active_dataset;
        INSERT INTO demo_dataset_runs
          (run_id, dataset_id, manifest_version, manifest_digest, status, created_at)
        VALUES
          ('conflict-run-a', 'conflict-dataset', 'v1', '${'7'.repeat(64)}', 'active', '2026-08-13T00:00:00.000Z'),
          ('conflict-run-b', 'conflict-dataset', 'v1', '${'8'.repeat(64)}', 'completed', '2026-08-13T00:00:01.000Z');`);
    } finally {
      duplicateIndexConflictDb.close();
    }
    assert.throws(
      () => initDatabase(),
      /active 冲突/,
      'canonical 唯一索引已缺失且数据冲突时必须明确安全失败。'
    );
    const conflictCleanupDb = openDatabase();
    try {
      assert.strictEqual(
        conflictCleanupDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'index' AND name = 'ux_demo_dataset_runs_active_dataset'").get().total,
        0,
        '安全失败不得半途创建 canonical 唯一索引。'
      );
      conflictCleanupDb.prepare("DELETE FROM demo_dataset_runs WHERE run_id IN ('conflict-run-a', 'conflict-run-b')").run();
    } finally {
      conflictCleanupDb.close();
    }
    initDatabase();

    createUserWithPermissions('demo_none', 'demo-none', []);
    createUserWithPermissions('demo_viewer', 'demo-viewer', ['system:demo:view']);
    const manualAdminGrantDb = openDatabase();
    try {
      const adminRoleId = manualAdminGrantDb.prepare("SELECT id FROM sys_roles WHERE role_code = 'super_admin'").get().id;
      const toggleMenuId = manualAdminGrantDb.prepare("SELECT id FROM sys_menus WHERE permission_code = 'system:demo:toggle'").get().id;
      manualAdminGrantDb.prepare('INSERT INTO sys_role_menus (role_id, menu_id) VALUES (?, ?)').run(adminRoleId, toggleMenuId);
    } finally {
      manualAdminGrantDb.close();
    }
    initDatabase();
    const ordinaryDb = openDatabase();
    try {
      for (const roleCode of ['demo_none', 'demo_viewer']) {
        const permissions = ordinaryDb.prepare(`SELECT menu.permission_code AS permissionCode
          FROM sys_role_menus AS role_menu
          JOIN sys_roles AS role ON role.id = role_menu.role_id
          JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
          WHERE role.role_code = ? AND menu.permission_code LIKE 'system:demo:%'
          ORDER BY menu.permission_code`).all(roleCode).map((row) => row.permissionCode);
        assert.deepStrictEqual(permissions, roleCode === 'demo_viewer' ? ['system:demo:view'] : [], '重复初始化不得给普通角色扩权。');
      }
      const superAdminPermissions = ordinaryDb.prepare(`SELECT menu.permission_code AS permissionCode
        FROM sys_role_menus AS role_menu
        JOIN sys_roles AS role ON role.id = role_menu.role_id
        JOIN sys_menus AS menu ON menu.id = role_menu.menu_id
        WHERE role.role_code = 'super_admin' AND menu.permission_code LIKE 'system:demo:%'
        ORDER BY menu.permission_code`).all().map((row) => row.permissionCode);
      assert.deepStrictEqual(superAdminPermissions, ['system:demo:toggle'], '重复初始化必须保留人工授权且不得补授其他四项。');
    } finally {
      ordinaryDb.close();
    }

    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    assert.strictEqual((await request(server, 'GET', '/api/system/demo-data/status')).status, 401);

    const missingBackupResponse = await request(server, 'POST', '/api/system/backups/not-present.sqlite/restore');
    assert.strictEqual(missingBackupResponse.status, 401, '未认证恢复请求仍应先由认证边界拒绝。');

    const noneLogin = await request(server, 'POST', '/api/login', { username: 'demo-none', password: 'Password123!' });
    assert.strictEqual(noneLogin.status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/system/demo-data/status', null, noneLogin.body.data.token)).status, 403);

    const viewerLogin = await request(server, 'POST', '/api/login', { username: 'demo-viewer', password: 'Password123!' });
    assert.strictEqual(viewerLogin.status, 200);
    const viewerToken = viewerLogin.body.data.token;
    const viewerStatus = await request(server, 'GET', '/api/system/demo-data/status', null, viewerToken);
    assert.strictEqual(viewerStatus.status, 200);
    assert.strictEqual(viewerStatus.body.data.runtime.enabled, true);
    assert.strictEqual(viewerStatus.body.data.confirmationTexts.legacyClaim, LEGACY_CLAIM_CONFIRMATION_TEXT);
    assert.strictEqual(viewerStatus.body.data.confirmationTexts.cleanup, CLEANUP_CONFIRMATION_TEXT);
    assert.deepStrictEqual(viewerStatus.body.data.capabilities, {
      status: true,
      toggle: true,
      catalog: true,
      activeRun: true,
      download: true,
      contextIssue: true,
      contextReassociate: true,
      centralPreviewExecuteContext: true,
      retainedUploadReplayContext: false,
      ownershipRegistration: false,
      legacyClaimPreview: false,
      legacyClaimExecute: false,
      cleanupPreview: false,
      cleanupExecute: false
    });
    assert.strictEqual((await request(server, 'POST', '/api/system/demo-data/toggle', { enabled: false }, viewerToken)).status, 403);

    const invalidTokenStatus = await request(server, 'GET', '/api/system/demo-data/status', null, 'invalid-token');
    assert.strictEqual(invalidTokenStatus.status, 401, '真正无效 token 必须继续返回 401。');
    assert.strictEqual(invalidTokenStatus.body.error.code, 'UNAUTHENTICATED');

    const barrierPermit = blockDatabaseAdmission();
    try {
      const blockedStatus = await request(server, 'GET', '/api/system/demo-data/status', null, viewerToken);
      assert.strictEqual(blockedStatus.status, 423, '有效 token 在 restore barrier 期间不得被误判为 401。');
      assert.strictEqual(blockedStatus.body.error.code, 'DATABASE_ADMISSION_BLOCKED');
      assert.deepStrictEqual(blockedStatus.body.error.details, { retryable: true });
      assert(!JSON.stringify(blockedStatus.body).includes(tmpDir), 'barrier 响应不得泄露本地路径。');
      assert(!JSON.stringify(blockedStatus.body).toLowerCase().includes('permit'), 'barrier 响应不得泄露内部 permit。');
    } finally {
      unblockDatabaseAdmission(barrierPermit);
    }
    const statusAfterBarrier = await request(server, 'GET', '/api/system/demo-data/status', null, viewerToken);
    assert.strictEqual(statusAfterBarrier.status, 200, 'barrier 解除后同一有效 token 必须继续可用。');

    const adminLogin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    assert.strictEqual(adminLogin.status, 200);
    const adminToken = adminLogin.body.data.token;
    const missingBackup = await request(server, 'POST', '/api/system/backups/not-present.sqlite/restore', null, adminToken);
    assert.strictEqual(missingBackup.status, 404);
    assert(!JSON.stringify(missingBackup.body).includes(tmpDir));
    assert.deepStrictEqual(missingBackup.body.error.details, { backupName: 'not-present.sqlite', code: 'BACKUP_NOT_FOUND' });
    const invalidBackupName = await request(server, 'POST', '/api/system/backups/%2E%2E%2Fevil.sqlite/restore', null, adminToken);
    assert.strictEqual(invalidBackupName.status, 400);
    assert(!JSON.stringify(invalidBackupName.body).includes(tmpDir));
    const adminStatusViaSuperAdminFallback = await request(server, 'GET', '/api/system/demo-data/status', null, adminToken);
    assert.strictEqual(adminStatusViaSuperAdminFallback.status, 200, 'super_admin 无 view 角色关联时仍应沿用全局服务端兜底。');
    assert.strictEqual(adminStatusViaSuperAdminFallback.body.data.runtime.enabled, true, '系统开关状态必须对 super_admin 明确返回且不能被权限兜底改写。');
    const invalidToggle = await request(server, 'POST', '/api/system/demo-data/toggle', { enabled: 'false' }, adminToken);
    assert.strictEqual(invalidToggle.status, 400);
    const adminToggle = await request(server, 'POST', '/api/system/demo-data/toggle', { enabled: false }, adminToken);
    assert.strictEqual(adminToggle.status, 200);
    assert.strictEqual(adminToggle.body.data.runtime.enabled, false);
    assert.strictEqual(adminToggle.body.data.runtime.runtimeEpoch, 5);
    assert.strictEqual(adminToggle.body.data.runtime.revision, 5);
    const toggleAuditDb = openDatabase();
    try {
      const toggleAudit = toggleAuditDb.prepare(`SELECT user_id AS userId, ip, detail_json AS detailJson
        FROM sys_operation_logs WHERE operation = 'system.demo.runtime.toggle' ORDER BY id DESC LIMIT 1`).get();
      const toggleDetail = JSON.parse(toggleAudit.detailJson);
      assert.strictEqual(toggleAudit.userId, 1);
      assert(toggleAudit.ip, 'toggle 审计必须记录请求 IP。');
      assert.strictEqual(toggleDetail.previousEnabled, true);
      assert.strictEqual(toggleDetail.enabled, false);
      assert.strictEqual(toggleDetail.runtimeEpoch, 5);
      assert.strictEqual(toggleDetail.revision, 5);
    } finally {
      toggleAuditDb.close();
    }
    await runWithMaintenance('demo-governance-test', async () => {
      const lockedToggle = await request(server, 'POST', '/api/system/demo-data/toggle', { enabled: true }, adminToken);
      assert.strictEqual(lockedToggle.status, 423);
      assert.strictEqual(lockedToggle.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    });

    const backupEnabledState = toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    const currentSchemaBackup = await createBackup({ reason: 'manual' });
    const beforeCurrentRestore = toggleDemoRuntime({ enabled: false, actorUserId: 1 });
    const currentSchemaRestore = await restoreBackup(currentSchemaBackup.backupName, {
      userId: 1,
      username: 'admin',
      displayName: '请求快照不得覆盖恢复库可信资料',
      ip: '127.0.0.1'
    });
    assert.strictEqual(currentSchemaRestore.demoRuntimeSafetyReset.enabled, false);
    assert.strictEqual(currentSchemaRestore.demoRuntimeSafetyReset.runtimeEpoch, Math.max(backupEnabledState.runtimeEpoch, beforeCurrentRestore.runtimeEpoch) + 1);
    assert.strictEqual(currentSchemaRestore.demoRuntimeSafetyReset.revision, Math.max(backupEnabledState.revision, beforeCurrentRestore.revision) + 1);
    assert.strictEqual(currentSchemaRestore.demoRuntimeSafetyReset.changeReason, DATABASE_RESTORE_SAFETY_REASON);
    assert.strictEqual(currentSchemaRestore.demoRuntimeSafetyReset.updatedBy, 1);
    assert.deepStrictEqual(currentSchemaRestore.cleanupWarnings, []);
    const publicCurrentRestore = toPublicRestoreResult(currentSchemaRestore);
    assert.deepStrictEqual(publicCurrentRestore.cleanupWarnings, []);
    assert(!JSON.stringify(publicCurrentRestore).includes(tmpDir));
    const actorMatchedDb = openDatabase();
    try {
      const matchedSetting = actorMatchedDb.prepare('SELECT updated_by AS updatedBy FROM demo_runtime_settings WHERE id = 1').get();
      assert.strictEqual(matchedSetting.updatedBy, 1, '恢复库 actor 匹配时 updated_by 必须关联可信用户。');
      for (const operation of ['system.demo.runtime.restore-safety-reset', 'system.backup.restore']) {
        const matchedAudit = actorMatchedDb.prepare(`SELECT user_id AS userId, detail_json AS detailJson
          FROM sys_operation_logs WHERE operation = ? ORDER BY id DESC LIMIT 1`).get(operation);
        const matchedDetail = JSON.parse(matchedAudit.detailJson);
        assert.strictEqual(matchedAudit.userId, 1, `${operation} 必须关联恢复库可信用户。`);
        assert.strictEqual(matchedDetail.actorResolvedInRestoredDatabase, true);
        assert.strictEqual(matchedDetail.requestActorSnapshot.displayName, '请求快照不得覆盖恢复库可信资料');
        assert.strictEqual(matchedDetail.resolvedActor.username, 'admin');
        assert.strictEqual(matchedDetail.resolvedActor.displayName, '系统管理员');
      }
    } finally {
      actorMatchedDb.close();
    }

    const badAuditBackupName = 'legacy-bad-operation-audit.sqlite';
    const badAuditBackupPath = path.join(process.env.BACKUPS_DIR, badAuditBackupName);
    createLegacyBackupWithoutDemoGovernance(badAuditBackupPath);
    const badAuditDb = new Database(badAuditBackupPath);
    try {
      badAuditDb.pragma('foreign_keys = OFF');
      badAuditDb.exec(`DROP TABLE sys_operation_logs;
        CREATE TABLE sys_operation_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation INTEGER NOT NULL CHECK (operation = 1)
        );`);
      badAuditDb.pragma('foreign_keys = ON');
    } finally {
      badAuditDb.close();
    }
    const beforeFailedRestoreSha = require('crypto').createHash('sha256')
      .update(fs.readFileSync(process.env.SQLITE_PATH)).digest('hex');
    await assert.rejects(() => restoreBackup(badAuditBackupName, {
      userId: 1,
      username: 'admin',
      displayName: '系统管理员',
      ip: '127.0.0.1'
    }), (error) => {
      assert.strictEqual(error.code, 'BACKUP_RESTORE_FAILED');
      assert.deepStrictEqual(Object.keys(error.details).sort(), ['backupName', 'code', 'phase', 'retryable', 'rollbackStatus'].sort());
      assert(!JSON.stringify(error.details).includes(tmpDir));
      return true;
    });
    const afterFailedRestoreSha = require('crypto').createHash('sha256')
      .update(fs.readFileSync(process.env.SQLITE_PATH)).digest('hex');
    assert.strictEqual(afterFailedRestoreSha, beforeFailedRestoreSha, '候选迁移或审计失败不得改动正式数据库文件。');
    assert.strictEqual(getDemoRuntimeStatus().enabled, false, '恢复失败后正式数据库必须保持 fail-closed。');

    const legacyBackupName = 'legacy-without-demo-governance.sqlite';
    const legacyBackupPath = path.join(process.env.BACKUPS_DIR, legacyBackupName);
    createLegacyBackupWithoutDemoGovernance(legacyBackupPath);

    initDatabase();
    initDatabase();
    const idempotentDb = openDatabase();
    try {
      GOVERNANCE_TABLES.forEach((tableName) => {
        assert.strictEqual(idempotentDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName).total, 1);
      });
      DEMO_PERMISSIONS.forEach((permissionCode) => {
        assert.strictEqual(idempotentDb.prepare('SELECT COUNT(*) AS total FROM sys_menus WHERE permission_code = ?').get(permissionCode).total, 1);
      });
    } finally {
      idempotentDb.close();
    }

    const beforeLegacyRestore = toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    const restoreResult = await restoreBackup(legacyBackupName, {
      userId: 1,
      username: 'not-admin',
      displayName: '未确认的请求身份',
      ip: '127.0.0.1'
    });
    assert.strictEqual(restoreResult.restoredFrom.backupName, legacyBackupName);
    assert.strictEqual(restoreResult.demoRuntimeSafetyReset.enabled, false);
    assert.strictEqual(restoreResult.demoRuntimeSafetyReset.runtimeEpoch, beforeLegacyRestore.runtimeEpoch + 1);
    assert.strictEqual(restoreResult.demoRuntimeSafetyReset.revision, beforeLegacyRestore.revision + 1);
    assert.strictEqual(restoreResult.demoRuntimeSafetyReset.changeReason, DATABASE_RESTORE_SAFETY_REASON);
    assert(!JSON.stringify({
      restoredFrom: restoreResult.restoredFrom,
      preRestoreBackup: restoreResult.preRestoreBackup,
      demoRuntimeSafetyReset: restoreResult.demoRuntimeSafetyReset,
      note: restoreResult.note
    }).includes(tmpDir), '备份对外白名单信息不得包含隔离目录。');

    const restoredDb = openDatabase();
    try {
      GOVERNANCE_TABLES.forEach((tableName) => {
        assert.strictEqual(restoredDb.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName).total, 1, `旧备份恢复后必须迁移 ${tableName}`);
      });
      const restoredSetting = restoredDb.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch, revision,
          updated_by AS updatedBy, change_reason AS changeReason FROM demo_runtime_settings WHERE id = 1`).get();
      assert.deepStrictEqual(restoredSetting, {
        enabled: 0,
        runtimeEpoch: beforeLegacyRestore.runtimeEpoch + 1,
        revision: beforeLegacyRestore.revision + 1,
        updatedBy: null,
        changeReason: DATABASE_RESTORE_SAFETY_REASON
      });
      assert.strictEqual(restoredDb.pragma('foreign_key_check').length, 0);
      const restoreAudit = restoredDb.prepare(`SELECT user_id AS userId, operation, ip, detail_json AS detailJson
        FROM sys_operation_logs WHERE operation = 'system.demo.runtime.restore-safety-reset'
        ORDER BY id DESC LIMIT 1`).get();
      assert(restoreAudit && restoreAudit.detailJson.includes(DATABASE_RESTORE_SAFETY_REASON));
      assert.strictEqual(restoreAudit.userId, null);
      const restoreAuditDetail = JSON.parse(restoreAudit.detailJson);
      assert.strictEqual(restoreAuditDetail.actorResolvedInRestoredDatabase, false);
      assert.strictEqual(restoreAuditDetail.requestActorSnapshot.username, 'not-admin');
      assert.strictEqual(restoreAuditDetail.requestActorSnapshot.displayName, '未确认的请求身份');
      assert.strictEqual(restoreAuditDetail.resolvedActor, null);
      const backupRestoreAudit = restoredDb.prepare(`SELECT user_id AS userId, operation, ip, detail_json AS detailJson
        FROM sys_operation_logs WHERE operation = 'system.backup.restore'
        ORDER BY id DESC LIMIT 1`).get();
      assert(backupRestoreAudit, '恢复成功必须写独立 system.backup.restore 审计。');
      const backupRestoreDetail = JSON.parse(backupRestoreAudit.detailJson);
      assert.strictEqual(backupRestoreAudit.userId, null);
      assert.strictEqual(backupRestoreDetail.backupName, legacyBackupName);
      assert.strictEqual(backupRestoreDetail.requestActorSnapshot.username, 'not-admin');
      assert.strictEqual(backupRestoreDetail.requestActorSnapshot.displayName, '未确认的请求身份');
      assert.strictEqual(backupRestoreDetail.actorResolvedInRestoredDatabase, false);
      assert.strictEqual(backupRestoreDetail.resolvedActor, null);
    } finally {
      restoredDb.close();
    }

    console.log('demo governance foundation tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows SQLite 句柄释放可能略晚于 close；临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
