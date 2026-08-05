const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '../../../client/src/legacy-main.js'), 'utf8');
const generationRouteJs = fs.readFileSync(path.join(__dirname, '../routes/generation.js'), 'utf8');
const generationServiceJs = fs.readFileSync(path.join(__dirname, '../services/generationService.js'), 'utf8');

function assertIncludes(fragment, message) {
  assert(mainJs.includes(fragment), message);
}

function getMainSection(startFragment, endFragment) {
  const start = mainJs.indexOf(startFragment);
  assert(start >= 0, `未找到片段：${startFragment}`);
  const end = mainJs.indexOf(endFragment, start + startFragment.length);
  assert(end > start, `未找到片段结束标记：${endFragment}`);
  return mainJs.slice(start, end);
}

assertIncludes("tab: 'generation'", '基础台账页签应包含发电自用 generation 入口。');
assertIncludes("text: '发电自用'", '页面应展示“发电自用”入口文案。');
assertIncludes("id: 'ledger-generation-form'", '页面应包含发电记录新增/编辑表单。');
assertIncludes("renderFilterRow('ledger-generation'", '页面应包含发电记录筛选表单。');

assertIncludes('/generation/records', '前端应接入 /api/generation/records 列表/新增 API。');
assertIncludes('/generation/statistics/monthly', '前端应接入 /api/generation/statistics/monthly 汇总 API。');
assertIncludes('`/generation/records/${id}`', '前端应接入 /api/generation/records/:id 编辑/作废 API。');
assertIncludes("payload.energyTypeCode = 'photovoltaic'", '发电记录能源类型应固定为 photovoltaic。');

assertIncludes("'generation-records': '发电自用记录导入模板.xlsx'", '前端应登记 generation-records 模板文件名。');
assertIncludes("createTemplateDownloadButton('generation-records', '下载发电记录导入模板（Excel）')", '发电页签应提供 Excel 模板下载入口。');
assertIncludes("action: 'download-template-csv'", '发电页签应提供 CSV 模板下载入口。');
assertIncludes("templateType: 'generation-records'", 'CSV 模板按钮应指向 generation-records 模板。');
assertIncludes("id: 'ledger-generation-import-preview-form'", '页面应包含发电导入 preview 上传表单。');
assertIncludes("/generation/records/import/preview", '前端应调用发电导入 preview API。');
assertIncludes("/generation/records/import/execute", '前端应调用发电导入 execute API。');
assertIncludes("action: 'export-ledger-generation'", '页面应提供发电当前筛选 Excel 导出动作。');
assertIncludes("action: 'export-ledger-generation-csv'", '页面应提供发电当前筛选 CSV 导出动作。');
assertIncludes("/generation/records/export", '前端应调用发电记录导出 API。');
assertIncludes("action: 'execute-generation-record-import'", '页面应提供受控 execute 动作。');
assertIncludes('确认导入发电自用记录', '页面应展示并校验固定确认文本。');
assertIncludes('previewSignature: preview.previewSignature', 'execute 请求应携带 previewSignature。');
assertIncludes('expectedWouldImport: Number(summary.wouldImport || 0)', 'execute 请求应携带 expectedWouldImport。');
assertIncludes('candidateRowIds,', 'execute 请求应携带 candidateRowIds。');
assertIncludes('candidateRows: preview.candidateRows || []', 'execute 请求应携带 candidateRows。');
assertIncludes('previewAudit: preview.previewAudit || { summary: preview.summary || {}, items: preview.items || [] }', 'execute 请求应携带原始 preview audit 审计快照。');
assertIncludes('previewAuditDigest: preview.previewAuditDigest', 'execute 请求应携带 preview audit digest。');
assertIncludes('acknowledgeSkippedRisks: true', 'execute 请求应确认 skipped 风险。');
assertIncludes('requireBackup: true', 'execute 请求应显式要求自动备份。');

assertIncludes('generationRecordImportPreviewLoading', '发电导入应有 preview loading 状态。');
assertIncludes('generationRecordImportExecuteLoading', '发电导入应有 execute loading 状态。');
assertIncludes('generationRecordImportPreviewError', '发电导入应有 preview error 状态。');
assertIncludes('generationRecordImportExecuteResult', '发电导入应有 execute result 状态。');
assertIncludes("'aria-live': 'polite'", '结果区域应使用 aria-live 提示异步结果。');
assertIncludes('renderGenerationRecordImportResultRegion', '发电导入异步反馈应集中由 live region 渲染。');
assertIncludes('renderGenerationRecordImportAudit', '页面应展示发电导入 summary 和行级结果。');
assertIncludes('summary、wouldImport/skipped/blocked、行级错误/警告原因', '页面应说明会展示 summary 和行级错误/警告。');
assertIncludes('renderGenerationImportIssueList', '错误/警告应以文本列表展示，不只依赖颜色。');

const generationImportResultRegionSource = getMainSection('function renderGenerationRecordImportResultRegion', 'function renderGenerationRecordImportPanel');
assert(generationImportResultRegionSource.includes("id: 'ledger-generation-import-result'"), '发电导入结果容器应由 live region helper 生成。');
assert(generationImportResultRegionSource.includes("'aria-live': 'polite'"), '发电导入结果容器本身应带 aria-live=polite。');
assert(generationImportResultRegionSource.includes('content.push(renderLoading'), 'preview/execute loading 应渲染在 live region 内。');
assert(generationImportResultRegionSource.includes('state.generationRecordImportPreviewError'), 'preview error 应渲染在 live region 内。');
assert(generationImportResultRegionSource.includes('state.generationRecordImportExecuteError'), 'execute error 应渲染在 live region 内。');
assert(generationImportResultRegionSource.includes('renderGenerationRecordImportAudit(executeResult)'), 'execute result audit 应渲染在 live region 内。');
assert(generationImportResultRegionSource.includes('renderGenerationRecordImportAudit(preview)'), 'preview audit 应渲染在 live region 内。');
const generationImportAuditSource = getMainSection('function renderGenerationRecordImportAudit', 'function renderGenerationRecordImportResultRegion');
assert(generationImportAuditSource.includes('audit.previewAudit?.items'), 'execute 结果表应能展示保留的原始 preview skipped/blocked 审计行。');
assert(generationImportAuditSource.includes("key: 'organizationUnitCode'"), '发电导入结果表应展示用能单元编码列。');
assert(generationImportAuditSource.includes("key: 'organizationUnitName'"), '发电导入结果表应展示用能单元名称列。');

assertIncludes('外购电参考来自 active energy_records', '页面应说明外购电参考来源。');
assertIncludes('仅供参考，不自动抵扣、不入账', '页面应说明外购电参考仅供参考且不抵扣不入账。');
assertIncludes('导入/导出只维护 generation_records', '页面应说明导入/导出只维护 generation_records。');
assertIncludes('不会自动写入或回填 energy_records', '页面应说明不写 energy_records。');
assertIncludes('不会自动写入 carbon_emissions', '页面应说明不写 carbon_emissions。');
assertIncludes('不影响单位产品能耗统计', '页面应说明不影响单位产品能耗。');
assertIncludes('外购电参考只读，不抵扣不入账', '页面应说明外购电参考只读，不抵扣不入账。');
assertIncludes('不引入实时采集、自动同步或外部网关', '页面应说明不含实时采集/外部网关。');

assert(!mainJs.includes('页面不提供发电导入、导出或模板下载'), '前端不应继续声明页面不提供发电导入/导出。');
assert(!mainJs.includes('当前页面仍不提供导入/导出入口。'), '前端不应继续声明当前页面未接入导入/导出。');
assert(!mainJs.includes('外购电抵扣 kWh'), '前端不得提供外购电抵扣字段。');
assert(!mainJs.includes('碳排写入'), '前端不得出现碳排写入误导文案。');
assertIncludes('safeApi(`/imports/batches${importBatchQuery}`)', '统一数据导入页应按筛选条件读取批次列表。');
assertIncludes('importBatchFilters', '统一批次列表应有前端筛选状态。');
assertIncludes("{ value: 'production_output', label: '月度产量导入' }", '批次类型筛选应支持月度产量导入。');
assertIncludes("{ value: 'generation_record', label: '发电记录导入' }", '批次类型筛选应支持发电记录导入。');
assertIncludes("production_output: '月度产量导入'", '批次类型标签应中文化 production_output。');
assertIncludes("generation_record: '发电记录导入'", '批次类型标签应中文化 generation_record。');
assertIncludes('function isImportAuditBatchType', '前端应集中识别 production/generation 审计批次类型。');
assertIncludes("importType === 'production_output' || importType === 'generation_record'", 'production/generation 审计批次应共用删除禁用判断。');
assertIncludes('月度产量/发电记录审计批次需保留原文件、错误明细和业务记录追溯', '页面应说明 production/generation 批次禁止通用删除的原因。');
assertIncludes("action: 'load-import-batch-detail'", '页面应提供批次详情入口。');
assertIncludes('/imports/batches/${batchId}', '页面应调用批次详情 API。');
assertIncludes('/imports/batches/${batchId}/errors?page=1&pageSize=50', '页面应调用错误明细 API。');
assertIncludes('/imports/batches/${encodeURIComponent(batchId)}/download', '页面应调用原文件下载 API。');
assertIncludes('导入批次原始文件不存在或已被移动。', '原文件缺失时应展示可读提示。');
assertIncludes('页面不会展示服务端本地路径', '原文件下载失败提示不得暴露服务端路径。');
assertIncludes('renderImportAuditBatchLinks', '领域导入结果应渲染持久批次追溯入口。');
assertIncludes('查看批次详情', '领域导入结果应提供查看批次详情入口。');
assertIncludes('查看错误明细', '领域导入结果应提供查看错误明细入口。');
assertIncludes('下载原文件', '领域导入结果应提供下载原文件入口。');
assertIncludes('持久化状态', '领域导入结果应展示持久化状态。');
assertIncludes('batchId: preview.batchId || preview.auditBatch?.id', 'execute 请求应携带 preview 返回的 batchId。');
assert(!mainJs.includes('当前只展示本次 preview/execute 响应明细，不提供批次持久追溯入口'), '前端不应继续声明不提供批次持久追溯入口。');
const importAuditPanelFallbackSource = getMainSection('function getImportAuditPanel', 'async function loadImportBatchDetail');
assert(importAuditPanelFallbackSource.includes("id: selector.replace(/^#/, '')"), '非数据导入页缺少详情/错误容器时，应创建与 loader 兼容的 fallback panel。');
assert(importAuditPanelFallbackSource.includes("className: 'sub-panel import-audit-fallback-panel'"), 'fallback panel 应有可见样式类，避免点击后无反馈。');
assert(importAuditPanelFallbackSource.includes("'aria-live': 'polite'"), 'fallback panel 应使用 aria-live 提示异步结果。');
assert(importAuditPanelFallbackSource.includes('root.prepend(fallbackPanel)'), 'fallback panel 应挂载到当前页面 view-root，而不是只在数据导入页可用。');
const importBatchDetailLoaderSource = getMainSection('async function loadImportBatchDetail', 'async function loadImportErrors');
assert(importBatchDetailLoaderSource.includes('getImportAuditPanel(') && importBatchDetailLoaderSource.includes("'#import-batch-detail-panel'"), '批次详情 loader 应在缺少 imports 页 panel 时使用 fallback panel。');
assert(importBatchDetailLoaderSource.includes('safeApi(`/imports/batches/${batchId}`)'), '批次详情 loader 应在 fallback panel 中继续调用详情接口。');
const importErrorsLoaderSource = getMainSection('async function loadImportErrors', 'function renderFilterRow');
assert(importErrorsLoaderSource.includes('getImportAuditPanel(') && importErrorsLoaderSource.includes("'#import-errors-panel'"), '错误明细 loader 应在缺少 imports 页 panel 时使用 fallback panel。');
assert(importErrorsLoaderSource.includes('safeApi(`/imports/batches/${batchId}/errors?page=1&pageSize=50`)'), '错误明细 loader 应在 fallback panel 中继续调用错误明细接口。');

const productionImportAuditSource = getMainSection('function renderProductionOutputImportAudit', 'function renderProductionOutputImportPanel');
assert(productionImportAuditSource.includes('renderImportAuditBatchLinks(audit, \'月度产量导入\')'), '月度产量导入结果应接入批次详情/错误/下载入口。');
assert(productionImportAuditSource.includes('批次号：'), '月度产量导入结果应展示批次号。');
assert(productionImportAuditSource.includes('持久化状态：'), '月度产量导入结果应展示持久化状态。');
const productionPanelSource = getMainSection('function renderProductionOutputImportPanel()', 'function renderMeterReadingActions');
assert(productionPanelSource.includes('preview/execute 响应会展示可追溯批次号、批次详情、错误明细和原文件下载入口'), '月度产量导入面板应说明支持持久批次追溯。');
assert(!productionPanelSource.includes('不提供批次持久追溯入口'), '月度产量导入面板不得声明不提供持久追溯。');

const generationPanelSource = getMainSection('function renderGenerationRecordImportPanel()', 'function renderGenerationActions');
assert(generationPanelSource.includes('renderGenerationRecordImportResultRegion(preview, executeResult)'), '发电导入面板应把动态反馈挂入 live region helper。');
assert(generationPanelSource.includes("createTemplateDownloadButton('generation-records', '下载发电记录导入模板（Excel）')"), 'Excel 模板按钮必须在发电导入面板作用域内。');
assert(generationPanelSource.includes("dataset: { action: 'download-template-csv', templateType: 'generation-records'"), 'CSV 模板按钮必须在发电导入面板作用域内并指向 generation-records。');
assert(generationPanelSource.includes("createElement('input', { type: 'file', name: 'file'"), '发电 preview 表单的文件字段名必须精确为 file。');
assert(generationPanelSource.includes("action: 'export-ledger-generation'"), 'Excel 导出按钮必须在发电导入面板作用域内。');
assert(generationPanelSource.includes("action: 'export-ledger-generation-csv'"), 'CSV 导出按钮必须在发电导入面板作用域内。');
assert(!generationPanelSource.includes('children.push(renderLoading'), '发电导入 loading 不应作为 live region 外的卡片子节点渲染。');
assert(!generationPanelSource.includes('children.push(renderMessage'), '发电导入错误或空状态不应作为 live region 外的卡片子节点渲染。');
assert(!generationPanelSource.includes('children.push(...renderGenerationRecordImportAudit'), '发电导入 audit/result 不应作为 live region 外的卡片子节点渲染。');
assert(!/overwrite|append|覆盖导入|追加导入/.test(generationPanelSource), '发电导入面板不得引入 overwrite/append/覆盖/追加策略。');
assert(generationPanelSource.includes('默认 skip'), '发电导入面板应明确默认 skip。');
assert(generationPanelSource.includes('不覆盖旧记录'), '发电导入面板应明确不覆盖旧记录。');
assert(generationPanelSource.includes('当前支持从 preview/execute 响应进入持久批次追溯'), '发电导入面板应说明支持持久批次追溯。');
assert(generationPanelSource.includes('导入/导出只维护 generation_records'), '发电导入面板应继续说明只维护 generation_records。');
assert(generationPanelSource.includes('不写 energy_records'), '发电导入面板应继续说明不写 energy_records。');
assert(generationPanelSource.includes('不写 carbon_emissions'), '发电导入面板应继续说明不写 carbon_emissions。');
assert(generationPanelSource.includes('不影响单位产品能耗'), '发电导入面板应继续说明不影响单位产品能耗。');

const generationExecuteSource = getMainSection('async function executeGenerationRecordImportFromPreview', 'async function renderLedger');
assert(generationExecuteSource.includes('batchId: preview.batchId || preview.auditBatch?.id'), '发电 execute 请求应携带 preview 返回的 batchId。');
const productionExecuteSource = getMainSection('async function executeProductionOutputImport', 'async function handleProductionOutputSubmit');
assert(productionExecuteSource.includes('batchId: preview.batchId || preview.auditBatch?.id'), '月度产量 execute 请求应携带 preview 返回的 batchId。');

const generationPreviewSubmitSource = getMainSection('async function handleGenerationRecordImportPreviewSubmit', 'async function executeGenerationRecordImportFromPreview');
assert(generationPreviewSubmitSource.includes("querySelector('input[type=\"file\"][name=\"file\"]')"), '发电 preview 读取的文件 input name 必须精确为 file。');
assert(generationPreviewSubmitSource.includes("const body = new FormData()"), '发电 preview 应使用 FormData。');
assert(generationPreviewSubmitSource.includes("body.append('file', file)"), '发电 preview FormData 字段名必须精确为 file。');
assert(generationPreviewSubmitSource.includes("safeApi('/generation/records/import/preview', { method: 'POST', body })"), '发电 preview 应将 FormData 直接提交到 preview API。');

const generationExportSource = getMainSection("async function exportGenerationRecords(format = 'xlsx')", 'async function exportEnergyLedgerBackfillPreview');
assert(generationExportSource.includes("const normalizedFormat = String(format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx'"), '发电导出应规范化 format=xlsx|csv。');
assert(generationExportSource.includes('const query = toQuery({ ...state.ledgerGenerationFilters, format: normalizedFormat })'), '发电导出 query 必须使用当前 state.ledgerGenerationFilters 和 format。');
assert(generationExportSource.includes('`/generation/records/export${query}`'), '发电导出应把当前筛选 query 拼接到导出 API。');

assert(generationRouteJs.includes("router.get('/contract'"), '后端应提供发电导入导出静态契约接口。');
assert(generationRouteJs.includes("router.get('/records/export'"), '后端应提供发电当前筛选导出接口。');
assert(generationRouteJs.includes("router.post('/records/import/preview'"), '后端应提供发电导入 preview 接口。');
assert(generationRouteJs.includes("router.post('/records/import/execute', authenticate, requirePermission('ledger:generation:execute'), requireWritable('generation:records-import-execute')"), '后端应提供受控 execute 且挂写保护。');
assert(generationServiceJs.includes("GENERATION_RECORD_IMPORT_TEMPLATE_ID = 'generation-records'"), '后端应定稿 generation-records 模板 id。');
assert(generationServiceJs.includes("GENERATION_RECORD_IMPORT_CONFIRM_TEXT = '确认导入发电自用记录'"), '后端应定稿受控 execute 固定确认文本。');
assert(generationServiceJs.includes('acknowledgeSkippedRisks'), '后端契约应包含跳过风险确认字段。');
assert(generationServiceJs.includes('requireBackup'), '后端契约应包含 requireBackup 字段。');
assert(generationServiceJs.includes('previewSignature'), '后端契约应包含 previewSignature 字段。');
assert(generationServiceJs.includes('expectedWouldImport'), '后端契约应包含 expectedWouldImport 字段。');
assert(generationServiceJs.includes('candidateRows'), '后端契约应包含 candidateRows 字段。');

console.log('generation frontend contract tests passed');
