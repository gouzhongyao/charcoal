const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { backupsDir, databasePath, ensureLocalDataDirectories, initDatabase, openDatabase } = require('../db/database');
const { assertWritableAllowed, runWithMaintenance } = require('./maintenanceState');
const { badRequest, invalidBackup, notFound } = require('../utils/errors');

const BACKUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(sqlite|db)$/i;
const BACKUP_REASONS = new Set(['manual', 'pre-restore']);
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
    throw badRequest('备份文件路径必须位于当前备份目录下。', { backupsDir: base, target });
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

function buildBackupMetadata(filePath) {
  const stat = fs.statSync(filePath);
  return {
    backupName: path.basename(filePath),
    path: filePath,
    sizeBytes: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    sha256: sha256File(filePath)
  };
}

function listBackups() {
  ensureBackupDir();
  const rows = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME_PATTERN.test(entry.name))
    .map((entry) => buildBackupMetadata(path.join(backupsDir, entry.name)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.backupName).localeCompare(String(a.backupName)));

  return {
    backupsDir,
    databasePath,
    rows,
    total: rows.length
  };
}

function assertExistingBackup(backupName) {
  const safeName = assertSafeBackupName(backupName);
  const listed = listBackups().rows.find((backup) => backup.backupName === safeName);
  if (!listed) {
    throw notFound('备份文件不存在或不在当前备份目录白名单内。', { backupName: safeName, backupsDir });
  }
  const backupPath = getBackupPathFromName(safeName);
  assertInsideBackupsDir(backupPath);
  if (normalizeForCompare(backupPath) !== normalizeForCompare(listed.path)) {
    throw badRequest('备份文件路径校验失败。', { backupName: safeName, backupPath, listedPath: listed.path });
  }
  return listed;
}

function buildBackupName(reason = 'manual') {
  const safeReason = BACKUP_REASONS.has(reason) ? reason : 'manual';
  return `energy-carbon-${safeReason}-${getNowForFilename()}-${process.pid}.sqlite`;
}

function checkpointDatabase() {
  if (!fs.existsSync(databasePath)) {
    return;
  }
  const db = openDatabase();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
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
      reason: error && error.message ? error.message : String(error)
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function copyDatabaseToBackup(destinationPath) {
  const db = openDatabase();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    if (typeof db.backup === 'function') {
      await db.backup(destinationPath);
      return 'better-sqlite3-backup-api';
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

  const method = await copyDatabaseToBackup(backupPath);
  const metadata = buildBackupMetadata(backupPath);
  return {
    ...metadata,
    reason,
    method,
    databasePath,
    backupsDir
  };
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
      databasePath
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

async function restoreBackup(backupName) {
  return runWithMaintenance('backups:restore', async () => {
    const source = assertExistingBackup(backupName);
    const validation = validateBackupFile(source.path);
    const preRestoreBackup = await createBackup({ reason: 'pre-restore' });

    checkpointDatabase();
    removeSqliteSidecars(databasePath);
    fs.copyFileSync(source.path, databasePath);
    removeSqliteSidecars(databasePath);
    initDatabase();

    return {
      restoredFrom: {
        backupName: source.backupName,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        validation
      },
      preRestoreBackup: {
        backupName: preRestoreBackup.backupName,
        sizeBytes: preRestoreBackup.sizeBytes,
        sha256: preRestoreBackup.sha256
      },
      databasePath,
      backupsDir,
      note: '恢复前已完成 SQLite quick_check 与关键 schema 校验，并自动创建 pre-restore 备份；恢复后建议刷新页面并重新检查当前数据。'
    };
  }, { backupName: String(backupName || '') });
}

module.exports = {
  assertSafeBackupName,
  createBackup,
  deleteBackup,
  getBackupForDownload,
  listBackups,
  restoreBackup,
  validateBackupFile
};
