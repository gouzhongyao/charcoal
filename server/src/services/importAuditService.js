const fs = require('fs');
const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { decodeUploadOriginalName } = require('../utils/filenameEncoding');

const AUDIT_IMPORT_TYPES = Object.freeze(['production_output', 'generation_record']);
const GENERIC_DELETE_FORBIDDEN_IMPORT_TYPES = Object.freeze([...AUDIT_IMPORT_TYPES, 'meter_reading']);
const IMPORT_BATCH_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled']);
const IMPORT_AUDIT_PHASES = Object.freeze(['preview', 'execute']);
const IMPORT_FILE_TYPES = Object.freeze(['xlsx', 'xls', 'csv']);
const IMPORT_ISSUE_SEVERITIES = Object.freeze(['error', 'warning']);
const DEFAULT_DUPLICATE_STRATEGY = 'skip';
const BACKUP_AUDIT_PUBLIC_FIELDS = Object.freeze(['backupName', 'reason', 'method', 'sizeBytes', 'createdAt', 'updatedAt', 'sha256']);
const BACKUP_AUDIT_FIELD_ALIASES = Object.freeze({
  sizeBytes: ['sizeBytes', 'fileSizeBytes'],
  sha256: ['sha256', 'fileSha256']
});

function getNow() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isSensitiveAuditKey(key) {
  const normalized = String(key || '').replace(/[\s_-]+/g, '').toLowerCase();
  return /(?:token|password|secret|apikey|privatekey|credential|authorization)/.test(normalized);
}

function sanitizeAuditJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditJsonValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = isSensitiveAuditKey(key) ? '[redacted]' : sanitizeAuditJsonValue(value[key]);
      return acc;
    }, {});
  }
  return value === undefined ? null : value;
}

function serializeAuditJson(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return stableStringify(sanitizeAuditJsonValue(value));
}

function parseStoredAuditJson(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function getFirstDefinedValue(source, fieldName) {
  const candidateFields = BACKUP_AUDIT_FIELD_ALIASES[fieldName] || [fieldName];
  const matchedField = candidateFields.find((candidateField) => Object.prototype.hasOwnProperty.call(source, candidateField) && source[candidateField] !== undefined);
  return matchedField ? source[matchedField] : undefined;
}

function projectBackupAuditMetadata(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    const parsed = parseStoredAuditJson(value);
    return parsed === value ? value : projectBackupAuditMetadata(parsed);
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectBackupAuditMetadata(item));
  }
  if (typeof value !== 'object') {
    return value;
  }
  return BACKUP_AUDIT_PUBLIC_FIELDS.reduce((acc, fieldName) => {
    const fieldValue = getFirstDefinedValue(value, fieldName);
    if (fieldValue !== undefined) {
      acc[fieldName] = fieldValue;
    }
    return acc;
  }, {});
}

function serializeBackupAuditJson(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return serializeAuditJson(projectBackupAuditMetadata(value));
}

function parseStoredBackupAuditJson(value) {
  return projectBackupAuditMetadata(parseStoredAuditJson(value));
}

function parsePositiveInteger(value, fieldName) {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: value });
  }
  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是安全范围内的正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: value });
  }
  return numberValue;
}

function normalizeAuditImportType(importType) {
  const normalized = String(importType || '').trim();
  if (!AUDIT_IMPORT_TYPES.includes(normalized)) {
    throw badRequest('importType 不在导入审计服务支持范围内。', {
      code: 'UNSUPPORTED_IMPORT_AUDIT_TYPE',
      importType,
      supportedImportTypes: AUDIT_IMPORT_TYPES
    });
  }
  return normalized;
}

function normalizeImportFileType(fileType, originalFilename) {
  const normalized = String(fileType || '').trim().toLowerCase() || String(originalFilename || '').split('.').pop().toLowerCase();
  if (!IMPORT_FILE_TYPES.includes(normalized)) {
    throw badRequest('导入审计批次文件类型不支持。', {
      code: 'UNSUPPORTED_IMPORT_AUDIT_FILE_TYPE',
      fileType,
      originalFilename,
      supportedFileTypes: IMPORT_FILE_TYPES
    });
  }
  return normalized;
}

function normalizeImportBatchStatus(status, fallback = 'pending') {
  const normalized = String(status || fallback).trim();
  if (!IMPORT_BATCH_STATUSES.includes(normalized)) {
    throw badRequest('导入审计批次状态不支持。', { code: 'UNSUPPORTED_IMPORT_BATCH_STATUS', status, supportedStatuses: IMPORT_BATCH_STATUSES });
  }
  return normalized;
}

function normalizeAuditPhase(auditPhase, fallback = 'preview') {
  const normalized = String(auditPhase || fallback).trim();
  if (!IMPORT_AUDIT_PHASES.includes(normalized)) {
    throw badRequest('导入审计阶段不支持。', { code: 'UNSUPPORTED_IMPORT_AUDIT_PHASE', auditPhase, supportedAuditPhases: IMPORT_AUDIT_PHASES });
  }
  return normalized;
}

function normalizeDuplicateStrategy(duplicateStrategy) {
  const normalized = String(duplicateStrategy || DEFAULT_DUPLICATE_STRATEGY).trim();
  if (normalized !== DEFAULT_DUPLICATE_STRATEGY) {
    throw badRequest('当前导入审计服务仅支持默认 skip 重复策略。', {
      code: 'UNSUPPORTED_DUPLICATE_STRATEGY',
      duplicateStrategy,
      enabledDuplicateStrategies: [DEFAULT_DUPLICATE_STRATEGY]
    });
  }
  return normalized;
}

function normalizeNonNegativeInteger(value, fieldName, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0 || !Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是非负整数。`, { code: 'INVALID_NON_NEGATIVE_INTEGER', fieldName, rawValue: value });
  }
  return numberValue;
}

function normalizeStatistics(input = {}) {
  const summary = input.summary || input.previewSummary || input.statistics || input;
  const totalRows = normalizeNonNegativeInteger(summary.totalRows ?? summary.total, 'totalRows', 0);
  const successCount = normalizeNonNegativeInteger(summary.successCount ?? summary.imported ?? summary.wouldImport, 'successCount', 0);
  const failureCount = normalizeNonNegativeInteger(summary.failureCount ?? summary.blocked, 'failureCount', 0);
  const skippedCount = normalizeNonNegativeInteger(summary.skippedCount ?? summary.skipped, 'skippedCount', 0);
  if (successCount + failureCount + skippedCount > totalRows) {
    throw badRequest('导入审计批次统计不一致：success/failure/skipped 之和不能大于 totalRows。', {
      code: 'IMPORT_AUDIT_STATISTICS_INCONSISTENT',
      totalRows,
      successCount,
      failureCount,
      skippedCount
    });
  }
  return { totalRows, successCount, failureCount, skippedCount };
}

function inferCompletedStatus(statistics) {
  return statistics.failureCount > 0 || statistics.skippedCount > 0 ? 'completed_with_errors' : 'completed';
}

function normalizeFileMetadata(input = {}) {
  const file = input.file || {};
  const originalFilename = decodeUploadOriginalName(input.originalFilename || input.originalname || file.originalFilename || file.originalname || file.name || '');
  if (!originalFilename) {
    throw badRequest('导入审计批次缺少原始文件名。', { code: 'IMPORT_AUDIT_ORIGINAL_FILENAME_REQUIRED' });
  }
  const storedFilename = input.storedFilename || input.filename || file.storedFilename || file.filename || null;
  const filePath = input.filePath || input.path || file.path || null;
  const fileType = normalizeImportFileType(input.fileType || input.mimetypeFileType || file.fileType, originalFilename);
  const fileSizeBytes = normalizeNonNegativeInteger(input.fileSizeBytes ?? input.size ?? file.fileSizeBytes ?? file.size, 'fileSizeBytes', null);
  const fileSha256 = input.fileSha256 || file.fileSha256 || (filePath && fs.existsSync(filePath) ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : null);
  return { originalFilename, storedFilename, fileType, fileSizeBytes, fileSha256 };
}

function mapImportAuditIssue(issue = {}) {
  const rowNumber = normalizeNonNegativeInteger(issue.rowNumber ?? issue.row_number, 'rowNumber', null);
  if (!rowNumber || rowNumber < 1) {
    throw badRequest('导入审计明细 rowNumber 必须是正整数。', { code: 'INVALID_IMPORT_AUDIT_ISSUE_ROW_NUMBER', rowNumber: issue.rowNumber ?? issue.row_number });
  }
  const errorCode = String(issue.code || issue.errorCode || issue.error_code || '').trim();
  if (!errorCode) {
    throw badRequest('导入审计明细缺少 code。', { code: 'IMPORT_AUDIT_ISSUE_CODE_REQUIRED', issue });
  }
  const errorReason = String(issue.message || issue.errorReason || issue.error_reason || '').trim();
  if (!errorReason) {
    throw badRequest('导入审计明细缺少 message。', { code: 'IMPORT_AUDIT_ISSUE_MESSAGE_REQUIRED', issue });
  }
  const severity = String(issue.severity || 'error').trim().toLowerCase();
  if (!IMPORT_ISSUE_SEVERITIES.includes(severity)) {
    throw badRequest('导入审计明细 severity 仅支持 error/warning。', { code: 'UNSUPPORTED_IMPORT_AUDIT_ISSUE_SEVERITY', severity, supportedSeverities: IMPORT_ISSUE_SEVERITIES });
  }
  const rawValue = issue.rawValue ?? issue.raw_value;
  return {
    rowNumber,
    fieldName: issue.fieldName ?? issue.field_name ?? null,
    rawValue: rawValue && typeof rawValue === 'object' ? serializeAuditJson(rawValue) : (rawValue === undefined || rawValue === null ? null : String(rawValue)),
    errorCode,
    errorReason,
    severity
  };
}

function withAuditDatabase(options, callback) {
  const db = options?.db || openDatabase();
  try {
    return callback(db);
  } finally {
    if (!options?.db) {
      db.close();
    }
  }
}

function ensureImportAuditBatchExists(db, batchId) {
  const row = db.prepare('SELECT id, import_type AS importType FROM import_batches WHERE id = ?').get(batchId);
  if (!row) {
    throw notFound('导入审计批次不存在。', { batchId });
  }
  return row;
}

function ensurePreviewAuditBatchCanUpdate(db, batchId, importType) {
  const batch = ensureImportAuditBatchExists(db, batchId);
  const existingImportType = String(batch.importType || '').trim();
  if (!AUDIT_IMPORT_TYPES.includes(existingImportType)) {
    throw badRequest('导入审计 preview 批次类型不支持更新。', {
      code: 'IMPORT_AUDIT_PREVIEW_BATCH_TYPE_MISMATCH',
      batchId,
      importType,
      existingImportType,
      supportedImportTypes: AUDIT_IMPORT_TYPES
    });
  }
  if (existingImportType !== importType) {
    throw badRequest('导入审计 preview 批次类型与本次导入类型不一致。', {
      code: 'IMPORT_AUDIT_PREVIEW_BATCH_TYPE_MISMATCH',
      batchId,
      importType,
      existingImportType
    });
  }
  return batch;
}

function recordPreviewAuditBatch(input = {}, options = {}) {
  return withAuditDatabase(options, (db) => {
    const importType = normalizeAuditImportType(input.importType || input.import_type);
    const duplicateStrategy = normalizeDuplicateStrategy(input.duplicateStrategy || input.duplicate_strategy);
    const auditPhase = normalizeAuditPhase(input.auditPhase || input.audit_phase, 'preview');
    const statistics = normalizeStatistics(input.statistics || input.summary || input.previewSummary || {});
    const status = normalizeImportBatchStatus(input.status, inferCompletedStatus(statistics));
    const fileMetadata = normalizeFileMetadata({ ...(input.fileMetadata || {}), ...input });
    const now = getNow();
    const fieldMappingJson = serializeAuditJson(input.fieldMapping ?? input.field_mapping ?? input.fieldMappingJson);
    const auditContextJson = serializeAuditJson(input.auditContext ?? input.audit_context ?? input.auditContextJson);
    const startedAt = input.startedAt || input.started_at || now;
    const finishedAt = input.finishedAt || input.finished_at || (status === 'pending' || status === 'processing' ? null : now);

    if (input.batchId || input.id) {
      const batchId = parsePositiveInteger(input.batchId || input.id, 'batchId');
      ensurePreviewAuditBatchCanUpdate(db, batchId, importType);
      db.prepare(
        `UPDATE import_batches
         SET import_type = ?,
             original_filename = ?,
             stored_filename = ?,
             file_type = ?,
             file_size_bytes = ?,
             file_sha256 = ?,
             status = ?,
             audit_phase = ?,
             preview_signature = ?,
             preview_audit_digest = ?,
             audit_context_json = ?,
             total_rows = ?,
             success_count = ?,
             failure_count = ?,
             skipped_count = ?,
             duplicate_strategy = ?,
             field_mapping_json = ?,
             started_at = COALESCE(started_at, ?),
             finished_at = ?,
             updated_at = ?,
             error_summary = ?
         WHERE id = ?`
      ).run(
        importType,
        fileMetadata.originalFilename,
        fileMetadata.storedFilename,
        fileMetadata.fileType,
        fileMetadata.fileSizeBytes,
        fileMetadata.fileSha256,
        status,
        auditPhase,
        input.previewSignature || input.preview_signature || null,
        input.previewAuditDigest || input.preview_audit_digest || null,
        auditContextJson,
        statistics.totalRows,
        statistics.successCount,
        statistics.failureCount,
        statistics.skippedCount,
        duplicateStrategy,
        fieldMappingJson,
        startedAt,
        finishedAt,
        now,
        input.errorSummary || input.error_summary || null,
        batchId
      );
      return getImportAuditBatchDetail(batchId, { db });
    }

    const result = db.prepare(
      `INSERT INTO import_batches (
         import_type,
         original_filename,
         stored_filename,
         file_type,
         file_size_bytes,
         file_sha256,
         status,
         audit_phase,
         preview_signature,
         preview_audit_digest,
         audit_context_json,
         total_rows,
         success_count,
         failure_count,
         skipped_count,
         duplicate_strategy,
         field_mapping_json,
         started_at,
         finished_at,
         created_at,
         updated_at,
         error_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      importType,
      fileMetadata.originalFilename,
      fileMetadata.storedFilename,
      fileMetadata.fileType,
      fileMetadata.fileSizeBytes,
      fileMetadata.fileSha256,
      status,
      auditPhase,
      input.previewSignature || input.preview_signature || null,
      input.previewAuditDigest || input.preview_audit_digest || null,
      auditContextJson,
      statistics.totalRows,
      statistics.successCount,
      statistics.failureCount,
      statistics.skippedCount,
      duplicateStrategy,
      fieldMappingJson,
      startedAt,
      finishedAt,
      now,
      now,
      input.errorSummary || input.error_summary || null
    );
    return getImportAuditBatchDetail(result.lastInsertRowid, { db });
  });
}

function replaceImportAuditIssues(batchId, issues = [], options = {}) {
  const numericBatchId = parsePositiveInteger(batchId, 'batchId');
  if (!Array.isArray(issues)) {
    throw badRequest('导入审计明细必须是数组。', { code: 'IMPORT_AUDIT_ISSUES_MUST_BE_ARRAY' });
  }
  return withAuditDatabase(options, (db) => {
    ensureImportAuditBatchExists(db, numericBatchId);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(numericBatchId);
      const insertIssue = db.prepare(
        `INSERT INTO import_errors (
           batch_id,
           row_number,
           field_name,
           raw_value,
           error_code,
           error_reason,
           severity
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      issues.map(mapImportAuditIssue).forEach((issue) => {
        insertIssue.run(numericBatchId, issue.rowNumber, issue.fieldName, issue.rawValue, issue.errorCode, issue.errorReason, issue.severity);
      });
      db.prepare("UPDATE import_batches SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(numericBatchId);
      return getImportAuditBatchDetail(numericBatchId, { db });
    });
    return transaction();
  });
}

function updateExecuteAuditResult(batchId, input = {}, options = {}) {
  const numericBatchId = parsePositiveInteger(batchId, 'batchId');
  return withAuditDatabase(options, (db) => {
    const batch = ensureImportAuditBatchExists(db, numericBatchId);
    normalizeAuditImportType(batch.importType);
    const statistics = normalizeStatistics(input.statistics || input.summary || input.executeSummary || input);
    const status = normalizeImportBatchStatus(input.status, inferCompletedStatus(statistics));
    const completedAt = input.completedAt || input.finishedAt || input.completed_at || getNow();
    const now = getNow();
    db.prepare(
      `UPDATE import_batches
       SET status = ?,
           audit_phase = 'execute',
           execute_result_json = ?,
           backup_json = ?,
           total_rows = ?,
           success_count = ?,
           failure_count = ?,
           skipped_count = ?,
           started_at = COALESCE(started_at, ?),
           finished_at = ?,
           updated_at = ?,
           error_summary = COALESCE(?, error_summary)
       WHERE id = ?`
    ).run(
      status,
      serializeAuditJson(input.executeResult ?? input.execute_result ?? input.executeResultJson),
      serializeBackupAuditJson(input.backup ?? input.backupJson ?? input.backup_json),
      statistics.totalRows,
      statistics.successCount,
      statistics.failureCount,
      statistics.skippedCount,
      input.startedAt || input.started_at || now,
      completedAt,
      now,
      input.errorSummary || input.error_summary || null,
      numericBatchId
    );
    return getImportAuditBatchDetail(numericBatchId, { db });
  });
}

function getIssueCounts(db, batchId) {
  const counts = { total: 0, error: 0, warning: 0 };
  db.prepare('SELECT severity, COUNT(*) AS total FROM import_errors WHERE batch_id = ? GROUP BY severity').all(batchId).forEach((row) => {
    counts[row.severity] = row.total;
    counts.total += row.total;
  });
  return counts;
}

function listIssuesForBatch(db, batchId) {
  return db.prepare(
    `SELECT
       id,
       batch_id AS batchId,
       row_number AS rowNumber,
       field_name AS fieldName,
       raw_value AS rawValue,
       error_code AS errorCode,
       error_reason AS errorReason,
       severity,
       created_at AS createdAt
     FROM import_errors
     WHERE batch_id = ?
     ORDER BY row_number ASC, id ASC`
  ).all(batchId);
}

function getImportAuditBatchDetail(batchId, options = {}) {
  const numericBatchId = parsePositiveInteger(batchId, 'batchId');
  return withAuditDatabase(options, (db) => {
    const row = db.prepare(
      `SELECT
         id,
         import_type AS importType,
         original_filename AS originalFilename,
         stored_filename AS storedFilename,
         file_type AS fileType,
         file_size_bytes AS fileSizeBytes,
         file_sha256 AS fileSha256,
         status,
         audit_phase AS auditPhase,
         preview_signature AS previewSignature,
         preview_audit_digest AS previewAuditDigest,
         audit_context_json AS auditContextJson,
         execute_result_json AS executeResultJson,
         backup_json AS backupJson,
         total_rows AS totalRows,
         success_count AS successCount,
         failure_count AS failureCount,
         skipped_count AS skippedCount,
         duplicate_strategy AS duplicateStrategy,
         field_mapping_json AS fieldMappingJson,
         started_at AS startedAt,
         finished_at AS finishedAt,
         created_at AS createdAt,
         updated_at AS updatedAt,
         error_summary AS errorSummary
       FROM import_batches
       WHERE id = ?`
    ).get(numericBatchId);
    if (!row) {
      throw notFound('导入审计批次不存在。', { batchId: numericBatchId });
    }
    const displayFilename = decodeUploadOriginalName(row.originalFilename);
    const includeIssues = options.includeIssues !== false;
    return {
      ...row,
      originalFilename: displayFilename,
      displayFilename,
      completedAt: row.finishedAt,
      fieldMapping: parseStoredAuditJson(row.fieldMappingJson),
      auditContext: parseStoredAuditJson(row.auditContextJson),
      executeResult: parseStoredAuditJson(row.executeResultJson),
      backup: parseStoredBackupAuditJson(row.backupJson),
      issueCounts: getIssueCounts(db, numericBatchId),
      issues: includeIssues ? listIssuesForBatch(db, numericBatchId) : undefined,
      fieldMappingJson: undefined,
      auditContextJson: undefined,
      executeResultJson: undefined,
      backupJson: undefined
    };
  });
}

function getImportAuditSummary(batchId, options = {}) {
  const detail = getImportAuditBatchDetail(batchId, { ...options, includeIssues: false });
  return {
    id: detail.id,
    importType: detail.importType,
    status: detail.status,
    auditPhase: detail.auditPhase,
    originalFilename: detail.originalFilename,
    fileSha256: detail.fileSha256,
    fileSizeBytes: detail.fileSizeBytes,
    previewSignature: detail.previewSignature,
    previewAuditDigest: detail.previewAuditDigest,
    counts: {
      totalRows: detail.totalRows,
      successCount: detail.successCount,
      failureCount: detail.failureCount,
      skippedCount: detail.skippedCount
    },
    issueCounts: detail.issueCounts,
    hasBackup: Boolean(detail.backup),
    completedAt: detail.completedAt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt
  };
}

function isGenericDeleteAllowedForImportType(importType) {
  const normalized = String(importType || 'energy_record').trim();
  return !GENERIC_DELETE_FORBIDDEN_IMPORT_TYPES.includes(normalized);
}

function assertAuditBatchCanUseGenericDelete(batch = {}) {
  const importType = batch.importType || batch.import_type || 'energy_record';
  if (!isGenericDeleteAllowedForImportType(importType)) {
    throw badRequest('该导入批次类型默认禁止通过通用导入批次删除接口删除；请先单独确认审计追溯、业务记录和原文件清理策略。', {
      code: 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN',
      batchId: batch.id,
      importType,
      forbiddenImportTypes: GENERIC_DELETE_FORBIDDEN_IMPORT_TYPES,
      allowedGenericDeleteImportTypes: ['energy_record']
    });
  }
  return true;
}

module.exports = {
  AUDIT_IMPORT_TYPES,
  GENERIC_DELETE_FORBIDDEN_IMPORT_TYPES,
  assertAuditBatchCanUseGenericDelete,
  createPreviewAuditBatch: recordPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  isGenericDeleteAllowedForImportType,
  mapImportAuditIssue,
  parseStoredAuditJson,
  recordPreviewAuditBatch,
  replaceImportAuditIssues,
  serializeAuditJson,
  updateExecuteAuditResult
};
