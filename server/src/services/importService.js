const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { openDatabase, uploadsDir } = require('../db/database');
const { assertWritableAllowed } = require('./maintenanceState');
const { badRequest, notFound } = require('../utils/errors');
const { decodeUploadOriginalName } = require('../utils/filenameEncoding');
const { assertAuditBatchCanUseGenericDelete, getImportAuditBatchDetail, parseStoredAuditJson } = require('./importAuditService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');
const { buildEnergyTypeIndex, detectEnergyImportTemplateMismatch, validateAndNormalizeRow } = require('./import/normalization');
const { findLedgerAssociationsForImportRecord, loadActiveLedgerIndexes } = require('./ledgerService');

const MAX_PAGE_SIZE = 500;
const ENERGY_RECORD_IMPORT_TYPE = 'energy_record';
const METER_READING_IMPORT_TYPE = 'meter_reading';
// 中央批次列表支持的导入类型与中文展示标签。
const IMPORT_TYPE_LABELS = Object.freeze({
  energy_record: '能耗数据导入',
  meter_reading: '计量抄表导入',
  organization_unit: '组织/用能单元导入',
  meter_device: '计量器具导入',
  production_unit: '产能单元导入',
  production_output: '月度产量导入',
  generation_record: '发电记录导入',
  energy_budget: '用能预算导入',
  carbon_factor: '碳排放因子导入',
  prediction_config: '预测配置导入',
  energy_timeseries: '能耗时序数据导入',
  shift_schedule: '排班计划导入',
  device_state: '设备状态导入',
  energy_conversion_factor: '能源折标系数导入',
  energy_benchmark: '能效对标导入',
  energy_flow_node: '能流节点导入',
  energy_flow_edge: '能流边导入',
  energy_flow_record: '显式边值导入'
});
const IMPORT_TYPE_VALUES = Object.freeze(Object.keys(IMPORT_TYPE_LABELS));

function getNow() {
  return new Date().toISOString();
}

function parseBatchId(batchId) {
  const rawBatchId = String(batchId ?? '');
  if (!/^[1-9]\d*$/.test(rawBatchId)) {
    throw badRequest('batchId 必须是正整数。', { batchId });
  }

  const numericBatchId = Number(rawBatchId);
  if (!Number.isSafeInteger(numericBatchId)) {
    throw badRequest('batchId 必须是安全范围内的正整数。', { batchId });
  }
  return numericBatchId;
}

function normalizeImportTypeFilter(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  if (!IMPORT_TYPE_VALUES.includes(normalized)) {
    throw badRequest('importType 不在支持范围内。', {
      code: 'UNSUPPORTED_IMPORT_TYPE_FILTER',
      importType: value,
      supportedImportTypes: IMPORT_TYPE_VALUES
    });
  }
  return normalized;
}

function getImportTypeLabel(importType) {
  return IMPORT_TYPE_LABELS[importType] || importType || IMPORT_TYPE_LABELS[ENERGY_RECORD_IMPORT_TYPE];
}

function normalizeImportBatchRow(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const importType = row.importType || ENERGY_RECORD_IMPORT_TYPE;
  const displayFilename = decodeUploadOriginalName(row.originalFilename);
  return {
    ...row,
    importType,
    importTypeLabel: getImportTypeLabel(importType),
    originalFilename: displayFilename,
    displayFilename
  };
}

function assertImportBatchCanUseGenericDelete(batch) {
  const importType = batch?.importType || ENERGY_RECORD_IMPORT_TYPE;
  if (importType === METER_READING_IMPORT_TYPE) {
    throw badRequest('抄表导入批次禁止通过通用导入批次删除接口删除；请走抄表批次作废/追溯策略，避免 meter_reading_records.source_batch_id 追溯链路丢失。', {
      code: 'METER_READING_IMPORT_BATCH_DELETE_FORBIDDEN',
      batchId: batch?.id,
      importType,
      allowedGenericDeleteImportTypes: [ENERGY_RECORD_IMPORT_TYPE]
    });
  }
  return assertAuditBatchCanUseGenericDelete(batch);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveStoredImportFilePath(storedFilename) {
  const filename = path.basename(String(storedFilename || ''));
  if (!filename || filename !== storedFilename) {
    throw badRequest('导入批次原始文件名无效。', { code: 'INVALID_STORED_IMPORT_FILENAME' });
  }

  const resolvedPath = path.resolve(uploadsDir, filename);
  const relativePath = path.relative(path.resolve(uploadsDir), resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw badRequest('导入批次原始文件路径无效。', { code: 'INVALID_STORED_IMPORT_PATH' });
  }
  return resolvedPath;
}

function parseJsonBody(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw badRequest('fieldMapping 必须是合法 JSON。', {
      code: 'INVALID_FIELD_MAPPING_JSON',
      rawValue: String(value)
    });
  }
}

function parsePagination(query, defaults = {}) {
  const page = Math.max(1, Number.parseInt(query.page || defaults.page || '1', 10) || 1);
  const requestedPageSize = Number.parseInt(query.pageSize || defaults.pageSize || '20', 10) || 20;
  const pageSize = Math.min(Math.max(1, requestedPageSize), defaults.maxPageSize || MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function getActiveEnergyTypes(db) {
  return db.prepare(
    `SELECT
       id,
       code,
       name,
       category,
       default_unit AS defaultUnit,
       standard_unit AS standardUnit
     FROM energy_types
     WHERE is_active = 1`
  ).all();
}

function insertBatch(db, file, fileType, fileSha256) {
  const result = db.prepare(
    `INSERT INTO import_batches (
       original_filename,
       stored_filename,
       file_type,
       file_size_bytes,
       file_sha256,
       status,
       duplicate_strategy,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 'skip', ?, ?)`
  ).run(
    decodeUploadOriginalName(file.originalname),
    file.filename,
    fileType,
    file.size,
    fileSha256,
    getNow(),
    getNow()
  );

  return result.lastInsertRowid;
}

function applyProvidedFieldMapping(row, providedMapping) {
  if (!providedMapping || typeof providedMapping !== 'object') {
    return row;
  }

  const mappedRow = { ...row };
  Object.entries(providedMapping).forEach(([field, sourceHeader]) => {
    if (typeof sourceHeader !== 'string' || sourceHeader.trim() === '') {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(row, sourceHeader)) {
      mappedRow[field] = row[sourceHeader];
    }
  });

  return mappedRow;
}

function persistImportResult(db, context) {
  const {
    batchId,
    rows,
    providedFieldMapping
  } = context;

  const energyTypes = getActiveEnergyTypes(db);
  const energyTypeIndex = buildEnergyTypeIndex(energyTypes);
  const ledgerIndexes = loadActiveLedgerIndexes(db);
  const insertError = db.prepare(
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
  const duplicateExists = db.prepare(
    `SELECT id FROM energy_records WHERE duplicate_key = ? AND record_status = 'active' LIMIT 1`
  );
  const insertRecord = db.prepare(
    `INSERT INTO energy_records (
       source_batch_id,
       source_row_number,
       energy_type_id,
       organization_unit_id,
       meter_device_id,
       original_month,
       normalized_month,
       original_unit,
       original_value,
       normalized_unit,
       normalized_value,
       organization,
       site,
       department,
       production_line,
       meter_code,
       business_dimension,
       remark,
       duplicate_key,
       record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  );
  const updateBatch = db.prepare(
    `UPDATE import_batches
     SET status = ?,
         total_rows = ?,
         success_count = ?,
         failure_count = ?,
         skipped_count = ?,
         field_mapping_json = ?,
         started_at = COALESCE(started_at, ?),
         finished_at = ?,
         updated_at = ?,
         error_summary = ?
     WHERE id = ?`
  );
  const markProcessing = db.prepare(
    `UPDATE import_batches
     SET status = 'processing', started_at = ?, updated_at = ?
     WHERE id = ?`
  );

  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let validationErrorCount = 0;
  const mergedFieldMapping = { ...(providedFieldMapping || {}) };

  markProcessing.run(getNow(), getNow(), batchId);

  if (rows.length === 0) {
    insertError.run(batchId, 1, null, null, 'EMPTY_IMPORT_FILE', '导入文件没有可解析的数据行。', 'error');
    updateBatch.run('failed', 0, 0, 0, 0, JSON.stringify(mergedFieldMapping), getNow(), getNow(), getNow(), '导入文件没有可解析的数据行。', batchId);
    return {
      batchId,
      status: 'failed',
      totalRows: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      validationErrorCount: 1
    };
  }

  const templateMismatch = detectEnergyImportTemplateMismatch(rows, providedFieldMapping);
  if (templateMismatch) {
    insertError.run(batchId, 1, null, null, templateMismatch.errorCode, templateMismatch.errorReason, 'error');
    updateBatch.run('failed', rows.length, 0, rows.length, 0, JSON.stringify(mergedFieldMapping), getNow(), getNow(), getNow(), templateMismatch.errorReason, batchId);
    return {
      batchId,
      status: 'failed',
      totalRows: rows.length,
      successCount: 0,
      failureCount: rows.length,
      skippedCount: 0,
      validationErrorCount: 1
    };
  }

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const mappedInput = applyProvidedFieldMapping(row, providedFieldMapping);
    const { errors, fieldMapping, record } = validateAndNormalizeRow(mappedInput, rowNumber, energyTypeIndex);
    Object.assign(mergedFieldMapping, fieldMapping);

    if (errors.length > 0) {
      failureCount += 1;
      validationErrorCount += errors.length;
      errors.forEach((error) => {
        insertError.run(batchId, error.rowNumber, error.fieldName, error.rawValue, error.errorCode, error.errorReason, error.severity);
      });
      return;
    }

    if (duplicateExists.get(record.duplicateKey)) {
      skippedCount += 1;
      insertError.run(
        batchId,
        rowNumber,
        'duplicate_key',
        record.duplicateKey,
        'DUPLICATE_SKIPPED',
        '默认 skip 策略已跳过与历史 active 能耗记录重复的数据。',
        'warning'
      );
      return;
    }

    try {
      const ledgerAssociations = findLedgerAssociationsForImportRecord(record, ledgerIndexes);
      insertRecord.run(
        batchId,
        record.sourceRowNumber,
        record.energyTypeId,
        ledgerAssociations.organizationUnitId,
        ledgerAssociations.meterDeviceId,
        record.originalMonth,
        record.normalizedMonth,
        record.originalUnit,
        record.originalValue,
        record.normalizedUnit,
        record.normalizedValue,
        record.organization,
        record.site,
        record.department,
        record.productionLine,
        record.meterCode,
        record.businessDimension,
        record.remark,
        record.duplicateKey
      );
      successCount += 1;
    } catch (error) {
      if (String(error.message || '').includes('ux_energy_records_active_duplicate_key')) {
        skippedCount += 1;
        insertError.run(
          batchId,
          rowNumber,
          'duplicate_key',
          record.duplicateKey,
          'DUPLICATE_SKIPPED',
          '默认 skip 策略已跳过与历史 active 能耗记录重复的数据。',
          'warning'
        );
        return;
      }
      throw error;
    }
  });

  const status = failureCount > 0 || skippedCount > 0 ? 'completed_with_errors' : 'completed';
  const summaryParts = [];
  if (failureCount > 0) {
    summaryParts.push(`存在 ${failureCount} 行校验失败，共 ${validationErrorCount} 条错误。`);
  }
  if (skippedCount > 0) {
    summaryParts.push(`默认 skip 策略跳过 ${skippedCount} 行重复数据。`);
  }
  const errorSummary = summaryParts.length > 0 ? summaryParts.join(' ') : null;

  updateBatch.run(
    status,
    rows.length,
    successCount,
    failureCount,
    skippedCount,
    JSON.stringify(mergedFieldMapping),
    getNow(),
    getNow(),
    getNow(),
    errorSummary,
    batchId
  );

  return {
    batchId,
    status,
    totalRows: rows.length,
    successCount,
    failureCount,
    skippedCount,
    validationErrorCount
  };
}

function getImportProcessingErrorCode(error, fallback = 'IMPORT_PROCESS_FAILED') {
  return error?.details?.code || error?.code || fallback;
}

function markBatchFailed(db, batchId, message, errorCode = 'IMPORT_PROCESS_FAILED') {
  const update = db.prepare(
    `UPDATE import_batches
     SET status = 'failed',
         finished_at = ?,
         updated_at = ?,
         error_summary = ?
     WHERE id = ?`
  );
  const insertError = db.prepare(
    `INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity)
     VALUES (?, 1, NULL, NULL, ?, ?, 'error')`
  );

  update.run(getNow(), getNow(), message, batchId);
  insertError.run(batchId, errorCode, message);
}

function createImportBatchFromUpload(file, options = {}) {
  assertWritableAllowed('imports:create-batch:service');

  if (!file) {
    throw badRequest('请使用 multipart/form-data 上传字段名为 file 的表格文件。', {
      code: 'IMPORT_FILE_REQUIRED',
      fieldName: 'file'
    });
  }

  const duplicateStrategy = options.duplicateStrategy || 'skip';
  if (duplicateStrategy !== 'skip') {
    throw badRequest('当前仅支持默认 skip 重复策略，overwrite/append 尚未启用。', {
      code: 'UNSUPPORTED_DUPLICATE_STRATEGY',
      enabledDuplicateStrategies: ['skip'],
      pendingDuplicateStrategies: ['overwrite', 'append']
    });
  }

  const fileType = assertSupportedImportFile(file.originalname);
  const providedFieldMapping = parseJsonBody(options.fieldMapping, {});
  const fileSha256 = sha256File(file.path);
  const db = openDatabase();
  let batchId = null;

  try {
    batchId = insertBatch(db, file, fileType, fileSha256);
    const parsed = parseImportFile(file.path, file.originalname);
    const transaction = db.transaction((context) => persistImportResult(db, context));
    const result = transaction({
      batchId,
      rows: parsed.rows,
      providedFieldMapping
    });

    return getImportBatchDetail(db, result.batchId, { summary: result });
  } catch (error) {
    if (batchId) {
      markBatchFailed(db, batchId, error.message || '导入处理失败。', getImportProcessingErrorCode(error));
      return getImportBatchDetail(db, batchId, {
        summary: {
          batchId,
          status: 'failed',
          totalRows: 0,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          validationErrorCount: 1
        }
      });
    }
    throw error;
  } finally {
    db.close();
  }
}

function getImportBatchDetail(db, batchId, extra = {}) {
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
  ).get(batchId);

  if (!row) {
    throw notFound('导入批次不存在。', { batchId });
  }

  return {
    ...normalizeImportBatchRow(row),
    fieldMapping: parseStoredAuditJson(row.fieldMappingJson),
    fieldMappingJson: undefined,
    ...extra
  };
}

function getImportIssueSummaryRows(db, batchId) {
  return db.prepare(
    `SELECT
       severity,
       error_code AS errorCode,
       COUNT(*) AS count,
       MIN(row_number) AS firstRowNumber,
       MIN(error_reason) AS sampleMessage
     FROM import_errors
     WHERE batch_id = ?
     GROUP BY severity, error_code
     ORDER BY severity ASC, firstRowNumber ASC, error_code ASC
     LIMIT 20`
  ).all(batchId);
}

function getImportBatchQueryDetail(batchId) {
  const numericBatchId = parseBatchId(batchId);
  const detail = getImportAuditBatchDetail(numericBatchId, { includeIssues: false });
  const db = openDatabase();
  try {
    return {
      ...normalizeImportBatchRow(detail),
      counts: {
        totalRows: detail.totalRows,
        successCount: detail.successCount,
        failureCount: detail.failureCount,
        skippedCount: detail.skippedCount
      },
      issueSummary: getImportIssueSummaryRows(db, numericBatchId),
      download: {
        available: Boolean(detail.storedFilename),
        url: `/api/imports/batches/${numericBatchId}/download`,
        originalFilename: detail.originalFilename,
        fileType: detail.fileType,
        fileSizeBytes: detail.fileSizeBytes,
        fileSha256: detail.fileSha256
      },
      errorsUrl: `/api/imports/batches/${numericBatchId}/errors`
    };
  } finally {
    db.close();
  }
}

function listImportBatches(query = {}) {
  const { page, pageSize, offset } = parsePagination(query, { pageSize: 20, maxPageSize: 100 });
  const where = [];
  const params = {};

  const importType = normalizeImportTypeFilter(query.importType || query.import_type);
  if (importType) {
    where.push('import_type = @importType');
    params.importType = importType;
  }
  if (query.status) {
    where.push('status = @status');
    params.status = query.status;
  }
  if (query.fileType) {
    where.push('file_type = @fileType');
    params.fileType = query.fileType;
  }
  if (query.createdAtStart) {
    where.push('created_at >= @createdAtStart');
    params.createdAtStart = query.createdAtStart;
  }
  if (query.createdAtEnd) {
    where.push('created_at <= @createdAtEnd');
    params.createdAtEnd = query.createdAtEnd;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM import_batches ${whereSql}`).get(params).total;
    const rows = db.prepare(
      `SELECT
         id,
         import_type AS importType,
         original_filename AS originalFilename,
         file_type AS fileType,
         file_size_bytes AS fileSizeBytes,
         file_sha256 AS fileSha256,
         status,
         audit_phase AS auditPhase,
         preview_audit_digest AS previewAuditDigest,
         total_rows AS totalRows,
         success_count AS successCount,
         failure_count AS failureCount,
         skipped_count AS skippedCount,
         duplicate_strategy AS duplicateStrategy,
         CASE WHEN backup_json IS NULL OR backup_json = '' THEN 0 ELSE 1 END AS hasBackup,
         started_at AS startedAt,
         finished_at AS finishedAt,
         created_at AS createdAt,
         updated_at AS updatedAt,
         error_summary AS errorSummary
       FROM import_batches
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset });

    return { rows: rows.map(normalizeImportBatchRow), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function deleteImportBatch(batchId) {
  assertWritableAllowed('imports:delete-batch:service');
  const numericBatchId = parseBatchId(batchId);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const batch = db.prepare('SELECT id, import_type AS importType, original_filename AS originalFilename FROM import_batches WHERE id = ?').get(numericBatchId);
      if (!batch) {
        throw notFound('导入批次不存在。', { batchId: numericBatchId });
      }
      assertImportBatchCanUseGenericDelete(batch);

      const deletedErrors = db.prepare('SELECT COUNT(*) AS total FROM import_errors WHERE batch_id = ?').get(numericBatchId).total;
      const deletedCarbonEmissions = db.prepare(
        `SELECT COUNT(*) AS total
         FROM carbon_emissions
         WHERE energy_record_id IN (
           SELECT id FROM energy_records WHERE source_batch_id = ?
         )`
      ).get(numericBatchId).total;
      db.prepare(
        `DELETE FROM carbon_emissions
         WHERE energy_record_id IN (
           SELECT id FROM energy_records WHERE source_batch_id = ?
         )`
      ).run(numericBatchId);

      const deletedEnergyRecords = db.prepare('DELETE FROM energy_records WHERE source_batch_id = ?').run(numericBatchId).changes;
      db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(numericBatchId);
      db.prepare('DELETE FROM import_batches WHERE id = ?').run(numericBatchId);

      return {
        batchId: numericBatchId,
        originalFilename: decodeUploadOriginalName(batch.originalFilename),
        deletedEnergyRecords,
        deletedErrors,
        deletedCarbonEmissions,
        deletedImportBatches: 1,
        deletedStoredFile: false,
        predictionImpact: '历史能耗记录已变化，既有预测运行和结果不会自动删除；如需反映最新数据，请重新创建预测运行。'
      };
    });

    return transaction();
  } finally {
    db.close();
  }
}

function normalizeIssueSeverityFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!['error', 'warning'].includes(normalized)) {
    throw badRequest('severity 仅支持 error 或 warning。', { code: 'UNSUPPORTED_IMPORT_ERROR_SEVERITY_FILTER', severity: value });
  }
  return normalized;
}

function normalizeIssueStatusFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['skipped', 'skip', 'warning'].includes(normalized)) {
    return 'warning';
  }
  if (['blocked', 'failed', 'error'].includes(normalized)) {
    return 'error';
  }
  throw badRequest('status 仅支持 skipped/blocked 或 error/warning 等价筛选。', { code: 'UNSUPPORTED_IMPORT_ERROR_STATUS_FILTER', status: value });
}

function listImportErrors(batchId, query = {}) {
  const numericBatchId = parseBatchId(batchId);

  const { page, pageSize, offset } = parsePagination(query, { pageSize: 50, maxPageSize: 500 });
  const db = openDatabase();
  try {
    const batch = db.prepare('SELECT id FROM import_batches WHERE id = ?').get(numericBatchId);
    if (!batch) {
      throw notFound('导入批次不存在。', { batchId: numericBatchId });
    }

    const where = ['batch_id = @batchId'];
    const params = { batchId: numericBatchId };
    const severity = normalizeIssueSeverityFilter(query.severity);
    const statusSeverity = normalizeIssueStatusFilter(query.status);
    if (severity && statusSeverity && severity !== statusSeverity) {
      where.push('1 = 0');
    } else if (severity || statusSeverity) {
      where.push('severity = @severity');
      params.severity = severity || statusSeverity;
    }
    const code = String(query.code || query.errorCode || query.error_code || '').trim();
    if (code) {
      where.push('error_code = @code');
      params.code = code;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = db.prepare(`SELECT COUNT(*) AS total FROM import_errors ${whereSql}`).get(params).total;
    const rows = db.prepare(
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
       ${whereSql}
       ORDER BY row_number ASC, id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset });

    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function getImportBatchFileDownload(batchId) {
  const numericBatchId = parseBatchId(batchId);
  const db = openDatabase();
  try {
    const batch = db.prepare(
      `SELECT
         id,
           original_filename AS originalFilename,
         stored_filename AS storedFilename,
         file_type AS fileType
       FROM import_batches
       WHERE id = ?`
    ).get(numericBatchId);
    if (!batch) {
      throw notFound('导入批次不存在。', { batchId: numericBatchId });
    }
    if (!batch.storedFilename) {
      throw notFound('该导入批次没有可下载的原始文件。', { batchId: numericBatchId });
    }

    const filePath = resolveStoredImportFilePath(batch.storedFilename);
    if (!fs.existsSync(filePath)) {
      throw notFound('导入批次原始文件不存在或已被移动。', { batchId: numericBatchId });
    }

    return {
      batchId: numericBatchId,
      filePath,
      fileName: decodeUploadOriginalName(batch.originalFilename) || `导入批次原文件-${numericBatchId}.${batch.fileType}`,
      fileType: batch.fileType
    };
  } finally {
    db.close();
  }
}

function listEnergyRecords(query = {}) {
  const { page, pageSize, offset } = parsePagination(query, { pageSize: 20, maxPageSize: 200 });
  const where = ["er.record_status = 'active'"];
  const params = {};

  if (query.normalizedMonthStart) {
    where.push('er.normalized_month >= @normalizedMonthStart');
    params.normalizedMonthStart = query.normalizedMonthStart;
  }
  if (query.normalizedMonthEnd) {
    where.push('er.normalized_month <= @normalizedMonthEnd');
    params.normalizedMonthEnd = query.normalizedMonthEnd;
  }
  if (query.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = query.energyTypeCode;
  }
  if (query.organization) {
    where.push('er.organization = @organization');
    params.organization = query.organization;
  }
  if (query.site) {
    where.push('er.site = @site');
    params.site = query.site;
  }
  if (query.department) {
    where.push('er.department = @department');
    params.department = query.department;
  }
  if (query.sourceBatchId) {
    where.push('er.source_batch_id = @sourceBatchId');
    params.sourceBatchId = Number.parseInt(query.sourceBatchId, 10);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM energy_records er
       JOIN energy_types et ON et.id = er.energy_type_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         er.id,
         er.source_batch_id AS sourceBatchId,
         er.source_row_number AS sourceRowNumber,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         er.original_month AS originalMonth,
         er.normalized_month AS normalizedMonth,
         er.original_unit AS originalUnit,
         er.original_value AS originalValue,
         er.normalized_unit AS normalizedUnit,
         er.normalized_value AS normalizedValue,
         er.organization,
         er.site,
         er.department,
         er.production_line AS productionLine,
         er.meter_code AS meterCode,
         er.business_dimension AS businessDimension,
         er.remark,
         er.duplicate_key AS duplicateKey,
         er.created_at AS createdAt,
         er.updated_at AS updatedAt
       FROM energy_records er
       JOIN energy_types et ON et.id = er.energy_type_id
       ${whereSql}
       ORDER BY er.normalized_month DESC, et.display_order ASC, er.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset });

    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

module.exports = {
  ENERGY_RECORD_IMPORT_TYPE,
  METER_READING_IMPORT_TYPE,
  assertImportBatchCanUseGenericDelete,
  createImportBatchFromUpload,
  deleteImportBatch,
  getImportBatchFileDownload,
  getImportBatchQueryDetail,
  getImportTypeLabel,
  listEnergyRecords,
  listImportBatches,
  listImportErrors,
  parsePagination
};
