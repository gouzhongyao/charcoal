import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PREDICTION_CATEGORY_COLORS,
  PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
  PREDICTION_RESULTS_READ_ONLY,
  buildPredictionConfigFilters,
  buildPredictionConfigImportExecutePayload,
  buildPredictionResultFilters,
  buildPredictionRunFilters,
  buildPredictionTrendRows,
  canArchivePredictionRun,
  canCancelPredictionRun,
  nextPredictionConfigStatus,
  rowsForPredictionUnit
} from '../utils/predictionManagement.js';

assert.deepEqual(
  buildPredictionConfigFilters({ status: 'draft', energyTypeCode: 'electricity', algorithm: 'moving_average', keyword: '生产部' }, { page: 2, pageSize: 50 }),
  { status: 'draft', energyTypeCode: 'electricity', algorithm: 'moving_average', keyword: '生产部', page: 2, pageSize: 50 }
);
assert.deepEqual(buildPredictionRunFilters({ status: 'failed', algorithm: 'linear_trend', energyTypeCode: 'heat', targetMonth: '2026-06', keyword: '样本' }, { page: 3, pageSize: 20 }), { status: 'failed', algorithm: 'linear_trend', energyTypeCode: 'heat', targetMonth: '2026-06', keyword: '样本', page: 3, pageSize: 20 });
assert.deepEqual(buildPredictionResultFilters({ runId: 7, energyTypeCode: 'electricity', targetMonthStart: '2026-04', targetMonthEnd: '2026-06', runStatus: 'completed', keyword: '移动平均' }, { page: 1, pageSize: 100 }), { runId: 7, energyTypeCode: 'electricity', targetMonthStart: '2026-04', targetMonthEnd: '2026-06', runStatus: 'completed', keyword: '移动平均', page: 1, pageSize: 100 });

const preview = { batchId: 15, confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT, previewSignature: 'hmac-sha256:v1:preview', summary: { wouldImport: 2 }, candidateRowIds: [2, 4], candidateRows: [{ candidateRowId: 'prediction-config:2', rowNumber: 2 }, { candidateRowId: 'prediction-config:4', rowNumber: 4 }] };
assert.deepEqual(buildPredictionConfigImportExecutePayload(preview), { batchId: 15, confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT, previewSignature: 'hmac-sha256:v1:preview', expectedWouldImport: 2, candidateRowIds: [2, 4], candidateRows: preview.candidateRows, requireBackup: true, acknowledgeSkippedRisks: true }, 'execute 必须原样传递服务器签名的预演候选。');

assert.equal(nextPredictionConfigStatus('draft'), 'archived');
assert.equal(nextPredictionConfigStatus('archived'), 'draft');
assert.equal(canCancelPredictionRun('pending'), true);
assert.equal(canCancelPredictionRun('running'), true);
assert.equal(canCancelPredictionRun('completed'), false, '完成运行不允许前端显示取消入口。');
assert.equal(canCancelPredictionRun('failed'), false, '失败运行不允许前端篡改。');
assert.equal(canArchivePredictionRun('completed'), true);
assert.equal(canArchivePredictionRun('failed'), true);
assert.equal(canArchivePredictionRun('running'), false);
assert.equal(PREDICTION_RESULTS_READ_ONLY, true, '前端必须显式维持预测结果只读边界。');

const mixedUnits = [
  { predictionRunId: 7, energyTypeCode: 'electricity', energyTypeName: '电力', targetMonth: '2026-04', predictedValue: 100, predictedUnit: 'kWh' },
  { predictionRunId: 7, energyTypeCode: 'electricity', energyTypeName: '电力', targetMonth: '2026-05', predictedValue: 120, predictedUnit: 'kWh' },
  { predictionRunId: 7, energyTypeCode: 'heat', energyTypeName: '热力', targetMonth: '2026-04', predictedValue: 30, predictedUnit: 'MJ' }
];
assert.deepEqual(rowsForPredictionUnit(mixedUnits, 'kWh'), [mixedUnits[0], mixedUnits[1]], '趋势图必须先按预测单位分面，禁止跨单位相加。');
assert.deepEqual(buildPredictionTrendRows(mixedUnits, 'kWh'), [
  { energyTypeCode: 'electricity', energyTypeName: '电力', targetMonth: '2026-04', predictedUnit: 'kWh', predictedValue: 100, resultCount: 1 },
  { energyTypeCode: 'electricity', energyTypeName: '电力', targetMonth: '2026-05', predictedUnit: 'kWh', predictedValue: 120, resultCount: 1 }
]);
assert.deepEqual(PREDICTION_CATEGORY_COLORS, ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'], '预测图表必须使用固定、已验证的实体色顺序。');

// 预测运行、结果和配置月份字段必须统一使用可编辑的 YYYY-MM 月份控件。
const predictionPageSource = readFileSync(new URL('../views/predictions/PredictionManagement.vue', import.meta.url), 'utf8');
const predictionApiSource = readFileSync(new URL('../api/predictions.js', import.meta.url), 'utf8');
assert.match(predictionApiSource, /\/templates\/demo-park\/12-prediction-configs\.xlsx/);
assert.match(predictionPageSource, /hasPermi\('prediction:config:import'\)/);
assert.match(predictionPageSource, /下载模板/);
assert.match(predictionPageSource, /导入草稿/);
assert.match(predictionPageSource, /不会运行预测/);
assert.doesNotMatch(predictionPageSource, /demoExampleLoading|downloadDemoExample|天坤集团示例/);
for (const fieldName of [
  'runDraftFilters.targetMonth',
  'resultDraftFilters.targetMonthStart',
  'resultDraftFilters.targetMonthEnd',
  'configForm.trainStartMonth',
  'configForm.trainEndMonth',
  'configForm.predictStartMonth',
  'configForm.predictEndMonth'
]) {
  const escapedFieldName = fieldName.replace('.', '\\.');
  assert.match(
    predictionPageSource,
    new RegExp(`<el-date-picker(?=[^>]*v-model="${escapedFieldName}")(?=[^>]*type="month")(?=[^>]*value-format="YYYY-MM")(?=[^>]*format="YYYY-MM")(?=[^>]*:editable="true")[^>]*>`),
    `${fieldName} 必须使用可编辑的 YYYY-MM 月份控件。`
  );
}

console.log('predictionManagement.test.mjs passed');
