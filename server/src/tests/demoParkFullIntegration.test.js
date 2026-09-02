'use strict';

const assert = require('assert');
const crypto = require('crypto');
const XLSX = require('xlsx');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 天坤集团全链路测试仅使用系统临时目录和隔离 SQLite。
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
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const { createDemoContext, sha256Buffer } = require('../services/demoContextService');
const { getDemoArtifactRegistration } = require('../services/demoArtifactRegistry');
const { requireDemoPostAction } = require('../services/demoPostActionRegistry');
const {
  executeDemoPostAction,
  getDemoPostActionStatus,
  previewDemoPostAction
} = require('../services/demoPostActionService');
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
  CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
  calculateCarbonEmissions,
  createCarbonFactorImportPreviewFromUpload,
  executeCarbonFactorImport
} = require('../services/carbonAccountingService');
const {
  PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
  createPredictionConfigImportPreviewFromUpload,
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
  getDeviceStateConsumptionAnalysis,
  getEnergyLoadCurve,
  getEnergyLoadSummary,
  getMonthlyConsumptionAnalysis,
  getShiftConsumptionAnalysis,
  getTimeOfUseConsumptionAnalysis
} = require('../services/energyConsumptionAnalysisService');
const { getEnergyIntensityAnalysis } = require('../services/energyIntensityAnalysisService');
const { getPeakContributionAnalysis } = require('../services/energyConsumptionPeakContributionService');
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
const {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  executeCarbonActivityImport,
  previewCarbonActivityImport
} = require('../services/carbonActivityImportService');
const {
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  executeCarbonEmissionReportImport,
  previewCarbonEmissionReportImport
} = require('../services/carbonEmissionReportImportService');
const {
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  executeGhgReportImport,
  previewGhgReportImport
} = require('../services/ghgReportImportService');
const {
  SUPPLIER_IMPORT_CONFIRM_TEXT,
  executeSupplierImport,
  previewSupplierImport
} = require('../services/supplierService');
const { getCarbonEmissionReportByBatch } = require('../services/carbonEmissionReportService');
const { getGhgReportByBatch } = require('../services/ghgReportService');
const { createBackup } = require('../services/backupService');

// 严格按 manifest 顺序记录已处理 artifact。
const processedArtifactKeys = [];
// 保存每项首次导入结果，便于最终覆盖断言。
const importResults = new Map();

/** 将动态 artifact 原始下载字节写入隔离上传目录并返回 Multer 风格对象。 */
function createArtifactUpload(artifactKey, suffix = 'initial') {
  const generated = generateDemoParkArtifact(artifactKey, 'xlsx');
  const buffer = generated.buffer;
  const storedFilename = `${artifactKey}-${suffix}.xlsx`;
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  fs.writeFileSync(filePath, buffer);
  return {
    originalname: generated.fileName,
    filename: storedFilename,
    size: buffer.length,
    path: filePath
  };
}

/** 生成不会与正式导入或另一个顺序场景重复的 artifact 15/18 managed 变体。 */
function createManagedStrategyArtifactUpload(artifactKey, variant) {
  const variantConfig = {
    forward: { date: '2026-08-02', suffix: 'FORWARD', label: '正序' },
    reverse: { date: '2026-08-03', suffix: 'REVERSE', label: '逆序' }
  }[variant];
  if (!variantConfig) throw new Error(`不支持 managed strategy variant：${variant}`);
  const generated = generateDemoParkArtifact(artifactKey, 'xlsx');
  const workbook = XLSX.read(generated.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false
  });
  if (artifactKey === '15-energy-timeseries') {
    rows.slice(1).forEach((row) => {
      row[3] = String(row[3]).replace('2026-08-01', variantConfig.date);
      row[4] = String(row[4]).replace('2026-08-01', variantConfig.date);
      row[9] = `${row[9]}:managed:${variant}`;
    });
  } else if (artifactKey === '18-strategy-rules') {
    rows[1][0] = `QL-STRATEGY-PEAK-MANAGED-${variantConfig.suffix}`;
    rows[1][1] = `峰段能耗偏高提醒（managed ${variantConfig.label}）`;
  } else {
    throw new Error(`不支持 managed strategy artifact：${artifactKey}`);
  }
  workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const storedFilename = `${artifactKey}-managed-${variant}.xlsx`;
  const filePath = path.join(temporaryUploadsDir, storedFilename);
  fs.writeFileSync(filePath, buffer);
  return {
    originalname: storedFilename,
    filename: storedFilename,
    size: buffer.length,
    path: filePath,
    buffer
  };
}

/** 根据统一能源分析 preview 构造完整 execute 见证请求。 */
function buildAnalysisExecuteBody(preview, ids = {}) {
  return {
    ...ids,
    uploadGroupId: preview.uploadGroupId,
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
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
    expectedWouldImport: preview.summary.wouldImport,
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

/** 为 manifest artifact 创建绑定同一 active run 的正式 managed context。 */
function createManagedDemoImportContext(db, actor, demoRun, artifact, file) {
  assert(demoRun && demoRun.runId, `${artifact.artifactKey} managed 导入必须绑定 active demo run。`);
  const registration = getDemoArtifactRegistration(artifact.artifactKey);
  const context = createDemoContext({
    db,
    userId: actor.userId,
    runId: demoRun.runId,
    artifactKey: artifact.artifactKey,
    handlerKey: registration.handlerKey,
    artifactFileSha256: sha256Buffer(fs.readFileSync(file.path))
  });
  return {
    context,
    demoContext: {
      token: context.token,
      userId: actor.userId,
      artifactKey: artifact.artifactKey,
      handlerKey: registration.handlerKey
    }
  };
}

/** 读取 Carbon connected 生命周期的业务、ownership、output 与审计计数。 */
function readCarbonConnectedState(db, runId) {
  return {
    calculationRuns: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
    accountingResults: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
    domainAudits: Number(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'carbon.accounting.run.create'").get().total),
    derivedOwnership: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND ownership_kind = 'derived' AND cleaned_at IS NULL`).get(runId).total),
    relations: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations WHERE run_id = ?').get(runId).total),
    outputs: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_post_action_outputs').get().total),
    actionRuns: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_post_action_runs
      WHERE run_id = ? AND action_key = 'carbon-accounting-run'`).get(runId).total),
    previewAudits: Number(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.preview' AND detail_json LIKE '%carbon-accounting-run%'`).get().total),
    executeAudits: Number(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
      WHERE operation = 'system.demo.post-action.execute' AND detail_json LIKE '%carbon-accounting-run%'`).get().total)
  };
}

/** 断言 Carbon connected 公共 DTO 不暴露私有摘要或内部载荷。 */
function assertCarbonConnectedPublicDtoSafe(value) {
  assert.strictEqual(
    /privateDigest|privateScopeDigest|PRIVATE_SENTINEL|SELECT \* FROM private_table/i.test(JSON.stringify(value)),
    false,
    'Carbon connected 公共 DTO 不得泄漏私有摘要、SQL 或内部哨兵。'
  );
}

/** 在 29 项正式导入后执行真实 Carbon connected post-action，并验证输出追溯与 replay 幂等。 */
function runCarbonConnectedPostAction(db, actor, demoRun) {
  const definition = requireDemoPostAction('carbon-accounting-run');
  assert.deepStrictEqual({
    implementationStatus: definition.implementationStatus,
    resolverVersion: definition.resolverVersion,
    executorVersion: definition.executorVersion
  }, {
    implementationStatus: 'connected',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:v1'
  });

  const importedFactorRows = db.prepare(`SELECT CAST(entity_pk AS INTEGER) AS entityPk
    FROM demo_data_registry WHERE run_id = ? AND artifact_key = '11-carbon-factors'
      AND entity_type = 'carbon_factor' AND ownership_kind = 'imported' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(demoRun.runId);
  const importedActivityRows = db.prepare(`SELECT CAST(entity_pk AS INTEGER) AS entityPk
    FROM demo_data_registry WHERE run_id = ? AND artifact_key = '27-carbon-activities'
      AND entity_type = 'carbon_activity_record' AND ownership_kind = 'imported' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(demoRun.runId);
  assert(importedFactorRows.length > 0, 'Carbon connected 必须取得 artifact 11 的真实 imported ownership。');
  assert(importedActivityRows.length > 0, 'Carbon connected 必须取得 artifact 27 的真实 imported ownership。');
  const importedFactorIds = new Set(importedFactorRows.map((row) => Number(row.entityPk)));
  const importedActivityIds = importedActivityRows.map((row) => Number(row.entityPk)).sort((a, b) => a - b);
  const unownedFactorIds = new Set(db.prepare(`SELECT id FROM carbon_factors
    WHERE id NOT IN (SELECT CAST(entity_pk AS INTEGER) FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'carbon_factor' AND ownership_kind = 'imported'
        AND cleaned_at IS NULL)`).all(demoRun.runId).map((row) => Number(row.id)));
  const unownedActivityIds = new Set(db.prepare(`SELECT id FROM carbon_activity_records
    WHERE id NOT IN (SELECT CAST(entity_pk AS INTEGER) FROM demo_data_registry
      WHERE run_id = ? AND entity_type = 'carbon_activity_record' AND ownership_kind = 'imported'
        AND cleaned_at IS NULL)`).all(demoRun.runId).map((row) => Number(row.id)));

  const clientRequestId = 'demo-park-carbon-connected';
  const stateBeforePreview = readCarbonConnectedState(db, demoRun.runId);
  const preview = previewDemoPostAction({
    db,
    runId: demoRun.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: actor.userId,
    actorIp: actor.ip,
    body: { clientRequestId }
  });
  assert.strictEqual(preview.status, 'previewed');
  assert.strictEqual(preview.blocker, null);
  assert.deepStrictEqual(preview.input.sources, ['11-carbon-factors', '27-carbon-activities']);
  assert.strictEqual(preview.input.factorCount, importedFactorIds.size);
  assert.strictEqual(preview.input.activityCount, importedActivityIds.length);
  assert.strictEqual(preview.input.expectedRunCount, 1);
  assert.strictEqual(preview.input.expectedResultCount, importedActivityIds.length);
  assert.strictEqual(preview.input.expectedOutputCount, importedActivityIds.length + 1);
  assert.strictEqual(
    preview.input.calculatedCount + preview.input.factorMissingCount,
    importedActivityIds.length
  );
  assert.strictEqual(preview.result, null);
  assert.strictEqual(preview.outputCount, 0);
  assert.deepStrictEqual(preview.outputs, []);
  assertCarbonConnectedPublicDtoSafe(preview);
  assert.deepStrictEqual(readCarbonConnectedState(db, demoRun.runId), {
    ...stateBeforePreview,
    actionRuns: stateBeforePreview.actionRuns + 1,
    previewAudits: stateBeforePreview.previewAudits + 1
  }, 'Carbon connected preview 只能新增 action run 与 preview audit。');

  const persistedInput = JSON.parse(db.prepare(`SELECT input_json AS inputJson
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(preview.actionRunId).inputJson);
  assert.deepStrictEqual({
    actionKey: persistedInput.publicProjectionActionKey,
    resolverVersion: persistedInput.publicProjectionResolverVersion,
    executorVersion: persistedInput.publicProjectionExecutorVersion,
    projectionVersion: persistedInput.publicProjectionVersion
  }, {
    actionKey: 'carbon-accounting-run',
    resolverVersion: 'carbon-accounting-resolver:v1',
    executorVersion: 'carbon-accounting-executor:v1',
    projectionVersion: 1
  });

  const stateBeforeExecute = readCarbonConnectedState(db, demoRun.runId);
  const succeeded = executeDemoPostAction({
    db,
    actionRunId: preview.actionRunId,
    actorUserId: actor.userId,
    actorIp: actor.ip,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.strictEqual(succeeded.status, 'succeeded');
  assert.strictEqual(succeeded.blocker, null);
  assert.strictEqual(succeeded.outputCount, importedActivityIds.length + 1);
  assert.strictEqual(succeeded.outputs.length, succeeded.outputCount);
  assert.strictEqual(succeeded.result.runCount, 1);
  assert.strictEqual(succeeded.result.resultCount, importedActivityIds.length);
  assert.strictEqual(succeeded.result.outputCount, succeeded.outputCount);
  assert.strictEqual(
    succeeded.result.calculatedCount + succeeded.result.factorMissingCount,
    importedActivityIds.length
  );
  assertCarbonConnectedPublicDtoSafe(succeeded);

  const persistedOutputs = db.prepare(`SELECT output_entity_type AS outputEntityType,
      output_entity_id AS outputEntityId FROM demo_post_action_outputs
    WHERE action_run_id = ? ORDER BY output_id`).all(preview.actionRunId);
  const calculationRunOutputs = persistedOutputs.filter((output) => output.outputEntityType === 'carbon_calculation_run');
  assert.strictEqual(calculationRunOutputs.length, 1);
  const calculationRunId = Number(calculationRunOutputs[0].outputEntityId);
  const calculationRun = db.prepare(`SELECT id, status, result_count AS resultCount
    FROM carbon_calculation_runs WHERE id = ?`).get(calculationRunId);
  assert.deepStrictEqual(calculationRun, {
    id: calculationRunId,
    status: 'completed',
    resultCount: importedActivityIds.length
  });
  const resultRows = db.prepare(`SELECT id, activity_record_id AS activityRecordId,
      carbon_factor_id AS carbonFactorId, status FROM carbon_accounting_results
    WHERE calculation_run_id = ? ORDER BY id`).all(calculationRunId);
  assert.deepStrictEqual(
    resultRows.map((row) => Number(row.activityRecordId)).sort((a, b) => a - b),
    importedActivityIds,
    'Carbon connected 结果必须精确覆盖 artifact 27 imported ownership。'
  );
  resultRows.forEach((row) => {
    assert.strictEqual(unownedActivityIds.has(Number(row.activityRecordId)), false,
      'Carbon connected 不得吸收未归属 activity 哨兵。');
    if (row.carbonFactorId !== null) {
      assert.strictEqual(importedFactorIds.has(Number(row.carbonFactorId)), true,
        'calculated 结果必须只引用 artifact 11 imported factor。');
      assert.strictEqual(unownedFactorIds.has(Number(row.carbonFactorId)), false,
        'Carbon connected 不得吸收未归属 factor 哨兵。');
    }
  });
  const expectedOutputFacts = [
    `carbon_calculation_run:${calculationRunId}`,
    ...resultRows.map((row) => `carbon_accounting_result:${row.id}`)
  ].sort();
  assert.deepStrictEqual(
    persistedOutputs.map((output) => `${output.outputEntityType}:${output.outputEntityId}`).sort(),
    expectedOutputFacts
  );
  assert.deepStrictEqual(
    succeeded.outputs.map((output) => output.outputEntityType).sort(),
    persistedOutputs.map((output) => output.outputEntityType).sort(),
    'Carbon connected 公共 outputs 类型与基数必须对应真实持久化 outputs。'
  );
  // 公共 calculation run outputs 只验证稳定类型与白名单引用，不读取内部实体 ID。
  const publicCalculationRunOutputs = succeeded.outputs.filter(
    (output) => output.outputEntityType === 'carbon_calculation_run'
  );
  // 公共 accounting result outputs 与持久化结果保持类型基数一致，并逐项验证安全引用。
  const publicAccountingResultOutputs = succeeded.outputs.filter(
    (output) => output.outputEntityType === 'carbon_accounting_result'
  );
  assert.strictEqual(publicCalculationRunOutputs.length, 1);
  assert.strictEqual(publicAccountingResultOutputs.length, resultRows.length);
  assert.deepStrictEqual(
    Object.keys(publicCalculationRunOutputs[0].outputRef).sort(),
    [
      'activityCount',
      'calculatedCount',
      'endUtc',
      'factorMissingCount',
      'resultCount',
      'runCode',
      'startUtc',
      'status'
    ],
    'Carbon connected calculation run 公共引用必须保持递归显式白名单。'
  );
  assert.deepStrictEqual({
    status: publicCalculationRunOutputs[0].outputRef.status,
    activityCount: publicCalculationRunOutputs[0].outputRef.activityCount,
    resultCount: publicCalculationRunOutputs[0].outputRef.resultCount,
    calculatedCount: publicCalculationRunOutputs[0].outputRef.calculatedCount,
    factorMissingCount: publicCalculationRunOutputs[0].outputRef.factorMissingCount
  }, {
    status: 'completed',
    activityCount: importedActivityIds.length,
    resultCount: resultRows.length,
    calculatedCount: succeeded.result.calculatedCount,
    factorMissingCount: succeeded.result.factorMissingCount
  });
  publicAccountingResultOutputs.forEach((output) => {
    assert(output.outputRef && typeof output.outputRef === 'object' && !Array.isArray(output.outputRef),
      'Carbon connected accounting result 公共 output 必须包含安全引用。');
    assert.deepStrictEqual(
      Object.keys(output.outputRef).sort(),
      ['emissionUnit', 'emissionValue', 'missingReason', 'status'],
      'Carbon connected accounting result 公共引用必须保持递归显式白名单。'
    );
    assert(['calculated', 'factor_missing'].includes(output.outputRef.status),
      'Carbon connected accounting result 公共引用必须保留稳定业务状态。');
  });
  const derivedFacts = db.prepare(`SELECT entity_type AS entityType, entity_pk AS entityPk
    FROM demo_data_registry WHERE run_id = ? AND ownership_kind = 'derived' AND cleaned_at IS NULL
    ORDER BY registry_id`).all(demoRun.runId)
    .map((row) => `${row.entityType}:${row.entityPk}`).sort();
  assert.deepStrictEqual(derivedFacts, expectedOutputFacts,
    'Carbon connected derived ownership 必须精确对应真实 outputs。');

  const relationRows = db.prepare(`SELECT relation_type AS relationType,
      source.entity_type AS sourceEntityType, source.entity_pk AS sourceEntityPk,
      target.entity_type AS targetEntityType, target.entity_pk AS targetEntityPk
    FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.run_id = ? ORDER BY relation.relation_id`).all(demoRun.runId);
  const expectedRelations = [];
  resultRows.forEach((row) => {
    expectedRelations.push(
      `contains:carbon_calculation_run:${calculationRunId}->carbon_accounting_result:${row.id}`,
      `generated_from:carbon_accounting_result:${row.id}->carbon_activity_record:${row.activityRecordId}`
    );
    if (row.status === 'calculated') {
      expectedRelations.push(
        `uses_factor:carbon_accounting_result:${row.id}->carbon_factor:${row.carbonFactorId}`
      );
    }
  });
  assert.deepStrictEqual(
    relationRows.map((row) => `${row.relationType}:${row.sourceEntityType}:${row.sourceEntityPk}`
      + `->${row.targetEntityType}:${row.targetEntityPk}`).sort(),
    expectedRelations.sort(),
    'Carbon connected relation 必须精确连接 calculation run、results 与 imported inputs。'
  );
  assert.deepStrictEqual(readCarbonConnectedState(db, demoRun.runId), {
    ...stateBeforeExecute,
    calculationRuns: stateBeforeExecute.calculationRuns + 1,
    accountingResults: stateBeforeExecute.accountingResults + resultRows.length,
    domainAudits: stateBeforeExecute.domainAudits + 1,
    derivedOwnership: stateBeforeExecute.derivedOwnership + expectedOutputFacts.length,
    relations: stateBeforeExecute.relations + expectedRelations.length,
    outputs: stateBeforeExecute.outputs + expectedOutputFacts.length,
    executeAudits: stateBeforeExecute.executeAudits + 1
  });

  const status = getDemoPostActionStatus({
    db,
    actionRunId: preview.actionRunId,
    actorUserId: actor.userId
  });
  assert.deepStrictEqual(status, succeeded);
  const stateBeforeReplay = readCarbonConnectedState(db, demoRun.runId);
  const replayedPreview = previewDemoPostAction({
    db,
    runId: demoRun.runId,
    actionKey: 'carbon-accounting-run',
    actorUserId: actor.userId,
    body: { clientRequestId }
  });
  const replayedExecute = executeDemoPostAction({
    db,
    actionRunId: preview.actionRunId,
    actorUserId: actor.userId,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: definition.confirmationText
    }
  });
  assert.deepStrictEqual(replayedPreview, succeeded);
  assert.deepStrictEqual(replayedExecute, succeeded);
  assert.deepStrictEqual(readCarbonConnectedState(db, demoRun.runId), stateBeforeReplay,
    'Carbon connected terminal replay 不得重复写入业务、ownership、relation、output 或审计。');
  return {
    actionRunId: preview.actionRunId,
    calculationRunId,
    resultCount: resultRows.length,
    outputCount: expectedOutputFacts.length,
    relationCount: expectedRelations.length
  };
}

/** 读取当前 managed strategy run 的业务治理计数，供重复 execute 前后精确比较。 */
function readManagedStrategyRunState(db, runId) {
  return {
    timeseriesOwnership: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '15-energy-timeseries'
        AND entity_type = 'energy_timeseries' AND ownership_kind = 'imported'
        AND cleaned_at IS NULL`).get(runId).total),
    ruleOwnership: Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '18-strategy-rules'
        AND entity_type = 'strategy_rule' AND ownership_kind = 'imported'
        AND cleaned_at IS NULL`).get(runId).total),
    relations: Number(db.prepare('SELECT COUNT(*) AS total FROM demo_data_relations WHERE run_id = ?').get(runId).total),
    evaluations: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total),
    hits: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total)
  };
}

/** 在 full integration 中按指定顺序验证 managed artifact 15/18 的跨导入闭包和重复 execute 幂等。 */
async function runManagedStrategyInputIntegration(db, actor, order, label, variant) {
  if (!['forward', 'reverse'].includes(variant)) {
    throw new Error(`${label} 必须声明 forward 或 reverse managed variant。`);
  }
  assert.deepStrictEqual([...order].sort(), [
    '15-energy-timeseries',
    '18-strategy-rules'
  ].sort(), `${label} 必须只验证 artifact 15/18 两种顺序。`);
  toggleDemoRuntime({ enabled: true, actorUserId: actor.userId });
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: actor.userId });
  const artifactContext = (artifactKey, context) => ({
    token: context.token,
    userId: actor.userId,
    artifactKey,
    handlerKey: getDemoArtifactRegistration(artifactKey).handlerKey
  });
  const executeManagedArtifact = async (artifactKey, suffix) => {
    const file = createManagedStrategyArtifactUpload(artifactKey, variant);
    const context = createDemoContext({
      db,
      userId: actor.userId,
      runId: run.runId,
      artifactKey,
      handlerKey: getDemoArtifactRegistration(artifactKey).handlerKey,
      artifactFileSha256: sha256Buffer(file.buffer)
    });
    const demoContext = artifactContext(artifactKey, context);
    const options = { ...getAnalysisOptions(db, actor), demoContext };
    const preview = artifactKey === '15-energy-timeseries'
      ? previewEnergyTimeseriesImport(file, options)
      : previewStrategyRuleImport(file, options);
    const relationCountBeforeExecute = Number(db.prepare(`SELECT COUNT(*) AS total
      FROM demo_data_relations WHERE run_id = ?`).get(run.runId).total);
    const executed = artifactKey === '15-energy-timeseries'
      ? await executeEnergyTimeseriesImport(buildAnalysisExecuteBody(preview), options)
      : await executeStrategyRuleImport(buildAnalysisExecuteBody(preview), options);
    assert.strictEqual(db.prepare('SELECT status FROM demo_import_contexts WHERE context_id = ?')
      .get(context.contextId).status, 'executed', `${label} ${suffix} context 必须完成 CAS。`);
    return { context, preview, executed, relationCountBeforeExecute };
  };

  const strategyRunCountsBefore = {
    evaluations: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total),
    hits: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total)
  };
  const firstImport = await executeManagedArtifact(order[0], 'first');
  assert.strictEqual(firstImport.relationCountBeforeExecute, 0,
    `${label} 首个 artifact 执行前不得存在策略输入关系。`);
  assert.strictEqual(firstImport.executed.ownership.relationCount, 0,
    `${label} 首个 artifact 尚无 counterpart 时不得生成不完整策略输入关系。`);

  const secondImport = await executeManagedArtifact(order[1], 'second');
  const expectedRelationCount = Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '15-energy-timeseries'
      AND entity_type = 'energy_timeseries' AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(run.runId).total)
    * Number(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
      WHERE run_id = ? AND artifact_key = '18-strategy-rules'
        AND entity_type = 'strategy_rule' AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(run.runId).total);
  assert.strictEqual(secondImport.relationCountBeforeExecute, 0,
    `${label} counterpart execute 前 preview 不得预先补写策略输入关系。`);
  assert.strictEqual(secondImport.executed.ownership.relationCount, expectedRelationCount,
    `${label} 第二个 artifact execute 必须生成完整 T × R 闭包。`);

  const relationRows = db.prepare(`SELECT relation.relation_type AS relationType,
      source.artifact_key AS sourceArtifactKey, source.entity_type AS sourceEntityType,
      source.entity_pk AS sourceEntityPk, target.artifact_key AS targetArtifactKey,
      target.entity_type AS targetEntityType, target.entity_pk AS targetEntityPk,
      source.ownership_kind AS sourceOwnershipKind, target.ownership_kind AS targetOwnershipKind,
      relation.run_id AS relationRunId, source.run_id AS sourceRunId, target.run_id AS targetRunId
    FROM demo_data_relations relation
    JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
    JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
    WHERE relation.run_id = ? AND source.run_id = ? AND target.run_id = ?
    ORDER BY relation.relation_id`).all(run.runId, run.runId, run.runId);
  assert.strictEqual(relationRows.length, expectedRelationCount,
    `${label} relation 数量必须等于完整 T × R 基数。`);
  const expectedRelationPairs = new Set();
  const timeseriesEntityPks = db.prepare(`SELECT entity_pk AS entityPk FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '15-energy-timeseries' AND entity_type = 'energy_timeseries'
      AND ownership_kind = 'imported' AND cleaned_at IS NULL ORDER BY registry_id`).all(run.runId)
    .map((row) => String(row.entityPk));
  const ruleEntityPks = db.prepare(`SELECT entity_pk AS entityPk FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '18-strategy-rules' AND entity_type = 'strategy_rule'
      AND ownership_kind = 'imported' AND cleaned_at IS NULL ORDER BY registry_id`).all(run.runId)
    .map((row) => String(row.entityPk));
  timeseriesEntityPks.forEach((timeseriesEntityPk) => ruleEntityPks.forEach((ruleEntityPk) => {
    expectedRelationPairs.add(`${timeseriesEntityPk}->${ruleEntityPk}`);
  }));
  const actualRelationPairs = new Set();
  relationRows.forEach((relation) => {
    assert.deepStrictEqual({
      relationType: relation.relationType,
      sourceArtifactKey: relation.sourceArtifactKey,
      sourceEntityType: relation.sourceEntityType,
      targetArtifactKey: relation.targetArtifactKey,
      targetEntityType: relation.targetEntityType,
      sourceOwnershipKind: relation.sourceOwnershipKind,
      targetOwnershipKind: relation.targetOwnershipKind,
      relationRunId: relation.relationRunId,
      sourceRunId: relation.sourceRunId,
      targetRunId: relation.targetRunId
    }, {
      relationType: 'uses_config',
      sourceArtifactKey: '15-energy-timeseries',
      sourceEntityType: 'energy_timeseries',
      targetArtifactKey: '18-strategy-rules',
      targetEntityType: 'strategy_rule',
      sourceOwnershipKind: 'imported',
      targetOwnershipKind: 'imported',
      relationRunId: run.runId,
      sourceRunId: run.runId,
      targetRunId: run.runId
    });
    actualRelationPairs.add(`${relation.sourceEntityPk}->${relation.targetEntityPk}`);
  });
  assert.deepStrictEqual(actualRelationPairs, expectedRelationPairs,
    `${label} relation 必须精确覆盖每个时序到每个规则的方向闭包。`);
  assert.deepStrictEqual({
    evaluations: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total),
    hits: Number(db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total)
  }, strategyRunCountsBefore, `${label} managed ownership 不得创建 strategy run 或 hit。`);

  // 使用相同 managed 文件创建全 skipped execute，验证两条执行路径均返回既有闭包且不新增事实。
  const stateBeforeDuplicates = readManagedStrategyRunState(db, run.runId);
  for (const artifactKey of order) {
    const duplicate = await executeManagedArtifact(artifactKey, 'duplicate');
    assert.strictEqual(duplicate.preview.expectedWouldImport, 0,
      `${label} ${artifactKey} duplicate preview 必须全部 skip。`);
    assert.strictEqual(duplicate.executed.imported, 0);
    assert.strictEqual(duplicate.executed.ownership.noInsertedRecords, true);
    assert.strictEqual(duplicate.executed.ownership.relationCount, expectedRelationCount,
      `${label} ${artifactKey} duplicate execute 必须返回既有完整闭包。`);
    assert.deepStrictEqual(readManagedStrategyRunState(db, run.runId), stateBeforeDuplicates,
      `${label} ${artifactKey} duplicate execute 不得新增业务、ownership、relation、run 或 hit。`);
  }
  return {
    run,
    order: [...order],
    timeseriesCount: timeseriesEntityPks.length,
    ruleCount: ruleEntityPks.length,
    relationCount: expectedRelationCount
  };
}

/** 将已完成的 managed strategy 测试 run 标记为 cleaned，以便隔离验证相反导入顺序。 */
function markManagedStrategyRunCleaned(db, runId) {
  db.prepare(`UPDATE demo_dataset_runs SET status = 'cleaned', cleaned_at = ?
    WHERE run_id = ? AND status = 'active'`).run(new Date().toISOString(), runId);
}

/** 返回四项正式无状态导入服务所需的隔离数据库、原文件目录和操作者。 */
function getFormalImportOptions(db, actor) {
  return {
    db,
    uploadsDir: temporaryUploadsDir,
    actor,
    createBackup
  };
}

/** 断言正式导入 preview 只留下审计和原文件见证，不写领域业务事实。 */
function assertFormalPreviewReadOnly(db, before, after, artifactKey) {
  assert.deepStrictEqual(after, before, `${artifactKey} preview 不得写入业务事实。`);
}

/** 从隔离库精确读取正式导入批次审计字段，避免测试只依赖服务返回值。 */
function selectFormalImportBatchAudit(db, batchId) {
  return db.prepare(`SELECT id,
      import_type AS importType,
      original_filename AS originalFilename,
      stored_filename AS storedFilename,
      file_type AS fileType,
      file_size_bytes AS fileSizeBytes,
      file_sha256 AS fileSha256,
      status,
      audit_phase AS auditPhase,
      preview_signature AS previewSignature,
      preview_audit_digest AS previewAuditDigest,
      audit_context_json AS auditContextJson,
      execute_result_json AS executeResultJson,
      backup_json AS backupJson,
      total_rows AS totalRows,
      success_count AS successCount,
      failure_count AS failureCount,
      skipped_count AS skippedCount,
      duplicate_strategy AS duplicateStrategy,
      field_mapping_json AS fieldMappingJson,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      error_summary AS errorSummary
    FROM import_batches WHERE id = ?`).get(batchId);
}

/** 读取指定批次的完整导入错误明细，用于重复执行前后副作用比较。 */
function selectImportErrorsForBatch(db, batchId) {
  return db.prepare(`SELECT id,
      batch_id AS batchId,
      row_number AS rowNumber,
      field_name AS fieldName,
      raw_value AS rawValue,
      error_code AS errorCode,
      error_reason AS errorReason,
      severity,
      created_at AS createdAt
    FROM import_errors WHERE batch_id = ? ORDER BY id`).all(batchId);
}

/** 读取正式导入领域操作审计，用于确认零候选 execute 不新增操作日志。 */
function selectFormalImportOperations(db, operationPrefix) {
  return db.prepare(`SELECT id,
      user_id AS userId,
      operation,
      target_type AS targetType,
      target_id AS targetId,
      detail_json AS detailJson,
      ip,
      created_at AS createdAt
    FROM sys_operation_logs WHERE operation LIKE ? ORDER BY id`).all(`${operationPrefix}.%`);
}

/** 将 SQLite 标识符安全引用，允许按真实 schema 动态读取业务表。 */
function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

/** 按排序后的显式列投影读取单表快照，避免依赖 schema 列定义顺序。 */
function snapshotDatabaseTable(db, tableName) {
  const quotedTableName = quoteSqlIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${quotedTableName})`).all();
  const columnNames = columns.map((column) => column.name).sort();
  const selectedColumns = columnNames.map(quoteSqlIdentifier).join(', ');
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => quoteSqlIdentifier(column.name));
  const orderBy = primaryKeyColumns.length > 0 ? primaryKeyColumns.join(', ') : 'rowid';
  return {
    columns: columnNames,
    rows: db.prepare(`SELECT ${selectedColumns} FROM ${quotedTableName} ORDER BY ${orderBy}`).all()
  };
}

/** 对指定业务表读取完整行快照，覆盖业务事实而非只比较记录数量。 */
function snapshotFormalImportTables(db, tableNames) {
  return Object.fromEntries(tableNames.map((tableName) => [
    tableName,
    snapshotDatabaseTable(db, tableName).rows
  ]));
}

/** 读取隔离库全部用户表快照，覆盖任意审计日志和跨报告业务副作用。 */
function snapshotAllDatabaseTables(db) {
  const tableNames = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `).all().map((row) => row.name);
  return Object.fromEntries(tableNames.map((tableName) => [
    tableName,
    snapshotDatabaseTable(db, tableName)
  ]));
}

/** 递归收集备份目录相对路径、类型、文件大小和内容摘要。 */
function collectBackupDirectoryEntries(rootDirectory, currentDirectory, snapshots) {
  const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)));
  entries.forEach((entry) => {
    const entryPath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(rootDirectory, entryPath).split(path.sep).join('/');
    const stats = fs.lstatSync(entryPath);
    const isFile = entry.isFile();
    snapshots.push({
      relativePath,
      kind: entry.isDirectory() ? 'directory' : (isFile ? 'file' : 'other'),
      sizeBytes: isFile ? stats.size : null,
      sha256: isFile
        ? crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')
        : null
    });
    if (entry.isDirectory()) {
      collectBackupDirectoryEntries(rootDirectory, entryPath, snapshots);
    }
  });
}

/** 读取备份目录稳定文件列表和内容摘要，不绑定文件系统时间或权限元数据。 */
function snapshotBackupDirectory() {
  const snapshots = [];
  collectBackupDirectoryEntries(temporaryBackupsDir, temporaryBackupsDir, snapshots);
  return snapshots;
}

/** 汇总重复 execute 前的全局数据库和正式审计快照，禁止遗漏跨域事实。 */
function snapshotFormalDuplicateExecuteState(db) {
  const allTables = snapshotAllDatabaseTables(db);
  return {
    allTables,
    importBatches: allTables.import_batches.rows,
    importErrors: allTables.import_errors.rows,
    operationLogs: allTables.sys_operation_logs.rows
  };
}

/** 断言正式导入 preview 已按真实数据库字段持久化完整审计见证。 */
function assertFormalPreviewAudit(db, batchId, importType, operationPrefix, file, preview) {
  const batch = selectFormalImportBatchAudit(db, batchId);
  assert(batch, `${importType} preview 必须持久化批次。`);
  const expectedStatus = Number(preview.summary.blocked || 0) > 0 || Number(preview.summary.skipped || 0) > 0
    ? 'completed_with_errors'
    : 'completed';
  assert.deepStrictEqual({
    importType: batch.importType,
    originalFilename: batch.originalFilename,
    storedFilename: batch.storedFilename,
    fileType: batch.fileType,
    fileSizeBytes: Number(batch.fileSizeBytes),
    fileSha256: batch.fileSha256,
    status: batch.status,
    auditPhase: batch.auditPhase,
    totalRows: Number(batch.totalRows),
    successCount: Number(batch.successCount),
    failureCount: Number(batch.failureCount),
    skippedCount: Number(batch.skippedCount),
    duplicateStrategy: batch.duplicateStrategy
  }, {
    importType,
    originalFilename: file.originalname,
    storedFilename: file.filename,
    fileType: 'xlsx',
    fileSizeBytes: file.size,
    fileSha256: preview.fileSha256,
    status: expectedStatus,
    auditPhase: 'preview',
    totalRows: preview.summary.totalRows,
    successCount: preview.summary.wouldImport,
    failureCount: preview.summary.blocked,
    skippedCount: preview.summary.skipped,
    duplicateStrategy: 'skip'
  });
  assert.strictEqual(batch.previewSignature, preview.previewSignature, `${importType} preview_signature 必须与服务返回一致。`);
  assert.strictEqual(batch.previewAuditDigest, preview.previewAuditDigest, `${importType} preview_audit_digest 必须与服务返回一致。`);
  assert(batch.auditContextJson, `${importType} preview 必须持久化 audit_context_json。`);
  assert(batch.fieldMappingJson, `${importType} preview 必须持久化 field_mapping_json。`);
  assert.strictEqual(batch.executeResultJson, null, `${importType} execute 前不得持久化 execute_result_json。`);
  assert.strictEqual(batch.backupJson, null, `${importType} execute 前不得持久化 backup_json。`);
  assert(batch.startedAt, `${importType} preview 必须持久化 started_at。`);
  assert(batch.finishedAt, `${importType} preview 必须持久化 finished_at。`);
  assert.strictEqual(batch.errorSummary, null, `${importType} 首次 preview 不应产生错误摘要。`);

  const auditContext = JSON.parse(batch.auditContextJson);
  assert.deepStrictEqual({
    templateType: auditContext.templateType,
    operation: auditContext.operation,
    recordKind: auditContext.recordKind,
    importTypes: auditContext.importTypes,
    duplicateStrategy: auditContext.duplicateStrategy,
    summary: auditContext.summary,
    candidateRowIds: auditContext.candidateRowIds,
    candidateRows: auditContext.candidateRows,
    previewAudit: auditContext.previewAudit
  }, {
    templateType: preview.templateType,
    operation: preview.operation,
    recordKind: preview.recordKind,
    importTypes: preview.importTypes,
    duplicateStrategy: 'skip',
    summary: preview.summary,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    previewAudit: preview.previewAudit
  });
  assert.deepStrictEqual(JSON.parse(batch.fieldMappingJson), preview.fieldMapping);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = ?`).get(`${operationPrefix}.preview`).total, 1);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = ?`).get(`${operationPrefix}.execute`).total, 0);
}

/** 断言正式导入批次完成备份、执行结果和 preview/execute 操作审计，并精确核对 import_type。 */
function assertFormalAuditAndBackup(db, batchId, importType, operationPrefix, file) {
  const batch = db.prepare(`SELECT import_type AS importType, status, audit_phase AS auditPhase,
      stored_filename AS storedFilename, backup_json AS backupJson,
      execute_result_json AS executeResultJson
    FROM import_batches WHERE id = ?`).get(batchId);
  assert(batch, `${importType} 必须持久化批次。`);
  assert.strictEqual(batch.importType, importType);
  assert.strictEqual(batch.status, 'completed');
  assert.strictEqual(batch.auditPhase, 'execute');
  assert.strictEqual(batch.storedFilename, file.filename);
  assert(batch.backupJson, `${importType} 必须持久化 backup_json。`);
  assert(batch.executeResultJson, `${importType} 必须持久化 execute_result_json。`);
  const backup = JSON.parse(batch.backupJson);
  assert.strictEqual(JSON.parse(batch.executeResultJson).executed, true);
  assert(fs.existsSync(path.join(temporaryBackupsDir, backup.backupName)), `${importType} 必须生成真实隔离 SQLite 备份。`);
  assert(fs.existsSync(path.join(temporaryUploadsDir, file.filename)), `${importType} 原上传文件必须保留。`);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = ?`).get(`${operationPrefix}.preview`).total, 1);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM sys_operation_logs
    WHERE operation = ?`).get(`${operationPrefix}.execute`).total, 1);
}

/** 断言正式导入零候选 execute 按生产契约拒绝且不产生任何数据库或备份副作用。 */
async function assertFormalDuplicateExecuteRejected({
  db,
  preview,
  importType,
  operationPrefix,
  confirmText,
  expectedSummary,
  expectedIssueCode,
  execute,
  options,
  tableNames
}) {
  assert.deepStrictEqual(preview.summary, expectedSummary, `${importType} 重复 preview 汇总必须精确匹配生产契约。`);
  assert.strictEqual(preview.confirmText, confirmText);
  assert.strictEqual(preview.candidateRows.length, 0);
  const batchBefore = selectFormalImportBatchAudit(db, preview.batchId);
  assert(batchBefore, `${importType} 重复 preview 必须持久化批次。`);
  assert.deepStrictEqual({
    importType: batchBefore.importType,
    status: batchBefore.status,
    auditPhase: batchBefore.auditPhase,
    totalRows: Number(batchBefore.totalRows),
    successCount: Number(batchBefore.successCount),
    failureCount: Number(batchBefore.failureCount),
    skippedCount: Number(batchBefore.skippedCount),
    duplicateStrategy: batchBefore.duplicateStrategy,
    executeResultJson: batchBefore.executeResultJson,
    backupJson: batchBefore.backupJson
  }, {
    importType,
    status: 'completed_with_errors',
    auditPhase: 'preview',
    totalRows: expectedSummary.totalRows,
    successCount: 0,
    failureCount: expectedSummary.blocked,
    skippedCount: expectedSummary.skipped,
    duplicateStrategy: 'skip',
    executeResultJson: null,
    backupJson: null
  });
  assert.strictEqual(typeof batchBefore.errorSummary, 'string', `${importType} 重复 preview 必须持久化结构化错误摘要字段。`);
  assert(batchBefore.errorSummary.trim().length > 0, `${importType} 重复 preview 错误摘要不得为空。`);
  const businessBefore = snapshotFormalImportTables(db, tableNames);
  const errorsBefore = selectImportErrorsForBatch(db, preview.batchId);
  assert.strictEqual(errorsBefore.length, preview.auditIssues.length);
  assert.strictEqual(errorsBefore.every((issue) => issue.errorCode === expectedIssueCode), true, `${importType} 错误明细编码不匹配：${JSON.stringify(errorsBefore)}`);
  assert.deepStrictEqual(errorsBefore.map((issue) => ({
    rowNumber: issue.rowNumber,
    fieldName: issue.fieldName,
    rawValue: issue.rawValue,
    errorCode: issue.errorCode,
    errorReason: issue.errorReason,
    severity: issue.severity
  })), preview.auditIssues.map((issue) => ({
    rowNumber: issue.rowNumber,
    fieldName: issue.fieldName,
    rawValue: issue.rawValue,
    errorCode: issue.code,
    errorReason: issue.message,
    severity: issue.severity
  })));
  const operationsBefore = selectFormalImportOperations(db, operationPrefix);
  const duplicatePreviewOperations = operationsBefore.filter((operation) => (
    operation.operation === `${operationPrefix}.preview`
      && operation.targetId === String(preview.batchId)
  ));
  assert.strictEqual(duplicatePreviewOperations.length, 1);
  assert.strictEqual(duplicatePreviewOperations[0].targetType, importType);
  assert.deepStrictEqual(JSON.parse(duplicatePreviewOperations[0].detailJson), {
    batchId: preview.batchId,
    fileSha256: preview.fileSha256,
    summary: expectedSummary
  });
  const stateBefore = snapshotFormalDuplicateExecuteState(db);
  const backupsBefore = snapshotBackupDirectory();
  const originalCreateBackup = options.createBackup;
  let backupCallCount = 0;
  // 备份调用计数器证明零候选拒绝发生在备份服务调用之前。
  options.createBackup = async (...args) => {
    backupCallCount += 1;
    return originalCreateBackup(...args);
  };

  let caughtError = null;
  try {
    await execute();
  } catch (error) {
    caughtError = error;
  } finally {
    options.createBackup = originalCreateBackup;
  }
  assert(caughtError, `${importType} 零候选 execute 必须拒绝。`);
  assert.strictEqual(caughtError.code, 'BAD_REQUEST');
  assert.strictEqual(caughtError.statusCode, 400);
  assert.deepStrictEqual(caughtError.details, { code: 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED' });

  const stateAfter = snapshotFormalDuplicateExecuteState(db);
  assert.deepStrictEqual(snapshotFormalImportTables(db, tableNames), businessBefore, `${importType} 重复 execute 不得新增或修改声明的业务事实。`);
  assert.deepStrictEqual(stateAfter.importBatches, stateBefore.importBatches, `${importType} 重复 execute 不得新增或更新任何 import_batches 行。`);
  assert.deepStrictEqual(stateAfter.importErrors, stateBefore.importErrors, `${importType} 重复 execute 不得新增、删除或更新任何 import_errors 行。`);
  assert.deepStrictEqual(stateAfter.operationLogs, stateBefore.operationLogs, `${importType} 重复 execute 不得新增、删除或更新任何 sys_operation_logs 行。`);
  assert.deepStrictEqual(stateAfter.allTables, stateBefore.allTables, `${importType} 重复 execute 不得改变隔离库任何用户表事实。`);
  assert.deepStrictEqual(snapshotBackupDirectory(), backupsBefore, `${importType} 零候选 execute 不得改变备份目录文件或元数据。`);
  assert.strictEqual(backupCallCount, 0, `${importType} 零候选 execute 不得调用备份服务。`);
  assert.deepStrictEqual(selectFormalImportBatchAudit(db, preview.batchId), batchBefore, `${importType} 零候选 execute 不得改变当前批次完整审计状态。`);
}

/** 断言普通上传即执行结果遵守当前批次详情 + summary 固定契约并确实写入数据。 */
function assertImmediateImport(result, artifactKey) {
  assert(result && result.summary, `${artifactKey} 首次导入必须返回批次详情及 summary：${JSON.stringify(result)}`);
  assert.strictEqual(Number(result.summary.batchId), Number(result.id), `${artifactKey} 批次详情 ID 必须与 summary.batchId 一致。`);
  assert(Number(result.summary.successCount) > 0, `${artifactKey} 首次导入必须写入业务记录：${JSON.stringify(result)}`);
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
      const managed = createManagedDemoImportContext(db, actor, context.demoRun, artifact, file);
      const result = createImportBatchFromUpload(file, {
        duplicateStrategy: 'skip',
        demoContext: managed.demoContext
      });
      assertImmediateImport(result, artifact.artifactKey);
      assert.strictEqual(result.terminalReplay, false);
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM demo_data_registry
        WHERE run_id = ? AND artifact_key = '07-monthly-energy'
          AND entity_type = 'energy_record' AND source_batch_id = ?
          AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(
        context.demoRun.runId,
        result.id
      ).total, result.summary.successCount);
      assert.strictEqual(db.prepare(`SELECT status FROM demo_import_contexts
        WHERE context_id = ?`).get(managed.context.contextId).status, 'executed');
      context.monthlyEnergyBatchId = Number(result.id);
      assert(Number.isSafeInteger(context.monthlyEnergyBatchId), '07 月度能耗导入批次详情必须返回真实 id。');
      assert.strictEqual(Number(result.summary.batchId), context.monthlyEnergyBatchId, '07 月度能耗 summary.batchId 必须与批次详情 id 一致。');
      assert.notStrictEqual(context.monthlyEnergyBatchId, 7, '全链路不得依赖固定批次 ID 7。');
      const sourceBatch = db.prepare(
        'SELECT id, import_type AS importType, success_count AS successCount FROM import_batches WHERE id = ?'
      ).get(context.monthlyEnergyBatchId);
      assert.deepStrictEqual(sourceBatch, {
        id: context.monthlyEnergyBatchId,
        importType: 'energy_record',
        successCount: artifact.rows.length
      });
      // artifact 07 首次导入必须写入 70 条，其中实际样例企业独立形成 59 条无仪表历史事实。
      const actualEnergySummary = db.prepare(`SELECT COUNT(*) AS total,
          MIN(er.normalized_month) AS minMonth,
          MAX(er.normalized_month) AS maxMonth,
          SUM(CASE WHEN er.meter_device_id IS NULL THEN 1 ELSE 0 END) AS withoutMeter
        FROM energy_records er
        JOIN organization_units ou ON ou.id = er.organization_unit_id
        WHERE er.source_batch_id = ?
          AND er.record_status = 'active'
          AND ou.unit_code = 'QL-ACTUAL-PARK'`).get(context.monthlyEnergyBatchId);
      assert.deepStrictEqual(actualEnergySummary, {
        total: 59,
        minMonth: '2024-03',
        maxMonth: '2026-03',
        withoutMeter: 59
      });
      const linkedEnergyCount = Number(db.prepare(`SELECT COUNT(*) AS total
        FROM energy_records er
        JOIN organization_units ou ON ou.id = er.organization_unit_id
        WHERE er.source_batch_id = ?
          AND er.record_status = 'active'
          AND ou.unit_code <> 'QL-ACTUAL-PARK'`).get(context.monthlyEnergyBatchId).total);
      assert.strictEqual(linkedEnergyCount, 11, '天坤集团原 11 条预测、预算和抄表联动事实必须保持不变。');
      const actualEnergyTypeCounts = db.prepare(`SELECT et.code, COUNT(*) AS total
        FROM energy_records er
        JOIN energy_types et ON et.id = er.energy_type_id
        JOIN organization_units ou ON ou.id = er.organization_unit_id
        WHERE er.source_batch_id = ?
          AND er.record_status = 'active'
          AND ou.unit_code = 'QL-ACTUAL-PARK'
        GROUP BY et.code
        ORDER BY et.code`).all(context.monthlyEnergyBatchId);
      assert.deepStrictEqual(actualEnergyTypeCounts, [
        { code: 'diesel', total: 2 },
        { code: 'electricity', total: 25 },
        { code: 'natural_gas', total: 7 },
        { code: 'water', total: 25 }
      ]);
      return result;
    }
    case '08-meter-readings-2026-08': {
      const energyCountBefore = Number(db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE record_status = 'active'").get().total);
      const result = createMeterReadingImportBatchFromUpload(file, { duplicateStrategy: 'skip' });
      assertImmediateImport(result, artifact.artifactKey);
      const energyCountAfter = Number(db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE record_status = 'active'").get().total);
      assert.strictEqual(energyCountAfter, energyCountBefore, 'artifact 08 导入只能写抄表记录，不得自动联动能耗记录。');
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
      const managed = createManagedDemoImportContext(db, actor, context.demoRun, artifact, file);
      const options = {
        ...getFormalImportOptions(db, actor),
        demoContext: managed.demoContext
      };
      const preview = createCarbonFactorImportPreviewFromUpload(file, options);
      assert(preview.summary.wouldImport > 0);
      const result = await executeCarbonFactorImport({
        batchId: preview.batchId,
        confirmText: CARBON_FACTOR_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, preview.summary.wouldImport);
      assert.strictEqual(result.ownership.registrationCount, result.imported);
      assert.strictEqual(db.prepare(`SELECT status FROM demo_import_contexts
        WHERE context_id = ?`).get(managed.context.contextId).status, 'executed');
      return result;
    }
    case '12-prediction-configs': {
      assert(Number.isSafeInteger(context.monthlyEnergyBatchId), '预测配置导入前必须取得 artifact 07 的真实批次 ID。');
      const managed = createManagedDemoImportContext(db, actor, context.demoRun, artifact, file);
      const options = {
        ...getFormalImportOptions(db, actor),
        demoContext: managed.demoContext
      };
      const preview = createPredictionConfigImportPreviewFromUpload(file, options);
      assert.strictEqual(preview.summary.wouldImport, 1);
      assert.strictEqual(preview.candidateRows[0].sourceBatchFilterId, null, 'Artifact 12 文件不得携带或猜测 Artifact 07 自增批次。');
      const result = await executePredictionConfigImport({
        batchId: preview.batchId,
        confirmText: PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.sourceTrainingBatchId, context.monthlyEnergyBatchId);
      assert.strictEqual(result.importedRecords[0].sourceBatchId, preview.batchId);
      assert.strictEqual(result.importedRecords[0].sourceBatchFilterId, context.monthlyEnergyBatchId);
      assert.strictEqual(result.importedRecords[0].status, 'draft');
      assert.strictEqual(result.ownership.registrationCount, 1);
      assert.strictEqual(db.prepare(`SELECT status FROM demo_import_contexts
        WHERE context_id = ?`).get(managed.context.contextId).status, 'executed');
      return result;
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
      assert.strictEqual(preview.expectedWouldImport, 4, '平衡边界和三个项目必须全部成为候选。');
      assert.strictEqual(preview.summary.blocked, 0, '平衡配置不得包含被静默忽略的阻断项目。');
      const body = buildAnalysisExecuteBody(preview, {
        boundaryBatchId: preview.boundaryBatchId,
        itemBatchId: preview.itemBatchId
      });
      return executeEnergyBalanceBundleImport(body, {
        ...analysisOptions,
        actor
      });
    }
    case '26-suppliers': {
      const options = getFormalImportOptions(db, actor);
      const before = { suppliers: Number(db.prepare('SELECT COUNT(*) AS total FROM suppliers').get().total) };
      const preview = previewSupplierImport(file, options);
      const afterPreview = { suppliers: Number(db.prepare('SELECT COUNT(*) AS total FROM suppliers').get().total) };
      assert.strictEqual(preview.summary.wouldImport, 3);
      assertFormalPreviewReadOnly(db, before, afterPreview, artifact.artifactKey);
      assertFormalPreviewAudit(db, preview.batchId, 'supplier', 'supplier.import', file, preview);
      const result = await executeSupplierImport({
        batchId: preview.batchId,
        confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, 3);
      assertFormalAuditAndBackup(db, preview.batchId, 'supplier', 'supplier.import', file);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE status = 'active'").get().total, 2);
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE status = 'inactive'").get().total, 1);
      assert.deepStrictEqual(db.prepare(`SELECT contact_phone AS contactPhone, typeof(contact_phone) AS storageType
        FROM suppliers WHERE supplier_code_key = 'QL-SUP-ELECTRIC'`).get(), {
        contactPhone: '010-66001234', storageType: 'text'
      });
      return result;
    }
    case '27-carbon-activities': {
      const managed = createManagedDemoImportContext(db, actor, context.demoRun, artifact, file);
      const options = {
        ...getFormalImportOptions(db, actor),
        demoContext: managed.demoContext
      };
      const before = {
        records: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      };
      const preview = previewCarbonActivityImport(file, options);
      assert.strictEqual(preview.summary.wouldImport, 2);
      const afterPreview = {
        records: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      };
      assertFormalPreviewReadOnly(db, before, afterPreview, artifact.artifactKey);
      assertFormalPreviewAudit(db, preview.batchId, 'carbon_activity', 'carbon.activity.import', file, preview);
      const result = await executeCarbonActivityImport({
        batchId: preview.batchId,
        confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.ownership.registrationCount, 2);
      assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total), before.records + 2);
      assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total), before.runs);
      assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total), before.results);
      assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total), before.emissions);
      assertFormalAuditAndBackup(db, preview.batchId, 'carbon_activity', 'carbon.activity.import', file);
      assert.strictEqual(db.prepare(`SELECT status FROM demo_import_contexts
        WHERE context_id = ?`).get(managed.context.contextId).status, 'executed');
      return result;
    }
    case '28-carbon-emission-report': {
      const options = getFormalImportOptions(db, actor);
      const tableNames = [
        'carbon_emission_reports', 'carbon_emission_report_boundaries',
        'carbon_emission_report_items', 'carbon_emission_report_summaries',
        'carbon_emission_report_evidence'
      ];
      const before = Object.fromEntries(tableNames.map((table) => [
        table, Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)
      ]));
      const protectedBefore = {
        activities: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      };
      const preview = previewCarbonEmissionReportImport(file, options);
      assert.strictEqual(preview.summary.wouldImport, 1);
      const afterPreview = Object.fromEntries(tableNames.map((table) => [
        table, Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)
      ]));
      assertFormalPreviewReadOnly(db, before, afterPreview, artifact.artifactKey);
      assertFormalPreviewAudit(db, preview.batchId, 'carbon_emission_report', 'carbon.emission-report.import', file, preview);
      const result = await executeCarbonEmissionReportImport({
        batchId: preview.batchId,
        confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, 1);
      const detail = getCarbonEmissionReportByBatch(preview.batchId);
      assert.strictEqual(detail.boundaries.length, 2);
      assert.strictEqual(detail.items.length, 2);
      assert.strictEqual(detail.summaries.length, 3);
      assert.strictEqual(detail.evidence.length, 2);
      assert.strictEqual(Math.round(detail.summaries.find((row) => row.summaryCode === 'QL-CER-TOTAL-202608').emissionValue * 1e9), 302927860000);
      assert.deepStrictEqual({
        activities: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      }, protectedBefore);
      assertFormalAuditAndBackup(db, preview.batchId, 'carbon_emission_report', 'carbon.emission-report.import', file);
      return result;
    }
    case '29-ghg-report': {
      const options = getFormalImportOptions(db, actor);
      const tableNames = [
        'ghg_reports', 'ghg_report_organization_boundaries',
        'ghg_report_operational_boundaries', 'ghg_report_items',
        'ghg_report_summaries', 'ghg_report_evidence'
      ];
      const before = Object.fromEntries(tableNames.map((table) => [
        table, Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)
      ]));
      const protectedBefore = {
        activities: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      };
      const preview = previewGhgReportImport(file, options);
      assert.strictEqual(preview.summary.wouldImport, 1);
      const afterPreview = Object.fromEntries(tableNames.map((table) => [
        table, Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)
      ]));
      assertFormalPreviewReadOnly(db, before, afterPreview, artifact.artifactKey);
      assertFormalPreviewAudit(db, preview.batchId, 'ghg_report', 'carbon.ghg-report.import', file, preview);
      const result = await executeGhgReportImport({
        batchId: preview.batchId,
        confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, options);
      assert.strictEqual(result.imported, 1);
      const detail = getGhgReportByBatch(preview.batchId);
      assert.strictEqual(detail.organizationBoundaries.length, 1);
      assert.strictEqual(detail.operationalBoundaries.length, 2);
      assert.strictEqual(detail.items.length, 2);
      assert.strictEqual(detail.summaries.length, 4);
      assert.strictEqual(detail.summaries.every((row) => Number(row.removalCo2e) === 0), true, '29 所有汇总清除量必须为零。');
      assert.strictEqual(detail.summaries.every((row) => Number(row.netCo2e) === Number(row.emissionCo2e) - Number(row.removalCo2e)), true, '29 汇总净值必须等于排放减清除。');
      assert.strictEqual(detail.evidence.length, 2);
      const totalSummary = detail.summaries.find((row) => row.summaryCode === 'QL-GHG-TOTAL-202608');
      assert(totalSummary, '29 必须包含总计汇总。');
      assert.strictEqual(Number(totalSummary.emissionCo2e), 302.92786);
      assert.deepStrictEqual({
        activities: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total),
        runs: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total),
        results: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total),
        emissions: Number(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total)
      }, protectedBefore);
      assertFormalAuditAndBackup(db, preview.batchId, 'ghg_report', 'carbon.ghg-report.import', file);
      return result;
    }
    default:
      assert.fail(`未实现 artifact handler：${artifact.artifactKey}`);
  }
}

/** 验证关键事实二次导入稳定 skip，禁止静默覆盖。 */
async function verifyDuplicateImports(context) {
  const { db, actor, analysisOptions } = context;

  const organizationResult = createOrganizationUnitImportBatchFromUpload(
    createArtifactUpload('01-organization-root', 'duplicate'),
    { duplicateStrategy: 'skip' }
  );
  assert.deepStrictEqual({
    batchId: Number(organizationResult.summary.batchId),
    status: organizationResult.summary.status,
    totalRows: organizationResult.summary.totalRows,
    successCount: organizationResult.summary.successCount,
    failureCount: organizationResult.summary.failureCount,
    skippedCount: organizationResult.summary.skippedCount
  }, {
    batchId: Number(organizationResult.id),
    status: 'completed_with_errors',
    totalRows: 2,
    successCount: 0,
    failureCount: 0,
    skippedCount: 2
  });

  const energyResult = createImportBatchFromUpload(
    createArtifactUpload('07-monthly-energy', 'duplicate'),
    { duplicateStrategy: 'skip' }
  );
  assert.deepStrictEqual({
    batchId: Number(energyResult.summary.batchId),
    status: energyResult.summary.status,
    totalRows: energyResult.summary.totalRows,
    successCount: energyResult.summary.successCount,
    failureCount: energyResult.summary.failureCount,
    skippedCount: energyResult.summary.skippedCount
  }, {
    batchId: Number(energyResult.id),
    status: 'completed_with_errors',
    totalRows: 70,
    successCount: 0,
    failureCount: 0,
    skippedCount: 70
  });

  const budgetPreview = createEnergyBudgetImportPreviewFromUpload(createArtifactUpload('10-energy-budgets', 'duplicate'));
  assert.deepStrictEqual({
    totalRows: budgetPreview.summary.totalRows,
    wouldImport: budgetPreview.summary.wouldImport,
    skipped: budgetPreview.summary.skipped,
    blocked: budgetPreview.summary.blocked
  }, { totalRows: 2, wouldImport: 0, skipped: 2, blocked: 0 });

  const strategyPreview = previewStrategyRuleImport(
    createArtifactUpload('18-strategy-rules', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(strategyPreview.expectedWouldImport, 0);
  assert.strictEqual(strategyPreview.summary.skipped, 1);

  const flowPreview = previewEnergyFlowModelImport(
    createArtifactUpload('22-energy-flow-models', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(flowPreview.expectedWouldImport, 0);
  assert.strictEqual(flowPreview.summary.skipped, 1);

  const conversionPreview = previewEnergyConversionFactorImport(
    createArtifactUpload('19-conversion-factors', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(conversionPreview.expectedWouldImport, 0);
  assert.strictEqual(conversionPreview.summary.skipped, 1);

  const benchmarkDefinitionPreview = previewEnergyBenchmarkDefinitionImport(
    createArtifactUpload('20-benchmark-definitions', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(benchmarkDefinitionPreview.expectedWouldImport, 0);
  assert.strictEqual(benchmarkDefinitionPreview.summary.skipped, 1);

  const benchmarkTargetPreview = previewEnergyBenchmarkTargetImport(
    createArtifactUpload('21-benchmark-targets', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(benchmarkTargetPreview.expectedWouldImport, 0);
  assert.strictEqual(benchmarkTargetPreview.summary.skipped, 1);

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
  assert.strictEqual(flowBundlePreview.edgePreview.summary.skipped, 1);
  assert.strictEqual(flowBundlePreview.recordPreview.summary.skipped, 1);

  const balancePreview = previewEnergyBalanceBundleImport(
    createArtifactUpload('25-energy-balance-configs', 'duplicate'),
    analysisOptions
  );
  assert.strictEqual(balancePreview.expectedWouldImport, 0);
  assert.strictEqual(balancePreview.boundaryPreview.summary.skipped, 1);
  assert.strictEqual(balancePreview.itemPreview.summary.skipped, 3);

  const formalOptions = getFormalImportOptions(db, actor);
  const supplierPreview = previewSupplierImport(
    createArtifactUpload('26-suppliers', 'duplicate'),
    formalOptions
  );
  assert.strictEqual(supplierPreview.summary.wouldImport, 0);
  assert.strictEqual(supplierPreview.summary.skipped, 3);
  assert.strictEqual(supplierPreview.candidateRows.length, 0);
  await assertFormalDuplicateExecuteRejected({
    db,
    preview: supplierPreview,
    importType: 'supplier',
    operationPrefix: 'supplier.import',
    confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
    expectedSummary: {
      totalRows: 3,
      wouldImport: 0,
      skipped: 3,
      blocked: 0,
      warnings: 3,
      errors: 0
    },
    expectedIssueCode: 'SUPPLIER_CODE_EXISTS_SKIPPED',
    execute: () => executeSupplierImport({
      batchId: supplierPreview.batchId,
      confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, formalOptions),
    options: formalOptions,
    tableNames: ['suppliers']
  });

  const carbonActivityPreview = previewCarbonActivityImport(
    createArtifactUpload('27-carbon-activities', 'duplicate'),
    formalOptions
  );
  assert.strictEqual(carbonActivityPreview.summary.wouldImport, 0);
  assert.strictEqual(carbonActivityPreview.summary.skipped + carbonActivityPreview.summary.blocked, 2);
  assert.strictEqual(carbonActivityPreview.candidateRows.length, 0);
  await assertFormalDuplicateExecuteRejected({
    db,
    preview: carbonActivityPreview,
    importType: 'carbon_activity',
    operationPrefix: 'carbon.activity.import',
    confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
    expectedSummary: {
      totalRows: 2,
      wouldImport: 0,
      skipped: 0,
      blocked: 2,
      warnings: 0,
      errors: 2
    },
    expectedIssueCode: 'CARBON_ACTIVITY_CODE_EXISTS',
    execute: () => executeCarbonActivityImport({
      batchId: carbonActivityPreview.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, formalOptions),
    options: formalOptions,
    tableNames: [
      'carbon_activity_records',
      'carbon_calculation_runs',
      'carbon_accounting_results',
      'carbon_emissions'
    ]
  });

  const carbonEmissionReportPreview = previewCarbonEmissionReportImport(
    createArtifactUpload('28-carbon-emission-report', 'duplicate'),
    formalOptions
  );
  assert.strictEqual(carbonEmissionReportPreview.summary.wouldImport, 0);
  assert.strictEqual(carbonEmissionReportPreview.candidateRows.length, 0);
  assert(carbonEmissionReportPreview.summary.skipped + carbonEmissionReportPreview.summary.blocked > 0);
  await assertFormalDuplicateExecuteRejected({
    db,
    preview: carbonEmissionReportPreview,
    importType: 'carbon_emission_report',
    operationPrefix: 'carbon.emission-report.import',
    confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
    expectedSummary: {
      totalRows: 1,
      wouldImport: 0,
      skipped: 0,
      blocked: 1,
      warnings: 0,
      errors: 1
    },
    expectedIssueCode: 'CARBON_EMISSION_REPORT_CODE_EXISTS',
    execute: () => executeCarbonEmissionReportImport({
      batchId: carbonEmissionReportPreview.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, formalOptions),
    options: formalOptions,
    tableNames: [
      'carbon_emission_reports',
      'carbon_emission_report_boundaries',
      'carbon_emission_report_items',
      'carbon_emission_report_summaries',
      'carbon_emission_report_evidence',
      'carbon_activity_records',
      'carbon_calculation_runs',
      'carbon_accounting_results',
      'carbon_emissions'
    ]
  });

  const ghgReportPreview = previewGhgReportImport(
    createArtifactUpload('29-ghg-report', 'duplicate'),
    formalOptions
  );
  assert.strictEqual(ghgReportPreview.summary.wouldImport, 0);
  assert.strictEqual(ghgReportPreview.candidateRows.length, 0);
  assert(ghgReportPreview.summary.skipped + ghgReportPreview.summary.blocked > 0);
  await assertFormalDuplicateExecuteRejected({
    db,
    preview: ghgReportPreview,
    importType: 'ghg_report',
    operationPrefix: 'carbon.ghg-report.import',
    confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
    expectedSummary: {
      totalRows: 1,
      wouldImport: 0,
      skipped: 0,
      blocked: 1,
      warnings: 0,
      errors: 1
    },
    expectedIssueCode: 'GHG_REPORT_CODE_EXISTS',
    execute: () => executeGhgReportImport({
      batchId: ghgReportPreview.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, formalOptions),
    options: formalOptions,
    tableNames: [
      'ghg_reports',
      'ghg_report_organization_boundaries',
      'ghg_report_operational_boundaries',
      'ghg_report_items',
      'ghg_report_summaries',
      'ghg_report_evidence',
      'carbon_activity_records',
      'carbon_calculation_runs',
      'carbon_accounting_results',
      'carbon_emissions'
    ]
  });
}

/** 主动验证抄表非联动边界，并执行核算、预测、分析、策略、对标、能流、平衡和中控断言。 */
function runDerivedOperations(db, actor, demoRun, monthlyEnergyBatchId) {
  const energyCountBeforePreview = Number(db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE record_status = 'active'").get().total);
  const generatedPreview = getMeterReadingEnergyRecordGenerationPreview({
    monthStart: '2026-08',
    monthEnd: '2026-08'
  });
  assert.deepStrictEqual(generatedPreview.summary, {
    totalScanned: 2,
    wouldGenerate: 1,
    conflict: 1,
    void: 0,
    alreadyGenerated: 0,
    missingLedger: 0,
    invalidUnit: 0,
    blocked: 0,
    skipped: 1
  });
  assert.strictEqual(generatedPreview.dryRun, true);
  assert.strictEqual(generatedPreview.previewOnly, true);
  assert.strictEqual(generatedPreview.writesEnergyRecords, false, '抄表转能耗预演必须只读。');
  assert.strictEqual(generatedPreview.items.length, 2);
  const parkConflict = generatedPreview.items.find((item) => item.meterCode === 'QL-M-ELEC-PARK');
  const cncCandidate = generatedPreview.items.find((item) => item.meterCode === 'QL-M-ELEC-CNC01');
  assert(parkConflict, '预演必须返回 QL-M-ELEC-PARK 园区总表候选。');
  assert.deepStrictEqual({
    normalizedMonth: parkConflict.normalizedMonth,
    normalizedUsageValue: parkConflict.normalizedUsageValue,
    normalizedUnit: parkConflict.normalizedUnit,
    status: parkConflict.status,
    wouldGenerate: parkConflict.wouldGenerate,
    reasonCodes: parkConflict.reasonCodes
  }, {
    normalizedMonth: '2026-08',
    normalizedUsageValue: 458000,
    normalizedUnit: 'kWh',
    status: 'conflict',
    wouldGenerate: false,
    reasonCodes: 'MONTHLY_ACTIVE_ENERGY_RECORD_EXISTS'
  });
  assert(Number.isSafeInteger(Number(parkConflict.conflictEnergyRecordId)), '园区 conflict 必须指向已存在的同表直接能耗记录。');
  assert(cncCandidate, '预演必须返回 QL-M-ELEC-CNC01 分表候选。');
  assert.deepStrictEqual({
    normalizedMonth: cncCandidate.normalizedMonth,
    normalizedUsageValue: cncCandidate.normalizedUsageValue,
    normalizedUnit: cncCandidate.normalizedUnit,
    status: cncCandidate.status,
    wouldGenerate: cncCandidate.wouldGenerate,
    conflictEnergyRecordId: cncCandidate.conflictEnergyRecordId,
    reasonCodes: cncCandidate.reasonCodes
  }, {
    normalizedMonth: '2026-08',
    normalizedUsageValue: 92500,
    normalizedUnit: 'kWh',
    status: 'wouldGenerate',
    wouldGenerate: true,
    conflictEnergyRecordId: null,
    reasonCodes: 'READY_TO_GENERATE'
  });
  assert.deepStrictEqual(generatedPreview.candidateReadingIds, [cncCandidate.readingId]);
  const energyCountAfterPreview = Number(db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE record_status = 'active'").get().total);
  assert.strictEqual(energyCountAfterPreview, energyCountBeforePreview, 'P0 仅验证抄表转能耗候选，不执行后置写入。');

  const legacyFormalCarbonResult = calculateCarbonEmissions({
      normalizedMonthStart: '2026-06',
      normalizedMonthEnd: '2026-08'
    });
    assert(legacyFormalCarbonResult.calculatedCount > 0,
      'legacy/formal 碳排放计算必须保持独立验收价值，不得冒充 connected post-action。');

    const predictionConfig = db.prepare(
      `SELECT pc.id, pc.organization_unit_id AS organizationUnitId,
              ou.unit_code AS organizationUnitCode, ou.unit_path AS organizationUnitPath,
              pc.meter_device_id AS meterDeviceId, md.meter_code AS meterCode,
              pc.source_batch_filter_id AS sourceBatchFilterId,
              pc.train_start_month AS trainStartMonth, pc.train_end_month AS trainEndMonth,
              pc.predict_start_month AS predictStartMonth, pc.predict_end_month AS predictEndMonth
         FROM prediction_configs pc
         LEFT JOIN organization_units ou ON ou.id = pc.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = pc.meter_device_id
        WHERE pc.name = '天坤集团电力趋势预测'`
    ).get();
    assert(predictionConfig, '必须通过稳定名称解析预测配置 ID。');
    assert.deepStrictEqual({
      organizationUnitCode: predictionConfig.organizationUnitCode,
      organizationUnitPath: predictionConfig.organizationUnitPath,
      meterCode: predictionConfig.meterCode,
      sourceBatchFilterId: Number(predictionConfig.sourceBatchFilterId),
      trainStartMonth: predictionConfig.trainStartMonth,
      trainEndMonth: predictionConfig.trainEndMonth,
      predictStartMonth: predictionConfig.predictStartMonth,
      predictEndMonth: predictionConfig.predictEndMonth
    }, {
      organizationUnitCode: 'QL-PARK',
      organizationUnitPath: '天坤集团',
      meterCode: 'QL-M-ELEC-PARK',
      sourceBatchFilterId: monthlyEnergyBatchId,
      trainStartMonth: '2026-01',
      trainEndMonth: '2026-07',
      predictStartMonth: '2026-08',
      predictEndMonth: '2026-10'
    });
    const predictionDefinition = requireDemoPostAction('prediction-run');
    const predictionClientRequestId = 'demo-park-full-prediction-v7';
    const predictionPreview = previewDemoPostAction({
      db,
      runId: demoRun.runId,
      actionKey: 'prediction-run',
      actorUserId: actor.userId,
      actorIp: actor.ip,
      body: { clientRequestId: predictionClientRequestId }
    });
    assert.strictEqual(predictionPreview.status, 'previewed', JSON.stringify(predictionPreview));
    assert.strictEqual(predictionPreview.blocker, null);
    assert.strictEqual(predictionPreview.input.algorithm, 'moving_average');
    assert.strictEqual(predictionPreview.input.trainingRecordCount, 7);
    assert.strictEqual(predictionPreview.input.expectedResultCount, 3);
    assert.deepStrictEqual(predictionPreview.outputs, []);
    const predictionSucceeded = executeDemoPostAction({
      db,
      actionRunId: predictionPreview.actionRunId,
      actorUserId: actor.userId,
      actorIp: actor.ip,
      body: {
        clientRequestId: predictionClientRequestId,
        previewDigest: predictionPreview.previewDigest,
        confirmationText: predictionDefinition.confirmationText
      }
    });
    assert.strictEqual(predictionSucceeded.status, 'succeeded', JSON.stringify(predictionSucceeded));
    assert.deepStrictEqual({
      resultStatus: predictionSucceeded.result.status,
      resultCount: predictionSucceeded.result.resultCount,
      outputCount: predictionSucceeded.outputCount,
      outputTypes: predictionSucceeded.outputs.map((output) => output.outputEntityType)
    }, {
      resultStatus: 'completed',
      resultCount: 3,
      outputCount: 4,
      outputTypes: ['prediction_run', 'prediction_result', 'prediction_result', 'prediction_result']
    });
    assert(predictionSucceeded.outputs.every((output) => output.outputRef !== null));
    const predictionActionIdentity = db.prepare(`SELECT registry_version AS registryVersion,
        registry_digest AS registryDigest, resolver_version AS resolverVersion,
        executor_version AS executorVersion, input_json AS inputJson
      FROM demo_post_action_runs WHERE action_run_id = ?`).get(predictionPreview.actionRunId);
    assert.deepStrictEqual({
      registryVersion: predictionActionIdentity.registryVersion,
      registryDigest: predictionActionIdentity.registryDigest,
      resolverVersion: predictionActionIdentity.resolverVersion,
      executorVersion: predictionActionIdentity.executorVersion
    }, {
      registryVersion: 'demo-post-actions:v7',
      registryDigest: '70d980ad87156784f137b6bcbc072faebd8577bf4427b4581ac5ee623735e01a',
      resolverVersion: 'prediction-resolver:v1',
      executorVersion: 'prediction-executor:v1'
    });
    const predictionProjectionMarker = JSON.parse(predictionActionIdentity.inputJson);
    assert.deepStrictEqual({
      actionKey: predictionProjectionMarker.publicProjectionActionKey,
      resolverVersion: predictionProjectionMarker.publicProjectionResolverVersion,
      executorVersion: predictionProjectionMarker.publicProjectionExecutorVersion,
      projectionVersion: predictionProjectionMarker.publicProjectionVersion
    }, {
      actionKey: 'prediction-run',
      resolverVersion: 'prediction-resolver:v1',
      executorVersion: 'prediction-executor:v1',
      projectionVersion: 1
    });
    const predictionStatus = getDemoPostActionStatus({
      db,
      actionRunId: predictionPreview.actionRunId,
      actorUserId: actor.userId
    });
    assert.deepStrictEqual(predictionStatus, predictionSucceeded);
    assert.deepStrictEqual(previewDemoPostAction({
      db,
      runId: demoRun.runId,
      actionKey: 'prediction-run',
      actorUserId: actor.userId,
      actorIp: actor.ip,
      body: { clientRequestId: predictionClientRequestId }
    }), predictionSucceeded);
    assert.deepStrictEqual(executeDemoPostAction({
      db,
      actionRunId: predictionPreview.actionRunId,
      actorUserId: actor.userId,
      actorIp: actor.ip,
      body: {
        clientRequestId: predictionClientRequestId,
        previewDigest: predictionPreview.previewDigest,
        confirmationText: predictionDefinition.confirmationText
      }
    }), predictionSucceeded);
    const predictionRunOutput = db.prepare(`SELECT output_entity_id AS outputEntityId
      FROM demo_post_action_outputs
      WHERE action_run_id = ? AND output_entity_type = 'prediction_run'`).get(
      predictionPreview.actionRunId
    );
    assert(predictionRunOutput, 'Prediction public execute 必须持久化 prediction_run output。');
    const predictionRunId = Number(predictionRunOutput.outputEntityId);
    assert(Number.isSafeInteger(predictionRunId) && predictionRunId > 0);
    const predictionDetail = getPredictionRun(predictionRunId);
    assert.strictEqual(predictionDetail.status, 'completed', `预测运行失败：${JSON.stringify(predictionDetail)}`);
    assert.strictEqual(predictionDetail.resultCount, 3);
    assert.strictEqual(predictionDetail.results.length, 3);
    assert.deepStrictEqual(predictionDetail.parameters.trainMonths, [
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'
    ]);
    assert.deepStrictEqual(predictionDetail.parameters.predictionMonths, ['2026-08', '2026-09', '2026-10']);
    assert.deepStrictEqual(predictionDetail.results.map((result) => result.targetMonth), ['2026-08', '2026-09', '2026-10']);
    assert.strictEqual(Number(predictionDetail.parameters.filters.organizationUnitId), Number(predictionConfig.organizationUnitId));
    assert.strictEqual(Number(predictionDetail.parameters.filters.meterDeviceId), Number(predictionConfig.meterDeviceId));
    assert.strictEqual(Number(predictionDetail.parameters.filters.sourceBatchId), Number(monthlyEnergyBatchId));
    const predictionOwnershipRows = db.prepare(`SELECT entity_type AS entityType, entity_pk AS entityPk
      FROM demo_data_registry
      WHERE run_id = ? AND ownership_kind = 'derived' AND cleaned_at IS NULL
        AND entity_type IN ('prediction_run', 'prediction_result')
      ORDER BY entity_type, CAST(entity_pk AS INTEGER)`).all(demoRun.runId);
    assert.strictEqual(predictionOwnershipRows.filter((row) => row.entityType === 'prediction_run').length, 1);
    assert.strictEqual(predictionOwnershipRows.filter((row) => row.entityType === 'prediction_result').length, 3);
    assert.strictEqual(
      predictionOwnershipRows.find((row) => row.entityType === 'prediction_run').entityPk,
      String(predictionRunId)
    );
    const predictionRelations = db.prepare(`SELECT relation.relation_type AS relationType,
        source.entity_type AS sourceEntityType, target.entity_type AS targetEntityType,
        source.entity_pk AS sourceEntityPk, target.entity_pk AS targetEntityPk
      FROM demo_data_relations relation
      JOIN demo_data_registry source ON source.registry_id = relation.from_registry_id
      JOIN demo_data_registry target ON target.registry_id = relation.to_registry_id
      WHERE relation.run_id = ? AND source.entity_type = 'prediction_run'
        AND source.entity_pk = ?
      ORDER BY relation.relation_type, target.entity_type, CAST(target.entity_pk AS INTEGER)`).all(
      demoRun.runId,
      String(predictionRunId)
    );
    assert.deepStrictEqual(
      Object.fromEntries(['contains', 'uses_config', 'generated_from'].map((relationType) => [
        relationType,
        predictionRelations.filter((relation) => relation.relationType === relationType).length
      ])),
      { contains: 3, uses_config: 1, generated_from: 7 }
    );
    assert(predictionRelations.filter((relation) => relation.relationType === 'contains')
      .every((relation) => relation.sourceEntityType === 'prediction_run'
        && relation.targetEntityType === 'prediction_result'));
    assert(predictionRelations.filter((relation) => relation.relationType === 'uses_config')
      .every((relation) => relation.sourceEntityType === 'prediction_run'
        && relation.targetEntityType === 'prediction_config'
        && relation.targetEntityPk === String(predictionConfig.id)));
    assert(predictionRelations.filter((relation) => relation.relationType === 'generated_from')
      .every((relation) => relation.sourceEntityType === 'prediction_run'
        && relation.targetEntityType === 'energy_record'));
    const predictionClosureBlocked = previewDemoPostAction({
      db,
      runId: demoRun.runId,
      actionKey: 'prediction-run',
      actorUserId: actor.userId,
      actorIp: actor.ip,
      body: { clientRequestId: 'demo-park-full-prediction-v7-closure-blocked' }
    });
    assert.strictEqual(predictionClosureBlocked.status, 'blocked');
    assert.strictEqual(
      predictionClosureBlocked.blocker.code,
      'DEMO_PREDICTION_ACTIVE_DERIVED_CLOSURE_EXISTS'
    );

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
      endUtc: '2026-08-01T04:00:00.000Z',
      sourceTimeZone: 'Asia/Shanghai'
    };
    const loadSummary = getEnergyLoadSummary(loadInput, { db });
    assert.strictEqual(loadSummary.recordCount, 16);
    assert.strictEqual(loadSummary.granularityMinutes, 15);
    assert.deepStrictEqual({
      status: loadSummary.quality.status,
      sufficient: loadSummary.quality.sufficient,
      coverageRate: loadSummary.quality.coverageRate,
      coveredMinutes: loadSummary.quality.coveredMinutes,
      expectedMinutes: loadSummary.quality.expectedMinutes,
      reasonCodes: loadSummary.quality.reasonCodes
    }, {
      status: 'sufficient',
      sufficient: true,
      coverageRate: 1,
      coveredMinutes: 240,
      expectedMinutes: 240,
      reasonCodes: []
    });
    assert.deepStrictEqual({
      observedEnergy: loadSummary.metrics.observedEnergy,
      totalEnergy: loadSummary.metrics.totalEnergy,
      totalEnergyComplete: loadSummary.metrics.totalEnergyComplete,
      energyUnit: loadSummary.metrics.energyUnit,
      maxLoad: loadSummary.metrics.maxLoad,
      loadUnit: loadSummary.metrics.loadUnit
    }, {
      observedEnergy: 5270,
      totalEnergy: 5270,
      totalEnergyComplete: true,
      energyUnit: 'kWh',
      maxLoad: 1640,
      loadUnit: 'kW'
    });
    assert(loadSummary.peakInterval, '负荷摘要必须返回峰值区间。');

    const loadCurve = getEnergyLoadCurve({
      ...loadInput,
      outputIntervalMinutes: 15
    }, { db });
    assert.strictEqual(loadCurve.recordCount, 16);
    assert.strictEqual(loadCurve.buckets.length, 16);
    assert.strictEqual(loadCurve.localHeatmap.length, 16);
    assert.strictEqual(loadCurve.quality.status, 'sufficient');
    assert.strictEqual(loadCurve.metrics.totalEnergy, 5270);

    const touScheme = db.prepare(
      "SELECT id FROM tou_schemes WHERE scheme_code = 'QL-TOU-2026' AND version = 'QL-TOU:v1' AND status = 'active'"
    ).get();
    assert(touScheme, '必须通过 TOU 方案编码和版本解析真实方案 ID。');
    const touAnalysis = getTimeOfUseConsumptionAnalysis({
      ...loadInput,
      touSchemeId: Number(touScheme.id)
    }, { db });
    assert.strictEqual(touAnalysis.recordCount, 16);
    assert.strictEqual(touAnalysis.scheme.code, 'QL-TOU-2026');
    assert.strictEqual(touAnalysis.scheme.ruleRecordCount, 28);
    assert.strictEqual(touAnalysis.quality.status, 'sufficient');
    assert.deepStrictEqual({
      sourceTimeZone: touAnalysis.dataRange.sourceTimeZone,
      durationMinutes: touAnalysis.dataRange.durationMinutes,
      expectedMinutes: touAnalysis.quality.expectedMinutes,
      coveredMinutes: touAnalysis.quality.coveredMinutes,
      coverageRate: touAnalysis.quality.coverageRate,
      totalEnergy: touAnalysis.metrics.totalEnergy,
      totalEnergyComplete: touAnalysis.metrics.totalEnergyComplete
    }, {
      sourceTimeZone: 'Asia/Shanghai',
      durationMinutes: 240,
      expectedMinutes: 240,
      coveredMinutes: 240,
      coverageRate: 1,
      totalEnergy: 5270,
      totalEnergyComplete: true
    });
    assert.deepStrictEqual(touAnalysis.periods.map((period) => ({
      type: period.type,
      expectedMinutes: period.expectedMinutes,
      coveredMinutes: period.coveredMinutes,
      coverageRate: period.coverageRate,
      observed: period.observed,
      complete: period.complete,
      share: period.share
    })), [
      { type: 'peak', expectedMinutes: 0, coveredMinutes: 0, coverageRate: 1, observed: 0, complete: 0, share: 0 },
      { type: 'flat', expectedMinutes: 240, coveredMinutes: 240, coverageRate: 1, observed: 5269.999999999997, complete: 5269.999999999997, share: 1 },
      { type: 'valley', expectedMinutes: 0, coveredMinutes: 0, coverageRate: 1, observed: 0, complete: 0, share: 0 }
    ]);

    const shiftAnalysis = getShiftConsumptionAnalysis(loadInput, { db });
    assert.strictEqual(shiftAnalysis.recordCount, 16);
    assert.strictEqual(shiftAnalysis.scheduleRecordCount, 1);
    assert.strictEqual(shiftAnalysis.quality.status, 'sufficient');
    assert.strictEqual(shiftAnalysis.metrics.assignedEnergy, 5270);
    assert.strictEqual(shiftAnalysis.metrics.unassignedEnergy, 0);
    assert.strictEqual(shiftAnalysis.shifts[0].code, 'QL-SHIFT-DAY');

    const deviceStateAnalysis = getDeviceStateConsumptionAnalysis(loadInput, { db });
    assert.strictEqual(deviceStateAnalysis.recordCount, 16);
    assert.strictEqual(deviceStateAnalysis.stateRecordCount, 1);
    assert.strictEqual(deviceStateAnalysis.quality.status, 'sufficient');
    assert.strictEqual(deviceStateAnalysis.quality.stateCoverageRate, 1);
    assert.strictEqual(deviceStateAnalysis.states.find((state) => state.status === 'running').minutes, 240);

    const equipment = db.prepare(
      "SELECT id FROM organization_units WHERE unit_code = 'QL-EQ-CNC-01'"
    ).get();
    assert(equipment, '必须通过 CNC 设备组织编码解析高峰贡献范围。');
    const peakContribution = getPeakContributionAnalysis({
      organizationUnitId: Number(equipment.id),
      energyTypeCode: 'electricity',
      unit: 'kWh',
      sourceTimeZone: 'Asia/Shanghai',
      startUtc: loadInput.startUtc,
      endUtc: loadInput.endUtc,
      outputIntervalMinutes: 15,
      topContributors: 5
    }, { db });
    assert.strictEqual(peakContribution.recordCount, 16);
    assert.strictEqual(peakContribution.quality.status, 'sufficient');
    assert.strictEqual(peakContribution.peak.calculable, true);
    assert.strictEqual(peakContribution.peak.energy, 410);
    assert.strictEqual(peakContribution.peak.intervals[0].contributors[0].meterCode, 'QL-M-ELEC-CNC01');

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
      `SELECT por.output_value AS outputValue, por.output_unit AS outputUnit
         FROM production_output_records por
         JOIN production_units pu ON pu.id = por.production_unit_id
        WHERE pu.unit_code = 'QL-PU-PRECISION' AND por.normalized_month = '2026-08' AND por.record_status = 'active'`
    ).get();
    const electricity = db.prepare(
      `SELECT COALESCE(SUM(er.normalized_value), 0) AS total, er.normalized_unit AS unit
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         JOIN organization_units ou ON ou.id = er.organization_unit_id
        WHERE er.normalized_month = '2026-08'
          AND et.code = 'electricity'
          AND er.normalized_unit = 'kWh'
          AND ou.unit_code = 'QL-WORKSHOP-A'
          AND er.record_status = 'active'
        GROUP BY er.normalized_unit`
    ).get();
    assert.deepStrictEqual(production, { outputValue: 1320, outputUnit: 't' });
    assert.deepStrictEqual(electricity, { total: 138000, unit: 'kWh' });
    const rawIntensity = Math.round((Number(electricity.total) / Number(production.outputValue)) * 1e12) / 1e12;
    const actualIntensity = Math.round((Number(electricity.total) * 0.1229 / Number(production.outputValue)) * 1e6) / 1e6;
    const intensity = getEnergyIntensityAnalysis({
      productionUnitId: Number(db.prepare("SELECT id FROM production_units WHERE unit_code = 'QL-PU-PRECISION'").get().id),
      startMonth: '2026-08',
      endMonth: '2026-08',
      energyTypeCode: 'electricity',
      unit: 'kWh'
    }, { db });
    assert.strictEqual(intensity.quality.status, 'sufficient');
    assert.strictEqual(intensity.scope.organizationUnitCode, 'QL-WORKSHOP-A');
    assert.strictEqual(intensity.scope.energyTypeCode, 'electricity');
    assert.strictEqual(intensity.scope.outputUnit, 't');
    assert.strictEqual(intensity.facets.length, 1);
    assert.strictEqual(intensity.facets[0].monthly[0].month, '2026-08');
    assert.strictEqual(intensity.facets[0].monthly[0].numerator.value, 138000);
    assert.strictEqual(intensity.facets[0].monthly[0].denominator.value, 1320);
    assert.strictEqual(intensity.facets[0].monthly[0].intensity.value, rawIntensity);
    const createBenchmarkActual = (objectId, objectName, actualValue) => ({
      objectId,
      objectName,
      objectLevel: 'workshop',
      actualValue,
      metricCode: 'energy_intensity',
      unit: 'kgce/t',
      periodType: 'month',
      periodStartUtc: '2026-08-01T00:00:00Z',
      periodEndUtc: '2026-09-01T00:00:00Z',
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
      createBenchmarkActual('QL-WORKSHOP-A-PEAK', '精密制造一车间峰值场景', actualIntensity + 150)
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
      // Asia/Shanghai 的 2026-07 完整自然月对应 UTC 2026-06-30 16:00 至 2026-07-31 16:00。
      startUtc: '2026-06-30T16:00:00.000Z',
      endUtc: '2026-07-31T16:00:00.000Z'
    }, { actor });
    assert(balance.originalFacets.length > 0, '平衡快照必须非空。');
    assert.strictEqual(balance.originalFacets[0].inputTotalOriginal, 499000, '电力平衡输入必须包含外购电和光伏自发自用。');
    assert.strictEqual(balance.originalFacets[0].outputTotalOriginal, 470000, '电力平衡输出必须包含显式有用能。');
    assert(balance.originalFacets[0].utilizationRate >= 0 && balance.originalFacets[0].utilizationRate <= 1, '电力平衡利用率必须保持在 0 至 1。');
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
    const electricityBudget = budgets.rows.find((row) => row.energyTypeCode === 'electricity' && row.organizationScope === '天坤集团');
    const naturalGasBudget = budgets.rows.find((row) => row.energyTypeCode === 'natural_gas' && row.organizationScope === '公辅动力站');
    assert.deepStrictEqual({
      periodMonth: electricityBudget.periodMonth,
      budgetValue: electricityBudget.budgetValue,
      actualValue: electricityBudget.actualValue,
      budgetUnit: electricityBudget.budgetUnit,
      actualUnit: electricityBudget.actualUnit,
      comparisonStatus: electricityBudget.comparisonStatus
    }, {
      periodMonth: '2026-08',
      budgetValue: 470000,
      actualValue: 458000,
      budgetUnit: 'kWh',
      actualUnit: 'kWh',
      comparisonStatus: 'comparable'
    });
    assert.deepStrictEqual({
      periodMonth: naturalGasBudget.periodMonth,
      budgetValue: naturalGasBudget.budgetValue,
      actualValue: naturalGasBudget.actualValue,
      budgetUnit: naturalGasBudget.budgetUnit,
      actualUnit: naturalGasBudget.actualUnit,
      comparisonStatus: naturalGasBudget.comparisonStatus
    }, {
      periodMonth: '2026-08',
      budgetValue: 20000,
      actualValue: 19300,
      budgetUnit: 'm3',
      actualUnit: 'm3',
      comparisonStatus: 'comparable'
    });
    assert.strictEqual(budgets.rows.filter((row) => row.budgetId).some((row) => row.comparisonStatus === 'no_actual' || row.comparisonStatus === 'unit_mismatch'), false);
    assert.strictEqual(dashboard.energy.status, 'available');
    assert(dashboard.energy.totals.length > 0, '中控能耗核心域必须非空。');
    assert.strictEqual(dashboard.imports.status, 'available');
    assert(Number(dashboard.imports.batchCount) >= DEMO_PARK_ARTIFACTS.length);

    return {
      generatedPreview,
      legacyFormalCarbonResult,
      predictionDetail,
      monthlyAnalysis,
      loadSummary,
      loadCurve,
      touAnalysis,
      shiftAnalysis,
      deviceStateAnalysis,
      peakContribution,
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
}

(async () => {
  let db = null;
  const startedAt = Date.now();
  try {
    fs.mkdirSync(temporaryDataDir, { recursive: true });
    fs.mkdirSync(temporaryUploadsDir, { recursive: true });
    fs.mkdirSync(temporaryBackupsDir, { recursive: true });
    assert.strictEqual(validateDemoParkManifest(), true);
    assert.strictEqual(DEMO_PARK_ARTIFACTS.length, 29);
    assert.deepStrictEqual(
      DEMO_PARK_ARTIFACTS.map((artifact) => artifact.order),
      Array.from({ length: 29 }, (_item, index) => index + 1)
    );

    initDatabase();
    db = openDatabase();
    // 预先写入一条无关批次，证明演示合同和预测关系不能依赖固定自增 ID。
    const unrelatedBatch = db.prepare(
      `INSERT INTO import_batches (
         import_type, original_filename, file_type, file_size_bytes, file_sha256,
         status, duplicate_strategy, total_rows, success_count, failure_count, skipped_count
       ) VALUES ('supplier', 'unrelated-seed.xlsx', 'xlsx', 0, 'unrelated-seed', 'cancelled', 'skip', 0, 0, 0, 0)`
    ).run();
    assert.strictEqual(Number(unrelatedBatch.lastInsertRowid), 1);
    const actor = getTestActor(db);
    toggleDemoRuntime({ enabled: true, actorUserId: actor.userId });
    const demoRun = db.transaction(() => getOrCreateActiveDemoDatasetRun({
      db,
      actorUserId: actor.userId
    })).immediate();
    const context = {
      db,
      actor,
      demoRun,
      analysisOptions: getAnalysisOptions(db, actor)
    };

    for (const artifact of DEMO_PARK_ARTIFACTS) {
      const file = createArtifactUpload(artifact.artifactKey, 'initial');
      const result = await importArtifact(artifact, file, context);
      processedArtifactKeys.push(artifact.artifactKey);
      importResults.set(artifact.artifactKey, result);
    }

    assert.deepStrictEqual(
      processedArtifactKeys,
      DEMO_PARK_ARTIFACTS.map((artifact) => artifact.artifactKey),
      '29 项 artifact 必须严格按 manifest 固定顺序执行。'
    );
    assert.strictEqual(importResults.size, 29);

    const carbonConnected = runCarbonConnectedPostAction(db, actor, demoRun);
    assert(carbonConnected.outputCount > 0, 'Carbon connected post-action 必须产生非空可追溯 output。');
    const derived = await runDerivedOperations(db, actor, demoRun, context.monthlyEnergyBatchId);
    assert(derived.legacyFormalCarbonResult.calculatedCount > 0);
    await verifyDuplicateImports(context);
    markManagedStrategyRunCleaned(db, demoRun.runId);
    const managedStrategyForward = await runManagedStrategyInputIntegration(
      db,
      actor,
      ['15-energy-timeseries', '18-strategy-rules'],
      'managed strategy 正序',
      'forward'
    );
    assert.strictEqual(
      managedStrategyForward.relationCount,
      managedStrategyForward.timeseriesCount * managedStrategyForward.ruleCount
    );
    markManagedStrategyRunCleaned(db, managedStrategyForward.run.runId);

    const managedStrategyReverse = await runManagedStrategyInputIntegration(
      db,
      actor,
      ['18-strategy-rules', '15-energy-timeseries'],
      'managed strategy 逆序',
      'reverse'
    );
    assert.strictEqual(
      managedStrategyReverse.relationCount,
      managedStrategyReverse.timeseriesCount * managedStrategyReverse.ruleCount
    );
    assert.deepStrictEqual(db.pragma('foreign_key_check'), [], '隔离库外键检查必须为空。');

    console.log(JSON.stringify({
      status: 'passed',
      artifactCount: processedArtifactKeys.length,
      processedArtifactKeys,
      blockedArtifactKeys: [],
      completedOperations: [
        'meter-reading-energy-generation-preview-only',
        'carbon-connected-post-action',
        'legacy-formal-carbon-accounting',
        'prediction-run',
        'monthly-consumption-analysis',
        'load-summary-and-curve',
        'time-of-use-analysis',
        'shift-consumption-analysis',
        'device-state-analysis',
        'peak-contribution-analysis',
        'strategy-preview-and-run',
        'managed-strategy-input-closure',
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
