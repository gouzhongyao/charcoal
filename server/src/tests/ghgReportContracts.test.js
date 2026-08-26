'use strict';

const assert = require('assert');
const XLSX = require('xlsx');
const {
  GHG_REPORT_IMPORT_BACKUP_REASON,
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_IMPORT_TYPE,
  GHG_REPORT_RESOURCE_LIMITS,
  GHG_REPORT_SHEETS,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION,
  assertGhgReportAllowedFields,
  buildGhgReportCodeKey,
  normalizeGhgReportDate,
  normalizeGhgReportNonNegativeNumber,
  normalizeGhgReportPositiveNumber,
  normalizeGhgReportRecordType,
  normalizeGhgReportScope,
  normalizeGhgReportSignedNumber,
  normalizeGhgReportSummaryDimension
} = require('../services/ghgReportContracts');
const { parseGhgReportWorkbook } = require('../services/ghgReportImportService');
const { normalizeGhgReportPagination } = require('../services/ghgReportService');
const { getTemplateCsv, getTemplateXlsx, listTemplates } = require('../services/templateService');

// 固定身份、工作表和精确表头是 N7 与 N6 隔离的首要合同。
assert.strictEqual(GHG_REPORT_TEMPLATE_TYPE, 'ghg-report');
assert.strictEqual(GHG_REPORT_TEMPLATE_VERSION, '1.0');
assert.strictEqual(GHG_REPORT_IMPORT_TYPE, 'ghg_report');
assert.strictEqual(GHG_REPORT_IMPORT_CONFIRM_TEXT, '确认导入温室气体报告');
assert.strictEqual(GHG_REPORT_IMPORT_BACKUP_REASON, 'ghg-report-import');
assert.deepStrictEqual(GHG_REPORT_SHEETS.map((sheet) => sheet.name), [
  '报告信息', '组织边界', '运行边界', '报告项目', '汇总', '证据说明'
]);
assert.deepStrictEqual(GHG_REPORT_SHEETS.map((sheet) => sheet.headers), [
  ['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注'],
  ['边界编码', '组织单元', '纳入方式', '边界说明'],
  ['排放范围', '类别', '边界说明'],
  ['项目编码', '记录类型', '排放范围', '类别', '温室气体种类', '排放源或汇', '活动数据', '活动数据单位', '排放量或清除量', 'GWP', 'CO2e', 'CO2e单位', '核算方法', '证据编号', '备注'],
  ['汇总编码', '汇总维度', '汇总值', '排放CO2e', '清除CO2e', '净CO2e', 'CO2e单位', '备注'],
  ['证据编号', '证据名称', '证据类型', '证据说明', '备注']
]);
assert.deepStrictEqual(GHG_REPORT_SHEETS.map((sheet) => [sheet.minDataRows, sheet.maxDataRows]), [
  [1, 1], [1, 5000], [1, 5000], [1, 5000], [1, 5000], [1, 5000]
]);
assert(GHG_REPORT_RESOURCE_LIMITS.maxZipEntries >= 256);
assert(GHG_REPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes >= 64 * 1024 * 1024);
assert(GHG_REPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes >= 128 * 1024 * 1024);
assert.strictEqual(GHG_REPORT_RESOURCE_LIMITS.maxUploadBytes, 10 * 1024 * 1024);

// 枚举、日期、数值和规范键必须保持冻结语义。
assert.strictEqual(buildGhgReportCodeKey('  ｇｈｇ-００１  '), 'GHG-001');
assert.strictEqual(normalizeGhgReportScope('范围一'), 'scope_1');
assert.strictEqual(normalizeGhgReportScope('scope 3'), 'scope_3');
assert.strictEqual(normalizeGhgReportScope('范围四'), null);
assert.strictEqual(normalizeGhgReportRecordType('排放'), 'emission');
assert.strictEqual(normalizeGhgReportRecordType('removal'), 'removal');
assert.strictEqual(normalizeGhgReportRecordType('负排放'), null);
assert.strictEqual(normalizeGhgReportSummaryDimension('温室气体'), 'gas');
assert.strictEqual(normalizeGhgReportSummaryDimension('记录类型'), 'record_type');
assert.strictEqual(normalizeGhgReportDate('2028-02-29'), '2028-02-29');
assert.strictEqual(normalizeGhgReportDate('2026-02-29'), null);
assert.strictEqual(normalizeGhgReportNonNegativeNumber(0), 0);
assert.strictEqual(normalizeGhgReportPositiveNumber(0), null);
assert.strictEqual(normalizeGhgReportPositiveNumber(0.125), 0.125);
assert.strictEqual(normalizeGhgReportSignedNumber(-0.5), -0.5);
assert.strictEqual(normalizeGhgReportSignedNumber(Infinity), null);
assert.deepStrictEqual(normalizeGhgReportPagination({ page: Number.MAX_SAFE_INTEGER, pageSize: 1 }), {
  page: Number.MAX_SAFE_INTEGER,
  pageSize: 1,
  offset: Number.MAX_SAFE_INTEGER - 1
});
assert.throws(
  () => normalizeGhgReportPagination({ page: Number.MAX_SAFE_INTEGER, pageSize: 2 }),
  (error) => error?.details?.code === 'GHG_REPORT_PAGE_OFFSET_INVALID'
);

// 六个工作表名称必须由标准 SheetJS 直接写入和回读，不允许 OOXML 名称后处理。
const legalNameProbeWorkbook = XLSX.utils.book_new();
GHG_REPORT_SHEETS.forEach((sheet) => {
  XLSX.utils.book_append_sheet(legalNameProbeWorkbook, XLSX.utils.aoa_to_sheet([sheet.headers]), sheet.name);
});
const legalNameProbeBuffer = XLSX.write(legalNameProbeWorkbook, { type: 'buffer', bookType: 'xlsx' });
assert.deepStrictEqual(
  XLSX.read(legalNameProbeBuffer, { type: 'buffer' }).SheetNames,
  GHG_REPORT_SHEETS.map((sheet) => sheet.name)
);

// execute 请求体必须拒绝客户端提供签名、候选或其他内部见证。
assert.doesNotThrow(() => assertGhgReportAllowedFields(
  { batchId: 1, confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT },
  new Set(['batchId', 'confirmText']),
  'import-execute'
));
assert.throws(
  () => assertGhgReportAllowedFields(
    { batchId: 1, previewSignature: 'client-controlled' },
    new Set(['batchId']),
    'import-execute'
  ),
  (error) => error?.details?.code === 'GHG_REPORT_UNKNOWN_FIELDS_REJECTED'
);

// 中央模板必须只提供 XLSX，且示例可以由 N7 解析器按固定六表合同重读。
const templateMetadata = listTemplates().find((template) => template.type === GHG_REPORT_TEMPLATE_TYPE);
assert(templateMetadata);
assert.deepStrictEqual(templateMetadata.sheetNames, GHG_REPORT_SHEETS.map((sheet) => sheet.name));
assert.strictEqual(templateMetadata.csvRoute, null);
assert.strictEqual(templateMetadata.requiredPermission, 'carbon:ghg-reports:import:preview');
assert.throws(
  () => getTemplateCsv(GHG_REPORT_TEMPLATE_TYPE),
  (error) => error?.code === 'TEMPLATE_FORMAT_UNSUPPORTED' && error.statusCode === 400
);
const template = getTemplateXlsx(GHG_REPORT_TEMPLATE_TYPE);
assert(template);
assert(template.buffer.length <= GHG_REPORT_RESOURCE_LIMITS.maxUploadBytes);
const templateWorkbook = XLSX.read(template.buffer, { type: 'buffer' });
assert.deepStrictEqual(templateWorkbook.SheetNames, GHG_REPORT_SHEETS.map((sheet) => sheet.name));
const parsedTemplate = parseGhgReportWorkbook(template.buffer, template.fileName);
assert.deepStrictEqual(Object.fromEntries(Object.entries(parsedTemplate).map(([key, rows]) => [key, rows.length])), {
  report: 1,
  organizationBoundaries: 1,
  operationalBoundaries: 2,
  items: 2,
  summaries: 3,
  evidence: 2
});
assert.strictEqual(parsedTemplate.items[0].values[6], 12000);
assert.strictEqual(parsedTemplate.items[1].values[8], 0.5);
assert.strictEqual(parsedTemplate.summaries[2].values[5], -0.5);

console.log('ghgReportContracts tests passed');
