'use strict';

const { badRequest } = require('../utils/errors');

// 碳排放报告固定 Excel v1 模板身份和受控导入语义。
const CARBON_EMISSION_REPORT_TEMPLATE_TYPE = 'carbon-emission-report';
const CARBON_EMISSION_REPORT_TEMPLATE_VERSION = '1.0';
const CARBON_EMISSION_REPORT_IMPORT_TYPE = 'carbon_emission_report';
const CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT = '确认导入碳排放报告';
const CARBON_EMISSION_REPORT_IMPORT_BACKUP_REASON = 'carbon-emission-report-import';

// 五张可见工作表的名称、顺序和精确中文表头均属于冻结合同。
const CARBON_EMISSION_REPORT_SHEETS = Object.freeze([
  Object.freeze({
    key: 'report',
    name: '报告信息',
    headers: Object.freeze(['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注']),
    minDataRows: 1,
    maxDataRows: 1
  }),
  Object.freeze({
    key: 'boundaries',
    name: '组织与核算边界',
    headers: Object.freeze(['边界类型', '边界名称', '边界说明']),
    minDataRows: 2,
    maxDataRows: 2
  }),
  Object.freeze({
    key: 'items',
    name: '报告项目',
    headers: Object.freeze(['项目编码', '排放范围', '类别', '排放源或能源类型', '活动量', '活动量单位', '排放因子', '因子单位', '排放量', 'CO2e单位', '证据编号', '备注']),
    minDataRows: 1,
    maxDataRows: 5000
  }),
  Object.freeze({
    key: 'summaries',
    name: '汇总',
    headers: Object.freeze(['汇总编码', '汇总维度', '汇总值', '排放量', 'CO2e单位', '备注']),
    minDataRows: 1,
    maxDataRows: 5000
  }),
  Object.freeze({
    key: 'evidence',
    name: '证据说明',
    headers: Object.freeze(['证据编号', '证据名称', '证据类型', '证据说明', '备注']),
    minDataRows: 1,
    maxDataRows: 5000
  })
]);

// 多表工作簿在 SheetJS 解压前和解析后同时执行资源限制。
const CARBON_EMISSION_REPORT_RESOURCE_LIMITS = Object.freeze({
  maxWorksheets: CARBON_EMISSION_REPORT_SHEETS.length,
  maxZipEntries: 256,
  maxZipEntryUncompressedBytes: 64 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNonEmptyCells: 100000,
  maxWorkbookTextCharacters: 10_000_000,
  maxIssues: 10000,
  maxUploadBytes: 10 * 1024 * 1024
});

// 报告事实字段长度由模板、导入、查询和导出共同遵守。
const CARBON_EMISSION_REPORT_FIELD_LIMITS = Object.freeze({
  reportCode: 128,
  reportName: 300,
  reportOrganization: 300,
  note: 2000,
  boundaryName: 500,
  boundaryDescription: 4000,
  itemCode: 128,
  category: 300,
  emissionSource: 500,
  activityUnit: 100,
  factorUnit: 200,
  co2eUnit: 100,
  evidenceCode: 128,
  summaryCode: 128,
  summaryValue: 300,
  evidenceName: 500,
  evidenceType: 100,
  evidenceDescription: 4000
});

// 导入数值上限防止非有限数和 SQLite REAL 极值进入报告事实。
const CARBON_EMISSION_REPORT_MAX_VALUE = 1e15;

// 排放范围允许固定中英文别名，持久化统一为 scope_1/2/3。
const CARBON_EMISSION_REPORT_SCOPE_ALIASES = Object.freeze({
  scope_1: 'scope_1', scope1: 'scope_1', 'scope 1': 'scope_1', 范围一: 'scope_1', 范围1: 'scope_1', 直接排放: 'scope_1',
  scope_2: 'scope_2', scope2: 'scope_2', 'scope 2': 'scope_2', 范围二: 'scope_2', 范围2: 'scope_2', 购入能源间接排放: 'scope_2',
  scope_3: 'scope_3', scope3: 'scope_3', 'scope 3': 'scope_3', 范围三: 'scope_3', 范围3: 'scope_3', 其他间接排放: 'scope_3'
});

// 边界类型固定为组织边界和核算边界，且每份报告各一行。
const CARBON_EMISSION_REPORT_BOUNDARY_ALIASES = Object.freeze({
  组织边界: 'organization', organization: 'organization',
  核算边界: 'accounting', accounting: 'accounting'
});

// 汇总维度固定为总计、排放范围和类别。
const CARBON_EMISSION_REPORT_SUMMARY_DIMENSION_ALIASES = Object.freeze({
  总计: 'total', total: 'total',
  排放范围: 'scope', 范围: 'scope', scope: 'scope',
  类别: 'category', category: 'category'
});

/** 将任意显示值规范化为去除首尾空白的文本。 */
function normalizeCarbonEmissionReportText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 使用 trim、Unicode NFKC 和 locale-independent 大写生成编码规范键。 */
function buildCarbonEmissionReportCodeKey(value) {
  return normalizeCarbonEmissionReportText(value).normalize('NFKC').toUpperCase();
}

/** 生成文本匹配规范键，供单位、类别和汇总一致性校验使用。 */
function buildCarbonEmissionReportNormalizationKey(value) {
  return normalizeCarbonEmissionReportText(value).normalize('NFKC').toUpperCase();
}

/** 将排放范围别名映射为冻结枚举。 */
function normalizeCarbonEmissionReportScope(value) {
  const key = normalizeCarbonEmissionReportText(value).normalize('NFKC').toLowerCase();
  return CARBON_EMISSION_REPORT_SCOPE_ALIASES[key] || null;
}

/** 将边界类型映射为冻结枚举。 */
function normalizeCarbonEmissionReportBoundaryType(value) {
  const key = normalizeCarbonEmissionReportText(value).normalize('NFKC').toLowerCase();
  return CARBON_EMISSION_REPORT_BOUNDARY_ALIASES[key] || null;
}

/** 将汇总维度映射为冻结枚举。 */
function normalizeCarbonEmissionReportSummaryDimension(value) {
  const key = normalizeCarbonEmissionReportText(value).normalize('NFKC').toLowerCase();
  return CARBON_EMISSION_REPORT_SUMMARY_DIMENSION_ALIASES[key] || null;
}

/** 规范化有限、非负且不超过冻结上限的数值。 */
function normalizeCarbonEmissionReportNonNegativeNumber(value) {
  const text = normalizeCarbonEmissionReportText(value);
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isFinite(numberValue) && numberValue >= 0 && numberValue <= CARBON_EMISSION_REPORT_MAX_VALUE
    ? numberValue
    : null;
}

/** 规范化有限、正数且不超过冻结上限的排放因子。 */
function normalizeCarbonEmissionReportPositiveNumber(value) {
  const numberValue = normalizeCarbonEmissionReportNonNegativeNumber(value);
  return numberValue !== null && numberValue > 0 ? numberValue : null;
}

/** 严格校验 YYYY-MM-DD 日历日期，不进行时区推断。 */
function normalizeCarbonEmissionReportDate(value) {
  const text = normalizeCarbonEmissionReportText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? text
    : null;
}

/** 严格拒绝请求对象中的未知字段。 */
function assertCarbonEmissionReportAllowedFields(input, allowedFields, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('碳排放报告请求体必须是 JSON 对象。', {
      code: 'CARBON_EMISSION_REPORT_PAYLOAD_INVALID', operation
    });
  }
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('碳排放报告请求包含不受支持的字段。', {
      code: 'CARBON_EMISSION_REPORT_UNKNOWN_FIELDS_REJECTED', operation, unknownFields
    });
  }
}

module.exports = {
  CARBON_EMISSION_REPORT_BOUNDARY_ALIASES,
  CARBON_EMISSION_REPORT_FIELD_LIMITS,
  CARBON_EMISSION_REPORT_IMPORT_BACKUP_REASON,
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_IMPORT_TYPE,
  CARBON_EMISSION_REPORT_MAX_VALUE,
  CARBON_EMISSION_REPORT_RESOURCE_LIMITS,
  CARBON_EMISSION_REPORT_SCOPE_ALIASES,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_SUMMARY_DIMENSION_ALIASES,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
  assertCarbonEmissionReportAllowedFields,
  buildCarbonEmissionReportCodeKey,
  buildCarbonEmissionReportNormalizationKey,
  normalizeCarbonEmissionReportBoundaryType,
  normalizeCarbonEmissionReportDate,
  normalizeCarbonEmissionReportNonNegativeNumber,
  normalizeCarbonEmissionReportPositiveNumber,
  normalizeCarbonEmissionReportScope,
  normalizeCarbonEmissionReportSummaryDimension,
  normalizeCarbonEmissionReportText
};
