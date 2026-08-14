import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 静态契约读取模块。
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = async (relativePath) => readFile(resolve(currentDirectory, relativePath), 'utf8');
const [apiSource, pageSource, topologySource, logicSource] = await Promise.all([
  source('../api/energyFlows.js'),
  source('../views/energy/flows/index.vue'),
  source('../views/energy/flows/EnergyFlowTopology.vue'),
  source('../utils/energyFlow.js')
]);

// API 根路径、HTTP 方法和资源层级必须与后端路由一致。
for (const endpoint of [
  "'/energy-flows'",
  "'/energy-flow-imports'",
  '/models/${modelId}/nodes',
  '/models/${modelId}/edges',
  '/models/${modelId}/topology',
  '/models/${modelId}/analysis',
  '/models/preview',
  '/models/execute',
  '/nodes/preview',
  '/nodes/execute',
  '/bundle/preview',
  '/bundle/execute'
]) assert(apiSource.includes(endpoint), `API 应包含 ${endpoint}`);
for (const method of ["method: 'post'", "method: 'put'", "method: 'patch'"]) assert(apiSource.includes(method), `API 应包含 ${method}`);
assert(apiSource.includes("data.append('file', file)"), '导入上传字段必须固定为 file。');
assert(apiSource.includes("import { download, query, request } from '@/api/http';"), '能流模板和示例下载必须复用共享 HTTP download。');
assert(apiSource.includes('/templates/demo-park/') && apiSource.includes('/templates/${encodeURIComponent(templateType)}'), '能流 API 必须提供空白模板和青岚示例下载。');
assert(apiSource.includes('params: query(params)'), 'GET 参数必须使用共享 query 清理空值。');
assert(apiSource.includes('listAllEnergyFlowNodes') && apiSource.includes('listAllEnergyFlowEdges'), '节点和边维护必须提供全量分页读取 API。');
assert(apiSource.includes('collectEnergyFlowPaginatedRows'), '全量节点和边必须复用后端分页契约收集器。');
assert(pageSource.includes('listAllEnergyFlowNodes(modelId)') && pageSource.includes('listAllEnergyFlowEdges(modelId)'), '模型切换必须加载全部节点和边。');
assert(!pageSource.includes('listEnergyFlowNodes(modelId, { page: 1, pageSize: 200 })'), '节点维护不得固定截断在前 200 条。');
assert(!pageSource.includes('listEnergyFlowEdges(modelId, { page: 1, pageSize: 200 })'), '边维护不得固定截断在前 200 条。');

// 页面必须声明四类权限并将写操作与查看权限分离。
for (const permission of [
  'energy:flows:view',
  'energy:flows:manage',
  'energy:flows:import:preview',
  'energy:flows:import:execute'
]) assert(pageSource.includes(permission), `页面应检查 ${permission}`);
assert(pageSource.includes('维护态仍可用'), '页面应说明读取和分析在维护态仍可用。');
assert(pageSource.includes('维护态会阻断执行'), '页面应说明导入 execute 由维护态阻断。');

// 产品边界必须直接展示，不能以自动推导或自动抵扣替代显式模型。
for (const text of [
  '不从组织树推导',
  '不自动抵扣能耗或碳排',
  '不自动定性为损耗',
  '显式储能变化',
  'generation、self_use 或 grid_export',
  '物理端点、能源分面和来源映射不可重写'
]) assert(pageSource.includes(text) || logicSource.includes(text), `页面或逻辑层应包含边界提示：${text}`);

// 分析 UI 必须覆盖统计期、时区、三种视图、覆盖率、差额和原因。
for (const text of ['统计期类型', '来源时区', '原单位', 'kgce', 'tce', '覆盖率', '节点流入、流出与差额', '不平衡率', '质量与原因提示', '异常明细', '来源使用审计']) {
  assert(pageSource.includes(text), `分析页应包含 ${text}`);
}
for (const code of [
  'SOURCE_RECORD_REUSED_ACROSS_EDGES',
  'SOURCE_OVERLAP_OR_DUPLICATE',
  'MISSING_CONVERSION_FACTOR',
  'FACTOR_PERIOD_AMBIGUOUS',
  'TOPOLOGY_SOURCE_UNMAPPED',
  'UNIT_NOT_COMPARABLE'
]) assert(logicSource.includes(code), `原因映射应包含 ${code}`);
assert(pageSource.includes("formatEnergyFlowValue(row[field]"), '节点平衡表必须复用真实零/缺失格式化逻辑。');
for (const contract of ['modelListError', 'modelSelectionError', 'organizationUnitsError', 'energyTypesError', 'analysisHasRun']) {
  assert(pageSource.includes(contract), `页面必须显式区分 ${contract} 对应状态。`);
}
for (const status of ['401', '403', '413', '423']) assert(logicSource.includes(`${status}:`), `页面错误映射必须覆盖 HTTP ${status}。`);
assert(logicSource.includes('apiError.details?.code') && logicSource.includes('configurationErrors') && logicSource.includes('authorizationErrors'), '错误映射必须读取真实 badRequest details.code 和结构化业务原因数组。');
assert(logicSource.includes('ENERGY_FLOW_ENVELOPE_CODES') && logicSource.includes('ENERGY_FLOW_RANGE_TOO_LARGE'), '通用错误信封码不得冒充业务原因，范围业务码必须有中文解释。');
assert(logicSource.includes('分页停滞') && logicSource.includes('分页数据不完整'), '分页收集器必须检测重复页停滞和 total 不完整。');
assert(pageSource.includes('createEnergyFlowAnalysisRequestSnapshot') && pageSource.includes('analysisRequestGuard'), '分析必须冻结请求快照并启用 latest-response 保护。');
assert(pageSource.includes('analysisCurrentInputFingerprint') && pageSource.includes('canCommitEnergyFlowAnalysisResponse'), '分析响应必须同时绑定当前输入指纹和 latest ticket。');
assert(pageSource.includes('analysisResultDirty') && pageSource.includes('analysisSnapshotRangeLabel'), '旧分析结果必须按请求快照展示并标记当前输入脏状态。');
assert(pageSource.includes('modelSelectionRequestGuard') && pageSource.includes('modelListRequestGuard'), '模型列表和模型切换必须启用 latest-response 保护。');
assert(pageSource.includes('storageChanges.value = []'), '模型切换必须清理旧模型储能变化。');

// 四个严格 UTC 字段必须统一复用共享输入，月份选择器和来源时区边界不得被扩大迁移。
assert(pageSource.includes("import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';"), '页面必须引入共享严格 UTC 输入组件。');
assert.equal((pageSource.match(/<StrictUtcDateTimeInput\b/g) || []).length, 4, '分析 UTC 起止和模型有效期起止必须共使用四个共享组件。');
for (const fieldName of ['analysisFilters.startUtc', 'analysisFilters.endUtc', 'modelForm.effectiveStartUtc', 'modelForm.effectiveEndUtc']) {
  assert(pageSource.includes(`v-model="${fieldName}"`), `严格 UTC 组件必须保持字段 ${fieldName} 的 v-model。`);
  assert(!pageSource.includes(`<el-input v-model.trim="${fieldName}"`), `字段 ${fieldName} 不得继续使用普通文本输入。`);
}
for (const fieldName of ['effectiveStartUtc', 'effectiveEndUtc']) {
  assert.match(pageSource, new RegExp(`<StrictUtcDateTimeInput v-model="modelForm\\.${fieldName}" :disabled="Boolean\\(modelEditing\\)"`), `${fieldName} 在模型编辑态必须继续冻结。`);
}
assert.match(pageSource, /<el-date-picker(?=[^>]*v-model="analysisFilters\.startMonth")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>/, '开始月份必须继续使用可编辑的 YYYY-MM 月份控件。');
assert.match(pageSource, /<el-date-picker(?=[^>]*v-model="analysisFilters\.endMonth")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>/, '结束月份必须继续使用可编辑的 YYYY-MM 月份控件。');
assert(pageSource.includes('<el-form-item label="来源时区"><el-input :model-value="selectedModel.sourceTimeZone" disabled /></el-form-item>'), '分析来源时区必须继续只读展示模型时区。');
assert(pageSource.includes("import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';"), '页面必须引入共享 IANA 时区选择组件。');
assert.equal((pageSource.match(/<IanaTimeZoneSelect\b/g) || []).length, 2, '模型与边来源映射的可编辑时区必须使用共享选择组件。');
assert(pageSource.includes('<IanaTimeZoneSelect v-model="modelForm.sourceTimeZone" :disabled="Boolean(modelEditing)"'), '模型来源时区必须继续使用原字段并在编辑态冻结。');
assert(pageSource.includes('<IanaTimeZoneSelect v-model="edgeForm.sourceTimeZone" :disabled="edgeBindingFrozen"'), '边来源时区必须继续使用原字段并在绑定冻结态禁用。');
assert(!pageSource.includes('v-model.trim="modelForm.sourceTimeZone"'), '模型来源时区不得继续使用普通输入框。');
assert(!pageSource.includes('v-model.trim="edgeForm.sourceTimeZone"'), '边来源时区不得继续使用普通输入框。');
assert(pageSource.includes("import { parseStrictUtcDateTime } from '@/utils/dateTimeFields';"), '表单规则必须复用共享严格 UTC 解析。');
assert(pageSource.includes('normalizeEnergyFlowModelUtcFields') && pageSource.includes('normalizeEnergyFlowAnalysisUtcFields'), '模型回显、复制和 UTC 分析提交必须复用可测试的规范化逻辑。');
assert(pageSource.includes('prepareModelForm(row)') && pageSource.includes("prepareModelForm(row, { id: undefined, version: '', status: 'active' })"), '模型编辑与新版本复制必须规范 UTC 回显。');
assert.match(pageSource, /const utcNormalization = normalizeEnergyFlowModelUtcFields\(modelForm\.value\);[\s\S]*?if \(!utcNormalization\.valid\) \{ formError\.value = modelUtcDiagnostic\.value \|\| utcNormalization\.message; return; \}/, '模型保存前必须再次阻断非法 UTC，并保留回显原值诊断。');
assert.match(pageSource, /if \(!modelEditing\.value && !isIanaTimeZone\(utcNormalization\.value\.sourceTimeZone\)\) \{ formError\.value = '请选择当前运行时可识别的 IANA 来源时区。'; return; \}[\s\S]*?createEnergyFlowModel\(payload\)/, '模型新增和新版本必须在创建 API 前执行运行时 IANA 校验。');
assert.match(pageSource, /const edgeSourceTimeZone = String\(edgeForm\.value\.sourceTimeZone \|\| ''\)\.trim\(\);[\s\S]*?if \(edgeSourceTimeZone && !isIanaTimeZone\(edgeSourceTimeZone\)\)[\s\S]*?buildEnergyFlowSourceMapping/, '边可选来源时区非空时必须在构造写载荷前执行运行时 IANA 校验。');
assert.match(pageSource, /const utcNormalization = normalizeEnergyFlowAnalysisUtcFields\(filters\);[\s\S]*?if \(!utcNormalization\.valid\) \{ analysisError\.value = analysisUtcDiagnostic\.value \|\| utcNormalization\.message; return; \}/, 'UTC 分析提交前必须再次阻断非法 UTC，并保留初始化原值诊断。');
assert(pageSource.includes("analysisError.value = analysisUtcDiagnostic.value || '请填写完整 UTC 区间。'") && pageSource.includes("const analysisUtcDiagnostic = ref('')"), '隐藏非法 UTC 被清空后，分析提交仍必须展示原始诊断并阻断。');
assert(pageSource.includes("const modelUtcDiagnostic = ref('')") && pageSource.includes('modelUtcDiagnostic.value = normalization.message'), '模型非法原值只能保留在诊断状态。');
assert(pageSource.includes("strictUtcRule('生效开始 UTC')") && pageSource.includes("strictUtcRule('生效结束 UTC')"), '模型表单规则必须拒绝非零毫秒。');

// SVG 必须可访问、可缩放、可滚动，并提供同源等价表格。
for (const contract of [
  'role="img"',
  '<title :id="svgTitleId">',
  '<desc :id="svgDescId">',
  'tabindex="0"',
  'marker-end',
  '节点等价表格',
  '边等价表格',
  'topology-scroll',
  'changeZoom',
  'fitTopology'
]) assert(topologySource.includes(contract), `拓扑组件应包含 ${contract}`);
assert(topologySource.includes('buildEnergyFlowEdgePresentation(layout.value'), 'SVG 和表格必须复用同一边展示行。');
assert(topologySource.includes('directionLabel'), '边表格必须显式展示方向。');
assert(topologySource.includes('其他能源（超出固定色序）'), '超出固定色序后必须折叠为其他，而不是循环颜色。');
assert(topologySource.includes('class="edge-hit-line"') && topologySource.includes('.edge-hit-line{stroke-width:24'), '可见细边必须叠加约 24px 透明命中线。');
assert(topologySource.includes('label="原因说明"') && topologySource.includes('reasonSummary(row)'), '边等价表格必须展示原因码中文说明。');
assert(topologySource.includes('function edgeAriaLabel(edge)') && topologySource.includes('${reasonSummary(edge)}'), '边 ARIA 说明必须包含与 tooltip、表格等价的原因信息。');
assert.equal((topologySource.match(/<title :id="svgTitleId">/g) || []).length, 1, '每个 SVG 模板只能声明一个唯一 title。');
assert.equal((topologySource.match(/<desc :id="svgDescId">/g) || []).length, 1, '每个 SVG 模板只能声明一个唯一 desc。');
assert(topologySource.includes('--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a') && topologySource.includes('--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70'), '拓扑必须使用分别选择的亮暗三色全配对调色板。');
assert(logicSource.includes('buildStableEnergyFlowColorRegistry') && pageSource.includes(':color-domain="energyTypeColorDomain"'), '颜色必须按完整能源业务键色域稳定绑定。');

// 分析请求和导入请求不得携带未授权客户端伪造字段。
assert(logicSource.includes("['startMonth', 'endMonth', 'startUtc', 'endUtc', 'storageChanges']"), '分析正文应固定五字段白名单。');
assert(logicSource.includes('edgeBatchId: preview.edgeBatchId') && logicSource.includes('recordBatchId: preview.recordBatchId'), 'bundle execute 应提交双批次 ID。');
const singleBatchBuilderStart = logicSource.indexOf('function buildEnergyFlowSingleBatchImportExecutePayload');
const singleBatchBuilder = logicSource.slice(singleBatchBuilderStart, logicSource.indexOf('\n}', singleBatchBuilderStart) + 2);
for (const forbidden of ['candidateRows:', 'candidateRowIds:', 'previewSignature:', 'previewAuditDigest:', 'fileSha256:', 'expectedWouldImport:', 'backupReason:', 'duplicateStrategy:']) assert(!singleBatchBuilder.includes(forbidden), `模型/节点 execute 不得提交 ${forbidden}`);
const bundleBuilderStart = logicSource.indexOf('export function buildEnergyFlowBundleImportExecutePayload');
const bundleBuilder = logicSource.slice(bundleBuilderStart, logicSource.indexOf('\n}', bundleBuilderStart) + 2);
for (const forbidden of ['candidateRows:', 'candidateRowIds:', 'previewSignature:', 'fileSha256:']) assert(!bundleBuilder.includes(forbidden), `bundle execute 不得提交 ${forbidden}`);
assert(pageSource.includes("previewEnergyFlowModelImport(requestTicket.snapshot.file)"), '模型 preview 必须使用受保护的文件快照调用后端。');
assert(pageSource.includes("previewEnergyFlowNodeImport(requestTicket.snapshot.file)"), '节点 preview 必须使用受保护的文件快照调用后端。');
assert(pageSource.includes("previewEnergyFlowBundleImport(requestTicket.snapshot.file)"), 'bundle preview 必须使用受保护的文件快照调用后端。');
assert(pageSource.includes(':file-list="modelImportFileList"') && pageSource.includes(':file-list="nodeImportFileList"') && pageSource.includes(':file-list="bundleImportFileList"'), '三个上传控件必须使用受控 file-list。');
assert(pageSource.includes(":on-remove=\"() => clearImportSelection('model')\"") && pageSource.includes(":on-remove=\"() => clearImportSelection('node')\"") && pageSource.includes(":on-remove=\"() => clearImportSelection('bundle')\""), '三个上传控件移除文件时必须同步清空状态。');
assert(pageSource.includes('prepareImportPreview') && pageSource.includes('resetImportExecutionContext'), '重新预演必须立即清空旧预演、确认文本和执行种类。');
assert(pageSource.includes('modelImportPreviewBinding') && pageSource.includes('nodeImportPreviewBinding') && pageSource.includes('bundleImportPreviewBinding'), '三个预演结果必须绑定当前文件指纹和请求票据。');
assert(pageSource.includes('activeImportCanExecute') && logicSource.includes('previewFileFingerprint'), '导入 execute 必须校验 loading、当前文件和最新预演绑定。');
for (const contract of [
  ':disabled="importExecuteLoading"',
  ':disabled="!modelImportFile || importExecuteLoading"',
  ':disabled="!nodeImportFile || importExecuteLoading"',
  ':disabled="!bundleImportFile || importExecuteLoading"',
  '@update:model-value="updateImportExecuteDrawer"',
  'if (importExecuteLoading.value && !open) return',
  'createEnergyFlowImportExecuteSnapshot',
  'importExecuteRequestGuard',
  'canCommitEnergyFlowImportExecuteResponse'
]) assert(pageSource.includes(contract) || logicSource.includes(contract), `导入执行并发隔离必须包含 ${contract}`);
assert.match(pageSource, /const executeSnapshot = createEnergyFlowImportExecuteSnapshot\(kind, preview, currentImportFingerprint\(kind\)\);[\s\S]*?submitEnergyFlowImport\(executeSnapshot\.kind, executeSnapshot\.preview\)/, 'execute 调用必须使用开始时冻结的 kind 和 preview。');
assert.match(pageSource, /function clearImportSelection\(kind\) \{\s*if \(importExecuteLoading\.value\) return;/, 'execute loading 期间必须阻止文件移除。');
assert.match(pageSource, /function selectImportFile\(kind, upload\) \{\s*if \(importExecuteLoading\.value\) return;/, 'execute loading 期间必须阻止文件选择。');
assert.match(pageSource, /function prepareImportPreview\(kind\) \{\s*if \(importExecuteLoading\.value\) return false;/, 'execute loading 期间必须阻止重新 preview。');
for (const state of ['modelImportFile.value = null', 'modelImportPreview.value = null', 'nodeImportFile.value = null', 'nodeImportPreview.value = null', 'bundleImportFile.value = null', 'bundleImportPreview.value = null', "confirmText.value = ''"]) {
  assert(pageSource.includes(state), `上传移除必须清理 ${state}。`);
}
assert(pageSource.includes('依赖顺序：1 模型 → 2 节点 → 3 边 → 4 显式边值'), '空库可见导入区必须明确完整依赖顺序。');
for (const artifact of ['22-energy-flow-models', '23-energy-flow-nodes', '24-energy-flow-edges']) assert(pageSource.includes(artifact), `页面必须提供青岚示例 ${artifact}。`);
assert(pageSource.indexOf('能流模型与拓扑导入') < pageSource.indexOf('<template v-if="selectedModel">'), '模型导入区必须位于 selectedModel 条件之外。');
assert(pageSource.includes("if (executeSnapshot.kind !== 'model' && selectedModel.value) await selectModel(selectedModel.value);"), '模型 execute 成功后只刷新模型列表并清理旧 preview，不得依赖旧模型选择刷新。');
assert(pageSource.includes('value: null, sourceMapping'), '新增储能变化默认值必须为空。');
assert(!pageSource.includes("value: 0, sourceMapping: { reference: '' }"), '新增储能变化不得默认伪造真实零。');
assert(logicSource.includes("row?.value !== '' && row?.value !== null && row?.value !== undefined"), '分析正文必须排除未填写储能变化并保留显式零。');

console.log('energyFlowContract.test.mjs passed');
