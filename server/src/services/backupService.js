const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  backupsDir,
  blockDatabaseAdmission,
  databasePath,
  ensureLocalDataDirectories,
  getDatabaseAdmissionState,
  initDatabase,
  openDatabase,
  poisonDatabaseAdmission,
  unblockDatabaseAdmission
} = require('../db/database');
const { assertWritableAllowed, runWithMaintenance } = require('./maintenanceState');
const { normalizeDemoRuntimeAfterRestore, readCanonicalDemoRuntime } = require('./demoRuntimeService');
const { AppError, badRequest, invalidBackup, notFound } = require('../utils/errors');

const BACKUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(sqlite|db)$/i;
// 允许进入备份文件名和审计元数据的正式备份原因。
const BACKUP_REASONS = new Set([
  'manual',
  'pre-restore',
  'meter-reading-energy-record-generation',
  'production-output-import',
  'generation-record-import',
  'energy-analysis-import',
  'carbon-activity-import',
  'carbon-emission-report-import',
  'prediction-config-import',
  'import-batch-delete'
]);
const REQUIRED_BACKUP_SCHEMA = {
  app_meta: [
    ['key'],
    ['value']
  ],
  import_batches: [
    ['id'],
    ['original_filename'],
    ['file_type'],
    ['status'],
    ['total_rows'],
    ['success_count', 'success_rows'],
    ['failure_count', 'failed_rows'],
    ['skipped_count', 'skipped_rows'],
    ['created_at']
  ],
  import_errors: [
    ['id'],
    ['batch_id'],
    ['row_number'],
    ['field_name'],
    ['error_code'],
    ['error_reason', 'error_message']
  ],
  energy_types: [
    ['id'],
    ['code'],
    ['name'],
    ['standard_unit']
  ],
  energy_records: [
    ['id'],
    ['source_batch_id'],
    ['energy_type_id', 'energy_type_code'],
    ['normalized_month'],
    ['normalized_unit'],
    ['normalized_value'],
    ['record_status'],
    ['duplicate_key']
  ],
  carbon_factors: [
    ['id'],
    ['energy_type_id', 'energy_type_code'],
    ['unit'],
    ['factor_value'],
    ['is_active']
  ],
  carbon_emissions: [
    ['id'],
    ['energy_record_id'],
    ['status'],
    ['emission_value'],
    ['calculation_method']
  ],
  prediction_runs: [
    ['id'],
    ['status'],
    ['algorithm'],
    ['train_start_month'],
    ['train_end_month'],
    ['predict_start_month'],
    ['predict_end_month']
  ],
  prediction_results: [
    ['id'],
    ['prediction_run_id', 'run_id'],
    ['target_month'],
    ['predicted_value'],
    ['predicted_unit']
  ]
};
const REQUIRED_BACKUP_TABLES = Object.keys(REQUIRED_BACKUP_SCHEMA);
// admission drain 只等待有限时间，避免恢复接口无限占用维护态。
const DATABASE_DRAIN_TIMEOUT_MS = 2000;
const DATABASE_DRAIN_POLL_MS = 20;
// durable marker 协议和 operationId 文件命名必须与启动恢复校验完全一致。
const DATABASE_RESTORE_MARKER_SCHEMA = 'charcoal-database-restore-marker';
const DATABASE_RESTORE_MARKER_VERSION = 1;
const DATABASE_RESTORE_MARKER_PHASE = 'prepared';
const DATABASE_RESTORE_MARKER_NAME = '.restore-in-progress.json';

function getNowForFilename() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '-$1Z');
}

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertInsideBackupsDir(filePath) {
  const base = path.resolve(backupsDir);
  const target = path.resolve(filePath);
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest('备份文件路径必须位于当前备份目录下。', { code: 'BACKUP_PATH_OUTSIDE_ALLOWLIST' });
  }
}

function assertSafeBackupName(backupName) {
  const name = String(backupName || '').trim();
  if (!name || name !== path.basename(name) || !BACKUP_NAME_PATTERN.test(name)) {
    throw badRequest('backupName 不合法，仅允许当前备份目录下的 .sqlite/.db 文件名。', {
      backupName,
      pattern: BACKUP_NAME_PATTERN.source
    });
  }
  return name;
}

function getBackupPathFromName(backupName) {
  const safeName = assertSafeBackupName(backupName);
  const backupPath = path.join(backupsDir, safeName);
  assertInsideBackupsDir(backupPath);
  return backupPath;
}

function ensureBackupDir() {
  ensureLocalDataDirectories();
  fs.mkdirSync(backupsDir, { recursive: true });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildBackupMetadata(filePath, fileOperations = fs) {
  const statSync = typeof fileOperations.statSync === 'function'
    ? fileOperations.statSync.bind(fileOperations) : fs.statSync.bind(fs);
  const stat = statSync(filePath);
  return {
    backupName: path.basename(filePath),
    path: filePath,
    sizeBytes: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    sha256: sha256File(filePath)
  };
}

function listBackups(options = {}) {
  const fileOperations = options.fileOperations || fs;
  ensureBackupDir();
  const rows = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME_PATTERN.test(entry.name))
    .map((entry) => buildBackupMetadata(path.join(backupsDir, entry.name), fileOperations))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.backupName).localeCompare(String(a.backupName)));

  return {
    backupsDir,
    databasePath,
    rows,
    total: rows.length
  };
}

function assertExistingBackup(backupName, options = {}) {
  const safeName = assertSafeBackupName(backupName);
  const listed = listBackups(options).rows.find((backup) => backup.backupName === safeName);
  if (!listed) {
    throw notFound('备份文件不存在或不在当前备份目录白名单内。', { backupName: safeName, code: 'BACKUP_NOT_FOUND' });
  }
  const backupPath = getBackupPathFromName(safeName);
  assertInsideBackupsDir(backupPath);
  if (normalizeForCompare(backupPath) !== normalizeForCompare(listed.path)) {
    throw badRequest('备份文件路径校验失败。', { backupName: safeName, code: 'BACKUP_PATH_VALIDATION_FAILED' });
  }
  return listed;
}

function buildBackupName(reason = 'manual') {
  const safeReason = BACKUP_REASONS.has(reason) ? reason : 'manual';
  return `energy-carbon-${safeReason}-${getNowForFilename()}-${process.pid}.sqlite`;
}

function checkpointDatabase(options = {}) {
  if (!fs.existsSync(databasePath)) return;
  const db = openDatabase({ admissionPermit: options.admissionPermit });
  try {
    assertCheckpointComplete(db.pragma('wal_checkpoint(TRUNCATE)'), 'DATABASE_CHECKPOINT_INCOMPLETE');
  } finally {
    db.close();
  }
}

/**
 * 校验 WAL checkpoint 无 busy 且全部 log frame 已写回。
 * @param {object[]} checkpointRows better-sqlite3 pragma 返回行。
 * @param {string} code 稳定错误子码。
 */
function assertCheckpointComplete(checkpointRows, code) {
  const incomplete = !Array.isArray(checkpointRows) || checkpointRows.length < 1
    || checkpointRows.some((row) => Number(row.busy) !== 0
      || !Number.isSafeInteger(Number(row.log))
      || !Number.isSafeInteger(Number(row.checkpointed))
      || Number(row.log) !== Number(row.checkpointed));
  if (incomplete) {
    throw badRequest('数据库 checkpoint 未完整写回，暂不能执行恢复。', { code });
  }
}

/** 等待 admission barrier 前已打开的正式库连接自然排空。 */
async function waitForOfficialDatabaseDrain(timeoutMs = DATABASE_DRAIN_TIMEOUT_MS) {
  const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : DATABASE_DRAIN_TIMEOUT_MS;
  const deadline = Date.now() + effectiveTimeoutMs;
  while (getDatabaseAdmissionState().activeConnections !== 0) {
    if (Date.now() >= deadline) {
      throw badRequest('正式数据库连接未在限定时间内排空，暂不能执行恢复。', {
        code: 'DATABASE_DRAIN_TIMEOUT'
      });
    }
    await new Promise((resolve) => setTimeout(resolve, DATABASE_DRAIN_POLL_MS));
  }
}

/** 将恢复标记写入并 fsync，确保双 rename 中间窗口可在下次启动恢复。 */
function writeDurableRestoreMarker(markerPath, marker) {
  const descriptor = fs.openSync(markerPath, 'w');
  try {
    fs.writeFileSync(descriptor, JSON.stringify(marker), 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeSqliteSidecars(sqlitePath) {
  [`${sqlitePath}-wal`, `${sqlitePath}-shm`].forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  });
}

function getTableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all().map((row) => row.name));
}

function validateRequiredColumns(db) {
  return Object.entries(REQUIRED_BACKUP_SCHEMA).flatMap(([tableName, columnGroups]) => {
    const existingColumns = getTableColumns(db, tableName);
    return columnGroups
      .filter((acceptedColumns) => !acceptedColumns.some((columnName) => existingColumns.has(columnName)))
      .map((acceptedColumns) => ({ tableName, acceptedColumns }));
  });
}

function validateBackupFile(backupPath) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(backupPath, { readonly: true, fileMustExist: true });
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') {
      throw invalidBackup('备份文件无效/损坏：SQLite quick_check 未通过。', { quickCheck });
    }

    const foreignKeyCheck = db.pragma('foreign_key_check');
    if (foreignKeyCheck.length > 0) {
      throw invalidBackup('备份文件无效/损坏：SQLite foreign_key_check 未通过。', { foreignKeyCheck });
    }

    const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const missingTables = REQUIRED_BACKUP_TABLES.filter((tableName) => !existingTables.has(tableName));
    if (missingTables.length > 0) {
      throw invalidBackup('备份文件无效/损坏：缺少关键数据表。', { missingTables, requiredTables: REQUIRED_BACKUP_TABLES });
    }

    const missingColumns = validateRequiredColumns(db);
    if (missingColumns.length > 0) {
      throw invalidBackup('备份文件无效/损坏：关键数据表缺少必要字段。', { missingColumns, requiredSchema: REQUIRED_BACKUP_SCHEMA });
    }

    return {
      quickCheck,
      foreignKeyCheck: 'ok',
      requiredTables: REQUIRED_BACKUP_TABLES.slice(),
      requiredSchema: REQUIRED_BACKUP_SCHEMA
    };
  } catch (error) {
    if (error && error.code === 'INVALID_BACKUP_FILE') {
      throw error;
    }
    throw invalidBackup('备份文件无效/损坏，无法作为 SQLite 备份恢复。', {
      code: 'BACKUP_SQLITE_OPEN_OR_READ_FAILED'
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * 使用独立只读快照连接创建 SQLite 备份。
 * @param {string} destinationPath 备份目标路径。
 * @param {object} options 受控备份选项。
 * @returns {Promise<string>} 备份方法。
 */
async function copyDatabaseToBackup(destinationPath, options = {}) {
  const skipCheckpoint = options.skipCheckpoint === true;
  const db = openDatabase({ admissionPermit: options.admissionPermit });
  try {
    // BEGIN IMMEDIATE 调用方持有 RESERVED 锁时不能执行 checkpoint，但在线备份仍可读取锁前已提交快照。
    if (!skipCheckpoint) {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
    if (typeof db.backup === 'function') {
      await db.backup(destinationPath);
      return 'better-sqlite3-backup-api';
    }
    if (skipCheckpoint) {
      throw badRequest('锁内备份要求 SQLite 在线备份 API 可用。', {
        code: 'BACKUP_ONLINE_API_REQUIRED'
      });
    }
  } finally {
    db.close();
  }

  fs.copyFileSync(databasePath, destinationPath);
  return 'wal-checkpoint-copy';
}

async function createBackup(options = {}) {
  ensureBackupDir();
  if (!fs.existsSync(databasePath)) {
    initDatabase();
  }

  const reason = BACKUP_REASONS.has(options.reason) ? options.reason : 'manual';
  const backupName = buildBackupName(reason);
  const backupPath = getBackupPathFromName(backupName);
  if (fs.existsSync(backupPath)) {
    throw badRequest('备份文件名冲突，请稍后重试。', { backupName });
  }

  try {
    const method = await copyDatabaseToBackup(backupPath, {
      skipCheckpoint: options.skipCheckpoint === true,
      admissionPermit: options.admissionPermit
    });
    const metadata = buildBackupMetadata(backupPath, options.fileOperations || fs);
    return {
      ...metadata,
      reason,
      method,
      databasePath,
      backupsDir
    };
  } catch (error) {
    try {
      if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { force: true });
      }
    } catch (_cleanupError) {
      // 备份清理是次生操作，不得覆盖原始备份失败。
    }
    throw error;
  }
}

function getBackupForDownload(backupName) {
  const metadata = assertExistingBackup(backupName);
  return {
    ...metadata,
    streamPath: metadata.path,
    contentType: 'application/octet-stream'
  };
}

function deleteBackup(backupName) {
  assertWritableAllowed('backups:delete');
  ensureBackupDir();
  const metadata = assertExistingBackup(backupName);
  const backupPath = getBackupPathFromName(metadata.backupName);
  assertInsideBackupsDir(backupPath);
  if (normalizeForCompare(backupPath) === normalizeForCompare(databasePath)) {
    throw badRequest('不能删除当前 SQLite 数据库，只能删除备份目录下的备份文件。', {
      backupName: metadata.backupName,
      code: 'CURRENT_DATABASE_DELETE_FORBIDDEN'
    });
  }

  const deletedBytes = metadata.sizeBytes;
  fs.rmSync(backupPath, { force: false });
  return {
    deleted: true,
    deletedBackupName: metadata.backupName,
    deletedBytes,
    backupsDir,
    note: '仅删除所选备份文件，不影响当前 SQLite 数据库。'
  };
}

async function restoreBackup(backupName, actor = {}, options = {}) {
  const fileOperations = options.fileOperations || fs;
  const safeBackupName = (() => {
    try {
      return assertSafeBackupName(backupName);
    } catch (_error) {
      return String(backupName || '').trim();
    }
  })();
  return runWithMaintenance('backups:restore', async () => {
    const admissionPermit = blockDatabaseAdmission();
    let source = null;
    let validation = null;
    let sourceResolutionAttempted = false;
    let sourceValidated = false;
    let preRestoreBackup = null;
    let frozenLiveRuntime = null;
    const operationId = crypto.randomUUID();
    const candidatePath = path.join(path.dirname(databasePath), `.restore-candidate-${operationId}.sqlite`);
    const oldStagingPath = path.join(path.dirname(databasePath), `.restore-old-${operationId}.sqlite`);
    const markerPath = path.join(path.dirname(databasePath), DATABASE_RESTORE_MARKER_NAME);
    let officialMoved = false;
    let candidateMoved = false;
    let demoRuntimeSafetyReset = null;
    try {
      if (typeof options.onAdmissionBlocked === 'function') {
        await options.onAdmissionBlocked();
      }
      await waitForOfficialDatabaseDrain(options.drainTimeoutMs);
      frozenLiveRuntime = readCanonicalDemoRuntime({ admissionPermit });
      preRestoreBackup = await createBackup({
        reason: 'pre-restore',
        fileOperations,
        admissionPermit
      });
      if (typeof options.onPreRestoreBackupCreated === 'function') {
        await options.onPreRestoreBackupCreated(preRestoreBackup);
      }
      sourceResolutionAttempted = true;
      source = assertExistingBackup(backupName, { fileOperations });
      validation = validateBackupFile(source.path);
      sourceValidated = true;
      fs.copyFileSync(source.path, candidatePath);
      removeSqliteSidecars(candidatePath);
      initDatabase({ databasePath: candidatePath });
      const candidateDb = openDatabase({ databasePath: candidatePath });
      try {
        if (typeof options.onCandidatePrepared === 'function') {
          await options.onCandidatePrepared({ databasePath: candidatePath, db: candidateDb });
        }
        const requestActorSnapshot = {
          userId: typeof actor.userId === 'number' && Number.isSafeInteger(actor.userId) && actor.userId > 0
            ? actor.userId : null,
          username: actor.username ? String(actor.username) : null,
          displayName: actor.displayName ? String(actor.displayName) : null,
          ip: actor.ip ? String(actor.ip) : null
        };
        const resolvedActor = requestActorSnapshot.userId && requestActorSnapshot.username
          ? candidateDb.prepare(`SELECT id, username, display_name AS displayName FROM sys_users
            WHERE id = ? AND username = ?`).get(requestActorSnapshot.userId, requestActorSnapshot.username)
          : null;
        if (candidateDb.pragma('quick_check', { simple: true }) !== 'ok'
          || candidateDb.pragma('integrity_check', { simple: true }) !== 'ok'
          || candidateDb.pragma('foreign_key_check').length > 0) {
          throw new Error('候选数据库完整性检查失败。');
        }
      } finally {
        candidateDb.close();
      }
      removeSqliteSidecars(candidatePath);

      const frozenCandidateDb = openDatabase({ databasePath: candidatePath });
      try {
        demoRuntimeSafetyReset = normalizeDemoRuntimeAfterRestore(actor, {
          db: frozenCandidateDb,
          minimumRuntimeEpoch: frozenLiveRuntime.runtimeEpoch,
          minimumRevision: frozenLiveRuntime.revision
        });
        const requestActorSnapshot = {
          userId: typeof actor.userId === 'number' && Number.isSafeInteger(actor.userId) && actor.userId > 0
            ? actor.userId : null,
          username: actor.username ? String(actor.username) : null,
          displayName: actor.displayName ? String(actor.displayName) : null,
          ip: actor.ip ? String(actor.ip) : null
        };
        const resolvedActor = requestActorSnapshot.userId && requestActorSnapshot.username
          ? frozenCandidateDb.prepare(`SELECT id, username, display_name AS displayName FROM sys_users
            WHERE id = ? AND username = ?`).get(requestActorSnapshot.userId, requestActorSnapshot.username)
          : null;
        frozenCandidateDb.prepare(`INSERT INTO sys_operation_logs
          (user_id, operation, target_type, target_id, detail_json, ip, created_at)
          VALUES (?, 'system.backup.restore', 'backup', ?, ?, ?, ?)`)
          .run(resolvedActor ? resolvedActor.id : null, source.backupName, JSON.stringify({
            requestActorSnapshot,
            actorResolvedInRestoredDatabase: Boolean(resolvedActor),
            resolvedActor: resolvedActor ? {
              userId: resolvedActor.id,
              username: resolvedActor.username,
              displayName: resolvedActor.displayName
            } : null,
            backupName: source.backupName,
            safetyReset: demoRuntimeSafetyReset
          }), requestActorSnapshot.ip, new Date().toISOString());
        if (frozenCandidateDb.pragma('quick_check', { simple: true }) !== 'ok'
          || frozenCandidateDb.pragma('integrity_check', { simple: true }) !== 'ok'
          || frozenCandidateDb.pragma('foreign_key_check').length > 0) {
          throw new Error('候选数据库完整性检查失败。');
        }
        const candidateCheckpointRows = typeof options.checkpointCandidate === 'function'
          ? options.checkpointCandidate(frozenCandidateDb)
          : frozenCandidateDb.pragma('wal_checkpoint(TRUNCATE)');
        assertCheckpointComplete(
          candidateCheckpointRows,
          'RESTORE_CANDIDATE_CHECKPOINT_INCOMPLETE'
        );
      } finally {
        frozenCandidateDb.close();
      }
      removeSqliteSidecars(candidatePath);

      if (typeof options.checkpointOfficial === 'function') {
        assertCheckpointComplete(
          options.checkpointOfficial(),
          'DATABASE_CHECKPOINT_INCOMPLETE'
        );
      } else {
        checkpointDatabase({ admissionPermit });
      }
      if (getDatabaseAdmissionState().activeConnections !== 0) {
        throw badRequest('正式数据库 checkpoint 后连接状态异常，拒绝切换。', {
          code: 'DATABASE_DRAIN_STATE_CHANGED'
        });
      }
      removeSqliteSidecars(databasePath);
      writeDurableRestoreMarker(markerPath, {
        schema: DATABASE_RESTORE_MARKER_SCHEMA,
        version: DATABASE_RESTORE_MARKER_VERSION,
        phase: DATABASE_RESTORE_MARKER_PHASE,
        operationId,
        candidate: path.basename(candidatePath),
        old: path.basename(oldStagingPath)
      });
      fileOperations.renameSync(databasePath, oldStagingPath);
      officialMoved = true;
      fileOperations.renameSync(candidatePath, databasePath);
      candidateMoved = true;
      const cleanupWarnings = [];
      try {
        fileOperations.rmSync(oldStagingPath, { force: true });
        fileOperations.rmSync(markerPath, { force: true });
      } catch (_cleanupError) {
        cleanupWarnings.push('RESTORE_SWITCH_CLEANUP_PENDING');
      }
      unblockDatabaseAdmission(admissionPermit);

      return {
        restoredFrom: { backupName: source.backupName, sizeBytes: source.sizeBytes, sha256: source.sha256, validation },
        preRestoreBackup: { backupName: preRestoreBackup.backupName, sizeBytes: preRestoreBackup.sizeBytes, sha256: preRestoreBackup.sha256 },
        demoRuntimeSafetyReset,
        cleanupWarnings,
        databasePath,
        backupsDir,
        note: cleanupWarnings.length > 0
          ? '数据库已成功恢复；切换残留将在下次初始化时幂等清理。'
          : '恢复候选库已完成迁移、演示安全重置、审计和完整性校验，并通过同卷原子替换切换。'
      };
    } catch (error) {
      const errorBackupName = source ? source.backupName : safeBackupName;
      // 输入白名单错误也必须先走 barrier 释放和候选清理，再保持原 code/status/details 对外返回。
      const passthroughInputError = error instanceof AppError && sourceResolutionAttempted && (
        (!source && ['BAD_REQUEST', 'NOT_FOUND'].includes(error.code))
        || (!sourceValidated && error.code === 'INVALID_BACKUP_FILE')
      );
      if (candidateMoved) {
        poisonDatabaseAdmission();
        throw new AppError('BACKUP_RESTORE_SWITCH_INDETERMINATE', '数据库已完成文件切换但收尾状态无法确认，服务已安全锁定。', {
          statusCode: 500,
          details: {
            backupName: errorBackupName,
            phase: 'post_switch_verification',
            rollbackStatus: 'not_applicable',
            retryable: false,
            code: 'DATABASE_POISONED'
          }
        });
      }
      let rollbackStatus = officialMoved ? 'not_attempted' : 'official_unchanged';
      if (officialMoved && !candidateMoved) {
        try {
          fileOperations.renameSync(oldStagingPath, databasePath);
          rollbackStatus = 'restored';
          try {
            fileOperations.rmSync(markerPath, { force: true });
          } catch (_markerCleanupError) {
            // 回滚已成功时 marker 清理失败不得覆盖主错误。
          }
          unblockDatabaseAdmission(admissionPermit);
        } catch (_rollbackError) {
          rollbackStatus = 'failed_poisoned';
          poisonDatabaseAdmission();
        }
      } else if (!officialMoved) {
        unblockDatabaseAdmission(admissionPermit);
      }
      for (const cleanupPath of [candidatePath, `${candidatePath}-wal`, `${candidatePath}-shm`]) {
        try {
          fileOperations.rmSync(cleanupPath, { force: true });
        } catch (_cleanupError) {
          // 候选清理是次生操作，不得覆盖恢复主错误。
        }
      }
      if (passthroughInputError) {
        throw error;
      }
      throw new AppError('BACKUP_RESTORE_FAILED', '备份恢复失败，正式数据库未切换或已安全回滚。', {
        statusCode: 500,
        details: {
          backupName: errorBackupName,
          phase: officialMoved ? 'atomic_switch' : 'candidate_prepare',
          rollbackStatus,
          retryable: rollbackStatus !== 'failed_poisoned',
          code: rollbackStatus === 'failed_poisoned' ? 'DATABASE_POISONED' : 'RESTORE_CANDIDATE_REJECTED'
        }
      });
    }
  }, { backupName: String(backupName || '') });
}

module.exports = {
  assertSafeBackupName,
  createBackup,
  deleteBackup,
  getBackupForDownload,
  listBackups,
  restoreBackup,
  validateBackupFile,
  _test: {
    assertCheckpointComplete,
    checkpointDatabase,
    waitForOfficialDatabaseDrain
  }
};
