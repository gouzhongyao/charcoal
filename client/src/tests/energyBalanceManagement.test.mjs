import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALANCE_ROLE_DEFINITIONS,
  ENERGY_BALANCE_PERMISSIONS,
  balanceReasonLabel,
  buildBalanceChartRows,
  buildBalanceItemPayload,
  calculateBalanceBarWidth,
  createLatestEnergyBalanceRequestGuard,
  buildFullMonthCalculationWindow,
  buildSnapshotFilters,
  buildSuggestionFilters,
  formatEnergyBalanceRequestError,
  groupSnapshotsByCalculationRun,
  isFullNaturalMonthWindow,
  loadAllEnergyBalanceItems,
  normalizeEnergyBalanceBoundaryUtcFields,
  suggestionReviewTargets,
  validateSuggestionReview
} from '../utils/energyBalanceManagement.js';

/** 当前测试目录和待检查源码路径。 */
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientSourceDirectory = path.resolve(currentDirectory, '..');
const pageSource = fs.readFileSync(path.join(clientSourceDirectory, 'views/energy/balances/index.vue'), 'utf8');
const chartSource = fs.readFileSync(path.join(clientSourceDirectory, 'views/energy/balances/BalanceDivergingChart.vue'), 'utf8');
const apiSource = fs.readFileSync(path.join(clientSourceDirectory, 'api/energyBalances.js'), 'utf8');
const utilitySource = fs.readFileSync(path.join(clientSourceDirectory, 'utils/energyBalanceManagement.js'), 'utf8');

/** 验证九角色标签完整且顺序与服务端契约一致。 */
function testNineRoleLabels() {
  assert.deepEqual(
    BALANCE_ROLE_DEFINITIONS.map((item) => item.value),
    [
      'input',
      'self_generation',
      'inventory_decrease',
      'adjustment_increase',
      'output',
      'useful_utilization',
      'known_loss',
      'inventory_increase',
      'adjustment_decrease'
    ]
  );
  assert.equal(BALANCE_ROLE_DEFINITIONS.length, 9);
  BALANCE_ROLE_DEFINITIONS.forEach((item) => {
    assert.ok(item.label.length >= 2, `${item.value} 应有中文标签。`);
    assert.ok(['input', 'output'].includes(item.side));
  });
}

/** 验证快照只按运行编号建组，同一 digest 的不同运行绝不混合。 */
function testCalculationRunGroupingPreventsDigestMerge() {
  const grouped = groupSnapshotsByCalculationRun([
    { id: 4, calculationRunId: 'run-b', sourceDataDigest: 'same-digest', createdAt: '2026-05-02T00:00:00Z' },
    { id: 1, calculationRunId: 'run-a', sourceDataDigest: 'same-digest', createdAt: '2026-05-01T00:00:00Z' },
    { id: 2, calculationRunId: 'run-a', sourceDataDigest: 'same-digest', createdAt: '2026-05-01T00:00:01Z' }
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].calculationRunId, 'run-b');
  assert.deepEqual(grouped.find((item) => item.calculationRunId === 'run-a').snapshots.map((item) => item.id), [1, 2]);
  assert.match(utilitySource, /runMap\.has\(calculationRunId\)/);
  assert.doesNotMatch(utilitySource, /runMap\.has\(snapshot\?\.sourceDataDigest\)/);
}

/** 验证同一运行中出现不同内容指纹时只告警、不另改分组语义。 */
function testDigestIntegrityWarning() {
  const [run] = groupSnapshotsByCalculationRun([
    { id: 1, calculationRunId: 'run-a', sourceDataDigest: 'digest-a' },
    { id: 2, calculationRunId: 'run-a', sourceDataDigest: 'digest-b' }
  ]);
  assert.equal(run.calculationRunId, 'run-a');
  assert.equal(run.snapshots.length, 2);
  assert.equal(run.digestIntegrityWarning, true);
}

/** 验证来源时区下完整自然月换算为 UTC 左闭右开窗口。 */
function testFullNaturalMonthWindow() {
  const shanghaiWindow = buildFullMonthCalculationWindow(['2026-01', '2026-03'], 'Asia/Shanghai');
  assert.deepEqual(shanghaiWindow, {
    valid: true,
    startUtc: '2025-12-31T16:00:00.000Z',
    endUtc: '2026-03-31T16:00:00.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    intervalBoundary: '[startUtc,endUtc)',
    startMonth: '2026-01',
    endMonth: '2026-03'
  });
  assert.equal(isFullNaturalMonthWindow(shanghaiWindow.startUtc, shanghaiWindow.endUtc, 'Asia/Shanghai'), true);

  const daylightSavingWindow = buildFullMonthCalculationWindow(['2026-03', '2026-03'], 'America/New_York');
  assert.equal(daylightSavingWindow.startUtc, '2026-03-01T05:00:00.000Z');
  assert.equal(daylightSavingWindow.endUtc, '2026-04-01T04:00:00.000Z');
  assert.equal(isFullNaturalMonthWindow(daylightSavingWindow.startUtc, daylightSavingWindow.endUtc, 'America/New_York'), true);
  assert.equal(isFullNaturalMonthWindow('2026-03-02T05:00:00.000Z', daylightSavingWindow.endUtc, 'America/New_York'), false);
}

/** 验证边界回显与保存兜底规范零毫秒，并拒绝隐藏提交非零毫秒。 */
function testBoundaryStrictUtcNormalization() {
  const normalized = normalizeEnergyBalanceBoundaryUtcFields({
    effectiveStartUtc: '2026-01-01T00:00:00.000Z',
    effectiveEndUtc: '2027-01-01T00:00:00.000Z',
    sourceTimeZone: 'Asia/Shanghai'
  });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.value.effectiveStartUtc, '2026-01-01T00:00:00Z');
  assert.equal(normalized.value.effectiveEndUtc, '2027-01-01T00:00:00Z');
  assert.equal(normalized.value.sourceTimeZone, 'Asia/Shanghai');

  const rejected = normalizeEnergyBalanceBoundaryUtcFields({
    effectiveStartUtc: '2026-01-01T00:00:00.001Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z'
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.value.effectiveStartUtc, '');
  assert.equal(rejected.value.effectiveEndUtc, '2027-01-01T00:00:00Z');
  assert.match(rejected.message, /边界有效期开始 UTC.*非零毫秒不能被截断.*原值：2026-01-01T00:00:00\.001Z/);
}

/** 验证非完整自然月错误给出可执行修正建议。 */
function testFullMonthCorrectionMessage() {
  const message = formatEnergyBalanceRequestError({
    apiError: {
      code: 'BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH',
      message: '月度来源统计期不是完整自然月。',
      details: { sourceTimeZone: 'Asia/Shanghai' }
    }
  });
  assert.match(message, /修正建议/);
  assert.match(message, /完整自然月/);
  assert.match(message, /Asia\/Shanghai 月初 00:00/);
  assert.match(message, /左闭右开区间/);
}

/** 验证页面级权限、体积、维护态、质量冻结与审计错误提供统一反馈。 */
function testWriteFailureMessages() {
  assert.match(formatEnergyBalanceRequestError({ response: { status: 401, data: { error: {} } } }), /重新登录/);
  assert.match(formatEnergyBalanceRequestError({ response: { status: 403, data: { error: {} } } }), /权限不足/);
  assert.match(formatEnergyBalanceRequestError({ response: { status: 413, data: { error: {} } } }), /超过服务端限制/);
  assert.match(formatEnergyBalanceRequestError({ response: { status: 423, data: { error: { message: '系统维护中。' } } } }), /只读查询仍可使用/);
  assert.match(formatEnergyBalanceRequestError({ apiError: { code: 'MAINTENANCE_IN_PROGRESS', message: '系统维护中。' } }), /只读查询仍可使用/);
  assert.match(formatEnergyBalanceRequestError({ apiError: { code: 'BAD_REQUEST', message: '覆盖不足。', details: { code: 'COVERAGE_BELOW_THRESHOLD' } } }), /补齐统计期来源记录/);
  assert.match(formatEnergyBalanceRequestError({ apiError: { code: 'BAD_REQUEST', message: '无法计算。', details: { code: 'MISSING_CONVERSION_FACTOR' } } }), /保持不可计算或冻结/);
  assert.match(formatEnergyBalanceRequestError({ apiError: { code: 'ENERGY_BALANCE_OPERATION_FAILED', message: '写入失败。' } }), /事务已回滚/);
  assert.match(formatEnergyBalanceRequestError({ apiError: { code: 'ENERGY_BALANCE_AUDIT_ACTOR_REQUIRED', message: '缺少审计操作者。' } }), /审计记录未完成/);
}

/** 验证计算抽屉按分页契约读取 200 条以上全部启用项目。 */
async function testLoadAllActiveItemsBeyondTwoHundred() {
  const allItems = Array.from({ length: 205 }, (_value, index) => ({ id: index + 1 }));
  const requestedPages = [];
  const loaded = await loadAllEnergyBalanceItems(async ({ page, pageSize }) => {
    requestedPages.push({ page, pageSize });
    const start = (page - 1) * pageSize;
    return {
      data: allItems.slice(start, start + pageSize),
      meta: { pagination: { page, pageSize, total: allItems.length, totalPages: 2 } }
    };
  });
  assert.equal(loaded.length, 205);
  assert.deepEqual(loaded.map((item) => item.id), allItems.map((item) => item.id));
  assert.deepEqual(requestedPages, [{ page: 1, pageSize: 200 }, { page: 2, pageSize: 200 }]);
}

/** 验证旧异步响应会被最后请求守卫丢弃，且请求输入已冻结。 */
function testLatestRequestGuardDropsStaleResponse() {
  const guard = createLatestEnergyBalanceRequestGuard();
  const first = guard.begin({ boundaryId: 1, explicitValues: { 9: 10 } });
  const second = guard.begin({ boundaryId: 2, explicitValues: { 9: 20 } });
  assert.equal(guard.isLatest(first), false);
  assert.equal(guard.isLatest(second), true);
  assert.equal(Object.isFrozen(second.snapshot), true);
  assert.equal(Object.isFrozen(second.snapshot.explicitValues), true);
  assert.throws(() => { second.snapshot.explicitValues[9] = 99; }, TypeError);
  assert.equal(second.snapshot.explicitValues[9], 20);
}

/** 验证真实零严格零宽，整行交互命中不依赖最小可见条。 */
function testZeroBarHasStrictZeroWidth() {
  assert.equal(calculateBalanceBarWidth(0, 100), 0);
  assert.equal(calculateBalanceBarWidth(null, 100), 0);
  assert.equal(calculateBalanceBarWidth(50, 100), 24);
  assert.equal(calculateBalanceBarWidth(200, 100), 48);
  assert.doesNotMatch(chartSource, /Math\.max\(2/);
  assert.match(chartSource, /v-if="hasVisibleBar\(row\)"/);
  assert.match(chartSource, /v-else-if="!row\.available" class="unavailable-mark"/);
  assert.match(chartSource, /return row\.available && barWidth\(row\) > 0/);
  assert.doesNotMatch(chartSource, /v-if="row\.available"\s+class="bar-mark"/);
  assert.match(chartSource, /整行按钮独立承担交互命中/);
}

/** 验证原单位与折标不可计算不会被伪装为零。 */
function testOriginalAndConvertedChartRows() {
  const balance = {
    originalUnit: 'kWh',
    inputTotalOriginal: 120,
    outputTotalOriginal: 100,
    storageChangeOriginal: 5,
    unexplainedOriginal: 15,
    inputTotalKgce: null,
    outputTotalKgce: null,
    storageChangeKgce: null,
    unexplainedKgce: null
  };
  const originalRows = buildBalanceChartRows(balance, 'original');
  const kgceRows = buildBalanceChartRows(balance, 'kgce');
  assert.deepEqual(originalRows.map((row) => row.value), [120, 100, 5, 15]);
  assert.ok(originalRows.every((row) => row.unit === 'kWh' && row.available));
  assert.ok(kgceRows.every((row) => row.unit === 'kgce' && row.value === null && !row.available));
  assert.equal(originalRows.find((row) => row.key === 'input').side, 'left');
  assert.equal(originalRows.find((row) => row.key === 'difference').side, 'left');
}

/** 验证建议人工状态机和拒绝、解决备注要求。 */
function testSuggestionReviewFlow() {
  assert.deepEqual(suggestionReviewTargets('unconfirmed'), ['accepted', 'rejected']);
  assert.deepEqual(suggestionReviewTargets('accepted'), ['rejected', 'resolved']);
  assert.deepEqual(suggestionReviewTargets('rejected'), []);
  assert.deepEqual(suggestionReviewTargets('resolved'), []);
  assert.equal(validateSuggestionReview('unconfirmed', 'resolved', '跳过接受').valid, false);
  assert.equal(validateSuggestionReview('unconfirmed', 'rejected', '').valid, false);
  assert.equal(validateSuggestionReview('accepted', 'resolved', '现场复核完成').valid, true);
  assert.deepEqual(validateSuggestionReview('unconfirmed', 'accepted', ''), {
    valid: true,
    payload: { manualStatus: 'accepted', reviewNote: null }
  });
}

/** 验证发电字段、角色和防重复键按显式映射进入载荷。 */
function testGenerationMappingPayload() {
  const selfUsePayload = buildBalanceItemPayload({
    itemCode: 'SELF_USE', itemName: '光伏自用', role: 'self_generation', energyTypeId: 2,
    originalUnit: 'kWh', sourceType: 'generation', sourceMappingReference: '发电记录',
    sourceRecordIds: '8, 9, 9', generationAntiDoubleCountKey: 'pv-self-use'
  });
  assert.deepEqual(selfUsePayload.sourceMapping.recordIds, [8, 9]);
  assert.equal(selfUsePayload.sourceMapping.valueField, 'self_use_value_kwh');
  assert.equal(selfUsePayload.generationAntiDoubleCountKey, 'pv-self-use');

  const exportPayload = buildBalanceItemPayload({
    itemCode: 'EXPORT', itemName: '上网电量', role: 'output', energyTypeId: 2,
    originalUnit: 'kWh', sourceType: 'generation', sourceMappingReference: '发电记录',
    sourceRecordIds: '10', generationAntiDoubleCountKey: 'pv-export'
  });
  assert.equal(exportPayload.sourceMapping.valueField, 'grid_export_value_kwh');
}

/** 验证原因码和查询参数不会丢失业务语义。 */
function testLabelsAndFilterContracts() {
  assert.equal(balanceReasonLabel('MISSING_CONVERSION_FACTOR'), '缺少统计期内有效的 kgce 折标系数');
  assert.equal(balanceReasonLabel('UNKNOWN_REASON'), 'UNKNOWN_REASON');
  assert.deepEqual(buildSnapshotFilters({ boundaryId: 7, calculationRunId: 'run-1', sourceDataDigest: 'digest-1', confirmationStatus: '' }, { page: 2, pageSize: 100 }), {
    boundaryId: 7, calculationRunId: 'run-1', sourceDataDigest: 'digest-1', page: 2, pageSize: 100
  });
  assert.deepEqual(buildSuggestionFilters({ boundaryId: 7, calculationRunId: 'run-1', manualStatus: 'accepted', priority: 'high' }, { page: 1, pageSize: 20 }), {
    boundaryId: 7, calculationRunId: 'run-1', manualStatus: 'accepted', priority: 'high', page: 1, pageSize: 20
  });
}

/** 验证四类前端可见性权限编码完整。 */
function testPermissionContracts() {
  assert.deepEqual(ENERGY_BALANCE_PERMISSIONS, {
    view: 'energy:balance:view',
    manage: 'energy:balance:manage',
    calculate: 'energy:balance:calculate',
    suggestionReview: 'energy:balance:suggestion:review',
    importPreview: 'energy:balance:import:preview',
    importExecute: 'energy:balance:import:execute'
  });
  Object.values(ENERGY_BALANCE_PERMISSIONS).forEach((permission) => assert.match(utilitySource, new RegExp(permission.replaceAll(':', '\\:'))));
}

/** 验证 API 封装覆盖真实路由、方法和参数透传。 */
function testApiStaticContract() {
  assert.match(apiSource, /const BASE_URL = '\/energy-balances'/);
  assert.match(apiSource, /getEnergyBalanceBoundaries = \(params = \{\}\) => get\(`\$\{BASE_URL\}\/boundaries`, params\)/);
  assert.match(apiSource, /method: 'post'.+boundaries`/);
  assert.match(apiSource, /method: 'put'.+boundaries\/\$\{boundaryId\}`/);
  assert.match(apiSource, /method: 'patch'.+\/status`/);
  assert.match(apiSource, /snapshots\/calculate/);
  assert.match(apiSource, /getEnergyBalanceSnapshots = \(params = \{\}\)/);
  assert.match(apiSource, /getEnergyBalanceSnapshotRuns = \(params = \{\}\).+view: 'runs'/);
  assert.match(apiSource, /snapshots\/runs\/\$\{encodeURIComponent\(calculationRunId\)\}/);
  assert.match(apiSource, /getEnergyBalanceSuggestions = \(params = \{\}\)/);
  assert.match(apiSource, /updateEnergyBalanceSuggestionStatus/);
  assert.match(apiSource, /data: payload/);
}

/** 验证页面静态契约、单轴图和等价表格共用同一 rows 数据源。 */
function testPageAndChartStaticContract() {
  assert.match(pageSource, /energy\/balances\/index/);
  assert.match(pageSource, /sourceDataDigest 只是内容指纹/);
  assert.match(pageSource, /严格按 calculationRunId/);
  assert.match(pageSource, /当前查询共.+次计算运行/);
  assert.match(pageSource, /getEnergyBalanceSnapshotRuns/);
  assert.match(pageSource, /getEnergyBalanceSnapshotRun/);
  assert.match(pageSource, /openSnapshotRunDetail/);
  assert.doesNotMatch(pageSource, /row\.snapshots\[0\]/);
  assert.match(pageSource, /representativeSnapshotId/);
  assert.match(pageSource, /loadAllEnergyBalanceItems/);
  assert.match(pageSource, /createLatestEnergyBalanceRequestGuard/);
  assert.match(pageSource, /boundaryDetailError/);
  assert.match(pageSource, /reloadBoundaryDetail/);
  assert.match(pageSource, /calculationResultSnapshot/);
  assert.match(pageSource, /effectiveStartUtc: '', effectiveEndUtc: '', sourceTimeZone: ''/);
  assert.doesNotMatch(pageSource, /effectiveStartUtc: '2026-01-01T00:00:00Z'/);
  assert.doesNotMatch(pageSource, /effectiveEndUtc: '2027-01-01T00:00:00Z'/);
  assert.match(pageSource, /import StrictUtcDateTimeInput from '@\/components\/StrictUtcDateTimeInput\.vue';/);
  assert.equal((pageSource.match(/<StrictUtcDateTimeInput\b/g) || []).length, 2, '边界有效期起止必须共使用两个共享严格 UTC 组件。');
  assert.match(pageSource, /<StrictUtcDateTimeInput v-model="boundaryForm\.effectiveStartUtc"/);
  assert.match(pageSource, /<StrictUtcDateTimeInput v-model="boundaryForm\.effectiveEndUtc"/);
  assert.doesNotMatch(pageSource, /<el-input v-model\.trim="boundaryForm\.(?:effectiveStartUtc|effectiveEndUtc)"/);
  assert.match(pageSource, /effectiveStartUtc: \[\{ required: true,[^\n]+trigger: \['change', 'blur'\] \}, strictBoundaryUtcRule\('边界有效期开始 UTC'\)\]/);
  assert.match(pageSource, /effectiveEndUtc: \[\{ required: true,[^\n]+trigger: \['change', 'blur'\] \}, strictBoundaryUtcRule\('边界有效期结束 UTC'\)\]/);
  assert.match(pageSource, /import \{ parseStrictUtcDateTime \} from '@\/utils\/dateTimeFields';/);
  assert.match(pageSource, /import \{ isIanaTimeZone \} from '@\/utils\/ianaTimeZones';/);
  assert.match(pageSource, /const boundaryIanaTimeZoneRule = \{[\s\S]*?isIanaTimeZone\(String\(value \|\| ''\)\.trim\(\)\)[\s\S]*?trigger: \['change', 'blur'\]/);
  assert.doesNotMatch(pageSource, /sourceTimeZone: \[\{ required: true, pattern:/, '边界时区不得只用正则形态校验。');
  assert.match(pageSource, /if \(!isIanaTimeZone\(utcNormalization\.value\.sourceTimeZone\)\) \{ boundaryFormError\.value = '请选择当前运行时可识别的 IANA 来源时区。'; return; \}[\s\S]*?createEnergyBalanceBoundary\(payload\)/, '边界保存必须在创建 API 前执行运行时 IANA 校验。');
  assert.match(pageSource, /const normalization = normalizeEnergyBalanceBoundaryUtcFields\(\{/);
  assert.match(pageSource, /const utcNormalization = normalizeEnergyBalanceBoundaryUtcFields\(boundaryForm\.value\);[\s\S]*?if \(!utcNormalization\.valid\) \{ boundaryFormError\.value = boundaryUtcDiagnostic\.value \|\| utcNormalization\.message; return; \}/);
  assert(pageSource.includes("const boundaryUtcDiagnostic = ref('')") && pageSource.includes('boundaryUtcDiagnostic.value = normalization.message'), '边界非法原值只能保留在诊断状态。');
  assert(pageSource.includes('boundaryForm.value = normalization.value') && pageSource.includes('boundaryFormError.value = boundaryUtcDiagnostic.value'), '边界编辑必须清空不可见非法字段，同时明确展示原始诊断。');
  assert.match(pageSource, /<el-date-picker(?=[^>]*v-model="calculationForm\.monthRange")(?=[^>]*type="monthrange")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>/);
  assert.match(pageSource, /import IanaTimeZoneSelect from '@\/components\/IanaTimeZoneSelect\.vue';/);
  assert.equal((pageSource.match(/<IanaTimeZoneSelect\b/g) || []).length, 1, '边界可编辑来源时区必须使用共享选择组件。');
  assert.match(pageSource, /<IanaTimeZoneSelect v-model="boundaryForm\.sourceTimeZone" placeholder="请选择或搜索来源时区"/);
  assert.doesNotMatch(pageSource, /<el-input[^>]+v-model(?:\.trim)?="boundaryForm\.sourceTimeZone"/);
  assert.match(pageSource, /Date\.parse\(boundaryForm\.value\.effectiveStartUtc\) >= Date\.parse\(boundaryForm\.value\.effectiveEndUtc\)/);
  assert.match(pageSource, /buildFullMonthCalculationWindow/);
  assert.match(pageSource, /BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH|formatEnergyBalanceRequestError/);
  assert.match(pageSource, /self_use_value_kwh/);
  assert.match(pageSource, /grid_export_value_kwh/);
  assert.match(pageSource, /generationAntiDoubleCountKey/);
  assert.match(pageSource, /未生成（无充分证据不估算）/);
  assert.match(pageSource, /canReviewSuggestions/);
  assert.match(chartSource, /v-for="row in rows"/);
  assert.match(chartSource, /<el-table :data="rows"/);
  assert.match(chartSource, /全部条形共用一条数值轴/);
  assert.doesNotMatch(chartSource, /dual[- ]?axis|双轴/i);
  assert.match(chartSource, /aria-label/);
  assert.match(chartSource, /不可计算/);
}

/** 顺序执行全部纯逻辑与静态契约检查。 */
const tests = [
  testNineRoleLabels,
  testCalculationRunGroupingPreventsDigestMerge,
  testDigestIntegrityWarning,
  testFullNaturalMonthWindow,
  testBoundaryStrictUtcNormalization,
  testFullMonthCorrectionMessage,
  testWriteFailureMessages,
  testLoadAllActiveItemsBeyondTwoHundred,
  testLatestRequestGuardDropsStaleResponse,
  testZeroBarHasStrictZeroWidth,
  testOriginalAndConvertedChartRows,
  testSuggestionReviewFlow,
  testGenerationMappingPayload,
  testLabelsAndFilterContracts,
  testPermissionContracts,
  testApiStaticContract,
  testPageAndChartStaticContract
];

for (const test of tests) await test();
console.log(`energyBalanceManagement tests passed: ${tests.length}`);
