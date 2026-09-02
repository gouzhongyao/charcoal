'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 专项测试只使用临时目录和隔离 SQLite，绝不接触默认 data/energy-carbon.sqlite。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-prediction-exact-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'prediction-exact.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { createImportBatchFromUpload } = require('../services/importService');

initDatabase();

const predictionServicePath = require.resolve('../services/predictionService');
const predictionService = require('../services/predictionService');
const PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.prediction.exactInternal.v1');
const exactProtocol = predictionService[PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL];

// 普通 CommonJS 字符串 exports 必须完整保持 P3 前的固定集合。
const EXPECTED_PUBLIC_EXPORT_KEYS = Object.freeze([
  'PREDICTION_CONFIG_EXPORT_FIELDS',
  'PREDICTION_CONFIG_IMPORT_ALIASES',
  'PREDICTION_CONFIG_IMPORT_CONFIRM_TEXT',
  'PREDICTION_CONFIG_IMPORT_HEADERS',
  'PREDICTION_CONFIG_IMPORT_TEMPLATE_ID',
  'PREDICTION_CONFIG_STATUSES',
  'PREDICTION_RESULT_EXPORT_FIELDS',
  'buildConfigWhere',
  'buildHistoryWhere',
  'buildPredictionConfigImportPreviewFromRows',
  'buildPredictionStats',
  'buildResultWhere',
  'buildRunListWhere',
  'cancelOrArchivePredictionRun',
  'copyPredictionConfig',
  'createPredictionConfig',
  'createPredictionConfigImportPreviewFromUpload',
  'createPredictionRun',
  'createRunFromConfig',
  'executePredictionConfigImport',
  'exportPredictionConfigs',
  'exportPredictionResults',
  'getPredictionConfig',
  'getPredictionManagementContract',
  'getPredictionRun',
  'listPredictionConfigs',
  'listPredictionResults',
  'listPredictionRuns',
  'normalizeConfigPayload',
  'normalizePredictionPayload',
  'setPredictionConfigStatus',
  'updatePredictionConfig'
]);

/** 插入隔离测试使用的导入批次。 */
function insertImportBatch(db, filename) {
  return Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, status, total_rows, success_count)
    VALUES ('energy_record', ?, 'csv', 'completed', 0, 0)`).run(filename).lastInsertRowid);
}

/** 插入隔离测试使用的组织。 */
function insertOrganization(db, code, name) {
  return Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status)
    VALUES (?, ?, ?, 'enterprise', 'active')`).run(code, name, `/${code}`).lastInsertRowid);
}

/** 插入隔离测试使用的计量器具。 */
function insertMeter(db, code, energyTypeId, organizationUnitId) {
  return Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
    VALUES (?, ?, 'other', ?, ?, 'active')`).run(
    code,
    `${code}计量器具`,
    energyTypeId,
    organizationUnitId
  ).lastInsertRowid);
}

/** 插入一条带完整来源身份的能耗记录。 */
function insertEnergyRecord(db, input) {
  return Number(db.prepare(`INSERT INTO energy_records
    (source_batch_id, source_row_number, energy_type_id, organization_unit_id,
      meter_device_id, original_month, normalized_month, original_unit,
      original_value, normalized_unit, normalized_value, remark, duplicate_key,
      record_status)
    VALUES (@sourceBatchId, @sourceRowNumber, @energyTypeId, @organizationUnitId,
      @meterDeviceId, @month, @month, @unit, @value, @unit, @value, @remark,
      @duplicateKey, @recordStatus)`).run(input).lastInsertRowid);
}

/** 构造正式导入服务使用的隔离上传文件描述。 */
function buildUploadFile(filePath, originalname) {
  return {
    path: filePath,
    originalname,
    filename: path.basename(filePath),
    size: fs.statSync(filePath).size
  };
}

/** 返回 run/result 当前计数。 */
function readPredictionCounts(db) {
  return {
    runs: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_runs').get().count),
    results: Number(db.prepare('SELECT COUNT(*) AS count FROM prediction_results').get().count)
  };
}

/** 在调用方事务内建立 exact scope。 */
function withExactScope(db, identities, callback) {
  return exactProtocol.withCallerTransactionScope({ db, ...identities }, callback);
}

/** 使用固定 payload 执行 exact inspect。 */
function inspectExact(db, transactionScope, payload, configSnapshot = null) {
  return exactProtocol.inspectExact({
    db,
    transactionScope,
    payload,
    configSnapshot
  });
}

/** 执行 exact capability。 */
function executeExact(db, transactionScope, exactCapability, identities) {
  return exactProtocol.executeExact({
    db,
    transactionScope,
    exactCapability,
    ...identities
  });
}

/** 读取 completion witness。 */
function readWitness(db, transactionScope, completionWitness, identities) {
  return exactProtocol.readCompletionWitness({
    db,
    transactionScope,
    completionWitness,
    ...identities
  });
}

/** 消费 completion witness。 */
function consumeWitness(db, transactionScope, completionWitness, identities) {
  return exactProtocol.consumeCompletionWitness({
    db,
    transactionScope,
    completionWitness,
    ...identities
  });
}

/** 判断错误是否命中固定 Prediction exact code。 */
function hasExactCode(code) {
  return (error) => error?.details?.code === code;
}

const db = openDatabase();
const samePhysicalDb = openDatabase();
const crossDb = openDatabase({ databasePath: path.join(tmpDir, 'cross.sqlite') });

try {
  const energyTypes = new Map(db.prepare('SELECT id, code FROM energy_types').all()
    .map((row) => [row.code, Number(row.id)]));
  const electricityId = energyTypes.get('electricity');
  const waterId = energyTypes.get('water');
  const targetBatchId = insertImportBatch(db, 'prediction-target.csv');
  const otherBatchId = insertImportBatch(db, 'prediction-other.csv');
  const emptyBatchId = insertImportBatch(db, 'prediction-empty.csv');
  const organizationAId = insertOrganization(db, 'PRED-EXACT-A', 'Prediction Exact A');
  const organizationBId = insertOrganization(db, 'PRED-EXACT-B', 'Prediction Exact B');
  const electricityMeterAId = insertMeter(db, 'PRED-ELECTRIC-A', electricityId, organizationAId);
  const electricityMeterAOtherId = insertMeter(db, 'PRED-ELECTRIC-A-OTHER', electricityId, organizationAId);
  const electricityMeterBId = insertMeter(db, 'PRED-ELECTRIC-B', electricityId, organizationBId);
  const waterMeterAId = insertMeter(db, 'PRED-WATER-A', waterId, organizationAId);

  // 目标集合故意包含同月多行和月份断档，用于验证精确聚合与连续性 warning。
  const targetRecordIds = [
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-01',
      unit: 'kWh',
      value: 100,
      remark: '目标一月第一行',
      duplicateKey: 'prediction-target-1',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 3,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-01',
      unit: 'kWh',
      value: 10,
      remark: '目标一月第二行',
      duplicateKey: 'prediction-target-2',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 4,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-03',
      unit: 'kWh',
      value: 120,
      remark: '目标三月',
      duplicateKey: 'prediction-target-3',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 5,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-04',
      unit: 'kWh',
      value: 140,
      remark: '目标四月',
      duplicateKey: 'prediction-target-4',
      recordStatus: 'active'
    })
  ];

  // 正式哨兵覆盖批次、组织、仪表、能源类型和 active 状态过滤边界。
  const sentinelRecordIds = [
    insertEnergyRecord(db, {
      sourceBatchId: otherBatchId,
      sourceRowNumber: 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-02',
      unit: 'kWh',
      value: 999,
      remark: '错误批次哨兵',
      duplicateKey: 'prediction-sentinel-batch',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 6,
      energyTypeId: electricityId,
      organizationUnitId: organizationBId,
      meterDeviceId: electricityMeterBId,
      month: '2026-02',
      unit: 'kWh',
      value: 888,
      remark: '错误组织哨兵',
      duplicateKey: 'prediction-sentinel-org',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 7,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAOtherId,
      month: '2026-02',
      unit: 'kWh',
      value: 777,
      remark: '错误仪表哨兵',
      duplicateKey: 'prediction-sentinel-meter',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 8,
      energyTypeId: waterId,
      organizationUnitId: organizationAId,
      meterDeviceId: waterMeterAId,
      month: '2026-01',
      unit: 'm3',
      value: 50,
      remark: '水分组一月',
      duplicateKey: 'prediction-water-1',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 9,
      energyTypeId: waterId,
      organizationUnitId: organizationAId,
      meterDeviceId: waterMeterAId,
      month: '2026-02',
      unit: 'm3',
      value: 60,
      remark: '水分组二月',
      duplicateKey: 'prediction-water-2',
      recordStatus: 'active'
    }),
    insertEnergyRecord(db, {
      sourceBatchId: targetBatchId,
      sourceRowNumber: 10,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-02',
      unit: 'kWh',
      value: 666,
      remark: 'void 状态哨兵',
      duplicateKey: 'prediction-sentinel-void',
      recordStatus: 'void'
    })
  ];

  const identities = Object.freeze({
    demoRun: Object.freeze({ id: 101, runCode: 'demo-prediction-exact' }),
    actionRun: Object.freeze({ id: 202, actionKey: 'prediction-run' }),
    actor: Object.freeze({ userId: 303, username: 'prediction-exact-actor' })
  });
  const mutableIdentities = {
    demoRun: { id: 501, runCode: 'mutable-demo-run', metadata: { version: 1 } },
    actionRun: { id: 502, actionKey: 'prediction-run', metadata: { attempt: 1 } },
    actor: { userId: 503, username: 'mutable-actor', profile: { tenant: 'local' } }
  };
  const configSnapshot = Object.freeze({
    configId: 404,
    config: Object.freeze({ name: 'Prediction exact 配置快照', sourceBatchId: targetBatchId })
  });
  const filteredPayload = Object.freeze({
    name: 'Prediction exact filtered',
    energyTypeCode: 'electricity',
    organizationUnitCode: 'PRED-EXACT-A',
    meterCode: 'PRED-ELECTRIC-A',
    sourceBatchId: targetBatchId,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-04',
    predictStartMonth: '2026-05',
    predictEndMonth: '2026-06',
    algorithm: 'moving_average',
    windowSize: 3
  });

  assert.deepStrictEqual(Object.keys(predictionService), [...EXPECTED_PUBLIC_EXPORT_KEYS]);
  assert(exactProtocol && Object.isFrozen(exactProtocol));
  assert.deepStrictEqual(Object.keys(exactProtocol), [
    'withCallerTransactionScope',
    'inspectExact',
    'executeExact',
    'readCompletionWitness',
    'consumeCompletionWitness',
    'bindP4CompletionVerifier'
  ]);
  const exactDescriptor = Object.getOwnPropertyDescriptor(
    predictionService,
    PREDICTION_EXACT_INTERNAL_PROTOCOL_SYMBOL
  );
  assert.strictEqual(exactDescriptor.enumerable, false);
  assert.strictEqual(exactDescriptor.writable, false);
  assert.strictEqual(exactDescriptor.configurable, false);
  const moduleExportsDescriptor = Object.getOwnPropertyDescriptor(
    require.cache[predictionServicePath],
    'exports'
  );
  assert.strictEqual(moduleExportsDescriptor.writable, false);
  assert.strictEqual(moduleExportsDescriptor.configurable, false);

  // invocation identity canonicalize 拒绝 Proxy、cycle、不稳定类型、非原生数组、空洞和附加字段。
  const cyclicActor = { userId: 1 };
  cyclicActor.self = cyclicActor;
  let customPrototypeGetterReads = 0;
  const customArrayPrototype = Object.create(Array.prototype, {
    secret: {
      enumerable: true,
      get() {
        customPrototypeGetterReads += 1;
        return '不得读取';
      }
    }
  });
  const customPrototypeArray = ['scope:create'];
  Object.setPrototypeOf(customPrototypeArray, customArrayPrototype);
  const sparseArray = [];
  sparseArray.length = 1;
  const additionalFieldArray = ['scope'];
  additionalFieldArray.extra = true;
  const invalidIdentityCases = [
    [{ ...identities, actor: new Proxy({ userId: 1 }, {}) }, 'PREDICTION_EXACT_INVOCATION_IDENTITY_REQUIRED'],
    [{ ...identities, actor: cyclicActor }, 'PREDICTION_EXACT_IDENTITY_CYCLE'],
    [{ ...identities, actor: { userId: 1, callback: () => {} } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID'],
    [{ ...identities, actor: { userId: 1, token: Symbol('invalid') } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID'],
    [{ ...identities, actor: { userId: Number.POSITIVE_INFINITY } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID'],
    [{ ...identities, actor: { userId: 1, scopes: customPrototypeArray } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID'],
    [{ ...identities, actor: { userId: 1, scopes: sparseArray } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID'],
    [{ ...identities, actor: { userId: 1, scopes: additionalFieldArray } }, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID']
  ];
  db.exec('BEGIN IMMEDIATE');
  invalidIdentityCases.forEach(([invalidIdentities, expectedCode]) => {
    assert.throws(
      () => withExactScope(db, invalidIdentities, () => null),
      hasExactCode(expectedCode)
    );
  });
  assert.strictEqual(customPrototypeGetterReads, 0, '自定义数组原型 getter 不得在拒绝前被执行。');
  assert.strictEqual(withExactScope(db, {
    ...identities,
    actor: { userId: 1, scopes: ['prediction:read', { tags: ['local'] }] }
  }, () => 'json-array-accepted'), 'json-array-accepted');
  db.exec('ROLLBACK');

  // 一次历史查询同时产生 exact rows 和由其计算的月度聚合 points。
  db.exec('BEGIN IMMEDIATE');
  let energyRecordQueryCount = 0;
  const originalPrepare = db.prepare;
  db.prepare = function countPredictionHistoryQueries(sql) {
    if (String(sql).includes('FROM energy_records er')) energyRecordQueryCount += 1;
    return originalPrepare.call(this, sql);
  };
  const inspectOnlySummary = withExactScope(db, identities, (transactionScope) => (
    inspectExact(db, transactionScope, filteredPayload, configSnapshot).summary
  ));
  db.prepare = originalPrepare;
  assert.strictEqual(energyRecordQueryCount, 1, '历史 active energy_records 必须只查询一次。');
  assert.strictEqual(inspectOnlySummary.groups.length, 1);
  assert.deepStrictEqual(
    inspectOnlySummary.exactTrainingRecords.map((record) => record.id),
    targetRecordIds
  );
  assert.strictEqual(
    inspectOnlySummary.exactTrainingRecords.some((record) => sentinelRecordIds.includes(record.id)),
    false,
    '批次、组织、仪表、能源类型或状态不匹配的正式哨兵不得进入 exact 集合。'
  );
  assert.deepStrictEqual(inspectOnlySummary.groups[0].points, [
    { month: '2026-01', value: 110, recordCount: 2 },
    { month: '2026-03', value: 120, recordCount: 1 },
    { month: '2026-04', value: 140, recordCount: 1 }
  ]);
  assert.strictEqual(inspectOnlySummary.executable, true);
  assert.match(inspectOnlySummary.warnings.join('；'), /缺失月份：2026-02/);
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 }, 'inspect 必须零领域写入。');
  db.exec('ROLLBACK');

  // 普通字符串 export monkeypatch 不得接管初始化期捕获的 exact normalize/inspect 函数。
  const originalNormalizeExport = predictionService.normalizePredictionPayload;
  const originalCreateRunExport = predictionService.createPredictionRun;
  predictionService.normalizePredictionPayload = () => { throw new Error('monkeypatch normalize'); };
  predictionService.createPredictionRun = () => { throw new Error('monkeypatch create'); };
  db.exec('BEGIN IMMEDIATE');
  const monkeypatchSummary = withExactScope(db, identities, (transactionScope) => (
    inspectExact(db, transactionScope, filteredPayload, configSnapshot).summary
  ));
  assert.strictEqual(monkeypatchSummary.normalizedPayload.algorithm, 'moving_average');
  db.exec('ROLLBACK');
  predictionService.normalizePredictionPayload = originalNormalizeExport;
  predictionService.createPredictionRun = originalCreateRunExport;

  // moving average 成功，witness 保留完整实际训练集合和月份断档 warning。
  db.exec('BEGIN IMMEDIATE');
  const movingFacts = withExactScope(db, identities, (transactionScope) => {
    const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
    const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
    assert.strictEqual(executed.run.status, 'completed');
    assert.strictEqual(executed.summary.resultCount, 2);
    const readFacts = readWitness(db, transactionScope, executed.completionWitness, identities);
    assert.strictEqual(readFacts.status, 'completed');
    assert.deepStrictEqual(readFacts.exactTrainingRecords.map((record) => record.id), targetRecordIds);
    assert.strictEqual(readFacts.results.length, 2);
    assert.strictEqual(readFacts.configSnapshot.configId, configSnapshot.configId);
    return consumeWitness(db, transactionScope, executed.completionWitness, identities);
  });
  assert.strictEqual(movingFacts.algorithm, 'moving_average');
  assert.strictEqual(movingFacts.groups[0].unit, 'kWh');
  assert.strictEqual(movingFacts.results[0].predictedUnit, 'kWh');
  assert(movingFacts.exactTrainingRecords.every((record) => record.normalizedUnit === 'kWh'));
  assert.deepStrictEqual(movingFacts.groups[0].trainingRecords.map((record) => record.id), targetRecordIds);
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 1, results: 2 });
  db.exec('ROLLBACK');
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });

  // TEMP trigger 即使把结果改成仍可解析的数值，也必须由持久化写入代次门禁阻断并完整回滚。
  db.exec(`CREATE TEMP TRIGGER prediction_exact_forecast_drift
    AFTER INSERT ON prediction_results
    BEGIN
      UPDATE prediction_results SET predicted_value = predicted_value + 1 WHERE id = NEW.id;
    END;`);
  db.exec('BEGIN IMMEDIATE');
  withExactScope(db, identities, (transactionScope) => {
    const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
    assert.throws(
      () => executeExact(db, transactionScope, inspected.exactCapability, identities),
      hasExactCode('PREDICTION_EXACT_WRITE_CARDINALITY_MISMATCH')
    );
  });
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  db.exec('ROLLBACK');
  db.exec('DROP TRIGGER prediction_exact_forecast_drift');

  // linear trend 使用完整 points 拟合，并通过调用方 SAVEPOINT 完整回滚 run/results。
  db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT caller_prediction_linear');
  const linearPayload = { ...filteredPayload, name: 'Prediction exact linear', algorithm: 'linear_trend' };
  const linearFacts = withExactScope(db, identities, (transactionScope) => {
    const inspected = inspectExact(db, transactionScope, linearPayload, configSnapshot);
    const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
    return consumeWitness(db, transactionScope, executed.completionWitness, identities);
  });
  assert.strictEqual(linearFacts.algorithm, 'linear_trend');
  assert.strictEqual(linearFacts.results.length, 2);
  assert.strictEqual(linearFacts.results[0].predictedValue, 153.333333);
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 1, results: 2 });
  db.exec('ROLLBACK TO SAVEPOINT caller_prediction_linear');
  db.exec('RELEASE SAVEPOINT caller_prediction_linear');
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  db.exec('ROLLBACK');

  // 多 group 中 electricity 成功、water 样本不足；完整训练集合仍覆盖两组实际记录。
  const multiGroupPayload = {
    name: 'Prediction exact multi group',
    organizationUnitCode: 'PRED-EXACT-A',
    sourceBatchId: targetBatchId,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-04',
    predictStartMonth: '2026-05',
    predictEndMonth: '2026-05',
    algorithm: 'moving_average',
    windowSize: 3
  };
  db.exec('BEGIN IMMEDIATE');
  const multiGroupSummary = withExactScope(db, identities, (transactionScope) => (
    inspectExact(db, transactionScope, multiGroupPayload, configSnapshot).summary
  ));
  db.exec('ROLLBACK');
  assert.strictEqual(multiGroupSummary.groups.length, 2);
  assert.strictEqual(multiGroupSummary.eligibleGroups.length, 1);
  assert.strictEqual(multiGroupSummary.skippedGroups.length, 1);
  assert.strictEqual(multiGroupSummary.skippedGroups[0].group, 'water/m3');
  assert.strictEqual(multiGroupSummary.exactTrainingRecords.length, 7);

  // SQLite 异常 text/空串数值必须作为持久事实完整性错误阻断，不能 Number() 为 0 或静默丢弃。
  ['', 'not-a-number', '100kWh'].forEach((invalidValue, index) => {
    const invalidBatchId = insertImportBatch(db, `prediction-invalid-number-${index}.csv`);
    const recordId = insertEnergyRecord(db, {
      sourceBatchId: invalidBatchId,
      sourceRowNumber: 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-01',
      unit: 'kWh',
      value: 100,
      remark: '异常数值持久事实',
      duplicateKey: `prediction-invalid-number-${index}`,
      recordStatus: 'active'
    });
    db.prepare('UPDATE energy_records SET normalized_value = ? WHERE id = ?')
      .run(invalidValue, recordId);
    const invalidPayload = { ...filteredPayload, sourceBatchId: invalidBatchId };
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      assert.throws(
        () => inspectExact(db, transactionScope, invalidPayload, configSnapshot),
        hasExactCode('PREDICTION_HISTORY_DATA_INTEGRITY_ERROR')
      );
      assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    });
    db.exec('ROLLBACK');
    assert.throws(
      () => predictionService.createPredictionRun(invalidPayload),
      hasExactCode('PREDICTION_HISTORY_DATA_INTEGRITY_ERROR')
    );
  });

  // normalized_unit 必须严格使用 energy_types.standard_unit；空值和非 canonical 单位均 fail-closed。
  ['', 'Wh'].forEach((invalidUnit, index) => {
    const invalidBatchId = insertImportBatch(db, `prediction-invalid-unit-${index}.csv`);
    insertEnergyRecord(db, {
      sourceBatchId: invalidBatchId,
      sourceRowNumber: 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-01',
      unit: invalidUnit,
      value: 100,
      remark: '异常单位持久事实',
      duplicateKey: `prediction-invalid-unit-${index}`,
      recordStatus: 'active'
    });
    const invalidPayload = { ...filteredPayload, sourceBatchId: invalidBatchId };
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      assert.throws(
        () => inspectExact(db, transactionScope, invalidPayload, configSnapshot),
        hasExactCode('PREDICTION_HISTORY_DATA_INTEGRITY_ERROR')
      );
    });
    db.exec('ROLLBACK');
  });

  // original_month 只保留合法追溯字符串；空值、BLOB、控制字符和超长值必须 fail-closed。
  ['', Buffer.from('2026/01', 'utf8'), '2026/01\n', '2'.repeat(129)].forEach((invalidMonth, index) => {
    const invalidBatchId = insertImportBatch(db, `prediction-invalid-original-month-${index}.csv`);
    const recordId = insertEnergyRecord(db, {
      sourceBatchId: invalidBatchId,
      sourceRowNumber: 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month: '2026-01',
      unit: 'kWh',
      value: 100,
      remark: '异常月份追溯事实',
      duplicateKey: `prediction-invalid-original-month-${index}`,
      recordStatus: 'active'
    });
    db.prepare('UPDATE energy_records SET original_month = ? WHERE id = ?')
      .run(invalidMonth, recordId);
    const invalidPayload = { ...filteredPayload, sourceBatchId: invalidBatchId };
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      assert.throws(
        () => inspectExact(db, transactionScope, invalidPayload, configSnapshot),
        hasExactCode('PREDICTION_HISTORY_DATA_INTEGRITY_ERROR')
      );
    });
    db.exec('ROLLBACK');
    assert.throws(
      () => predictionService.createPredictionRun(invalidPayload),
      hasExactCode('PREDICTION_HISTORY_DATA_INTEGRITY_ERROR')
    );
  });

  // 两种算法的大有限值中间溢出必须受控报错，exact 与普通路径均不产生 completed zero。
  const overflowBatchId = insertImportBatch(db, 'prediction-overflow.csv');
  ['2026-01', '2026-02', '2026-03'].forEach((month, index) => {
    insertEnergyRecord(db, {
      sourceBatchId: overflowBatchId,
      sourceRowNumber: index + 2,
      energyTypeId: electricityId,
      organizationUnitId: organizationAId,
      meterDeviceId: electricityMeterAId,
      month,
      unit: 'kWh',
      value: Number.MAX_VALUE / 2,
      remark: '算法溢出持久事实',
      duplicateKey: `prediction-overflow-${index}`,
      recordStatus: 'active'
    });
  });
  ['moving_average', 'linear_trend'].forEach((algorithm) => {
    const overflowPayload = {
      ...filteredPayload,
      sourceBatchId: overflowBatchId,
      trainEndMonth: '2026-03',
      algorithm
    };
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      assert.throws(
        () => inspectExact(db, transactionScope, overflowPayload, configSnapshot),
        hasExactCode('PREDICTION_NUMERIC_INTEGRITY_ERROR')
      );
      assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    });
    db.exec('ROLLBACK');
    assert.throws(
      () => predictionService.createPredictionRun(overflowPayload),
      hasExactCode('PREDICTION_NUMERIC_INTEGRITY_ERROR')
    );
  });

  // 全部不足和无历史在 inspect 中形成 blocker，exact execute 在任何 run 写入前 fail-closed。
  const allInsufficientPayload = {
    name: 'Prediction exact all insufficient',
    energyTypeCode: 'water',
    organizationUnitCode: 'PRED-EXACT-A',
    meterCode: 'PRED-WATER-A',
    sourceBatchId: targetBatchId,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-04',
    predictStartMonth: '2026-05',
    predictEndMonth: '2026-05',
    algorithm: 'linear_trend'
  };
  const noHistoryPayload = {
    ...filteredPayload,
    name: 'Prediction exact no history',
    sourceBatchId: emptyBatchId
  };
  [
    [allInsufficientPayload, 'PREDICTION_EXACT_NO_ELIGIBLE_GROUPS'],
    [noHistoryPayload, 'PREDICTION_EXACT_NO_HISTORY']
  ].forEach(([payload, blockerCode]) => {
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, payload, configSnapshot);
      assert.strictEqual(inspected.summary.executable, false);
      assert.strictEqual(inspected.summary.blockers[0].code, blockerCode);
      assert.throws(
        () => executeExact(db, transactionScope, inspected.exactCapability, identities),
        hasExactCode('PREDICTION_EXACT_EXECUTION_BLOCKED')
      );
      assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    });
    db.exec('ROLLBACK');
  });

  // capability/witness clone、JSON 伪造与重复消费拒绝，但合法原对象仍可完成。
  db.exec('BEGIN IMMEDIATE');
  withExactScope(db, identities, (transactionScope) => {
    const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
    assert.throws(
      () => executeExact(db, transactionScope, { ...inspected.exactCapability }, identities),
      hasExactCode('PREDICTION_EXACT_CAPABILITY_REQUIRED')
    );
    assert.throws(
      () => executeExact(
        db,
        transactionScope,
        JSON.parse(JSON.stringify(inspected.exactCapability)),
        identities
      ),
      hasExactCode('PREDICTION_EXACT_CAPABILITY_REQUIRED')
    );
    const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
    assert.throws(
      () => executeExact(db, transactionScope, inspected.exactCapability, identities),
      hasExactCode('PREDICTION_EXACT_CAPABILITY_REPLAY')
    );
    assert.throws(
      () => readWitness(db, transactionScope, { ...executed.completionWitness }, identities),
      hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_REQUIRED')
    );
    assert.throws(
      () => readWitness(
        db,
        transactionScope,
        JSON.parse(JSON.stringify(executed.completionWitness)),
        identities
      ),
      hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_REQUIRED')
    );
    readWitness(db, transactionScope, executed.completionWitness, identities);
    assert.throws(
      () => readWitness(db, transactionScope, executed.completionWitness, identities),
      hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_READ_REPLAY')
    );
    consumeWitness(db, transactionScope, executed.completionWitness, identities);
    assert.throws(
      () => consumeWitness(db, transactionScope, executed.completionWitness, identities),
      hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_REPLAY')
    );
  });
  db.exec('ROLLBACK');
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });

  // 同 PK、同 snapshot 删除重建也必须使旧 witness 失效，不能只比较最终行内容。
  db.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => withExactScope(db, identities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
      const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
      const result = db.prepare(`SELECT id, prediction_run_id AS predictionRunId,
          energy_type_id AS energyTypeId, target_month AS targetMonth,
          predicted_value AS predictedValue, predicted_unit AS predictedUnit,
          confidence_low AS confidenceLow, confidence_high AS confidenceHigh,
          method_note AS methodNote, created_at AS createdAt
        FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1`).get(
        executed.run.id
      );
      db.prepare('DELETE FROM prediction_results WHERE id = ?').run(result.id);
      db.prepare(`INSERT INTO prediction_results
        (id, prediction_run_id, energy_type_id, target_month, predicted_value,
         predicted_unit, confidence_low, confidence_high, method_note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        result.id,
        result.predictionRunId,
        result.energyTypeId,
        result.targetMonth,
        result.predictedValue,
        result.predictedUnit,
        result.confidenceLow,
        result.confidenceHigh,
        result.methodNote,
        result.createdAt
      );
      consumeWitness(db, transactionScope, executed.completionWitness, identities);
    }),
    hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_FACT_MISMATCH')
  );
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  db.exec('ROLLBACK');

  // capability/witness 跨 scope 会 poison 错误 scope，但不消费原 scope 的原始能力。
  db.exec('BEGIN IMMEDIATE');
  withExactScope(db, identities, (transactionScope) => {
    const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
    assert.throws(
      () => withExactScope(db, identities, (otherTransactionScope) => {
        try {
          executeExact(db, otherTransactionScope, inspected.exactCapability, identities);
        } catch (error) {
          assert.strictEqual(error.details?.code, 'PREDICTION_EXACT_CAPABILITY_BINDING_MISMATCH');
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
    assert.throws(
      () => withExactScope(db, identities, (otherTransactionScope) => {
        try {
          readWitness(db, otherTransactionScope, executed.completionWitness, identities);
        } catch (error) {
          assert.strictEqual(error.details?.code, 'PREDICTION_EXACT_COMPLETION_WITNESS_BINDING_MISMATCH');
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    consumeWitness(db, transactionScope, executed.completionWitness, identities);
  });
  db.exec('ROLLBACK');
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });

  // 同物理 SQLite 的第二连接、不同 DB 和 clone invocation 均 poison scope，调用方捕获也不能提交。
  [samePhysicalDb, crossDb].forEach((foreignDb) => {
    db.exec('BEGIN IMMEDIATE');
    let capturedCode = null;
    assert.throws(
      () => withExactScope(db, identities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        try {
          executeExact(foreignDb, transactionScope, inspected.exactCapability, identities);
        } catch (error) {
          capturedCode = error.details?.code;
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    assert.strictEqual(capturedCode, 'PREDICTION_EXACT_TRANSACTION_SCOPE_DATABASE_MISMATCH');
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    db.exec('ROLLBACK');

    db.exec('BEGIN IMMEDIATE');
    capturedCode = null;
    assert.throws(
      () => withExactScope(db, identities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
        try {
          readWitness(foreignDb, transactionScope, executed.completionWitness, identities);
        } catch (error) {
          capturedCode = error.details?.code;
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    assert.strictEqual(capturedCode, 'PREDICTION_EXACT_TRANSACTION_SCOPE_DATABASE_MISMATCH');
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    db.exec('ROLLBACK');
  });

  db.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => withExactScope(db, identities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
      try {
        executeExact(db, transactionScope, inspected.exactCapability, {
          ...identities,
          actor: Object.freeze({ userId: identities.actor.userId })
        });
      } catch (_error) {
        // 模拟调用方吞掉绑定错误；scope 仍必须 poison 并回滚。
      }
    }),
    hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
  );
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  db.exec('ROLLBACK');

  // 同一 invocation 对象的直接字段和嵌套字段漂移必须被 digest 识别并 poison。
  [
    () => { mutableIdentities.actor.userId = 999; },
    () => { mutableIdentities.demoRun.metadata.version = 2; }
  ].forEach((mutateIdentity, index) => {
    mutableIdentities.actor.userId = 503;
    mutableIdentities.demoRun.metadata.version = 1;
    db.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => withExactScope(db, mutableIdentities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        mutateIdentity();
        try {
          executeExact(db, transactionScope, inspected.exactCapability, mutableIdentities);
        } catch (error) {
          assert.strictEqual(error.details?.code, 'PREDICTION_EXACT_INVOCATION_BINDING_MISMATCH', `identity drift ${index}`);
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    db.exec('ROLLBACK');
  });
  mutableIdentities.actor.userId = 503;
  mutableIdentities.demoRun.metadata.version = 1;

  // scope 创建后嵌套数组原型漂移时，execute/read/consume 都必须拒绝并 poison，且不得执行原型 getter。
  ['execute', 'read', 'consume'].forEach((operationName) => {
    const scopes = ['prediction:run'];
    const prototypeDriftIdentities = {
      demoRun: { id: 601, metadata: { scopes } },
      actionRun: { id: 602, actionKey: 'prediction-run' },
      actor: { userId: 603 }
    };
    db.exec('BEGIN IMMEDIATE');
    let identityErrorCode = null;
    assert.throws(
      () => withExactScope(db, prototypeDriftIdentities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        const executed = operationName === 'execute'
          ? null
          : executeExact(
            db,
            transactionScope,
            inspected.exactCapability,
            prototypeDriftIdentities
          );
        Object.setPrototypeOf(scopes, customArrayPrototype);
        try {
          if (operationName === 'execute') {
            executeExact(db, transactionScope, inspected.exactCapability, prototypeDriftIdentities);
          } else if (operationName === 'read') {
            readWitness(
              db,
              transactionScope,
              executed.completionWitness,
              prototypeDriftIdentities
            );
          } else {
            consumeWitness(
              db,
              transactionScope,
              executed.completionWitness,
              prototypeDriftIdentities
            );
          }
        } catch (error) {
          identityErrorCode = error.details?.code;
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
    );
    assert.strictEqual(identityErrorCode, 'PREDICTION_EXACT_IDENTITY_VALUE_INVALID');
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    db.exec('ROLLBACK');
  });
  assert.strictEqual(customPrototypeGetterReads, 0, '原型漂移校验不得触发自定义 getter。');

  // execute 后、consume 前发生同对象嵌套身份漂移时，已写 run/results 必须由 poisoned scope 回滚。
  mutableIdentities.actionRun.metadata.attempt = 1;
  db.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => withExactScope(db, mutableIdentities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
      const executed = executeExact(db, transactionScope, inspected.exactCapability, mutableIdentities);
      mutableIdentities.actionRun.metadata.attempt = 2;
      try {
        consumeWitness(db, transactionScope, executed.completionWitness, mutableIdentities);
      } catch (error) {
        assert.strictEqual(error.details?.code, 'PREDICTION_EXACT_INVOCATION_BINDING_MISMATCH');
      }
    }),
    hasExactCode('PREDICTION_EXACT_SCOPE_POISONED')
  );
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  db.exec('ROLLBACK');
  mutableIdentities.actionRun.metadata.attempt = 1;

  // witness 对 run 删除、result 删除/新增、字段与 status 漂移均拒绝并回滚全部 exact 写入。
  const witnessDriftMutations = [
    (runId) => db.prepare('DELETE FROM prediction_runs WHERE id = ?').run(runId),
    (runId) => db.prepare(`DELETE FROM prediction_results WHERE id = (
      SELECT id FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1
    )`).run(runId),
    (runId) => db.prepare(`INSERT INTO prediction_results
      (prediction_run_id, energy_type_id, target_month, predicted_value, predicted_unit,
        confidence_low, confidence_high, method_note)
      SELECT ?, energy_type_id, '2099-01', predicted_value, predicted_unit,
        confidence_low, confidence_high, '额外结果漂移'
      FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1`).run(runId, runId),
    (runId) => db.prepare(`UPDATE prediction_results SET predicted_value = predicted_value + 1
      WHERE id = (SELECT id FROM prediction_results WHERE prediction_run_id = ? ORDER BY id LIMIT 1)`)
      .run(runId),
    (runId) => db.prepare('UPDATE prediction_runs SET status = ? WHERE id = ?').run('failed', runId)
  ];
  witnessDriftMutations.forEach((mutateFacts) => {
    db.exec('BEGIN IMMEDIATE');
    withExactScope(db, identities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
      const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
      mutateFacts(executed.run.id);
      assert.throws(
        () => consumeWitness(db, transactionScope, executed.completionWitness, identities),
        hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_FACT_MISMATCH')
      );
      assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
    });
    db.exec('ROLLBACK');
  });

  // 调用方释放父 SAVEPOINT 并吞掉 read/consume marker 错误时，scope 必须 fatal 且完整回滚。
  ['read', 'consume'].forEach((operationName) => {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`SAVEPOINT caller_parent_${operationName}`);
    let markerErrorCode = null;
    assert.throws(
      () => withExactScope(db, identities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
        db.exec(`RELEASE SAVEPOINT caller_parent_${operationName}`);
        try {
          if (operationName === 'read') {
            readWitness(db, transactionScope, executed.completionWitness, identities);
          } else {
            consumeWitness(db, transactionScope, executed.completionWitness, identities);
          }
        } catch (error) {
          markerErrorCode = error.details?.code;
        }
      }),
      hasExactCode('PREDICTION_EXACT_SCOPE_RECOVERY_FAILED')
    );
    assert.strictEqual(markerErrorCode, 'PREDICTION_EXACT_COMPLETION_WITNESS_TRANSACTION_MISMATCH');
    assert.strictEqual(db.inTransaction, false);
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  });

  // scope 结束后的 capability 和未消费 witness 都失效，未消费 witness 对应写入自动回滚。
  db.exec('BEGIN IMMEDIATE');
  let expiredCapability;
  let expiredScope;
  withExactScope(db, identities, (transactionScope) => {
    expiredScope = transactionScope;
    expiredCapability = inspectExact(db, transactionScope, filteredPayload, configSnapshot).exactCapability;
  });
  assert.throws(
    () => executeExact(db, expiredScope, expiredCapability, identities),
    hasExactCode('PREDICTION_EXACT_TRANSACTION_SCOPE_REQUIRED')
  );
  let expiredWitness;
  assert.throws(
    () => withExactScope(db, identities, (transactionScope) => {
      const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
      const executed = executeExact(db, transactionScope, inspected.exactCapability, identities);
      expiredWitness = executed.completionWitness;
      return executed;
    }),
    hasExactCode('PREDICTION_EXACT_P4_OBLIGATION_PENDING')
  );
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  withExactScope(db, identities, (transactionScope) => {
    assert.throws(
      () => readWitness(db, transactionScope, expiredWitness, identities),
      hasExactCode('PREDICTION_EXACT_COMPLETION_WITNESS_REPLAY')
    );
  });
  db.exec('ROLLBACK');

  // capability/witness 在原事务 ROLLBACK 后 re-BEGIN 时 marker 已不存在，scope 严格 fail-closed。
  ['capability', 'witness'].forEach((stage) => {
    db.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => withExactScope(db, identities, (transactionScope) => {
        const inspected = inspectExact(db, transactionScope, filteredPayload, configSnapshot);
        const executed = stage === 'witness'
          ? executeExact(db, transactionScope, inspected.exactCapability, identities)
          : null;
        db.exec('ROLLBACK');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (stage === 'capability') {
            executeExact(db, transactionScope, inspected.exactCapability, identities);
          } else {
            consumeWitness(db, transactionScope, executed.completionWitness, identities);
          }
        } catch (_error) {
          // 模拟调用方吞掉跨事务错误，scope 仍必须恢复失败并结束新事务。
        }
      }),
      (error) => error?.code === 'DATABASE_TRANSACTION_OBLIGATION_PENDING'
    );
    assert.strictEqual(db.inTransaction, true);
    db.exec('ROLLBACK');
    assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });
  });

  // capability 创建后提前 COMMIT 也必须被 callback 生命周期门禁拒绝并保留 caller 外层事务。
  const closedLifecycleDb = openDatabase();
  closedLifecycleDb.exec('BEGIN IMMEDIATE');
  assert.throws(
    () => withExactScope(closedLifecycleDb, identities, (transactionScope) => {
      const inspected = inspectExact(
        closedLifecycleDb,
        transactionScope,
        filteredPayload,
        configSnapshot
      );
      closedLifecycleDb.exec('COMMIT');
      try {
        executeExact(
          closedLifecycleDb,
          transactionScope,
          inspected.exactCapability,
          identities
        );
      } catch (_error) {
        // 模拟调用方吞掉原事务已结束错误。
      }
    }),
    (error) => error?.code === 'DATABASE_TRANSACTION_OBLIGATION_PENDING'
  );
  assert.strictEqual(closedLifecycleDb.open, true);
  assert.strictEqual(closedLifecycleDb.inTransaction, true);
  closedLifecycleDb.exec('ROLLBACK');
  closedLifecycleDb.close();
  assert.deepStrictEqual(readPredictionCounts(db), { runs: 0, results: 0 });

  // 正式 XLSX 导入允许非 canonical 月份原值，并由普通与 exact Prediction 原样保留追溯事实。
  const importedOrganizationCode = 'PRED-IMPORTED-MONTH';
  const importedMeterCode = 'PRED-IMPORTED-METER';
  const importedOrganizationId = insertOrganization(
    db,
    importedOrganizationCode,
    'Prediction Imported Month'
  );
  insertMeter(
    db,
    importedMeterCode,
    electricityId,
    importedOrganizationId
  );
  const excelMonthValue = new Date(2026, 2, 1);
  const importWorkbook = XLSX.utils.book_new();
  const importSheet = XLSX.utils.aoa_to_sheet([
    [
      '月份',
      '能源类型编码',
      '用量',
      '单位',
      '用能单元编码',
      '计量器具编码',
      '备注'
    ],
    [
      '2026/01',
      'electricity',
      100,
      'kWh',
      importedOrganizationCode,
      importedMeterCode,
      '斜杠月份原值'
    ],
    [
      '2026.02',
      'electricity',
      110,
      'kWh',
      importedOrganizationCode,
      importedMeterCode,
      '点号月份原值'
    ],
    [
      excelMonthValue,
      'electricity',
      120,
      'kWh',
      importedOrganizationCode,
      importedMeterCode,
      'Excel 日期单元格原值'
    ]
  ], {
    cellDates: true,
    dateNF: 'yyyy-mm-dd'
  });
  XLSX.utils.book_append_sheet(importWorkbook, importSheet, '能耗数据');
  const importedWorkbookPath = path.join(
    tmpDir,
    'prediction-original-month.xlsx'
  );
  XLSX.writeFile(importWorkbook, importedWorkbookPath, {
    bookType: 'xlsx',
    cellDates: true
  });
  const formalImport = createImportBatchFromUpload(
    buildUploadFile(
      importedWorkbookPath,
      'prediction-original-month.xlsx'
    )
  );
  assert.strictEqual(formalImport.status, 'completed');
  assert.strictEqual(formalImport.successCount, 3);
  assert.strictEqual(formalImport.failureCount, 0);
  const persistedImportedRecords = db.prepare(`SELECT id,
      source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber,
      original_month AS originalMonth,
      normalized_month AS normalizedMonth
    FROM energy_records
    WHERE source_batch_id = ?
    ORDER BY source_row_number ASC`).all(formalImport.id);
  assert.deepStrictEqual(
    persistedImportedRecords.map((record) => record.normalizedMonth),
    ['2026-01', '2026-02', '2026-03']
  );
  assert.strictEqual(persistedImportedRecords[0].originalMonth, '2026/01');
  assert.strictEqual(persistedImportedRecords[1].originalMonth, '2026.02');
  assert.strictEqual(
    persistedImportedRecords[2].originalMonth,
    String(excelMonthValue)
  );
  const importedPredictionPayload = {
    name: 'Prediction imported original month',
    energyTypeCode: 'electricity',
    organizationUnitCode: importedOrganizationCode,
    meterCode: importedMeterCode,
    sourceBatchId: formalImport.id,
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-03',
    predictStartMonth: '2026-04',
    predictEndMonth: '2026-04',
    algorithm: 'linear_trend'
  };
  const ordinaryImportedPrediction = predictionService.createPredictionRun(
    importedPredictionPayload
  );
  assert.strictEqual(ordinaryImportedPrediction.run.status, 'completed');
  assert.strictEqual(ordinaryImportedPrediction.summary.resultCount, 1);
  const importedIdentities = {
    demoRun: { id: 601, runCode: 'imported-month-demo' },
    actionRun: { id: 602, actionKey: 'prediction-run' },
    actor: { userId: 603, username: 'imported-month-actor' }
  };
  db.exec('BEGIN IMMEDIATE');
  const importedMonthFacts = withExactScope(
    db,
    importedIdentities,
    (transactionScope) => {
      const inspected = inspectExact(
        db,
        transactionScope,
        importedPredictionPayload
      );
      assert.deepStrictEqual(
        inspected.summary.exactTrainingRecords.map(
          (record) => record.originalMonth
        ),
        persistedImportedRecords.map((record) => record.originalMonth)
      );
      const executed = executeExact(
        db,
        transactionScope,
        inspected.exactCapability,
        importedIdentities
      );
      const readFacts = readWitness(
        db,
        transactionScope,
        executed.completionWitness,
        importedIdentities
      );
      assert.deepStrictEqual(
        readFacts.exactTrainingRecords.map(
          (record) => record.originalMonth
        ),
        persistedImportedRecords.map((record) => record.originalMonth)
      );
      return consumeWitness(
        db,
        transactionScope,
        executed.completionWitness,
        importedIdentities
      );
    }
  );
  assert.strictEqual(importedMonthFacts.status, 'completed');
  assert.strictEqual(importedMonthFacts.resultCount, 1);
  assert.deepStrictEqual(
    importedMonthFacts.exactTrainingRecords.map(
      (record) => ({ id: record.id, originalMonth: record.originalMonth })
    ),
    persistedImportedRecords.map(
      (record) => ({ id: record.id, originalMonth: record.originalMonth })
    )
  );
  db.exec('ROLLBACK');

  // canonical sourceBatchFilterId 支持 camel/snake 写入，旧 sourceBatchId 仅作为非 DTO 兼容别名。
  const canonicalConfigInput = {
    name: 'Prediction canonical filter create',
    energyTypeCode: 'electricity',
    organizationUnitCode: 'PRED-EXACT-A',
    meterCode: 'PRED-ELECTRIC-A',
    trainStartMonth: '2026-01',
    trainEndMonth: '2026-04',
    predictStartMonth: '2026-05',
    predictEndMonth: '2026-05',
    algorithm: 'linear_trend',
    status: 'draft'
  };
  const canonicalCreatedConfig = predictionService.createPredictionConfig({
    ...canonicalConfigInput,
    sourceBatchFilterId: targetBatchId
  });
  assert.strictEqual(canonicalCreatedConfig.sourceBatchId, null);
  assert.strictEqual(canonicalCreatedConfig.sourceBatchFilterId, targetBatchId);
  const canonicalSnakeUpdatedConfig = predictionService.updatePredictionConfig(
    canonicalCreatedConfig.id,
    { source_batch_filter_id: otherBatchId }
  );
  assert.strictEqual(canonicalSnakeUpdatedConfig.sourceBatchFilterId, otherBatchId);
  const canonicalRestoredConfig = predictionService.updatePredictionConfig(
    canonicalCreatedConfig.id,
    { sourceBatchFilterId: targetBatchId }
  );
  assert.strictEqual(canonicalRestoredConfig.sourceBatchFilterId, targetBatchId);
  const canonicalConfigRun = predictionService.createRunFromConfig(canonicalCreatedConfig.id);
  assert.strictEqual(canonicalConfigRun.run.status, 'completed');
  assert.strictEqual(
    canonicalConfigRun.run.parameters.filters.sourceBatchId,
    targetBatchId
  );
  const canonicalSnakeCreatedConfig = predictionService.createPredictionConfig({
    ...canonicalConfigInput,
    name: 'Prediction canonical snake create',
    source_batch_filter_id: targetBatchId
  });
  assert.strictEqual(canonicalSnakeCreatedConfig.sourceBatchFilterId, targetBatchId);
  assert.strictEqual(predictionService.normalizeConfigPayload({
    ...canonicalConfigInput,
    sourceBatchFilterId: targetBatchId,
    sourceBatchId: targetBatchId
  }).filters.sourceBatchId, targetBatchId);
  assert.throws(
    () => predictionService.normalizeConfigPayload({
      ...canonicalConfigInput,
      sourceBatchFilterId: targetBatchId,
      sourceBatchId: otherBatchId
    }),
    hasExactCode('PREDICTION_ALIAS_CONFLICT')
  );

  // 配置 provenance batch 与训练 filter batch 严格分离，完整 GET DTO、更新、运行和导出都只使用 filter。
  const filteredConfigId = Number(db.prepare(`INSERT INTO prediction_configs
    (source_batch_id, source_row_number, name, energy_type_id, organization_unit_id,
      meter_device_id, source_batch_filter_id, train_start_month, train_end_month,
      predict_start_month, predict_end_month, algorithm, window_size, status)
    VALUES (?, 2, 'Prediction provenance filtered', ?, ?, ?, ?, '2026-01', '2026-04',
      '2026-05', '2026-05', 'linear_trend', NULL, 'draft')`).run(
    otherBatchId,
    electricityId,
    organizationAId,
    electricityMeterAId,
    targetBatchId
  ).lastInsertRowid);
  const fullFilteredConfigDto = predictionService.getPredictionConfig(filteredConfigId);
  assert.strictEqual(fullFilteredConfigDto.sourceBatchId, otherBatchId);
  assert.strictEqual(fullFilteredConfigDto.sourceBatchFilterId, targetBatchId);
  const roundTrippedFilteredConfig = predictionService.updatePredictionConfig(filteredConfigId, {
    ...fullFilteredConfigDto,
    name: 'Prediction provenance filtered DTO round-trip'
  });
  assert.strictEqual(roundTrippedFilteredConfig.sourceBatchId, otherBatchId);
  assert.strictEqual(roundTrippedFilteredConfig.sourceBatchFilterId, targetBatchId);
  const updatedFilteredConfig = predictionService.updatePredictionConfig(filteredConfigId, {
    name: 'Prediction provenance filtered updated'
  });
  assert.strictEqual(updatedFilteredConfig.sourceBatchId, otherBatchId);
  assert.strictEqual(updatedFilteredConfig.sourceBatchFilterId, targetBatchId);
  const filteredConfigRun = predictionService.createRunFromConfig(filteredConfigId);
  assert.strictEqual(filteredConfigRun.run.status, 'completed');
  assert.strictEqual(filteredConfigRun.summary.resultCount, 1);
  const filteredExportText = predictionService.exportPredictionConfigs({
    format: 'csv',
    keyword: 'Prediction provenance filtered updated'
  }).body.toString('utf8');
  assert.match(filteredExportText, new RegExp(`"${targetBatchId}"`));
  assert.doesNotMatch(filteredExportText, new RegExp(`"${otherBatchId}"(?=,"2026-01")`));

  const nullFilterConfigId = Number(db.prepare(`INSERT INTO prediction_configs
    (source_batch_id, source_row_number, name, energy_type_id, organization_unit_id,
      meter_device_id, source_batch_filter_id, train_start_month, train_end_month,
      predict_start_month, predict_end_month, algorithm, window_size, status)
    VALUES (?, 3, 'Prediction provenance null filter', ?, ?, ?, NULL, '2026-01', '2026-04',
      '2026-05', '2026-05', 'linear_trend', NULL, 'draft')`).run(
    otherBatchId,
    electricityId,
    organizationAId,
    electricityMeterAId
  ).lastInsertRowid);
  const updatedNullFilterConfig = predictionService.updatePredictionConfig(nullFilterConfigId, {
    name: 'Prediction provenance null filter updated'
  });
  assert.strictEqual(updatedNullFilterConfig.sourceBatchId, otherBatchId);
  assert.strictEqual(updatedNullFilterConfig.sourceBatchFilterId, null);

  db.prepare('DELETE FROM prediction_results').run();
  db.prepare('DELETE FROM prediction_runs').run();
  db.prepare('DELETE FROM prediction_configs').run();

  // 普通管理 API 继续保留样本不足时持久化 failed run 的既有语义。
  const ordinaryFailed = predictionService.createPredictionRun(noHistoryPayload);
  assert.strictEqual(ordinaryFailed.run.status, 'failed');
  assert.strictEqual(ordinaryFailed.summary.resultCount, 0);
  assert.strictEqual(readPredictionCounts(db).runs, 1);
  assert.strictEqual(readPredictionCounts(db).results, 0);

  const failedConfig = predictionService.createPredictionConfig({
    ...noHistoryPayload,
    name: 'Prediction config failed run',
    status: 'draft'
  });
  const failedConfigRun = predictionService.createRunFromConfig(failedConfig.id);
  assert.strictEqual(failedConfigRun.run.status, 'failed');
  assert.strictEqual(failedConfigRun.summary.resultCount, 0);
  assert.strictEqual(readPredictionCounts(db).runs, 2);
  assert.strictEqual(readPredictionCounts(db).results, 0);

  console.log('prediction exact core tests passed');
} finally {
  if (crossDb.inTransaction) crossDb.exec('ROLLBACK');
  if (samePhysicalDb.inTransaction) samePhysicalDb.exec('ROLLBACK');
  if (db.inTransaction) db.exec('ROLLBACK');
  crossDb.close();
  samePhysicalDb.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
