const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { openDatabase, uploadsDir } = require('../db/database');
const { assertWritableAllowed } = require('./maintenanceState');
const { getUserPermissions, isSuperAdmin } = require('./authService');
const { AppError, badRequest, notFound } = require('../utils/errors');
const { decodeUploadOriginalName } = require('../utils/filenameEncoding');
const {
  assertAuditBatchCanUseGenericDelete,
  getImportAuditBatchDetail,
  parseStoredAuditJson,
  projectBackupAuditMetadata
} = require('./importAuditService');
const backupService = require('./backupService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');
const { buildEnergyTypeIndex, detectEnergyImportTemplateMismatch, validateAndNormalizeRow } = require('./import/normalization');
const { findLedgerAssociationsForImportRecord, loadActiveLedgerIndexes } = require('./ledgerService');

const MAX_PAGE_SIZE = 500;
const ENERGY_RECORD_IMPORT_TYPE = 'energy_record';
const METER_READING_IMPORT_TYPE = 'meter_reading';
// 导入批次删除备份原因用于生成可识别且受控的恢复快照。
const IMPORT_BATCH_DELETE_BACKUP_REASON = 'import-batch-delete';
// 导入批次删除操作编码用于持久化审计检索。
const IMPORT_BATCH_DELETE_OPERATION = 'imports.batch.delete';
// 导入批次删除审计对象类型用于统一标识被删除的批次。
const IMPORT_BATCH_DELETE_TARGET_TYPE = 'import_batch';
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
  shift_definition: '班次定义导入',
  tou_scheme: 'TOU 方案与时段导入',
  strategy_rule: '策略规则导入',
  energy_conversion_factor: '能源折标系数导入',
  energy_benchmark: '能效对标导入',
  energy_flow_node: '能流节点导入',
  energy_flow_edge: '能流边导入',
  energy_flow_record: '显式边值导入',
  energy_flow_workbook: '完整能流工作簿导入',
  carbon_activity: '独立碳活动导入',
  carbon_emission_report: '碳排放报告导入',
  ghg_report: '温室气体报告导入'
});
const IMPORT_TYPE_VALUES = Object.freeze(Object.keys(IMPORT_TYPE_LABELS));
// 特殊领域批次在通用导入查询入口仍需叠加领域权限，未知操作默认拒绝。
const IMPORT_TYPE_DOMAIN_PERMISSIONS = Object.freeze({
  energy_flow_workbook: Object.freeze({
    view: 'energy:flows:view',
    download: 'energy:flows:view'
  }),
  carbon_emission_report: Object.freeze({
    view: 'carbon:emission-reports:view',
    download: 'carbon:emission-reports:export'
  }),
  ghg_report: Object.freeze({
    view: 'carbon:ghg-reports:view',
    download: 'carbon:ghg-reports:export'
  })
});
// 两类独立报告批次都必须在通用导入查询中使用显式安全 DTO。
const RESTRICTED_REPORT_IMPORT_TYPES = Object.freeze(new Set([
  'carbon_emission_report',
  'ghg_report',
  'energy_flow_workbook'
]));

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

/** 返回通用导入入口针对特殊领域批次需要叠加的权限。 */
function getImportTypeDomainPermission(importType, operation) {
  const domainPermissions = IMPORT_TYPE_DOMAIN_PERMISSIONS[String(importType || '').trim()];
  if (!domainPermissions) return null;
  if (!Object.prototype.hasOwnProperty.call(domainPermissions, operation)) {
    throw new AppError('IMPORT_BATCH_DOMAIN_OPERATION_FORBIDDEN', '该导入批次操作未配置领域权限，已默认拒绝。', {
      statusCode: 403,
      details: { operation }
    });
  }
  return domainPermissions[operation];
}

/** 计算当前用户在通用列表中必须隐藏的特殊领域导入类型。 */
function getRestrictedImportTypesForUser(userId, operation = 'view') {
  if (isSuperAdmin(userId)) return [];
  const grantedPermissions = new Set(getUserPermissions(userId));
  return Object.keys(IMPORT_TYPE_DOMAIN_PERMISSIONS).filter((importType) => {
    const requiredPermission = getImportTypeDomainPermission(importType, operation);
    const requiredPermissions = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
    return !requiredPermissions.every((permission) => grantedPermissions.has(permission));
  });
}

/** 对详情、错误和原文件下载叠加特殊领域权限。 */
function assertImportBatchDomainPermission(batchId, userId, operation = 'view') {
  const numericBatchId = parseBatchId(batchId);
  const db = openDatabase();
  let batch;
  try {
    batch = db.prepare('SELECT id, import_type AS importType FROM import_batches WHERE id = ?').get(numericBatchId);
  } finally {
    db.close();
  }
  if (!batch) throw notFound('导入批次不存在。', { batchId: numericBatchId });
  const requiredPermission = getImportTypeDomainPermission(batch.importType, operation);
  if (!requiredPermission || isSuperAdmin(userId)) return batch;
  const grantedPermissions = new Set(getUserPermissions(userId));
  const requiredPermissions = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
  if (!requiredPermissions.every((permission) => grantedPermissions.has(permission))) {
    throw new AppError('FORBIDDEN', '当前账号没有访问该领域导入批次的权限。', {
      statusCode: 403,
      details: { requiredPermissions, mode: 'all' }
    });
  }
  return batch;
}

/** 投影独立报告批次在通用列表中的安全字段，移除摘要和内部见证。 */
function projectRestrictedReportBatchListRow(row) {
  return {
    id: row.id,
    importType: row.importType,
    importTypeLabel: row.importTypeLabel,
    originalFilename: row.originalFilename,
    displayFilename: row.displayFilename,
    fileType: row.fileType,
    fileSizeBytes: row.fileSizeBytes,
    status: row.status,
    auditPhase: row.auditPhase,
    totalRows: row.totalRows,
    successCount: row.successCount,
    failureCount: row.failureCount,
    skippedCount: row.skippedCount,
    hasBackup: Boolean(row.hasBackup),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    errorSummary: row.errorSummary
  };
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
  // 批次导入类型用于在通用审计白名单前保留抄表领域的明确错误提示。
  const importType = batch?.importType || batch?.import_type || '';
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

/** 构造独立报告批次通用详情安全 DTO，不透出内部文件名、摘要、签名或候选见证。 */
function projectRestrictedReportBatchDetail(detail, issueSummary, numericBatchId) {
  const normalizedDetail = normalizeImportBatchRow(detail);
  return {
    id: normalizedDetail.id,
    importType: normalizedDetail.importType,
    importTypeLabel: normalizedDetail.importTypeLabel,
    originalFilename: normalizedDetail.originalFilename,
    displayFilename: normalizedDetail.displayFilename,
    fileType: normalizedDetail.fileType,
    fileSizeBytes: normalizedDetail.fileSizeBytes,
    status: normalizedDetail.status,
    auditPhase: normalizedDetail.auditPhase,
    counts: {
      totalRows: normalizedDetail.totalRows,
      successCount: normalizedDetail.successCount,
      failureCount: normalizedDetail.failureCount,
      skippedCount: normalizedDetail.skippedCount
    },
    issueCounts: normalizedDetail.issueCounts,
    issueSummary,
    errorSummary: normalizedDetail.errorSummary,
    startedAt: normalizedDetail.startedAt,
    finishedAt: normalizedDetail.finishedAt,
    createdAt: normalizedDetail.createdAt,
    updatedAt: normalizedDetail.updatedAt,
    download: {
      available: Boolean(detail.storedFilename),
      url: `/api/imports/batches/${numericBatchId}/download`,
      originalFilename: normalizedDetail.originalFilename,
      fileType: normalizedDetail.fileType,
      fileSizeBytes: normalizedDetail.fileSizeBytes
    },
    errorsUrl: `/api/imports/batches/${numericBatchId}/errors`
  };
}

function getImportBatchQueryDetail(batchId) {
  const numericBatchId = parseBatchId(batchId);
  const detail = getImportAuditBatchDetail(numericBatchId, { includeIssues: false });
  const db = openDatabase();
  try {
    const issueSummary = getImportIssueSummaryRows(db, numericBatchId);
    if (RESTRICTED_REPORT_IMPORT_TYPES.has(detail.importType)) {
      return projectRestrictedReportBatchDetail(detail, issueSummary, numericBatchId);
    }
    return {
      ...normalizeImportBatchRow(detail),
      counts: {
        totalRows: detail.totalRows,
        successCount: detail.successCount,
        failureCount: detail.failureCount,
        skippedCount: detail.skippedCount
      },
      issueSummary,
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

function listImportBatches(query = {}, options = {}) {
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
  const excludedImportTypes = Array.isArray(options.excludedImportTypes)
    ? [...new Set(options.excludedImportTypes.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  if (excludedImportTypes.length > 0) {
    const placeholders = excludedImportTypes.map((excludedImportType, index) => {
      const parameterName = `excludedImportType${index}`;
      params[parameterName] = excludedImportType;
      return `@${parameterName}`;
    });
    where.push(`import_type NOT IN (${placeholders.join(', ')})`);
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

    const projectedRows = rows.map(normalizeImportBatchRow).map((row) => (
      RESTRICTED_REPORT_IMPORT_TYPES.has(row.importType) ? projectRestrictedReportBatchListRow(row) : row
    ));
    return { rows: projectedRows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

/**
 * 校验批次删除审计操作者，确保持久化审计可追溯到已认证用户。
 * @param {object} options 删除服务选项。
 * @returns {{ userId: number, username: string, displayName: string|null, ip: string|null }} 标准化操作者。
 */
function requireImportBatchDeleteActor(options = {}) {
  // 原始操作者用于读取路由传入的认证上下文。
  const sourceActor = options.actor || {};
  // 数字用户 ID 用于写入操作审计外键。
  const userId = Number(sourceActor.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !String(sourceActor.username || '').trim()) {
    throw badRequest('删除导入批次缺少合法的已认证操作者。', {
      code: 'IMPORT_BATCH_DELETE_ACTOR_REQUIRED'
    });
  }
  return {
    userId,
    username: String(sourceActor.username).trim(),
    displayName: sourceActor.displayName === undefined || sourceActor.displayName === null
      ? null
      : String(sourceActor.displayName),
    ip: sourceActor.ip === undefined || sourceActor.ip === null ? null : String(sourceActor.ip)
  };
}

/**
 * 构造删除前备份失败的稳定公开错误，避免原生异常详情进入 development HTTP 响应。
 * @returns {AppError} 不含本机路径和底层错误消息的应用错误。
 */
function createImportBatchDeleteBackupFailedError() {
  return new AppError(
    'IMPORT_BATCH_DELETE_BACKUP_FAILED',
    '删除前备份失败，已拒绝删除。',
    {
      statusCode: 500,
      details: null
    }
  );
}

/**
 * 在批次删除事务内写入持久化操作审计，审计失败会使业务删除整体回滚。
 * @param {object} db 当前 SQLite 事务连接。
 * @param {object} actor 标准化操作者。
 * @param {number} batchId 被删除批次 ID。
 * @param {object} detail 删除结果与恢复信息。
 * @param {object} options 删除服务选项。
 */
function insertImportBatchDeleteAudit(db, actor, batchId, detail, options = {}) {
  if (typeof options.beforeAuditInsert === 'function') {
    options.beforeAuditInsert({
      db,
      operation: IMPORT_BATCH_DELETE_OPERATION,
      targetType: IMPORT_BATCH_DELETE_TARGET_TYPE,
      targetId: batchId,
      detail
    });
  }
  db.prepare(
    `INSERT INTO sys_operation_logs
       (user_id, operation, target_type, target_id, detail_json, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actor.userId,
    IMPORT_BATCH_DELETE_OPERATION,
    IMPORT_BATCH_DELETE_TARGET_TYPE,
    String(batchId),
    JSON.stringify(detail),
    actor.ip
  );
}

/**
 * 删除普通能耗导入批次，并在删除前创建备份、在同一事务记录操作审计。
 * @param {string|number} batchId 导入批次 ID。
 * @param {object} options 操作者、备份服务和测试故障注入选项。
 * @returns {Promise<object>} 删除计数、安全备份标识和影响说明。
 */
async function deleteImportBatch(batchId, options = {}) {
  assertWritableAllowed('imports:delete-batch:service');
  // 数字批次 ID 用于所有事务内查询和审计目标标识。
  const numericBatchId = parseBatchId(batchId);
  // 标准化操作者用于保证删除成功时一定存在可追溯审计。
  const actor = requireImportBatchDeleteActor(options);
  // 可注入备份创建方法仅用于隔离测试故障，不改变生产默认服务。
  const createBackup = options.createBackup || backupService.createBackup;
  // 业务数据库连接用于锁定目标、删除业务数据并原子写审计。
  const db = openDatabase();
  try {
    db.exec('BEGIN IMMEDIATE');
    // 锁内批次快照用于避免校验后目标类型或文件信息发生变化。
    const batch = db.prepare(
      `SELECT id, import_type AS importType, original_filename AS originalFilename
       FROM import_batches
       WHERE id = ?`
    ).get(numericBatchId);
    if (!batch) {
      throw notFound('导入批次不存在。', { batchId: numericBatchId });
    }
    assertImportBatchCanUseGenericDelete(batch);

    // 原始备份结果只在服务内使用，随后投影为不含绝对路径的安全元数据。
    let rawBackup;
    try {
      rawBackup = await createBackup({
        reason: IMPORT_BATCH_DELETE_BACKUP_REASON,
        skipCheckpoint: true
      });
    } catch {
      throw createImportBatchDeleteBackupFailedError();
    }
    // 安全备份元数据用于 API 响应和持久化审计，禁止泄漏数据库或备份目录绝对路径。
    const backup = projectBackupAuditMetadata(rawBackup);
    if (!backup || !String(backup.backupName || '').trim()) {
      throw badRequest('删除前备份未返回可追溯的备份标识，已拒绝删除。', {
        code: 'IMPORT_BATCH_DELETE_BACKUP_IDENTIFIER_REQUIRED'
      });
    }

    // 删除错误数量在删除前统计，用于响应和持久审计。
    const deletedErrors = db.prepare('SELECT COUNT(*) AS total FROM import_errors WHERE batch_id = ?').get(numericBatchId).total;
    // 关联旧碳结果数量在删除前统计，随后按既有顺序优先删除。
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

    // 删除能耗记录数量来自实际变更行数，避免只依赖批次成功计数。
    const deletedEnergyRecords = db.prepare('DELETE FROM energy_records WHERE source_batch_id = ?').run(numericBatchId).changes;
    db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(numericBatchId);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(numericBatchId);

    // 解码后的原文件名用于用户提示和审计，不包含本地存储路径。
    const originalFilename = decodeUploadOriginalName(batch.originalFilename);
    // 恢复说明用于明确备份只能由管理员按高风险恢复流程处理。
    const recoveryInformation = `删除前备份为 ${backup.backupName}；如需恢复，请由具备备份恢复权限的管理员按整库恢复流程处理。`;
    // 预测影响说明用于固定“不自动删除预测运行和结果”的领域边界。
    const predictionImpact = '历史能耗记录已变化，既有预测运行和结果不会自动删除；如需反映最新数据，请重新创建预测运行。';
    // 删除结果用于 API 响应和审计详情的同源数据。
    const result = {
      batchId: numericBatchId,
      importType: batch.importType,
      originalFilename,
      deletedEnergyRecords,
      deletedErrors,
      deletedCarbonEmissions,
      deletedImportBatches: 1,
      deletedStoredFile: false,
      backup,
      recoveryInformation,
      predictionImpact
    };
    // 审计详情记录操作者、批次、原文件、删除计数、备份标识和恢复边界。
    const auditDetail = {
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
      ...result
    };
    insertImportBatchDeleteAudit(db, actor, numericBatchId, auditDetail, options);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
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
  IMPORT_TYPE_DOMAIN_PERMISSIONS,
  METER_READING_IMPORT_TYPE,
  assertImportBatchCanUseGenericDelete,
  assertImportBatchDomainPermission,
  createImportBatchFromUpload,
  deleteImportBatch,
  getImportBatchFileDownload,
  getImportBatchQueryDetail,
  getImportTypeDomainPermission,
  getImportTypeLabel,
  getRestrictedImportTypesForUser,
  listEnergyRecords,
  listImportBatches,
  listImportErrors,
  parsePagination
};
