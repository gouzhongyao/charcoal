const path = require('path');
const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { requireWritable } = require('../middleware/maintenance');
const backupService = require('../services/backupService');
const { deleteBackup, getBackupForDownload, listBackups, restoreBackup } = backupService;
const { AppError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName) {
  const fallback = String(fileName || 'backup.sqlite').replace(/[^A-Za-z0-9._-]+/g, '-') || 'backup.sqlite';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// 备份接口只暴露文件名和完整性元数据，避免返回本地目录或数据库路径。
function toPublicBackupMetadata(backup = {}) {
  return {
    backupName: backup.backupName,
    sizeBytes: backup.sizeBytes,
    createdAt: backup.createdAt,
    updatedAt: backup.updatedAt,
    sha256: backup.sha256,
    reason: backup.reason,
    method: backup.method
  };
}

// 恢复结果沿用必要的校验与追溯信息，但不泄露本地文件系统位置。
function toPublicRestoreResult(result = {}) {
  return {
    restoredFrom: toPublicBackupMetadata(result.restoredFrom),
    preRestoreBackup: toPublicBackupMetadata(result.preRestoreBackup),
    demoRuntimeSafetyReset: result.demoRuntimeSafetyReset,
    cleanupWarnings: Array.isArray(result.cleanupWarnings)
      ? result.cleanupWarnings.filter((warning) => warning === 'RESTORE_SWITCH_CLEANUP_PENDING')
      : [],
    note: result.note
  };
}

/**
 * 构造系统手工备份失败的稳定公开错误，避免底层文件和 SQLite 异常进入响应。
 * @returns {AppError} 不含原生异常消息和本机路径的应用错误。
 */
function createSystemBackupFailedError() {
  return new AppError(
    'SYSTEM_BACKUP_CREATE_FAILED',
    '系统备份创建失败，请稍后重试。',
    {
      statusCode: 500,
      details: null
    }
  );
}

router.get('/', authenticate, requirePermission('system:backup:view'), asyncHandler(async (req, res) => {
  const result = listBackups();
  sendSuccess(res, result.rows.map(toPublicBackupMetadata), {
    meta: {
      total: result.total,
      namePolicy: 'backupName 仅允许当前备份目录下的 .sqlite/.db 文件名，下载和恢复都会做白名单校验。'
    }
  });
}));

router.post('/', authenticate, requirePermission('system:backup:create'), requireWritable('backups:create'), asyncHandler(async (req, res) => {
  // 手工备份结果仅在创建成功后投影为公开元数据。
  let backup;
  try {
    backup = await backupService.createBackup({ reason: 'manual' });
  } catch {
    throw createSystemBackupFailedError();
  }
  sendSuccess(res, toPublicBackupMetadata(backup), { statusCode: 201 });
}));

router.get('/:backupName/download', authenticate, requirePermission('system:backup:download'), asyncHandler(async (req, res) => {
  const backup = getBackupForDownload(req.params.backupName);
  res.setHeader('Content-Type', backup.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(backup.backupName));
  res.setHeader('Content-Length', String(backup.sizeBytes));
  res.setHeader('X-Backup-Name', backup.backupName);
  res.sendFile(path.resolve(backup.streamPath));
}));

router.post('/:backupName/restore', authenticate, requirePermission('system:backup:restore'), requireWritable('backups:restore'), asyncHandler(async (req, res) => {
  const result = await restoreBackup(req.params.backupName, {
    userId: req.user.id,
    username: req.user.username,
    displayName: req.user.displayName,
    ip: req.ip
  });
  sendSuccess(res, toPublicRestoreResult(result));
}));

router.delete('/:backupName', authenticate, requirePermission('system:backup:delete'), requireWritable('backups:delete'), asyncHandler(async (req, res) => {
  const result = deleteBackup(req.params.backupName);
  sendSuccess(res, {
    deleted: result.deleted,
    deletedBackupName: result.deletedBackupName,
    deletedBytes: result.deletedBytes,
    note: result.note
  });
}));

module.exports = router;
module.exports.toPublicRestoreResult = toPublicRestoreResult;
