'use strict';

const { badRequest } = require('../utils/errors');

// 温室气体报告固定 Excel v1 模板身份和受控导入语义，与 N6 碳排放报告完全独立。
const GHG_REPORT_TEMPLATE_TYPE = 'ghg-report';
const GHG_REPORT_TEMPLATE_VERSION = '1.0';
const GHG_REPORT_IMPORT_TYPE = 'ghg_report';
const GHG_REPORT_IMPORT_CONFIRM_TEXT = '确认导入温室气体报告';
const GHG_REPORT_IMPORT_BACKUP_REASON = 'ghg-report-import';

// 六张可见工作表的名称、顺序和精确中文表头均属于冻结合同。
const GHG_REPORT_SHEETS = Object.freeze([
  Object.freeze({
    key: 'report',
    name: '报告信息',
    headers: Object.freeze(['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注']),
    minDataRows: 1,
    maxDataRows: 1
  }),
  Object.freeze({
    key: 'organizationBoundaries',
    name: '组织边界',
    headers: Object.freeze(['边界编码', '组织单元', '纳入方式', '边界说明']),
    minDataRows: 1,
    maxDataRows: 5000
  }),
  Object.freeze({
    key: 'operationalBoundaries',
    name: '运行边界',
    headers: Object.freeze(['排放范围', '类别', '边界说明']),
    minDataRows: 1,
    maxDataRows: 5000
  }),
  Object.freeze({
    key: 'items',
    name: '报告项目',
    headers: Object.freeze([
      '项目编码', '记录类型', '排放范围', '类别', '温室气体种类', '排放源或汇',
      '活动数据', '活动数据单位', '排放量或清除量', 'GWP', 'CO2e', 'CO2e单位',
      '核算方法', '证据编号', '备注'
    ]),
    minDataRows: 1,
    maxDataRows: 5000
  }),
  Object.freeze({
    key: 'summaries',
    name: '汇总',
    headers: Object.freeze(['汇总编码', '汇总维度', '汇总值', '排放CO2e', '清除CO2e', '净CO2e', 'CO2e单位', '备注']),
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
const GHG_REPORT_RESOURCE_LIMITS = Object.freeze({
  maxWorksheets: GHG_REPORT_SHEETS.length,
  maxZipEntries: 256,
  maxZipEntryUncompressedBytes: 64 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNonEmptyCells: 100000,
  maxWorkbookTextCharacters: 10_000_000,
  maxIssues: 10000,
  maxUploadBytes: 10 * 1024 * 1024
});

// 报告事实字段长度由模板、导入、查询和导出共同遵守。
const GHG_REPORT_FIELD_LIMITS = Object.freeze({
  reportCode: 128,
  reportName: 300,
  reportOrganization: 300,
  note: 2000,
  boundaryCode: 128,
  organizationUnit: 500,
  inclusionMethod: 300,
  boundaryDescription: 4000,
  category: 300,
  itemCode: 128,
  greenhouseGas: 100,
  sourceOrSink: 500,
  activityUnit: 100,
  co2eUnit: 100,
  accountingMethod: 1000,
  evidenceCode: 128,
  summaryCode: 128,
  summaryValue: 300,
  evidenceName: 500,
  evidenceType: 100,
  evidenceDescription: 4000
});

// 导入数值上限防止非有限数和 SQLite REAL 极值进入报告事实。
const GHG_REPORT_MAX_VALUE = 1e15;

// 排放范围允许固定中英文别名，持久化统一为 scope_1/2/3。
const GHG_REPORT_SCOPE_ALIASES = Object.freeze({
  scope_1: 'scope_1', scope1: 'scope_1', 'scope 1': 'scope_1', 范围一: 'scope_1', 范围1: 'scope_1', 直接排放: 'scope_1',
  scope_2: 'scope_2', scope2: 'scope_2', 'scope 2': 'scope_2', 范围二: 'scope_2', 范围2: 'scope_2', 购入能源间接排放: 'scope_2',
  scope_3: 'scope_3', scope3: 'scope_3', 'scope 3': 'scope_3', 范围三: 'scope_3', 范围3: 'scope_3', 其他间接排放: 'scope_3'
});

// 排放与清除显式建模，不通过负排放表达清除。
const GHG_REPORT_RECORD_TYPE_ALIASES = Object.freeze({
  emission: 'emission', 排放: 'emission',
  removal: 'removal', 清除: 'removal'
});

// 汇总维度覆盖总计、范围、类别、温室气体和记录类型。
const GHG_REPORT_SUMMARY_DIMENSION_ALIASES = Object.freeze({
  总计: 'total', total: 'total',
  排放范围: 'scope', 范围: 'scope', scope: 'scope',
  类别: 'category', category: 'category',
  温室气体: 'gas', 温室气体种类: 'gas', gas: 'gas',
  记录类型: 'record_type', record_type: 'record_type', recordtype: 'record_type'
});

/** 将任意显示值规范化为去除首尾空白的文本。 */
function normalizeGhgReportText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 使用 trim、Unicode NFKC 和 locale-independent 大写生成编码规范键。 */
function buildGhgReportCodeKey(value) {
  return normalizeGhgReportText(value).normalize('NFKC').trim().toUpperCase();
}

/** 生成文本匹配规范键，供类别、气体、单位和汇总一致性校验使用。 */
function buildGhgReportNormalizationKey(value) {
  return normalizeGhgReportText(value).normalize('NFKC').trim().toUpperCase();
}

/** 将排放范围别名映射为冻结枚举。 */
function normalizeGhgReportScope(value) {
  const key = normalizeGhgReportText(value).normalize('NFKC').toLowerCase();
  return GHG_REPORT_SCOPE_ALIASES[key] || null;
}

/** 将记录类型映射为 emission 或 removal。 */
function normalizeGhgReportRecordType(value) {
  const key = normalizeGhgReportText(value).normalize('NFKC').toLowerCase();
  return GHG_REPORT_RECORD_TYPE_ALIASES[key] || null;
}

/** 将汇总维度映射为冻结枚举。 */
function normalizeGhgReportSummaryDimension(value) {
  const key = normalizeGhgReportText(value).normalize('NFKC').toLowerCase();
  return GHG_REPORT_SUMMARY_DIMENSION_ALIASES[key] || null;
}

/** 规范化有限、非负且不超过冻结上限的数值。 */
function normalizeGhgReportNonNegativeNumber(value) {
  const text = normalizeGhgReportText(value);
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isFinite(numberValue) && numberValue >= 0 && numberValue <= GHG_REPORT_MAX_VALUE
    ? numberValue
    : null;
}

/** 规范化有限、正数且不超过冻结上限的数值。 */
function normalizeGhgReportPositiveNumber(value) {
  const numberValue = normalizeGhgReportNonNegativeNumber(value);
  return numberValue !== null && numberValue > 0 ? numberValue : null;
}

/** 规范化有限且绝对值不超过冻结上限的净值。 */
function normalizeGhgReportSignedNumber(value) {
  const text = normalizeGhgReportText(value);
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isFinite(numberValue) && Math.abs(numberValue) <= GHG_REPORT_MAX_VALUE
    ? numberValue
    : null;
}

/** 严格校验 YYYY-MM-DD 日历日期，不进行时区推断。 */
function normalizeGhgReportDate(value) {
  const text = normalizeGhgReportText(value);
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
function assertGhgReportAllowedFields(input, allowedFields, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('温室气体报告请求体必须是 JSON 对象。', {
      code: 'GHG_REPORT_PAYLOAD_INVALID', operation
    });
  }
  const unknownFields = Object.keys(input).filter((fieldName) => !allowedFields.has(fieldName));
  if (unknownFields.length > 0) {
    throw badRequest('温室气体报告请求包含不受支持的字段。', {
      code: 'GHG_REPORT_UNKNOWN_FIELDS_REJECTED', operation, unknownFields
    });
  }
}

module.exports = {
  GHG_REPORT_FIELD_LIMITS,
  GHG_REPORT_IMPORT_BACKUP_REASON,
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_IMPORT_TYPE,
  GHG_REPORT_MAX_VALUE,
  GHG_REPORT_RECORD_TYPE_ALIASES,
  GHG_REPORT_RESOURCE_LIMITS,
  GHG_REPORT_SCOPE_ALIASES,
  GHG_REPORT_SHEETS,
  GHG_REPORT_SUMMARY_DIMENSION_ALIASES,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION,
  assertGhgReportAllowedFields,
  buildGhgReportCodeKey,
  buildGhgReportNormalizationKey,
  normalizeGhgReportDate,
  normalizeGhgReportNonNegativeNumber,
  normalizeGhgReportPositiveNumber,
  normalizeGhgReportRecordType,
  normalizeGhgReportScope,
  normalizeGhgReportSignedNumber,
  normalizeGhgReportSummaryDimension,
  normalizeGhgReportText
};
