'use strict';

const assert = require('assert');
const XLSX = require('xlsx');
const {
  ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
  ENERGY_FLOW_WORKBOOK_ENUMS,
  ENERGY_FLOW_WORKBOOK_HEADERS,
  ENERGY_FLOW_WORKBOOK_IMPORT_TYPE,
  ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS,
  ENERGY_FLOW_WORKBOOK_SHEETS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION,
  buildEnergyFlowWorkbookExamples,
  normalizeWorkbookCode,
  normalizeWorkbookKey,
  normalizeWorkbookNumber,
  normalizeWorkbookVersion,
  normalizeWorkbookWallClockRange,
  projectEnergyFlowWorkbookPublicDto
} = require('../services/energyFlowWorkbookContracts');
const { parseEnergyFlowWorkbookXlsx } = require('../services/energyFlowWorkbookImportService');
const { getTemplateXlsx, listTemplates } = require('../services/templateService');

/** 构造严格六表工作簿，用于验证空事实表和表头边界。 */
function buildWorkbook(rowsByKey = {}) {
  const workbook = XLSX.utils.book_new();
  ENERGY_FLOW_WORKBOOK_SHEETS.forEach((sheet) => {
    const rows = rowsByKey[sheet.key] || [];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([sheet.headers, ...rows]),
      sheet.name
    );
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** 断言解析失败使用稳定错误码。 */
function assertWorkbookError(action, expectedCode, expectedStatus = null) {
  assert.throws(action, (error) => (
    (error?.code === expectedCode || error?.details?.code === expectedCode)
      && (expectedStatus === null || error.statusCode === expectedStatus)
  ));
}

// 固定身份、权限入口、确认文本和六表顺序必须不可漂移。
assert.strictEqual(ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE, 'energy-flow-workbook');
assert.strictEqual(ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION, '1.0');
assert.strictEqual(ENERGY_FLOW_WORKBOOK_IMPORT_TYPE, 'energy_flow_workbook');
assert.strictEqual(ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT, '确认导入完整能流工作簿');
assert.deepStrictEqual(ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.name), [
  '模型', '设备资产与节点', '有向边', '期间流量', '余热事实', '损耗证据'
]);
assert.deepStrictEqual(ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.headers), [
  ENERGY_FLOW_WORKBOOK_HEADERS.模型,
  ENERGY_FLOW_WORKBOOK_HEADERS.设备资产与节点,
  ENERGY_FLOW_WORKBOOK_HEADERS.有向边,
  ENERGY_FLOW_WORKBOOK_HEADERS.期间流量,
  ENERGY_FLOW_WORKBOOK_HEADERS.余热事实,
  ENERGY_FLOW_WORKBOOK_HEADERS.损耗证据
]);
ENERGY_FLOW_WORKBOOK_SHEETS.forEach((sheet) => {
  assert.strictEqual(new Set(sheet.headers).size, sheet.headers.length, `${sheet.name} 表头必须唯一。`);
});
assert.strictEqual(ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxUploadBytes, 10 * 1024 * 1024);
assert.deepStrictEqual(ENERGY_FLOW_WORKBOOK_ENUMS.recordRoles, ['edge_flow', 'storage_change']);

// 规范编码保留 ASCII 显示值，比较键执行 NFKC 和稳定大写。
const issues = [];
assert.deepStrictEqual(normalizeWorkbookCode(issues, 2, '编码', '  FLOW-01  '), {
  value: 'FLOW-01',
  key: 'FLOW-01'
});
assert.strictEqual(normalizeWorkbookKey('  ｆｌｏｗ-０１  '), 'FLOW-01');
assert.strictEqual(normalizeWorkbookVersion([], 2, 'v1'), 'v1');
assert.strictEqual(normalizeWorkbookNumber([], 2, '数值', 1.25, { maxDecimals: 2 }), 1.25);

// 完整能流来源墙钟兼容新旧输入，归一化后继续保存内部分钟合同并按显式 IANA 时区转换 UTC。
const visibleWallClockIssues = [];
assert.deepStrictEqual(normalizeWorkbookWallClockRange(
  visibleWallClockIssues,
  2,
  '2026-07-01 09:05:00',
  '2026-07-01 10:35:00',
  'Asia/Shanghai',
  '期间时间'
), {
  startWallClock: '2026-07-01T09:05',
  endWallClock: '2026-07-01T10:35',
  sourceTimezone: 'Asia/Shanghai',
  startUtc: '2026-07-01T01:05:00Z',
  endUtc: '2026-07-01T02:35:00Z'
});
assert.deepStrictEqual(visibleWallClockIssues, []);
const historicalWallClockIssues = [];
assert.deepStrictEqual(normalizeWorkbookWallClockRange(
  historicalWallClockIssues,
  2,
  '2026-07-01T09:05',
  '2026-07-01T10:35',
  'Asia/Shanghai',
  '期间时间'
), {
  startWallClock: '2026-07-01T09:05',
  endWallClock: '2026-07-01T10:35',
  sourceTimezone: 'Asia/Shanghai',
  startUtc: '2026-07-01T01:05:00Z',
  endUtc: '2026-07-01T02:35:00Z'
});
assert.deepStrictEqual(historicalWallClockIssues, []);
const nonZeroSecondIssues = [];
const nonZeroSecondRange = normalizeWorkbookWallClockRange(
  nonZeroSecondIssues,
  3,
  '2026-07-01 09:05:01',
  '2026-07-01 10:35:00',
  'Asia/Shanghai',
  '期间时间'
);
assert.strictEqual(nonZeroSecondRange.startUtc, null);
assert.strictEqual(nonZeroSecondRange.endUtc, null);
assert.deepStrictEqual(nonZeroSecondIssues.map((issue) => issue.code), [
  'ENERGY_FLOW_WORKBOOK_WALL_CLOCK_SECOND_MUST_BE_ZERO'
]);

// 中央固定模板只能下载 XLSX，并且真实 SheetJS 回读仍为六表合同。
const templateMetadata = listTemplates().find((template) => template.type === ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE);
assert(templateMetadata);
assert.strictEqual(templateMetadata.templateVersion, ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION);
assert.strictEqual(templateMetadata.requiredPermission, 'energy:flows:import:preview');
assert.deepStrictEqual(templateMetadata.sheetNames, ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.name));
assert.strictEqual(templateMetadata.csvRoute, null);
const template = getTemplateXlsx(ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE);
assert(template && Buffer.isBuffer(template.buffer));
const templateWorkbook = XLSX.read(template.buffer, { type: 'buffer' });
assert.deepStrictEqual(templateWorkbook.SheetNames, ENERGY_FLOW_WORKBOOK_SHEETS.map((sheet) => sheet.name));
const parsedTemplate = parseEnergyFlowWorkbookXlsx(template.buffer, template.fileName);
assert.deepStrictEqual(Object.fromEntries(Object.entries(parsedTemplate).map(([key, rows]) => [key, rows.length])), {
  models: 1,
  assetsNodes: 3,
  edges: 1,
  records: 2,
  wasteHeat: 1,
  lossEvidence: 2
});
assert.deepStrictEqual(buildEnergyFlowWorkbookExamples().模型[0].slice(0, 2), [
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION
]);

// 余热事实和损耗证据可以是零数据行，但六张表及精确表头仍必须存在。
const emptyFactWorkbook = buildWorkbook({
  models: [['energy-flow-workbook', '1.0', 'MODEL-EMPTY', '空事实模型', '测试来源', '', 'v1', '2026-01-01T00:00', '2027-01-01T00:00', 'Asia/Shanghai', 'workbook_facts', 'workbook_facts_only', 'active']],
  assetsNodes: [['asset', 'MODEL-EMPTY', 'ASSET-01', '设备', 'production_device', '', '', '', '', '', '', '', '', 'active']],
  edges: [['MODEL-EMPTY', 'PATH-01', '路径', 1, 'EDGE-01', 'NODE-01', 'NODE-02', 'electricity', 'kWh', 'workbook_fact', 'edge:01', 'active']],
  records: [['REC-01', 'MODEL-EMPTY', 'edge_flow', 'EDGE-01', '', 'PATH-01', '', 'waste_heat', '2026-07-01T00:00', '2026-07-01T01:00', 'Asia/Shanghai', 'electricity', 1, 'kWh', 'record:01']],
  wasteHeat: [],
  lossEvidence: []
});
const emptyFactParsed = parseEnergyFlowWorkbookXlsx(emptyFactWorkbook, 'empty-facts.xlsx');
assert.strictEqual(emptyFactParsed.wasteHeat.length, 0);
assert.strictEqual(emptyFactParsed.lossEvidence.length, 0);

// 文件名、伪装文件、增列和表头重排均在 SheetJS 业务解析前稳定拒绝。
assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(template.buffer, 'template.csv'), 'ENERGY_FLOW_WORKBOOK_XLSX_REQUIRED');
assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(Buffer.from('not-a-zip'), 'fake.xlsx'), 'ENERGY_FLOW_WORKBOOK_ZIP_DIRECTORY_INVALID');
const extraColumnWorkbook = buildWorkbook();
const extraColumnSheet = XLSX.read(extraColumnWorkbook, { type: 'buffer' });
extraColumnSheet.Sheets['模型']['N1'] = { t: 's', v: '额外列' };
extraColumnSheet.Sheets['模型']['!ref'] = 'A1:N1';
const extraColumnBuffer = XLSX.write(extraColumnSheet, { type: 'buffer', bookType: 'xlsx' });
assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(extraColumnBuffer, 'extra-column.xlsx'), 'ENERGY_FLOW_WORKBOOK_COLUMN_COUNT_INVALID');
const reorderedWorkbook = buildWorkbook();
const reorderedSheet = XLSX.read(reorderedWorkbook, { type: 'buffer' });
reorderedSheet.Sheets['模型']['A1'].v = ENERGY_FLOW_WORKBOOK_HEADERS.模型[1];
reorderedSheet.Sheets['模型']['B1'].v = ENERGY_FLOW_WORKBOOK_HEADERS.模型[0];
assertWorkbookError(() => parseEnergyFlowWorkbookXlsx(
  XLSX.write(reorderedSheet, { type: 'buffer', bookType: 'xlsx' }),
  'reordered.xlsx'
), 'ENERGY_FLOW_WORKBOOK_HEADERS_MISMATCH');

// 公共 DTO 必须递归阻断候选、安全链、来源追溯和服务端文件信息，同时保留安全摘要。
const cyclic = {};
cyclic.self = cyclic;
const publicDto = projectEnergyFlowWorkbookPublicDto({
  batchId: 7,
  summary: { totalRows: 10, wouldImport: 1 },
  issues: [{ rowNumber: 2, fieldName: '模型编码', code: 'TEST' }],
  auditBatch: {
    id: 7,
    status: 'completed',
    fileSha256: 'sha256-secret',
    previewSignature: 'signature-secret',
    previewAuditDigest: 'digest-secret'
  },
  workbook: { candidateRowId: 'workbook:secret', model: { sourceRowNumber: 2 } },
  candidateRowId: 'top-level-candidate-secret',
  nested: {
    workbook: { candidateRows: [{ candidateRowId: 'nested-secret' }] },
    candidateRows: [{ sourceBatchId: 7, sourceRowNumber: 2 }],
    securityChain: { witness: 'witness-secret' },
    signaturePayload: { hmac: 'hmac-secret' },
    installationHmacSecret: 'installation-hmac-secret',
    internalAudit: { operationAudit: 'operation-audit-secret' },
    importExecuteAudit: { executeResult: 'execute-result-secret' },
    storedFilename: 'server-file.xlsx',
    filePath: 'C:/server/uploads/server-file.xlsx',
    sourceBatchId: 7,
    sourceRowNumber: 2
  },
  cycle: cyclic
});
const publicDtoText = JSON.stringify(publicDto);
assert.strictEqual(publicDto.batchId, 7);
assert.deepStrictEqual(publicDto.summary, { totalRows: 10, wouldImport: 1 });
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicDto, 'workbook'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicDto.nested, 'workbook'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicDto.nested, 'candidateRows'), false);
assert.strictEqual(publicDto.auditBatch.fileSha256, undefined);
assert.strictEqual(publicDto.auditBatch.previewSignature, undefined);
assert.strictEqual(publicDto.cycle.self, null);
['candidateRowId', 'top-level-candidate-secret', 'nested-secret', 'sha256-secret', 'signature-secret', 'digest-secret',
  'witness-secret', 'hmac-secret', 'installation-hmac-secret', 'operation-audit-secret', 'execute-result-secret',
  'server-file.xlsx', 'server/uploads'].forEach((secret) => {
  assert(!publicDtoText.includes(secret), `公共 DTO 不得泄漏 ${secret}。`);
});

console.log('energyFlowWorkbookContracts tests passed');
