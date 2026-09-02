'use strict';

// 服务导出壳在依赖加载前固定，确保私有协议捕获初始化期函数且不受后续整体替换影响。
const predictionServiceExports = {};
const predictionServiceExportsProxy = new Proxy(predictionServiceExports, {});
Object.defineProperty(module, 'exports', {
  value: predictionServiceExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const crypto = require('crypto');
const { types: utilTypes } = require('util');
const XLSX = require('xlsx');
const databaseModule = require('../db/database');
const { openDatabase, uploadsDir: defaultUploadsDir } = databaseModule;
const { badRequest, notFound } = require('../utils/errors');
const { MAX_IMPORT_FILE_SIZE_BYTES } = require('../middleware/upload');
const backupService = require('./backupService');
const { buildPaginationMeta, normalizePagination } = require('./energyRecordQuery');
const { assertSupportedImportFile, parseImportBuffer, parseImportFile } = require('./import/parser');
const { readSafeUploadFile } = require('./energyAnalysisImportCore');
const { recordOperation } = require('./sessionService');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssues,
  replaceImportAuditIssuesWithDatabase,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_ROUNDING_DIGITS,
  PREDICTION_SORT_COLUMNS,
  buildForecast,
  buildPredictionConfidenceFacts,
  detectHistoryWarnings,
  formatPredictionForecastMethodNote,
  generateMonthSequence,
  isPredictionRoundedValue,
  normalizeMonth,
  normalizePositiveInteger,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  normalizeText,
  resolveMovingAverageRequiredHistoryMonths,
  roundSignedPredictionValue,
  summarizeHistorySufficiency,
  validatePredictionRange
} = require('./predictionUtils');

const RUN_PAGE_SIZE_MAX = 200;
const RESULT_PAGE_SIZE_MAX = 500;
const CONFIG_PAGE_SIZE_MAX = 200;
const MAX_PREDICTION_EXPORT_ROWS = 5000;
const PREDICTION_CONFIG_STATUSES = Object.freeze(['draft', 'active', 'archived']);
const PREDICTION_CONFIG_IMPORT_TYPE = 'prediction_config';
const PREDICTION_CONFIG_IMPORT_TEMPLATE_ID = 'prediction-configs';
const PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT = '确认导入预测配置草稿';
const PREDICTION_CONFIG_IMPORT_BACKUP_REASON = 'prediction-config-import';
const PREDICTION_CONFIG_IMPORT_HMAC_SECRET_META_KEY = 'prediction_config_import_hmac_secret';
const PREDICTION_CONFIG_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v1';
const PREDICTION_CONFIG_IMPORT_AUDIT_DIGEST_PREFIX = 'hmac-sha256:v1:audit';
// Artifact 12 只能通过 ownership 非枚举内部协议提交完整 retained operation。
const DEMO_PREDICTION_CONFIG_MANAGED_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.demoOwnership.predictionConfigManaged.v1');
const PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.predictionConfig.managedCore.v1');
// Prediction exact core 只通过非枚举 Symbol 暴露 caller-owned 生命周期能力。
const PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.prediction.exactInternal.v1');
const DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.database.rawConnectionInternal.v1');
// 原始连接校验协议在模块初始化期固定，普通 export monkeypatch 不会改变 exact 边界。
const databaseRawConnectionInternalProtocol =
  databaseModule[DATABASE_RAW_CONNECTION_INTERNAL_PROTOCOL_SYMBOL];
// obligation 与 SAVEPOINT release 能力只在本模块初始化期一次性领取，普通调用方不能伪造 authority。
const PREDICTION_DATABASE_TRANSACTION_AUTHORITY = Object.freeze({});
const predictionDatabaseTransactionProtocol =
  databaseRawConnectionInternalProtocol?.bindTransactionAuthority(
    PREDICTION_DATABASE_TRANSACTION_AUTHORITY
  );
// transaction scope、inspect capability 与 completion witness 的真实状态仅保存在模块私有 WeakMap。
const PREDICTION_EXACT_TRANSACTION_SCOPE_STATE = new WeakMap();
const PREDICTION_EXACT_CAPABILITY_STATE = new WeakMap();
const PREDICTION_COMPLETION_WITNESS_STATE = new WeakMap();
// P4 pending obligation 只通过 opaque 对象绑定 witness、scope 和数据库事务门禁。
const PREDICTION_COMPLETION_OBLIGATION_STATE = new WeakMap();
const PREDICTION_CONFIG_IMPORT_HEADERS = Object.freeze(['配置名称', '备注', '能源类型编码', '用能单元编码', '计量器具编码', '能耗批次ID', '训练开始月份', '训练结束月份', '预测开始月份', '预测结束月份', '算法', '窗口大小', '状态']);
const PREDICTION_CONFIG_IMPORT_ALIASES = Object.freeze({
  name: ['name', '名称', '配置名称'], note: ['note', 'remark', '备注', '说明'],
  energyTypeCode: ['energyTypeCode', 'energy_type_code', '能源类型', '能源类型编码'],
  organizationUnitCode: ['organizationUnitCode', 'organization_unit_code', '用能单元编码', '组织单元编码'],
  meterCode: ['meterCode', 'meter_code', '计量器具编码', '仪表编码'],
  sourceBatchId: ['sourceBatchId', 'source_batch_id', '能耗批次ID', '历史批次ID'],
  trainStartMonth: ['trainStartMonth', 'train_start_month', '训练开始月份'],
  trainEndMonth: ['trainEndMonth', 'train_end_month', '训练结束月份'],
  predictStartMonth: ['predictStartMonth', 'predict_start_month', '目标开始月份', '预测开始月份'],
  predictEndMonth: ['predictEndMonth', 'predict_end_month', '目标结束月份', '预测结束月份'],
  algorithm: ['algorithm', '算法'], windowSize: ['windowSize', 'window_size', '窗口大小'], status: ['status', '状态']
});
const PREDICTION_CONFIG_EXPORT_FIELDS = Object.freeze([
  { key: 'name', header: '配置名称' }, { key: 'note', header: '备注' },
  { key: 'energyTypeCode', header: '能源类型编码' }, { key: 'organizationUnitCode', header: '用能单元编码' },
  { key: 'organizationUnitName', header: '用能单元名称' }, { key: 'meterCode', header: '计量器具编码' },
  { key: 'meterName', header: '计量器具名称' }, { key: 'sourceBatchFilterId', header: '能耗批次ID' },
  { key: 'trainStartMonth', header: '训练开始月份' }, { key: 'trainEndMonth', header: '训练结束月份' },
  { key: 'predictStartMonth', header: '预测开始月份' }, { key: 'predictEndMonth', header: '预测结束月份' },
  { key: 'algorithm', header: '算法' }, { key: 'windowSize', header: '窗口大小' }, { key: 'status', header: '状态' }
]);
const PREDICTION_RESULT_EXPORT_FIELDS = Object.freeze([
  { key: 'predictionRunId', header: '预测运行ID' }, { key: 'predictionRunName', header: '预测运行名称' },
  { key: 'algorithm', header: '算法' }, { key: 'runStatus', header: '运行状态' },
  { key: 'energyTypeCode', header: '能源类型编码' }, { key: 'targetMonth', header: '预测月份' },
  { key: 'predictedValue', header: '预测值' }, { key: 'predictedUnit', header: '预测单位' },
  { key: 'confidenceLow', header: '置信区间下限' }, { key: 'confidenceHigh', header: '置信区间上限' }, { key: 'methodNote', header: '方法说明' }
]);

/** 延迟加载 demo context 服务，避免模板生成与预测服务初始化形成循环依赖。 */
function getPredictionDemoContextService() { return require('./demoContextService'); }
// 初始化后首次使用时一次性捕获 Artifact 12 ownership 协议，后续 exports 替换不能接管既有调用方。
let predictionConfigManagedOwnershipProtocol = null;
/** 延迟捕获 Artifact 12 唯一 managed operation 协议。 */
function getPredictionConfigManagedOwnershipProtocol() {
  if (predictionConfigManagedOwnershipProtocol) return predictionConfigManagedOwnershipProtocol;
  const ownershipService = require('./demoOwnershipService');
  const protocol = ownershipService[DEMO_PREDICTION_CONFIG_MANAGED_PROTOCOL_SYMBOL];
  if (!protocol || typeof protocol.executeManagedImport !== 'function') {
    throw new Error('Artifact 12 prediction config managed ownership 协议未完成初始化。');
  }
  predictionConfigManagedOwnershipProtocol = Object.freeze({
    executeManagedImport: protocol.executeManagedImport
  });
  return predictionConfigManagedOwnershipProtocol;
}

function nullableText(value) { return normalizeText(value) || null; }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, '\\$&'); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
/** 对齐 import audit 的 JSON 归一化规则，将对象内 undefined 稳定保存为 null。 */
function normalizePredictionAuditValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizePredictionAuditValue(item));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = normalizePredictionAuditValue(value[key]);
      return result;
    }, {});
  }
  return value === undefined ? null : value;
}
function timingSafeEqualText(actual, expected) { const left = Buffer.from(String(actual || ''), 'utf8'); const right = Buffer.from(String(expected || ''), 'utf8'); return left.length === right.length && crypto.timingSafeEqual(left, right); }

/** 判断调用方是否显式提供字段，避免 0、空串与缺省被 falsey 合并。 */
function hasOwnPredictionField(payload, fieldName) {
  return Object.prototype.hasOwnProperty.call(payload, fieldName);
}

/** 规范化 camelCase/snake_case 别名，并对空串和语义冲突 fail-closed。 */
function normalizePredictionAliasedField(payload, aliases, logicalFieldName, normalizer) {
  const providedAliases = aliases.filter((alias) => hasOwnPredictionField(payload, alias));
  if (providedAliases.length === 0) return undefined;
  const normalizedValues = providedAliases.map((alias) => {
    const rawValue = payload[alias];
    if (typeof rawValue === 'string' && rawValue.trim() === '') {
      throw badRequest(`${logicalFieldName} 不能使用空串表示缺省。`, {
        code: 'PREDICTION_EMPTY_ALIAS_VALUE',
        fieldName: logicalFieldName,
        alias
      });
    }
    return { alias, value: normalizer(rawValue) };
  });
  const canonicalValue = stableStringify(normalizedValues[0].value);
  if (normalizedValues.some((entry) => stableStringify(entry.value) !== canonicalValue)) {
    throw badRequest(`${logicalFieldName} 的 camelCase/snake_case 别名值冲突。`, {
      code: 'PREDICTION_ALIAS_CONFLICT',
      fieldName: logicalFieldName,
      aliases: normalizedValues.map((entry) => entry.alias)
    });
  }
  return normalizedValues[0].value;
}

/** 规范化实际预测服务支持的历史数据筛选条件。 */
function normalizeTrainingFilters(payload = {}) {
  return {
    energyTypeCode: normalizePredictionAliasedField(
      payload,
      ['energyTypeCode', 'energy_type_code'],
      'energyTypeCode',
      normalizeText
    ),
    organizationUnitCode: normalizePredictionAliasedField(
      payload,
      ['organizationUnitCode', 'organization_unit_code'],
      'organizationUnitCode',
      normalizeText
    ),
    organizationUnitId: normalizePredictionAliasedField(
      payload,
      ['organizationUnitId', 'organization_unit_id'],
      'organizationUnitId',
      (value) => normalizePositiveInteger(value, 'organizationUnitId')
    ),
    meterCode: normalizePredictionAliasedField(
      payload,
      ['meterCode', 'meter_code'],
      'meterCode',
      normalizeText
    ),
    meterDeviceId: normalizePredictionAliasedField(
      payload,
      ['meterDeviceId', 'meter_device_id'],
      'meterDeviceId',
      (value) => normalizePositiveInteger(value, 'meterDeviceId')
    ),
    sourceBatchId: normalizePredictionAliasedField(
      payload,
      ['sourceBatchId', 'source_batch_id'],
      'sourceBatchId',
      (value) => normalizePositiveInteger(value, 'sourceBatchId')
    )
  };
}

/** 规范化运行输入，禁止调用方提供或覆写预测结果。 */
function normalizePredictionPayload(payload = {}) {
  const algorithm = hasOwnPredictionField(payload, 'algorithm')
    ? normalizePredictionAliasedField(
      payload,
      ['algorithm'],
      'algorithm',
      normalizePredictionAlgorithm
    )
    : normalizePredictionAlgorithm(undefined);
  const trainStartMonth = normalizePredictionAliasedField(
    payload,
    ['trainStartMonth', 'train_start_month'],
    'trainStartMonth',
    (value) => normalizeMonth(value, 'trainStartMonth')
  );
  const trainEndMonth = normalizePredictionAliasedField(
    payload,
    ['trainEndMonth', 'train_end_month'],
    'trainEndMonth',
    (value) => normalizeMonth(value, 'trainEndMonth')
  );
  const predictStartMonth = normalizePredictionAliasedField(
    payload,
    ['predictStartMonth', 'predict_start_month'],
    'predictStartMonth',
    (value) => normalizeMonth(value, 'predictStartMonth')
  );
  const predictEndMonth = normalizePredictionAliasedField(
    payload,
    ['predictEndMonth', 'predict_end_month'],
    'predictEndMonth',
    (value) => normalizeMonth(value, 'predictEndMonth')
  );
  const missingFields = [['trainStartMonth', trainStartMonth], ['trainEndMonth', trainEndMonth], ['predictStartMonth', predictStartMonth], ['predictEndMonth', predictEndMonth]].filter(([, value]) => !value).map(([key]) => key);
  if (missingFields.length) throw badRequest('创建预测运行必须提供训练月份和预测月份范围。', { code: 'REQUIRED_PREDICTION_MONTH_RANGE', missingFields });
  const { trainMonths, predictionMonths } = validatePredictionRange({ trainStartMonth, trainEndMonth, predictStartMonth, predictEndMonth });
  const normalizedWindowSize = normalizePredictionAliasedField(
    payload,
    ['windowSize', 'window_size'],
    'windowSize',
    (value) => normalizePositiveInteger(value, 'windowSize', { min: 2, max: 12 })
  );
  const windowSize = algorithm === 'moving_average' ? (normalizedWindowSize ?? 3) : undefined;
  const filters = normalizeTrainingFilters(payload);
  const requiredHistoryMonths = algorithm === 'moving_average' ? resolveMovingAverageRequiredHistoryMonths(windowSize) : 3;
  return { name: normalizeText(payload.name) || `轻量预测 ${filters.energyTypeCode || '全部能源'} ${predictStartMonth}~${predictEndMonth}`, note: nullableText(payload.note ?? payload.remark), algorithm, trainStartMonth, trainEndMonth, predictStartMonth, predictEndMonth, trainMonths, predictionMonths, windowSize, filters, requiredHistoryMonths };
}

function resolveEnergyTypeId(db, energyTypeCode) {
  if (!energyTypeCode) return null;
  const energyType = db.prepare('SELECT id, is_active AS isActive FROM energy_types WHERE code = ?').get(energyTypeCode);
  if (!energyType) throw badRequest('未找到 energyTypeCode 对应的能源类型。', { code: 'UNKNOWN_ENERGY_TYPE', energyTypeCode });
  if (Number(energyType.isActive) !== 1) throw badRequest('能源类型已停用，不能创建预测配置或运行。', { code: 'INACTIVE_ENERGY_TYPE', energyTypeCode });
  return energyType.id;
}

function resolveOrganizationUnitId(db, filters) {
  if (filters.organizationUnitId) {
    const row = db.prepare("SELECT id, unit_code AS unitCode, status FROM organization_units WHERE id = ?").get(filters.organizationUnitId);
    if (!row) throw badRequest('用能单元不存在。', { code: 'UNKNOWN_ORGANIZATION_UNIT', organizationUnitId: filters.organizationUnitId });
    if (row.status !== 'active') throw badRequest('用能单元已停用。', { code: 'INACTIVE_ORGANIZATION_UNIT', organizationUnitId: filters.organizationUnitId });
    if (filters.organizationUnitCode && row.unitCode !== filters.organizationUnitCode) throw badRequest('用能单元编码与 ID 不一致。', { code: 'ORGANIZATION_UNIT_BINDING_MISMATCH' });
    return row.id;
  }
  if (!filters.organizationUnitCode) return null;
  const row = db.prepare("SELECT id, status FROM organization_units WHERE unit_code = ?").get(filters.organizationUnitCode);
  if (!row) throw badRequest('用能单元编码不存在。', { code: 'UNKNOWN_ORGANIZATION_UNIT_CODE', organizationUnitCode: filters.organizationUnitCode });
  if (row.status !== 'active') throw badRequest('用能单元已停用。', { code: 'INACTIVE_ORGANIZATION_UNIT', organizationUnitCode: filters.organizationUnitCode });
  return row.id;
}

function resolveMeterDeviceId(db, filters, energyTypeId, organizationUnitId) {
  if (!filters.meterDeviceId && !filters.meterCode) return null;
  const row = filters.meterDeviceId
    ? db.prepare('SELECT id, meter_code AS meterCode, energy_type_id AS energyTypeId, organization_unit_id AS organizationUnitId, status FROM meter_devices WHERE id = ?').get(filters.meterDeviceId)
    : db.prepare('SELECT id, meter_code AS meterCode, energy_type_id AS energyTypeId, organization_unit_id AS organizationUnitId, status FROM meter_devices WHERE meter_code = ?').get(filters.meterCode);
  if (!row) throw badRequest('计量器具不存在。', { code: 'UNKNOWN_METER_DEVICE', meterDeviceId: filters.meterDeviceId, meterCode: filters.meterCode });
  if (row.status !== 'active') throw badRequest('计量器具已停用。', { code: 'INACTIVE_METER_DEVICE', meterDeviceId: row.id });
  if (filters.meterCode && row.meterCode !== filters.meterCode) throw badRequest('计量器具编码与 ID 不一致。', { code: 'METER_BINDING_MISMATCH' });
  if (energyTypeId && Number(row.energyTypeId) !== Number(energyTypeId)) throw badRequest('计量器具能源类型不一致。', { code: 'METER_ENERGY_TYPE_MISMATCH' });
  if (organizationUnitId && Number(row.organizationUnitId) !== Number(organizationUnitId)) throw badRequest('计量器具不属于指定用能单元。', { code: 'METER_ORGANIZATION_UNIT_MISMATCH' });
  return row.id;
}

function buildHistoryWhere(normalizedPayload) {
  const where = ["er.record_status = 'active'", 'er.normalized_month >= @trainStartMonth', 'er.normalized_month <= @trainEndMonth'];
  const params = { trainStartMonth: normalizedPayload.trainStartMonth, trainEndMonth: normalizedPayload.trainEndMonth };
  const filters = normalizedPayload.filters;
  if (filters.energyTypeCode) { where.push('et.code = @energyTypeCode'); params.energyTypeCode = filters.energyTypeCode; }
  if (filters.organizationUnitId) { where.push('er.organization_unit_id = @organizationUnitId'); params.organizationUnitId = filters.organizationUnitId; }
  if (filters.meterDeviceId) { where.push('er.meter_device_id = @meterDeviceId'); params.meterDeviceId = filters.meterDeviceId; }
  if (filters.sourceBatchId) { where.push('er.source_batch_id = @sourceBatchId'); params.sourceBatchId = filters.sourceBatchId; }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

/** 对 exact summary、capability metadata 和 witness facts 做递归冻结复制。 */
function cloneFrozenPredictionSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozenPredictionSnapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, cloneFrozenPredictionSnapshot(item)]
    ))));
  }
  return value;
}

/** 构造 active energy_record 持久事实完整性错误。 */
function throwPredictionHistoryIntegrityError(row, fieldName, reason) {
  throw badRequest('预测历史记录存在不符合 schema 业务口径的持久事实，已阻断预测。', {
    code: 'PREDICTION_HISTORY_DATA_INTEGRITY_ERROR',
    recordId: typeof row?.id === 'number' && Number.isSafeInteger(row.id) ? row.id : null,
    fieldName,
    reason
  });
}

/** 严格读取数据库正整数，禁止 Number 隐式转换和不安全整数。 */
function requirePredictionHistoryPositiveInteger(row, fieldName, options = {}) {
  const value = row[fieldName];
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throwPredictionHistoryIntegrityError(row, fieldName, '必须是数据库原生安全正整数。');
  }
  return value;
}

/** 严格读取数据库有限非负数，禁止 text、空串、boolean 和非有限值。 */
function requirePredictionHistoryNonNegativeNumber(row, fieldName) {
  const value = row[fieldName];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throwPredictionHistoryIntegrityError(row, fieldName, '必须是数据库原生有限非负 number。');
  }
  return value;
}

/** 严格读取数据库字符串；可选字段只允许显式 null。 */
function requirePredictionHistoryString(row, fieldName, options = {}) {
  const value = row[fieldName];
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'string' || (options.allowEmpty !== true && value.trim() === '')) {
    throwPredictionHistoryIntegrityError(row, fieldName, '必须是符合字段口径的数据库原生字符串。');
  }
  return value;
}

/** 严格读取 YYYY-MM 月份且禁止自动 trim 或类型转换。 */
function requirePredictionHistoryMonth(row, fieldName) {
  const value = requirePredictionHistoryString(row, fieldName);
  if (normalizeMonth(value, fieldName) !== value) {
    throwPredictionHistoryIntegrityError(row, fieldName, '必须是严格 YYYY-MM 月份。');
  }
  return value;
}

/** 严格保留导入月份原值，不把追溯字段重新解释为 canonical 月份。 */
function requirePredictionHistoryOriginalMonth(row) {
  const value = row.originalMonth;
  const codePointLength = typeof value === 'string' ? Array.from(value).length : 0;
  if (typeof value !== 'string' || value.trim() === '' || codePointLength > 128
    || /\p{Cc}/u.test(value)) {
    throwPredictionHistoryIntegrityError(
      row,
      'originalMonth',
      '必须是 1-128 个 Unicode 字符且不含控制字符的数据库原生非空字符串。'
    );
  }
  return value;
}

/** 将单条 active energy_record 投影为通过完整性校验的稳定 exact lineage 快照。 */
function mapExactTrainingRecord(row) {
  const standardUnit = requirePredictionHistoryString(row, 'standardUnit');
  const normalizedUnit = requirePredictionHistoryString(row, 'normalizedUnit');
  if (normalizedUnit !== standardUnit) {
    throwPredictionHistoryIntegrityError(
      row,
      'normalizedUnit',
      'normalized_unit 必须严格等于 energy_types.standard_unit，不在预测域自动换算。'
    );
  }
  const recordStatus = requirePredictionHistoryString(row, 'recordStatus');
  if (recordStatus !== 'active') {
    throwPredictionHistoryIntegrityError(row, 'recordStatus', 'exact 历史集合只允许 active 记录。');
  }
  const meterDeviceId = requirePredictionHistoryPositiveInteger(row, 'meterDeviceId', { nullable: true });
  const meterCode = requirePredictionHistoryString(row, 'meterCode', { nullable: true });
  const meterName = requirePredictionHistoryString(row, 'meterName', { nullable: true });
  if ((meterDeviceId === null && (meterCode !== null || meterName !== null))
    || (meterDeviceId !== null && (meterCode === null || meterName === null))) {
    throwPredictionHistoryIntegrityError(row, 'meterDeviceId', '计量器具 ID 与关联名称事实不一致。');
  }
  return {
    id: requirePredictionHistoryPositiveInteger(row, 'id'),
    sourceBatchId: requirePredictionHistoryPositiveInteger(row, 'sourceBatchId', { nullable: true }),
    sourceRowNumber: requirePredictionHistoryPositiveInteger(row, 'sourceRowNumber', { nullable: true }),
    energyTypeId: requirePredictionHistoryPositiveInteger(row, 'energyTypeId'),
    energyTypeCode: requirePredictionHistoryString(row, 'energyTypeCode'),
    energyTypeName: requirePredictionHistoryString(row, 'energyTypeName'),
    organizationUnitId: requirePredictionHistoryPositiveInteger(row, 'organizationUnitId'),
    organizationUnitCode: requirePredictionHistoryString(row, 'organizationUnitCode'),
    organizationUnitName: requirePredictionHistoryString(row, 'organizationUnitName'),
    organizationUnitPath: requirePredictionHistoryString(row, 'organizationUnitPath'),
    meterDeviceId,
    meterCode,
    meterName,
    originalMonth: requirePredictionHistoryOriginalMonth(row),
    normalizedMonth: requirePredictionHistoryMonth(row, 'normalizedMonth'),
    originalUnit: requirePredictionHistoryString(row, 'originalUnit'),
    originalValue: requirePredictionHistoryNonNegativeNumber(row, 'originalValue'),
    normalizedUnit: standardUnit,
    normalizedValue: requirePredictionHistoryNonNegativeNumber(row, 'normalizedValue'),
    remark: requirePredictionHistoryString(row, 'remark', { nullable: true, allowEmpty: true }),
    duplicateKey: requirePredictionHistoryString(row, 'duplicateKey'),
    recordStatus,
    createdAt: requirePredictionHistoryString(row, 'createdAt'),
    updatedAt: requirePredictionHistoryString(row, 'updatedAt')
  };
}

/**
 * 一次历史 SQL 读取同一快照内的精确原始行，再由该行集合生成原有月度聚合 points。
 * 聚合和 lineage 不再通过两次宽查询分别推导。
 */
function loadHistoricalGroups(db, payload) {
  const energyTypeId = resolveEnergyTypeId(db, payload.filters.energyTypeCode);
  const organizationUnitId = resolveOrganizationUnitId(db, payload.filters);
  const meterDeviceId = resolveMeterDeviceId(db, payload.filters, energyTypeId, organizationUnitId);
  const resolvedPayload = { ...payload, filters: { ...payload.filters, organizationUnitId, meterDeviceId } };
  const { whereSql, params } = buildHistoryWhere(resolvedPayload);
  const rows = db.prepare(`SELECT er.id, er.source_batch_id AS sourceBatchId,
      er.source_row_number AS sourceRowNumber, er.energy_type_id AS energyTypeId,
      et.code AS energyTypeCode, et.name AS energyTypeName,
      et.standard_unit AS standardUnit, et.display_order AS energyTypeDisplayOrder,
      er.organization_unit_id AS organizationUnitId, ou.unit_code AS organizationUnitCode,
      ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath,
      er.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName,
      er.original_month AS originalMonth, er.normalized_month AS normalizedMonth,
      er.original_unit AS originalUnit, er.original_value AS originalValue,
      er.normalized_unit AS normalizedUnit, er.normalized_value AS normalizedValue,
      er.remark, er.duplicate_key AS duplicateKey, er.record_status AS recordStatus,
      er.created_at AS createdAt, er.updated_at AS updatedAt
    FROM energy_records er
    JOIN energy_types et ON et.id = er.energy_type_id
    JOIN organization_units ou ON ou.id = er.organization_unit_id
    LEFT JOIN meter_devices md ON md.id = er.meter_device_id
    ${whereSql}
    ORDER BY et.display_order, et.code, er.normalized_unit, er.normalized_month, er.id`).all(params);
  const groups = new Map();
  rows.forEach((row) => {
    const trainingRecord = mapExactTrainingRecord(row);
    const key = `${trainingRecord.energyTypeId}:${trainingRecord.normalizedUnit}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        energyTypeId: trainingRecord.energyTypeId,
        energyTypeCode: trainingRecord.energyTypeCode,
        energyTypeName: trainingRecord.energyTypeName,
        unit: trainingRecord.normalizedUnit,
        records: [],
        monthPoints: new Map()
      });
    }
    const group = groups.get(key);
    group.records.push(trainingRecord);
    const point = group.monthPoints.get(trainingRecord.normalizedMonth) || {
      month: trainingRecord.normalizedMonth,
      value: 0,
      recordCount: 0
    };
    const aggregatedValue = point.value + trainingRecord.normalizedValue;
    if (!Number.isFinite(aggregatedValue)) {
      throwPredictionHistoryIntegrityError(
        row,
        'normalizedValue',
        '同月 normalized_value 聚合产生非有限结果。'
      );
    }
    point.value = aggregatedValue;
    point.recordCount += 1;
    group.monthPoints.set(trainingRecord.normalizedMonth, point);
  });
  return {
    targetEnergyTypeId: energyTypeId,
    groups: [...groups.values()].map((group) => ({
      key: group.key,
      energyTypeId: group.energyTypeId,
      energyTypeCode: group.energyTypeCode,
      energyTypeName: group.energyTypeName,
      unit: group.unit,
      points: [...group.monthPoints.values()].map((point) => ({
        ...point,
        value: point.value
      })),
      records: group.records
    }))
  };
}

/** 将算法输出规范为持久化前完整 forecast fact，并重算 confidence 与正式文案。 */
function buildPredictionExpectedForecastFact(payload, group, forecast) {
  const confidence = buildPredictionConfidenceFacts(payload.algorithm, forecast.predictedValue);
  const commonFact = {
    algorithm: payload.algorithm,
    groupKey: group.key,
    energyTypeId: group.energyTypeId,
    energyTypeCode: group.energyTypeCode,
    canonicalUnit: group.unit,
    targetMonth: forecast.targetMonth,
    roundingDigits: PREDICTION_ROUNDING_DIGITS,
    predictedValue: forecast.predictedValue,
    confidenceLowMultiplier: confidence.confidenceLowMultiplier,
    confidenceHighMultiplier: confidence.confidenceHighMultiplier,
    confidenceLowRaw: confidence.confidenceLowRaw,
    confidenceHighRaw: confidence.confidenceHighRaw,
    confidenceLow: confidence.confidenceLow,
    confidenceHigh: confidence.confidenceHigh
  };
  if (!isPredictionRoundedValue(forecast.predictedValue, { nonNegative: true })
    || forecast.roundingDigits !== PREDICTION_ROUNDING_DIGITS
    || forecast.confidenceLowMultiplier !== confidence.confidenceLowMultiplier
    || forecast.confidenceHighMultiplier !== confidence.confidenceHighMultiplier
    || forecast.confidenceLow !== confidence.confidenceLow
    || forecast.confidenceHigh !== confidence.confidenceHigh) {
    throw badRequest('Prediction forecast 未满足固定六位舍入与 confidence 合同。', {
      code: 'PREDICTION_FORECAST_FACT_MISMATCH'
    });
  }
  if (payload.algorithm === 'moving_average') {
    const calculation = {
      windowSize: payload.windowSize,
      sourceValues: forecast.sourceValues,
      rawPredictedValue: forecast.rawPredictedValue
    };
    const methodFact = {
      algorithm: payload.algorithm,
      windowSize: payload.windowSize,
      sampleCount: null,
      signedSlope: null,
      clampedToZero: false
    };
    if (forecast.algorithm !== payload.algorithm || forecast.windowSize !== payload.windowSize
      || forecast.sampleCount !== null || forecast.signedSlope !== null
      || forecast.clampedToZero !== false || forecast.methodNote !== formatPredictionForecastMethodNote(methodFact)) {
      throw badRequest('Prediction moving average forecast 结构事实不一致。', {
        code: 'PREDICTION_FORECAST_FACT_MISMATCH'
      });
    }
    return cloneFrozenPredictionSnapshot({
      ...commonFact,
      ...methodFact,
      calculation,
      methodNote: formatPredictionForecastMethodNote(methodFact, {
        energyTypeCode: group.energyTypeCode,
        canonicalUnit: group.unit
      })
    });
  }
  const methodFact = {
    algorithm: payload.algorithm,
    windowSize: null,
    sampleCount: group.sufficiency.sampleMonths,
    signedSlope: forecast.signedSlope,
    clampedToZero: forecast.clampedToZero
  };
  const calculation = {
    sampleCount: forecast.sampleCount,
    sourceValues: forecast.sourceValues,
    targetIndex: forecast.targetIndex,
    intercept: forecast.intercept,
    rawSlope: forecast.rawSlope,
    signedSlope: forecast.signedSlope,
    rawPredictedValue: forecast.rawPredictedValue,
    clampedToZero: forecast.clampedToZero
  };
  if (forecast.algorithm !== payload.algorithm || forecast.windowSize !== null
    || forecast.sampleCount !== group.sufficiency.sampleMonths
    || forecast.signedSlope !== roundSignedPredictionValue(forecast.rawSlope)
    || forecast.clampedToZero !== (forecast.rawPredictedValue < 0)
    || forecast.methodNote !== formatPredictionForecastMethodNote(methodFact)) {
    throw badRequest('Prediction linear trend forecast 结构事实不一致。', {
      code: 'PREDICTION_FORECAST_FACT_MISMATCH'
    });
  }
  return cloneFrozenPredictionSnapshot({
    ...commonFact,
    ...methodFact,
    calculation,
    methodNote: formatPredictionForecastMethodNote(methodFact, {
      energyTypeCode: group.energyTypeCode,
      canonicalUnit: group.unit
    })
  });
}

/** 使用与 execute 完全一致的筛选、分组、连续性、充分性和算法生成私有 inspect 事实。 */
function inspectNormalizedPrediction(db, payload, configSnapshot = null) {
  const history = loadHistoricalGroups(db, payload);
  const groups = history.groups;
  const warnings = [];
  const eligibleGroups = [];
  const skippedGroups = [];
  groups.forEach((group) => {
    const sufficiency = summarizeHistorySufficiency(group.points, payload.trainMonths, {
      minHistoryMonths: payload.requiredHistoryMonths
    });
    const label = `${group.energyTypeCode}/${group.unit}`;
    if (!sufficiency.sufficient) {
      const skippedGroup = { group: label, groupKey: group.key, ...sufficiency };
      skippedGroups.push(skippedGroup);
      warnings.push(`${label} ${sufficiency.warnings.join('；')}`);
      return;
    }
    sufficiency.warnings.forEach((warning) => warnings.push(`${label} ${warning}`));
    const historyWarnings = detectHistoryWarnings(group.points);
    historyWarnings.forEach((warning) => warnings.push(`${label} ${warning}`));
    const forecasts = buildForecast(group.points, payload.predictionMonths, {
      algorithm: payload.algorithm,
      windowSize: payload.windowSize
    });
    eligibleGroups.push({
      ...group,
      label,
      sufficiency,
      historyWarnings,
      forecasts
    });
  });
  const exactTrainingRecords = groups.flatMap((group) => group.records)
    .sort((left, right) => left.id - right.id);
  const expectedForecastFacts = eligibleGroups.flatMap((group) => (
    group.forecasts.map((forecast) => buildPredictionExpectedForecastFact(payload, group, forecast))
  ));
  const expectedResultCount = expectedForecastFacts.length;
  const blockers = [];
  if (groups.length === 0) {
    blockers.push({
      code: 'PREDICTION_EXACT_NO_HISTORY',
      message: '未找到符合筛选条件的 active 历史能耗记录。'
    });
  } else if (eligibleGroups.length === 0) {
    blockers.push({
      code: 'PREDICTION_EXACT_NO_ELIGIBLE_GROUPS',
      message: '全部历史分组均不满足预测算法的最小样本要求。'
    });
  }
  return cloneFrozenPredictionSnapshot({
    normalizedPayload: payload,
    configSnapshot,
    targetEnergyTypeId: history.targetEnergyTypeId,
    groups,
    eligibleGroups,
    skippedGroups,
    exactTrainingRecords,
    expectedForecastFacts,
    expectedResultCount,
    warnings,
    blockers,
    executable: blockers.length === 0 && expectedResultCount > 0
  });
}

function serializeRunParameters(payload, warnings = [], configSnapshot = null) {
  return JSON.stringify({ algorithm: payload.algorithm, windowSize: payload.windowSize ?? null, filters: payload.filters, trainMonths: payload.trainMonths, predictionMonths: payload.predictionMonths, requiredHistoryMonths: payload.requiredHistoryMonths, configSnapshot, warnings });
}

function createRunRow(db, payload, targetEnergyTypeId, configSnapshot = null) {
  return Number(db.prepare(`INSERT INTO prediction_runs (name, algorithm, status, target_energy_type_id, train_start_month, train_end_month, predict_start_month, predict_end_month, parameters_json, note) VALUES (@name, @algorithm, 'running', @targetEnergyTypeId, @trainStartMonth, @trainEndMonth, @predictStartMonth, @predictEndMonth, @parametersJson, @note)`).run({ name: payload.name, algorithm: payload.algorithm, targetEnergyTypeId, trainStartMonth: payload.trainStartMonth, trainEndMonth: payload.trainEndMonth, predictStartMonth: payload.predictStartMonth, predictEndMonth: payload.predictEndMonth, parametersJson: serializeRunParameters(payload, [], configSnapshot), note: payload.note || '轻量预测运行已创建，计算结果仅作本地趋势参考。' }).lastInsertRowid);
}

function updateRunStatus(db, runId, status, note, parametersJson) {
  db.prepare(`UPDATE prediction_runs SET status = @status, completed_at = CASE WHEN @status IN ('completed', 'failed', 'cancelled') THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE completed_at END, parameters_json = @parametersJson, note = @note WHERE id = @runId`).run({ runId, status, note, parametersJson });
}

/** 保存一个 exact 分组的固定预测结果并返回稳定结果 ID。 */
function saveForecastResults(db, runId, group, rows) {
  const insert = db.prepare('INSERT INTO prediction_results (prediction_run_id, energy_type_id, target_month, predicted_value, predicted_unit, confidence_low, confidence_high, method_note) VALUES (@runId, @energyTypeId, @targetMonth, @predictedValue, @predictedUnit, @confidenceLow, @confidenceHigh, @methodNote)');
  return rows.map((row) => Number(insert.run({
    runId,
    energyTypeId: group.energyTypeId,
    targetMonth: row.targetMonth,
    predictedValue: row.predictedValue,
    predictedUnit: group.unit,
    confidenceLow: row.confidenceLow,
    confidenceHigh: row.confidenceHigh,
    methodNote: formatPredictionForecastMethodNote(row, {
      energyTypeCode: group.energyTypeCode,
      canonicalUnit: group.unit
    })
  }).lastInsertRowid));
}

/** 把共享 inspect 事实持久化为普通或 exact 预测运行。 */
function persistInspectedPrediction(db, inspection, options = {}) {
  const payload = inspection.normalizedPayload;
  const configSnapshot = inspection.configSnapshot;
  if (options.requireCompleted === true && !inspection.executable) {
    throw badRequest('exact 预测 inspect 已判定当前输入不可执行。', {
      code: 'PREDICTION_EXACT_NOT_EXECUTABLE',
      blockers: inspection.blockers
    });
  }
  const runId = createRunRow(db, payload, inspection.targetEnergyTypeId, configSnapshot);
  const createdGroups = [];
  const resultIds = [];
  inspection.eligibleGroups.forEach((group) => {
    const groupForecastFacts = inspection.expectedForecastFacts.filter((fact) => fact.groupKey === group.key);
    const groupResultIds = saveForecastResults(db, runId, group, groupForecastFacts);
    resultIds.push(...groupResultIds);
    createdGroups.push({
      group: group.label,
      energyTypeId: group.energyTypeId,
      energyTypeCode: group.energyTypeCode,
      unit: group.unit,
      sampleMonths: group.sufficiency.sampleMonths,
      resultCount: groupResultIds.length,
      warnings: group.sufficiency.warnings
    });
  });
  if (!createdGroups.length) {
    const noHistory = inspection.groups.length === 0;
    const note = noHistory
      ? '未找到符合筛选条件的历史能耗记录，预测运行失败，未写入预测结果。'
      : `历史样本月份不足，预测运行失败，未写入预测结果。${inspection.warnings.join('；')}`;
    const finalWarnings = inspection.warnings.length ? inspection.warnings : [note];
    updateRunStatus(db, runId, 'failed', note, serializeRunParameters(payload, finalWarnings, configSnapshot));
    return {
      run: getPredictionRunById(db, runId),
      summary: { status: 'failed', resultCount: 0, skippedGroups: inspection.skippedGroups, warnings: finalWarnings },
      resultIds
    };
  }
  const resultCount = resultIds.length;
  const note = [`预测完成：生成 ${resultCount} 条结果。`, '算法为本地轻量趋势/移动平均，不代表高精度 AI 或机器学习预测。', inspection.warnings.length ? `提示：${inspection.warnings.join('；')}` : null].filter(Boolean).join(' ');
  updateRunStatus(db, runId, 'completed', note, serializeRunParameters(payload, inspection.warnings, configSnapshot));
  const execution = {
    run: getPredictionRunById(db, runId),
    summary: {
      status: 'completed',
      resultCount,
      groups: createdGroups,
      skippedGroups: inspection.skippedGroups,
      warnings: inspection.warnings
    },
    resultIds
  };
  if (options.requireCompleted === true
    && (execution.run?.status !== 'completed' || execution.summary.resultCount <= 0
      || execution.summary.resultCount !== inspection.expectedResultCount)) {
    throw badRequest('exact 预测执行未产生 completed 且非空的固定结果集合。', {
      code: 'PREDICTION_EXACT_COMPLETION_INVARIANT_FAILED',
      status: execution.run?.status || null,
      resultCount: execution.summary.resultCount,
      expectedResultCount: inspection.expectedResultCount
    });
  }
  return execution;
}

/** 仅由后端基于一次 exact 历史快照生成普通管理 API 结果。 */
function runNormalizedPrediction(db, payload, configSnapshot = null) {
  return persistInspectedPrediction(
    db,
    inspectNormalizedPrediction(db, payload, configSnapshot),
    { requireCompleted: false }
  );
}

function createPredictionRun(payload = {}) {
  const normalized = normalizePredictionPayload(payload); const db = openDatabase();
  try { return db.transaction(() => runNormalizedPrediction(db, normalized))(); } finally { db.close(); }
}

/** 判断私有协议输入是否为无 Proxy、无自定义原型的普通对象。 */
function isPredictionExactObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 私有协议入口仅接受固定数据字段，拒绝访问器、Symbol 和附加控制参数。 */
function assertPredictionExactProtocolFields(input, expectedFields, code, message) {
  if (!isPredictionExactObject(input)) throw badRequest(message, { code });
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actualFields = Object.keys(descriptors).sort();
  const normalizedExpectedFields = [...expectedFields].sort();
  const hasAccessor = actualFields.some((fieldName) => (
    typeof descriptors[fieldName].get === 'function' || typeof descriptors[fieldName].set === 'function'
  ));
  const hasSymbolFields = Object.getOwnPropertySymbols(input).length > 0;
  if (hasAccessor || hasSymbolFields || actualFields.length !== normalizedExpectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== normalizedExpectedFields[index])) {
    throw badRequest(message, {
      code,
      expectedFields: normalizedExpectedFields,
      actualFields,
      hasAccessor,
      hasSymbolFields
    });
  }
  return input;
}

/** 对 invocation 身份对象做严格 canonicalize，拒绝 Proxy、cycle 与不稳定类型。 */
function canonicalizePredictionExactIdentity(value, path = 'identity', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw badRequest('Prediction exact invocation 身份包含非有限数值。', {
        code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
        path
      });
    }
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw badRequest('Prediction exact invocation 身份包含不支持的值类型。', {
      code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
      path,
      valueType: typeof value
    });
  }
  if (seen.has(value)) {
    throw badRequest('Prediction exact invocation 身份不能包含循环引用。', {
      code: 'PREDICTION_EXACT_IDENTITY_CYCLE',
      path
    });
  }
  const isArrayValue = Array.isArray(value);
  const expectedPrototype = isArrayValue ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) {
    throw badRequest('Prediction exact invocation 身份只能包含原生普通对象或原生数组。', {
      code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
      path
    });
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw badRequest('Prediction exact invocation 身份不能包含 Symbol 字段。', {
      code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
      path
    });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const expectedIndexKeys = Array.from({ length: value.length }, (_item, index) => String(index));
      const actualIndexKeys = Object.keys(descriptors).filter((key) => key !== 'length');
      if (actualIndexKeys.length !== expectedIndexKeys.length
        || actualIndexKeys.some((key, index) => key !== expectedIndexKeys[index])) {
        throw badRequest('Prediction exact invocation 身份数组不能包含空洞、附加字段或访问器。', {
          code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
          path
        });
      }
      return expectedIndexKeys.map((key) => {
        const descriptor = descriptors[key];
        if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
          throw badRequest('Prediction exact invocation 身份数组不能包含访问器。', {
            code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
            path: `${path}[${key}]`
          });
        }
        return canonicalizePredictionExactIdentity(descriptor.value, `${path}[${key}]`, seen);
      });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const canonical = {};
    keys.forEach((key) => {
      const descriptor = descriptors[key];
      if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
        throw badRequest('Prediction exact invocation 身份不能包含访问器字段。', {
          code: 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID',
          path: `${path}.${key}`
        });
      }
      canonical[key] = canonicalizePredictionExactIdentity(descriptor.value, `${path}.${key}`, seen);
    });
    return canonical;
  } finally {
    seen.delete(value);
  }
}

/** 生成 invocation 身份对象的稳定冻结摘要。 */
function buildPredictionExactIdentityDigest(value, fieldName) {
  return stableStringify(cloneFrozenPredictionSnapshot(
    canonicalizePredictionExactIdentity(value, fieldName)
  ));
}

/** 只接受 database 模块创建且仍打开的原始 better-sqlite3 连接。 */
function assertPredictionExactDatabase(db) {
  if (!databaseRawConnectionInternalProtocol
    || typeof databaseRawConnectionInternalProtocol.isOpenRawDatabaseConnection !== 'function'
    || !predictionDatabaseTransactionProtocol
    || typeof predictionDatabaseTransactionProtocol.createTransactionObligation !== 'function'
    || typeof predictionDatabaseTransactionProtocol.completeTransactionObligation !== 'function'
    || typeof predictionDatabaseTransactionProtocol.readTotalChanges !== 'function'
    || typeof predictionDatabaseTransactionProtocol.releaseSavepointWithObligations !== 'function'
    || !databaseRawConnectionInternalProtocol.isOpenRawDatabaseConnection(db)) {
    throw badRequest('Prediction exact core 必须使用数据库抽象创建的原始 SQLite 连接。', {
      code: 'PREDICTION_EXACT_RAW_DATABASE_REQUIRED'
    });
  }
  return db;
}

/** 创建不含调用方输入的私有 SAVEPOINT 名称。 */
function createPredictionExactSavepointName(stage) {
  return `prediction_exact_${stage}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 返回当前 exact scope 持有的全部 pending opaque obligation，作为私有 RELEASE authority。 */
function readPredictionExactReleaseObligations(scopeState) {
  const obligations = [];
  if (scopeState.scopeFinalizationObligationActive) {
    obligations.push(scopeState.scopeFinalizationObligation);
  }
  scopeState.obligations.forEach((obligation) => {
    const obligationState = PREDICTION_COMPLETION_OBLIGATION_STATE.get(obligation);
    if (obligationState?.status === 'pending') obligations.push(obligation);
  });
  return obligations;
}

/** 仅以当前 exact scope 的全部 opaque obligation 释放一个私有 SAVEPOINT。 */
function releasePredictionExactSavepoint(scopeState, savepointName) {
  return predictionDatabaseTransactionProtocol.releaseSavepointWithObligations(
    scopeState.db,
    readPredictionExactReleaseObligations(scopeState),
    savepointName
  );
}

/** 私有 SAVEPOINT 无法恢复时完整回滚；无活动事务或完整回滚失败时关闭连接。 */
function failClosedPredictionExactTransaction(db) {
  let noActiveTransaction = false;
  let fullRollbackError = null;
  let closeError = null;
  try {
    if (db.inTransaction === true) db.exec('ROLLBACK');
    else noActiveTransaction = true;
  } catch (error) {
    fullRollbackError = error;
  }
  if (noActiveTransaction || fullRollbackError) {
    try {
      db.close();
    } catch (error) {
      closeError = error;
    }
  }
  return { noActiveTransaction, fullRollbackError, closeError };
}

/** 回滚并释放 exact 私有 SAVEPOINT；失败时完整回滚或关闭，禁止继续提交。 */
function recoverPredictionExactSavepoint(scopeState, savepointName) {
  const db = scopeState.db;
  let rollbackError = null;
  let releaseError = null;
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } catch (error) {
    rollbackError = error;
  }
  if (!rollbackError) {
    try {
      releasePredictionExactSavepoint(scopeState, savepointName);
    } catch (error) {
      releaseError = error;
    }
  }
  if (rollbackError || releaseError) {
    try {
      completePredictionExactTransactionObligations(scopeState, 'cancelled');
      completePredictionExactScopeFinalizationObligation(scopeState);
    } catch (_error) {
      // 完整回滚失败路径会关闭连接，不用 obligation 解除错误覆盖原恢复证据。
    }
  }
  const failClosed = rollbackError || releaseError
    ? failClosedPredictionExactTransaction(db)
    : { noActiveTransaction: false, fullRollbackError: null, closeError: null };
  return { rollbackError, releaseError, ...failClosed };
}

/** 将 scope 标记为不可成功返回，防止调用方捕获协议错误后提交 exact 写入。 */
function poisonPredictionExactScope(scopeState, code) {
  if (!scopeState || !['active', 'poisoned'].includes(scopeState.status)) return;
  scopeState.status = 'poisoned';
  scopeState.poisonCodes.add(code);
}

/** 完成 scope 内全部 pending P4 obligation，供成功 consume 或失败回滚解除事务门禁。 */
function completePredictionExactTransactionObligations(scopeState, finalStatus) {
  scopeState.obligations.forEach((obligation) => {
    const obligationState = PREDICTION_COMPLETION_OBLIGATION_STATE.get(obligation);
    if (!obligationState || obligationState.status !== 'pending') return;
    predictionDatabaseTransactionProtocol.completeTransactionObligation(scopeState.db, obligation);
    obligationState.status = finalStatus;
  });
}

/** 解除 callback 生命周期事务终结门禁，只允许 exact scope 自身进入收口或恢复。 */
function completePredictionExactScopeFinalizationObligation(scopeState) {
  if (!scopeState.scopeFinalizationObligationActive) return;
  predictionDatabaseTransactionProtocol.completeTransactionObligation(
    scopeState.db,
    scopeState.scopeFinalizationObligation
  );
  scopeState.scopeFinalizationObligationActive = false;
}

/** 对 scope 内未完成的 capability/witness 统一失效，阻止 callback 结束后的重放。 */
function expirePredictionExactScopeState(scopeState) {
  scopeState.capabilities.forEach((capability) => {
    const capabilityState = PREDICTION_EXACT_CAPABILITY_STATE.get(capability);
    if (capabilityState?.status === 'issued') capabilityState.status = 'expired';
  });
  scopeState.witnesses.forEach((witness) => {
    const witnessState = PREDICTION_COMPLETION_WITNESS_STATE.get(witness);
    if (witnessState && ['issued', 'read'].includes(witnessState.status)) witnessState.status = 'expired';
  });
}

/** 校验 demo run、action run 与 actor 均以原始普通对象身份绑定。 */
function assertPredictionExactInvocationObjects(input) {
  ['demoRun', 'actionRun', 'actor'].forEach((fieldName) => {
    if (!isPredictionExactObject(input[fieldName])) {
      throw badRequest('Prediction exact invocation 必须绑定原始 demo run、action run 与 actor 对象。', {
        code: 'PREDICTION_EXACT_INVOCATION_IDENTITY_REQUIRED',
        fieldName
      });
    }
  });
}

/** 校验当前 callback 生命周期内的 opaque transaction scope。 */
function requirePredictionExactTransactionScope(db, transactionScope) {
  const scopeState = transactionScope && typeof transactionScope === 'object'
    ? PREDICTION_EXACT_TRANSACTION_SCOPE_STATE.get(transactionScope)
    : null;
  if (!scopeState || !['active', 'poisoned'].includes(scopeState.status)) {
    throw badRequest('Prediction exact core 必须使用当前 callback 内的原始 transaction scope。', {
      code: 'PREDICTION_EXACT_TRANSACTION_SCOPE_REQUIRED'
    });
  }
  if (scopeState.status === 'poisoned') {
    throw badRequest('Prediction exact transaction scope 已被不可恢复的协议错误污染。', {
      code: 'PREDICTION_EXACT_SCOPE_POISONED',
      poisonCodes: [...scopeState.poisonCodes]
    });
  }
  if (scopeState.db !== db) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_TRANSACTION_SCOPE_DATABASE_MISMATCH');
    throw badRequest('Prediction exact transaction scope 与 SQLite 连接对象身份不一致。', {
      code: 'PREDICTION_EXACT_TRANSACTION_SCOPE_DATABASE_MISMATCH'
    });
  }
  if (db.inTransaction !== true) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_CALLER_TRANSACTION_REQUIRED');
    throw badRequest('Prediction exact transaction scope 已离开调用方事务。', {
      code: 'PREDICTION_EXACT_CALLER_TRANSACTION_REQUIRED'
    });
  }
  return scopeState;
}

/** 复核 invocation 对象引用与 scope 初始化时的严格业务身份摘要均未漂移。 */
function assertPredictionExactInvocationBinding(scopeState, input) {
  try {
    assertPredictionExactInvocationObjects(input);
    const referenceMatches = scopeState.demoRun === input.demoRun
      && scopeState.actionRun === input.actionRun
      && scopeState.actor === input.actor;
    const digestMatches = referenceMatches
      && scopeState.identityDigests.demoRun === buildPredictionExactIdentityDigest(input.demoRun, 'demoRun')
      && scopeState.identityDigests.actionRun === buildPredictionExactIdentityDigest(input.actionRun, 'actionRun')
      && scopeState.identityDigests.actor === buildPredictionExactIdentityDigest(input.actor, 'actor');
    if (!digestMatches) {
      throw badRequest('Prediction exact invocation 对象引用或业务身份事实已漂移。', {
        code: 'PREDICTION_EXACT_INVOCATION_BINDING_MISMATCH'
      });
    }
  } catch (error) {
    poisonPredictionExactScope(scopeState, error.details?.code || error.code || 'PREDICTION_EXACT_INVOCATION_BINDING_MISMATCH');
    throw error;
  }
}

/** 构造 scope 私有恢复失败错误，报告是否已完整回滚或关闭连接。 */
function createPredictionExactScopeRecoveryError(originalError, recovery) {
  return badRequest('Prediction exact transaction scope 恢复失败，已执行严格 fail-closed，禁止继续提交。', {
    code: 'PREDICTION_EXACT_SCOPE_RECOVERY_FAILED',
    originalCode: originalError.details?.code || originalError.code || null,
    rollbackCode: recovery.rollbackError?.code || null,
    releaseCode: recovery.releaseError?.code || null,
    noActiveTransaction: recovery.noActiveTransaction === true,
    fullRollbackCode: recovery.fullRollbackError?.code || null,
    closeCode: recovery.closeError?.code || null
  });
}

/**
 * 在调用方已有事务内建立同步 callback 生命周期门禁。
 * scope 只在 callback 中有效；正常路径不 BEGIN、COMMIT 或结束外层事务。
 */
function withPredictionExactCallerTransactionScope(input = {}, callback) {
  assertPredictionExactProtocolFields(
    input,
    ['db', 'demoRun', 'actionRun', 'actor'],
    'PREDICTION_EXACT_SCOPE_INPUT_INVALID',
    'Prediction exact transaction scope 只接受 db、demoRun、actionRun 和 actor。'
  );
  if (typeof callback !== 'function') {
    throw badRequest('Prediction exact transaction scope 必须提供同步 callback。', {
      code: 'PREDICTION_EXACT_SCOPE_CALLBACK_REQUIRED'
    });
  }
  const db = assertPredictionExactDatabase(input.db);
  if (db.inTransaction !== true) {
    throw badRequest('Prediction exact transaction scope 必须在调用方已有事务或 SAVEPOINT 中创建。', {
      code: 'PREDICTION_EXACT_CALLER_TRANSACTION_REQUIRED'
    });
  }
  assertPredictionExactInvocationObjects(input);
  const identityDigests = Object.freeze({
    demoRun: buildPredictionExactIdentityDigest(input.demoRun, 'demoRun'),
    actionRun: buildPredictionExactIdentityDigest(input.actionRun, 'actionRun'),
    actor: buildPredictionExactIdentityDigest(input.actor, 'actor')
  });
  const transactionScope = Object.freeze({});
  const scopeSavepoint = createPredictionExactSavepointName('scope');
  const scopeState = {
    db,
    demoRun: input.demoRun,
    actionRun: input.actionRun,
    actor: input.actor,
    identityDigests,
    scopeSavepoint,
    capabilities: new Set(),
    witnesses: new Set(),
    obligations: new Set(),
    scopeFinalizationObligation: null,
    scopeFinalizationObligationActive: false,
    poisonCodes: new Set(),
    status: 'active'
  };
  db.exec(`SAVEPOINT ${scopeSavepoint}`);
  scopeState.scopeFinalizationObligation =
    predictionDatabaseTransactionProtocol.createTransactionObligation(
      db,
      () => poisonPredictionExactScope(
        scopeState,
        'PREDICTION_EXACT_TRANSACTION_FINALIZATION_BLOCKED'
      )
    );
  scopeState.scopeFinalizationObligationActive = true;
  PREDICTION_EXACT_TRANSACTION_SCOPE_STATE.set(transactionScope, scopeState);
  try {
    const result = callback(transactionScope);
    if (result && typeof result.then === 'function') {
      throw badRequest('Prediction exact transaction scope callback 必须同步完成。', {
        code: 'PREDICTION_EXACT_SCOPE_CALLBACK_ASYNC_FORBIDDEN'
      });
    }
    if (scopeState.status !== 'active') {
      throw badRequest('Prediction exact transaction scope 已被协议错误污染，不能成功返回。', {
        code: 'PREDICTION_EXACT_SCOPE_POISONED',
        poisonCodes: [...scopeState.poisonCodes]
      });
    }
    const pendingObligation = [...scopeState.obligations].find((obligation) => {
      const obligationState = PREDICTION_COMPLETION_OBLIGATION_STATE.get(obligation);
      return obligationState?.status === 'pending';
    });
    if (pendingObligation) {
      throw badRequest('Prediction exact P4 receipt obligation 必须由 verifier 完整履行。', {
        code: 'PREDICTION_EXACT_P4_OBLIGATION_PENDING'
      });
    }
    const nonTerminalWitness = [...scopeState.witnesses].find((witness) => {
      const witnessState = PREDICTION_COMPLETION_WITNESS_STATE.get(witness);
      return witnessState && !['consumed', 'rolled_back'].includes(witnessState.status);
    });
    if (nonTerminalWitness) {
      throw badRequest('Prediction exact execute 的 completion witness 必须 consumed，或已证明 exact 写入回滚。', {
        code: 'PREDICTION_EXACT_COMPLETION_WITNESS_NOT_CONSUMED'
      });
    }
    try {
      releasePredictionExactSavepoint(scopeState, scopeSavepoint);
      completePredictionExactScopeFinalizationObligation(scopeState);
    } catch (error) {
      poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_SCOPE_MARKER_MISMATCH');
      throw badRequest('Prediction exact transaction scope marker 已失效。', {
        code: 'PREDICTION_EXACT_SCOPE_MARKER_MISMATCH',
        originalCode: error.code || null
      });
    }
    scopeState.status = 'completed';
    expirePredictionExactScopeState(scopeState);
    return result;
  } catch (error) {
    expirePredictionExactScopeState(scopeState);
    const recovery = recoverPredictionExactSavepoint(scopeState, scopeSavepoint);
    scopeState.status = 'failed';
    if (recovery.rollbackError || recovery.releaseError) {
      throw createPredictionExactScopeRecoveryError(error, recovery);
    }
    try {
      completePredictionExactTransactionObligations(scopeState, 'cancelled');
      completePredictionExactScopeFinalizationObligation(scopeState);
    } catch (obligationError) {
      let closeError = null;
      try {
        db.close();
      } catch (databaseCloseError) {
        closeError = databaseCloseError;
      }
      throw badRequest('Prediction exact pending obligation 解除失败，已关闭连接并禁止继续使用事务。', {
        code: 'PREDICTION_EXACT_OBLIGATION_RELEASE_FAILED',
        originalCode: error.details?.code || error.code || null,
        obligationCode: obligationError.code || null,
        closeCode: closeError?.code || null
      });
    }
    throw error;
  }
}

/** 规范化并冻结可选配置快照，调用方后续修改不能改变 capability 绑定。 */
function normalizePredictionExactConfigSnapshot(configSnapshot) {
  if (configSnapshot === null) return null;
  if (!isPredictionExactObject(configSnapshot)) {
    throw badRequest('Prediction exact configSnapshot 必须是对象或 null。', {
      code: 'PREDICTION_EXACT_CONFIG_SNAPSHOT_INVALID'
    });
  }
  return cloneFrozenPredictionSnapshot(configSnapshot);
}

/** 在当前 caller-owned scope 中签发一次性 exact inspect capability。 */
function inspectPredictionExactInCallerTransaction(input = {}) {
  assertPredictionExactProtocolFields(
    input,
    ['db', 'transactionScope', 'payload', 'configSnapshot'],
    'PREDICTION_EXACT_INSPECT_INPUT_INVALID',
    'Prediction exact inspect 只接受 db、transactionScope、payload 和 configSnapshot。'
  );
  const db = assertPredictionExactDatabase(input.db);
  const scopeState = requirePredictionExactTransactionScope(db, input.transactionScope);
  const normalizedPayload = normalizePredictionPayload(input.payload);
  const configSnapshot = normalizePredictionExactConfigSnapshot(input.configSnapshot);
  const inspection = inspectNormalizedPrediction(db, normalizedPayload, configSnapshot);
  const exactCapability = Object.freeze({});
  const transactionMarkerSavepoint = createPredictionExactSavepointName('capability');
  db.exec(`SAVEPOINT ${transactionMarkerSavepoint}`);
  PREDICTION_EXACT_CAPABILITY_STATE.set(exactCapability, {
    db,
    transactionScope: input.transactionScope,
    inspection,
    transactionMarkerSavepoint,
    status: 'issued'
  });
  scopeState.capabilities.add(exactCapability);
  return Object.freeze({ summary: inspection, exactCapability });
}

/** 在任何业务写入前领取并验证原始 inspect capability。 */
function requirePredictionExactCapability(input) {
  assertPredictionExactProtocolFields(
    input,
    ['db', 'transactionScope', 'exactCapability', 'demoRun', 'actionRun', 'actor'],
    'PREDICTION_EXACT_EXECUTE_INPUT_INVALID',
    'Prediction exact execute 只接受固定 caller-owned 协议字段。'
  );
  const db = assertPredictionExactDatabase(input.db);
  const scopeState = requirePredictionExactTransactionScope(db, input.transactionScope);
  assertPredictionExactInvocationBinding(scopeState, input);
  const capabilityState = input.exactCapability && typeof input.exactCapability === 'object'
    ? PREDICTION_EXACT_CAPABILITY_STATE.get(input.exactCapability)
    : null;
  if (!capabilityState) {
    throw badRequest('Prediction exact execute 必须使用 inspect 签发的原始 capability。', {
      code: 'PREDICTION_EXACT_CAPABILITY_REQUIRED'
    });
  }
  if (capabilityState.status !== 'issued') {
    throw badRequest('Prediction exact capability 已领取、过期或失效。', {
      code: 'PREDICTION_EXACT_CAPABILITY_REPLAY'
    });
  }
  if (capabilityState.db !== db || capabilityState.transactionScope !== input.transactionScope) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_CAPABILITY_BINDING_MISMATCH');
    throw badRequest('Prediction exact capability 与 DB 或 transaction scope 对象身份不一致。', {
      code: 'PREDICTION_EXACT_CAPABILITY_BINDING_MISMATCH'
    });
  }
  capabilityState.status = 'claimed';
  try {
    releasePredictionExactSavepoint(
      scopeState,
      capabilityState.transactionMarkerSavepoint
    );
  } catch (_error) {
    capabilityState.status = 'failed';
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_TRANSACTION_MISMATCH');
    throw badRequest('Prediction exact capability 不属于当前 caller transaction。', {
      code: 'PREDICTION_EXACT_TRANSACTION_MISMATCH'
    });
  }
  return { db, scopeState, capabilityState };
}

/** 读取 execute 新建 run/results 的固定持久事实，不重新查询训练 lineage。 */
function readPredictionCompletionRows(db, runId) {
  const run = getPredictionRunById(db, runId);
  const results = selectPredictionResultRows(db, { runId }, {
    limit: MAX_PREDICTION_EXPORT_ROWS,
    offset: 0
  });
  return cloneFrozenPredictionSnapshot({ run, results });
}

/** 将持久结果逐项绑定到持久化前 forecast facts，禁止由落库 DTO 反向自证。 */
function assertPersistedPredictionForecastFacts(inspection, persisted) {
  const keyOf = (fact) => `${fact.energyTypeId}:${fact.canonicalUnit || fact.predictedUnit}:${fact.targetMonth}`;
  const expectedFacts = inspection.expectedForecastFacts;
  const expectedByKey = new Map(expectedFacts.map((fact) => [keyOf(fact), fact]));
  const actualFacts = persisted.results.map((result) => ({
    algorithm: result.algorithm,
    energyTypeId: result.energyTypeId,
    energyTypeCode: result.energyTypeCode,
    canonicalUnit: result.predictedUnit,
    targetMonth: result.targetMonth,
    predictedValue: result.predictedValue,
    confidenceLow: result.confidenceLow,
    confidenceHigh: result.confidenceHigh,
    methodNote: result.methodNote
  }));
  const actualByKey = new Map(actualFacts.map((fact) => [keyOf(fact), fact]));
  if (expectedByKey.size !== expectedFacts.length || actualByKey.size !== actualFacts.length
    || expectedFacts.length !== actualFacts.length) {
    throw badRequest('Prediction exact 持久结果集合不能唯一匹配持久化前 forecast facts。', {
      code: 'PREDICTION_EXACT_FORECAST_FACT_SET_MISMATCH'
    });
  }
  expectedFacts.forEach((expected) => {
    const actual = actualByKey.get(keyOf(expected));
    const expectedPersisted = {
      algorithm: expected.algorithm,
      energyTypeId: expected.energyTypeId,
      energyTypeCode: expected.energyTypeCode,
      canonicalUnit: expected.canonicalUnit,
      targetMonth: expected.targetMonth,
      predictedValue: expected.predictedValue,
      confidenceLow: expected.confidenceLow,
      confidenceHigh: expected.confidenceHigh,
      methodNote: expected.methodNote
    };
    if (!actual || !isPredictionRoundedValue(actual.predictedValue, { nonNegative: true })
      || !isPredictionRoundedValue(actual.confidenceLow, { nonNegative: true })
      || !isPredictionRoundedValue(actual.confidenceHigh, { nonNegative: true })
      || stableStringify(actual) !== stableStringify(expectedPersisted)) {
      throw badRequest('Prediction exact 持久结果与持久化前 forecast fact 不一致。', {
        code: 'PREDICTION_EXACT_FORECAST_FACT_MISMATCH',
        resultKey: keyOf(expected)
      });
    }
  });
}

/** 构造 completion witness 的完整 run-level exact lineage 与结果事实。 */
function buildPredictionCompletionWitnessFacts(inspection, execution, persisted) {
  return cloneFrozenPredictionSnapshot({
    normalizedPayload: inspection.normalizedPayload,
    configSnapshot: inspection.configSnapshot,
    algorithm: inspection.normalizedPayload.algorithm,
    windowSize: inspection.normalizedPayload.windowSize ?? null,
    trainMonths: inspection.normalizedPayload.trainMonths,
    predictionMonths: inspection.normalizedPayload.predictionMonths,
    groups: inspection.groups.map((group) => ({
      groupKey: group.key,
      energyTypeId: group.energyTypeId,
      energyTypeCode: group.energyTypeCode,
      unit: group.unit,
      points: group.points,
      trainingRecords: group.records
    })),
    eligibleGroups: inspection.eligibleGroups.map((group) => ({
      groupKey: group.key,
      energyTypeId: group.energyTypeId,
      energyTypeCode: group.energyTypeCode,
      unit: group.unit,
      sampleMonths: group.sufficiency.sampleMonths,
      resultCount: group.forecasts.length,
      trainingRecordIds: group.records.map((record) => record.id)
    })),
    skippedGroups: inspection.skippedGroups,
    exactTrainingRecords: inspection.exactTrainingRecords,
    expectedForecastFacts: inspection.expectedForecastFacts,
    expectedResultCount: inspection.expectedResultCount,
    warnings: inspection.warnings,
    status: execution.summary.status,
    resultCount: execution.summary.resultCount,
    run: persisted.run,
    results: persisted.results
  });
}

/** 在调用方已有事务中执行 exact 预测；不打开、关闭或结束外层事务。 */
function executePredictionExactInCallerTransaction(input = {}) {
  const controlled = requirePredictionExactCapability(input);
  const { db, scopeState, capabilityState } = controlled;
  const inspection = capabilityState.inspection;
  if (!inspection.executable) {
    capabilityState.status = 'blocked';
    throw badRequest('Prediction exact inspect 已阻断无历史或全部样本不足的运行。', {
      code: 'PREDICTION_EXACT_EXECUTION_BLOCKED',
      blockers: inspection.blockers
    });
  }
  const recoverySavepoint = createPredictionExactSavepointName('recovery');
  let recoverySavepointActive = false;
  try {
    db.exec(`SAVEPOINT ${recoverySavepoint}`);
    recoverySavepointActive = true;
    const changeCountBeforePersist =
      predictionDatabaseTransactionProtocol.readTotalChanges(db);
    const execution = persistInspectedPrediction(db, inspection, { requireCompleted: true });
    const changeCountAfterPersist =
      predictionDatabaseTransactionProtocol.readTotalChanges(db);
    const expectedPersistedChanges = 2 + inspection.expectedResultCount;
    if (changeCountAfterPersist - changeCountBeforePersist !== expectedPersistedChanges) {
      throw badRequest('Prediction exact 持久化发生了预期 run/results 之外的额外写入。', {
        code: 'PREDICTION_EXACT_WRITE_CARDINALITY_MISMATCH',
        expectedChanges: expectedPersistedChanges,
        actualChanges: changeCountAfterPersist - changeCountBeforePersist
      });
    }
    const persisted = readPredictionCompletionRows(db, execution.run.id);
    if (!persisted.run || persisted.run.status !== 'completed'
      || persisted.results.length <= 0
      || persisted.results.length !== inspection.expectedResultCount
      || Number(persisted.run.resultCount) !== persisted.results.length) {
      throw badRequest('Prediction exact 持久事实未满足 completed 且结果非空的不变量。', {
        code: 'PREDICTION_EXACT_PERSISTED_COMPLETION_INVARIANT_FAILED'
      });
    }
    assertPersistedPredictionForecastFacts(inspection, persisted);
    const facts = buildPredictionCompletionWitnessFacts(inspection, execution, persisted);
    const consumeMarkerSavepoint = createPredictionExactSavepointName('witness_consume');
    const readMarkerSavepoint = createPredictionExactSavepointName('witness_read');
    db.exec(`SAVEPOINT ${consumeMarkerSavepoint}`);
    db.exec(`SAVEPOINT ${readMarkerSavepoint}`);
    const completionObligation = predictionDatabaseTransactionProtocol.createTransactionObligation(
      db,
      () => poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_TRANSACTION_FINALIZATION_BLOCKED')
    );
    PREDICTION_COMPLETION_OBLIGATION_STATE.set(completionObligation, {
      db,
      transactionScope: input.transactionScope,
      status: 'pending'
    });
    scopeState.obligations.add(completionObligation);
    const completionWitness = Object.freeze({});
    PREDICTION_COMPLETION_WITNESS_STATE.set(completionWitness, {
      db,
      transactionScope: input.transactionScope,
      demoRun: input.demoRun,
      actionRun: input.actionRun,
      actor: input.actor,
      recoverySavepoint,
      consumeMarkerSavepoint,
      readMarkerSavepoint,
      completionObligation,
      facts,
      persistedDigest: stableStringify(persisted),
      totalChangesAtIssue: predictionDatabaseTransactionProtocol.readTotalChanges(db),
      status: 'issued'
    });
    scopeState.witnesses.add(completionWitness);
    recoverySavepointActive = false;
    capabilityState.status = 'completed';
    return Object.freeze({
      run: cloneFrozenPredictionSnapshot(execution.run),
      summary: cloneFrozenPredictionSnapshot(execution.summary),
      completionWitness
    });
  } catch (error) {
    capabilityState.status = 'failed';
    if (recoverySavepointActive && db.inTransaction === true) {
      const recovery = recoverPredictionExactSavepoint(scopeState, recoverySavepoint);
      if (recovery.rollbackError || recovery.releaseError) {
        throw badRequest('Prediction exact execute 私有 SAVEPOINT 恢复失败。', {
          code: 'PREDICTION_EXACT_EXECUTE_RECOVERY_FAILED',
          originalCode: error.details?.code || error.code || null
        });
      }
    }
    throw error;
  }
}

/** 校验原始 witness 与当前 scope/invocation 的对象身份。 */
function requirePredictionCompletionWitness(input, operationName) {
  assertPredictionExactProtocolFields(
    input,
    ['db', 'transactionScope', 'completionWitness', 'demoRun', 'actionRun', 'actor'],
    `PREDICTION_EXACT_WITNESS_${operationName}_INPUT_INVALID`,
    `Prediction completion witness ${operationName.toLowerCase()} 只接受固定 caller-owned 协议字段。`
  );
  const db = assertPredictionExactDatabase(input.db);
  const scopeState = requirePredictionExactTransactionScope(db, input.transactionScope);
  assertPredictionExactInvocationBinding(scopeState, input);
  const witnessState = input.completionWitness && typeof input.completionWitness === 'object'
    ? PREDICTION_COMPLETION_WITNESS_STATE.get(input.completionWitness)
    : null;
  if (!witnessState) {
    throw badRequest('Prediction completion witness 必须是 exact executor 签发的原始对象。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_REQUIRED'
    });
  }
  if (!['issued', 'read'].includes(witnessState.status)) {
    throw badRequest('Prediction completion witness 已消费、过期或失效。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_REPLAY'
    });
  }
  if (witnessState.db !== db || witnessState.transactionScope !== input.transactionScope
    || witnessState.demoRun !== input.demoRun || witnessState.actionRun !== input.actionRun
    || witnessState.actor !== input.actor) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_COMPLETION_WITNESS_BINDING_MISMATCH');
    throw badRequest('Prediction completion witness 与 DB、scope 或 invocation 对象身份不一致。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_BINDING_MISMATCH'
    });
  }
  return { db, scopeState, witnessState };
}

/** 复核 witness 对应 run/results 未漂移；首次读取还绑定落库后的 SQLite 写入代次。 */
function assertPredictionCompletionWitnessFacts(db, witnessState, requireGenerationStable = false) {
  const current = readPredictionCompletionRows(db, witnessState.facts.run.id);
  const generationStable = !requireGenerationStable
    || predictionDatabaseTransactionProtocol.readTotalChanges(db)
      === witnessState.totalChangesAtIssue;
  if (stableStringify(current) !== witnessState.persistedDigest || !generationStable) {
    throw badRequest('Prediction completion witness 与当前 run/results 持久事实或写入代次不一致。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_FACT_MISMATCH'
    });
  }
}

/** witness 验证失败时回滚私有写入边界，并显式报告无法恢复的事务状态。 */
function recoverPredictionCompletionWitnessOrThrow(
  db,
  scopeState,
  witnessState,
  originalError,
  operationName
) {
  const recovery = recoverPredictionExactSavepoint(scopeState, witnessState.recoverySavepoint);
  if (recovery.rollbackError || recovery.releaseError) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_COMPLETION_WITNESS_RECOVERY_FAILED');
    throw badRequest(`Prediction completion witness ${operationName} 私有 SAVEPOINT 恢复失败。`, {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_RECOVERY_FAILED',
      operationName,
      originalCode: originalError.details?.code || originalError.code || null,
      rollbackCode: recovery.rollbackError?.code || null,
      releaseCode: recovery.releaseError?.code || null,
      noActiveTransaction: recovery.noActiveTransaction === true,
      fullRollbackCode: recovery.fullRollbackError?.code || null,
      closeCode: recovery.closeError?.code || null
    });
  }
  const obligationState = PREDICTION_COMPLETION_OBLIGATION_STATE.get(
    witnessState.completionObligation
  );
  if (!obligationState || obligationState.db !== db || obligationState.status !== 'pending') {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_OBLIGATION_INVALID');
    throw badRequest('Prediction completion witness 回滚后的 P4 obligation 无效。', {
      code: 'PREDICTION_EXACT_P4_OBLIGATION_INVALID',
      operationName
    });
  }
  try {
    predictionDatabaseTransactionProtocol.completeTransactionObligation(
      db,
      witnessState.completionObligation
    );
    obligationState.status = 'cancelled';
  } catch (error) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_OBLIGATION_RELEASE_FAILED');
    throw badRequest('Prediction completion witness 回滚后的 P4 obligation 解除失败。', {
      code: 'PREDICTION_EXACT_P4_OBLIGATION_RELEASE_FAILED',
      operationName,
      originalCode: error.code || null
    });
  }
  witnessState.status = 'rolled_back';
}

/** 一次性读取并验证 completion witness，但保留后续同 scope consume 能力。 */
function readPredictionCompletionWitnessInCallerTransaction(input = {}) {
  const controlled = requirePredictionCompletionWitness(input, 'READ');
  const { db, scopeState, witnessState } = controlled;
  if (witnessState.status !== 'issued') {
    throw badRequest('Prediction completion witness 已读取，不能重复读取。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_READ_REPLAY'
    });
  }
  witnessState.status = 'reading';
  try {
    releasePredictionExactSavepoint(
      scopeState,
      witnessState.readMarkerSavepoint
    );
  } catch (_error) {
    witnessState.status = 'failed';
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_COMPLETION_WITNESS_TRANSACTION_MISMATCH');
    throw badRequest('Prediction completion witness 不属于当前 caller transaction。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_TRANSACTION_MISMATCH'
    });
  }
  try {
    witnessState.readMarkerSavepoint = null;
    assertPredictionCompletionWitnessFacts(db, witnessState, true);
    witnessState.status = 'read';
    return witnessState.facts;
  } catch (error) {
    witnessState.status = 'failed';
    recoverPredictionCompletionWitnessOrThrow(db, scopeState, witnessState, error, 'READ');
    throw error;
  }
}

// P4 finalizer 仅在模块初始化期允许首次 linker 绑定；普通 runtime 不能重复取得消费能力。
let predictionP4CompletionVerifierBound = false;

/** 将已读取 witness 绑定到首次初始化的 P4 verifier authority。 */
function bindPredictionCompletionWitnessToP4Verifier(input, verifierAuthority) {
  const controlled = requirePredictionCompletionWitness(input, 'P4_BIND');
  const { scopeState, witnessState } = controlled;
  if (witnessState.status !== 'read' || witnessState.p4VerifierAuthority) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_WITNESS_BINDING_INVALID');
    throw badRequest('Prediction completion witness 只能在首次读取后绑定一次 P4 verifier。', {
      code: 'PREDICTION_EXACT_P4_WITNESS_BINDING_INVALID'
    });
  }
  witnessState.p4VerifierAuthority = verifierAuthority;
  return witnessState.facts;
}

/** 仅允许首次绑定的 P4 verifier 在原 witness scope 内释放自身随机 SAVEPOINT。 */
function releasePredictionP4Savepoint(input, savepointName, verifierAuthority) {
  const controlled = requirePredictionCompletionWitness(input, 'P4_RELEASE');
  const { scopeState, witnessState } = controlled;
  if (witnessState.p4VerifierAuthority !== verifierAuthority
    || typeof savepointName !== 'string'
    || !/^prediction_ownership_[A-Za-z0-9_]+_[0-9a-f]{24}$/u.test(savepointName)) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_RELEASE_AUTHORITY_INVALID');
    throw badRequest('Prediction P4 私有 SAVEPOINT release authority 无效。', {
      code: 'PREDICTION_EXACT_P4_RELEASE_AUTHORITY_INVALID'
    });
  }
  return releasePredictionExactSavepoint(scopeState, savepointName);
}

/** 仅允许已绑定 P4 verifier 读取原 witness 连接的累计写入代次。 */
function readPredictionP4TotalChanges(input, verifierAuthority) {
  const controlled = requirePredictionCompletionWitness(input, 'P4_TOTAL_CHANGES');
  const { db, scopeState, witnessState } = controlled;
  if (witnessState.p4VerifierAuthority !== verifierAuthority) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_TOTAL_CHANGES_AUTHORITY_INVALID');
    throw badRequest('Prediction P4 写入代次读取 authority 无效。', {
      code: 'PREDICTION_EXACT_P4_TOTAL_CHANGES_AUTHORITY_INVALID'
    });
  }
  return predictionDatabaseTransactionProtocol.readTotalChanges(db);
}

/** 为首次初始化的 P4 verifier 返回固定 witness claim/finalize 闭包。 */
function bindPredictionP4CompletionVerifier(authority) {
  if (predictionP4CompletionVerifierBound || !authority || typeof authority !== 'object'
    || Array.isArray(authority) || utilTypes.isProxy(authority)
    || Object.getPrototypeOf(authority) !== Object.prototype
    || !Object.isFrozen(authority) || Reflect.ownKeys(authority).length !== 0) {
    throw badRequest('Prediction P4 completion verifier linker 无效或已经绑定。', {
      code: 'PREDICTION_EXACT_P4_VERIFIER_BINDING_INVALID'
    });
  }
  predictionP4CompletionVerifierBound = true;
  return Object.freeze({
    bindCompletionWitness: (input) => (
      bindPredictionCompletionWitnessToP4Verifier(input, authority)
    ),
    consumeCompletionWitness: (input) => (
      consumePredictionCompletionWitnessInCallerTransaction(input, authority)
    ),
    readTotalChanges: (input) => (
      readPredictionP4TotalChanges(input, authority)
    ),
    releaseSavepoint: (input, savepointName) => (
      releasePredictionP4Savepoint(input, savepointName, authority)
    )
  });
}

/** 验证并一次性消费 completion witness，同时释放 exact 私有恢复边界。 */
function consumePredictionCompletionWitnessInCallerTransaction(input = {}, verifierAuthority = null) {
  const controlled = requirePredictionCompletionWitness(input, 'CONSUME');
  const { db, scopeState, witnessState } = controlled;
  if (predictionP4CompletionVerifierBound
    && witnessState.p4VerifierAuthority !== verifierAuthority) {
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_P4_VERIFIER_REQUIRED');
    throw badRequest('P4 linker 生效后 completion witness 只能由对应 verifier 终结。', {
      code: 'PREDICTION_EXACT_P4_VERIFIER_REQUIRED'
    });
  }
  witnessState.status = 'consuming';
  try {
    if (witnessState.readMarkerSavepoint) {
      releasePredictionExactSavepoint(
        scopeState,
        witnessState.readMarkerSavepoint
      );
      witnessState.readMarkerSavepoint = null;
    }
    releasePredictionExactSavepoint(
      scopeState,
      witnessState.consumeMarkerSavepoint
    );
  } catch (_error) {
    witnessState.status = 'failed';
    poisonPredictionExactScope(scopeState, 'PREDICTION_EXACT_COMPLETION_WITNESS_TRANSACTION_MISMATCH');
    throw badRequest('Prediction completion witness 不属于当前 caller transaction。', {
      code: 'PREDICTION_EXACT_COMPLETION_WITNESS_TRANSACTION_MISMATCH'
    });
  }
  try {
    assertPredictionCompletionWitnessFacts(
      db,
      witnessState,
      !predictionP4CompletionVerifierBound
    );
    const obligationState = PREDICTION_COMPLETION_OBLIGATION_STATE.get(
      witnessState.completionObligation
    );
    if (!obligationState || obligationState.db !== db || obligationState.status !== 'pending') {
      throw badRequest('Prediction completion witness 的 P4 obligation 无效或已提前终结。', {
        code: 'PREDICTION_EXACT_P4_OBLIGATION_INVALID'
      });
    }
    predictionDatabaseTransactionProtocol.completeTransactionObligation(
      db,
      witnessState.completionObligation
    );
    obligationState.status = 'completed';
    releasePredictionExactSavepoint(
      scopeState,
      witnessState.recoverySavepoint
    );
    witnessState.status = 'consumed';
    return witnessState.facts;
  } catch (error) {
    witnessState.status = 'failed';
    recoverPredictionCompletionWitnessOrThrow(db, scopeState, witnessState, error, 'CONSUME');
    throw error;
  }
}

function mapRunRow(row) { if (!row) return null; let parameters = null; try { parameters = row.parametersJson ? JSON.parse(row.parametersJson) : null; } catch (_) { parameters = { parseError: 'parameters_json 不是有效 JSON' }; } return { ...row, parameters }; }
function getPredictionRunById(db, runId) {
  return mapRunRow(db.prepare(`SELECT pr.id, pr.name, pr.algorithm, pr.status, pr.target_energy_type_id AS targetEnergyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName, pr.train_start_month AS trainStartMonth, pr.train_end_month AS trainEndMonth, pr.predict_start_month AS predictStartMonth, pr.predict_end_month AS predictEndMonth, pr.parameters_json AS parametersJson, pr.created_at AS createdAt, pr.completed_at AS completedAt, pr.note, COUNT(pres.id) AS resultCount FROM prediction_runs pr LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id LEFT JOIN prediction_results pres ON pres.prediction_run_id = pr.id WHERE pr.id = @runId GROUP BY pr.id`).get({ runId }));
}
function getPredictionRun(runIdRaw) { const runId = normalizePositiveInteger(runIdRaw, 'runId'); const db = openDatabase(); try { const run = getPredictionRunById(db, runId); if (!run) throw notFound('预测运行不存在。', { runId }); const results = selectPredictionResultRows(db, { runId }, { limit: MAX_PREDICTION_EXPORT_ROWS }); return { ...run, results }; } finally { db.close(); } }

function normalizeRunListFilters(query = {}) { const algorithm = normalizeText(query.algorithm); if (algorithm) normalizePredictionAlgorithm(algorithm); return { algorithm, status: normalizePredictionStatus(query.status), energyTypeCode: normalizeText(query.energyTypeCode), targetMonth: normalizeText(query.targetMonth || query.predictStartMonth), keyword: normalizeText(query.keyword || query.search), createdAtStart: nullableText(query.createdAtStart), createdAtEnd: nullableText(query.createdAtEnd) }; }
function buildRunListWhere(filters = {}) { const where = []; const params = {}; if (filters.algorithm) { where.push('pr.algorithm = @algorithm'); params.algorithm = filters.algorithm; } if (filters.status) { where.push('pr.status = @status'); params.status = filters.status; } if (filters.energyTypeCode) { where.push('et.code = @energyTypeCode'); params.energyTypeCode = filters.energyTypeCode; } if (filters.targetMonth) { where.push('pr.predict_start_month <= @targetMonth AND pr.predict_end_month >= @targetMonth'); params.targetMonth = filters.targetMonth; } if (filters.keyword) { where.push("(pr.name LIKE @keyword ESCAPE '\\' OR pr.note LIKE @keyword ESCAPE '\\' OR et.code LIKE @keyword ESCAPE '\\' OR et.name LIKE @keyword ESCAPE '\\')"); params.keyword = `%${escapeLike(filters.keyword)}%`; } if (filters.createdAtStart) { where.push('pr.created_at >= @createdAtStart'); params.createdAtStart = filters.createdAtStart; } if (filters.createdAtEnd) { where.push('pr.created_at <= @createdAtEnd'); params.createdAtEnd = filters.createdAtEnd; } return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }; }
function listPredictionRuns(query = {}) { const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: RUN_PAGE_SIZE_MAX }); const sort = normalizeSort(query, PREDICTION_SORT_COLUMNS, { sortBy: 'createdAt', sortOrder: 'desc' }); const { whereSql, params } = buildRunListWhere(normalizeRunListFilters(query)); const db = openDatabase(); try { const total = db.prepare(`SELECT COUNT(*) AS total FROM prediction_runs pr LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id ${whereSql}`).get(params).total; const rows = db.prepare(`SELECT pr.id, pr.name, pr.algorithm, pr.status, pr.target_energy_type_id AS targetEnergyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName, pr.train_start_month AS trainStartMonth, pr.train_end_month AS trainEndMonth, pr.predict_start_month AS predictStartMonth, pr.predict_end_month AS predictEndMonth, pr.parameters_json AS parametersJson, pr.created_at AS createdAt, pr.completed_at AS completedAt, pr.note, COUNT(pres.id) AS resultCount FROM prediction_runs pr LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id LEFT JOIN prediction_results pres ON pres.prediction_run_id = pr.id ${whereSql} GROUP BY pr.id ORDER BY ${sort.orderSql}, pr.id DESC LIMIT @pageSize OFFSET @offset`).all({ ...params, pageSize, offset }).map(mapRunRow); return { rows, pagination: buildPaginationMeta(page, pageSize, total), sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder } }; } finally { db.close(); } }

function normalizeResultFilters(query = {}) { const runId = normalizePositiveInteger(query.runId || query.predictionRunId, 'runId'); const start = normalizeMonth(query.targetMonthStart || query.monthStart || query.startMonth, 'targetMonthStart'); const end = normalizeMonth(query.targetMonthEnd || query.monthEnd || query.endMonth, 'targetMonthEnd'); if (start && end) generateMonthSequence(start, end); return { runId, energyTypeCode: normalizeText(query.energyTypeCode), targetMonthStart: start, targetMonthEnd: end, keyword: normalizeText(query.keyword || query.search), runStatus: normalizePredictionStatus(query.runStatus) }; }
function buildResultWhere(filters = {}) { const where = []; const params = {}; if (filters.runId) { where.push('pres.prediction_run_id = @runId'); params.runId = filters.runId; } if (filters.energyTypeCode) { where.push('et.code = @energyTypeCode'); params.energyTypeCode = filters.energyTypeCode; } if (filters.targetMonthStart) { where.push('pres.target_month >= @targetMonthStart'); params.targetMonthStart = filters.targetMonthStart; } if (filters.targetMonthEnd) { where.push('pres.target_month <= @targetMonthEnd'); params.targetMonthEnd = filters.targetMonthEnd; } if (filters.runStatus) { where.push('pr.status = @runStatus'); params.runStatus = filters.runStatus; } if (filters.keyword) { where.push("(pr.name LIKE @keyword ESCAPE '\\' OR et.code LIKE @keyword ESCAPE '\\' OR et.name LIKE @keyword ESCAPE '\\' OR pres.method_note LIKE @keyword ESCAPE '\\')"); params.keyword = `%${escapeLike(filters.keyword)}%`; } return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }; }
function selectPredictionResultRows(db, query = {}, options = {}) { const sort = normalizeSort(query, PREDICTION_RESULT_SORT_COLUMNS, { sortBy: 'targetMonth', sortOrder: 'asc' }); const { whereSql, params } = buildResultWhere(normalizeResultFilters(query)); return db.prepare(`SELECT pres.id, pres.prediction_run_id AS predictionRunId, pr.name AS predictionRunName, pr.algorithm, pr.status AS runStatus, pres.energy_type_id AS energyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName, pres.target_month AS targetMonth, pres.predicted_value AS predictedValue, pres.predicted_unit AS predictedUnit, pres.confidence_low AS confidenceLow, pres.confidence_high AS confidenceHigh, pres.method_note AS methodNote, pres.created_at AS createdAt FROM prediction_results pres LEFT JOIN energy_types et ON et.id = pres.energy_type_id JOIN prediction_runs pr ON pr.id = pres.prediction_run_id ${whereSql} ORDER BY ${sort.orderSql}, et.display_order, et.code, pres.id LIMIT @limit OFFSET @offset`).all({ ...params, limit: options.limit || MAX_PREDICTION_EXPORT_ROWS, offset: options.offset || 0 }); }
function listPredictionResults(query = {}) { const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 50, maxPageSize: RESULT_PAGE_SIZE_MAX }); const sort = normalizeSort(query, PREDICTION_RESULT_SORT_COLUMNS, { sortBy: 'targetMonth', sortOrder: 'asc' }); const { whereSql, params } = buildResultWhere(normalizeResultFilters(query)); const db = openDatabase(); try { const total = db.prepare(`SELECT COUNT(*) AS total FROM prediction_results pres LEFT JOIN energy_types et ON et.id = pres.energy_type_id JOIN prediction_runs pr ON pr.id = pres.prediction_run_id ${whereSql}`).get(params).total; return { rows: selectPredictionResultRows(db, query, { limit: pageSize, offset }), pagination: buildPaginationMeta(page, pageSize, total), sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder } }; } finally { db.close(); } }

function normalizeConfigStatus(value, fallback = 'draft') { const status = normalizeText(value) || fallback; if (!PREDICTION_CONFIG_STATUSES.includes(status)) throw badRequest('预测配置状态仅支持 draft、active 或 archived。', { code: 'INVALID_PREDICTION_CONFIG_STATUS', status, allowedStatuses: PREDICTION_CONFIG_STATUSES }); return status; }

/** 配置更新时优先使用调用方显式别名；未提供时才继承现有业务字段。 */
function mergePredictionConfigAliasedField(input, merged, camelName, snakeName, existingValue) {
  if (hasOwnPredictionField(input, camelName)) {
    merged[camelName] = input[camelName];
    return;
  }
  if (hasOwnPredictionField(input, snakeName)) {
    merged[camelName] = input[snakeName];
    return;
  }
  merged[camelName] = existingValue;
}

/** 判断输入是否为当前完整配置 DTO 原样回传，避免把 provenance sourceBatchId 当作旧写别名。 */
function isPredictionConfigReadDto(input, existing) {
  const identityFields = ['id', 'sourceBatchId', 'sourceRowNumber', 'createdAt', 'updatedAt'];
  return Boolean(existing.id)
    && hasOwnPredictionField(input, 'sourceBatchFilterId')
    && !hasOwnPredictionField(input, 'source_batch_filter_id')
    && !hasOwnPredictionField(input, 'source_batch_id')
    && identityFields.every((fieldName) => hasOwnPredictionField(input, fieldName))
    && identityFields.every((fieldName) => input[fieldName] === existing[fieldName]);
}

/** 解析配置训练批次字段；canonical 字段优先，旧 sourceBatchId 只兼容非 DTO 写请求。 */
function resolvePredictionConfigSourceBatchFilter(input, existing) {
  const canonicalAliases = ['sourceBatchFilterId', 'source_batch_filter_id'];
  const legacyAliases = ['sourceBatchId', 'source_batch_id'];
  const hasCanonical = canonicalAliases.some((fieldName) => hasOwnPredictionField(input, fieldName));
  const hasLegacy = legacyAliases.some((fieldName) => hasOwnPredictionField(input, fieldName));
  const readDto = isPredictionConfigReadDto(input, existing);
  const normalizeBatchId = (value) => normalizePositiveInteger(value, 'sourceBatchFilterId');
  const canonicalValue = hasCanonical
    ? normalizePredictionAliasedField(
      input,
      canonicalAliases,
      'sourceBatchFilterId',
      normalizeBatchId
    )
    : undefined;
  if (hasCanonical && hasLegacy && !readDto) {
    const legacyValue = normalizePredictionAliasedField(
      input,
      legacyAliases,
      'sourceBatchFilterId',
      normalizeBatchId
    );
    if (stableStringify(canonicalValue) !== stableStringify(legacyValue)) {
      throw badRequest('sourceBatchFilterId 与旧 sourceBatchId 写别名值冲突。', {
        code: 'PREDICTION_ALIAS_CONFLICT',
        fieldName: 'sourceBatchFilterId',
        aliases: [...canonicalAliases, ...legacyAliases].filter((fieldName) => (
          hasOwnPredictionField(input, fieldName)
        ))
      });
    }
  }
  if (hasCanonical) return canonicalValue;
  if (hasLegacy && !readDto) {
    return normalizePredictionAliasedField(
      input,
      legacyAliases,
      'sourceBatchFilterId',
      normalizeBatchId
    );
  }
  return existing.sourceBatchFilterId;
}

/** 规范化配置输入，严格区分配置 provenance batch 与训练过滤 batch。 */
function normalizeConfigPayload(input = {}, options = {}) {
  const existing = options.existing || {};
  const merged = { ...existing, ...input };
  mergePredictionConfigAliasedField(input, merged, 'organizationUnitCode', 'organization_unit_code', existing.organizationUnitCode);
  mergePredictionConfigAliasedField(input, merged, 'organizationUnitId', 'organization_unit_id', existing.organizationUnitId);
  mergePredictionConfigAliasedField(input, merged, 'meterCode', 'meter_code', existing.meterCode);
  mergePredictionConfigAliasedField(input, merged, 'meterDeviceId', 'meter_device_id', existing.meterDeviceId);
  const sourceBatchFilterId = resolvePredictionConfigSourceBatchFilter(input, existing);
  merged.sourceBatchId = sourceBatchFilterId;
  delete merged.source_batch_id;
  mergePredictionConfigAliasedField(input, merged, 'trainStartMonth', 'train_start_month', existing.trainStartMonth);
  mergePredictionConfigAliasedField(input, merged, 'trainEndMonth', 'train_end_month', existing.trainEndMonth);
  mergePredictionConfigAliasedField(input, merged, 'predictStartMonth', 'predict_start_month', existing.predictStartMonth);
  mergePredictionConfigAliasedField(input, merged, 'predictEndMonth', 'predict_end_month', existing.predictEndMonth);
  mergePredictionConfigAliasedField(input, merged, 'windowSize', 'window_size', existing.windowSize);
  const normalized = normalizePredictionPayload(merged);
  const status = normalizeConfigStatus(input.status, existing.status || 'draft');
  if (status === 'archived' && !options.allowArchived) throw badRequest('请通过状态接口归档预测配置。', { code: 'PREDICTION_CONFIG_ARCHIVE_ROUTE_REQUIRED' });
  if (normalized.name.length > 200 || (normalized.note && normalized.note.length > 1000)) throw badRequest('预测配置名称或备注长度超出限制。', { code: 'PREDICTION_CONFIG_TEXT_TOO_LONG' });
  return { ...normalized, status };
}

function mapConfigRow(row) {
  return row ? {
    ...row,
    windowSize: row.windowSize === null ? null : Number(row.windowSize),
    sourceBatchId: row.sourceBatchId === null ? null : Number(row.sourceBatchId),
    sourceBatchFilterId: row.sourceBatchFilterId === null ? null : Number(row.sourceBatchFilterId),
    organizationUnitId: row.organizationUnitId === null ? null : Number(row.organizationUnitId),
    meterDeviceId: row.meterDeviceId === null ? null : Number(row.meterDeviceId)
  } : null;
}
function getPredictionConfigById(db, configId, options = {}) { const row = db.prepare(`SELECT pc.id, pc.source_batch_id AS sourceBatchId, pc.source_row_number AS sourceRowNumber, pc.name, pc.note, pc.energy_type_id AS energyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName, pc.organization_unit_id AS organizationUnitId, ou.unit_code AS organizationUnitCode, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath, pc.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName, pc.source_batch_filter_id AS sourceBatchFilterId, pc.train_start_month AS trainStartMonth, pc.train_end_month AS trainEndMonth, pc.predict_start_month AS predictStartMonth, pc.predict_end_month AS predictEndMonth, pc.algorithm, pc.window_size AS windowSize, pc.status, pc.created_at AS createdAt, pc.updated_at AS updatedAt, pc.archived_at AS archivedAt FROM prediction_configs pc LEFT JOIN energy_types et ON et.id = pc.energy_type_id LEFT JOIN organization_units ou ON ou.id = pc.organization_unit_id LEFT JOIN meter_devices md ON md.id = pc.meter_device_id WHERE pc.id = ?`).get(configId); if (!row && !options.optional) throw notFound('预测配置草稿不存在。', { configId }); return mapConfigRow(row); }
function getPredictionConfig(configIdRaw) { const configId = normalizePositiveInteger(configIdRaw, 'configId'); const db = openDatabase(); try { return getPredictionConfigById(db, configId); } finally { db.close(); } }
function configFields(db, payload, energyTypeId) { const organizationUnitId = resolveOrganizationUnitId(db, payload.filters); const meterDeviceId = resolveMeterDeviceId(db, payload.filters, energyTypeId, organizationUnitId); return { name: payload.name, note: payload.note, energyTypeId, organizationUnitId, meterDeviceId, sourceBatchFilterId: payload.filters.sourceBatchId ?? null, trainStartMonth: payload.trainStartMonth, trainEndMonth: payload.trainEndMonth, predictStartMonth: payload.predictStartMonth, predictEndMonth: payload.predictEndMonth, algorithm: payload.algorithm, windowSize: payload.windowSize ?? null, status: payload.status }; }
function createPredictionConfig(input = {}) { const payload = normalizeConfigPayload(input); const db = openDatabase(); try { return db.transaction(() => { const fields = configFields(db, payload, resolveEnergyTypeId(db, payload.filters.energyTypeCode)); const inserted = db.prepare(`INSERT INTO prediction_configs (name, note, energy_type_id, organization_unit_id, meter_device_id, source_batch_filter_id, train_start_month, train_end_month, predict_start_month, predict_end_month, algorithm, window_size, status) VALUES (@name, @note, @energyTypeId, @organizationUnitId, @meterDeviceId, @sourceBatchFilterId, @trainStartMonth, @trainEndMonth, @predictStartMonth, @predictEndMonth, @algorithm, @windowSize, @status)`).run(fields); return getPredictionConfigById(db, inserted.lastInsertRowid); })(); } finally { db.close(); } }
function updatePredictionConfig(configIdRaw, input = {}) { const configId = normalizePositiveInteger(configIdRaw, 'configId'); const db = openDatabase(); try { return db.transaction(() => { const existing = getPredictionConfigById(db, configId); if (existing.status === 'archived') throw badRequest('已归档预测配置不可编辑；请复制为新草稿。', { code: 'PREDICTION_CONFIG_ARCHIVED' }); const payload = normalizeConfigPayload(input, { existing }); const fields = configFields(db, payload, resolveEnergyTypeId(db, payload.filters.energyTypeCode)); db.prepare(`UPDATE prediction_configs SET name=@name, note=@note, energy_type_id=@energyTypeId, organization_unit_id=@organizationUnitId, meter_device_id=@meterDeviceId, source_batch_filter_id=@sourceBatchFilterId, train_start_month=@trainStartMonth, train_end_month=@trainEndMonth, predict_start_month=@predictStartMonth, predict_end_month=@predictEndMonth, algorithm=@algorithm, window_size=@windowSize, status=@status, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@configId`).run({ ...fields, configId }); return getPredictionConfigById(db, configId); })(); } finally { db.close(); } }
function setPredictionConfigStatus(configIdRaw, input = {}) { const configId = normalizePositiveInteger(configIdRaw, 'configId'); const status = normalizeConfigStatus(typeof input === 'string' ? input : input.status); const db = openDatabase(); try { return db.transaction(() => { getPredictionConfigById(db, configId); db.prepare(`UPDATE prediction_configs SET status=?, archived_at=CASE WHEN ?='archived' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(status, status, configId); return getPredictionConfigById(db, configId); })(); } finally { db.close(); } }
function copyPredictionConfig(configIdRaw) { const configId = normalizePositiveInteger(configIdRaw, 'configId'); const db = openDatabase(); try { return db.transaction(() => { const source = getPredictionConfigById(db, configId); const inserted = db.prepare(`INSERT INTO prediction_configs (name,note,energy_type_id,organization_unit_id,meter_device_id,source_batch_filter_id,train_start_month,train_end_month,predict_start_month,predict_end_month,algorithm,window_size,status) SELECT name || '（副本）',note,energy_type_id,organization_unit_id,meter_device_id,source_batch_filter_id,train_start_month,train_end_month,predict_start_month,predict_end_month,algorithm,window_size,'draft' FROM prediction_configs WHERE id=?`).run(source.id); return getPredictionConfigById(db, inserted.lastInsertRowid); })(); } finally { db.close(); } }
function buildConfigWhere(query = {}) { const where = []; const params = {}; const status = query.status ? normalizeConfigStatus(query.status) : null; const energyTypeCode = normalizeText(query.energyTypeCode); const organizationUnitCode = normalizeText(query.organizationUnitCode); const meterCode = normalizeText(query.meterCode); const algorithm = normalizeText(query.algorithm); const keyword = normalizeText(query.keyword || query.search); if (status) { where.push('pc.status=@status'); params.status = status; } if (energyTypeCode) { where.push('et.code=@energyTypeCode'); params.energyTypeCode = energyTypeCode; } if (organizationUnitCode) { where.push('ou.unit_code=@organizationUnitCode'); params.organizationUnitCode = organizationUnitCode; } if (meterCode) { where.push('md.meter_code=@meterCode'); params.meterCode = meterCode; } if (algorithm) { normalizePredictionAlgorithm(algorithm); where.push('pc.algorithm=@algorithm'); params.algorithm = algorithm; } if (keyword) { where.push("(pc.name LIKE @keyword ESCAPE '\\' OR pc.note LIKE @keyword ESCAPE '\\' OR ou.unit_code LIKE @keyword ESCAPE '\\' OR ou.unit_name LIKE @keyword ESCAPE '\\' OR ou.unit_path LIKE @keyword ESCAPE '\\' OR md.meter_code LIKE @keyword ESCAPE '\\' OR md.meter_name LIKE @keyword ESCAPE '\\' OR et.code LIKE @keyword ESCAPE '\\')"); params.keyword = `%${escapeLike(keyword)}%`; } return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }; }
function selectConfigRows(db, query = {}, options = {}) { const { whereSql, params } = buildConfigWhere(query); return db.prepare(`SELECT pc.id,pc.source_batch_id AS sourceBatchId,pc.source_row_number AS sourceRowNumber,pc.name,pc.note,pc.energy_type_id AS energyTypeId,et.code AS energyTypeCode,et.name AS energyTypeName,pc.organization_unit_id AS organizationUnitId,ou.unit_code AS organizationUnitCode,ou.unit_name AS organizationUnitName,ou.unit_path AS organizationUnitPath,pc.meter_device_id AS meterDeviceId,md.meter_code AS meterCode,md.meter_name AS meterName,pc.source_batch_filter_id AS sourceBatchFilterId,pc.train_start_month AS trainStartMonth,pc.train_end_month AS trainEndMonth,pc.predict_start_month AS predictStartMonth,pc.predict_end_month AS predictEndMonth,pc.algorithm,pc.window_size AS windowSize,pc.status,pc.created_at AS createdAt,pc.updated_at AS updatedAt,pc.archived_at AS archivedAt FROM prediction_configs pc LEFT JOIN energy_types et ON et.id=pc.energy_type_id LEFT JOIN organization_units ou ON ou.id=pc.organization_unit_id LEFT JOIN meter_devices md ON md.id=pc.meter_device_id ${whereSql} ORDER BY pc.updated_at DESC,pc.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: options.limit || MAX_PREDICTION_EXPORT_ROWS, offset: options.offset || 0 }).map(mapConfigRow); }
function listPredictionConfigs(query = {}) { const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: CONFIG_PAGE_SIZE_MAX }); const db = openDatabase(); try { const { whereSql, params } = buildConfigWhere(query); const total = db.prepare(`SELECT COUNT(*) AS total FROM prediction_configs pc LEFT JOIN energy_types et ON et.id=pc.energy_type_id LEFT JOIN organization_units ou ON ou.id=pc.organization_unit_id LEFT JOIN meter_devices md ON md.id=pc.meter_device_id ${whereSql}`).get(params).total; return { rows: selectConfigRows(db, query, { limit: pageSize, offset }), pagination: buildPaginationMeta(page, pageSize, total) }; } finally { db.close(); } }
function createRunFromConfig(configIdRaw) { const configId = normalizePositiveInteger(configIdRaw, 'configId'); const db = openDatabase(); try { return db.transaction(() => { const config = getPredictionConfigById(db, configId); if (config.status === 'archived') throw badRequest('已归档预测配置不可运行；请复制为新草稿。', { code: 'PREDICTION_CONFIG_ARCHIVED' }); const configRunInput = { ...config, sourceBatchId: config.sourceBatchFilterId }; const payload = normalizePredictionPayload(configRunInput); const snapshot = { configId: config.id, config: { name: config.name, note: config.note, energyTypeCode: config.energyTypeCode, organizationUnitId: config.organizationUnitId, organizationUnitCode: config.organizationUnitCode, meterDeviceId: config.meterDeviceId, meterCode: config.meterCode, sourceBatchId: config.sourceBatchFilterId, trainStartMonth: config.trainStartMonth, trainEndMonth: config.trainEndMonth, predictStartMonth: config.predictStartMonth, predictEndMonth: config.predictEndMonth, algorithm: config.algorithm, windowSize: config.windowSize } }; return runNormalizedPrediction(db, payload, snapshot); })(); } finally { db.close(); } }
function cancelOrArchivePredictionRun(runIdRaw, input = {}) { const runId = normalizePositiveInteger(runIdRaw, 'runId'); const requested = normalizeText(input.status || input.action); if (!['cancelled', 'archived'].includes(requested)) throw badRequest('status 仅支持 cancelled 或 archived。', { code: 'INVALID_PREDICTION_RUN_TRANSITION' }); const db = openDatabase(); try { return db.transaction(() => { const run = getPredictionRunById(db, runId); if (!run) throw notFound('预测运行不存在。', { runId }); if (requested === 'cancelled' && !['pending', 'running'].includes(run.status)) throw badRequest('仅 pending/running 预测运行可取消；已完成、失败或已归档记录和结果不可篡改。', { code: 'PREDICTION_RUN_CANCEL_NOT_ALLOWED', status: run.status }); if (requested === 'archived' && !['completed', 'failed', 'cancelled', 'archived'].includes(run.status)) throw badRequest('仅终态预测运行可归档，运行中的任务请先取消。', { code: 'PREDICTION_RUN_ARCHIVE_NOT_ALLOWED', status: run.status }); db.prepare(`UPDATE prediction_runs SET status=?, completed_at=CASE WHEN ?='cancelled' THEN COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE completed_at END, note=COALESCE(note || ' ', '') || ? WHERE id=?`).run(requested, requested, requested === 'archived' ? ' 已归档；预测结果保持只读。' : ' 已取消；未删除或改写预测结果。', runId); return getPredictionRunById(db, runId); })(); } finally { db.close(); } }
function buildPredictionStats(query = {}) { const db = openDatabase(); try { const { whereSql, params } = buildRunListWhere(normalizeRunListFilters(query)); const summary = db.prepare(`SELECT COUNT(DISTINCT pr.id) AS totalRuns, COUNT(DISTINCT CASE WHEN pr.status='completed' THEN pr.id END) AS completedCount, COUNT(DISTINCT CASE WHEN pr.status='failed' THEN pr.id END) AS failedCount, COUNT(DISTINCT CASE WHEN pr.status='cancelled' THEN pr.id END) AS cancelledCount, COUNT(DISTINCT CASE WHEN pr.status='archived' THEN pr.id END) AS archivedCount, COUNT(pres.id) AS resultCount FROM prediction_runs pr LEFT JOIN energy_types et ON et.id=pr.target_energy_type_id LEFT JOIN prediction_results pres ON pres.prediction_run_id=pr.id ${whereSql}`).get(params); const aggregate = (columns, groupBy) => db.prepare(`SELECT ${columns}, COUNT(*) AS runCount, COUNT(pres.id) AS resultCount FROM prediction_runs pr LEFT JOIN energy_types et ON et.id=pr.target_energy_type_id LEFT JOIN prediction_results pres ON pres.prediction_run_id=pr.id ${whereSql} GROUP BY ${groupBy} ORDER BY runCount DESC`).all(params); return { totalRuns: Number(summary.totalRuns || 0), completedCount: Number(summary.completedCount || 0), failedCount: Number(summary.failedCount || 0), cancelledCount: Number(summary.cancelledCount || 0), archivedCount: Number(summary.archivedCount || 0), resultCount: Number(summary.resultCount || 0), byStatus: aggregate('pr.status AS status', 'pr.status'), byAlgorithm: aggregate('pr.algorithm AS algorithm', 'pr.algorithm'), byEnergyType: aggregate('COALESCE(et.code, \'全部能源\') AS energyTypeCode', 'COALESCE(et.code, \'全部能源\')'), byTargetMonth: aggregate("pr.predict_start_month || '~' || pr.predict_end_month AS targetMonthRange", 'pr.predict_start_month,pr.predict_end_month'), meta: { filtersApplied: { ...query }, aggregationPolicy: '统计仅聚合当前筛选命中的真实预测运行及其实际 prediction_results；失败或样本不足运行不伪造结果。', noDataFabricated: true } }; } finally { db.close(); } }
function renderExport(rows, fields, sheetName, prefix, requestedFormat) { const format = String(requestedFormat || 'xlsx').toLowerCase(); if (!['xlsx', 'csv'].includes(format)) throw badRequest('format 仅支持 xlsx 或 csv。', { code: 'UNSUPPORTED_EXPORT_FORMAT', format }); const headers = fields.map((field) => field.header); const values = rows.map((row) => fields.reduce((result, field) => ({ ...result, [field.header]: row[field.key] ?? '' }), {})); const fileName = `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${format}`; if (format === 'csv') { const csv = `﻿${[headers, ...values.map((row) => headers.map((key) => row[key]))].map((row) => row.map((item) => `"${String(item).replace(/"/g, '""')}"`).join(',')).join('\n')}\n`; return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(csv, 'utf8'), rowCount: rows.length, fields: headers }; } const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(values, { header: headers }), sheetName); return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers }; }
function exportPredictionConfigs(query = {}) { const db = openDatabase(); try { return renderExport(selectConfigRows(db, query), PREDICTION_CONFIG_EXPORT_FIELDS, '预测配置草稿', '预测配置草稿导出', query.format); } finally { db.close(); } }
function exportPredictionResults(query = {}) { const db = openDatabase(); try { return renderExport(selectPredictionResultRows(db, query), PREDICTION_RESULT_EXPORT_FIELDS, '预测结果', '预测结果导出', query.format); } finally { db.close(); } }

function normalizeHeader(value) { return String(value || '').trim().replace(/[\s_\-/:：()（）]/g, '').toLowerCase(); }
function mapImportFields(row = {}) { const mapped = {}; const fieldMapping = {}; Object.entries(row).forEach(([header, value]) => { const field = Object.entries(PREDICTION_CONFIG_IMPORT_ALIASES).find(([, aliases]) => aliases.map(normalizeHeader).includes(normalizeHeader(header)))?.[0]; if (field && (mapped[field] === undefined || !normalizeText(mapped[field]))) { mapped[field] = value; fieldMapping[field] = header; } }); return { mapped, fieldMapping }; }
function candidateId(row) { return `prediction-config:${row.rowNumber}:${row.name}`; }
/** 读取预测配置导入 HMAC secret；caller-owned 事务必须复用同一连接。 */
function importSecret(providedDb = null) {
  const configured = normalizeText(process.env.PREDICTION_CONFIG_IMPORT_HMAC_SECRET)
    || normalizeText(process.env.CHARCOAL_HMAC_SECRET)
    || normalizeText(process.env.APP_SECRET);
  if (configured) return configured;
  const ownedDb = !providedDb;
  const db = providedDb || openDatabase();
  try {
    const saved = db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PREDICTION_CONFIG_IMPORT_HMAC_SECRET_META_KEY);
    if (normalizeText(saved?.value)) return saved.value;
    const generated = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO app_meta (key, value, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key) DO NOTHING`).run(PREDICTION_CONFIG_IMPORT_HMAC_SECRET_META_KEY, generated);
    return db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PREDICTION_CONFIG_IMPORT_HMAC_SECRET_META_KEY).value;
  } finally {
    if (ownedDb) db.close();
  }
}

/** 计算与正式导入兼容的候选签名。 */
function previewSignature(rows, secret) {
  return `${PREDICTION_CONFIG_IMPORT_SIGNATURE_PREFIX}:${crypto.createHmac('sha256', secret || importSecret())
    .update(stableStringify({ operation: 'prediction-config-import', rows }))
    .digest('hex')}`;
}
function buildPredictionConfigImportPreviewWithDb(db, rows = [], options = {}) {
  const types = new Map(db.prepare('SELECT id,code,name,is_active AS isActive FROM energy_types').all().map((row) => [row.code, row]));
  const excludedExistingConfigIds = new Set((options.excludedExistingConfigIds || []).map(Number));
  const existingNames = new Set(db.prepare('SELECT id, name FROM prediction_configs').all()
    .filter((row) => !excludedExistingConfigIds.has(Number(row.id)))
    .map((row) => row.name));
  const seenNames = new Set(); const items = []; const fieldMapping = {};
  rows.forEach((row, index) => {
    const rowNumber = Number(row.rowNumber || row.__rowNumber || index + 2);
    const { mapped: baseMapped, fieldMapping: mapping } = mapImportFields(row);
    const mapped = { ...baseMapped, sourceBatchId: baseMapped.sourceBatchId ?? row.sourceBatchFilterId ?? row.sourceBatchId };
    // 表格空单元格按既有导入合同表示可选训练批次未设置；0 和非空异常值仍进入严格校验。
    if (typeof mapped.sourceBatchId === 'string' && mapped.sourceBatchId.trim() === '') {
      delete mapped.sourceBatchId;
    }
    Object.assign(fieldMapping, mapping); const reasons = []; let candidate = null; let status = 'blocked';
    try {
      const energyTypeCode = normalizeText(mapped.energyTypeCode); const energy = energyTypeCode ? types.get(energyTypeCode) : null;
      if (energyTypeCode && !energy) throw badRequest('未找到匹配能源类型。', { code: 'UNKNOWN_ENERGY_TYPE' });
      if (energy && Number(energy.isActive) !== 1) throw badRequest('能源类型已停用。', { code: 'INACTIVE_ENERGY_TYPE' });
      const payload = normalizeConfigPayload({ ...mapped, status: 'draft' });
      candidate = {
        candidateRowId: candidateId({ rowNumber, name: payload.name }),
        rowNumber,
        ...configFields(db, payload, energy?.id || null),
        energyTypeCode: payload.filters.energyTypeCode,
        organizationUnitCode: payload.filters.organizationUnitCode,
        meterCode: payload.filters.meterCode,
        sourceBatchId: payload.filters.sourceBatchId
      };
      if (existingNames.has(candidate.name) || seenNames.has(candidate.name)) {
        reasons.push({ rowNumber, fieldName: 'name', rawValue: candidate.name, code: 'DUPLICATE_PREDICTION_CONFIG_SKIPPED', message: '已存在或同文件重复的预测配置名称按 skip 策略跳过，不覆盖既有草稿。', severity: 'warning' });
        status = 'skipped'; candidate = null;
      } else { seenNames.add(payload.name); status = 'wouldImport'; }
    } catch (error) { reasons.push({ rowNumber, fieldName: null, rawValue: JSON.stringify(mapped), code: error.details?.code || 'INVALID_PREDICTION_CONFIG', message: error.message, severity: 'error' }); }
    const item = { rowNumber, status, wouldImport: status === 'wouldImport', name: candidate?.name || normalizeText(mapped.name), reasons, errors: reasons.filter((reason) => reason.severity === 'error'), warnings: reasons.filter((reason) => reason.severity === 'warning'), reasonCodes: reasons.map((reason) => reason.code).join('|'), reasonText: reasons.map((reason) => reason.message).join('；'), candidate };
    items.push(item);
  });
  const candidateRows = items.filter((item) => item.wouldImport).map((item) => item.candidate);
  const summary = { totalRows: items.length, wouldImport: candidateRows.length, skipped: items.filter((item) => item.status === 'skipped').length, blocked: items.filter((item) => item.status === 'blocked').length, warnings: items.reduce((sum, item) => sum + item.warnings.length, 0), errors: items.reduce((sum, item) => sum + item.errors.length, 0) };
  const preview = { dryRun: true, previewOnly: true, writesPredictionConfigs: false, writesPredictionRuns: false, writesPredictionResults: false, persistsImportBatch: true, duplicateStrategy: 'skip', confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT, backupReason: PREDICTION_CONFIG_IMPORT_BACKUP_REASON, fieldMapping, summary, candidateRowIds: candidateRows.map((row) => row.rowNumber), candidateRows, items, notices: ['配置导入只生成可编辑 draft 预测配置，不运行预测，不写 prediction_runs 或 prediction_results，也不写 energy_records/carbon_emissions。', '预测结果只能由后端依据已入库 active energy_records 运行生成。'] };
  const secret = options.secret || importSecret(db);
  preview.previewSignature = previewSignature(candidateRows, secret);
  preview.previewAuditDigest = `${PREDICTION_CONFIG_IMPORT_AUDIT_DIGEST_PREFIX}:${crypto.createHmac('sha256', secret)
    .update(stableStringify({ summary, items: items.map((item) => ({ rowNumber: item.rowNumber, status: item.status, reasonCodes: item.reasonCodes })) }))
    .digest('hex')}`;
  return preview;
}
function buildPredictionConfigImportPreviewFromRows(rows = []) {
  const db = openDatabase();
  try {
    return buildPredictionConfigImportPreviewWithDb(db, rows, { secret: importSecret(db) });
  } finally {
    db.close();
  }
}

/** 打开预测配置导入数据库；测试仅通过 databasePath 指向隔离 SQLite。 */
function openPredictionConfigImportDatabase(options = {}) {
  if (options.db) return { db: options.db, owned: false };
  return {
    db: openDatabase(options.databasePath ? { databasePath: options.databasePath } : {}),
    owned: true
  };
}

/** 安全读取 preview 文件；managed 模式必须保留受控上传目录内的原始字节。 */
function readPredictionConfigPreviewUpload(file, options = {}) {
  assertSupportedImportFile(file.originalname);
  if (file.filename) {
    const safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, file.filename, {
      expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined,
      maxSizeBytes: MAX_IMPORT_FILE_SIZE_BYTES,
      afterFileOpen: options.afterManagedPreviewFileOpen
    });
    return { ...safeFile, parsed: parseImportBuffer(safeFile.buffer, file.originalname) };
  }
  if (options.demoContext) {
    throw badRequest('managed 预测配置 preview 必须保留上传目录内的原始文件。', {
      code: 'PREDICTION_CONFIG_IMPORT_RETAINED_UPLOAD_REQUIRED'
    });
  }
  const parsed = parseImportFile(file.path, file.originalname);
  return { filePath: file.path, sizeBytes: file.size, fileSha256: null, parsed };
}

/** 收集预测配置 preview 的行级审计问题。 */
function collectPredictionConfigImportAuditIssues(preview) {
  return (preview.items || []).flatMap((item) => item.reasons || []);
}

/** 投影与 import_errors 持久化列完全一致的 canonical 行级审计集合。 */
function projectPredictionConfigImportAuditIssues(preview) {
  return collectPredictionConfigImportAuditIssues(preview).map((issue) => {
    const rawValue = issue.rawValue ?? issue.raw_value;
    return {
      rowNumber: Number(issue.rowNumber ?? issue.row_number),
      fieldName: issue.fieldName ?? issue.field_name ?? null,
      rawValue: rawValue && typeof rawValue === 'object'
        ? stableStringify(normalizePredictionAuditValue(rawValue))
        : (rawValue === undefined || rawValue === null ? null : String(rawValue)),
      errorCode: String(issue.code || issue.errorCode || issue.error_code || '').trim(),
      errorReason: String(issue.message || issue.errorReason || issue.error_reason || '').trim(),
      severity: String(issue.severity || 'error').trim().toLowerCase()
    };
  });
}

/** 创建正式或 managed retained prediction config preview。 */
function createPredictionConfigImportPreviewFromUpload(file, options = {}) {
  if (!file) {
    throw badRequest('请使用 multipart/form-data 上传字段名为 file 的预测配置表格文件。', {
      code: 'IMPORT_FILE_REQUIRED',
      fieldName: 'file'
    });
  }
  const upload = readPredictionConfigPreviewUpload(file, options);
  const databaseContext = openPredictionConfigImportDatabase(options);
  try {
    const createPreview = () => {
      const secret = importSecret(databaseContext.db);
      const preview = buildPredictionConfigImportPreviewWithDb(
        databaseContext.db,
        upload.parsed.rows || [],
        { secret }
      );
      const audit = createPreviewAuditBatch({
        importType: PREDICTION_CONFIG_IMPORT_TYPE,
        originalFilename: file.originalname,
        storedFilename: file.filename || null,
        filePath: upload.filePath,
        fileType: upload.parsed.fileType,
        fileSizeBytes: upload.sizeBytes,
        fileSha256: upload.fileSha256,
        duplicateStrategy: 'skip',
        fieldMapping: preview.fieldMapping,
        previewSignature: preview.previewSignature,
        previewAuditDigest: preview.previewAuditDigest,
        auditContext: {
          summary: preview.summary,
          candidateRows: preview.candidateRows,
          candidateRowIds: preview.candidateRowIds,
          confirmText: preview.confirmText,
          backupReason: preview.backupReason,
          previewAuditDigest: preview.previewAuditDigest,
          notices: preview.notices
        },
        statistics: {
          totalRows: preview.summary.totalRows,
          successCount: preview.summary.wouldImport,
          failureCount: preview.summary.blocked,
          skippedCount: preview.summary.skipped
        }
      }, { db: databaseContext.db });
      replaceImportAuditIssuesWithDatabase(
        databaseContext.db,
        audit.id,
        collectPredictionConfigImportAuditIssues(preview)
      );
      if (options.demoContext) {
        const { bindDemoContextPreviewInTransaction } = getPredictionDemoContextService();
        bindDemoContextPreviewInTransaction({
          db: databaseContext.db,
          ...options.demoContext,
          uploadFileSha256: upload.fileSha256,
          previewDigest: preview.previewAuditDigest,
          batchBindings: [{ batchId: audit.id, batchRole: 'primary' }]
        });
        if (typeof options.beforeManagedPreviewOperationAudit === 'function') {
          options.beforeManagedPreviewOperationAudit({ db: databaseContext.db, batchId: audit.id });
        }
        recordOperation({
          userId: options.actor?.userId ?? options.demoContext.userId,
          operation: 'prediction.config.import.preview',
          targetType: 'prediction_config_import',
          targetId: audit.id,
          detail: {
            wouldImport: preview.summary.wouldImport,
            blocked: preview.summary.blocked
          },
          ip: options.actor?.ip || null,
          db: databaseContext.db
        });
      }
      const auditBatch = getImportAuditSummary(audit.id, { db: databaseContext.db });
      return { ...preview, batchId: auditBatch.id, auditBatch };
    };
    const result = databaseContext.db.inTransaction
      ? createPreview()
      : databaseContext.db.transaction(createPreview).immediate();
    if (options.demoContext && databaseContext.owned && options.managedUploadState) {
      options.managedUploadState.committed = true;
    }
    return result;
  } finally {
    if (databaseContext.owned) databaseContext.db.close();
  }
}

/** 只保留对外允许落入备份审计的元数据。 */
function projectPredictionBackupMetadata(backup = {}) {
  return ['backupName', 'reason', 'method', 'sizeBytes', 'createdAt', 'updatedAt', 'sha256']
    .reduce((result, key) => {
      if (backup[key] !== undefined) result[key] = backup[key];
      return result;
    }, {});
}

/** 投影 managed ownership 的固定计数摘要。 */
function projectPredictionOwnershipSummary(ownership = {}) {
  const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  return {
    applied: ownership.applied === true,
    mode: ownership.mode === 'demo' ? 'demo' : 'unknown',
    noInsertedRecords: ownership.noInsertedRecords === true,
    registrationCount: count(ownership.registrationCount),
    insertedCount: count(ownership.insertedCount),
    idempotentCount: count(ownership.idempotentCount),
    skippedCount: count(ownership.skippedCount),
    relationCount: count(ownership.relationCount)
  };
}

/** managed execute 只允许 retained replay 所需的最小确认字段。 */
function normalizeManagedPredictionConfigExecuteRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('预测配置 managed execute 请求体必须是对象。', {
      code: 'PREDICTION_CONFIG_IMPORT_EXECUTE_BODY_INVALID'
    });
  }
  const allowedFields = new Set(['batchId', 'confirmText', 'requireBackup', 'acknowledgeSkippedRisks']);
  const extraFields = Object.keys(body).filter((fieldName) => !allowedFields.has(fieldName));
  if (extraFields.length > 0) {
    throw badRequest('预测配置 managed execute 仅允许固定确认字段。', {
      code: 'PREDICTION_CONFIG_IMPORT_EXECUTE_FIELDS_INVALID',
      extraFields: extraFields.sort()
    });
  }
  const batchId = normalizePositiveInteger(body.batchId, 'batchId');
  if (body.confirmText !== PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT
    || body.requireBackup !== true
    || body.acknowledgeSkippedRisks !== true) {
    throw badRequest('预测配置 managed execute 必须确认固定文案、备份和跳过风险。', {
      code: 'PREDICTION_CONFIG_IMPORT_CONFIRMATION_INVALID',
      expectedConfirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT
    });
  }
  return { batchId };
}

/** 从 retained 原字节重建 Artifact 12 preview，并可仅排除该批次已导入配置。 */
function rebuildManagedPredictionConfigPreview(db, safeFile, originalFilename, excludedExistingConfigIds = []) {
  const parsed = parseImportBuffer(safeFile.buffer, originalFilename);
  return buildPredictionConfigImportPreviewWithDb(db, parsed.rows || [], {
    secret: importSecret(db),
    excludedExistingConfigIds
  });
}

/** 比较 retained file、preview audit 与服务端重算候选，任何漂移都 fail-closed。 */
function assertManagedPredictionConfigBatchMatches(batch, preview, safeFile, options = {}) {
  const mismatchReasons = [];
  const expectedAuditPhase = options.expectedAuditPhase || 'preview';
  if (batch.importType !== PREDICTION_CONFIG_IMPORT_TYPE) mismatchReasons.push('import-type');
  if (batch.auditPhase !== expectedAuditPhase) mismatchReasons.push('audit-phase');
  if (!['completed', 'completed_with_errors'].includes(batch.status)) mismatchReasons.push('audit-status');
  if (batch.fileSha256 !== safeFile.fileSha256) mismatchReasons.push('file-sha256');
  if (Number(batch.fileSizeBytes) !== safeFile.sizeBytes) mismatchReasons.push('file-size');
  if (!timingSafeEqualText(batch.previewSignature, preview.previewSignature)) mismatchReasons.push('preview-signature');
  if (!timingSafeEqualText(batch.previewAuditDigest, preview.previewAuditDigest)) mismatchReasons.push('preview-digest');
  if (batch.auditContext?.confirmText !== PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT) mismatchReasons.push('confirm-text');
  if (!timingSafeEqualText(batch.auditContext?.previewAuditDigest, preview.previewAuditDigest)) mismatchReasons.push('audit-context-digest');
  if (stableStringify(batch.auditContext?.summary || {}) !== stableStringify(preview.summary)) mismatchReasons.push('summary');
  if (stableStringify(batch.auditContext?.candidateRows || []) !== stableStringify(normalizePredictionAuditValue(preview.candidateRows))) mismatchReasons.push('candidate-rows');
  if (stableStringify(batch.auditContext?.candidateRowIds || []) !== stableStringify(preview.candidateRowIds)) mismatchReasons.push('candidate-row-ids');
  if (mismatchReasons.length > 0) {
    throw badRequest('预测配置批次、原文件或最新预演事实不一致。', {
      code: 'PREDICTION_CONFIG_IMPORT_MANAGED_BATCH_MISMATCH',
      mismatchReasons
    });
  }
  if (preview.candidateRows.length !== 1) {
    throw badRequest('Artifact 12 managed execute 必须且只能产生一个可导入预测配置。', {
      code: 'PREDICTION_CONFIG_IMPORT_MANAGED_CANDIDATE_COUNT_INVALID',
      candidateCount: preview.candidateRows.length
    });
  }
}

/** 执行 Artifact 12 managed retained preview/execute/replay 单一 operation。 */
async function executeManagedPredictionConfigImport(body = {}, options = {}) {
  const request = normalizeManagedPredictionConfigExecuteRequest(body);
  const demoContext = options.demoContext;
  if (!demoContext || (options.actor?.userId !== undefined
    && options.actor.userId !== demoContext.userId)) {
    throw badRequest('预测配置导入 actor 与 managed context 用户不一致。', {
      code: 'PREDICTION_CONFIG_IMPORT_ACTOR_MISMATCH'
    });
  }
  const protocol = getPredictionConfigManagedOwnershipProtocol();
  const faultInjector = typeof options.managedFaultInjector === 'function'
    ? options.managedFaultInjector
    : (stage, facts) => {
      if (stage === 'after-config-insert'
        && typeof options.beforeManagedOwnershipRegistration === 'function') {
        options.beforeManagedOwnershipRegistration(facts);
      }
      if (stage === 'before-execute-audit'
        && typeof options.beforeManagedExecuteAudit === 'function') {
        options.beforeManagedExecuteAudit(facts);
      }
      if (stage === 'before-context-cas'
        && typeof options.beforeManagedContextExecuted === 'function') {
        options.beforeManagedContextExecuted(facts);
      }
    };
  const databaseContext = openPredictionConfigImportDatabase(options);
  try {
    return await protocol.executeManagedImport(databaseContext.db, {
      actor: Object.freeze({
        userId: demoContext.userId,
        ip: options.actor?.ip || null
      }),
      backupsDir: options.backupsDir,
      batchId: request.batchId,
      createBackup: options.createBackup || backupService.createBackup,
      demoContext: Object.freeze({
        token: demoContext.token,
        userId: demoContext.userId,
        artifactKey: demoContext.artifactKey,
        handlerKey: demoContext.handlerKey
      }),
      faultInjector,
      uploadsDir: options.uploadsDir || defaultUploadsDir
    });
  } finally {
    if (databaseContext.owned) databaseContext.db.close();
  }
}

/** 保持普通、无 demo context 的预测配置正式导入合同。 */
async function executeFormalPredictionConfigImport(body = {}) {
  const fail = (message, code) => { throw badRequest(message, { code }); };
  if (normalizeText(body.confirmText) !== PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT) fail('确认文本不匹配，已拒绝导入预测配置草稿。', 'PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT_MISMATCH');
  if (body.acknowledgeSkippedRisks !== true) fail('必须确认无效或重复记录将被跳过。', 'PREDICTION_CONFIG_IMPORT_SKIPPED_RISKS_ACK_REQUIRED');
  if (body.requireBackup !== true) fail('执行前必须要求自动备份。', 'PREDICTION_CONFIG_IMPORT_BACKUP_REQUIRED');
  if (!Array.isArray(body.candidateRows) || !body.candidateRows.length || !Array.isArray(body.candidateRowIds)) fail('candidateRows 和 candidateRowIds 必须来自 preview。', 'PREDICTION_CONFIG_IMPORT_CANDIDATES_REQUIRED');
  const db = openDatabase(); let latest;
  try {
    latest = buildPredictionConfigImportPreviewWithDb(db, body.candidateRows, { secret: importSecret(db) });
  } finally { db.close(); }
  if (!timingSafeEqualText(body.previewSignature, latest.previewSignature)) fail('当前 previewSignature 与重新计算结果不一致，请重新 preview。', 'PREDICTION_CONFIG_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
  if (stableStringify(body.candidateRowIds.map(Number)) !== stableStringify(latest.candidateRowIds)) fail('候选行与最新预演不一致，请重新 preview。', 'PREDICTION_CONFIG_IMPORT_CANDIDATES_MISMATCH');
  const batchId = normalizePositiveInteger(body.batchId, 'batchId');
  const batch = getImportAuditBatchDetail(batchId, { includeIssues: false });
  if (batch.importType !== PREDICTION_CONFIG_IMPORT_TYPE || !timingSafeEqualText(batch.previewSignature, body.previewSignature)) fail('batchId 与预测配置 previewSignature 不匹配。', 'PREDICTION_CONFIG_IMPORT_AUDIT_BATCH_MISMATCH');
  const backup = await backupService.createBackup({ reason: PREDICTION_CONFIG_IMPORT_BACKUP_REASON });
  const writeDb = openDatabase();
  try {
    return writeDb.transaction(() => {
      const current = buildPredictionConfigImportPreviewWithDb(writeDb, body.candidateRows, { secret: importSecret(writeDb) });
      if (!timingSafeEqualText(body.previewSignature, current.previewSignature)) fail('写入前预演已失效，请重新 preview。', 'PREDICTION_CONFIG_IMPORT_EXPIRED_PREVIEW');
      const insert = writeDb.prepare(`INSERT INTO prediction_configs (source_batch_id,source_row_number,name,note,energy_type_id,organization_unit_id,meter_device_id,source_batch_filter_id,train_start_month,train_end_month,predict_start_month,predict_end_month,algorithm,window_size,status) VALUES (@batchId,@sourceRowNumber,@name,@note,@energyTypeId,@organizationUnitId,@meterDeviceId,@sourceBatchFilterId,@trainStartMonth,@trainEndMonth,@predictStartMonth,@predictEndMonth,@algorithm,@windowSize,'draft')`);
      const created = current.candidateRows.map((row) => {
        const id = insert.run({ ...row, batchId, sourceRowNumber: row.rowNumber }).lastInsertRowid;
        return getPredictionConfigById(writeDb, id);
      });
      const result = {
        executed: true,
        dryRun: false,
        imported: created.length,
        skipped: Number(batch.skippedCount || 0),
        blocked: Number(batch.failureCount || 0),
        writesPredictionConfigs: true,
        writesPredictionRuns: false,
        writesPredictionResults: false,
        writesEnergyRecords: false,
        writesCarbonEmissions: false,
        importedRecords: created,
        backup: projectPredictionBackupMetadata(backup),
        note: '仅导入 draft 预测配置；未运行预测且未写入结果。'
      };
      updateExecuteAuditResult(batchId, {
        status: batch.failureCount || batch.skippedCount ? 'completed_with_errors' : 'completed',
        statistics: {
          totalRows: batch.totalRows,
          successCount: created.length,
          failureCount: batch.failureCount,
          skippedCount: batch.skippedCount
        },
        executeResult: result,
        backup: result.backup
      }, { db: writeDb });
      return { ...result, batchId, auditBatch: getImportAuditSummary(batchId, { db: writeDb }) };
    })();
  } finally { writeDb.close(); }
}

async function executePredictionConfigImport(body = {}, options = {}) {
  return options.demoContext
    ? executeManagedPredictionConfigImport(body, options)
    : executeFormalPredictionConfigImport(body);
}

function getPredictionManagementContract() { return { status: 'unified-management-api-ready', configTable: 'prediction_configs', runTable: 'prediction_runs', resultTable: 'prediction_results', configStatuses: PREDICTION_CONFIG_STATUSES, runStatuses: ['pending', 'running', 'completed', 'failed', 'cancelled', 'archived'], implementedAlgorithms: ['moving_average', 'linear_trend'], routes: { configList: 'GET /api/predictions/configs', configDetail: 'GET /api/predictions/configs/:configId', configCreate: 'POST /api/predictions/configs', configUpdate: 'PUT /api/predictions/configs/:configId', configStatus: 'PATCH /api/predictions/configs/:configId/status', configCopy: 'POST /api/predictions/configs/:configId/copy', configRun: 'POST /api/predictions/configs/:configId/runs', configExport: 'GET /api/predictions/configs/export?format=xlsx|csv', configImportPreview: 'POST /api/predictions/configs/import/preview', configImportExecute: 'POST /api/predictions/configs/import/execute', configTemplate: 'GET /api/templates/prediction-configs.xlsx|csv', runList: 'GET /api/predictions/runs', runDetail: 'GET /api/predictions/runs/:runId', runStatus: 'PATCH /api/predictions/runs/:runId/status', runStats: 'GET /api/predictions/runs/stats', resultList: 'GET /api/predictions/results', resultExport: 'GET /api/predictions/results/export?format=xlsx|csv' }, permissions: { config: ['prediction:config:view', 'prediction:config:create', 'prediction:config:update', 'prediction:config:status', 'prediction:config:import', 'prediction:config:export', 'prediction:config:template'], run: ['prediction:run:create', 'prediction:run:view', 'prediction:run:cancel', 'prediction:run:export'], result: ['prediction:result:view', 'prediction:result:export'] }, import: { template: { type: PREDICTION_CONFIG_IMPORT_TEMPLATE_ID, headers: PREDICTION_CONFIG_IMPORT_HEADERS, aliases: PREDICTION_CONFIG_IMPORT_ALIASES }, confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT, previewWrites: '仅统一 import_batches/import_errors 审计；不写 prediction_configs、prediction_runs、prediction_results、energy_records 或 carbon_emissions。', executeWrites: '仅写 prediction_configs 且强制状态为 draft；不触发预测运行或写预测结果。' }, resultPolicy: '预测结果不可手工导入、新增、编辑或删除；只能由服务端基于 active energy_records 在创建运行时生成。样本不足时运行 failed，prediction_results 保持为空。' }; }

Object.assign(predictionServiceExports, { PREDICTION_CONFIG_EXPORT_FIELDS, PREDICTION_CONFIG_IMPORT_ALIASES, PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT, PREDICTION_CONFIG_IMPORT_HEADERS, PREDICTION_CONFIG_IMPORT_TEMPLATE_ID, PREDICTION_CONFIG_STATUSES, PREDICTION_RESULT_EXPORT_FIELDS, buildConfigWhere, buildHistoryWhere, buildPredictionConfigImportPreviewFromRows, buildPredictionStats, buildResultWhere, buildRunListWhere, cancelOrArchivePredictionRun, copyPredictionConfig, createPredictionConfig, createPredictionConfigImportPreviewFromUpload, createPredictionRun, createRunFromConfig, executePredictionConfigImport, exportPredictionConfigs, exportPredictionResults, getPredictionConfig, getPredictionManagementContract, getPredictionRun, listPredictionConfigs, listPredictionResults, listPredictionRuns, normalizeConfigPayload, normalizePredictionPayload, setPredictionConfigStatus, updatePredictionConfig });

Object.defineProperty(predictionServiceExports, PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL, {
  value: Object.freeze({
    withCallerTransactionScope: withPredictionExactCallerTransactionScope,
    inspectExact: inspectPredictionExactInCallerTransaction,
    executeExact: executePredictionExactInCallerTransaction,
    readCompletionWitness: readPredictionCompletionWitnessInCallerTransaction,
    consumeCompletionWitness: consumePredictionCompletionWitnessInCallerTransaction,
    bindP4CompletionVerifier: bindPredictionP4CompletionVerifier
  }),
  enumerable: false,
  writable: false,
  configurable: false
});

Object.defineProperty(predictionServiceExports, PREDICTION_CONFIG_MANAGED_CORE_PROTOCOL_SYMBOL, {
  value: Object.freeze({
    assertBatchMatches: assertManagedPredictionConfigBatchMatches,
    backupReason: PREDICTION_CONFIG_IMPORT_BACKUP_REASON,
    getAuditSummary: getImportAuditSummary,
    getBatch: getImportAuditBatchDetail,
    getConfigById: getPredictionConfigById,
    projectAuditIssues: projectPredictionConfigImportAuditIssues,
    projectBackup: projectPredictionBackupMetadata,
    projectOwnership: projectPredictionOwnershipSummary,
    rebuildPreview: rebuildManagedPredictionConfigPreview
  }),
  enumerable: false,
  writable: false,
  configurable: false
});
