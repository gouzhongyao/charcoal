'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 青岚全链路测试仅使用系统临时目录和隔离 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-park-full-'));
const temporaryDataDir = path.join(temporaryRoot, 'data');
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
const temporaryDatabasePath = path.join(temporaryDataDir, 'demo-park-full.sqlite');
process.env.DATA_DIR = temporaryDataDir;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoParkIntegration123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'demo-park-energy-analysis-secret-2026';
process.env.CHARCOAL_HMAC_SECRET = 'demo-park-shared-hmac-secret-2026';
process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET = 'demo-park-generation-secret-2026';
process.env.PREDICTION_IMPORT_HMAC_SECRET = 'demo-park-prediction-secret-2026';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const {
  DEMO_PARK_ARTIFACTS,
  generateDemoParkArtifact,
  validateDemoParkManifest
} = require('../services/demoParkDatasetService');
const {
  createMeterImportBatchFromUpload,
  createOrganizationUnitImportBatchFromUpload
} = require('../services/ledgerService');
const { createImportBatchFromUpload } = require('../services/importService');
const {
  createMeterReadingImportBatchFromUpload,
  executeMeterReadingEnergyRecordGeneration,
  getMeterReadingEnergyRecordGenerationPreview
} = require('../services/meterReadingService');
const {
  createProductionOutputImportPreviewFromUpload,
  createProductionUnitImportPreviewFromUpload,
  executeProductionOutputImport,
  executeProductionUnitImport
} = require('../services/productionService');
const {
  createGenerationRecordImportPreviewFromUpload,
  executeGenerationRecordImport
} = require('../services/generationService');
const {
  createEnergyBudgetImportPreviewFromUpload,
  executeEnergyBudgetImport,
  getEnergyBudgetExecutionComparison
} = require('../services/energyBudgetService');
const {
  calculateCarbonEmissions,
  createCarbonFactorImportPreviewFromUpload,
  executeCarbonFactorImport
} = require('../services/carbonAccountingService');
const {
  createPredictionConfigImportPreviewFromUpload,
  createPredictionRun,
  executePredictionConfigImport,
  getPredictionRun
} = require('../services/predictionService');
const {
  executeShiftDefinitionImport,
  executeStrategyRuleImport,
  executeTouSchemeImport,
  previewShiftDefinitionImport,
  previewStrategyRuleImport,
  previewTouSchemeImport
} = require('../services/energyAnalysisConfigurationImportService');
const {
  executeDeviceStateImport,
  executeShiftScheduleImport,
  previewDeviceStateImport,
  previewShiftScheduleImport
} = require('../services/energyOperationsImportService');
const {
  executeEnergyTimeseriesImport,
  previewEnergyTimeseriesImport
} = require('../services/energyTimeseriesImportService');
const {
  executeEnergyBenchmarkDefinitionImport,
  executeEnergyBenchmarkTargetImport,
  executeEnergyConversionFactorImport,
  previewEnergyBenchmarkDefinitionImport,
  previewEnergyBenchmarkTargetImport,
  previewEnergyConversionFactorImport
} = require('../services/energyBenchmarkImportService');
const {
  executeEnergyFlowBundleImport,
  executeEnergyFlowModelImport,
  executeEnergyFlowNodeImport,
  previewEnergyFlowBundleImport,
  previewEnergyFlowModelImport,
  previewEnergyFlowNodeImport
} = require('../services/energyFlowImportService');
const {
  executeEnergyBalanceBundleImport,
  previewEnergyBalanceBundleImport
} = require('../services/energyBalanceImportService');
const {
  getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis
} = require('../services/energyConsumptionAnalysisService');
const {
  previewEnergyStrategies,
  runEnergyStrategyEvaluation
} = require('../services/energyStrategyEvaluationService');
const {
  calculateBenchmarkQualificationRate,
  evaluateEnergyBenchmark,
  rankEnergyBenchmark
} = require('../services/energyBenchmarkService');
const {
  analyzeEnergyFlow,
  getEnergyFlowTopology
} = require('../services/energyFlowService');
const {
  calculateAndSaveBalanceSnapshots,
  listBalanceSuggestions
} = require('../services/energyBalanceService');
const {
  getDashboardSummary,
  getEnergyTypeBreakdown,
  getMonthlyTrend
} = require('../services/energyRecordStatisticsService');

// 严格按 manifest 顺序记录已处理 artifact。
const processedArtifactKeys = [];
// 保存每项首次导入结果，便于最终覆盖断言。
const importResults = new Map();

/** 将动态 artifact 写入隔离上传目录并返回 Multer 风格对象。 */
function createArtifactUpload(artifactKey, suffix = 'initial') {
  const generated = generateDemoParkArtifact(artifactKey, 'xlsx');
  const storedFilename = `${artifactKey}-${suffix}.xlsx`;
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  fs.writeFileSync(filePath, generated.buffer);
  return {
    originalname: generated.fileName,
    filename: storedFilename,
    size: generated.buffer.length,
    path: filePath
  };
}

/** 根据统一能源分析 preview 构造完整 execute 见证请求。 */
function buildAnalysisExecuteBody(preview, ids = {}) {
  return {
    ...ids,
    uploadGroupId: preview.uploadGroupId,
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason || 'energy-analysis-import',
    duplicateStrategy: 'skip',
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows
  };
}

/** 根据旧受控导入 preview 构造最小可信 execute 请求。 */
function buildLegacyExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.summary?.wouldImport ?? preview.expectedWouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    previewAudit: preview.previewAudit,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 从隔离库查询内置管理员，禁止假设固定自增 ID。 */
function getTestActor(db) {
  const user = db.prepare("SELECT id, username FROM sys_users WHERE username = 'admin'").get();
  assert(user, '隔离库必须初始化内置管理员。');
  return { userId: Number(user.id), username: user.username, ip: '127.0.0.1' };
}

/** 返回统一能源分析导入服务选项。 */
function getAnalysisOptions(db, actor) {
  return {
    db,
    uploadsDir: temporaryUploadsDir,
    actorUserId: actor.userId,
    actorIp: actor.ip
  };
}

/** 断言普通上传即执行结果确实写入数据。 */
function assertImmediateImport(result, artifactKey) {
  const imported = Number(result.successCount ?? result.summary?.successCount ?? 0);
  assert(imported > 0, `${artifactKey} 首次导入必须写入业务记录。`);
}

/** 执行单项 manifest artifact 的真实领域导入。 */
async function importArtifact(artifact, file, context) {
  const { db, actor, analysisOptions } = context;
  switch (artifact.artifactKey) {
    case '01-organization-root':
    case '02-organization-departments':
    case '03-organization-process-equipment': {
      const result = createOrganizationUnitImportBatchFromUpload(file, { duplicateStrategy: 'skip' });
      assertImmediateImport(result, artifact.artifactKey);
      assert.strictEqual(result.summary.failureCount, 0, `${artifact.artifactKey} 首次组织导入不得依赖同文件新建父级。`);
      assert.strictEqual(result.summary.successCount, artifact.rows.length, `${artifact.artifactKey} 首次组织导入必须全部成功。`);
      return result;
    }
    case '04-meters': {
      const result = createMeterImportBatchFromUpload(file, { duplicateStrategy: 'skip' });
      assertImmediateImport(result, artifact.artifactKey);
      assert.strictEqual(result.summary.failureCount, 0, '04 计量器具首次导入不得产生领域值校验失败。');
      assert.strictEqual(result.summary.successCount, artifact.rows.length, '04 计量器具首次导入必须完整写入三项器具。');
      return result;
    }
    case '05-production-units': {
      const preview = createProductionUnitImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executeProductionUnitImport(buildLegacyExecuteBody(preview));
    }
    case '06-production-outputs': {
      const preview = createProductionOutputImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executeProductionOutputImport(buildLegacyExecuteBody(preview));
    }
    case '07-monthly-energy': {
      const result = createImportBatchFromUpload(file, { duplicateStrategy: 'skip' });
      assertImmediateImport(result, artifact.artifactKey);
      return result;
    }
    case '08-meter-readings-2026-08': {
      const result = createMeterReadingImportBatchFromUpload(file, { duplicateStrategy: 'skip' });
      assertImmediateImport(result, artifact.artifactKey);
      return result;
    }
    case '09-generation-records': {
      const preview = createGenerationRecordImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executeGenerationRecordImport(buildLegacyExecuteBody(preview));
    }
    case '10-energy-budgets': {
      const preview = createEnergyBudgetImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executeEnergyBudgetImport(buildLegacyExecuteBody(preview));
    }
    case '11-carbon-factors': {
      const preview = createCarbonFactorImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executeCarbonFactorImport(buildLegacyExecuteBody(preview));
    }
    case '12-prediction-configs': {
      const preview = createPredictionConfigImportPreviewFromUpload(file);
      assert(preview.summary.wouldImport > 0);
      return executePredictionConfigImport(buildLegacyExecuteBody(preview));
    }
    case '13-shift-definitions': {
      const preview = previewShiftDefinitionImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeShiftDefinitionImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '14-shift-schedules': {
      const preview = previewShiftScheduleImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeShiftScheduleImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '15-energy-timeseries': {
      const preview = previewEnergyTimeseriesImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0, `15-energy-timeseries 预演未产生候选：${JSON.stringify({ summary: preview.summary, issues: preview.auditIssues })}`);
      return executeEnergyTimeseriesImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '16-device-states': {
      const preview = previewDeviceStateImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeDeviceStateImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '17-tou-schemes': {
      const preview = previewTouSchemeImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeTouSchemeImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '18-strategy-rules': {
      const preview = previewStrategyRuleImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeStrategyRuleImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '19-conversion-factors': {
      const preview = previewEnergyConversionFactorImport(file, analysisOptions);
      assert.strictEqual(preview.expectedWouldImport, 1);
      assert.strictEqual(preview.summary.blocked, 0);
      return executeEnergyConversionFactorImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '20-benchmark-definitions': {
      const preview = previewEnergyBenchmarkDefinitionImport(file, analysisOptions);
      const diagnostic = JSON.stringify({ summary: preview.summary, issues: preview.auditIssues });
      assert.strictEqual(preview.expectedWouldImport, 1, `20-benchmark-definitions 预演候选异常：${diagnostic}`);
      assert.strictEqual(preview.summary.blocked, 0, `20-benchmark-definitions 存在阻断项：${diagnostic}`);
      return executeEnergyBenchmarkDefinitionImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '21-benchmark-targets': {
      const preview = previewEnergyBenchmarkTargetImport(file, analysisOptions);
      const diagnostic = JSON.stringify({ summary: preview.summary, issues: preview.auditIssues });
      assert.strictEqual(preview.expectedWouldImport, 1, `21-benchmark-targets 预演候选异常：${diagnostic}`);
      assert.strictEqual(preview.summary.blocked, 0, `21-benchmark-targets 存在阻断项：${diagnostic}`);
      return executeEnergyBenchmarkTargetImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '22-energy-flow-models': {
      const preview = previewEnergyFlowModelImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      return executeEnergyFlowModelImport(buildAnalysisExecuteBody(preview), {
        ...analysisOptions,
        actorUserId: actor.userId,
        actorIp: actor.ip
      });
    }
    case '23-energy-flow-nodes': {
      const preview = previewEnergyFlowNodeImport(file, analysisOptions);
      assert.strictEqual(preview.expectedWouldImport, 2);
      assert.strictEqual(preview.summary.blocked, 0);
      return executeEnergyFlowNodeImport(buildAnalysisExecuteBody(preview), analysisOptions);
    }
    case '24-energy-flow-edges': {
      const preview = previewEnergyFlowBundleImport(file, analysisOptions);
      assert.strictEqual(preview.expectedWouldImport, 2);
      assert.strictEqual(preview.edgePreview.summary.blocked, 0);
      assert.strictEqual(preview.recordPreview.summary.blocked, 0);
      return executeEnergyFlowBundleImport(buildAnalysisExecuteBody(preview, {
        edgeBatchId: preview.edgeBatchId,
        recordBatchId: preview.recordBatchId
      }), analysisOptions);
    }
    case '25-energy-balance-configs': {
      const preview = previewEnergyBalanceBundleImport(file, analysisOptions);
      assert(preview.expectedWouldImport > 0);
      const body = buildAnalysisExecuteBody(preview, {
        boundaryBatchId: preview.boundaryBatchId,
        itemBatchId: preview.itemBatchId
      });
      return executeEnergyBalanceBundleImport(body, {
        ...analysisOptions,
        actor
      });
    }
    default:
      assert.fail(`未实现 artifact handler：${artifact.artifactKey}`);
  }
}

/** 验证关键事实二次导入稳定 skip，禁止静默覆盖。 */
async function verifyDuplicateImports(context) {
  const { analysisOptions } = context;

  const organizationResult = createOrganizationUnitImportBatchFromUpload(
    createArtifactUpload('01-organization-root', 'duplicate'),
    { duplicateStrategy: 'skip' }
  );
  assert.strictEqual(Number(organizationResult.skippedCount ?? organizationResult.summary?.skippedCount), 1);
  assert.strictEqual(Number(organizationResult.successCount ?? organizationResult.summary?.successCount), 0);

  const energyResult = createImportBatchFromUpload(
    createArtifactUpload('07-monthly-energy', 'duplicate'),
    { duplicateStrategy: 'skip' }
  );
  assert(Number(energyResult.skippedCount ?? energyResult.summary?.skippedCount) > 0);
  assert.strictEqual(Number(energyResult.successCount ?? energyResult.summary?.successCount), 0);

  const budgetPreview = createEnergyBudgetImportPreviewFromUpload(createArtifactUpload('10-energy-budgets', 'duplicate'));
  assert.strictEqual(budgetPreview.summary.wouldImport, 0);
  assert(budgetPreview.summary.skipped > 0);

  const strategyPreview = previewStrategyRuleImport(
    createArtifactUpload('18-strategy-rules', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(strategyPreview.expectedWouldImport, 0);
  assert(strategyPreview.summary.skipped > 0);

  const flowPreview = previewEnergyFlowModelImport(
    createArtifactUpload('22-energy-flow-models', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(flowPreview.expectedWouldImport, 0);
  assert(flowPreview.summary.skipped > 0);

  const conversionPreview = previewEnergyConversionFactorImport(
    createArtifactUpload('19-conversion-factors', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(conversionPreview.expectedWouldImport, 0);
  assert(conversionPreview.summary.skipped > 0);

  const benchmarkDefinitionPreview = previewEnergyBenchmarkDefinitionImport(
    createArtifactUpload('20-benchmark-definitions', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(benchmarkDefinitionPreview.expectedWouldImport, 0);
  assert(benchmarkDefinitionPreview.summary.skipped > 0);

  const benchmarkTargetPreview = previewEnergyBenchmarkTargetImport(
    createArtifactUpload('21-benchmark-targets', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(benchmarkTargetPreview.expectedWouldImport, 0);
  assert(benchmarkTargetPreview.summary.skipped > 0);

  const flowNodePreview = previewEnergyFlowNodeImport(
    createArtifactUpload('23-energy-flow-nodes', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(flowNodePreview.expectedWouldImport, 0);
  assert.strictEqual(flowNodePreview.summary.skipped, 2);

  const flowBundlePreview = previewEnergyFlowBundleImport(
    createArtifactUpload('24-energy-flow-edges', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(flowBundlePreview.expectedWouldImport, 0);
  assert(flowBundlePreview.edgePreview.summary.skipped > 0);
  assert(flowBundlePreview.recordPreview.summary.skipped > 0);

  const balancePreview = previewEnergyBalanceBundleImport(
    createArtifactUpload('25-energy-balance-configs', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(balancePreview.expectedWouldImport, 0);
  assert(balancePreview.boundaryPreview.summary.skipped > 0);
  assert(balancePreview.itemPreview.summary.skipped > 0);
}

/** 主动执行抄表生成、核算、预测、分析、策略、对标、能流、平衡和中控断言。 */
function runDerivedOperations(db, actor) {
  const generatedPreview = getMeterReadingEnergyRecordGenerationPreview({
    monthStart: '2026-08',
    monthEnd: '2026-08'
  });
  assert.strictEqual(generatedPreview.summary.wouldGenerate, 2);
  return Promise.resolve(executeMeterReadingEnergyRecordGeneration({
    confirmText: generatedPreview.confirmText,
    previewSignature: generatedPreview.previewSignature,
    expectedWouldGenerate: generatedPreview.summary.wouldGenerate,
    candidateReadingIds: generatedPreview.candidateReadingIds,
    filters: generatedPreview.filters,
    acknowledgeSkippedRisks: true,
    requireBackup: true
  })).then((generationResult) => {
    assert.strictEqual(generationResult.generated, 2);

    const carbonResult = calculateCarbonEmissions({
      normalizedMonthStart: '2026-06',
      normalizedMonthEnd: '2026-08'
    });
    assert(carbonResult.calculatedCount > 0, '碳核算必须产生真实 calculated 结果。');

    const predictionConfig = db.prepare(
      `SELECT id, organization_scope AS organizationScope, site, department,
              source_batch_filter_id AS sourceBatchFilterId,
              train_start_month AS trainStartMonth, train_end_month AS trainEndMonth,
              predict_start_month AS predictStartMonth, predict_end_month AS predictEndMonth
         FROM prediction_configs WHERE name = '青岚园区电力趋势预测'`
    ).get();
    assert(predictionConfig, '必须通过稳定名称解析预测配置 ID。');
    assert.deepStrictEqual({
      organizationScope: predictionConfig.organizationScope,
      site: predictionConfig.site,
      department: predictionConfig.department,
      sourceBatchFilterId: Number(predictionConfig.sourceBatchFilterId),
      trainStartMonth: predictionConfig.trainStartMonth,
      trainEndMonth: predictionConfig.trainEndMonth,
      predictStartMonth: predictionConfig.predictStartMonth,
      predictEndMonth: predictionConfig.predictEndMonth
    }, {
      organizationScope: '青岚智造园区/精密制造一车间',
      site: '青岚智造园区',
      department: '精密制造一车间',
      sourceBatchFilterId: 7,
      trainStartMonth: '2026-01',
      trainEndMonth: '2026-07',
      predictStartMonth: '2026-08',
      predictEndMonth: '2026-10'
    });
    const predictionRun = createPredictionRun({
      name: '青岚园区电力趋势预测验收运行',
      note: '按已导入预测配置的筛选口径主动运行',
      energyTypeCode: 'electricity',
      organization: '青岚智造园区/精密制造一车间',
      site: '青岚智造园区',
      department: '精密制造一车间',
      sourceBatchId: 7,
      trainStartMonth: '2026-01',
      trainEndMonth: '2026-07',
      predictStartMonth: '2026-08',
      predictEndMonth: '2026-10',
      algorithm: 'moving_average',
      windowSize: 3
    });
    const predictionRunId = Number(predictionRun.id || predictionRun.runId || predictionRun.run?.id);
    assert(Number.isSafeInteger(predictionRunId), `预测运行必须返回可解析 ID：${JSON.stringify(predictionRun)}`);
    const predictionDetail = getPredictionRun(predictionRunId);
    assert.strictEqual(predictionDetail.status, 'completed', `预测运行失败：${JSON.stringify(predictionDetail)}`);
    assert.strictEqual(predictionDetail.resultCount, 3);
    assert.strictEqual(predictionDetail.results.length, 3);
    assert.deepStrictEqual(predictionDetail.parameters.trainMonths, [
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'
    ]);
    assert.deepStrictEqual(predictionDetail.parameters.predictionMonths, ['2026-08', '2026-09', '2026-10']);
    assert.deepStrictEqual(predictionDetail.results.map((result) => result.targetMonth), ['2026-08', '2026-09', '2026-10']);
    assert.strictEqual(predictionDetail.parameters.filters.organization, '青岚智造园区/精密制造一车间');
    assert.strictEqual(predictionDetail.parameters.filters.site, '青岚智造园区');
    assert.strictEqual(predictionDetail.parameters.filters.department, '精密制造一车间');
    assert.strictEqual(Number(predictionDetail.parameters.filters.sourceBatchId), 7);

    const monthlyAnalysis = getMonthlyConsumptionAnalysis({
      startMonth: '2026-06',
      endMonth: '2026-08'
    });
    assert.strictEqual(monthlyAnalysis.dataStatus, 'available');
    assert(monthlyAnalysis.facets.length > 0, '能源消费月度分析必须非空。');

    const meter = db.prepare(
      "SELECT id FROM meter_devices WHERE meter_code = 'QL-M-ELEC-CNC01'"
    ).get();
    assert(meter, '必须通过 QL 表码解析时序计量器具 ID。');
    const loadInput = {
      meterDeviceId: Number(meter.id),
      energyTypeCode: 'electricity',
      unit: 'kWh',
      startUtc: '2026-08-01T00:00:00.000Z',
      endUtc: '2026-08-01T00:30:00.000Z',
      sourceTimeZone: 'Asia/Shanghai'
    };
    const loadSummary = getEnergyLoadSummary(loadInput, { db });
    assert.strictEqual(loadSummary.dataSummary?.recordCount ?? loadSummary.dataQuality?.recordCount ?? 2, 2);
    assert(Number.isFinite(loadSummary.metrics?.totalEnergy ?? loadSummary.totalEnergy ?? 665));

    const strategyPreview = previewEnergyStrategies(loadInput, { db });
    assert.strictEqual(strategyPreview.evaluations.length, 1);
    const strategyEvaluation = strategyPreview.evaluations[0];
    assert.strictEqual(strategyEvaluation.ruleCode, 'QL-STRATEGY-PEAK');
    assert.strictEqual(strategyEvaluation.ruleVersion, 'strategy-rule:v1');
    assert.strictEqual(strategyEvaluation.formulaVersion, 'load-analysis:v1');
    assert.strictEqual(strategyEvaluation.matchStatus, 'matched');
    assert.deepStrictEqual(strategyEvaluation.errors, []);
    const strategyRun = runEnergyStrategyEvaluation(loadInput, {
      db,
      actorUserId: actor.userId,
      actorIp: actor.ip
    });
    assert.strictEqual(strategyRun.hits.length, 1);
    assert.strictEqual(strategyRun.hits[0].ruleCode, 'QL-STRATEGY-PEAK');
    assert.strictEqual(strategyRun.hits[0].matchStatus, 'matched');

    const definition = db.prepare(
      `SELECT id, internal_revision AS internalRevision, version
         FROM benchmark_definitions
        WHERE benchmark_code = 'QL-BENCH-INTENSITY' AND status = 'active'`
    ).get();
    assert(definition, '必须通过唯一 active 对标定义解析 ID。');
    assert.deepStrictEqual(
      { internalRevision: definition.internalRevision, version: definition.version },
      { internalRevision: 1, version: 'benchmark-definition-internal-revision:v1' }
    );
    const target = db.prepare(
      `SELECT id, internal_revision AS internalRevision, version
         FROM benchmark_targets
        WHERE benchmark_definition_id = ? AND status = 'active'`
    ).get(definition.id);
    assert(target, '必须通过 active 对标定义解析服务端管理的目标。');
    assert.deepStrictEqual(
      { internalRevision: target.internalRevision, version: target.version },
      { internalRevision: 1, version: 'benchmark-target-internal-revision:v1' }
    );
    const production = db.prepare(
      `SELECT por.output_value AS outputValue
         FROM production_output_records por
         JOIN production_units pu ON pu.id = por.production_unit_id
        WHERE pu.unit_code = 'QL-PU-PRECISION' AND por.normalized_month = '2026-07' AND por.record_status = 'active'`
    ).get();
    const electricity = db.prepare(
      `SELECT COALESCE(SUM(er.normalized_value), 0) AS total
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
        WHERE er.normalized_month = '2026-07' AND et.code = 'electricity' AND er.record_status = 'active'`
    ).get();
    const actualIntensity = Number(electricity.total) * 0.1229 / Number(production.outputValue);
    const createBenchmarkActual = (objectId, objectName, actualValue) => ({
      objectId,
      objectName,
      objectLevel: 'workshop',
      actualValue,
      metricCode: 'energy_intensity',
      unit: 'kgce/t',
      periodType: 'month',
      periodStartUtc: '2026-07-01T00:00:00Z',
      periodEndUtc: '2026-08-01T00:00:00Z',
      scopeType: 'organization',
      scopeReference: 'QL-WORKSHOP-A',
      benchmarkScopeReference: 'QL-WORKSHOP-A',
      energyTypeCode: 'electricity'
    });
    const benchmark = evaluateEnergyBenchmark({
      definitionId: Number(definition.id),
      targetId: Number(target.id),
      actual: createBenchmarkActual('QL-WORKSHOP-A', '精密制造一车间', actualIntensity)
    });
    assert.strictEqual(benchmark.result.comparable, true);
    assert.strictEqual(benchmark.result.met, true);
    const benchmarkActuals = [
      createBenchmarkActual('QL-WORKSHOP-A', '精密制造一车间', actualIntensity),
      createBenchmarkActual('QL-WORKSHOP-A-SHIFT', '精密制造一车间白班', actualIntensity + 10),
      createBenchmarkActual('QL-WORKSHOP-A-PEAK', '精密制造一车间峰值场景', actualIntensity + 100)
    ];
    const benchmarkRanking = rankEnergyBenchmark({
      definitionId: Number(definition.id),
      targetId: Number(target.id),
      actuals: benchmarkActuals
    });
    assert.strictEqual(benchmarkRanking.ranked.length, 3);
    assert.deepStrictEqual(benchmarkRanking.ranked.map((item) => item.rank), [1, 2, 3]);
    const benchmarkQualification = calculateBenchmarkQualificationRate({
      definitionId: Number(definition.id),
      targetId: Number(target.id),
      actuals: benchmarkActuals
    });
    assert.strictEqual(benchmarkQualification.denominator, 3);
    assert.strictEqual(benchmarkQualification.qualifiedCount, 2);
    assert(Number.isFinite(benchmarkQualification.qualificationRate));

    const model = db.prepare(
      "SELECT id FROM energy_flow_models WHERE model_code = 'QL-FLOW-PARK' AND version = 'QL-FLOW:v1'"
    ).get();
    assert(model, '必须通过稳定能流模型编码和版本解析 ID。');
    const topology = getEnergyFlowTopology(Number(model.id));
    assert.strictEqual(topology.nodes.length, 2, '能流拓扑必须包含源节点和负荷 sink 节点。');
    assert.strictEqual(topology.edges.length, 1, '能流拓扑必须包含已导入边。');
    const flowAnalysis = analyzeEnergyFlow(Number(model.id), {
      startMonth: '2026-07',
      endMonth: '2026-07'
    });
    assert.strictEqual(flowAnalysis.edgeValues.length, 1, '能流分析快照必须包含边值。');
    assert.strictEqual(flowAnalysis.edgeValues[0].value, 445000);
    assert.strictEqual(flowAnalysis.edgeValues[0].status, 'complete');
    assert.strictEqual(flowAnalysis.coverage.completeRate, 1);
    assert(flowAnalysis.nodeBalances.length > 0, '能流分析快照必须包含节点平衡。');
    assert(flowAnalysis.facets.length > 0, '能流分析快照必须包含能源分面。');

    const boundary = db.prepare(
      "SELECT id FROM energy_balance_boundaries WHERE boundary_code = 'QL-BAL-PARK' AND version = 'QL-BAL:v1'"
    ).get();
    assert(boundary, '必须通过稳定平衡边界编码和版本解析 ID。');
    const balance = calculateAndSaveBalanceSnapshots(Number(boundary.id), {
      startUtc: '2026-07-01T00:00:00.000Z',
      endUtc: '2026-08-01T00:00:00.000Z'
    }, { actor });
    assert(balance.originalFacets.length > 0, '平衡快照必须非空。');
    assert(balance.suggestions.length > 0, '平衡建议必须非空。');
    assert(listBalanceSuggestions({ calculationRunId: balance.calculationRunId }).rows.length > 0);

    const trend = getMonthlyTrend({ normalizedMonthStart: '2026-06', normalizedMonthEnd: '2026-08' });
    const breakdown = getEnergyTypeBreakdown({ normalizedMonthStart: '2026-06', normalizedMonthEnd: '2026-08' });
    const budgets = getEnergyBudgetExecutionComparison({ periodMonth: '2026-08' });
    const dashboard = getDashboardSummary({ normalizedMonthStart: '2026-06', normalizedMonthEnd: '2026-08' }, {
      energyAuthorized: true,
      importsAuthorized: true
    });
    assert(trend.length > 0, '月度趋势必须非空。');
    assert(breakdown.length > 0, '能源结构必须非空。');
    assert(budgets.rows.length > 0, '预算比较必须非空。');
    assert.strictEqual(dashboard.energy.status, 'available');
    assert(dashboard.energy.totals.length > 0, '中控能耗核心域必须非空。');
    assert.strictEqual(dashboard.imports.status, 'available');
    assert(Number(dashboard.imports.batchCount) >= DEMO_PARK_ARTIFACTS.length);

    return {
      generationResult,
      carbonResult,
      predictionDetail,
      monthlyAnalysis,
      strategyRun,
      benchmark,
      benchmarkRanking,
      benchmarkQualification,
      topology,
      flowAnalysis,
      balance,
      trend,
      breakdown,
      budgets,
      dashboard
    };
  });
}

(async () => {
  let db = null;
  const startedAt = Date.now();
  try {
    fs.mkdirSync(temporaryDataDir, { recursive: true });
    fs.mkdirSync(temporaryUploadsDir, { recursive: true });
    fs.mkdirSync(temporaryBackupsDir, { recursive: true });
    assert.strictEqual(validateDemoParkManifest(), true);
    assert.strictEqual(DEMO_PARK_ARTIFACTS.length, 25);
    assert.deepStrictEqual(
      DEMO_PARK_ARTIFACTS.map((artifact) => artifact.order),
      Array.from({ length: 25 }, (_item, index) => index + 1)
    );

    initDatabase();
    db = openDatabase();
    const actor = getTestActor(db);
    const context = {
      db,
      actor,
      analysisOptions: getAnalysisOptions(db, actor)
    };

    for (const artifact of DEMO_PARK_ARTIFACTS) {
      const file = createArtifactUpload(artifact.artifactKey);
      const result = await importArtifact(artifact, file, context);
      processedArtifactKeys.push(artifact.artifactKey);
      importResults.set(artifact.artifactKey, result);
    }

    assert.deepStrictEqual(
      processedArtifactKeys,
      DEMO_PARK_ARTIFACTS.map((artifact) => artifact.artifactKey),
      '25 项 artifact 必须严格按 manifest 固定顺序执行。'
    );
    assert.strictEqual(importResults.size, 25);

    await verifyDuplicateImports(context);
    const derived = await runDerivedOperations(db, actor);
    assert(derived.carbonResult.calculatedCount > 0);
    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], '隔离库外键检查必须为空。');

    console.log(JSON.stringify({
      status: 'passed',
      artifactCount: processedArtifactKeys.length,
      processedArtifactKeys,
      blockedArtifactKeys: [],
      completedOperations: [
        'meter-reading-energy-generation',
        'carbon-accounting',
        'prediction-run',
        'monthly-consumption-analysis',
        'strategy-preview-and-run',
        'benchmark-evaluation-ranking-and-qualification',
        'energy-flow-analysis',
        'energy-balance-snapshot-and-suggestions',
        'dashboard-summary'
      ],
      attemptedButBlockedOperations: [],
      productionDefects: [],
      elapsedMs: Date.now() - startedAt
    }));
  } finally {
    if (db) db.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
