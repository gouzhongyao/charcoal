'use strict';

const { openDatabase: defaultOpenDatabase, uploadsDir: defaultUploadsDir } = require('../db/database');
const { AppError, badRequest } = require('../utils/errors');
const backupService = require('./backupService');
const {
  bindDemoContextPreviewInTransaction,
  markDemoContextExecutedInTransaction
} = require('./demoContextService');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssuesWithDatabase,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  authorizeEnergyAnalysisImportExecute,
  buildEnergyAnalysisImportPreviewAuditDigest,
  buildEnergyAnalysisImportPreviewSignature,
  buildEnergyAnalysisImportSignaturePayload,
  getEnergyAnalysisImportTemplate,
  normalizeCandidateRows,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  stableSerialize,
  timingSafeEqualText,
  verifyEnergyAnalysisImportPreviewAuditDigest,
  verifyEnergyAnalysisImportPreviewSignature
} = require('./energyAnalysisImportCore');

// 单批次能源分析导入固定使用服务端原文件、统一审计和统一 execute 授权门槛。
const SINGLE_BATCH_IMPORT_SERVICE_VERSION = 'energy-analysis-single-batch-import:v1';

/**
 * 将批次 ID 规范化为正安全整数。
 * @param {*} value 原始批次 ID。
 * @returns {number} 规范化批次 ID。
 */
function normalizeBatchId(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw badRequest('batchId 必须是正整数。', { code: 'ENERGY_ANALYSIS_IMPORT_BATCH_ID_INVALID', batchId: value });
  }
  const batchId = Number(text);
  if (!Number.isSafeInteger(batchId)) {
    throw badRequest('batchId 必须是安全范围内的正整数。', { code: 'ENERGY_ANALYSIS_IMPORT_BATCH_ID_INVALID', batchId: value });
  }
  return batchId;
}

/**
 * 打开可注入的 SQLite 连接，并记录连接是否由当前服务负责关闭。
 * @param {object} options 依赖注入选项。
 * @returns {{db:object,shouldClose:boolean}} 数据库上下文。
 */
function openServiceDatabase(options = {}) {
  if (options.db) {
    return { db: options.db, shouldClose: false };
  }
  const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
  return { db: openDatabase(), shouldClose: true };
}

/** 使用当前连接执行 IMMEDIATE 写事务；已有外层事务时复用且不嵌套。 */
function runImmediateWriteTransaction(db, operation) {
  if (db.inTransaction) return operation();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 使用当前 SQLite 连接读取或幂等持久化安装级 HMAC 密钥。
 * @param {object} db SQLite 连接。
 * @param {object} options 依赖注入选项。
 * @returns {string} 安装级 HMAC 密钥。
 */
function resolveImportSecret(db, options = {}) {
  const readAppMeta = typeof options.readAppMeta === 'function'
    ? options.readAppMeta
    : (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  const persistAppMeta = typeof options.persistAppMeta === 'function'
    ? options.persistAppMeta
    : (key, value) => {
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO NOTHING`
      ).run(key, value);
      return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
    };
  return resolveEnergyAnalysisImportHmacSecret({
    env: options.env || process.env,
    readAppMeta,
    persistAppMeta,
    randomBytes: options.randomBytes
  });
}

/**
 * 将持久化批次和审计上下文投影为统一授权函数需要的服务端元数据。
 * @param {object} batch 持久化审计批次详情。
 * @returns {object} 不信任客户端的批次绑定对象。
 */
function buildPersistedBatchBinding(batch) {
  const auditContext = batch && batch.auditContext && typeof batch.auditContext === 'object'
    ? batch.auditContext
    : {};
  return {
    id: batch.id,
    status: batch.status,
    auditPhase: batch.auditPhase,
    importType: batch.importType,
    templateType: auditContext.templateType,
    operation: auditContext.operation,
    recordKind: auditContext.recordKind,
    importTypes: auditContext.importTypes,
    fileSha256: batch.fileSha256,
    previewSignature: batch.previewSignature,
    previewAuditDigest: batch.previewAuditDigest
  };
}

/**
 * 从持久化 preview 批次恢复单批次 execute 完整见证，客户端只保留确认字段。
 * @param {object} body 客户端最小 execute 请求体。
 * @param {object} batch 持久化 preview 批次。
 * @returns {object} 服务端受控的完整 execute 上下文。
 */
function buildPersistedSingleBatchExecuteBody(body, batch) {
  const requestBody = body && typeof body === 'object' ? body : {};
  const auditContext = batch && batch.auditContext && typeof batch.auditContext === 'object'
    ? batch.auditContext
    : {};
  const candidateRows = normalizeCandidateRows(auditContext.candidateRows || []);
  const persistedWitness = {
    backupReason: getEnergyAnalysisImportTemplate(auditContext.templateType).backupReason,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    fileSha256: batch.fileSha256,
    previewSignature: batch.previewSignature,
    previewAuditDigest: batch.previewAuditDigest,
    expectedWouldImport: candidateRows.length,
    candidateRowIds: candidateRows.map((row) => row.candidateRowId),
    candidateRows
  };
  const resolveWitness = (field) => Object.prototype.hasOwnProperty.call(requestBody, field)
    ? requestBody[field]
    : persistedWitness[field];
  return {
    batchId: batch.id,
    confirmText: requestBody.confirmText,
    backupReason: resolveWitness('backupReason'),
    duplicateStrategy: resolveWitness('duplicateStrategy'),
    requireBackup: requestBody.requireBackup,
    acknowledgeSkippedRisks: requestBody.acknowledgeSkippedRisks,
    fileSha256: resolveWitness('fileSha256'),
    previewSignature: resolveWitness('previewSignature'),
    previewAuditDigest: resolveWitness('previewAuditDigest'),
    expectedWouldImport: resolveWitness('expectedWouldImport'),
    candidateRowIds: resolveWitness('candidateRowIds'),
    candidateRows: resolveWitness('candidateRows')
  };
}

/**
 * 在读取原文件前验证 execute 请求确实属于当前 descriptor 的持久化 preview 批次。
 * @param {object} body execute 请求体。
 * @param {object} batch 服务端持久化批次。
 * @param {object} template 当前 descriptor 对应冻结模板。
 * @param {string} secret 服务端 HMAC 密钥。
 * @returns {boolean} 是否允许后续失败更新该批次审计。
 */
function isTrustedPersistedBatchForFailureAudit(body, batch, template, secret) {
  try {
    const auditContext = batch && batch.auditContext && typeof batch.auditContext === 'object'
      ? batch.auditContext
      : null;
    const previewAudit = auditContext && auditContext.previewAudit && typeof auditContext.previewAudit === 'object'
      ? auditContext.previewAudit
      : null;
    if (!body || !batch || !auditContext || !previewAudit || template.importTypes.length !== 1) return false;
    if (Number(body.batchId) !== Number(batch.id)) return false;
    if (!['completed', 'completed_with_errors'].includes(batch.status) || batch.auditPhase !== 'preview') return false;
    if (batch.importType !== template.importTypes[0]
      || auditContext.templateType !== template.templateType
      || auditContext.operation !== template.operation
      || auditContext.recordKind !== template.recordKind
      || stableSerialize(auditContext.importTypes) !== stableSerialize(template.importTypes)) return false;
    if (previewAudit.templateType !== template.templateType
      || previewAudit.operation !== template.operation
      || previewAudit.recordKind !== template.recordKind
      || stableSerialize(previewAudit.importTypes) !== stableSerialize(template.importTypes)) return false;
    if (typeof batch.storedFilename !== 'string' || !batch.storedFilename.trim()
      || !Number.isSafeInteger(batch.fileSizeBytes) || batch.fileSizeBytes < 0
      || typeof batch.fileSha256 !== 'string'
      || previewAudit.fileSha256 !== batch.fileSha256
      || !timingSafeEqualText(batch.previewSignature, buildEnergyAnalysisImportPreviewSignature({
        templateType: template.templateType,
        fileSha256: batch.fileSha256,
        candidateRows: normalizeCandidateRows(auditContext.candidateRows || [])
      }, secret))) return false;
    if (body.confirmText !== template.confirmText
      || body.requireBackup !== true
      || body.acknowledgeSkippedRisks !== true) return false;

    const persistedCandidateRows = normalizeCandidateRows(auditContext.candidateRows || []);
    if (Number(auditContext.summary?.wouldImport) !== persistedCandidateRows.length) return false;

    const signaturePayload = buildEnergyAnalysisImportSignaturePayload({
      templateType: template.templateType,
      fileSha256: batch.fileSha256,
      candidateRows: persistedCandidateRows
    });
    return verifyEnergyAnalysisImportPreviewSignature(signaturePayload, batch.previewSignature, secret)
      && verifyEnergyAnalysisImportPreviewAuditDigest(previewAudit, batch.previewAuditDigest, secret);
  } catch (_error) {
    return false;
  }
}

/**
 * 将领域 preview 补齐稳定候选、安全审计快照、签名和摘要。
 * @param {object} preview 领域重算结果。
 * @param {object} context 文件与模板安全上下文。
 * @returns {object} 可持久化 preview。
 */
function securePreviewResult(preview, context) {
  const candidateRows = normalizeCandidateRows(preview.candidateRows || []);
  const candidateRowIds = candidateRows.map((row) => row.candidateRowId);
  const previewAudit = {
    version: `${SINGLE_BATCH_IMPORT_SERVICE_VERSION}:preview-audit`,
    templateType: context.template.templateType,
    operation: context.template.operation,
    recordKind: context.template.recordKind,
    importTypes: [...context.template.importTypes],
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    fileSha256: context.fileSha256,
    summary: preview.summary,
    items: preview.items || [],
    auditIssues: preview.auditIssues || []
  };
  const signatureInput = {
    templateType: context.template.templateType,
    fileSha256: context.fileSha256,
    candidateRows,
    candidateRowIds
  };
  const previewSignature = buildEnergyAnalysisImportPreviewSignature(signatureInput, context.secret);
  const previewAuditDigest = buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, context.secret);
  return {
    ...preview,
    dryRun: true,
    previewOnly: true,
    writesBusinessRecords: false,
    templateType: context.template.templateType,
    operation: context.template.operation,
    recordKind: context.template.recordKind,
    importTypes: [...context.template.importTypes],
    confirmText: context.template.confirmText,
    backupReason: context.template.backupReason,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: true,
    fileSha256: context.fileSha256,
    candidateRows,
    candidateRowIds,
    expectedWouldImport: candidateRows.length,
    previewAudit,
    previewSignature,
    previewAuditDigest
  };
}

/**
 * 构造 preview 批次错误摘要。
 * @param {object} summary 统一 preview 汇总。
 * @returns {string|null} 中文错误摘要。
 */
function buildPreviewErrorSummary(summary = {}, domainName = '能源分析') {
  const parts = [];
  if (Number(summary.blocked || 0) > 0) parts.push(`${summary.blocked} 行阻断`);
  if (Number(summary.skipped || 0) > 0) parts.push(`${summary.skipped} 行跳过`);
  if (Number(summary.warnings || 0) > 0) parts.push(`${summary.warnings} 条警告`);
  if (Number(summary.errors || 0) > 0) parts.push(`${summary.errors} 条错误`);
  const safeDomainName = String(domainName || '').trim() || '能源分析';
  return parts.length > 0 ? `${safeDomainName}导入存在 ${parts.join('、')}。` : null;
}

/**
 * 投影可进入响应和 execute 审计的备份摘要，排除本机绝对路径。
 * @param {object|null} backup 备份服务返回值。
 * @returns {object|null} 安全备份摘要。
 */
function projectSafeBackupSummary(backup) {
  if (!backup || typeof backup !== 'object') return null;
  return {
    backupName: backup.backupName || null,
    reason: backup.reason || null,
    sizeBytes: Number.isFinite(Number(backup.sizeBytes)) ? Number(backup.sizeBytes) : null,
    sha256: backup.sha256 || null,
    method: backup.method || null,
    createdAt: backup.createdAt || null,
    updatedAt: backup.updatedAt || null
  };
}

/**
 * 创建单批次能源分析 preview，并仅写统一审计批次及问题明细。
 * @param {object} file Multer 已落盘文件对象。
 * @param {object} descriptor 领域解析与 preview 构建描述器。
 * @param {object} options 依赖注入选项。
 * @returns {object} 持久化后的安全 preview。
 */
function createEnergyAnalysisSingleBatchPreview(file, descriptor, options = {}) {
  if (!file || !file.originalname || !file.filename) {
    throw badRequest('请上传已落盘且包含 originalname/filename 的表格文件。', {
      code: 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED',
      fieldName: 'file'
    });
  }
  if (!descriptor || typeof descriptor.buildPreview !== 'function') {
    throw badRequest('单批次导入缺少领域 preview 构建器。', { code: 'ENERGY_ANALYSIS_IMPORT_PREVIEW_BUILDER_REQUIRED' });
  }

  const template = getEnergyAnalysisImportTemplate(descriptor.templateType);
  const uploadsDir = options.uploadsDir || defaultUploadsDir;
  const safeFile = readSafeUploadFile(uploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined,
    maxSizeBytes: options.maxFileSizeBytes
  });
  const databaseContext = openServiceDatabase(options);
  try {
    const secret = resolveImportSecret(databaseContext.db, options);
    let previewBuildError = null;
    let domainPreview;
    const previewBuildContext = {
      db: databaseContext.db,
      buffer: safeFile.buffer,
      originalFilename: file.originalname,
      fileSha256: safeFile.fileSha256,
      fileSizeBytes: safeFile.sizeBytes,
      template,
      options
    };
    try {
      domainPreview = descriptor.buildPreview(previewBuildContext);
    } catch (error) {
      if (descriptor.persistBuildPreviewFailures !== true || typeof descriptor.buildPreviewFailure !== 'function') {
        throw error;
      }
      previewBuildError = error;
      domainPreview = descriptor.buildPreviewFailure({ ...previewBuildContext, error });
    }
    const preview = securePreviewResult(domainPreview, {
      template,
      fileSha256: safeFile.fileSha256,
      secret
    });
    const summary = preview.summary || {};
    const status = previewBuildError
      ? 'failed'
      : (Number(summary.totalRows || 0) === 0 && Number(summary.errors || 0) > 0
        ? 'failed'
        : (Number(summary.blocked || 0) > 0 || Number(summary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed'));

    const persistPreview = () => runImmediateWriteTransaction(databaseContext.db, () => {
      const batch = createPreviewAuditBatch({
        importType: template.importTypes[0],
        originalFilename: file.originalname,
        storedFilename: file.filename,
        fileType: String(file.originalname).split('.').pop().toLowerCase(),
        fileSizeBytes: safeFile.sizeBytes,
        fileSha256: safeFile.fileSha256,
        status,
        auditPhase: 'preview',
        duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
        fieldMapping: preview.fieldMapping || {},
        previewSignature: preview.previewSignature,
        previewAuditDigest: preview.previewAuditDigest,
        auditContext: {
          version: SINGLE_BATCH_IMPORT_SERVICE_VERSION,
          templateType: template.templateType,
          operation: template.operation,
          recordKind: template.recordKind,
          importTypes: [...template.importTypes],
          confirmText: template.confirmText,
          backupReason: template.backupReason,
          duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
          requireBackup: true,
          summary: preview.summary,
          candidateRowIds: preview.candidateRowIds,
          candidateRows: preview.candidateRows,
          previewAudit: preview.previewAudit,
          notices: preview.notices || []
        },
        statistics: {
          totalRows: Number(summary.totalRows || 0),
          successCount: Number(summary.wouldImport || 0),
          failureCount: Number(summary.blocked || 0),
          skippedCount: Number(summary.skipped || 0)
        },
        errorSummary: buildPreviewErrorSummary(summary, descriptor.domainName)
      }, { db: databaseContext.db });
      replaceImportAuditIssuesWithDatabase(databaseContext.db, batch.id, preview.auditIssues || []);
      // 领域 preview 审计钩子仅来自服务端描述器，并与批次及问题明细共享当前事务。
      if (typeof descriptor.persistPreviewAudit === 'function') {
        descriptor.persistPreviewAudit({
          db: databaseContext.db,
          batch,
          preview,
          file,
          safeFile,
          template,
          options
        });
      }
      if (options.demoContext) {
        bindDemoContextPreviewInTransaction({
          db: databaseContext.db,
          ...options.demoContext,
          uploadFileSha256: safeFile.fileSha256,
          previewDigest: preview.previewAuditDigest,
          batchBindings: [{ batchId: batch.id, batchRole: 'primary' }]
        });
      }
      return getImportAuditSummary(batch.id, { db: databaseContext.db });
    });
    const auditBatch = persistPreview();
    if (previewBuildError) throw previewBuildError;
    return {
      ...preview,
      persistsImportBatch: true,
      batchId: auditBatch.id,
      auditBatch
    };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 将统一授权错误转换为稳定 BAD_REQUEST。
 * @param {object} authorization 统一授权结果。
 * @returns {never} 始终抛出错误。
 */
function throwAuthorizationFailure(authorization) {
  const firstError = authorization.errors && authorization.errors[0]
    ? authorization.errors[0]
    : { code: 'ENERGY_ANALYSIS_IMPORT_EXECUTE_NOT_AUTHORIZED', message: '能源分析导入未获授权。' };
  throw badRequest(firstError.message || '能源分析导入未获授权。', {
    code: firstError.code || 'ENERGY_ANALYSIS_IMPORT_EXECUTE_NOT_AUTHORIZED',
    authorizationErrors: authorization.errors || []
  });
}

/**
 * 使用服务端批次、原文件与重算 preview 调用唯一 execute 授权门槛。
 * @param {object} body execute 请求体。
 * @param {object} batch 持久化批次详情。
 * @param {object} preview 服务端当前重算 preview。
 * @param {Buffer} fileBuffer 同一文件描述符读取的 Buffer。
 * @param {string} secret 服务端 HMAC 密钥。
 * @returns {object} 授权结果。
 */
function authorizePersistedBatchExecute(body, batch, preview, fileBuffer, secret) {
  const template = getEnergyAnalysisImportTemplate(preview.templateType);
  const trustedBody = buildPersistedSingleBatchExecuteBody(body, batch);
  return authorizeEnergyAnalysisImportExecute({
    templateType: template.templateType,
    operation: template.operation,
    recordKind: template.recordKind,
    importTypes: [...template.importTypes],
    confirmText: trustedBody.confirmText,
    backupReason: trustedBody.backupReason,
    duplicateStrategy: trustedBody.duplicateStrategy,
    requireBackup: trustedBody.requireBackup,
    acknowledgeSkippedRisks: trustedBody.acknowledgeSkippedRisks,
    fileSha256: trustedBody.fileSha256,
    previewSignature: trustedBody.previewSignature,
    previewAuditDigest: trustedBody.previewAuditDigest,
    expectedWouldImport: trustedBody.expectedWouldImport,
    candidateRowIds: trustedBody.candidateRowIds,
    candidateRows: trustedBody.candidateRows,
    expectedBatchId: batch.id,
    batch: buildPersistedBatchBinding(batch)
  }, {
    secret,
    fileBuffer,
    recomputedCandidateRows: preview.candidateRows,
    previewAudit: preview.previewAudit
  });
}

/**
 * 判断错误码是否属于可向审计暴露的稳定能源分析领域码。
 * @param {*} value 原始错误码。
 * @returns {boolean} 是否为稳定领域错误码。
 */
function isSafeEnergyAnalysisErrorCode(value) {
  const code = String(value || '').trim();
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code)
    && (code.startsWith('ENERGY_ANALYSIS_')
      || code.startsWith('ENERGY_TIMESERIES_')
      || code.startsWith('CARBON_ACTIVITY_')
      || code.startsWith('CARBON_EMISSION_REPORT_')
      || code.startsWith('GHG_REPORT_'));
}

/**
 * 根据稳定错误码返回固定安全中文消息，禁止使用原始异常文本。
 * @param {string} code 稳定领域错误码。
 * @returns {string} 可进入响应与审计的安全消息。
 */
function getSafeExecuteErrorMessage(code, domainName = '能源分析') {
  const safeDomainName = String(domainName || '').trim() || '能源分析';
  if (code === 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED') {
    return `${safeDomainName}导入备份失败，未写入业务数据。`;
  }
  if (code === 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED') {
    return `${safeDomainName}导入事务失败，业务数据已回滚。`;
  }
  if (code === 'ENERGY_ANALYSIS_IMPORT_SOURCE_OR_BATCH_INVALID') {
    return `${safeDomainName}导入原文件或批次校验失败，未写入业务数据。`;
  }
  if (code.startsWith('ENERGY_ANALYSIS_UPLOAD_')) {
    return `${safeDomainName}导入原文件安全校验失败，未写入业务数据。`;
  }
  if (code.startsWith('ENERGY_TIMESERIES_') && safeDomainName === '能源分析') {
    return '时序能耗导入文件或模板校验失败，未写入业务数据。';
  }
  return `${safeDomainName}导入授权校验失败，未写入业务数据。`;
}

/**
 * 根据安全领域码构造对外错误；授权类保持 4xx，备份和事务基础设施故障使用 5xx。
 * @param {string} code 稳定领域错误码。
 * @returns {Error} 带安全消息和合适 HTTP 状态的错误。
 */
function createSafeExecuteError(code, domainName = '能源分析') {
  const message = getSafeExecuteErrorMessage(code, domainName);
  if (code === 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED') {
    return new AppError(code, message, { statusCode: 503, details: { code } });
  }
  if (code === 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED') {
    return new AppError(code, message, { statusCode: 500, details: { code } });
  }
  return badRequest(message, { code });
}

/**
 * 将任意 execute 异常包装为不含路径、令牌或底层基础设施文本的领域错误。
 * @param {Error} error 原始异常。
 * @param {'preflight'|'lock'|'backup'|'write'} stage 失败阶段。
 * @returns {Error} 安全领域错误。
 */
function normalizeSafeExecuteError(error, stage = 'preflight', domainName = '能源分析') {
  const detailCode = error?.details?.code;
  if (isSafeEnergyAnalysisErrorCode(detailCode)) {
    return createSafeExecuteError(detailCode, domainName);
  }
  const stageCode = stage === 'backup'
    ? 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED'
    : (stage === 'lock' || stage === 'write'
      ? 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
      : 'ENERGY_ANALYSIS_IMPORT_SOURCE_OR_BATCH_INVALID');
  return createSafeExecuteError(stageCode, domainName);
}

/**
 * 尽力把失败 execute 写回正确的 preview 批次，且不覆盖已成功 execute 的审计结果。
 * @param {*} requestedBatchId 请求中的批次 ID。
 * @param {object} descriptor 领域描述器。
 * @param {Error} error 原始失败。
 * @param {object} options 依赖注入选项。
 * @param {object|null} backup 已创建备份元数据。
 */
function markEnergyAnalysisSingleBatchFailure(requestedBatchId, descriptor, error, options = {}, backup = null) {
  let databaseContext = null;
  try {
    const batchId = normalizeBatchId(requestedBatchId);
    const template = getEnergyAnalysisImportTemplate(descriptor.templateType);
    const safeError = normalizeSafeExecuteError(error, 'preflight', descriptor.domainName);
    const safeErrorCode = safeError.details.code;
    const safeErrorMessage = getSafeExecuteErrorMessage(safeErrorCode, descriptor.domainName);
    databaseContext = openServiceDatabase(options);
    const batch = getImportAuditBatchDetail(batchId, { db: databaseContext.db, includeIssues: false });
    if (batch.importType !== template.importTypes[0]) return;
    if (batch.auditPhase === 'execute' && ['completed', 'completed_with_errors'].includes(batch.status)) return;
    updateExecuteAuditResult(batchId, {
      status: 'failed',
      statistics: {
        totalRows: Number(batch.totalRows || 0),
        successCount: 0,
        failureCount: Number(batch.failureCount || 0),
        skippedCount: Number(batch.skippedCount || 0)
      },
      executeResult: {
        executed: false,
        writesBusinessRecords: false,
        errorCode: safeErrorCode,
        errorMessage: safeErrorMessage,
        previewSignature: null,
        previewAuditDigest: null
      },
      backup,
      errorSummary: safeErrorMessage
    }, { db: databaseContext.db });
  } catch (_auditError) {
    // 失败审计不得掩盖原始授权、备份或事务错误。
  } finally {
    if (databaseContext && databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 执行单批次能源分析导入：服务端重读、重算、授权、备份并在单事务内复核写入。
 * @param {object} body execute 请求体。
 * @param {object} descriptor 领域重算与写入描述器。
 * @param {object} options 依赖注入选项。
 * @returns {Promise<object>} execute 结果及最终审计。
 */
async function executeEnergyAnalysisSingleBatchImport(body = {}, descriptor, options = {}) {
  let backup = null;
  let failureStage = 'preflight';
  let trustedFailureAuditBatchId = null;
  try {
    if (!descriptor || typeof descriptor.buildPreview !== 'function' || typeof descriptor.insertCandidates !== 'function') {
      throw badRequest('单批次导入缺少领域重算或写入构建器。', { code: 'ENERGY_ANALYSIS_IMPORT_EXECUTE_BUILDER_REQUIRED' });
    }
    const batchId = normalizeBatchId(body.batchId);
    const template = getEnergyAnalysisImportTemplate(descriptor.templateType);
    const databaseContext = openServiceDatabase(options);
    try {
      const batch = getImportAuditBatchDetail(batchId, { db: databaseContext.db, includeIssues: false });
      const secret = resolveImportSecret(databaseContext.db, options);
      const trustedPersistedBatch = isTrustedPersistedBatchForFailureAudit(body, batch, template, secret);
      if (!batch.storedFilename) {
        throw badRequest('持久化批次缺少服务端原文件。', { code: 'ENERGY_ANALYSIS_IMPORT_STORED_FILE_REQUIRED', batchId });
      }
      const uploadsDir = options.uploadsDir || defaultUploadsDir;
      const safeFile = readSafeUploadFile(uploadsDir, batch.storedFilename, {
        expectedSizeBytes: Number.isSafeInteger(batch.fileSizeBytes) ? batch.fileSizeBytes : undefined,
        maxSizeBytes: options.maxFileSizeBytes
      });
      if (safeFile.fileSha256 !== batch.fileSha256) {
        throw badRequest('当前原文件 SHA-256 与 preview 批次不一致。', {
          code: 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH'
        });
      }
      const recomputedDomainPreview = descriptor.buildPreview({
        db: databaseContext.db,
        buffer: safeFile.buffer,
        originalFilename: batch.originalFilename,
        fileSha256: safeFile.fileSha256,
        fileSizeBytes: safeFile.sizeBytes,
        template,
        options
      });
      const recomputedPreview = securePreviewResult(recomputedDomainPreview, {
        template,
        fileSha256: safeFile.fileSha256,
        secret
      });
      const authorization = authorizePersistedBatchExecute(body, batch, recomputedPreview, safeFile.buffer, secret);
      if (!authorization.valid) throwAuthorizationFailure(authorization);
      if (Number(authorization.expectedWouldImport || 0) <= 0) throwAuthorizationFailure(authorization);

      const createBackup = typeof options.createBackup === 'function'
        ? options.createBackup
        : backupService.createBackup;
      let transactionActive = false;
      try {
        failureStage = 'lock';
        // RESERVED 写锁从锁内重算前一直保持到审计和业务写入提交，阻止备份后插入前出现并发提交窗口。
        databaseContext.db.exec('BEGIN IMMEDIATE');
        transactionActive = true;

        const latestBatch = getImportAuditBatchDetail(batchId, { db: databaseContext.db, includeIssues: false });
        const latestDomainPreview = descriptor.buildPreview({
          db: databaseContext.db,
          buffer: safeFile.buffer,
          originalFilename: latestBatch.originalFilename,
          fileSha256: safeFile.fileSha256,
          fileSizeBytes: safeFile.sizeBytes,
          template,
          options
        });
        const latestPreview = securePreviewResult(latestDomainPreview, {
          template,
          fileSha256: safeFile.fileSha256,
          secret
        });
        const latestAuthorization = authorizePersistedBatchExecute(body, latestBatch, latestPreview, safeFile.buffer, secret);
        if (!latestAuthorization.valid) throwAuthorizationFailure(latestAuthorization);
        if (Number(latestAuthorization.expectedWouldImport || 0) <= 0) throwAuthorizationFailure(latestAuthorization);

        failureStage = 'backup';
        // 只有已经进入真实备份阶段的失败才写 execute failed；锁内重算和 stale 仍保留 preview 可重试。
        if (trustedPersistedBatch) trustedFailureAuditBatchId = batchId;
        // 独立读连接在线备份锁前已提交快照；跳过会与当前 RESERVED 锁冲突的 checkpoint。
        backup = await createBackup({
          reason: template.backupReason,
          skipCheckpoint: true
        });

        failureStage = 'write';
        const insertion = descriptor.insertCandidates({
          db: databaseContext.db,
          batchId,
          candidateRows: latestPreview.candidateRows,
          preview: latestPreview,
          options
        });
        const imported = Number(insertion.imported ?? latestPreview.candidateRows.length);
        const summary = latestPreview.summary || {};
        const safeBackup = projectSafeBackupSummary(backup);
        const executeResult = {
          executed: true,
          writesBusinessRecords: true,
          templateType: template.templateType,
          operation: template.operation,
          recordKind: template.recordKind,
          importTypes: [...template.importTypes],
          imported,
          skipped: Number(summary.skipped || 0),
          blocked: Number(summary.blocked || 0),
          warnings: Number(summary.warnings || 0),
          errors: Number(summary.errors || 0),
          expectedWouldImport: latestPreview.candidateRows.length,
          candidateRowIds: latestPreview.candidateRowIds,
          candidateRows: latestPreview.candidateRows,
          previewSignature: latestPreview.previewSignature,
          previewAuditDigest: latestPreview.previewAuditDigest,
          previewAudit: latestPreview.previewAudit,
          importedIds: insertion.importedIds || [],
          importedItems: insertion.importedItems || [],
          backup: safeBackup
        };
        const auditBatch = updateExecuteAuditResult(batchId, {
          status: Number(summary.blocked || 0) > 0 || Number(summary.skipped || 0) > 0
            ? 'completed_with_errors'
            : 'completed',
          statistics: {
            totalRows: Number(summary.totalRows || 0),
            successCount: imported,
            failureCount: Number(summary.blocked || 0),
            skippedCount: Number(summary.skipped || 0)
          },
          executeResult,
          backup,
          errorSummary: buildPreviewErrorSummary(summary, descriptor.domainName)
        }, { db: databaseContext.db });
        const result = {
          ...executeResult,
          persistsImportBatch: true,
          batchId,
          auditBatch: getImportAuditSummary(auditBatch.id, { db: databaseContext.db })
        };
        if (options.demoContext) {
          markDemoContextExecutedInTransaction({
            db: databaseContext.db,
            ...options.demoContext,
            uploadFileSha256: safeFile.fileSha256,
            previewDigest: latestPreview.previewAuditDigest,
            batchBindings: [{ batchId, batchRole: 'primary' }]
          });
        }
        databaseContext.db.exec('COMMIT');
        transactionActive = false;
        return result;
      } catch (error) {
        if (transactionActive) {
          try {
            databaseContext.db.exec('ROLLBACK');
          } catch (_rollbackError) {
            // 回滚异常不得替代原始失败，外层会统一包装为安全领域错误。
          }
          transactionActive = false;
        }
        throw error;
      }
    } finally {
      if (databaseContext.shouldClose) databaseContext.db.close();
    }
  } catch (error) {
    const safeError = normalizeSafeExecuteError(error, failureStage, descriptor?.domainName);
    if (trustedFailureAuditBatchId !== null) {
      markEnergyAnalysisSingleBatchFailure(trustedFailureAuditBatchId, descriptor || {}, safeError, options, backup);
    }
    throw safeError;
  }
}

module.exports = {
  SINGLE_BATCH_IMPORT_SERVICE_VERSION,
  buildPersistedBatchBinding,
  buildPersistedSingleBatchExecuteBody,
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport,
  markEnergyAnalysisSingleBatchFailure,
  normalizeBatchId,
  securePreviewResult
};
