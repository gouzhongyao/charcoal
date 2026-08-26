'use strict';

const assert = require('assert');
const XLSX = require('xlsx');
const {
  CARBON_EMISSION_REPORT_IMPORT_BACKUP_REASON,
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_IMPORT_TYPE,
  CARBON_EMISSION_REPORT_RESOURCE_LIMITS,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
  assertCarbonEmissionReportAllowedFields,
  buildCarbonEmissionReportCodeKey,
  normalizeCarbonEmissionReportBoundaryType,
  normalizeCarbonEmissionReportDate,
  normalizeCarbonEmissionReportNonNegativeNumber,
  normalizeCarbonEmissionReportPositiveNumber,
  normalizeCarbonEmissionReportScope,
  normalizeCarbonEmissionReportSummaryDimension
} = require('../services/carbonEmissionReportContracts');
const { getTemplateCsv, getTemplateXlsx, listTemplates } = require('../services/templateService');
const { parseCarbonEmissionReportWorkbook } = require('../services/carbonEmissionReportImportService');
const { normalizeCarbonEmissionReportPagination } = require('../services/carbonEmissionReportService');

assert.strictEqual(CARBON_EMISSION_REPORT_TEMPLATE_TYPE, 'carbon-emission-report');
assert.strictEqual(CARBON_EMISSION_REPORT_TEMPLATE_VERSION, '1.0');
assert.strictEqual(CARBON_EMISSION_REPORT_IMPORT_TYPE, 'carbon_emission_report');
assert.strictEqual(CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT, '确认导入碳排放报告');
assert.strictEqual(CARBON_EMISSION_REPORT_IMPORT_BACKUP_REASON, 'carbon-emission-report-import');
assert.deepStrictEqual(CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name), [
  '报告信息', '组织与核算边界', '报告项目', '汇总', '证据说明'
]);
assert.deepStrictEqual(CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.headers), [
  ['报告编码', '报告名称', '报告组织', '报告开始日期', '报告结束日期', '模板标识', '模板版本', '备注'],
  ['边界类型', '边界名称', '边界说明'],
  ['项目编码', '排放范围', '类别', '排放源或能源类型', '活动量', '活动量单位', '排放因子', '因子单位', '排放量', 'CO2e单位', '证据编号', '备注'],
  ['汇总编码', '汇总维度', '汇总值', '排放量', 'CO2e单位', '备注'],
  ['证据编号', '证据名称', '证据类型', '证据说明', '备注']
]);
assert.deepStrictEqual(CARBON_EMISSION_REPORT_SHEETS.map((sheet) => [sheet.minDataRows, sheet.maxDataRows]), [
  [1, 1], [2, 2], [1, 5000], [1, 5000], [1, 5000]
]);
assert(CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxZipEntries >= 256);
assert(CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes >= 64 * 1024 * 1024);
assert(CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes >= 128 * 1024 * 1024);

assert.strictEqual(buildCarbonEmissionReportCodeKey('  ｃｅｒ-００１  '), 'CER-001');
assert.strictEqual(normalizeCarbonEmissionReportScope('范围一'), 'scope_1');
assert.strictEqual(normalizeCarbonEmissionReportScope('scope 2'), 'scope_2');
assert.strictEqual(normalizeCarbonEmissionReportScope('范围四'), null);
assert.strictEqual(normalizeCarbonEmissionReportBoundaryType('组织边界'), 'organization');
assert.strictEqual(normalizeCarbonEmissionReportBoundaryType('核算边界'), 'accounting');
assert.strictEqual(normalizeCarbonEmissionReportSummaryDimension('总计'), 'total');
assert.strictEqual(normalizeCarbonEmissionReportSummaryDimension('排放范围'), 'scope');
assert.strictEqual(normalizeCarbonEmissionReportSummaryDimension('类别'), 'category');
assert.strictEqual(normalizeCarbonEmissionReportDate('2026-02-28'), '2026-02-28');
assert.strictEqual(normalizeCarbonEmissionReportDate('2026-02-29'), null);
assert.strictEqual(normalizeCarbonEmissionReportNonNegativeNumber('0'), 0);
assert.strictEqual(normalizeCarbonEmissionReportPositiveNumber('0'), null);
assert.strictEqual(normalizeCarbonEmissionReportPositiveNumber('0.1'), 0.1);
assert.strictEqual(normalizeCarbonEmissionReportNonNegativeNumber('Infinity'), null);
assert.deepStrictEqual(normalizeCarbonEmissionReportPagination({ page: Number.MAX_SAFE_INTEGER, pageSize: 1 }), {
  page: Number.MAX_SAFE_INTEGER,
  pageSize: 1,
  offset: Number.MAX_SAFE_INTEGER - 1
});
assert.throws(
  () => normalizeCarbonEmissionReportPagination({ page: Number.MAX_SAFE_INTEGER, pageSize: 2 }),
  (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_PAGE_OFFSET_INVALID'
);

// 发布合同中的全部工作表名称必须可由标准 SheetJS 写入，不依赖 OOXML 后处理。
const legalNameProbeWorkbook = XLSX.utils.book_new();
CARBON_EMISSION_REPORT_SHEETS.forEach((sheet) => {
  XLSX.utils.book_append_sheet(legalNameProbeWorkbook, XLSX.utils.aoa_to_sheet([sheet.headers]), sheet.name);
});
const legalNameProbeBuffer = XLSX.write(legalNameProbeWorkbook, { type: 'buffer', bookType: 'xlsx' });
assert.deepStrictEqual(XLSX.read(legalNameProbeBuffer, { type: 'buffer' }).SheetNames,
  CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));

assert.doesNotThrow(() => assertCarbonEmissionReportAllowedFields(
  { batchId: 1, confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT },
  new Set(['batchId', 'confirmText']),
  'import-execute'
));
assert.throws(
  () => assertCarbonEmissionReportAllowedFields(
    { batchId: 1, previewSignature: 'client-controlled' },
    new Set(['batchId']),
    'import-execute'
  ),
  (error) => error?.details?.code === 'CARBON_EMISSION_REPORT_UNKNOWN_FIELDS_REJECTED'
);

const templateMetadata = listTemplates().find((template) => template.type === CARBON_EMISSION_REPORT_TEMPLATE_TYPE);
assert(templateMetadata);
assert.deepStrictEqual(templateMetadata.sheetNames, CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));
assert.strictEqual(templateMetadata.csvRoute, null);
assert.throws(
  () => getTemplateCsv(CARBON_EMISSION_REPORT_TEMPLATE_TYPE),
  (error) => error?.code === 'TEMPLATE_FORMAT_UNSUPPORTED' && error.statusCode === 400
);
const template = getTemplateXlsx(CARBON_EMISSION_REPORT_TEMPLATE_TYPE);
assert(template);
assert(template.buffer.length <= CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxUploadBytes);
const workbook = XLSX.read(template.buffer, { type: 'buffer' });
assert.deepStrictEqual(workbook.SheetNames, CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));
const parsed = parseCarbonEmissionReportWorkbook(template.buffer, template.fileName);
assert.deepStrictEqual(Object.fromEntries(Object.entries(parsed).map(([key, rows]) => [key, rows.length])), {
  report: 1,
  boundaries: 2,
  items: 2,
  summaries: 3,
  evidence: 2
});

console.log('carbonEmissionReportContracts tests passed');
