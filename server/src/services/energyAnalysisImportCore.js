'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { badRequest } = require('../utils/errors');

// 能源分析受控导入统一备份原因。
const ENERGY_ANALYSIS_IMPORT_BACKUP_REASON = 'energy-analysis-import';

// 能源分析安装级 HMAC 密钥在 app_meta 中的键名。
const ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY = 'energy_analysis_import_hmac_secret';

// preview 签名协议版本。
const ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION = 'energy-analysis-import-preview:v1';

// preview 签名稳定前缀。
const ENERGY_ANALYSIS_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v1';

// preview 审计摘要独立前缀。
const ENERGY_ANALYSIS_IMPORT_AUDIT_DIGEST_PREFIX = 'hmac-sha256:v1:audit';

// preview 签名域分隔符。
const ENERGY_ANALYSIS_IMPORT_SIGNATURE_DOMAIN = 'energy-analysis-import:preview-signature:v1';

// preview 审计摘要域分隔符。
const ENERGY_ANALYSIS_IMPORT_AUDIT_DOMAIN = 'energy-analysis-import:preview-audit:v1';

// 默认重复数据策略。
const ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY = 'skip';

// 可参与汇总的行状态。
const ENERGY_ANALYSIS_IMPORT_ITEM_STATUSES = Object.freeze(['wouldImport', 'skipped', 'blocked']);

// 可写入统一审计明细的严重级别。
const ENERGY_ANALYSIS_IMPORT_ISSUE_SEVERITIES = Object.freeze(['error', 'warning']);

// execute 只允许绑定已完成 preview 的批次状态。
const ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_STATUSES = Object.freeze(['completed', 'completed_with_errors']);

// execute 前持久化批次必须仍处于 preview 阶段。
const ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_PHASE = 'preview';

// SHA-256 十六进制摘要格式。
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

// preview 签名及审计摘要格式。
const PREVIEW_SIGNATURE_PATTERN = /^hmac-sha256:v1:[a-f0-9]{64}$/;
const PREVIEW_AUDIT_DIGEST_PATTERN = /^hmac-sha256:v1:audit:[a-f0-9]{64}$/;

/**
 * 递归冻结对象，避免模板安全契约在运行时被修改。
 * @param {*} value 待冻结值。
 * @returns {*} 冻结后的原值。
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

// 八个能源分析模板及其受控导入安全契约。
const ENERGY_ANALYSIS_IMPORT_TEMPLATES = deepFreeze([
  {
    id: 'energy-timeseries',
    templateType: 'energy-timeseries',
    operation: 'energy-timeseries-import',
    recordKind: 'energy_timeseries',
    importTypes: ['energy_timeseries'],
    confirmText: '确认导入时序能耗记录',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['energy_timeseries_records']
  },
  {
    id: 'shift-schedules',
    templateType: 'shift-schedules',
    operation: 'shift-schedule-import',
    recordKind: 'shift_schedule',
    importTypes: ['shift_schedule'],
    confirmText: '确认导入排班记录',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['shift_definitions', 'shift_schedule_records']
  },
  {
    id: 'device-states',
    templateType: 'device-states',
    operation: 'device-state-import',
    recordKind: 'device_state',
    importTypes: ['device_state'],
    confirmText: '确认导入设备状态记录',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['device_state_records']
  },
  {
    id: 'energy-conversion-factors',
    templateType: 'energy-conversion-factors',
    operation: 'energy-conversion-factor-import',
    recordKind: 'energy_conversion_factor',
    importTypes: ['energy_conversion_factor'],
    confirmText: '确认导入折标系数',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['energy_conversion_factors']
  },
  {
    id: 'energy-benchmark-definitions',
    templateType: 'energy-benchmark-definitions',
    operation: 'energy-benchmark-standard-import',
    recordKind: 'benchmark_standard',
    importTypes: ['energy_benchmark'],
    confirmText: '确认导入能效对标标准',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['benchmark_definitions']
  },
  {
    id: 'energy-benchmark-targets',
    templateType: 'energy-benchmark-targets',
    operation: 'energy-benchmark-target-import',
    recordKind: 'benchmark_target',
    importTypes: ['energy_benchmark'],
    confirmText: '确认导入能效对标目标',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['benchmark_targets']
  },
  {
    id: 'energy-flow-nodes',
    templateType: 'energy-flow-nodes',
    operation: 'energy-flow-node-import',
    recordKind: 'energy_flow_node',
    importTypes: ['energy_flow_node'],
    confirmText: '确认导入能流节点',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: false,
    targetTables: ['energy_flow_nodes']
  },
  {
    id: 'energy-flow-edges',
    templateType: 'energy-flow-edges',
    operation: 'energy-flow-edge-bundle-import',
    recordKind: 'energy_flow_edge_record_bundle',
    importTypes: ['energy_flow_edge', 'energy_flow_record'],
    confirmText: '确认导入能流边及显式边值',
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    xlsxOnly: true,
    targetTables: ['energy_flow_edges', 'energy_flow_records']
  }
]);

// 按模板 ID 查询的冻结映射。
const ENERGY_ANALYSIS_IMPORT_TEMPLATE_MAP = deepFreeze(ENERGY_ANALYSIS_IMPORT_TEMPLATES.reduce((result, item) => {
  result[item.id] = item;
  return result;
}, {}));

/**
 * 判断值是否为可稳定序列化的普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 构造稳定的校验错误项。
 * @param {string} code 错误码。
 * @param {string} message 错误说明。
 * @param {object} details 附加信息。
 * @returns {object} 校验错误项。
 */
function createValidationError(code, message, details = {}) {
  return { code, message, ...details };
}

/**
 * 构造去重且顺序稳定的纯函数校验结果。
 * @param {object[]} errors 错误列表。
 * @param {object} extra 附加结果。
 * @returns {object} 校验结果。
 */
function createValidationResult(errors, extra = {}) {
  const seenCodes = new Set();
  const stableErrors = errors.filter((error) => {
    const key = `${error.code}\0${JSON.stringify(error)}`;
    if (seenCodes.has(key)) return false;
    seenCodes.add(key);
    return true;
  });
  return { valid: stableErrors.length === 0, errors: stableErrors, ...extra };
}

/**
 * 将值递归转换为稳定、安全且可序列化的结构。
 * @param {*} value 待转换值。
 * @param {WeakSet<object>} ancestors 当前递归祖先集合。
 * @param {string} valuePath 值路径。
 * @returns {*} 规范化值。
 */
function canonicalizeStableValue(value, ancestors = new WeakSet(), valuePath = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw badRequest('稳定序列化拒绝非有限数值。', { code: 'STABLE_SERIALIZE_NON_FINITE_NUMBER', path: valuePath });
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw badRequest('稳定序列化拒绝无效日期。', { code: 'STABLE_SERIALIZE_INVALID_DATE', path: valuePath });
    }
    return value.toISOString();
  }
  if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
    throw badRequest('稳定序列化遇到不支持的值类型。', {
      code: 'STABLE_SERIALIZE_UNSUPPORTED_TYPE',
      path: valuePath,
      valueType: typeof value
    });
  }
  if (ancestors.has(value)) {
    throw badRequest('稳定序列化拒绝循环结构。', { code: 'STABLE_SERIALIZE_CIRCULAR_REFERENCE', path: valuePath });
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw badRequest('稳定序列化仅支持普通对象、数组和有效日期。', {
      code: 'STABLE_SERIALIZE_UNSUPPORTED_OBJECT',
      path: valuePath,
      objectType: value?.constructor?.name || 'unknown'
    });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw badRequest('稳定序列化拒绝 Symbol 键。', { code: 'STABLE_SERIALIZE_SYMBOL_KEY', path: valuePath });
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalizeStableValue(item, ancestors, `${valuePath}[${index}]`));
    }
    return Object.keys(value).sort().reduce((result, key) => {
      Object.defineProperty(result, key, {
        value: canonicalizeStableValue(value[key], ancestors, `${valuePath}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true
      });
      return result;
    }, {});
  } finally {
    ancestors.delete(value);
  }
}

/**
 * 按对象键排序、数组原顺序生成稳定 JSON。
 * @param {*} value 待序列化值。
 * @returns {string} 稳定 JSON。
 */
function stableSerialize(value) {
  return JSON.stringify(canonicalizeStableValue(value));
}

/**
 * 读取非空秘密文本，兼容 app_meta 行对象。
 * @param {*} value 原始秘密值。
 * @returns {string|null} 规范化秘密。
 */
function normalizeSecretText(value) {
  const rawValue = isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
  if (typeof rawValue !== 'string') return null;
  const normalized = rawValue.trim();
  return normalized || null;
}

/**
 * 按环境变量、app_meta、随机持久化顺序解析安装级 HMAC 密钥。
 * @param {object} options 密钥解析依赖。
 * @returns {string} HMAC 密钥。
 */
function resolveEnergyAnalysisImportHmacSecret(options = {}) {
  const environment = options.env || process.env;
  const environmentSecret = normalizeSecretText(environment.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET)
    || normalizeSecretText(environment.CHARCOAL_HMAC_SECRET)
    || normalizeSecretText(environment.APP_SECRET);
  if (environmentSecret) {
    return environmentSecret;
  }

  if (typeof options.readAppMeta === 'function') {
    const storedSecret = options.readAppMeta(ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY);
    if (storedSecret && typeof storedSecret.then === 'function') {
      throw badRequest('readAppMeta 必须是同步安全读取回调。', { code: 'ENERGY_ANALYSIS_HMAC_ASYNC_CALLBACK_UNSUPPORTED' });
    }
    const normalizedStoredSecret = normalizeSecretText(storedSecret);
    if (normalizedStoredSecret) {
      return normalizedStoredSecret;
    }
  }

  if (typeof options.persistAppMeta !== 'function') {
    throw badRequest('未配置能源分析导入 HMAC 密钥，且未提供安全持久化回调。', {
      code: 'ENERGY_ANALYSIS_HMAC_SECRET_PERSISTENCE_REQUIRED',
      metaKey: ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY
    });
  }

  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const generatedBytes = randomBytes(32);
  if (!(Buffer.isBuffer(generatedBytes) || generatedBytes instanceof Uint8Array) || generatedBytes.length !== 32) {
    throw badRequest('安全随机源必须返回 32 字节。', { code: 'ENERGY_ANALYSIS_HMAC_RANDOM_BYTES_INVALID' });
  }
  const generatedSecret = Buffer.from(generatedBytes).toString('hex');
  const persistedValue = options.persistAppMeta(ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY, generatedSecret);
  if (persistedValue && typeof persistedValue.then === 'function') {
    throw badRequest('persistAppMeta 必须是同步安全持久化回调。', { code: 'ENERGY_ANALYSIS_HMAC_ASYNC_CALLBACK_UNSUPPORTED' });
  }
  const persistedSecret = normalizeSecretText(persistedValue);
  if (persistedSecret) {
    return persistedSecret;
  }
  if (typeof options.readAppMeta === 'function') {
    const savedValue = options.readAppMeta(ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY);
    if (savedValue && typeof savedValue.then === 'function') {
      throw badRequest('readAppMeta 必须是同步安全读取回调。', { code: 'ENERGY_ANALYSIS_HMAC_ASYNC_CALLBACK_UNSUPPORTED' });
    }
    const savedSecret = normalizeSecretText(savedValue);
    if (savedSecret) return savedSecret;
  }
  throw badRequest('能源分析导入 HMAC 密钥未能安全持久化。', {
    code: 'ENERGY_ANALYSIS_IMPORT_SECRET_PERSIST_FAILED',
    metaKey: ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY
  });
}

/**
 * 获取指定模板的冻结导入契约。
 * @param {*} templateType 模板 ID。
 * @returns {object} 模板契约。
 */
function getEnergyAnalysisImportTemplate(templateType) {
  const normalized = String(templateType || '').trim();
  const template = ENERGY_ANALYSIS_IMPORT_TEMPLATE_MAP[normalized];
  if (!template) {
    throw badRequest('能源分析导入模板不受支持。', {
      code: 'ENERGY_ANALYSIS_IMPORT_TEMPLATE_UNSUPPORTED',
      templateType,
      supportedTemplateTypes: ENERGY_ANALYSIS_IMPORT_TEMPLATES.map((item) => item.id)
    });
  }
  return template;
}

/**
 * 比较两个字符串并使用 timingSafeEqual 完成等长内容校验。
 * @param {*} actual 实际文本。
 * @param {*} expected 预期文本。
 * @returns {boolean} 是否一致。
 */
function timingSafeEqualText(actual, expected) {
  const actualBuffer = Buffer.from(typeof actual === 'string' ? actual : '', 'utf8');
  const expectedBuffer = Buffer.from(typeof expected === 'string' ? expected : '', 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * 校验并规范化 SHA-256 摘要。
 * @param {*} value 原始摘要。
 * @returns {string} 小写摘要。
 */
function normalizeSha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw badRequest('fileSha256 必须是 64 位十六进制 SHA-256。', {
      code: 'ENERGY_ANALYSIS_IMPORT_FILE_SHA256_INVALID'
    });
  }
  return normalized;
}

/**
 * 规范化单个候选行 ID。
 * @param {*} value 原始 ID。
 * @param {number} index 候选行索引。
 * @returns {string} 稳定候选行 ID。
 */
function normalizeCandidateRowId(value, index) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw badRequest('候选行缺少稳定 row ID。', {
      code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_ID_REQUIRED',
      index
    });
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw badRequest('数值候选行 ID 必须是正安全整数。', {
      code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_ID_INVALID',
      index
    });
  }
  return String(value).trim();
}

/**
 * 规范化候选行、校验唯一 ID，并按 ID 形成稳定顺序。
 * @param {*} rows 候选行列表。
 * @returns {object[]} 稳定候选行列表。
 */
function normalizeCandidateRows(rows) {
  if (!Array.isArray(rows)) {
    throw badRequest('candidateRows 必须是数组。', { code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_REQUIRED' });
  }
  const seenIds = new Set();
  const normalizedRows = rows.map((row, index) => {
    if (!isPlainObject(row)) {
      throw badRequest('candidateRows 仅允许普通对象。', {
        code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_INVALID',
        index
      });
    }
    const candidateRowId = normalizeCandidateRowId(
      row.candidateRowId ?? row.rowId ?? row.rowNumber,
      index
    );
    if (seenIds.has(candidateRowId)) {
      throw badRequest('candidateRows 的 row ID 必须唯一。', {
        code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_ID_DUPLICATE',
        candidateRowId
      });
    }
    seenIds.add(candidateRowId);
    return canonicalizeStableValue({ ...row, candidateRowId }, new WeakSet(), `$[${index}]`);
  });
  return normalizedRows.sort((left, right) => {
    const idComparison = left.candidateRowId.localeCompare(right.candidateRowId, 'en');
    return idComparison || stableSerialize(left).localeCompare(stableSerialize(right), 'en');
  });
}

/**
 * 规范化候选行 ID 列表。
 * @param {*} values 原始 ID 列表。
 * @returns {string[]} 稳定 ID 列表。
 */
function normalizeCandidateRowIds(values) {
  if (!Array.isArray(values)) {
    throw badRequest('candidateRowIds 必须是数组。', { code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_REQUIRED' });
  }
  const normalized = values.map((value, index) => normalizeCandidateRowId(value, index));
  if (new Set(normalized).size !== normalized.length) {
    throw badRequest('candidateRowIds 不允许重复。', { code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_DUPLICATE' });
  }
  return normalized.sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * 构造签名载荷并固定模板安全字段。
 * @param {object} input 签名上下文。
 * @returns {object} 签名载荷。
 */
function buildEnergyAnalysisImportSignaturePayload(input = {}) {
  const template = getEnergyAnalysisImportTemplate(input.templateType);
  const candidateRows = normalizeCandidateRows(input.candidateRows || []);
  const derivedCandidateRowIds = candidateRows.map((row) => row.candidateRowId);
  const providedCandidateRowIds = input.candidateRowIds === undefined
    ? derivedCandidateRowIds
    : normalizeCandidateRowIds(input.candidateRowIds);
  if (stableSerialize(providedCandidateRowIds) !== stableSerialize(derivedCandidateRowIds)) {
    throw badRequest('candidateRowIds 必须与 candidateRows 完全一致。', {
      code: 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH'
    });
  }
  if (input.operation !== undefined && input.operation !== template.operation) {
    throw badRequest('operation 与模板安全契约不一致。', { code: 'ENERGY_ANALYSIS_IMPORT_OPERATION_MISMATCH' });
  }
  if (input.recordKind !== undefined && input.recordKind !== template.recordKind) {
    throw badRequest('recordKind 与模板安全契约不一致。', { code: 'ENERGY_ANALYSIS_IMPORT_RECORD_KIND_MISMATCH' });
  }
  if (input.confirmText !== undefined && input.confirmText !== template.confirmText) {
    throw badRequest('confirmText 与模板固定确认文本不一致。', { code: 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH' });
  }
  if (input.backupReason !== undefined && input.backupReason !== ENERGY_ANALYSIS_IMPORT_BACKUP_REASON) {
    throw badRequest('backupReason 与能源分析统一备份原因不一致。', { code: 'ENERGY_ANALYSIS_IMPORT_BACKUP_REASON_MISMATCH' });
  }
  if (input.requireBackup !== undefined && input.requireBackup !== true) {
    throw badRequest('能源分析导入签名要求 requireBackup=true。', { code: 'ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED' });
  }
  if (input.duplicateStrategy !== undefined && input.duplicateStrategy !== ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY) {
    throw badRequest('能源分析导入仅支持 skip 重复策略。', { code: 'ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY_UNSUPPORTED' });
  }
  return {
    version: ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION,
    operation: template.operation,
    templateType: template.templateType,
    recordKind: template.recordKind,
    importTypes: [...template.importTypes],
    fileSha256: normalizeSha256(input.fileSha256),
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    targetTables: [...template.targetTables],
    confirmText: template.confirmText,
    requireBackup: true,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    candidateRowIds: derivedCandidateRowIds,
    candidateRows
  };
}

/**
 * 使用域分隔符计算 HMAC-SHA256 十六进制摘要。
 * @param {string} secret HMAC 密钥。
 * @param {string} domain 域分隔符。
 * @param {*} payload 签名载荷。
 * @returns {string} 十六进制摘要。
 */
function hmacStablePayload(secret, domain, payload) {
  const normalizedSecret = normalizeSecretText(secret);
  if (!normalizedSecret) {
    throw badRequest('HMAC 密钥不能为空。', { code: 'ENERGY_ANALYSIS_HMAC_SECRET_REQUIRED' });
  }
  return crypto.createHmac('sha256', normalizedSecret)
    .update(`${domain}\0${stableSerialize(payload)}`, 'utf8')
    .digest('hex');
}

/**
 * 生成能源分析 preview 签名。
 * @param {object} input 签名上下文。
 * @param {string} secret HMAC 密钥。
 * @returns {string} 带版本前缀的签名。
 */
function buildEnergyAnalysisImportPreviewSignature(input, secret) {
  const payload = buildEnergyAnalysisImportSignaturePayload(input);
  return `${ENERGY_ANALYSIS_IMPORT_SIGNATURE_PREFIX}:${hmacStablePayload(secret, ENERGY_ANALYSIS_IMPORT_SIGNATURE_DOMAIN, payload)}`;
}

/**
 * timing-safe 校验能源分析 preview 签名。
 * @param {object} input 签名上下文。
 * @param {*} signature 待校验签名。
 * @param {string} secret HMAC 密钥。
 * @returns {boolean} 签名是否有效。
 */
function verifyEnergyAnalysisImportPreviewSignature(input, signature, secret) {
  return timingSafeEqualText(signature, buildEnergyAnalysisImportPreviewSignature(input, secret));
}

/**
 * 生成独立域的 preview 审计摘要。
 * @param {*} previewAudit 审计快照。
 * @param {string} secret HMAC 密钥。
 * @returns {string} 带审计前缀的摘要。
 */
function buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, secret) {
  const payload = {
    version: `${ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION}:audit`,
    previewAudit: canonicalizeStableValue(previewAudit)
  };
  return `${ENERGY_ANALYSIS_IMPORT_AUDIT_DIGEST_PREFIX}:${hmacStablePayload(secret, ENERGY_ANALYSIS_IMPORT_AUDIT_DOMAIN, payload)}`;
}

/**
 * timing-safe 校验 preview 审计摘要。
 * @param {*} previewAudit 审计快照。
 * @param {*} digest 待校验摘要。
 * @param {string} secret HMAC 密钥。
 * @returns {boolean} 摘要是否有效。
 */
function verifyEnergyAnalysisImportPreviewAuditDigest(previewAudit, digest, secret) {
  return timingSafeEqualText(digest, buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, secret));
}

/**
 * 判断目标路径是否严格位于根目录内。
 * @param {string} rootPath 根目录。
 * @param {string} targetPath 目标路径。
 * @returns {boolean} 是否位于根目录内且不等于根目录。
 */
function isPathInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * 跨平台比较路径状态与打开句柄是否指向同一文件身份。
 * @param {fs.Stats} pathStat 路径状态。
 * @param {fs.Stats} openedStat 打开句柄状态。
 * @returns {boolean} 是否为同一文件。
 */
function isSameFileIdentity(pathStat, openedStat) {
  if (pathStat.ino !== openedStat.ino) return false;
  if (pathStat.dev && openedStat.dev && pathStat.dev !== openedStat.dev) return false;
  return pathStat.birthtimeMs === openedStat.birthtimeMs;
}

/**
 * 判断两次文件状态是否仍指向同一份未变化内容。
 * @param {fs.Stats} beforeStat 读取前状态。
 * @param {fs.Stats} afterStat 读取后状态。
 * @returns {boolean} 文件身份和关键状态是否一致。
 */
function isSameOpenedFileState(beforeStat, afterStat) {
  return isSameFileIdentity(beforeStat, afterStat)
    && beforeStat.size === afterStat.size
    && beforeStat.mtimeMs === afterStat.mtimeMs;
}

/**
 * 在上传根目录内打开并原子读取普通文件，所有状态与摘要均来自同一文件描述符。
 * @param {string} uploadRoot 上传根目录。
 * @param {string} storedPath 上传根目录内的相对路径。
 * @param {object} options 可选文件大小约束及打开后测试钩子。
 * @returns {{filePath:string,sizeBytes:number,fileSha256:string,buffer:Buffer}} 已验证文件内容。
 */
function readSafeUploadFile(uploadRoot, storedPath, options = {}) {
  const rootInput = String(uploadRoot || '').trim();
  const relativeInput = String(storedPath || '').trim();
  if (!rootInput || !relativeInput) {
    throw badRequest('上传根目录和保存文件相对路径均为必填项。', { code: 'ENERGY_ANALYSIS_UPLOAD_PATH_REQUIRED' });
  }
  if (path.isAbsolute(relativeInput) || path.win32.isAbsolute(relativeInput) || path.posix.isAbsolute(relativeInput) || /^[A-Za-z]:/.test(relativeInput)) {
    throw badRequest('保存文件路径必须是上传根目录内的相对路径。', { code: 'ENERGY_ANALYSIS_UPLOAD_ABSOLUTE_PATH_REJECTED' });
  }
  const pathSegments = relativeInput.split(/[\\/]+/);
  if (pathSegments.some((segment) => segment === '..')) {
    throw badRequest('保存文件路径禁止包含父级目录。', { code: 'ENERGY_ANALYSIS_UPLOAD_PARENT_PATH_REJECTED' });
  }
  if (pathSegments.some((segment) => segment === '' || segment === '.')) {
    throw badRequest('保存文件路径包含无效目录段。', { code: 'ENERGY_ANALYSIS_UPLOAD_PATH_SEGMENT_INVALID' });
  }

  let fileDescriptor = null;
  try {
    const resolvedRoot = path.resolve(rootInput);
    const rootStat = fs.lstatSync(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw badRequest('上传根目录必须是真实目录且不能是符号链接。', { code: 'ENERGY_ANALYSIS_UPLOAD_ROOT_INVALID' });
    }
    const realRoot = fs.realpathSync(resolvedRoot);
    let currentPath = resolvedRoot;
    pathSegments.forEach((segment) => {
      currentPath = path.join(currentPath, segment);
      const segmentStat = fs.lstatSync(currentPath);
      if (segmentStat.isSymbolicLink()) {
        throw badRequest('保存文件路径禁止经过符号链接。', { code: 'ENERGY_ANALYSIS_UPLOAD_SYMLINK_REJECTED' });
      }
    });
    const pathStat = fs.lstatSync(currentPath);
    if (!pathStat.isFile()) {
      throw badRequest('保存文件路径必须指向普通文件。', { code: 'ENERGY_ANALYSIS_UPLOAD_NOT_REGULAR_FILE' });
    }
    const realFilePath = fs.realpathSync(currentPath);
    if (!isPathInside(realRoot, realFilePath)) {
      throw badRequest('保存文件路径逃逸上传根目录。', { code: 'ENERGY_ANALYSIS_UPLOAD_PATH_ESCAPE_REJECTED' });
    }

    const noFollowFlag = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    fileDescriptor = fs.openSync(currentPath, fs.constants.O_RDONLY | noFollowFlag);
    const beforeStat = fs.fstatSync(fileDescriptor);
    if (!beforeStat.isFile() || !isSameFileIdentity(pathStat, beforeStat)) {
      throw badRequest('打开文件与已校验路径不一致。', { code: 'ENERGY_ANALYSIS_UPLOAD_FILE_IDENTITY_MISMATCH' });
    }
    if (typeof options.afterFileOpen === 'function') {
      options.afterFileOpen({ fileDescriptor, filePath: currentPath });
    }
    const buffer = fs.readFileSync(fileDescriptor);
    const afterStat = fs.fstatSync(fileDescriptor);
    if (!isSameOpenedFileState(beforeStat, afterStat) || buffer.length !== beforeStat.size) {
      throw badRequest('读取期间上传文件发生变化。', { code: 'ENERGY_ANALYSIS_UPLOAD_FILE_CHANGED_DURING_READ' });
    }
    if (options.expectedSizeBytes !== undefined
      && (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0 || beforeStat.size !== options.expectedSizeBytes)) {
      throw badRequest('保存文件大小与预期不一致。', {
        code: 'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH',
        expectedSizeBytes: options.expectedSizeBytes,
        actualSizeBytes: beforeStat.size
      });
    }
    if (options.maxSizeBytes !== undefined
      && (!Number.isSafeInteger(options.maxSizeBytes) || options.maxSizeBytes < 0 || beforeStat.size > options.maxSizeBytes)) {
      throw badRequest('保存文件大小超过允许上限。', {
        code: 'ENERGY_ANALYSIS_UPLOAD_FILE_TOO_LARGE',
        maxSizeBytes: options.maxSizeBytes,
        actualSizeBytes: beforeStat.size
      });
    }
    return {
      filePath: realFilePath,
      sizeBytes: beforeStat.size,
      fileSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      buffer
    };
  } catch (error) {
    if (error && error.code === 'BAD_REQUEST') throw error;
    throw badRequest('保存文件不存在、不可访问或路径校验失败。', {
      code: 'ENERGY_ANALYSIS_UPLOAD_FILE_UNAVAILABLE',
      reasonCode: error && error.code ? error.code : null
    });
  } finally {
    if (fileDescriptor !== null) {
      fs.closeSync(fileDescriptor);
    }
  }
}

/**
 * 兼容返回受控上传文件信息，同时携带同一描述符读取的 Buffer 和摘要。
 * @param {string} uploadRoot 上传根目录。
 * @param {string} storedPath 上传根目录内相对路径。
 * @param {object} options 可选文件大小约束。
 * @returns {{filePath:string,sizeBytes:number,fileSha256:string,buffer:Buffer}} 已验证文件信息。
 */
function resolveSafeUploadFile(uploadRoot, storedPath, options = {}) {
  return readSafeUploadFile(uploadRoot, storedPath, options);
}

/**
 * 计算受控上传文件 SHA-256，并返回供解析复用的同一份 Buffer。
 * @param {string} uploadRoot 上传根目录。
 * @param {string} storedPath 上传根目录内相对路径。
 * @param {object} options 可选文件大小约束。
 * @returns {{filePath:string,sizeBytes:number,fileSha256:string,buffer:Buffer}} 文件摘要信息。
 */
function calculateSafeUploadFileSha256(uploadRoot, storedPath, options = {}) {
  return readSafeUploadFile(uploadRoot, storedPath, options);
}

/**
 * 校验客户端候选见证与服务端重算候选完全一致。
 * @param {object[]} recomputedCandidateRows 服务端重算候选。
 * @param {object} witness 客户端完整性见证。
 * @returns {object} 稳定校验结果。
 */
function validateCandidateWitness(recomputedCandidateRows, witness = {}) {
  const errors = [];
  let expectedRows;
  let actualRows;
  let actualIds;
  try {
    expectedRows = normalizeCandidateRows(recomputedCandidateRows);
  } catch (error) {
    return createValidationResult([
      createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_RECOMPUTED_CANDIDATES_INVALID', error.message)
    ]);
  }
  try {
    actualRows = normalizeCandidateRows(witness.candidateRows);
  } catch (error) {
    errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_INVALID', error.message));
    actualRows = [];
  }
  try {
    actualIds = normalizeCandidateRowIds(witness.candidateRowIds);
  } catch (error) {
    errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_INVALID', error.message));
    actualIds = [];
  }
  const expectedIds = expectedRows.map((row) => row.candidateRowId);
  const expectedWouldImport = Number(witness.expectedWouldImport);
  if (!Number.isSafeInteger(expectedWouldImport) || expectedWouldImport < 0 || expectedWouldImport !== expectedRows.length) {
    errors.push(createValidationError(
      'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
      'expectedWouldImport 与服务端重算候选数量不一致。',
      { expected: expectedRows.length, actual: witness.expectedWouldImport }
    ));
  }
  if (stableSerialize(actualIds) !== stableSerialize(expectedIds)) {
    errors.push(createValidationError(
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
      'candidateRowIds 与服务端重算结果不一致。'
    ));
  }
  if (stableSerialize(actualRows) !== stableSerialize(expectedRows)) {
    errors.push(createValidationError(
      'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH',
      'candidateRows 与服务端重算结果不一致。'
    ));
  }
  return createValidationResult(errors, {
    expectedWouldImport: expectedRows.length,
    candidateRowIds: expectedIds,
    candidateRows: expectedRows
  });
}

/**
 * 收集单批次与当前已验签 preview 上下文的绑定错误。
 * @param {*} batch 持久化批次元数据。
 * @param {object} expected 已验签上下文。
 * @returns {{errors:object[],template:object}} 元数据校验结果，不代表 execute 获得授权。
 */
function collectImportBatchMetadataErrors(batch, expected = {}) {
  const errors = [];
  const template = expected.template;
  const expectedBatchId = Number(expected.expectedBatchId);
  if (!Number.isSafeInteger(expectedBatchId) || expectedBatchId <= 0) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_EXPECTED_BATCH_ID_INVALID', 'expectedBatchId 必须是正安全整数。'));
  }
  if (!isPlainObject(batch)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_REQUIRED', '批次元数据为必填普通对象。'));
    return { errors, template };
  }
  if (Number(batch.id) !== expectedBatchId) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_ID_MISMATCH', '批次 id 与 expectedBatchId 不一致。'));
  }
  if (!ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_STATUSES.includes(batch.status)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID', '批次状态不允许进入 execute。'));
  }
  const batchPhase = batch.auditPhase ?? batch.phase;
  if (batchPhase !== ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_PHASE) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH', '批次必须仍处于 preview 阶段。'));
  }
  if (batch.templateType !== template.templateType) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_TEMPLATE_MISMATCH', '批次 templateType 与模板不一致。'));
  }
  if (batch.operation !== template.operation) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_OPERATION_MISMATCH', '批次 operation 与模板不一致。'));
  }
  if (batch.recordKind !== template.recordKind) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_RECORD_KIND_MISMATCH', '批次 recordKind 与模板不一致。'));
  }
  const batchImportTypes = Array.isArray(batch.importTypes) ? batch.importTypes.map((value) => String(value)) : [];
  if (stableSerialize(batchImportTypes) !== stableSerialize(template.importTypes)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_IMPORT_TYPES_MISMATCH', '批次 importTypes 与模板不一致。'));
  }
  if (template.importTypes.length === 1 && batch.importType !== template.importTypes[0]) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_IMPORT_TYPE_MISMATCH', '批次 importType 与模板不一致。'));
  }
  let batchFileSha256 = null;
  try {
    batchFileSha256 = normalizeSha256(batch.fileSha256);
  } catch (error) {
    errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_FILE_SHA256_INVALID', error.message));
  }
  if (batchFileSha256 && batchFileSha256 !== expected.fileSha256) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_FILE_SHA256_MISMATCH', '批次文件摘要与当前文件不一致。'));
  }
  const batchSignature = typeof batch.previewSignature === 'string' ? batch.previewSignature.trim() : '';
  if (!PREVIEW_SIGNATURE_PATTERN.test(batchSignature)
    || !PREVIEW_SIGNATURE_PATTERN.test(expected.previewSignature || '')
    || !timingSafeEqualText(batchSignature, expected.previewSignature)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_SIGNATURE_MISMATCH', '批次 previewSignature 与当前已验签值不一致。'));
  }
  const batchAuditDigest = typeof batch.previewAuditDigest === 'string' ? batch.previewAuditDigest.trim() : '';
  if (!PREVIEW_AUDIT_DIGEST_PATTERN.test(batchAuditDigest)
    || !PREVIEW_AUDIT_DIGEST_PATTERN.test(expected.previewAuditDigest || '')
    || !timingSafeEqualText(batchAuditDigest, expected.previewAuditDigest)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_AUDIT_DIGEST_MISMATCH', '批次 previewAuditDigest 与当前已验签值不一致。'));
  }
  return { errors, template };
}

/**
 * 从同一份已验证 Buffer 计算当前执行文件摘要。
 * @param {*} fileBuffer 原子读取入口返回的文件 Buffer。
 * @returns {string|null} 当前文件摘要。
 */
function hashExecuteFileBuffer(fileBuffer) {
  if (!(Buffer.isBuffer(fileBuffer) || fileBuffer instanceof Uint8Array)) {
    return null;
  }
  return crypto.createHash('sha256').update(Buffer.from(fileBuffer)).digest('hex');
}

/**
 * 能源分析导入唯一 execute 授权总门槛。
 * @param {object} input execute 请求与客户端完整性见证。
 * @param {object} serverContext 服务端当前文件、重算候选、审计快照和 HMAC 密钥。
 * @returns {object} 只有该函数返回 valid=true 才可进入备份与写事务。
 */
function authorizeEnergyAnalysisImportExecute(input = {}, serverContext = {}) {
  const errors = [];
  let template;
  try {
    template = getEnergyAnalysisImportTemplate(input.templateType);
  } catch (error) {
    return createValidationResult([
      createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_TEMPLATE_UNSUPPORTED', error.message)
    ]);
  }
  if (!isPlainObject(serverContext)) {
    return createValidationResult([
      createValidationError('ENERGY_ANALYSIS_IMPORT_SERVER_CONTEXT_REQUIRED', 'execute 服务端上下文为必填普通对象。')
    ], { template });
  }

  if (input.confirmText !== template.confirmText) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH', '固定中文确认文本不匹配。'));
  }
  if (input.requireBackup !== true) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED', 'requireBackup 必须显式为 true。'));
  }
  if (input.acknowledgeSkippedRisks !== true) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED', 'acknowledgeSkippedRisks 必须显式为 true。'));
  }
  if (input.backupReason !== ENERGY_ANALYSIS_IMPORT_BACKUP_REASON) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_BACKUP_REASON_MISMATCH', 'backupReason 必须使用统一值。'));
  }
  if (input.duplicateStrategy !== ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY_UNSUPPORTED', '仅支持 skip 重复策略。'));
  }
  if (input.operation !== template.operation) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_OPERATION_MISMATCH', 'operation 与模板不一致。'));
  }
  if (input.recordKind !== template.recordKind) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_RECORD_KIND_MISMATCH', 'recordKind 与模板不一致。'));
  }
  if (stableSerialize(input.importTypes || []) !== stableSerialize(template.importTypes)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_IMPORT_TYPES_MISMATCH', 'importTypes 与模板不一致。'));
  }

  const currentFileSha256 = hashExecuteFileBuffer(serverContext.fileBuffer);
  if (!currentFileSha256) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_FILE_BUFFER_REQUIRED', 'execute 必须使用原子读取入口返回的文件 Buffer。'));
  }
  let witnessedFileSha256 = null;
  try {
    witnessedFileSha256 = normalizeSha256(input.fileSha256);
  } catch (error) {
    errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_FILE_SHA256_INVALID', error.message));
  }
  if (currentFileSha256 && witnessedFileSha256 && currentFileSha256 !== witnessedFileSha256) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH', '客户端文件摘要与当前原子读取文件不一致。'));
  }

  const recomputedCandidateRows = serverContext.recomputedCandidateRows;
  const witnessValidation = validateCandidateWitness(recomputedCandidateRows, input);
  errors.push(...witnessValidation.errors);
  if (witnessValidation.expectedWouldImport !== undefined && witnessValidation.expectedWouldImport <= 0) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED', '服务端重算 wouldImport 必须大于 0。'));
  }

  const previewSignature = typeof input.previewSignature === 'string' ? input.previewSignature.trim() : '';
  const previewAuditDigest = typeof input.previewAuditDigest === 'string' ? input.previewAuditDigest.trim() : '';
  if (!previewSignature) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_REQUIRED', 'previewSignature 为必填项。'));
  }
  if (!previewAuditDigest) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_REQUIRED', 'previewAuditDigest 为必填项。'));
  }
  const secret = normalizeSecretText(serverContext.secret);
  if (!secret) {
    errors.push(createValidationError('ENERGY_ANALYSIS_HMAC_SECRET_REQUIRED', '服务端 HMAC 密钥为必填项。'));
  }
  if (!isPlainObject(serverContext.previewAudit)) {
    errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_REQUIRED', '服务端重算 preview 审计快照为必填普通对象。'));
  }

  let signaturePayload = null;
  let signatureVerified = false;
  if (currentFileSha256 && witnessValidation.candidateRows && secret && previewSignature) {
    try {
      signaturePayload = buildEnergyAnalysisImportSignaturePayload({
        templateType: template.templateType,
        fileSha256: currentFileSha256,
        candidateRows: witnessValidation.candidateRows
      });
      signatureVerified = verifyEnergyAnalysisImportPreviewSignature(signaturePayload, previewSignature, secret);
      if (!signatureVerified) {
        errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID', 'previewSignature 未通过当前文件和重算候选验签。'));
      }
    } catch (error) {
      errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID', error.message));
    }
  }

  let auditDigestVerified = false;
  if (isPlainObject(serverContext.previewAudit) && secret && previewAuditDigest) {
    try {
      auditDigestVerified = verifyEnergyAnalysisImportPreviewAuditDigest(serverContext.previewAudit, previewAuditDigest, secret);
      if (!auditDigestVerified) {
        errors.push(createValidationError('ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID', 'previewAuditDigest 未通过服务端重算审计快照校验。'));
      }
    } catch (error) {
      errors.push(createValidationError(error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_INVALID', error.message));
    }
  }

  if (signatureVerified && auditDigestVerified) {
    const verifiedContext = {
      template,
      fileSha256: currentFileSha256,
      previewSignature,
      previewAuditDigest
    };
    if (template.importTypes.length === 1) {
      errors.push(...collectImportBatchMetadataErrors(input.batch, {
        ...verifiedContext,
        expectedBatchId: input.expectedBatchId
      }).errors);
    } else {
      const bundleValidation = validateEnergyFlowBundleMetadata(input.bundle, verifiedContext);
      errors.push(...bundleValidation.errors);
    }
  }

  return createValidationResult(errors, {
    template,
    fileSha256: currentFileSha256,
    expectedWouldImport: witnessValidation.expectedWouldImport,
    candidateRowIds: witnessValidation.candidateRowIds,
    candidateRows: witnessValidation.candidateRows,
    signaturePayload,
    signatureVerified,
    auditDigestVerified
  });
}

/**
 * 构造统一 error/warning 行级问题。
 * @param {object} input 问题字段。
 * @returns {object} 标准问题对象。
 */
function createImportIssue(input = {}) {
  const rowNumber = Number(input.rowNumber);
  const severity = String(input.severity || '').trim().toLowerCase();
  const code = String(input.code || '').trim();
  const message = String(input.message || '').trim();
  if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0) {
    throw badRequest('issue.rowNumber 必须是正安全整数。', { code: 'ENERGY_ANALYSIS_IMPORT_ISSUE_ROW_NUMBER_INVALID' });
  }
  if (!ENERGY_ANALYSIS_IMPORT_ISSUE_SEVERITIES.includes(severity)) {
    throw badRequest('issue.severity 仅支持 error/warning。', { code: 'ENERGY_ANALYSIS_IMPORT_ISSUE_SEVERITY_INVALID' });
  }
  if (!code || !message) {
    throw badRequest('issue.code 和 issue.message 均为必填项。', { code: 'ENERGY_ANALYSIS_IMPORT_ISSUE_CONTENT_REQUIRED' });
  }
  const rawValue = input.rawValue;
  return {
    rowNumber,
    fieldName: input.fieldName === undefined || input.fieldName === null ? null : String(input.fieldName),
    rawValue: rawValue === undefined || rawValue === null
      ? null
      : (typeof rawValue === 'object' ? stableSerialize(rawValue) : String(rawValue)),
    code,
    message,
    severity
  };
}

/**
 * 合并并规范化单行 issues/reasons，保持首次出现顺序并去重。
 * @param {object} item 预演行。
 * @param {number} index 行索引。
 * @returns {object[]} 标准问题列表。
 */
function normalizeImportItemIssues(item, index) {
  const sources = [];
  ['issues', 'reasons'].forEach((fieldName) => {
    if (item[fieldName] === undefined || item[fieldName] === null) return;
    if (!Array.isArray(item[fieldName])) {
      throw badRequest(`导入预演行 ${fieldName} 必须是数组。`, {
        code: 'ENERGY_ANALYSIS_IMPORT_ITEM_ISSUES_INVALID',
        index,
        fieldName
      });
    }
    sources.push(...item[fieldName]);
  });
  const seen = new Set();
  return sources.reduce((result, issue, issueIndex) => {
    if (!isPlainObject(issue)) {
      throw badRequest('导入预演行问题必须是普通对象。', {
        code: 'ENERGY_ANALYSIS_IMPORT_ITEM_ISSUE_INVALID',
        index,
        issueIndex
      });
    }
    let normalizedIssue;
    try {
      normalizedIssue = createImportIssue(issue);
    } catch (error) {
      throw badRequest('导入预演行问题结构无效。', {
        code: error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_ITEM_ISSUE_INVALID',
        index,
        issueIndex
      });
    }
    const identity = stableSerialize(normalizedIssue);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(normalizedIssue);
    }
    return result;
  }, []);
}

/**
 * 汇总导入行状态与 error/warning 数量，矛盾状态直接拒绝。
 * @param {*} items 预演行列表。
 * @returns {object} 统一 summary。
 */
function buildImportSummary(items = []) {
  if (!Array.isArray(items)) {
    throw badRequest('导入预演 items 必须是数组。', { code: 'ENERGY_ANALYSIS_IMPORT_ITEMS_REQUIRED' });
  }
  const summary = { totalRows: items.length, wouldImport: 0, skipped: 0, blocked: 0, warnings: 0, errors: 0 };
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !ENERGY_ANALYSIS_IMPORT_ITEM_STATUSES.includes(item.status)) {
      throw badRequest('导入预演行状态无效。', {
        code: 'ENERGY_ANALYSIS_IMPORT_ITEM_STATUS_INVALID',
        index,
        status: item?.status
      });
    }
    const issues = normalizeImportItemIssues(item, index);
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    if (item.status === 'wouldImport' && errorCount > 0) {
      throw badRequest('wouldImport 行不得包含 error。', {
        code: 'ENERGY_ANALYSIS_IMPORT_WOULD_IMPORT_HAS_ERROR',
        index
      });
    }
    if (item.status === 'blocked' && errorCount === 0) {
      throw badRequest('blocked 行必须至少包含一个 error。', {
        code: 'ENERGY_ANALYSIS_IMPORT_BLOCKED_ERROR_REQUIRED',
        index
      });
    }
    summary[item.status] += 1;
    summary.warnings += issues.filter((issue) => issue.severity === 'warning').length;
    summary.errors += errorCount;
  });
  return summary;
}

/**
 * 校验能流边与显式边值双批次 bundle 元数据。
 * @param {*} bundle 双批次元数据。
 * @param {object} expected 当前已验签 preview 上下文。
 * @returns {object} 元数据校验结果，不能替代 execute 总门槛。
 */
function validateEnergyFlowBundleMetadata(bundle = {}, expected = {}) {
  const errors = [];
  if (!isPlainObject(bundle)) {
    return { metadataValid: false, errors: [
      createValidationError('ENERGY_FLOW_BUNDLE_REQUIRED', '双批次 bundle 为必填普通对象。')
    ] };
  }
  const edgeBatch = bundle.edgeBatch;
  const recordBatch = bundle.recordBatch;
  const edgeBatchId = Number(bundle.edgeBatchId);
  const recordBatchId = Number(bundle.recordBatchId);
  const uploadGroupId = String(bundle.uploadGroupId || '').trim();
  if (!Number.isSafeInteger(edgeBatchId) || edgeBatchId <= 0) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_EDGE_BATCH_ID_INVALID', 'edgeBatchId 必须是正安全整数。'));
  }
  if (!Number.isSafeInteger(recordBatchId) || recordBatchId <= 0) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_RECORD_BATCH_ID_INVALID', 'recordBatchId 必须是正安全整数。'));
  }
  if (edgeBatchId === recordBatchId && edgeBatchId > 0) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_BATCH_IDS_MUST_DIFFER', 'edgeBatchId 与 recordBatchId 必须不同。'));
  }
  if (!uploadGroupId) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_UPLOAD_GROUP_ID_REQUIRED', 'uploadGroupId 为必填项。'));
  }
  if (!isPlainObject(edgeBatch) || !isPlainObject(recordBatch)) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_BATCH_METADATA_REQUIRED', 'edgeBatch 和 recordBatch 元数据均为必填普通对象。'));
    return { metadataValid: false, errors };
  }
  if (Number(edgeBatch.id) !== edgeBatchId) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_EDGE_BATCH_ID_MISMATCH', 'edgeBatch.id 与 edgeBatchId 不一致。'));
  }
  if (Number(recordBatch.id) !== recordBatchId) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_RECORD_BATCH_ID_MISMATCH', 'recordBatch.id 与 recordBatchId 不一致。'));
  }
  [edgeBatch, recordBatch].forEach((batch, index) => {
    const label = index === 0 ? 'EDGE' : 'RECORD';
    if (!ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_STATUSES.includes(batch.status)) {
      errors.push(createValidationError(`ENERGY_FLOW_BUNDLE_${label}_BATCH_STATUS_INVALID`, '双批次状态不允许进入 execute。'));
    }
    const phase = batch.auditPhase ?? batch.phase;
    if (phase !== ENERGY_ANALYSIS_IMPORT_EXECUTABLE_BATCH_PHASE) {
      errors.push(createValidationError(`ENERGY_FLOW_BUNDLE_${label}_BATCH_PHASE_MISMATCH`, '双批次必须仍处于 preview 阶段。'));
    }
  });
  if (edgeBatch.importType !== 'energy_flow_edge') {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_EDGE_IMPORT_TYPE_MISMATCH', 'edgeBatch.importType 必须为 energy_flow_edge。'));
  }
  if (recordBatch.importType !== 'energy_flow_record') {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_RECORD_IMPORT_TYPE_MISMATCH', 'recordBatch.importType 必须为 energy_flow_record。'));
  }
  if (edgeBatch.uploadGroupId !== uploadGroupId || recordBatch.uploadGroupId !== uploadGroupId) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_UPLOAD_GROUP_MISMATCH', '两个批次必须属于同一 uploadGroupId。'));
  }
  let edgeSha = null;
  let recordSha = null;
  try {
    edgeSha = normalizeSha256(edgeBatch.fileSha256);
    recordSha = normalizeSha256(recordBatch.fileSha256);
  } catch (error) {
    errors.push(createValidationError(error?.details?.code || 'ENERGY_FLOW_BUNDLE_FILE_SHA256_INVALID', error.message));
  }
  if (edgeSha && recordSha && edgeSha !== recordSha) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_FILE_SHA256_MISMATCH', '两个批次必须引用同一上传文件 SHA-256。'));
  }
  if (!expected.fileSha256 || edgeSha !== expected.fileSha256 || recordSha !== expected.fileSha256) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_CURRENT_FILE_SHA256_MISMATCH', '两个批次文件摘要必须等于当前已验签文件。'));
  }

  const edgeSignature = typeof edgeBatch.previewSignature === 'string' ? edgeBatch.previewSignature.trim() : '';
  const recordSignature = typeof recordBatch.previewSignature === 'string' ? recordBatch.previewSignature.trim() : '';
  if (!PREVIEW_SIGNATURE_PATTERN.test(edgeSignature) || !PREVIEW_SIGNATURE_PATTERN.test(recordSignature)) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_PREVIEW_SIGNATURE_REQUIRED', '两个批次均必须包含合法 previewSignature。'));
  } else {
    if (!timingSafeEqualText(edgeSignature, recordSignature)) {
      errors.push(createValidationError('ENERGY_FLOW_BUNDLE_PREVIEW_SIGNATURE_MISMATCH', '两个批次必须使用同一 previewSignature。'));
    }
    if (!expected.previewSignature
      || !timingSafeEqualText(edgeSignature, expected.previewSignature)
      || !timingSafeEqualText(recordSignature, expected.previewSignature)) {
      errors.push(createValidationError('ENERGY_FLOW_BUNDLE_CURRENT_PREVIEW_SIGNATURE_MISMATCH', '两个批次签名必须等于当前已验签值。'));
    }
  }

  const edgeAuditDigest = typeof edgeBatch.previewAuditDigest === 'string' ? edgeBatch.previewAuditDigest.trim() : '';
  const recordAuditDigest = typeof recordBatch.previewAuditDigest === 'string' ? recordBatch.previewAuditDigest.trim() : '';
  if (!PREVIEW_AUDIT_DIGEST_PATTERN.test(edgeAuditDigest) || !PREVIEW_AUDIT_DIGEST_PATTERN.test(recordAuditDigest)) {
    errors.push(createValidationError('ENERGY_FLOW_BUNDLE_PREVIEW_AUDIT_DIGEST_REQUIRED', '两个批次均必须包含合法 previewAuditDigest。'));
  } else {
    if (!timingSafeEqualText(edgeAuditDigest, recordAuditDigest)) {
      errors.push(createValidationError('ENERGY_FLOW_BUNDLE_PREVIEW_AUDIT_DIGEST_MISMATCH', '两个批次必须使用同一 previewAuditDigest。'));
    }
    if (!expected.previewAuditDigest
      || !timingSafeEqualText(edgeAuditDigest, expected.previewAuditDigest)
      || !timingSafeEqualText(recordAuditDigest, expected.previewAuditDigest)) {
      errors.push(createValidationError('ENERGY_FLOW_BUNDLE_CURRENT_PREVIEW_AUDIT_DIGEST_MISMATCH', '两个批次摘要必须等于当前已验签值。'));
    }
  }
  return {
    metadataValid: errors.length === 0,
    errors,
    edgeBatchId,
    recordBatchId,
    uploadGroupId,
    fileSha256: edgeSha && edgeSha === recordSha ? edgeSha : null
  };
}

module.exports = {
  ENERGY_ANALYSIS_IMPORT_AUDIT_DIGEST_PREFIX,
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY,
  ENERGY_ANALYSIS_IMPORT_SIGNATURE_PREFIX,
  ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION,
  ENERGY_ANALYSIS_IMPORT_TEMPLATES,
  authorizeEnergyAnalysisImportExecute,
  buildEnergyAnalysisImportPreviewAuditDigest,
  buildEnergyAnalysisImportPreviewSignature,
  buildEnergyAnalysisImportSignaturePayload,
  buildImportSummary,
  calculateSafeUploadFileSha256,
  createImportIssue,
  getEnergyAnalysisImportTemplate,
  normalizeCandidateRows,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  resolveSafeUploadFile,
  stableSerialize,
  timingSafeEqualText,
  validateCandidateWitness,
  validateEnergyFlowBundleMetadata,
  verifyEnergyAnalysisImportPreviewAuditDigest,
  verifyEnergyAnalysisImportPreviewSignature
};
