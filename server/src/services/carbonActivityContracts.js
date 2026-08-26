'use strict';

const crypto = require('crypto');
const { badRequest } = require('../utils/errors');

// 独立碳活动固定 Excel v1 模板身份。
const CARBON_ACTIVITY_TEMPLATE_TYPE = 'carbon-activities';
const CARBON_ACTIVITY_IMPORT_TYPE = 'carbon_activity';
const CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT = '确认导入独立碳活动';
const CARBON_ACTIVITY_IMPORT_BACKUP_REASON = 'carbon-activity-import';
const CARBON_ACTIVITY_WORKSHEET_NAME = '独立碳活动';
// 固定 15 列中文表头禁止别名、缺列、增列和重排。
const CARBON_ACTIVITY_IMPORT_HEADERS = Object.freeze([
  '活动记录编码',
  '替代活动记录编码',
  '排放范围',
  '活动类别',
  '用能单元编码',
  '能源类型编码',
  '活动开始时间',
  '活动结束时间',
  '来源时区',
  '活动数据值',
  '活动数据单位',
  '因子地区',
  '来源标识',
  '证据引用',
  '备注'
]);

// 业务字段长度由固定模板、数据库事实和查询导出共同遵守。
const CARBON_ACTIVITY_FIELD_LIMITS = Object.freeze({
  activityCode: 64,
  supersedesActivityCode: 64,
  activityCategory: 200,
  organizationUnitCode: 64,
  energyTypeCode: 64,
  sourceTimezone: 100,
  activityUnit: 64,
  factorRegion: 100,
  sourceReference: 500,
  evidenceReference: 1000,
  note: 1000,
  voidReason: 500
});

// 固定 Excel v1 在 SheetJS 解压前和解析后都执行资源限制。
const CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS = Object.freeze({
  maxDataRows: 5000,
  maxColumns: 15,
  maxNonEmptyCells: 75015,
  maxWorksheets: 1,
  maxZipEntries: 256,
  maxZipEntryUncompressedBytes: 64 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 128 * 1024 * 1024,
  maxWorkbookTextCharacters: 10_000_000,
  maxIssues: 5000,
  maxUploadBytes: 10 * 1024 * 1024
});

// 排放范围支持固定中英文展示别名，统一持久化为 scope_1/2/3。
const CARBON_ACTIVITY_SCOPE_ALIASES = Object.freeze({
  scope_1: 'scope_1',
  scope1: 'scope_1',
  'scope 1': 'scope_1',
  范围一: 'scope_1',
  范围1: 'scope_1',
  直接排放: 'scope_1',
  scope_2: 'scope_2',
  scope2: 'scope_2',
  'scope 2': 'scope_2',
  范围二: 'scope_2',
  范围2: 'scope_2',
  购入能源间接排放: 'scope_2',
  scope_3: 'scope_3',
  scope3: 'scope_3',
  'scope 3': 'scope_3',
  范围三: 'scope_3',
  范围3: 'scope_3',
  其他间接排放: 'scope_3'
});

// 活动值上限防止非有限数和 SQLite REAL 极值进入核算事实。
const CARBON_ACTIVITY_MAX_VALUE = 1e15;
// duplicate key 使用显式版本域，未来字段升级时不得静默改变 v1 历史语义。
const CARBON_ACTIVITY_DUPLICATE_KEY_DOMAIN = 'carbon-activity-duplicate:v1';

/** 将任意显示值规范化为去除首尾空白的文本。 */
function normalizeCarbonActivityText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 使用 trim、Unicode NFKC 和 locale-independent 大写生成编码规范键。 */
function buildCarbonActivityCodeKey(value) {
  return normalizeCarbonActivityText(value).normalize('NFKC').toUpperCase();
}

/** 使用 trim、Unicode NFKC 和 locale-independent 大写生成类别或单位匹配键。 */
function buildCarbonActivityNormalizationKey(value) {
  return normalizeCarbonActivityText(value).normalize('NFKC').toUpperCase();
}

/** 将排放范围中英文别名映射为冻结枚举。 */
function normalizeCarbonActivityScope(value) {
  const normalized = normalizeCarbonActivityText(value).normalize('NFKC').toLowerCase();
  return CARBON_ACTIVITY_SCOPE_ALIASES[normalized] || null;
}

/** 将空因子地区规范化为 default，并保留非空显示文本。 */
function normalizeCarbonActivityFactorRegion(value) {
  return normalizeCarbonActivityText(value) || 'default';
}

/** 规范化有限、非负且不超过冻结上限的活动值。 */
function normalizeCarbonActivityValue(value) {
  const text = normalizeCarbonActivityText(value);
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isFinite(numberValue)
    && numberValue >= 0
    && numberValue <= CARBON_ACTIVITY_MAX_VALUE
    ? numberValue
    : null;
}

/**
 * 生成稳定 duplicate key v1；调用方必须传入服务端解析后的规范事实。
 * @param {object} input 规范活动事实。
 * @returns {string} 64 位小写 SHA-256。
 */
function buildCarbonActivityDuplicateKey(input = {}) {
  const payload = [
    CARBON_ACTIVITY_DUPLICATE_KEY_DOMAIN,
    input.emissionScope,
    input.activityCategoryKey,
    Number(input.organizationUnitId),
    Number(input.energyTypeId),
    input.startUtc,
    input.endUtc,
    Number(input.activityValue),
    buildCarbonActivityNormalizationKey(input.activityUnit),
    buildCarbonActivityNormalizationKey(input.factorRegion || 'default'),
    normalizeCarbonActivityText(input.sourceReference).normalize('NFKC')
  ];
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** 严格拒绝请求对象中的未知字段。 */
function assertCarbonActivityAllowedFields(input, allowedFields, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('独立碳活动请求体必须是 JSON 对象。', {
      code: 'CARBON_ACTIVITY_PAYLOAD_INVALID',
      operation
    });
  }
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('独立碳活动请求包含不受支持的字段。', {
      code: 'CARBON_ACTIVITY_UNKNOWN_FIELDS_REJECTED',
      operation,
      unknownFields
    });
  }
}

module.exports = {
  CARBON_ACTIVITY_DUPLICATE_KEY_DOMAIN,
  CARBON_ACTIVITY_FIELD_LIMITS,
  CARBON_ACTIVITY_IMPORT_BACKUP_REASON,
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_IMPORT_RESOURCE_LIMITS,
  CARBON_ACTIVITY_IMPORT_TYPE,
  CARBON_ACTIVITY_MAX_VALUE,
  CARBON_ACTIVITY_SCOPE_ALIASES,
  CARBON_ACTIVITY_TEMPLATE_TYPE,
  CARBON_ACTIVITY_WORKSHEET_NAME,
  assertCarbonActivityAllowedFields,
  buildCarbonActivityCodeKey,
  buildCarbonActivityDuplicateKey,
  buildCarbonActivityNormalizationKey,
  normalizeCarbonActivityFactorRegion,
  normalizeCarbonActivityScope,
  normalizeCarbonActivityText,
  normalizeCarbonActivityValue
};
