import assert from 'node:assert/strict';
import {
  ENERGY_FLOW_ANALYSIS_FIELDS,
  GENERATION_VALUE_FIELDS,
  SOURCE_MAPPING_FIELD_WHITELIST,
  buildDeterministicEnergyFlowTopology,
  buildEnergyFlowAnalysisPayload,
  buildEnergyFlowBundleImportExecutePayload,
  buildEnergyFlowEdgePresentation,
  buildEnergyFlowNodeImportExecutePayload,
  buildEnergyFlowSourceMapping,
  buildStableEnergyFlowColorRegistry,
  canCommitEnergyFlowAnalysisResponse,
  canExecuteEnergyFlowBundleImport,
  canExecuteEnergyFlowNodeImport,
  collectEnergyFlowPaginatedRows,
  createEnergyFlowAnalysisInputFingerprint,
  createEnergyFlowAnalysisRequestSnapshot,
  createEnergyFlowImportFileFingerprint,
  createEnergyFlowLatestResponseGuard,
  energyFlowReasonText,
  energyFlowRequestErrorMessage,
  formatEnergyFlowValue,
  normalizeEnergyFlowStorageChanges
} from '../utils/energyFlow.js';

// 测试夹具模块。
const nodes = [
  { id: 2, nodeCode: 'B', nodeName: '去向', nodeType: 'sink', x: 100, y: 10, status: 'active' },
  { id: 1, nodeCode: 'A', nodeName: '来源', nodeType: 'source', x: 0, y: 10, status: 'active' }
];
const edges = [{ id: 7, edgeCode: 'E-1', fromNodeId: 1, toNodeId: 2, energyTypeCode: 'electricity', unit: 'kWh', sourceType: 'explicit_edge_value', sourceMapping: { reference: 'upload:1' } }];

// 可控异步响应模块，用于验证旧响应延迟返回时的真实提交行为。
function createDeferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

// 显式坐标布局必须确定，输入顺序不影响节点、边和方向。
const firstLayout = buildDeterministicEnergyFlowTopology(nodes, edges);
const secondLayout = buildDeterministicEnergyFlowTopology([...nodes].reverse(), [...edges].reverse());
assert.deepStrictEqual(firstLayout, secondLayout);
assert.deepStrictEqual(firstLayout.nodes.map((row) => row.id), [1, 2]);
assert.equal(firstLayout.edges[0].directionLabel, '来源 → 去向');
assert(firstLayout.edges[0].x1 < firstLayout.edges[0].x2, '从左侧来源到右侧去向的边必须保持正向箭头。');

// 同一显式坐标轴的退化范围必须稳定居中，不允许从组织树推导布局。
const centeredLayout = buildDeterministicEnergyFlowTopology([
  { id: 1, nodeCode: 'N-1', nodeName: '节点 1', x: 20, y: 30 },
  { id: 2, nodeCode: 'N-2', nodeName: '节点 2', x: 20, y: 30 }
], []);
assert(centeredLayout.nodes.every((row) => row.displayX === 500 && row.displayY === 300));

// 来源映射只允许后端白名单字段，非法字段不得透传。
assert.deepStrictEqual(Object.keys(SOURCE_MAPPING_FIELD_WHITELIST).sort(), ['explicit_edge_value', 'generation', 'monthly_energy', 'timeseries']);
assert.deepStrictEqual(buildEnergyFlowSourceMapping('timeseries', {
  reference: ' meter:12 ',
  recordIds: '3,2,3,0,abc',
  meterDeviceId: 12,
  organizationUnitId: 99,
  sourceTimeZone: 'Asia/Shanghai',
  valueField: 'generation',
  forged: 'forged'
}), {
  reference: 'meter:12',
  recordIds: [3, 2],
  meterDeviceId: 12,
  sourceTimeZone: 'Asia/Shanghai'
});
assert.deepStrictEqual(buildEnergyFlowSourceMapping('explicit_edge_value', {
  reference: 'upload:batch-1',
  recordIds: [1],
  meterDeviceId: 2
}), { reference: 'upload:batch-1' });

// 发电来源必须显式保留三个不同业务字段，不允许合并或自动抵扣。
assert.deepStrictEqual(GENERATION_VALUE_FIELDS.map((item) => item.value), ['generation', 'self_use', 'grid_export']);
assert(GENERATION_VALUE_FIELDS.every((item) => item.label.includes(item.value)));
assert.deepStrictEqual(buildEnergyFlowSourceMapping('generation', {
  reference: 'generation:org-1',
  organizationUnitId: 8,
  valueField: 'self_use',
  meterDeviceId: 5
}), { reference: 'generation:org-1', organizationUnitId: 8, valueField: 'self_use' });

// 分析正文只保留后端五个允许字段，来源时区与折标视图不得误传。
assert.deepStrictEqual(ENERGY_FLOW_ANALYSIS_FIELDS, ['startMonth', 'endMonth', 'startUtc', 'endUtc', 'storageChanges']);
assert.deepStrictEqual(buildEnergyFlowAnalysisPayload({
  rangeMode: 'month',
  startMonth: '2026-01',
  endMonth: '2026-03',
  startUtc: 'forged',
  sourceTimeZone: 'Asia/Shanghai',
  standardCoalView: 'kgce'
}, [{ nodeId: 9, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:9' } }]), {
  startMonth: '2026-01',
  endMonth: '2026-03',
  storageChanges: [{ nodeId: 9, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:9' } }]
});
assert.deepStrictEqual(buildEnergyFlowAnalysisPayload({ rangeMode: 'utc', startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-02-01T00:00:00Z', startMonth: 'forged' }), {
  startUtc: '2026-01-01T00:00:00Z',
  endUtc: '2026-02-01T00:00:00Z',
  storageChanges: []
});

// 未填写储能变化不得被当作真实零提交，用户显式输入的 0 必须保留。
const storageInputs = [
  { nodeId: 1, energyTypeCode: 'electricity', unit: 'kWh', value: null, sourceMapping: { reference: '' } },
  { nodeId: 2, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:2' } }
];
assert.deepStrictEqual(normalizeEnergyFlowStorageChanges(storageInputs), [storageInputs[1]]);
assert.deepStrictEqual(buildEnergyFlowAnalysisPayload({ rangeMode: 'month', startMonth: '2026-01', endMonth: '2026-01' }, storageInputs).storageChanges, [storageInputs[1]]);

// 分析快照必须冻结模型、筛选和储能输入，后续改写原对象不能污染请求正文。
const mutableFilters = { rangeMode: 'month', startMonth: '2026-01', endMonth: '2026-02', standardCoalView: 'kgce' };
const mutableStorage = [{ nodeId: 2, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:2' } }];
const analysisSnapshot = createEnergyFlowAnalysisRequestSnapshot(9, mutableFilters, mutableStorage);
mutableFilters.startMonth = '2025-01';
mutableStorage[0].value = 99;
assert.equal(analysisSnapshot.modelId, 9);
assert.equal(analysisSnapshot.filters.startMonth, '2026-01');
assert.equal(analysisSnapshot.storageChanges[0].value, 0);
assert.equal(analysisSnapshot.payload.storageChanges[0].value, 0);
assert(Object.isFrozen(analysisSnapshot) && Object.isFrozen(analysisSnapshot.payload));
assert.equal(analysisSnapshot.inputFingerprint, createEnergyFlowAnalysisInputFingerprint(9, {
  rangeMode: 'month',
  startMonth: '2026-01',
  endMonth: '2026-02',
  standardCoalView: 'original'
}, mutableStorage.map((row) => ({ ...row, value: 0 }))));
const reorderedStorageFingerprint = createEnergyFlowAnalysisInputFingerprint(9, analysisSnapshot.filters, [
  { nodeId: 3, energyTypeCode: 'natural_gas', unit: 'm³', value: 2, sourceMapping: { reference: 'inventory:3' } },
  { nodeId: 2, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:2' } }
]);
assert.equal(reorderedStorageFingerprint, createEnergyFlowAnalysisInputFingerprint(9, analysisSnapshot.filters, [
  { nodeId: 2, energyTypeCode: 'electricity', unit: 'kWh', value: 0, sourceMapping: { reference: 'inventory:2' } },
  { nodeId: 3, energyTypeCode: 'natural_gas', unit: 'm³', value: 2, sourceMapping: { reference: 'inventory:3' } }
]));
assert.notEqual(analysisSnapshot.inputFingerprint, createEnergyFlowAnalysisInputFingerprint(9, { ...analysisSnapshot.filters, startMonth: '2026-02' }, analysisSnapshot.storageChanges));

// SVG 与表格复用的边展示行必须保持方向、真实零、原因和固定能源色槽一致。
const presentation = buildEnergyFlowEdgePresentation(firstLayout, [{ edgeId: 7, value: 0, trueZero: true, status: 'complete', reasonCodes: ['MISSING_CONVERSION_FACTOR'], configurationErrors: ['SOURCE_RECORD_REUSED_ACROSS_EDGES'] }]);
assert.equal(presentation[0].directionLabel, firstLayout.edges[0].directionLabel);
assert.equal(presentation[0].value, 0);
assert.equal(presentation[0].trueZero, true);
assert.deepStrictEqual(presentation[0].reasonCodes, ['MISSING_CONVERSION_FACTOR', 'SOURCE_RECORD_REUSED_ACROSS_EDGES']);
assert.equal(presentation[0].color, 'var(--series-1)');

// 分类色绑定完整业务色域；筛选前后同一能源不换色，容量外统一使用其他色且不循环。
const colorDomain = ['electricity', 'photovoltaic', 'natural_gas', 'gasoline', 'diesel'];
const manyEdges = colorDomain.map((energyTypeCode, index) => ({ id: index + 1, edgeCode: `E-${index}`, energyTypeCode, visible: true }));
const colored = buildEnergyFlowEdgePresentation({ edges: manyEdges }, [], { colorDomain });
const filteredColored = buildEnergyFlowEdgePresentation({ edges: manyEdges.filter((row) => row.energyTypeCode === 'natural_gas') }, [], { colorDomain });
assert.equal(colored.find((row) => row.energyTypeCode === 'natural_gas').color, 'var(--series-3)');
assert.equal(filteredColored[0].color, 'var(--series-3)');
assert.equal(colored.find((row) => row.energyTypeCode === 'gasoline').isOtherSeries, true);
assert.equal(colored.find((row) => row.energyTypeCode === 'gasoline').color, 'var(--series-other)');
assert.equal(colored.find((row) => row.energyTypeCode === 'diesel').color, 'var(--series-other)');
assert.notEqual(colored.find((row) => row.energyTypeCode === 'gasoline').color, colored[0].color);
assert.deepStrictEqual([...buildStableEnergyFlowColorRegistry(colorDomain).values()], [1, 2, 3, 0, 0]);
assert.equal(buildStableEnergyFlowColorRegistry(['natural_gas', 'electricity']).get('natural_gas'), 3);

// 真实零与缺失必须有明确不同文本。
assert.equal(formatEnergyFlowValue(0, true), '0');
assert.equal(formatEnergyFlowValue(null, false), '缺失');
assert.equal(formatEnergyFlowValue(undefined, false), '缺失');
assert.equal(formatEnergyFlowValue(12.345, false), '12.35');

// 指定质量原因码必须提供稳定中文提示，未知码仍保留技术码。
for (const code of ['SOURCE_RECORD_REUSED_ACROSS_EDGES', 'SOURCE_OVERLAP_OR_DUPLICATE', 'MISSING_CONVERSION_FACTOR', 'FACTOR_PERIOD_AMBIGUOUS', 'TOPOLOGY_SOURCE_UNMAPPED', 'UNIT_NOT_COMPARABLE']) {
  assert(!energyFlowReasonText(code).startsWith('未识别原因'), `${code} 应有中文原因文案。`);
}
assert.equal(energyFlowReasonText('CUSTOM_REASON'), '未识别原因：CUSTOM_REASON');

// 节点和边维护必须按分页契约收集 200+ 数据，并按 ID 去重。
const paginatedSource = Array.from({ length: 405 }, (_, index) => ({ id: index + 1, name: `row-${index + 1}` }));
const requestedPages = [];
const paginatedRows = await collectEnergyFlowPaginatedRows(async ({ page, pageSize }) => {
  requestedPages.push(page);
  const start = (page - 1) * pageSize;
  return {
    data: paginatedSource.slice(start, start + pageSize),
    meta: { pagination: { page, pageSize, total: paginatedSource.length, totalPages: Math.ceil(paginatedSource.length / pageSize) } }
  };
});
assert.equal(paginatedRows.length, 405);
assert.deepStrictEqual(requestedPages, [1, 2, 3]);
assert.equal(paginatedRows.at(-1).id, 405);

// 重叠页允许按 ID 去重，但必须最终满足服务端 total。
const overlappingPages = {
  1: [{ id: 1 }, { id: 2 }],
  2: [{ id: 2 }, { id: 3 }],
  3: [{ id: 4 }]
};
const overlappingRows = await collectEnergyFlowPaginatedRows(async ({ page }) => ({
  data: overlappingPages[page] || [],
  meta: { pagination: { page, pageSize: 2, total: 4, totalPages: 3 } }
}), {}, { pageSize: 2 });
assert.deepStrictEqual(overlappingRows.map((row) => row.id), [1, 2, 3, 4]);

// 完全重复页、提前空页和到达末页仍不足 total 必须明确报错。
await assert.rejects(
  collectEnergyFlowPaginatedRows(async ({ page }) => ({
    data: [{ id: 1 }, { id: 2 }],
    meta: { pagination: { page, pageSize: 2, total: 4, totalPages: 2 } }
  }), {}, { pageSize: 2 }),
  /分页停滞.*没有新增唯一 ID/
);
await assert.rejects(
  collectEnergyFlowPaginatedRows(async ({ page }) => ({
    data: page === 1 ? [{ id: 1 }, { id: 2 }] : [],
    meta: { pagination: { page, pageSize: 2, total: 4, totalPages: 3 } }
  }), {}, { pageSize: 2 }),
  /分页数据不完整.*提前返回空页.*2\/4/
);
await assert.rejects(
  collectEnergyFlowPaginatedRows(async ({ page }) => ({
    data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }],
    meta: { pagination: { page, pageSize: 2, total: 4, totalPages: 2 } }
  }), {}, { pageSize: 2 }),
  /分页数据不完整.*3\/4/
);

// latest-response 守卫必须拒绝旧模型、旧拓扑或旧分析响应。
const latestGuard = createEnergyFlowLatestResponseGuard();
const oldTicket = latestGuard.begin({ modelId: 1 });
const latestTicket = latestGuard.begin({ modelId: 2 });
assert.equal(latestGuard.isCurrent(oldTicket), false);
assert.equal(latestGuard.isCurrent(latestTicket), true);
latestGuard.invalidate();
assert.equal(latestGuard.isCurrent(latestTicket), false);

// 延迟分析响应必须同时通过 latest ticket 和当前输入指纹，旧输入响应不得提交。
const analysisRaceGuard = createEnergyFlowLatestResponseGuard();
let currentAnalysisFilters = { rangeMode: 'month', startMonth: '2026-01', endMonth: '2026-01' };
const delayedAnalysisSnapshot = createEnergyFlowAnalysisRequestSnapshot(9, currentAnalysisFilters, []);
const delayedAnalysisTicket = analysisRaceGuard.begin(delayedAnalysisSnapshot);
const delayedAnalysis = createDeferred();
const delayedAnalysisCommit = (async () => {
  await delayedAnalysis.promise;
  return canCommitEnergyFlowAnalysisResponse({
    isLatest: analysisRaceGuard.isCurrent(delayedAnalysisTicket),
    snapshot: delayedAnalysisSnapshot,
    currentModelId: 9,
    currentInputFingerprint: createEnergyFlowAnalysisInputFingerprint(9, currentAnalysisFilters, [])
  });
})();
currentAnalysisFilters = { ...currentAnalysisFilters, startMonth: '2026-02', endMonth: '2026-02' };
delayedAnalysis.resolve();
assert.equal(await delayedAnalysisCommit, false);

const oldAnalysisDeferred = createDeferred();
const latestAnalysisDeferred = createDeferred();
currentAnalysisFilters = { rangeMode: 'month', startMonth: '2026-03', endMonth: '2026-03' };
const oldAnalysisSnapshot = createEnergyFlowAnalysisRequestSnapshot(9, currentAnalysisFilters, []);
const oldAnalysisTicket = analysisRaceGuard.begin(oldAnalysisSnapshot);
const latestAnalysisSnapshot = createEnergyFlowAnalysisRequestSnapshot(9, currentAnalysisFilters, []);
const latestAnalysisTicket = analysisRaceGuard.begin(latestAnalysisSnapshot);
const resolveAnalysisCommit = async (deferred, ticket, snapshot) => {
  await deferred.promise;
  return canCommitEnergyFlowAnalysisResponse({
    isLatest: analysisRaceGuard.isCurrent(ticket),
    snapshot,
    currentModelId: 9,
    currentInputFingerprint: createEnergyFlowAnalysisInputFingerprint(9, currentAnalysisFilters, [])
  });
};
const oldAnalysisCommit = resolveAnalysisCommit(oldAnalysisDeferred, oldAnalysisTicket, oldAnalysisSnapshot);
const latestAnalysisCommit = resolveAnalysisCommit(latestAnalysisDeferred, latestAnalysisTicket, latestAnalysisSnapshot);
latestAnalysisDeferred.resolve();
assert.equal(await latestAnalysisCommit, true);
oldAnalysisDeferred.resolve();
assert.equal(await oldAnalysisCommit, false);

// 页面错误表达必须统一覆盖登录、权限、文件大小、维护态和业务原因码。
for (const [status, expectedText] of [[401, '登录状态已失效'], [403, '没有执行此能流操作的权限'], [413, '上传文件超过'], [423, '系统处于维护态']]) {
  assert(energyFlowRequestErrorMessage({ response: { status } }).includes(expectedText));
}
assert(energyFlowRequestErrorMessage({ apiError: { code: 'UNIT_NOT_COMPARABLE', message: '分析失败' } }).includes('配置单位与能源标准单位不可比'));
const realBadRequestMessage = energyFlowRequestErrorMessage({
  response: {
    status: 400,
    data: {
      error: {
        code: 'BAD_REQUEST',
        message: '月份范围最多支持 36 个月。',
        details: { code: 'ENERGY_FLOW_RANGE_TOO_LARGE' }
      }
    }
  }
});
assert.equal(realBadRequestMessage, '月份范围最多支持 36 个月。；ENERGY_FLOW_RANGE_TOO_LARGE：统计期超过能流分析允许的约 36 个月范围。');
assert(!realBadRequestMessage.includes('原因码 BAD_REQUEST'), 'BAD_REQUEST 只属于错误信封，不得作为业务原因展示。');
const structuredReasonMessage = energyFlowRequestErrorMessage({
  apiError: {
    code: 'BAD_REQUEST',
    message: '能流配置校验失败。',
    details: {
      configurationErrors: ['SOURCE_MAPPING_REFERENCE_MISSING', { code: 'TIMESERIES_SELECTOR_MISSING' }],
      authorizationErrors: [{ code: 'CUSTOM_ENERGY_FLOW_SCOPE_DENIED' }]
    }
  }
});
assert(structuredReasonMessage.includes('SOURCE_MAPPING_REFERENCE_MISSING：来源映射缺少可追溯标识。'));
assert(structuredReasonMessage.includes('TIMESERIES_SELECTOR_MISSING：时序来源缺少记录 ID 或计量器具选择器。'));
assert(structuredReasonMessage.includes('原因码 CUSTOM_ENERGY_FLOW_SCOPE_DENIED'));

// 节点 execute 使用完整预演上下文，双工作表 execute 只提交后端允许的最小正文。
const nodePreview = {
  batchId: 11,
  confirmText: '确认导入能流节点',
  backupReason: '能流导入自动备份',
  duplicateStrategy: 'skip_exact_duplicate',
  fileSha256: 'a'.repeat(64),
  previewSignature: 'signature',
  previewAuditDigest: 'digest',
  expectedWouldImport: 1,
  candidateRowIds: ['node:1'],
  candidateRows: [{ candidateRowId: 'node:1' }]
};
const nodeImportFile = { name: 'nodes.xlsx', size: 128, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 1000 };
const nodeImportFileFingerprint = createEnergyFlowImportFileFingerprint(nodeImportFile);
const currentNodeImportContext = {
  loading: false,
  currentFileFingerprint: nodeImportFileFingerprint,
  previewFileFingerprint: nodeImportFileFingerprint,
  isLatest: true
};
assert.equal(canExecuteEnergyFlowNodeImport(nodePreview, currentNodeImportContext), true);
assert.equal(canExecuteEnergyFlowNodeImport(nodePreview, { ...currentNodeImportContext, loading: true }), false);
assert.equal(canExecuteEnergyFlowNodeImport(nodePreview, { ...currentNodeImportContext, previewFileFingerprint: createEnergyFlowImportFileFingerprint({ ...nodeImportFile, lastModified: 1001 }) }), false);
assert.deepStrictEqual(buildEnergyFlowNodeImportExecutePayload(nodePreview), {
  ...nodePreview,
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
const bundlePreview = { edgeBatchId: 21, recordBatchId: 22, confirmText: '确认导入能流边及显式边值', expectedWouldImport: 2, candidateRows: [{ forged: true }] };
const bundleImportFile = { name: 'bundle.xlsx', size: 256, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 2000 };
const bundleImportFileFingerprint = createEnergyFlowImportFileFingerprint(bundleImportFile);
const currentBundleImportContext = {
  loading: false,
  currentFileFingerprint: bundleImportFileFingerprint,
  previewFileFingerprint: bundleImportFileFingerprint,
  isLatest: true
};
assert.equal(canExecuteEnergyFlowBundleImport(bundlePreview, currentBundleImportContext), true);
assert.deepStrictEqual(buildEnergyFlowBundleImportExecutePayload(bundlePreview), {
  edgeBatchId: 21,
  recordBatchId: 22,
  confirmText: '确认导入能流边及显式边值',
  requireBackup: true,
  acknowledgeSkippedRisks: true
});
assert.equal(canExecuteEnergyFlowBundleImport({ ...bundlePreview, recordBatchId: 21 }, currentBundleImportContext), false);

// 重新预演开始后必须立即禁用 execute，旧响应延迟返回也不能恢复旧预演。
const previewRaceGuard = createEnergyFlowLatestResponseGuard();
const firstPreviewTicket = previewRaceGuard.begin({ fileFingerprint: nodeImportFileFingerprint });
let previewState = nodePreview;
let previewBinding = { fileFingerprint: nodeImportFileFingerprint, ticket: firstPreviewTicket };
let previewLoading = false;
const canExecutePreviewState = () => canExecuteEnergyFlowNodeImport(previewState, {
  loading: previewLoading,
  currentFileFingerprint: nodeImportFileFingerprint,
  previewFileFingerprint: previewBinding?.fileFingerprint,
  isLatest: previewRaceGuard.isCurrent(previewBinding?.ticket)
});
assert.equal(canExecutePreviewState(), true);
const oldPreviewDeferred = createDeferred();
const latestPreviewDeferred = createDeferred();
const oldPreviewTicket = previewRaceGuard.begin({ fileFingerprint: nodeImportFileFingerprint });
const oldPreviewResponse = (async () => {
  const responsePreview = await oldPreviewDeferred.promise;
  if (previewRaceGuard.isCurrent(oldPreviewTicket)) {
    previewState = responsePreview;
    previewBinding = { fileFingerprint: nodeImportFileFingerprint, ticket: oldPreviewTicket };
  }
})();
const latestPreviewTicket = previewRaceGuard.begin({ fileFingerprint: nodeImportFileFingerprint });
previewState = null;
previewBinding = null;
previewLoading = true;
const latestPreviewResponse = (async () => {
  const responsePreview = await latestPreviewDeferred.promise;
  if (previewRaceGuard.isCurrent(latestPreviewTicket)) {
    previewState = responsePreview;
    previewBinding = { fileFingerprint: nodeImportFileFingerprint, ticket: latestPreviewTicket };
    previewLoading = false;
  }
})();
assert.equal(canExecutePreviewState(), false);
oldPreviewDeferred.resolve(nodePreview);
await oldPreviewResponse;
assert.equal(canExecutePreviewState(), false);
latestPreviewDeferred.resolve(nodePreview);
await latestPreviewResponse;
assert.equal(canExecutePreviewState(), true);

console.log('energyFlowLogic.test.mjs passed');
