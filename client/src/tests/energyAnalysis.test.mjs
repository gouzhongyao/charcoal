import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ENERGY_ANALYSIS_CONFIGURATION_CONTRACT,
  ENERGY_ANALYSIS_IMPORT_TYPES,
  ENERGY_ANALYSIS_PERMISSIONS,
  ENERGY_ANALYSIS_TOU_PRESENTATION,
  STRATEGY_STATUS_LABELS,
  allowedStrategyStatuses,
  buildEnergyAnalysisConfigPayload,
  buildImportExecutePayload,
  buildLoadCurvePoints,
  buildLoadCurveSegments,
  buildLoadSummaryParams,
  buildMonthlyAnalysisParams,
  buildStrategyParams,
  buildTimeseriesAnalysisParams,
  canExecuteEnergyAnalysisImport,
  commitEnergyAnalysisStrategyResult,
  completeEnergyAnalysisResultTransition,
  createDefaultEnergyAnalysisFilters,
  createEmptyEnergyAnalysisResult,
  createEnergyAnalysisConfigForm,
  createEnergyAnalysisSnapshot,
  createLatestEnergyAnalysisRequestGate,
  energyAnalysisBarPercentage,
  energyAnalysisErrorText,
  formatAnalysisValue,
  monthlyComparisonText,
  normalizeLoadCurveRows,
  qualityStatusText,
  reasonCodeLabel,
  reasonCodesText,
  replaceEnergyAnalysisStrategyHit,
  startEnergyAnalysisResultTransition,
  validateEnergyAnalysisEvidenceRequirements,
  validateEnergyAnalysisTouPeriodRules,
  validateStrategyReview
} from '../utils/energyAnalysis.js';

// 筛选参数必须使用后端冻结字段，空值不得发送。
const filters = {
  meterDeviceId: 12,
  energyTypeCode: 'electricity',
  unit: 'kWh',
  startUtc: '2026-08-01T00:00',
  endUtc: '2026-08-02T00:00',
  sourceTimeZone: 'Asia/Shanghai',
  minimumCoverageRate: 0.85,
  outputIntervalMinutes: 60,
  organizationUnitId: 9,
  productionUnitId: '',
  startMonth: '2026-01',
  endMonth: '2026-06'
};
assert.deepEqual(buildTimeseriesAnalysisParams(filters), {
  meterDeviceId: 12,
  energyTypeCode: 'electricity',
  unit: 'kWh',
  startUtc: '2026-07-31T16:00:00.000Z',
  endUtc: '2026-08-01T16:00:00.000Z',
  sourceTimeZone: 'Asia/Shanghai'
});
assert.deepEqual(buildLoadSummaryParams(filters), { ...buildTimeseriesAnalysisParams(filters), minimumCoverageRate: 0.85 });
assert.deepEqual(buildMonthlyAnalysisParams(filters), {
  startMonth: '2026-01',
  endMonth: '2026-06',
  organizationUnitId: 9,
  includeDescendants: false,
  energyTypeCode: 'electricity',
  unit: 'kWh',
  topN: 10
});
assert.deepEqual(buildStrategyParams(filters, ['R-2', 'R-2', 'R-1']).ruleCodes, ['R-2', 'R-1']);
assert.equal(createDefaultEnergyAnalysisFilters(new Date('2026-01-15T00:00:00.000Z')).startMonth, '2025-08');

// 状态文案必须严格区分缺失、真实零值、覆盖不足和不可计算。
assert.equal(formatAnalysisValue(null), '缺失');
assert.equal(formatAnalysisValue(0, { unit: 'kWh' }), '0 kWh');
assert.equal(formatAnalysisValue(3, { calculable: false }), '不可计算');
assert.match(qualityStatusText({ status: 'insufficient', coverageRate: 0.42 }), /覆盖不足/);
assert.match(qualityStatusText({ status: 'overlap_or_duplicate', coverageRate: 1 }), /来源存在重叠或重复/);
assert.match(qualityStatusText({ status: 'mixed_interval_granularity' }), /时序粒度混合/);
assert.match(qualityStatusText({ status: 'unit_not_comparable' }), /单位不可比/);
assert.match(qualityStatusText({ status: 'missing_shift_schedule', coverageRate: 0.5 }), /排班记录存在缺口/);
assert.equal(monthlyComparisonText({ status: 'base_missing' }), '基期缺失');
assert.equal(monthlyComparisonText({ status: 'base_zero' }), '基期为真实零值，不可计算');
assert.equal(reasonCodeLabel('UNIT_NOT_COMPARABLE'), '单位不可比或指标单位不可用');
assert.equal(reasonCodeLabel('MIXED_INTERVAL_GRANULARITY'), '时序记录粒度混合，当前结果不可直接计算');
assert.equal(reasonCodeLabel('SOURCE_OVERLAP_OR_DUPLICATE'), '时序来源存在重叠或重复记录');
assert.equal(reasonCodeLabel('MISSING_SHIFT_SCHEDULE'), '排班记录存在缺口');
assert.equal(reasonCodeLabel('MISSING_PRODUCTION_OUTPUT'), '缺少产量分母');
assert.equal(reasonCodeLabel('CUSTOM_BACKEND_REASON'), '后端原因码：CUSTOM_BACKEND_REASON');
assert.match(reasonCodesText(['NO_TIMESERIES_DATA', 'DEVICE_STATE_GAP']), /缺少时序能耗数据.*设备状态存在缺口/);
assert.equal(energyAnalysisErrorText({ response: { status: 401, data: { error: {} } } }), '登录状态已失效，请重新登录后再试。');
assert.equal(energyAnalysisErrorText({ response: { status: 403, data: { error: {} } } }), '权限不足：当前账号没有执行该操作的权限。');
assert.equal(energyAnalysisErrorText({ response: { status: 403, data: { error: {} } } }, '失败', { suppressGlobalHandledStatus: true }), '');
assert.equal(energyAnalysisErrorText({ response: { status: 423, data: { error: { code: 'MAINTENANCE_IN_PROGRESS' } } } }), '系统处于维护态，当前写操作已阻止');
assert.equal(energyAnalysisErrorText({ response: { status: 413, data: { error: { code: 'IMPORT_FILE_TOO_LARGE' } } } }), '上传文件超过服务端大小限制');
assert.equal(energyAnalysisErrorText({ response: { status: 400, data: { error: { code: 'IMPORT_FILE_TOO_LARGE', message: '上传文件超过服务端大小限制' } } } }), '上传文件超过服务端大小限制');
assert.equal(energyAnalysisErrorText({ response: { status: 413, data: { error: { code: 'ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE' } } } }), '执行确认正文超过 2MB 限制');
assert.equal(energyAnalysisErrorText({ response: { status: 400, data: { error: { code: 'BAD_REQUEST', message: '无法计算', details: { reasonCodes: ['SOURCE_OVERLAP_OR_DUPLICATE'] } } } } }), '时序来源存在重叠或重复记录');
assert.match(energyAnalysisErrorText({ response: { status: 400, data: { error: { code: 'BAD_REQUEST', message: '无法计算', details: { reasonCodes: ['NO_TIMESERIES_DATA'] } } } } }), /缺少时序能耗数据/);

// 最新请求门和冻结快照必须保证旧响应无法提交，新输入不会污染在途请求。
const requestGate = createLatestEnergyAnalysisRequestGate();
const mutableRequestInput = { filters: { meterDeviceId: 1 }, ruleCodes: ['R-1'] };
const firstRun = requestGate.start(mutableRequestInput);
mutableRequestInput.filters.meterDeviceId = 2;
mutableRequestInput.ruleCodes.push('R-2');
const secondRun = requestGate.start(mutableRequestInput);
assert.equal(firstRun.inputSnapshot.filters.meterDeviceId, 1);
assert.deepEqual(firstRun.inputSnapshot.ruleCodes, ['R-1']);
assert.equal(Object.isFrozen(firstRun.inputSnapshot.filters), true);
assert.equal(requestGate.isLatest(firstRun), false);
assert.equal(requestGate.isLatest(secondRun), true);
requestGate.invalidate();
assert.equal(requestGate.isLatest(secondRun), false);
assert.equal(Object.isFrozen(createEnergyAnalysisSnapshot({ nested: { value: 1 } }).nested), true);

// 两个异步请求逆序返回时，只允许后发请求提交结果。
const raceGate = createLatestEnergyAnalysisRequestGate();
let resolveOlderResponse;
let resolveLatestResponse;
let committedRaceValue = '';
const olderResponse = new Promise((resolve) => { resolveOlderResponse = resolve; });
const latestResponse = new Promise((resolve) => { resolveLatestResponse = resolve; });
const olderRaceRun = raceGate.start({ value: '旧' });
const olderTask = olderResponse.then((value) => { if (raceGate.isLatest(olderRaceRun)) committedRaceValue = value; });
const latestRaceRun = raceGate.start({ value: '新' });
const latestTask = latestResponse.then((value) => { if (raceGate.isLatest(latestRaceRun)) committedRaceValue = value; });
resolveLatestResponse('新响应');
await latestTask;
resolveOlderResponse('旧响应');
await olderTask;
assert.equal(committedRaceValue, '新响应');

// 分析刷新必须继续用旧结果自己的输入快照解释，直到新结果与新输入原子提交。
const oldAnalysisRun = { requestId: 1, inputSnapshot: createEnergyAnalysisSnapshot({ unit: 'kWh', meterDeviceId: 1 }) };
let analysisTransition = startEnergyAnalysisResultTransition(null, oldAnalysisRun);
analysisTransition = completeEnergyAnalysisResultTransition(analysisTransition, oldAnalysisRun, {
  ...createEmptyEnergyAnalysisResult(),
  loadSummary: { metrics: { totalEnergy: 10, energyUnit: 'kWh' }, quality: { status: 'sufficient' } }
});
const oldDisplaySnapshot = analysisTransition.displaySnapshot;
const newAnalysisRun = { requestId: 2, inputSnapshot: createEnergyAnalysisSnapshot({ unit: 'MWh', meterDeviceId: 2 }) };
analysisTransition = startEnergyAnalysisResultTransition(oldDisplaySnapshot, newAnalysisRun);
assert.equal(analysisTransition.displaySnapshot.inputSnapshot.unit, 'kWh');
assert.equal(analysisTransition.displaySnapshot.resultSnapshot.loadSummary.metrics.totalEnergy, 10);
assert.equal(analysisTransition.pendingSnapshot.inputSnapshot.unit, 'MWh');
analysisTransition = completeEnergyAnalysisResultTransition(analysisTransition, newAnalysisRun, {
  ...createEmptyEnergyAnalysisResult(),
  loadSummary: { metrics: { totalEnergy: 20, energyUnit: 'MWh' }, quality: { status: 'sufficient' } }
});
assert.equal(analysisTransition.displaySnapshot.inputSnapshot.unit, 'MWh');
assert.equal(analysisTransition.displaySnapshot.resultSnapshot.loadSummary.metrics.totalEnergy, 20);

// 策略只允许一个展示快照；正式运行后再预演不得保留旧命中。
const strategyRunRequest = { requestId: 1, inputSnapshot: createEnergyAnalysisSnapshot({ filters: { meterDeviceId: 1 }, ruleCodes: ['R-1'] }) };
let singleStrategySnapshot = commitEnergyAnalysisStrategyResult(null, strategyRunRequest, 'run', { hits: [{ id: 7, manualStatus: 'unconfirmed' }] });
const formalStrategySnapshot = singleStrategySnapshot;
assert.equal(singleStrategySnapshot.kind, 'run');
assert.equal(singleStrategySnapshot.resultSnapshot.hits.length, 1);
const strategyEvaluateRequest = { requestId: 2, inputSnapshot: createEnergyAnalysisSnapshot({ filters: { meterDeviceId: 2 }, ruleCodes: ['R-2'] }) };
singleStrategySnapshot = commitEnergyAnalysisStrategyResult(singleStrategySnapshot, strategyEvaluateRequest, 'evaluate', { evaluations: [{ ruleCode: 'R-2' }] });
assert.equal(singleStrategySnapshot.kind, 'evaluate');
assert.equal(singleStrategySnapshot.resultSnapshot.hits, undefined);
assert.equal(singleStrategySnapshot.resultSnapshot.evaluations.length, 1);
assert.equal(singleStrategySnapshot.inputSnapshot.filters.meterDeviceId, 2);
const reviewedStrategySnapshot = replaceEnergyAnalysisStrategyHit(formalStrategySnapshot, { id: 7, manualStatus: 'accepted' });
assert.equal(reviewedStrategySnapshot.resultSnapshot.hits[0].manualStatus, 'accepted');
assert.equal(Object.isFrozen(reviewedStrategySnapshot.resultSnapshot.hits), true);

// 图表点和等价表格必须共享同一标准化行，并让缺失值形成断线、零值保留为点。
const curveRows = normalizeLoadCurveRows([
  { startUtc: 'A', endUtc: 'B', energy: 5, energyUnit: 'kWh', observationMode: 'observed' },
  { startUtc: 'B', endUtc: 'C', energy: null, energyUnit: 'kWh', observationMode: 'missing' },
  { startUtc: 'C', endUtc: 'D', energy: 0, energyUnit: 'kWh', observationMode: 'observed' }
]);
assert.deepEqual(curveRows.map((row) => row.energy), [5, null, 0]);
const curvePoints = buildLoadCurvePoints(curveRows);
assert.equal(curvePoints[1].y, null);
assert.equal(Number.isFinite(curvePoints[2].y), true);
assert.equal(buildLoadCurveSegments(curvePoints).length, 2);
assert.deepEqual(curvePoints.map((point) => point.energy), curveRows.map((row) => row.energy));
assert.equal(energyAnalysisBarPercentage(0, 100), 0);
assert.equal(energyAnalysisBarPercentage(null, 100), 0);
assert.equal(energyAnalysisBarPercentage(25, 100), 25);
assert.equal(ENERGY_ANALYSIS_TOU_PRESENTATION.peak.color, '#2a78d6');
assert.equal(ENERGY_ANALYSIS_TOU_PRESENTATION.flat.color, '#eb6834');
assert.equal(ENERGY_ANALYSIS_TOU_PRESENTATION.valley.color, '#1baf7a');
assert.equal([ENERGY_ANALYSIS_TOU_PRESENTATION.valley, ENERGY_ANALYSIS_TOU_PRESENTATION.peak].map((item) => item.color).join(','), '#1baf7a,#2a78d6');

// 权限映射必须使用冻结的细分权限，而不是宽泛兼容权限。
assert.deepEqual(ENERGY_ANALYSIS_PERMISSIONS, {
  view: 'energy:analysis:view',
  strategyEvaluate: 'energy:strategy:evaluate',
  strategyRun: 'energy:strategy:run',
  strategyReview: 'energy:strategy:review',
  configView: 'energy:analysis:config:view',
  shiftManage: 'energy:analysis:shift:manage',
  touManage: 'energy:analysis:tou:manage',
  strategyRuleManage: 'energy:strategy:rule:manage',
  timeseriesPreview: 'energy:analysis:timeseries:preview',
  timeseriesExecute: 'energy:analysis:timeseries:execute',
  operationsPreview: 'energy:analysis:operations:preview',
  operationsExecute: 'energy:analysis:operations:execute'
});
assert.equal(ENERGY_ANALYSIS_IMPORT_TYPES.timeseries.previewPermission, 'energy:analysis:timeseries:preview');
assert.equal(ENERGY_ANALYSIS_IMPORT_TYPES.shifts.executePermission, 'energy:analysis:operations:execute');

// 策略状态必须遵守后端单向流转，拒绝和解决必须备注。
assert.deepEqual(allowedStrategyStatuses('unconfirmed'), ['accepted', 'rejected']);
assert.deepEqual(allowedStrategyStatuses('accepted'), ['rejected', 'resolved']);
assert.deepEqual(allowedStrategyStatuses('rejected'), []);
assert.equal(validateStrategyReview('unconfirmed', 'accepted', '').valid, true);
assert.equal(validateStrategyReview('unconfirmed', 'resolved', '已处理').valid, false);
assert.equal(validateStrategyReview('accepted', 'resolved', '').valid, false);
assert.equal(validateStrategyReview('accepted', 'resolved', '设备由人工完成检修').valid, true);
assert.equal(STRATEGY_STATUS_LABELS.resolved, '已解决');

// 新配置不得携带未经确认的班次、TOU、阈值、有效期或启用状态默认事实。
const emptyShiftForm = createEnergyAnalysisConfigForm('shift');
const emptyTouForm = createEnergyAnalysisConfigForm('tou');
const emptyRuleForm = createEnergyAnalysisConfigForm('rule');
assert.equal(emptyShiftForm.startMinute, null);
assert.equal(emptyShiftForm.endMinute, null);
assert.equal(emptyShiftForm.crossesMidnight, null);
assert.equal(emptyShiftForm.effectiveStartUtc, '');
assert.equal(emptyShiftForm.status, '');
assert.equal(emptyTouForm.periodRulesText, '');
assert.equal(emptyRuleForm.thresholdOperator, '');
assert.equal(emptyRuleForm.thresholdValue, null);
assert.equal(emptyRuleForm.metricCode, '');
assert.throws(() => buildEnergyAnalysisConfigPayload('shift', emptyShiftForm, false), /请填写来源时区/);
const confirmedShiftPayload = buildEnergyAnalysisConfigPayload('shift', {
  ...emptyShiftForm,
  shiftCode: 'SHIFT-A',
  shiftName: 'A 班',
  startMinute: 480,
  endMinute: 960,
  crossesMidnight: false,
  version: 'v1',
  source: '排班制度',
  sourceTimeZone: 'Asia/Shanghai',
  effectiveStartUtc: '2026-08-01T00:00',
  effectiveEndUtc: '2026-12-31T23:59',
  status: 'inactive'
}, false);
assert.equal(confirmedShiftPayload.status, 'inactive');
assert.equal(confirmedShiftPayload.startMinute, 480);
assert.equal(confirmedShiftPayload.effectiveStartUtc, '2026-08-01T00:00:00.000Z');
assert.doesNotMatch(JSON.stringify(confirmedShiftPayload), /2099-12-31|页面维护/);
assert.throws(() => buildEnergyAnalysisConfigPayload('shift', { ...emptyShiftForm, ...confirmedShiftPayload, status: '' }, false), /请选择启用或停用状态/);
assert.throws(() => buildEnergyAnalysisConfigPayload('shift', { ...emptyShiftForm, ...confirmedShiftPayload, status: 'paused' }, false), /请选择启用或停用状态/);

// TOU 必须逐字段符合后端契约，并让一周七天分别无重叠、无缺口覆盖 0 至 1440。
const fullWeekTouRules = Array.from({ length: 7 }, (_, index) => ({
  dayOfWeek: index + 1,
  periodType: index % 3 === 0 ? 'peak' : index % 3 === 1 ? 'flat' : 'valley',
  startMinute: 0,
  endMinute: 1440
}));
assert.equal(validateEnergyAnalysisTouPeriodRules(fullWeekTouRules).length, 7);
assert.throws(() => validateEnergyAnalysisTouPeriodRules([{ ...fullWeekTouRules[0], dayOfWeek: 0 }, ...fullWeekTouRules.slice(1)]), /dayOfWeek/);
assert.throws(() => validateEnergyAnalysisTouPeriodRules([{ ...fullWeekTouRules[0], periodType: 'sharp' }, ...fullWeekTouRules.slice(1)]), /periodType/);
assert.throws(() => validateEnergyAnalysisTouPeriodRules([{ ...fullWeekTouRules[0], endMinute: 1441 }, ...fullWeekTouRules.slice(1)]), /endMinute/);
assert.throws(() => validateEnergyAnalysisTouPeriodRules([{ ...fullWeekTouRules[0], endMinute: 1200 }, ...fullWeekTouRules.slice(1)]), /覆盖至 1440/);
const confirmedTouPayload = buildEnergyAnalysisConfigPayload('tou', {
  ...emptyTouForm,
  schemeCode: 'TOU-A',
  schemeName: '完整峰平谷方案',
  version: 'v1',
  periodRulesText: JSON.stringify(fullWeekTouRules),
  source: '峰谷制度',
  sourceTimeZone: 'Asia/Shanghai',
  effectiveStartUtc: '2026-08-01T00:00',
  effectiveEndUtc: '2026-12-31T23:59',
  status: 'inactive'
}, false);
assert.equal(confirmedTouPayload.periodRules.length, 7);

// 策略规则固定公式、指标、运算符、优先级和证据字段必须与后端冻结契约一致。
assert.deepEqual(ENERGY_ANALYSIS_CONFIGURATION_CONTRACT.strategyFormulaVersions, ['load-analysis:v1']);
assert.deepEqual(validateEnergyAnalysisEvidenceRequirements({ minimumCoverageRate: 0.8, maxEvidenceItems: 20, savingBasis: 'window_total_energy' }), { minimumCoverageRate: 0.8, maxEvidenceItems: 20, savingBasis: 'window_total_energy' });
assert.throws(() => validateEnergyAnalysisEvidenceRequirements({ command: 'start' }), /不支持的字段/);
assert.throws(() => validateEnergyAnalysisEvidenceRequirements({ minimumCoverageRate: 1.1 }), /0 至 1/);
assert.throws(() => validateEnergyAnalysisEvidenceRequirements({ maxEvidenceItems: 101 }), /1 至 100/);
assert.throws(() => validateEnergyAnalysisEvidenceRequirements({ savingBasis: 'estimated_power' }), /window_total_energy/);
const confirmedRuleForm = {
  ...emptyRuleForm,
  ruleCode: 'RULE-A',
  ruleName: '负荷率规则',
  ruleVersion: 'v1',
  formulaVersion: 'load-analysis:v1',
  metricCode: 'load_rate',
  thresholdOperator: 'gte',
  thresholdValue: 80,
  thresholdUnit: '%',
  priority: 'high',
  evidenceRequirementsText: JSON.stringify({ minimumCoverageRate: 0.8, maxEvidenceItems: 20, savingBasis: null }),
  recommendationText: '请人工复核高负荷时段。',
  source: '内部能源制度',
  sourceTimeZone: 'Asia/Shanghai',
  effectiveStartUtc: '2026-08-01T00:00',
  effectiveEndUtc: '2026-12-31T23:59',
  status: 'inactive'
};
const confirmedRulePayload = buildEnergyAnalysisConfigPayload('rule', confirmedRuleForm, false);
assert.equal(confirmedRulePayload.formulaVersion, 'load-analysis:v1');
assert.equal(confirmedRulePayload.metricCode, 'load_rate');
assert.equal(confirmedRulePayload.priority, 'high');
assert.throws(() => buildEnergyAnalysisConfigPayload('rule', { ...confirmedRuleForm, formulaVersion: 'dynamic:v2' }, false), /公式版本只允许/);
assert.throws(() => buildEnergyAnalysisConfigPayload('rule', { ...confirmedRuleForm, metricCode: 'sql_expression' }, false), /指标只允许/);
assert.throws(() => buildEnergyAnalysisConfigPayload('rule', { ...confirmedRuleForm, thresholdOperator: 'eval' }, false), /运算符不在/);
assert.throws(() => buildEnergyAnalysisConfigPayload('rule', { ...confirmedRuleForm, priority: 'urgent' }, false), /优先级只允许/);
assert.throws(() => buildEnergyAnalysisConfigPayload('rule', { ...confirmedRuleForm, evidenceRequirementsText: JSON.stringify({ unknown: true }) }, false), /不支持的字段/);

// 导入执行必须携带完整服务端见证；首次渲染的缺失、undefined 和 null 预演不得触发属性解引用。
assert.equal(canExecuteEnergyAnalysisImport(), false);
assert.equal(canExecuteEnergyAnalysisImport(undefined), false);
assert.equal(canExecuteEnergyAnalysisImport(null), false);
const preview = {
  batchId: 88,
  confirmText: '确认导入能源分析数据',
  backupReason: '导入前备份',
  duplicateStrategy: 'skip',
  fileSha256: 'sha256-value',
  previewSignature: 'signature',
  previewAuditDigest: 'digest',
  expectedWouldImport: 2,
  candidateRowIds: ['a', 'b'],
  candidateRows: [{ id: 'a' }, { id: 'b' }]
};
assert.equal(canExecuteEnergyAnalysisImport(preview), true);
assert.equal(canExecuteEnergyAnalysisImport({ ...preview, candidateRows: [{ id: 'a' }] }), false);
assert.deepEqual(buildImportExecutePayload(preview), {
  batchId: 88,
  confirmText: '确认导入能源分析数据',
  backupReason: '导入前备份',
  duplicateStrategy: 'skip',
  requireBackup: true,
  acknowledgeSkippedRisks: true,
  fileSha256: 'sha256-value',
  previewSignature: 'signature',
  previewAuditDigest: 'digest',
  expectedWouldImport: 2,
  candidateRowIds: ['a', 'b'],
  candidateRows: [{ id: 'a' }, { id: 'b' }]
});

// 页面与 API 静态契约必须覆盖正式组件、草稿筛选、权限、三类导入和全部分析接口。
const pageSource = readFileSync(new URL('../views/energy/analysis/index.vue', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/energyAnalysis.js', import.meta.url), 'utf8');
const utilitySource = readFileSync(new URL('../utils/energyAnalysis.js', import.meta.url), 'utf8');
assert.doesNotMatch(pageSource, /MigrationPlaceholder/);
assert.match(pageSource, /draftFilters/);
assert.match(pageSource, /appliedFilters/);
assert.match(pageSource, /输入变化不会自动请求/);
assert.match(pageSource, /function applyFilters\(\).*loadAnalysis\(\)/s);
assert.match(pageSource, /function resetFilters\(\).*loadAnalysis\(\)/s);
assert.match(pageSource, /不会连接外部 AI/);
assert.match(pageSource, /不会自动控制设备/);
assert.match(pageSource, /显式 idle/);
assert.match(pageSource, /stroke-width:2/);
assert.match(pageSource, /r="12" class="point-hit"/);
assert.match(pageSource, /aria-labelledby="energy-load-curve-title energy-load-curve-desc"/);
assert.match(pageSource, /<title id="energy-load-curve-title">/);
assert.match(pageSource, /<desc id="energy-load-curve-desc">/);
assert.doesNotMatch(pageSource, /role="button"[^>]*curvePointLabel|Math\.max\(2,/);
assert.match(pageSource, /energyAnalysisBarPercentage\(row\.observed, touMax\)/);
assert.match(pageSource, /touPresentation\(row\.type\)\.color/);
assert.match(pageSource, /摘要：.*qualityStatusText\(loadSummary\.quality\).*曲线：.*qualityStatusText\(loadCurve\.quality\)/s);
assert.match(pageSource, /createLatestEnergyAnalysisRequestGate/);
assert.match(pageSource, /analysisRequestGate\.isLatest\(run\)/);
assert.match(pageSource, /const nextResult = createEmptyEnergyAnalysisResult\(\)/);
assert.match(pageSource, /startEnergyAnalysisResultTransition\(analysisDisplaySnapshot\.value, run\)/);
assert.match(pageSource, /completeEnergyAnalysisResultTransition\(analysisResultState\.value, run, nextResult\)/);
assert.match(pageSource, /strategyRequestGate\.isLatest\(run\)/);
assert.match(pageSource, /strategyResult\.value = null/);
assert.match(pageSource, /commitEnergyAnalysisStrategyResult\(strategyResult\.value, run, kind, resultSnapshot\)/);
assert.doesNotMatch(pageSource, /strategyEvaluationResult|strategyRunResult/);
assert.match(pageSource, /strategyHits\.value\.find\(\(item\) => item\.id === hit\.id\)/);
assert.match(pageSource, /createEnergyAnalysisSnapshot\(draftFilters\.value\)/);
assert.match(pageSource, /v-loading="analysisRefreshing"/);
assert.match(pageSource, /仍展示上一次已提交查询快照/);
assert.match(pageSource, /analysisDisplayFilters\.productionUnitId|analysisDisplayFilters\.touSchemeId/);
assert.match(pageSource, /新配置不会预选状态/);
assert.match(pageSource, /preview: null/);
assert.match(pageSource, /canExecuteEnergyAnalysisImport\(importStates\[definition\.key\]\.preview\)/);
assert.match(utilitySource, /if \(!preview \|\| typeof preview !== 'object'\) return false/);
assert.match(utilitySource, /status: ''/);
assert.match(utilitySource, /statuses\.includes\(form\.status\)/);
for (const contractValue of [
  'MIXED_INTERVAL_GRANULARITY', 'SOURCE_OVERLAP_OR_DUPLICATE', 'MISSING_SHIFT_SCHEDULE',
  'MISSING_PRODUCTION_OUTPUT', 'overlap_or_duplicate', 'mixed_interval_granularity',
  'unit_not_comparable', 'missing_shift_schedule'
]) assert.match(utilitySource, new RegExp(contractValue));
assert.doesNotMatch(pageSource + utilitySource, /2099-12-31|defaultTouRules|thresholdValue:\s*source\?\.thresholdValue\s*\?\?\s*0\.8/);
assert.match(pageSource, /energy:analysis:config:view|ENERGY_ANALYSIS_PERMISSIONS\.configView/);
assert.match(pageSource, /energy:strategy:evaluate|ENERGY_ANALYSIS_PERMISSIONS\.strategyEvaluate/);
for (const endpoint of [
  '/consumption/load-summary', '/consumption/monthly-analysis', '/consumption/load-curve',
  '/consumption/time-of-use', '/consumption/shifts', '/consumption/device-states',
  '/consumption/peak-contribution', '/consumption/intensity', '/strategies/evaluate',
  '/strategies/runs', '/config/shifts', '/config/tou-schemes', '/config/strategy-rules'
]) assert.match(apiSource, new RegExp(endpoint.replaceAll('/', '\\/')));
for (const type of ['timeseries', 'shift-schedules', 'device-states']) assert.match(pageSource + apiSource + utilitySource, new RegExp(type));

console.log('energyAnalysis.test.mjs passed');
