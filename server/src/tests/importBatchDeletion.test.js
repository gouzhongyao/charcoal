const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// 隔离测试根目录用于保证所有 SQLite、上传和备份操作不触碰正式业务数据。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-import-batch-delete-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'import-batch-delete.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
// development 环境用于验证原生备份异常不会被通用错误处理器回显到 HTTP 响应。
process.env.NODE_ENV = 'development';

const { initDatabase, openDatabase } = require('../db/database');
const { app } = require('../index');
const { login } = require('../services/authService');
const { deleteImportBatch } = require('../services/importService');
const backupService = require('../services/backupService');
const { runWithMaintenance } = require('../services/maintenanceState');

/**
 * 向隔离 HTTP 服务发送 JSON 请求。
 * @param {object} server 当前测试服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname API 路径。
 * @param {object|null} body 可选 JSON 请求体。
 * @param {string|null} token 可选 Bearer Token。
 * @returns {Promise<{ status: number, body: object|null }>} HTTP 状态和响应体。
 */
function request(server, method, pathname, body = null, token = null) {
  return new Promise((resolve, reject) => {
    // JSON 请求文本用于 POST 登录等有请求体接口。
    const rawBody = body ? JSON.stringify(body) : '';
    // 请求头用于按需附加内容类型、长度和认证令牌。
    const headers = {
      ...(rawBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    // 当前请求用于收集完整响应后统一解析 JSON。
    const currentRequest = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (response) => {
      // 响应分片用于等待服务端完整输出。
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        // 响应文本用于兼容无正文结果。
        const responseText = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: responseText ? JSON.parse(responseText) : null
        });
      });
    });
    currentRequest.on('error', reject);
    currentRequest.end(rawBody);
  });
}

/**
 * 创建一个导入批次及其能耗、错误和旧碳结果夹具。
 * @param {object} db 当前隔离 SQLite 连接。
 * @param {string} suffix 唯一夹具后缀。
 * @param {object} options 批次类型、记录数和文件名选项。
 * @returns {{ batchId: number, storedFilename: string, energyRecordIds: number[], carbonEmissionIds: number[] }} 夹具标识。
 */
function createDeletionFixture(db, suffix, options = {}) {
  // 导入类型用于构造普通能耗或受保护领域批次。
  const importType = options.importType || 'energy_record';
  // 能耗记录数量用于创建成功删除和回滚场景。
  const recordCount = Number.isInteger(options.recordCount) ? options.recordCount : 1;
  // 原文件名用于验证用户可见结果和持久审计。
  const originalFilename = options.originalFilename || `${suffix}-原文件.csv`;
  // 存储文件名用于验证删除动作不物理清理上传原件。
  const storedFilename = options.storedFilename || `${suffix}-stored.csv`;
  // 批次插入结果用于关联错误和能耗记录。
  const batchResult = db.prepare(
    `INSERT INTO import_batches (
       import_type,
       original_filename,
       stored_filename,
       file_type,
       status,
       total_rows,
       success_count,
       failure_count,
       skipped_count,
       duplicate_strategy
     ) VALUES (?, ?, ?, 'csv', 'completed_with_errors', ?, ?, 1, 0, 'skip')`
  ).run(importType, originalFilename, storedFilename, recordCount + 1, recordCount);
  // 数字批次 ID 用于返回给 API 和服务测试。
  const batchId = Number(batchResult.lastInsertRowid);
  db.prepare(
    `INSERT INTO import_errors
       (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
     VALUES (?, ?, '用量', '-1', 'INVALID_VALUE', '测试错误', 'error')`
  ).run(batchId, recordCount + 1);

  // 能耗记录 ID 列表用于逐条验证事务删除或回滚。
  const energyRecordIds = [];
  // 旧碳结果 ID 列表用于验证关联结果同步删除。
  const carbonEmissionIds = [];
  if (importType === 'carbon_activity') {
    const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, ?, ?, 'department', 'active')`).run(
      `CARBON-DELETE-${suffix}`,
      `碳活动删除保护 ${suffix}`,
      `/CARBON-DELETE-${suffix}`
    ).lastInsertRowid);
    db.prepare(`INSERT INTO carbon_activity_records
      (source_type, source_batch_id, source_row_number, activity_code, activity_code_key,
       emission_scope, activity_category, activity_category_key, organization_unit_id,
       energy_type_id, start_wall_clock, end_wall_clock, source_timezone, start_utc,
       end_utc, activity_value, activity_unit, factor_region, source_reference,
       duplicate_key, record_status)
      VALUES ('independent_activity', ?, 2, ?, ?, 'scope_2', '购入电力', '购入电力', ?, ?,
       '2026-08-24T09:00', '2026-08-24T10:00', 'Asia/Shanghai',
       '2026-08-24T01:00:00Z', '2026-08-24T02:00:00Z', 100, 'kWh', 'default', ?, ?, 'active')`)
      .run(
        batchId,
        `CA-DELETE-${suffix}`,
        `CA-DELETE-${suffix}`.toUpperCase(),
        organizationUnitId,
        electricityId,
        `carbon-delete-${suffix}`,
        require('crypto').createHash('sha256').update(`carbon-delete-${suffix}`).digest('hex')
      );
  }
  if (importType === 'energy_record') {
    // 电力能源类型用于满足能耗记录外键。
    const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    // canonical 用能单元用于满足能耗记录必填外键。
    const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES (?, ?, ?, 'department', 'active')`).run(
      `ENERGY-DELETE-${suffix}`,
      `能耗删除闭环 ${suffix}`,
      `/ENERGY-DELETE-${suffix}`
    ).lastInsertRowid);
    // 能耗记录插入语句用于按夹具数量生成真实批次数据。
    const insertEnergyRecord = db.prepare(
      `INSERT INTO energy_records (
         source_batch_id,
         source_row_number,
         energy_type_id,
         organization_unit_id,
         original_month,
         normalized_month,
         original_unit,
         original_value,
         normalized_unit,
         normalized_value,
         duplicate_key
       ) VALUES (?, ?, ?, ?, '2026-08', '2026-08', 'kWh', ?, 'kWh', ?, ?)`
    );
    // 旧碳结果插入语句用于构造不依赖碳因子的 factor_missing 追溯记录。
    const insertCarbonEmission = db.prepare(
      `INSERT INTO carbon_emissions (
         energy_record_id,
         activity_value,
         activity_unit,
         status,
         note
       ) VALUES (?, ?, 'kWh', 'factor_missing', '删除闭环测试旧结果')`
    );
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      // 当前能耗值用于创建稳定的非负记录。
      const energyValue = 100 + recordIndex;
      // 当前能耗记录 ID 用于关联旧碳结果。
      const energyRecordId = Number(insertEnergyRecord.run(
        batchId,
        recordIndex + 1,
        electricityId,
        organizationUnitId,
        energyValue,
        energyValue,
        `import-batch-delete-${suffix}-${recordIndex}`
      ).lastInsertRowid);
      energyRecordIds.push(energyRecordId);
      // 当前旧碳结果 ID 用于删除后精确断言。
      const carbonEmissionId = Number(insertCarbonEmission.run(energyRecordId, energyValue).lastInsertRowid);
      carbonEmissionIds.push(carbonEmissionId);
    }
  }
  return { batchId, originalFilename, storedFilename, energyRecordIds, carbonEmissionIds };
}

/**
 * 读取指定批次及其关联记录数量。
 * @param {number} batchId 批次 ID。
 * @returns {{ batches: number, errors: number, energyRecords: number, carbonEmissions: number }} 数据计数。
 */
function readFixtureCounts(batchId) {
  // 独立短连接用于观察上一个事务提交或回滚后的最终状态。
  const db = openDatabase();
  try {
    return {
      batches: db.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE id = ?').get(batchId).total,
      errors: db.prepare('SELECT COUNT(*) AS total FROM import_errors WHERE batch_id = ?').get(batchId).total,
      energyRecords: db.prepare('SELECT COUNT(*) AS total FROM energy_records WHERE source_batch_id = ?').get(batchId).total,
      carbonEmissions: db.prepare(
        `SELECT COUNT(*) AS total
         FROM carbon_emissions
         WHERE energy_record_id IN (
           SELECT id FROM energy_records WHERE source_batch_id = ?
         )`
      ).get(batchId).total
    };
  } finally {
    db.close();
  }
}

/**
 * 列出隔离备份目录中的 SQLite 文件名。
 * @returns {string[]} 备份文件名列表。
 */
/** 读取受保护独立碳活动批次及其问题和活动事实数量。 */
function readCarbonActivityFixtureCounts(batchId) {
  const db = openDatabase();
  try {
    return {
      batches: db.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE id = ?').get(batchId).total,
      errors: db.prepare('SELECT COUNT(*) AS total FROM import_errors WHERE batch_id = ?').get(batchId).total,
      carbonActivities: db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records WHERE source_batch_id = ?').get(batchId).total
    };
  } finally {
    db.close();
  }
}

function listBackupNames() {
  if (!fs.existsSync(process.env.BACKUPS_DIR)) return [];
  return fs.readdirSync(process.env.BACKUPS_DIR).filter((filename) => /\.(?:sqlite|db)$/i.test(filename));
}

(async () => {
  // 隔离 HTTP 服务句柄用于测试结束时可靠关闭。
  let server;
  try {
    initDatabase();
    // 初始数据库连接用于创建普通用户、受保护批次和故障夹具。
    const setupDb = openDatabase();
    // 当前时间用于满足用户、角色关联的审计字段。
    const now = new Date().toISOString();
    // 普通角色 ID 用于构造没有 imports:delete 的真实用户。
    const userRoleId = setupDb.prepare("SELECT id FROM sys_roles WHERE role_code = 'user'").get().id;
    // 普通用户 ID 用于 403 权限验证。
    const normalUserId = Number(setupDb.prepare(
      `INSERT INTO sys_users (username, display_name, password_hash, status, created_at, updated_at)
       VALUES ('import-viewer', '导入查看用户', ?, 'active', ?, ?)`
    ).run(bcrypt.hashSync('Password123!', 10), now, now).lastInsertRowid);
    setupDb.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(normalUserId, userRoleId, now);
    // 特殊领域批次用于验证严格白名单在备份前拒绝删除。
    const protectedFixture = createDeletionFixture(setupDb, 'protected', {
      importType: 'production_output',
      recordCount: 0,
      originalFilename: '受保护月度产量.csv'
    });
    const carbonActivityProtectedFixture = createDeletionFixture(setupDb, 'carbon-activity-protected', {
      importType: 'carbon_activity',
      recordCount: 0,
      originalFilename: '受保护独立碳活动.xlsx',
      storedFilename: 'carbon-activity-protected.xlsx'
    });
    // 服务级备份失败夹具用于验证任何业务删除都不会提交。
    const backupFailureFixture = createDeletionFixture(setupDb, 'backup-failure', { recordCount: 1 });
    // HTTP 备份失败夹具用于验证 development 响应仍保持稳定且不泄漏本机路径。
    const httpBackupFailureFixture = createDeletionFixture(setupDb, 'http-backup-failure', { recordCount: 1 });
    // 审计失败夹具用于验证业务删除和操作审计同事务回滚。
    const auditFailureFixture = createDeletionFixture(setupDb, 'audit-failure', { recordCount: 2 });
    setupDb.close();

    // 管理员登录结果用于所有授权删除请求和服务审计操作者。
    const adminLogin = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }, { ip: '127.0.0.1' });
    // 普通用户登录结果用于验证没有危险权限时返回 403。
    const normalLogin = login({ username: 'import-viewer', password: 'Password123!' }, { ip: '127.0.0.1' });
    // 服务审计操作者用于直接故障注入测试。
    const serviceActor = {
      userId: adminLogin.user.id,
      username: adminLogin.user.username,
      displayName: adminLogin.user.displayName,
      ip: '127.0.0.1'
    };

    server = await new Promise((resolve) => {
      // 本地随机端口服务用于非浏览器 API 集成测试。
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    // 初始备份数量用于证明认证、权限、维护态、404 和特殊领域失败不会创建无意义备份。
    const initialBackupCount = listBackupNames().length;
    // 未认证结果必须由认证边界优先返回 401。
    const unauthenticatedResult = await request(server, 'DELETE', `/api/imports/batches/${protectedFixture.batchId}`);
    assert.strictEqual(unauthenticatedResult.status, 401);
    assert.strictEqual(unauthenticatedResult.body.error.code, 'UNAUTHENTICATED');

    // 无删除权限结果必须返回 403，普通角色不会因菜单补种自动扩权。
    const forbiddenResult = await request(server, 'DELETE', `/api/imports/batches/${protectedFixture.batchId}`, null, normalLogin.token);
    assert.strictEqual(forbiddenResult.status, 403);
    assert.strictEqual(forbiddenResult.body.error.code, 'FORBIDDEN');

    // 维护态结果必须在进入服务前返回 423。
    const maintenanceResult = await runWithMaintenance('test:import-batch-delete', () => request(
      server,
      'DELETE',
      `/api/imports/batches/${protectedFixture.batchId}`,
      null,
      adminLogin.token
    ));
    assert.strictEqual(maintenanceResult.status, 423);
    assert.strictEqual(maintenanceResult.body.error.code, 'MAINTENANCE_IN_PROGRESS');

    // 不存在批次必须返回 404，且不创建备份。
    const missingResult = await request(server, 'DELETE', '/api/imports/batches/999999', null, adminLogin.token);
    assert.strictEqual(missingResult.status, 404);
    assert.strictEqual(missingResult.body.error.code, 'NOT_FOUND');

    // 特殊领域批次必须按严格白名单返回 400，且不进入备份流程。
    const protectedResult = await request(server, 'DELETE', `/api/imports/batches/${protectedFixture.batchId}`, null, adminLogin.token);
    assert.strictEqual(protectedResult.status, 400);
    assert.strictEqual(protectedResult.body.error.code, 'BAD_REQUEST');
    assert.strictEqual(protectedResult.body.error.details.code, 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');
    assert.strictEqual(listBackupNames().length, initialBackupCount, '失败请求不得创建删除前备份。');
    assert.deepStrictEqual(readFixtureCounts(protectedFixture.batchId), {
      batches: 1,
      errors: 1,
      energyRecords: 0,
      carbonEmissions: 0
    });

    // 独立碳活动批次必须同样在备份前 fail-closed，批次、issues 和活动事实全部保留。
    const carbonActivityProtectedResult = await request(
      server,
      'DELETE',
      `/api/imports/batches/${carbonActivityProtectedFixture.batchId}`,
      null,
      adminLogin.token
    );
    assert.strictEqual(carbonActivityProtectedResult.status, 400);
    assert.strictEqual(carbonActivityProtectedResult.body.error.code, 'BAD_REQUEST');
    assert.strictEqual(carbonActivityProtectedResult.body.error.details.code, 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');
    assert.strictEqual(listBackupNames().length, initialBackupCount, '独立碳活动删除拒绝不得创建备份。');
    assert.deepStrictEqual(readCarbonActivityFixtureCounts(carbonActivityProtectedFixture.batchId), {
      batches: 1,
      errors: 1,
      carbonActivities: 1
    });

    // development HTTP 备份故障注入用于证明原生异常路径和消息不会进入公开响应。
    const originalCreateBackup = backupService.createBackup;
    // HTTP 备份失败响应用于在恢复真实服务实现前完成稳定错误断言。
    let httpBackupFailureResult;
    try {
      backupService.createBackup = async () => {
        throw new Error(`原生备份失败：${process.env.SQLITE_PATH}；${process.env.BACKUPS_DIR}`);
      };
      httpBackupFailureResult = await request(
        server,
        'DELETE',
        `/api/imports/batches/${httpBackupFailureFixture.batchId}`,
        null,
        adminLogin.token
      );
    } finally {
      backupService.createBackup = originalCreateBackup;
    }
    assert.strictEqual(httpBackupFailureResult.status, 500);
    assert.strictEqual(httpBackupFailureResult.body.error.code, 'IMPORT_BATCH_DELETE_BACKUP_FAILED');
    assert.strictEqual(httpBackupFailureResult.body.error.message, '删除前备份失败，已拒绝删除。');
    assert.strictEqual(httpBackupFailureResult.body.error.details, null);
    // HTTP 失败响应文本用于集中核对临时根目录、SQLite 路径和备份目录均未泄漏。
    const httpBackupFailureResponseText = JSON.stringify(httpBackupFailureResult.body);
    assert.strictEqual(httpBackupFailureResponseText.includes(temporaryRoot), false);
    assert.strictEqual(httpBackupFailureResponseText.includes(process.env.SQLITE_PATH), false);
    assert.strictEqual(httpBackupFailureResponseText.includes(process.env.BACKUPS_DIR), false);
    assert.deepStrictEqual(readFixtureCounts(httpBackupFailureFixture.batchId), {
      batches: 1,
      errors: 1,
      energyRecords: 1,
      carbonEmissions: 1
    });

    // 服务级备份失败用于证明稳定 AppError 和业务回滚不依赖 HTTP 错误处理器。
    await assert.rejects(
      deleteImportBatch(backupFailureFixture.batchId, {
        actor: serviceActor,
        createBackup: async () => {
          throw new Error(`模拟删除前备份失败：${process.env.SQLITE_PATH}`);
        }
      }),
      (error) => {
        assert.strictEqual(error.code, 'IMPORT_BATCH_DELETE_BACKUP_FAILED');
        assert.strictEqual(error.statusCode, 500);
        assert.strictEqual(error.message, '删除前备份失败，已拒绝删除。');
        assert.strictEqual(error.details, null);
        assert.strictEqual(String(error.message).includes(process.env.SQLITE_PATH), false);
        return true;
      }
    );
    assert.deepStrictEqual(readFixtureCounts(backupFailureFixture.batchId), {
      batches: 1,
      errors: 1,
      energyRecords: 1,
      carbonEmissions: 1
    });

    // 模拟审计插入失败用于证明业务删除和审计在同一事务整体回滚。
    await assert.rejects(
      deleteImportBatch(auditFailureFixture.batchId, {
        actor: serviceActor,
        createBackup: async () => ({
          backupName: 'energy-carbon-import-batch-delete-audit-rollback.sqlite',
          reason: 'import-batch-delete',
          method: 'test-double',
          sizeBytes: 1024,
          sha256: 'test-safe-sha256',
          path: path.join(temporaryRoot, '不得进入响应或审计.sqlite')
        }),
        beforeAuditInsert: () => {
          throw new Error('模拟持久化审计失败');
        }
      }),
      /模拟持久化审计失败/
    );
    assert.deepStrictEqual(readFixtureCounts(auditFailureFixture.batchId), {
      batches: 1,
      errors: 1,
      energyRecords: 2,
      carbonEmissions: 2
    });
    // 审计失败计数用于确认没有残留成功删除日志。
    const auditFailureDb = openDatabase();
    assert.strictEqual(auditFailureDb.prepare(
      `SELECT COUNT(*) AS total FROM sys_operation_logs
       WHERE operation = 'imports.batch.delete' AND target_id = ?`
    ).get(String(auditFailureFixture.batchId)).total, 0);
    auditFailureDb.close();

    // 成功和无关批次夹具在最终 API 场景前创建，确保备份快照包含删除前完整数据。
    const successSetupDb = openDatabase();
    const successFixture = createDeletionFixture(successSetupDb, 'success', {
      recordCount: 2,
      originalFilename: '八月普通能耗.csv',
      storedFilename: 'success-upload.csv'
    });
    const unrelatedFixture = createDeletionFixture(successSetupDb, 'unrelated', {
      recordCount: 1,
      originalFilename: '九月无关能耗.csv'
    });
    // 电力能源类型用于创建与批次删除无关的预测运行和结果。
    const electricityId = successSetupDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    // 预测运行 ID 用于验证删除普通能耗批次不联动删除预测数据。
    const predictionRunId = Number(successSetupDb.prepare(
      `INSERT INTO prediction_runs
         (name, algorithm, status, target_energy_type_id, predict_start_month, predict_end_month, completed_at)
       VALUES ('批次删除非联动预测', 'moving_average', 'completed', ?, '2026-09', '2026-09', ?)`
    ).run(electricityId, now).lastInsertRowid);
    // 预测结果 ID 用于删除后精确验证仍然存在。
    const predictionResultId = Number(successSetupDb.prepare(
      `INSERT INTO prediction_results
         (prediction_run_id, energy_type_id, target_month, predicted_value, predicted_unit)
       VALUES (?, ?, '2026-09', 123.45, 'kWh')`
    ).run(predictionRunId, electricityId).lastInsertRowid);
    successSetupDb.close();
    // 上传原文件夹具用于验证成功删除只删数据库记录，不物理删除文件。
    const uploadedFilePath = path.join(process.env.UPLOADS_DIR, successFixture.storedFilename);
    fs.writeFileSync(uploadedFilePath, 'month,value\n2026-08,100\n', 'utf8');

    // 成功删除结果必须返回实际数量和安全备份标识。
    const successResult = await request(server, 'DELETE', `/api/imports/batches/${successFixture.batchId}`, null, adminLogin.token);
    assert.strictEqual(successResult.status, 200);
    assert.strictEqual(successResult.body.success, true);
    assert.strictEqual(successResult.body.data.batchId, successFixture.batchId);
    assert.strictEqual(successResult.body.data.originalFilename, successFixture.originalFilename);
    assert.strictEqual(successResult.body.data.deletedEnergyRecords, 2);
    assert.strictEqual(successResult.body.data.deletedErrors, 1);
    assert.strictEqual(successResult.body.data.deletedCarbonEmissions, 2);
    assert.strictEqual(successResult.body.data.deletedImportBatches, 1);
    assert.strictEqual(successResult.body.data.deletedStoredFile, false);
    assert.match(successResult.body.data.predictionImpact, /预测运行和结果不会自动删除/);
    assert.match(successResult.body.data.recoveryInformation, /整库恢复流程/);
    assert.match(successResult.body.data.backup.backupName, /^energy-carbon-import-batch-delete-/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(successResult.body.data.backup, 'path'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(successResult.body.data.backup, 'databasePath'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(successResult.body.data.backup, 'backupsDir'), false);
    assert.strictEqual(JSON.stringify(successResult.body).includes(temporaryRoot), false, 'API 响应不得泄漏隔离目录绝对路径。');

    // 删除前真实备份文件必须存在，且快照中仍能读取目标批次和能耗记录。
    const backupPath = path.join(process.env.BACKUPS_DIR, successResult.body.data.backup.backupName);
    assert.strictEqual(fs.existsSync(backupPath), true, '删除成功前必须创建真实 SQLite 备份。');
    // 只读备份连接用于验证快照确实位于删除动作之前。
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    assert.strictEqual(backupDb.prepare('SELECT COUNT(*) AS total FROM import_batches WHERE id = ?').get(successFixture.batchId).total, 1);
    assert.strictEqual(backupDb.prepare('SELECT COUNT(*) AS total FROM energy_records WHERE source_batch_id = ?').get(successFixture.batchId).total, 2);
    backupDb.close();

    // 成功删除后的业务库必须删除目标数据，同时保留无关批次、上传原文件和预测数据。
    assert.deepStrictEqual(readFixtureCounts(successFixture.batchId), {
      batches: 0,
      errors: 0,
      energyRecords: 0,
      carbonEmissions: 0
    });
    assert.deepStrictEqual(readFixtureCounts(unrelatedFixture.batchId), {
      batches: 1,
      errors: 1,
      energyRecords: 1,
      carbonEmissions: 1
    });
    assert.strictEqual(fs.existsSync(uploadedFilePath), true, '批次删除不得物理删除上传原文件。');

    // 成功审计连接用于验证操作者、删除数量、备份和恢复信息完整持久化。
    const verificationDb = openDatabase();
    assert.strictEqual(verificationDb.prepare('SELECT COUNT(*) AS total FROM prediction_runs WHERE id = ?').get(predictionRunId).total, 1);
    assert.strictEqual(verificationDb.prepare('SELECT COUNT(*) AS total FROM prediction_results WHERE id = ?').get(predictionResultId).total, 1);
    // 删除操作审计用于核对目标、用户、IP 和安全详情。
    const operationLog = verificationDb.prepare(
      `SELECT user_id AS userId, operation, target_type AS targetType, target_id AS targetId,
         detail_json AS detailJson, ip
       FROM sys_operation_logs
       WHERE operation = 'imports.batch.delete' AND target_id = ?
       ORDER BY id DESC LIMIT 1`
    ).get(String(successFixture.batchId));
    assert(operationLog, '成功删除必须写入持久化操作审计。');
    assert.strictEqual(operationLog.userId, adminLogin.user.id);
    assert.strictEqual(operationLog.targetType, 'import_batch');
    assert.strictEqual(operationLog.targetId, String(successFixture.batchId));
    assert(operationLog.ip, '操作审计必须记录请求 IP。');
    // 审计详情用于核对批次、原文件、操作者、删除数量和安全备份标识。
    const operationDetail = JSON.parse(operationLog.detailJson);
    assert.strictEqual(operationDetail.actorUsername, adminLogin.user.username);
    assert.strictEqual(operationDetail.batchId, successFixture.batchId);
    assert.strictEqual(operationDetail.originalFilename, successFixture.originalFilename);
    assert.strictEqual(operationDetail.deletedEnergyRecords, 2);
    assert.strictEqual(operationDetail.deletedErrors, 1);
    assert.strictEqual(operationDetail.deletedCarbonEmissions, 2);
    assert.strictEqual(operationDetail.backup.backupName, successResult.body.data.backup.backupName);
    assert.match(operationDetail.recoveryInformation, /整库恢复流程/);
    assert.strictEqual(JSON.stringify(operationDetail).includes(temporaryRoot), false, '持久化审计不得泄漏绝对路径。');
    verificationDb.close();

    console.log('import batch deletion tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
