const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  GENERATION_DATA_SOURCES,
  GENERATION_RECORD_EXPORT_FIELDS,
  GENERATION_RECORD_IMPORT_ALIASES,
  GENERATION_RECORD_IMPORT_CONFIRM_TEXT,
  GENERATION_RECORD_IMPORT_HEADERS,
  GENERATION_RECORD_IMPORT_TEMPLATE_ID,
  GENERATION_RECORD_IMPORT_STATUSES,
  MAX_GENERATION_RECORD_EXPORT_ROWS,
  PHOTOVOLTAIC_ENERGY_TYPE_CODE,
  buildGenerationMeta,
  buildGenerationRecordImportPreviewFromRows,
  executeGenerationRecordImport,
  getGenerationImportExportContract
} = require('../services/generationService');
const {
  getTemplateCsv,
  getTemplateDefinition,
  getTemplateXlsx,
  listTemplates
} = require('../services/templateService');
const { getApiContract, getGenerationContract } = require('../services/contractService');

const expectedImportHeaders = ['用能单元编码', '用能单元名称', '月份', '发电量 kWh', '自发自用 kWh', '上网电量 kWh', '数据来源', '备注'];
const expectedExportHeaders = ['用能单元编码', '用能单元名称', '用能单元路径', '月份', '能源类型编码', '能源类型', '发电量 kWh', '自发自用 kWh', '上网电量 kWh', '自用率', '上网率', '数据来源', '状态', '备注', '创建时间', '更新时间'];
const forbiddenExportHeaders = ['外购电抵扣', '外购电抵扣 kWh', '碳排放', '碳排', '单位产品能耗'];

assert.strictEqual(GENERATION_RECORD_IMPORT_TEMPLATE_ID, 'generation-records');
assert.deepStrictEqual(GENERATION_RECORD_IMPORT_HEADERS, expectedImportHeaders);
assert.deepStrictEqual(GENERATION_RECORD_EXPORT_FIELDS.map((field) => field.header), expectedExportHeaders);
forbiddenExportHeaders.forEach((header) => {
  assert(!GENERATION_RECORD_EXPORT_FIELDS.some((field) => field.header.includes(header)), `发电导出字段不得包含 ${header}。`);
});
assert.strictEqual(GENERATION_RECORD_IMPORT_CONFIRM_TEXT, '确认导入发电自用记录');
assert.deepStrictEqual(GENERATION_RECORD_IMPORT_STATUSES, ['wouldImport', 'skipped', 'blocked']);
assert(GENERATION_DATA_SOURCES.includes('upload'), '发电导入数据来源应支持 upload。');
assert.strictEqual(PHOTOVOLTAIC_ENERGY_TYPE_CODE, 'photovoltaic');
assert.strictEqual(MAX_GENERATION_RECORD_EXPORT_ROWS, 5000);

assert(GENERATION_RECORD_IMPORT_ALIASES.organizationUnitCode.includes('用能单元编码'));
assert(GENERATION_RECORD_IMPORT_ALIASES.organizationUnitName.includes('用能单元名称'));
assert(GENERATION_RECORD_IMPORT_ALIASES.normalizedMonth.includes('月份'));
assert(GENERATION_RECORD_IMPORT_ALIASES.generationValueKwh.includes('发电量 kWh'));
assert(GENERATION_RECORD_IMPORT_ALIASES.selfUseValueKwh.includes('自发自用 kWh'));
assert(GENERATION_RECORD_IMPORT_ALIASES.gridExportValueKwh.includes('上网电量 kWh'));

const template = getTemplateDefinition('generation-records');
assert(template, '应提供 generation-records 发电自用记录导入模板。');
assert.strictEqual(template.type, 'generation-records');
assert.strictEqual(template.name, '发电自用记录导入模板');
assert.strictEqual(template.route, '/api/templates/generation-records.xlsx');
assert.strictEqual(template.csvRoute, '/api/templates/generation-records.csv');
assert.strictEqual(template.contractRoute, 'POST /api/generation/records/import/preview -> POST /api/generation/records/import/execute');
assert.deepStrictEqual(template.headers, expectedImportHeaders);
assert(template.description.includes('只写发电自用记录'), '模板说明应以中文业务名称明确写入范围。');
assert(template.description.includes('不写能耗记录'), '模板说明应以中文业务名称明确不写能耗记录。');
assert(template.description.includes('碳排放结果'), '模板说明应以中文业务名称明确不写碳排放结果。');
assert(template.description.includes('默认跳过并记录告警'), '模板说明应以中文业务描述明确重复处理方式。');
['generation_records', 'energy_records', 'carbon_emissions', 'skip warning'].forEach((internalTerm) => {
  assert(!template.description.includes(internalTerm), `用户可见模板说明不得暴露内部技术名 ${internalTerm}。`);
});
assert(listTemplates().some((item) => item.type === 'generation-records' && item.headers.join('|') === expectedImportHeaders.join('|')));
assert(getTemplateCsv('generation-records').csv.includes('用能单元编码'), '发电模板应支持 CSV 下载。');
assert(getTemplateCsv('generation-records').csv.startsWith('﻿'), '发电 CSV 模板应带 UTF-8 BOM。');
assert(getTemplateXlsx('generation-records').buffer.length > 0, '发电模板应支持 xlsx 下载。');

const contract = getGenerationImportExportContract();
assert.deepStrictEqual(getGenerationContract(), contract, 'contractService 应复用 generationService 发电契约，避免字段漂移。');
assert(['contract-template-ready', 'preview-ready', 'execute-ready'].includes(contract.status));
assert.strictEqual(contract.table, 'generation_records');
assert.strictEqual(contract.energyType.code, 'photovoltaic');
assert.strictEqual(contract.routes.contract, 'GET /api/generation/contract');
assert.strictEqual(contract.routes.export, 'GET /api/generation/records/export?format=xlsx|csv');
assert.strictEqual(contract.routes.importPreview, 'POST /api/generation/records/import/preview');
assert.strictEqual(contract.routes.importExecute, 'POST /api/generation/records/import/execute');
assert.deepStrictEqual(contract.template.headers, expectedImportHeaders);
const organizationUnitCodeField = contract.importFields.find((field) => field.key === 'organizationUnitCode');
const organizationUnitNameField = contract.importFields.find((field) => field.key === 'organizationUnitName');
assert.strictEqual(organizationUnitCodeField.required, true, '发电导入契约应用能单元编码必填。');
assert(organizationUnitCodeField.match.includes('按编码精确匹配 active 用能单元'), '发电导入契约应以编码匹配为准。');
assert.strictEqual(organizationUnitNameField.required, false, '用能单元名称不得替代编码作为必填匹配字段。');
assert(organizationUnitNameField.match.includes('仅用于辅助校验'), '用能单元名称仅可作为辅助校验/展示。');
assert(contract.importValidation.requiredFields.includes('用能单元编码'), '发电导入校验应要求用能单元编码必填。');
assert.deepStrictEqual(contract.export.fields.map((field) => field.header), expectedExportHeaders);
assert.strictEqual(contract.export.readOnly, true);
assert.strictEqual(contract.export.maxRows, MAX_GENERATION_RECORD_EXPORT_ROWS);
assert.strictEqual(contract.preview.dryRun, true);
assert.strictEqual(contract.preview.previewOnly, true);
assert.strictEqual(contract.preview.writesGenerationRecords, false);
assert.strictEqual(contract.preview.persistsImportBatch, true);
assert(contract.preview.responseShape.summary.includes('wouldImport'));
assert(contract.preview.responseShape.summary.includes('skipped'));
assert(contract.preview.responseShape.summary.includes('blocked'));
assert(contract.preview.responseShape.candidateRows.includes('candidateRowId'));
assert(contract.preview.responseShape.candidateRows.includes('generationValueKwh'));
assert(contract.preview.responseShape.previewSignature.includes('candidateRows/candidateRowIds'));
assert(contract.preview.responseShape.previewSignature.includes('summary/items 仅用于展示'));
assert(contract.preview.responseShape.previewAudit.includes('summary/items 的只读审计快照'));
assert(contract.preview.responseShape.previewAudit.includes('不作为候选写入授权'));
assert(contract.preview.responseShape.signaturePayload.includes('candidateRowIds'));
assert(contract.preview.responseShape.signaturePayload.includes('candidateRows'));
assert(!contract.preview.responseShape.signaturePayload.includes('summary'), 'previewSignature 载荷不得依赖 summary。');
assert(!contract.preview.responseShape.signaturePayload.includes('items'), 'previewSignature 载荷不得依赖 items。');
assert.strictEqual(typeof buildGenerationRecordImportPreviewFromRows, 'function', '发电服务应导出 preview 纯逻辑函数供后端和测试复用。');
assert.strictEqual(typeof executeGenerationRecordImport, 'function', '发电服务应导出受控 execute 服务函数。');
assert.deepStrictEqual(contract.execute.requiredFields, ['confirmText', 'previewSignature', 'expectedWouldImport', 'candidateRowIds', 'candidateRows', 'requireBackup', 'acknowledgeSkippedRisks']);
assert.deepStrictEqual(contract.execute.optionalAuditFields, ['previewAudit', 'previewAuditDigest']);
assert.strictEqual(contract.execute.confirmText, GENERATION_RECORD_IMPORT_CONFIRM_TEXT);
assert(contract.execute.candidateRows.includes('summary/items 仅用于展示'), 'execute 契约应说明 summary/items 不作为签名载荷。');
assert(contract.execute.previewAudit.includes('skipped/blocked 风险'), 'execute 契约应说明可保留原始 preview 风险审计。');
assert.strictEqual(contract.execute.requireBackup, true);
assert.strictEqual(contract.execute.acknowledgeSkippedRisks, true);
assert.strictEqual(contract.execute.targetTable, 'generation_records');
assert.strictEqual(contract.execute.defaultDuplicateStrategy, 'skip');
assert.deepStrictEqual(contract.execute.allowedDuplicateStrategies, ['skip']);
assert(contract.execute.rejectedDuplicateStrategies.includes('overwrite'));
assert.strictEqual(contract.boundaries.writesEnergyRecords, false);
assert.strictEqual(contract.boundaries.writesCarbonEmissions, false);
assert.strictEqual(contract.boundaries.affectsProductionIntensity, false);
assert.strictEqual(contract.boundaries.realtimeCollectionIncluded, false);
assert(contract.boundaries.purchasedElectricityReference.includes('只读汇总'));
assert(contract.boundaries.purchasedElectricityReference.includes('不包含外购电抵扣'));
assert(!JSON.stringify(contract).includes('外购电抵扣 kWh'), '契约不得提供外购电抵扣写入字段。');
assert.deepStrictEqual(contract.errorDetailShape, ['rowNumber', 'fieldName', 'rawValue', 'code', 'message', 'severity']);

const meta = buildGenerationMeta();
assert.strictEqual(meta.importExportIncluded, true, '发电导入导出已完成后，常规发电 meta 应标记已包含导入导出。');
assert.strictEqual(meta.importExportStatus, 'ready');
assert.deepStrictEqual(meta.importExportCapabilities, {
  contract: true,
  templateDownload: true,
  exportCurrentFilters: true,
  importPreview: true,
  importExecute: true,
  frontendPanel: true,
  persistsImportBatch: true
});
assert.strictEqual(meta.writesEnergyRecords, false);
assert.strictEqual(meta.writesCarbonEmissions, false);
assert.strictEqual(meta.affectsProductionIntensity, false);

const apiContract = getApiContract();
assert(apiContract.routes.generation.includes('/api/generation/contract'));
assert(apiContract.routes.generation.includes('preview 预演不写库'));
assert(apiContract.routes.generation.includes('只写 generation_records'));

const generationRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'generation.js'), 'utf8');
assert(generationRouteSource.includes("router.get('/contract'"), '发电路由应提供 /api/generation/contract。');
assert(generationRouteSource.includes("router.get('/records/export'"), '发电路由应提供 /api/generation/records/export 当前筛选导出接口。');
assert(generationRouteSource.includes("X-Export-Row-Count"), '发电导出路由应返回 X-Export-Row-Count 行数响应头。');
assert(generationRouteSource.includes("Content-Disposition"), '发电导出路由应返回 Content-Disposition 下载响应头。');
assert(generationRouteSource.includes("router.post('/records/import/preview', authenticate, requirePermission('ledger:generation:preview'), requireWritable('generation:records-import-preview')"), '发电路由应在上传文件落盘前对 preview 执行维护态写保护。');
assert(generationRouteSource.includes('createGenerationRecordImportPreviewFromUpload'), '发电 preview 路由应调用上传解析预演服务。');
assert(!generationRouteSource.includes('.then((preview) => {\n        cleanupUploadedImportFile(req.file);'), '发电 preview 成功后应保留本次上传文件供审计批次追溯，不再立即清理原文件。');
assert(generationRouteSource.includes('cleanupUploadedImportFile(req.file);\n        next(error);'), '发电 preview 解析失败后仍应清理本次临时上传文件。');
assert(generationRouteSource.includes("router.post('/records/import/execute', authenticate, requirePermission('ledger:generation:execute'), requireWritable('generation:records-import-execute')"), '发电路由应提供 /api/generation/records/import/execute 并挂维护态写保护。');
assert(generationRouteSource.includes('executeGenerationRecordImport'), '发电 execute 路由应调用受控导入服务。');

console.log('generation import/export contract tests passed');
