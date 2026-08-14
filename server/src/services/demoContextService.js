'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { openDatabase } = require('../db/database');
const { getUserPermissions, isSuperAdmin } = require('./authService');
const { requireDemoArtifactHandler } = require('./demoArtifactRegistry');
const { parseEnergyAnalysisTemplateBuffer } = require('./energyAnalysisTemplateService');
const { assertDemoRuntimeEnabled, requireDemoDatasetRun } = require('./demoRunService');
const { AppError, badRequest } = require('../utils/errors');

const DEMO_CONTEXT_TOKEN_BYTES = 32;
const DEMO_CONTEXT_TOKEN_LENGTH = 43;
const DEFAULT_DEMO_CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_DEMO_CONTEXT_TTL_MS = 8 * 60 * 60 * 1000;
const DEMO_CONTEXT_REASSOCIATE_GRACE_MS = 15 * 60 * 1000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PREVIEW_AUDIT_DIGEST_PATTERN = /^hmac-sha256:v1:audit:[a-f0-9]{64}$/;
// 重新关联预检见证仅以当前进程内对象身份保存，普通对象、JSON 副本和字符串都无法伪造。
const reassociatePreflightWitnesses = new WeakMap();

/** 生成 32 字节 CSPRNG base64url token，明文长度固定为 43。 */
function createDemoContextToken() {
  const token = crypto.randomBytes(DEMO_CONTEXT_TOKEN_BYTES).toString('base64url');
  if (token.length !== DEMO_CONTEXT_TOKEN_LENGTH) throw new Error('演示 context token 长度异常。');
  return token;
}

/** 将 context token 单向哈希后再存库。 */
function hashDemoContextToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** 计算内存 buffer、文件或已知字节的 SHA-256。 */
function sha256Buffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw badRequest('演示 artifact 内容必须为 Buffer。', { code: 'INVALID_DEMO_ARTIFACT_BUFFER' });
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 计算受控上传文件 SHA-256，不读取请求正文中的伪造摘要。 */
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 严格校验 context token 格式，禁止容忍 padding、空白或其他编码。 */
function validateDemoContextToken(token) {
  if (typeof token !== 'string' || token.length !== DEMO_CONTEXT_TOKEN_LENGTH || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new AppError('DEMO_CONTEXT_TOKEN_INVALID', '演示 context token 格式无效。', { statusCode: 400 });
  }
  return token;
}

/** 严格校验 SHA-256 十六进制摘要。 */
function validateSha256(value, fieldName) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw badRequest(`${fieldName} 必须为 SHA-256 十六进制摘要。`, { code: 'INVALID_DEMO_CONTEXT_DIGEST', fieldName });
  }
  return normalized;
}

/** 严格校验带域和版本的预演审计摘要，禁止归一化或截断。 */
function validatePreviewAuditDigest(value, fieldName = 'previewDigest') {
  if (typeof value !== 'string' || !PREVIEW_AUDIT_DIGEST_PATTERN.test(value)) {
    throw badRequest(`${fieldName} 必须为完整的预演审计摘要。`, {
      code: 'INVALID_DEMO_CONTEXT_PREVIEW_DIGEST',
      fieldName
    });
  }
  return value;
}

/** 解析 TTL 并限制在 1 秒到 8 小时。 */
function resolveContextTtlMs(value) {
  if (value === undefined) return DEFAULT_DEMO_CONTEXT_TTL_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1000 || value > MAX_DEMO_CONTEXT_TTL_MS) {
    throw badRequest('演示 context TTL 无效。', { code: 'INVALID_DEMO_CONTEXT_TTL' });
  }
  return value;
}

/** 判断用户是否具有真实领域权限；超级管理员权限兜底不影响独立 runtime 开关。 */
function assertDemoDomainPermission(userId, permission, options = {}) {
  if (!permission) throw new AppError('DEMO_PERMISSION_CONTRACT_INVALID', '演示 artifact 未声明所需领域权限。', { statusCode: 500 });
  const db = options.db;
  const superAdmin = db
    ? Boolean(db.prepare(`SELECT 1 FROM sys_user_roles ur JOIN sys_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.role_code = 'super_admin' AND r.status = 'active'`).get(userId))
    : isSuperAdmin(userId);
  if (superAdmin) return;
  const permissions = db
    ? db.prepare(`SELECT DISTINCT m.permission_code AS permissionCode
      FROM sys_menus m
      JOIN sys_role_menus rm ON rm.menu_id = m.id
      JOIN sys_user_roles ur ON ur.role_id = rm.role_id
      JOIN sys_roles r ON r.id = ur.role_id
      JOIN sys_users u ON u.id = ur.user_id
      WHERE ur.user_id = ? AND u.status = 'active' AND r.status = 'active'
        AND m.status = 'active' AND m.permission_code IS NOT NULL`).all(userId).map((row) => row.permissionCode)
    : getUserPermissions(userId);
  if (!new Set(permissions).has(permission)) {
    throw new AppError('FORBIDDEN', '当前账号没有执行该演示数据操作的领域权限。', {
      statusCode: 403,
      details: { requiredPermissions: [permission], mode: 'all' }
    });
  }
}

/** 将 context 数据库行映射为内部稳定结构，不包含 token 明文。 */
function mapContextRow(row) {
  if (!row) return null;
  return {
    contextId: row.contextId,
    runId: row.runId,
    datasetId: row.datasetId,
    manifestVersion: row.manifestVersion,
    manifestDigest: row.manifestDigest,
    artifactKey: row.artifactKey,
    handlerKey: row.handlerKey,
    artifactFileSha256: row.artifactFileSha256,
    issuedToUserId: row.issuedToUserId,
    runtimeEpoch: row.runtimeEpoch,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    uploadFileSha256: row.uploadFileSha256,
    previewDigest: row.previewDigest,
    previewedAt: row.previewedAt,
    executedAt: row.executedAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    reassociatedFromContextId: row.reassociatedFromContextId,
    replacementContextId: row.replacementContextId,
    reassociatedAt: row.reassociatedAt
  };
}

/** 读取 token hash 对应 context；查询不返回 token_hash，防止后续错误对象意外携带。 */
function readContextByTokenHash(db, tokenHash) {
  return mapContextRow(db.prepare(`SELECT context_id AS contextId, run_id AS runId,
      dataset_id AS datasetId, manifest_version AS manifestVersion,
      manifest_digest AS manifestDigest, artifact_key AS artifactKey,
      handler_key AS handlerKey, artifact_file_sha256 AS artifactFileSha256,
      issued_to_user_id AS issuedToUserId, runtime_epoch AS runtimeEpoch,
      status, issued_at AS issuedAt, expires_at AS expiresAt,
      upload_file_sha256 AS uploadFileSha256, preview_digest AS previewDigest,
      previewed_at AS previewedAt, executed_at AS executedAt,
      revoked_at AS revokedAt, revoke_reason AS revokeReason,
      reassociated_from_context_id AS reassociatedFromContextId,
      replacement_context_id AS replacementContextId,
      reassociated_at AS reassociatedAt
    FROM demo_import_contexts WHERE token_hash = ?`).get(tokenHash));
}

/** 创建绑定当前 runtime epoch、run、artifact、handler、user 和下载文件摘要的 context。 */
function createDemoContext(input = {}) {
  const userId = input.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw badRequest('演示 context 用户主键无效。', { code: 'INVALID_DEMO_CONTEXT_USER_ID' });
  }
  const artifact = requireDemoArtifactHandler(input.artifactKey, input.handlerKey);
  assertDemoDomainPermission(userId, artifact.permissions.download, { db: input.db });
  const artifactFileSha256 = validateSha256(input.artifactFileSha256, 'artifactFileSha256');
  const ttlMs = resolveContextTtlMs(input.ttlMs);
  const token = createDemoContextToken();
  const tokenHash = hashDemoContextToken(token);
  const contextId = `demo-context-${crypto.randomUUID()}`;
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const runtime = assertDemoRuntimeEnabled({ db });
    const run = requireDemoDatasetRun(db, input.runId);
    db.prepare(`INSERT INTO demo_import_contexts
      (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
        artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
        status, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
      contextId,
      tokenHash,
      run.runId,
      run.datasetId,
      run.manifestVersion,
      run.manifestDigest,
      artifact.artifactKey,
      artifact.handlerKey,
      artifactFileSha256,
      userId,
      runtime.runtimeEpoch,
      issuedAt,
      expiresAt
    );
    return {
      token,
      contextId,
      runId: run.runId,
      datasetId: run.datasetId,
      manifestVersion: run.manifestVersion,
      manifestDigest: run.manifestDigest,
      artifactKey: artifact.artifactKey,
      handlerKey: artifact.handlerKey,
      artifactFileSha256,
      issuedAt,
      expiresAt,
      runtimeEpoch: runtime.runtimeEpoch
    };
  } finally {
    if (ownedDb) db.close();
  }
}

/** 原子撤销 context；token 明文只参与哈希，不写日志、审计或错误 details。 */
function revokeDemoContext(input = {}) {
  const tokenHash = hashDemoContextToken(validateDemoContextToken(input.token));
  const reason = String(input.reason || 'explicit_revoke').trim();
  if (!reason || reason.length > 128) throw badRequest('演示 context 撤销原因无效。', { code: 'INVALID_DEMO_CONTEXT_REVOKE_REASON' });
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const revokedAt = new Date().toISOString();
    const result = db.prepare(`UPDATE demo_import_contexts
      SET status = 'revoked', revoked_at = ?, revoke_reason = ?
      WHERE token_hash = ? AND status IN ('issued', 'previewed')`).run(revokedAt, reason, tokenHash);
    return { revoked: result.changes > 0, revokedAt: result.changes > 0 ? revokedAt : null };
  } finally {
    if (ownedDb) db.close();
  }
}

/** 校验过期 context 是否可进入受控上传重新关联，旧 token 仅作为关联句柄。 */
function validateDemoContextReassociateCandidate(input = {}) {
  const token = validateDemoContextToken(input.token);
  const userId = input.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError('UNAUTHENTICATED', '请先登录。', { statusCode: 401 });
  }
  const artifact = requireDemoArtifactHandler(input.artifactKey, input.handlerKey);
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    const runtime = assertDemoRuntimeEnabled({ db });
    assertDemoDomainPermission(userId, artifact.permissions.download, { db });
    const current = readContextByTokenHash(db, hashDemoContextToken(token));
    if (!current) throw new AppError('DEMO_CONTEXT_NOT_FOUND', '演示 context 不存在。', { statusCode: 409 });
    if (current.issuedToUserId !== userId) {
      throw new AppError('DEMO_CONTEXT_REASSOCIATE_USER_MISMATCH', '演示 context 只能由原用户重新关联。', { statusCode: 403 });
    }
    const expiryMs = Date.parse(current.expiresAt);
    const nowMs = Date.now();
    const eligibleStatus = current.status === 'issued'
      || (current.status === 'expired' && current.revokeReason === 'ttl_expired');
    const bindingMatchesRequest = current.artifactKey === artifact.artifactKey
      && current.handlerKey === artifact.handlerKey;
    if (!eligibleStatus || !bindingMatchesRequest
      || current.runtimeEpoch !== runtime.runtimeEpoch
      || !Number.isFinite(expiryMs) || expiryMs > nowMs
      || nowMs - expiryMs > DEMO_CONTEXT_REASSOCIATE_GRACE_MS) {
      throw new AppError('DEMO_CONTEXT_REASSOCIATE_INVALID', '演示 context 不满足受控过期宽限期重新关联条件。', { statusCode: 410 });
    }
    const run = requireDemoDatasetRun(db, current.runId);
    if (current.datasetId !== run.datasetId
      || current.manifestVersion !== run.manifestVersion
      || current.manifestDigest !== run.manifestDigest) {
      throw new AppError('DEMO_CONTEXT_REASSOCIATE_BINDING_MISMATCH', '演示 context 的运行或清单绑定已变化。', { statusCode: 409 });
    }
    return current;
  } finally {
    if (ownedDb) db.close();
  }
}

/** 校验中央导入重新关联文件仍符合原 artifact 的模板结构，并签发一次性进程内见证。 */
function validateDemoContextReassociateUpload(input = {}) {
  const artifact = requireDemoArtifactHandler(input.artifactKey, input.handlerKey);
  if (!input.filePath || !input.originalFilename) {
    throw badRequest('重新关联文件预检参数不完整。', { code: 'DEMO_CONTEXT_REASSOCIATE_FILE_REQUIRED' });
  }
  if (artifact.blocker.previewExecuteContext) {
    throw new AppError('DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED', '该导入能力尚未接入演示 context。', { statusCode: 409 });
  }
  let validatedFileBuffer;
  let parsed;
  try {
    validatedFileBuffer = Buffer.from(fs.readFileSync(input.filePath));
    parsed = parseEnergyAnalysisTemplateBuffer(
      artifact.templateType,
      validatedFileBuffer,
      input.originalFilename
    );
  } catch (_error) {
    throw new AppError('DEMO_CONTEXT_REASSOCIATE_FILE_INVALID', '重新关联文件不符合原 artifact 模板结构。', { statusCode: 400 });
  }
  if (!parsed.valid) {
    throw new AppError('DEMO_CONTEXT_REASSOCIATE_FILE_INVALID', '重新关联文件不符合原 artifact 模板结构。', { statusCode: 400 });
  }
  // 私有副本同时作为结构校验与摘要计算的唯一字节快照，避免调用方在预检后替换同路径文件。
  const uploadFileSha256 = sha256Buffer(validatedFileBuffer);
  const witness = Object.freeze({});
  reassociatePreflightWitnesses.set(witness, {
    artifactKey: artifact.artifactKey,
    handlerKey: artifact.handlerKey,
    filePath: input.filePath,
    originalFilename: input.originalFilename,
    validatedFileBuffer,
    uploadFileSha256,
    inUse: false
  });
  return {
    parsed,
    valid: parsed.valid,
    uploadFileSha256,
    witness
  };
}

/** 读取并校验当前进程签发的一次性预检见证，拒绝普通对象和绑定错配。 */
function requireReassociatePreflightWitness(input, artifact) {
  const witnessRecord = input.preflightWitness && typeof input.preflightWitness === 'object'
    ? reassociatePreflightWitnesses.get(input.preflightWitness)
    : null;
  if (!witnessRecord) {
    throw new AppError(
      'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED',
      '演示 context 重新关联必须通过受控文件预检接口。',
      { statusCode: 409 }
    );
  }
  if (witnessRecord.artifactKey !== artifact.artifactKey
    || witnessRecord.handlerKey !== artifact.handlerKey) {
    throw new AppError(
      'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_MISMATCH',
      '演示 context 重新关联预检见证与请求绑定不一致。',
      { statusCode: 409 }
    );
  }
  return witnessRecord;
}

/** 最终消费见证前重读受控路径，并以同一字节重新验证模板结构和摘要。 */
function revalidateReassociatePreflightFile(witnessRecord, artifact) {
  let currentFileBuffer;
  let parsed;
  try {
    currentFileBuffer = fs.readFileSync(witnessRecord.filePath);
    parsed = parseEnergyAnalysisTemplateBuffer(
      artifact.templateType,
      currentFileBuffer,
      witnessRecord.originalFilename
    );
  } catch (_error) {
    throw new AppError(
      'DEMO_CONTEXT_REASSOCIATE_FILE_CHANGED',
      '重新关联文件在预检后已变化或失效。',
      { statusCode: 409 }
    );
  }
  if (!parsed.valid
    || !Buffer.isBuffer(witnessRecord.validatedFileBuffer)
    || !currentFileBuffer.equals(witnessRecord.validatedFileBuffer)
    || sha256Buffer(currentFileBuffer) !== witnessRecord.uploadFileSha256) {
    throw new AppError(
      'DEMO_CONTEXT_REASSOCIATE_FILE_CHANGED',
      '重新关联文件在预检后已变化或失效。',
      { statusCode: 409 }
    );
  }
  return witnessRecord.uploadFileSha256;
}

/** 受控上传预检后消费旧 token，并仅为原用户和原始全部绑定重新签发 token。 */
function reassociateDemoContext(input = {}) {
  const token = validateDemoContextToken(input.token);
  const tokenHash = hashDemoContextToken(token);
  const userId = input.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError('UNAUTHENTICATED', '请先登录。', { statusCode: 401 });
  }
  const artifact = requireDemoArtifactHandler(input.artifactKey, input.handlerKey);
  const witnessRecord = requireReassociatePreflightWitness(input, artifact);
  if (witnessRecord.inUse) {
    throw new AppError('DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_CONFLICT', '演示 context 重新关联预检见证正在使用或已消费。', { statusCode: 409 });
  }
  witnessRecord.inUse = true;
  let ownedDb = false;
  let db = null;
  let replacement;
  let completed = false;
  try {
    const uploadFileSha256 = revalidateReassociatePreflightFile(witnessRecord, artifact);
    const providedDb = input.db;
    ownedDb = !providedDb;
    db = providedDb || openDatabase();
    const execute = db.transaction(() => {
      const runtime = assertDemoRuntimeEnabled({ db });
      assertDemoDomainPermission(userId, artifact.permissions.download, { db });
      const current = readContextByTokenHash(db, tokenHash);
      if (!current) throw new AppError('DEMO_CONTEXT_NOT_FOUND', '演示 context 不存在。', { statusCode: 409 });
      if (current.issuedToUserId !== userId) {
        throw new AppError('DEMO_CONTEXT_REASSOCIATE_USER_MISMATCH', '演示 context 只能由原用户重新关联。', { statusCode: 403 });
      }
      const expiryMs = Date.parse(current.expiresAt);
      const nowMs = Date.now();
      const eligibleStatus = current.status === 'issued'
        || (current.status === 'expired' && current.revokeReason === 'ttl_expired');
      const requestBindingsMatch = current.artifactKey === artifact.artifactKey
        && current.handlerKey === artifact.handlerKey;
      if (!eligibleStatus
        || !requestBindingsMatch
        || current.replacementContextId !== null
        || current.runtimeEpoch !== runtime.runtimeEpoch
        || !Number.isFinite(expiryMs)
        || expiryMs > nowMs
        || nowMs - expiryMs > DEMO_CONTEXT_REASSOCIATE_GRACE_MS) {
        throw new AppError('DEMO_CONTEXT_REASSOCIATE_INVALID', '演示 context 不满足受控过期宽限期重新关联条件。', { statusCode: 410 });
      }
      const run = requireDemoDatasetRun(db, current.runId);
      const bindingsMatch = current.datasetId === run.datasetId
        && current.manifestVersion === run.manifestVersion
        && current.manifestDigest === run.manifestDigest;
      if (!bindingsMatch) {
        throw new AppError('DEMO_CONTEXT_REASSOCIATE_BINDING_MISMATCH', '演示 context 的运行或清单绑定已变化。', { statusCode: 409 });
      }
      const reassociatedAt = new Date().toISOString();
      const createdReplacement = createDemoContext({
        db,
        userId,
        runId: current.runId,
        artifactKey: artifact.artifactKey,
        handlerKey: artifact.handlerKey,
        artifactFileSha256: current.artifactFileSha256,
        ttlMs: input.ttlMs
      });
      db.prepare(`UPDATE demo_import_contexts
        SET upload_file_sha256 = ?, reassociated_from_context_id = ?, reassociated_at = ?
        WHERE context_id = ? AND status = 'issued'`)
        .run(uploadFileSha256, current.contextId, reassociatedAt, createdReplacement.contextId);
      const revoked = db.prepare(`UPDATE demo_import_contexts
        SET status = 'revoked', revoked_at = ?, revoke_reason = 'reassociated',
          replacement_context_id = ?, reassociated_at = ?
        WHERE token_hash = ? AND issued_to_user_id = ? AND status = ?
          AND runtime_epoch = ? AND expires_at = ? AND run_id = ? AND dataset_id = ?
          AND manifest_version = ? AND manifest_digest = ? AND artifact_key = ? AND handler_key = ?
          AND replacement_context_id IS NULL`).run(
        reassociatedAt,
        createdReplacement.contextId,
        reassociatedAt,
        tokenHash,
        userId,
        current.status,
        runtime.runtimeEpoch,
        current.expiresAt,
        current.runId,
        current.datasetId,
        current.manifestVersion,
        current.manifestDigest,
        artifact.artifactKey,
        artifact.handlerKey
      );
      if (revoked.changes !== 1) {
        throw new AppError('DEMO_CONTEXT_STATE_CONFLICT', '演示 context 状态已变化。', { statusCode: 409 });
      }
      return { ...createdReplacement, uploadFileSha256 };
    });
    replacement = execute.immediate();
    completed = true;
    reassociatePreflightWitnesses.delete(input.preflightWitness);
    return replacement;
  } finally {
    if (!completed && reassociatePreflightWitnesses.get(input.preflightWitness) === witnessRecord) {
      witnessRecord.inUse = false;
    }
    if (ownedDb && db) db.close();
  }
}

/** 校验请求 context 的全部绑定；任何失败都抛错，调用方不得降级为正式导入。 */
function validateDemoContext(input = {}) {
  const token = validateDemoContextToken(input.token);
  const userId = input.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 1) {
    throw new AppError('UNAUTHENTICATED', '请先登录。', { statusCode: 401 });
  }
  const artifact = requireDemoArtifactHandler(input.artifactKey, input.handlerKey);
  const phase = String(input.phase || 'execute').trim();
  if (!['preview', 'execute'].includes(phase)) throw badRequest('演示 context 校验阶段无效。', { code: 'INVALID_DEMO_CONTEXT_PHASE' });
  const tokenHash = hashDemoContextToken(token);
  const ownedDb = !input.db;
  const db = input.db || openDatabase();
  try {
    assertDemoDomainPermission(userId, artifact.permissions[phase], { db });
    const runtime = assertDemoRuntimeEnabled({ db });
    const context = readContextByTokenHash(db, tokenHash);
    if (!context) throw new AppError('DEMO_CONTEXT_NOT_FOUND', '演示 context 不存在或已失效。', { statusCode: 409 });
    const nowMs = Date.now();
    const expiryMs = Date.parse(context.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) {
      const revokedAt = new Date(nowMs).toISOString();
      db.prepare(`UPDATE demo_import_contexts SET status = 'expired', revoked_at = ?, revoke_reason = 'ttl_expired'
        WHERE context_id = ? AND status IN ('issued', 'previewed')`).run(revokedAt, context.contextId);
      throw new AppError('DEMO_CONTEXT_EXPIRED', '演示 context 已过期。', { statusCode: 410 });
    }
    const run = requireDemoDatasetRun(db, context.runId);
    const allowedStatuses = phase === 'preview' ? ['issued'] : ['previewed'];
    const valid = context.issuedToUserId === userId
      && context.artifactKey === artifact.artifactKey
      && context.handlerKey === artifact.handlerKey
      && context.runtimeEpoch === runtime.runtimeEpoch
      && context.datasetId === run.datasetId
      && context.manifestVersion === run.manifestVersion
      && context.manifestDigest === run.manifestDigest
      && allowedStatuses.includes(context.status);
    if (!valid) {
      throw new AppError('DEMO_CONTEXT_BINDING_MISMATCH', '演示 context 与当前请求绑定不一致。', {
        statusCode: 409,
        details: { artifactKey: artifact.artifactKey, phase }
      });
    }
    if (phase === 'preview' && input.uploadFileSha256) {
      const uploadFileSha256 = validateSha256(input.uploadFileSha256, 'uploadFileSha256');
      if (context.uploadFileSha256 && context.uploadFileSha256 !== uploadFileSha256) {
        throw new AppError('DEMO_CONTEXT_REASSOCIATED_FILE_MISMATCH', '上传文件与重新关联预绑定文件摘要不一致。', {
          statusCode: 409,
          details: { artifactKey: artifact.artifactKey }
        });
      }
    }
    if (phase === 'execute') {
      const previewDigest = validatePreviewAuditDigest(input.previewDigest);
      const uploadFileSha256 = validateSha256(input.uploadFileSha256, 'uploadFileSha256');
      if (previewDigest !== context.previewDigest || uploadFileSha256 !== context.uploadFileSha256) {
        throw new AppError('DEMO_CONTEXT_PREVIEW_MISMATCH', '执行请求与已绑定预演摘要或文件摘要不一致。', {
          statusCode: 409,
          details: { artifactKey: artifact.artifactKey }
        });
      }
    }
    return context;
  } finally {
    if (ownedDb) db.close();
  }
}

/** 校验调用者提供了同一 SQLite 写事务连接。 */
function requireTransactionDatabase(input = {}) {
  if (!input.db || input.db.inTransaction !== true) {
    throw new AppError('DEMO_CONTEXT_TRANSACTION_REQUIRED', '演示 context 状态转换必须位于现有 SQLite 事务中。', { statusCode: 500 });
  }
  return input.db;
}

/** 在调用者持有的同一写事务内绑定 preview，并登记本轮批次角色。 */
function bindDemoContextPreviewInTransaction(input = {}) {
  const db = requireTransactionDatabase(input);
  const context = validateDemoContext({ ...input, phase: 'preview', db });
  const uploadFileSha256 = validateSha256(input.uploadFileSha256, 'uploadFileSha256');
  const previewDigest = validatePreviewAuditDigest(input.previewDigest);
  const previewedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE demo_import_contexts
    SET status = 'previewed', upload_file_sha256 = ?, preview_digest = ?, previewed_at = ?
    WHERE context_id = ? AND issued_to_user_id = ? AND status = 'issued'
      AND runtime_epoch = ? AND expires_at = ? AND run_id = ? AND dataset_id = ?
      AND manifest_version = ? AND manifest_digest = ? AND artifact_key = ? AND handler_key = ?`).run(
    uploadFileSha256,
    previewDigest,
    previewedAt,
    context.contextId,
    context.issuedToUserId,
    context.runtimeEpoch,
    context.expiresAt,
    context.runId,
    context.datasetId,
    context.manifestVersion,
    context.manifestDigest,
    context.artifactKey,
    context.handlerKey
  );
  if (result.changes !== 1) throw new AppError('DEMO_CONTEXT_STATE_CONFLICT', '演示 context 状态已变化。', { statusCode: 409 });
  const batchBindings = Array.isArray(input.batchBindings) ? input.batchBindings : [];
  const insertBinding = db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, ?, ?, ?, ?)`);
  batchBindings.forEach((binding) => {
    const batchId = Number(binding.batchId);
    const batchRole = String(binding.batchRole || '').trim();
    if (!Number.isSafeInteger(batchId) || batchId < 1 || !batchRole || batchRole.length > 64) {
      throw new AppError('DEMO_CONTEXT_BATCH_BINDING_INVALID', '演示预演批次绑定无效。', { statusCode: 500 });
    }
    insertBinding.run(context.runId, context.artifactKey, context.contextId, batchId, batchRole);
  });
  return { ...context, status: 'previewed', uploadFileSha256, previewDigest, previewedAt };
}

/** preview 成功后原子绑定 retained upload SHA 和服务端 preview digest。 */
function bindDemoContextPreview(input = {}) {
  if (input.db) {
    return bindDemoContextPreviewInTransaction(input);
  }
  const db = openDatabase();
  try {
    return db.transaction(() => bindDemoContextPreviewInTransaction({ ...input, db })).immediate();
  } finally {
    db.close();
  }
}

/** 在调用者持有的同一写事务内消费 previewed context。 */
function markDemoContextExecutedInTransaction(input = {}) {
  const db = requireTransactionDatabase(input);
  const context = validateDemoContext({ ...input, phase: 'execute', db });
  const expectedBindings = Array.isArray(input.batchBindings) ? input.batchBindings : [];
  const persistedBindings = db.prepare(`SELECT import_batch_id AS batchId, batch_role AS batchRole
    FROM demo_run_import_batches WHERE context_id = ? ORDER BY batch_role, import_batch_id`).all(context.contextId);
  const normalizeBinding = (binding) => `${String(binding.batchRole || '').trim()}\0${Number(binding.batchId)}`;
  const expected = expectedBindings.map(normalizeBinding).sort();
  const actual = persistedBindings.map(normalizeBinding).sort();
  if (expected.length !== actual.length || expected.some((binding, index) => binding !== actual[index])) {
    throw new AppError('DEMO_CONTEXT_BATCH_BINDING_MISMATCH', '演示执行批次角色与预演绑定不一致。', { statusCode: 409 });
  }
  const executedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE demo_import_contexts SET status = 'executed', executed_at = ?
    WHERE context_id = ? AND issued_to_user_id = ? AND status = 'previewed'
      AND runtime_epoch = ? AND expires_at = ? AND upload_file_sha256 = ? AND preview_digest = ?`).run(
    executedAt,
    context.contextId,
    context.issuedToUserId,
    context.runtimeEpoch,
    context.expiresAt,
    context.uploadFileSha256,
    context.previewDigest
  );
  if (result.changes !== 1) throw new AppError('DEMO_CONTEXT_STATE_CONFLICT', '演示 context 状态已变化。', { statusCode: 409 });
  return { ...context, status: 'executed', executedAt };
}

/** execute 成功后把 context 标记为一次性已执行。 */
function markDemoContextExecuted(input = {}) {
  if (input.db) {
    return markDemoContextExecutedInTransaction(input);
  }
  const db = openDatabase();
  try {
    return db.transaction(() => markDemoContextExecutedInTransaction({ ...input, db })).immediate();
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_DEMO_CONTEXT_TTL_MS,
  DEMO_CONTEXT_TOKEN_BYTES,
  DEMO_CONTEXT_TOKEN_LENGTH,
  bindDemoContextPreview,
  bindDemoContextPreviewInTransaction,
  createDemoContext,
  createDemoContextToken,
  hashDemoContextToken,
  markDemoContextExecuted,
  markDemoContextExecutedInTransaction,
  reassociateDemoContext,
  revokeDemoContext,
  sha256Buffer,
  sha256File,
  validateDemoContext,
  validateDemoContextReassociateCandidate,
  validateDemoContextReassociateUpload,
  validateDemoContextToken,
  validatePreviewAuditDigest,
  validateSha256
};
