const path = require('path');
const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { createBackup, deleteBackup, getBackupForDownload, listBackups, restoreBackup } = require('../services/backupService');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

function buildContentDisposition(fileName) {
  const fallback = String(fileName || 'backup.sqlite').replace(/[^A-Za-z0-9._-]+/g, '-') || 'backup.sqlite';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/', asyncHandler(async (req, res) => {
  const result = listBackups();
  sendSuccess(res, result.rows, {
    meta: {
      backupsDir: result.backupsDir,
      databasePath: result.databasePath,
      total: result.total,
      namePolicy: 'backupName 仅允许当前备份目录下的 .sqlite/.db 文件名，下载和恢复都会做白名单校验。'
    }
  });
}));

router.post('/', requireWritable('backups:create'), asyncHandler(async (req, res) => {
  const backup = await createBackup({ reason: 'manual' });
  sendSuccess(res, backup, { statusCode: 201 });
}));

router.get('/:backupName/download', asyncHandler(async (req, res) => {
  const backup = getBackupForDownload(req.params.backupName);
  res.setHeader('Content-Type', backup.contentType);
  res.setHeader('Content-Disposition', buildContentDisposition(backup.backupName));
  res.setHeader('Content-Length', String(backup.sizeBytes));
  res.setHeader('X-Backup-Name', backup.backupName);
  res.sendFile(path.resolve(backup.streamPath));
}));

router.post('/:backupName/restore', requireWritable('backups:restore'), asyncHandler(async (req, res) => {
  const result = await restoreBackup(req.params.backupName);
  sendSuccess(res, result);
}));

router.delete('/:backupName', requireWritable('backups:delete'), asyncHandler(async (req, res) => {
  const result = deleteBackup(req.params.backupName);
  sendSuccess(res, result);
}));

module.exports = router;
