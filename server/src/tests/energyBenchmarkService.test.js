'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 全部测试数据使用系统临时目录和隔离 SQLite。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-benchmark-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-benchmark-service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const {
  ENERGY_BENCHMARK_REASON_CODES,
  buildBenchmarkExportRows,
  calculateBenchmarkQualificationRate,
  createBenchmarkDefinition: createBenchmarkDefinitionService,
  createBenchmarkTarget: createBenchmarkTargetService,
  createInternalHistoryBenchmark: createInternalHistoryBenchmarkService,
  evaluateEnergyBenchmark,
  getBenchmarkDefinition,
  getBenchmarkTarget,
  listBenchmarkDefinitions,
  listBenchmarkTargets,
  rankEnergyBenchmark,
  setBenchmarkDefinitionStatus: setBenchmarkDefinitionStatusService,
  setBenchmarkTargetStatus: setBenchmarkTargetStatusService,
  updateBenchmarkDefinition: updateBenchmarkDefinitionService,
  updateBenchmarkTarget: updateBenchmarkTargetService
} = require('../services/energyBenchmarkService');

// 写操作统一使用隔离库内置管理员作为可复核审计操作者。
const TEST_ACTOR = { userId: 1, username: 'admin', ip: '127.0.0.1' };

/**
 * 合并测试钩子和必填审计操作者。
 * @param {object} options 可选测试依赖。
 * @returns {object} 写操作选项。
 */
function auditOptions(options = {}) {
  return { ...options, actor: TEST_ACTOR };
}

// 以下包装器确保现有场景的每个领域写操作都携带操作者。
function createBenchmarkDefinition(input, options) {
  return createBenchmarkDefinitionService(input, auditOptions(options));
}
function updateBenchmarkDefinition(id, input, options) {
  return updateBenchmarkDefinitionService(id, input, auditOptions(options));
}
function setBenchmarkDefinitionStatus(id, status, options) {
  return setBenchmarkDefinitionStatusService(id, status, auditOptions(options));
}
function createBenchmarkTarget(input, options) {
  return createBenchmarkTargetService(input, auditOptions(options));
}
function updateBenchmarkTarget(id, input, options) {
  return updateBenchmarkTargetService(id, input, auditOptions(options));
}
function setBenchmarkTargetStatus(id, status, options) {
  return setBenchmarkTargetStatusService(id, status, auditOptions(options));
}
function createInternalHistoryBenchmark(input, options) {
  return createInternalHistoryBenchmarkService(input, auditOptions(options));
}

/**
 * 捕获同步领域错误并校验稳定错误码。
 * @param {Function} callback 预期失败操作。
 * @returns {Error} 捕获的错误。
 */
function captureError(callback) {
  try {
    callback();
  } catch (error) {
    assert(error.details?.code, `错误必须包含稳定 details.code：${error.stack || error}`);
    return error;
  }
  assert.fail('预期操作失败，但实际成功。');
}

/**
 * 初始化组织和产品范围主数据。
 */
function seedMasterData() {
  const db = openDatabase();
  try {
    const organizationId = Number(db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('OU-BENCH', '对标车间', '/OU-BENCH', 'workshop', 'active')`).run().lastInsertRowid);
    db.prepare(`INSERT INTO organization_units
      (unit_code, unit_name, unit_path, unit_type, status)
      VALUES ('OU-INACTIVE', '停用车间', '/OU-INACTIVE', 'workshop', 'inactive')`).run();
    const productionUnitId = Number(db.prepare(`INSERT INTO production_units
      (unit_code, unit_name, organization_unit_id, product_name, output_unit, status)
      VALUES ('PU-BENCH', '产品对标线', ?, '产品A', 't', 'active')`).run(organizationId).lastInsertRowid);
    const energyType = db.prepare(`SELECT id, standard_unit AS standardUnit FROM energy_types
      WHERE code = 'electricity'`).get();
    assert(energyType, '初始化数据库必须包含 electricity 能源类型。');
    const insertOutput = db.prepare(`INSERT INTO production_output_records
      (production_unit_id, normalized_month, output_value, output_unit, data_source, record_status)
      VALUES (?, ?, ?, 't', 'manual', 'active')`);
    insertOutput.run(productionUnitId, '2025-01', 10);
    insertOutput.run(productionUnitId, '2025-02', 20);
    const insertEnergy = db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
    insertEnergy.run(energyType.id, organizationId, '2025-01', '2025-01', energyType.standardUnit,
      100, energyType.standardUnit, 100, 'benchmark-history-2025-01');
    insertEnergy.run(energyType.id, organizationId, '2025-02', '2025-02', energyType.standardUnit,
      120, energyType.standardUnit, 120, 'benchmark-history-2025-02');
  } finally {
    db.close();
  }
}

/**
 * 创建合法定义输入。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 定义输入。
 */
function createDefinitionInput(overrides = {}) {
  return {
    benchmarkCode: 'BENCH-LOWER',
    benchmarkName: '单位产品能耗企业目标',
    benchmarkType: 'manual_benchmark',
    metricCode: 'energy_intensity',
    unit: 'kgce/t',
    periodType: 'month',
    scopeType: 'organization',
    scopeReference: 'OU-BENCH',
    direction: 'lower_better',
    source: '企业自定义目标',
    documentNo: null,
    version: 'lower-definition:v1',
    effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z',
    sourceTimeZone: 'Asia/Shanghai',
    status: 'active',
    ...overrides
  };
}

/**
 * 创建合法普通目标输入。
 * @param {number} definitionId 定义主键。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 目标输入。
 */
function createTargetInput(definitionId, overrides = {}) {
  return {
    benchmarkDefinitionId: definitionId,
    targetValue: 100,
    lowerBound: null,
    upperBound: null,
    version: 'lower-target:v1',
    status: 'active',
    ...overrides
  };
}

/**
 * 创建合法实际值上下文。
 * @param {number} actualValue 实际值。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 实际值上下文。
 */
function createActual(actualValue, overrides = {}) {
  return {
    objectId: 'WORKSHOP-1',
    objectName: '一号车间',
    objectLevel: 'workshop',
    actualValue,
    metricCode: 'energy_intensity',
    unit: 'kgce/t',
    periodType: 'month',
    periodStartUtc: '2026-06-01T00:00:00Z',
    periodEndUtc: '2026-07-01T00:00:00Z',
    scopeType: 'organization',
    scopeReference: 'WORKSHOP-1',
    benchmarkScopeReference: 'OU-BENCH',
    energyTypeCode: 'electricity',
    ...overrides
  };
}

/**
 * 验证定义和目标 CRUD、启停、分页和版本保护。
 * @returns {{definition:object,target:object}} 基础定义和目标。
 */
function testCrudAndStatus() {
  const definition = createBenchmarkDefinition(createDefinitionInput());
  assert.strictEqual(definition.status, 'active');
  assert.strictEqual(definition.benchmarkType, 'manual_benchmark');

  const definitionList = listBenchmarkDefinitions({ page: 1, pageSize: 10, status: 'active' });
  assert.strictEqual(definitionList.total, 1);
  assert.strictEqual(definitionList.items[0].id, definition.id);
  assert.strictEqual(captureError(() => listBenchmarkDefinitions({ pageSize: 101 })).details.code, 'BENCHMARK_INVALID_PAGE_SIZE');

  const updatedDefinition = updateBenchmarkDefinition(definition.id, createDefinitionInput({ benchmarkName: '更新后的企业目标' }));
  assert.strictEqual(updatedDefinition.benchmarkName, '更新后的企业目标');

  const target = createBenchmarkTarget(createTargetInput(definition.id));
  assert.strictEqual(target.targetValue, 100);
  assert.strictEqual(target.isFrozen, false);
  assert.strictEqual(getBenchmarkDefinition(definition.id).targets.length, 1);
  assert.strictEqual(getBenchmarkTarget(target.id).definition.id, definition.id);

  const targetList = listBenchmarkTargets({ definitionId: definition.id, page: 1, pageSize: 10 });
  assert.strictEqual(targetList.total, 1);

  const changedTarget = updateBenchmarkTarget(target.id, {
    targetValue: 90,
    lowerBound: null,
    upperBound: null,
    version: 'lower-target-next:v1',
    status: 'active'
  });
  assert.strictEqual(changedTarget.targetValue, 90);
  assert.strictEqual(changedTarget.predecessorTargetId, target.id);
  assert.strictEqual(getBenchmarkTarget(target.id).status, 'inactive', '旧目标版本必须保留并停用。');

  const versionError = captureError(() => updateBenchmarkTarget(changedTarget.id, {
    targetValue: 85,
    version: 'lower-target-next:v1',
    status: 'active'
  }));
  assert.strictEqual(versionError.details.code, 'BENCHMARK_TARGET_VERSION_CONFLICT');

  const definitionVersionError = captureError(() => updateBenchmarkDefinition(definition.id,
    createDefinitionInput({ metricCode: 'changed_metric' })));
  assert.strictEqual(definitionVersionError.details.code, 'BENCHMARK_DEFINITION_VERSION_CONFLICT');
  assert(definitionVersionError.details.fields.includes('metricCode'));

  const inactiveTarget = createBenchmarkTarget(createTargetInput(definition.id, {
    targetValue: 80,
    version: 'lower-target-third:v1',
    status: 'inactive'
  }));
  const activeConflict = captureError(() => setBenchmarkTargetStatus(inactiveTarget.id, 'active'));
  assert.strictEqual(activeConflict.details.code, 'BENCHMARK_TARGET_ACTIVE_CONFLICT');

  assert.strictEqual(setBenchmarkTargetStatus(changedTarget.id, 'inactive').status, 'inactive');
  assert.strictEqual(setBenchmarkTargetStatus(inactiveTarget.id, 'active').status, 'active');
  assert.strictEqual(setBenchmarkTargetStatus(inactiveTarget.id, 'inactive').status, 'inactive');
  assert.strictEqual(setBenchmarkTargetStatus(changedTarget.id, 'active').status, 'active');

  assert.strictEqual(setBenchmarkDefinitionStatus(definition.id, 'inactive').status, 'inactive');
  assert.strictEqual(setBenchmarkDefinitionStatus(definition.id, 'active').status, 'active');

  const duplicateVersion = captureError(() => createBenchmarkDefinition(createDefinitionInput({
    effectiveStartUtc: '2027-01-01T00:00:00Z',
    effectiveEndUtc: '2028-01-01T00:00:00Z'
  })));
  assert.strictEqual(duplicateVersion.details.code, 'BENCHMARK_DEFINITION_UNIQUE_KEY_CONFLICT');

  const overlap = captureError(() => createBenchmarkDefinition(createDefinitionInput({
    version: 'lower-definition-overlap:v1',
    effectiveStartUtc: '2026-06-01T00:00:00Z',
    effectiveEndUtc: '2027-06-01T00:00:00Z'
  })));
  assert.strictEqual(overlap.details.code, 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP');

  const inactiveScope = captureError(() => createBenchmarkDefinition(createDefinitionInput({
    benchmarkCode: 'BENCH-INACTIVE-SCOPE',
    version: 'inactive-scope:v1',
    scopeReference: 'OU-INACTIVE'
  })));
  assert.strictEqual(inactiveScope.details.code, 'BENCHMARK_ORGANIZATION_SCOPE_INACTIVE');

  const db = openDatabase();
  try {
    const operationRows = db.prepare(`SELECT operation, user_id AS userId, detail_json AS detailJson
      FROM sys_operation_logs WHERE operation LIKE 'energy.benchmark.%' ORDER BY id`).all();
    const operations = new Set(operationRows.map((row) => row.operation));
    [
      'energy.benchmark.definition.create',
      'energy.benchmark.definition.update',
      'energy.benchmark.definition.status',
      'energy.benchmark.target.create',
      'energy.benchmark.target.version',
      'energy.benchmark.target.status'
    ].forEach((operation) => assert(operations.has(operation), `缺少审计操作 ${operation}`));
    operationRows.forEach((row) => {
      assert.strictEqual(row.userId, TEST_ACTOR.userId);
      const detail = JSON.parse(row.detailJson);
      assert(Object.prototype.hasOwnProperty.call(detail, 'before'));
      assert(Object.prototype.hasOwnProperty.call(detail, 'after'));
    });
  } finally {
    db.close();
  }

  return { definition, target: changedTarget };
}

/**
 * 创建指定方向的定义和目标。
 * @param {string} code 对标编码。
 * @param {string} direction 方向。
 * @param {object} targetValues 目标值。
 * @returns {{definition:object,target:object}} 定义和目标。
 */
function createDirectionBenchmark(code, direction, targetValues) {
  const versionBase = code.toLocaleLowerCase('en-US').replace(/[^a-z0-9-]/g, '-');
  const definition = createBenchmarkDefinition(createDefinitionInput({
    benchmarkCode: code,
    benchmarkName: `${code} 测试`,
    direction,
    version: `${versionBase}:v1`
  }));
  const target = createBenchmarkTarget(createTargetInput(definition.id, {
    ...targetValues,
    version: `${versionBase}-target:v1`
  }));
  return { definition, target };
}

/**
 * 验证 lower、higher、range、零目标和兼容性原因。
 * @param {object} base 基础 lower 定义和目标。
 */
function testEvaluationDirectionsAndCompatibility(base) {
  const lower = evaluateEnergyBenchmark({
    definitionId: base.definition.id,
    targetId: base.target.id,
    actual: createActual(120)
  });
  assert.strictEqual(lower.result.comparable, true);
  assert.strictEqual(lower.result.met, false);
  assert.strictEqual(lower.result.absoluteDifference, 30);
  assert.strictEqual(lower.result.differenceRatio, 0.333333333333);

  const higherBenchmark = createDirectionBenchmark('BENCH-HIGHER', 'higher_better', {
    targetValue: 80,
    lowerBound: null,
    upperBound: null
  });
  const higher = evaluateEnergyBenchmark({
    definitionId: higherBenchmark.definition.id,
    targetId: higherBenchmark.target.id,
    actual: createActual(90)
  });
  assert.strictEqual(higher.result.met, true);
  assert.strictEqual(higher.result.absoluteDifference, 10);
  assert.strictEqual(higher.result.differenceRatio, 0.125);

  const rangeBenchmark = createDirectionBenchmark('BENCH-RANGE', 'range', {
    targetValue: null,
    lowerBound: 5,
    upperBound: 10
  });
  const inRange = evaluateEnergyBenchmark({
    definitionId: rangeBenchmark.definition.id,
    targetId: rangeBenchmark.target.id,
    actual: createActual(7)
  });
  assert.strictEqual(inRange.result.met, true);
  assert.strictEqual(inRange.result.absoluteDifference, 0);
  assert.strictEqual(inRange.result.differenceRatio, null);
  assert.strictEqual(inRange.result.lowerBound, 5);
  assert.strictEqual(inRange.result.upperBound, 10);

  const aboveRange = evaluateEnergyBenchmark({
    definitionId: rangeBenchmark.definition.id,
    targetId: rangeBenchmark.target.id,
    actual: createActual(12)
  });
  assert.strictEqual(aboveRange.result.met, false);
  assert.strictEqual(aboveRange.result.targetValue, 10);
  assert.strictEqual(aboveRange.result.absoluteDifference, 2);
  assert.strictEqual(aboveRange.result.differenceRatio, 0.2);

  const zeroBenchmark = createDirectionBenchmark('BENCH-ZERO', 'lower_better', {
    targetValue: 0,
    lowerBound: null,
    upperBound: null
  });
  const zeroResult = evaluateEnergyBenchmark({
    definitionId: zeroBenchmark.definition.id,
    targetId: zeroBenchmark.target.id,
    actual: createActual(3)
  });
  assert.strictEqual(zeroResult.result.absoluteDifference, 3);
  assert.strictEqual(zeroResult.result.differenceRatio, null, '零目标不能产生无意义比例。');

  const incompatible = evaluateEnergyBenchmark({
    definitionId: base.definition.id,
    targetId: base.target.id,
    actual: createActual(null, {
      metricCode: 'wrong_metric',
      unit: 'wrong_unit',
      periodType: 'year',
      scopeType: 'product',
      benchmarkScopeReference: 'PU-BENCH',
      objectLevel: 'product',
      periodStartUtc: '2027-01-01T00:00:00Z',
      periodEndUtc: '2028-01-01T00:00:00Z'
    })
  });
  assert.strictEqual(incompatible.result.comparable, false);
  [
    ENERGY_BENCHMARK_REASON_CODES.actualValueMissing,
    ENERGY_BENCHMARK_REASON_CODES.metricMismatch,
    ENERGY_BENCHMARK_REASON_CODES.unitMismatch,
    ENERGY_BENCHMARK_REASON_CODES.periodTypeMismatch,
    ENERGY_BENCHMARK_REASON_CODES.scopeTypeMismatch,
    ENERGY_BENCHMARK_REASON_CODES.scopeReferenceMismatch,
    ENERGY_BENCHMARK_REASON_CODES.objectLevelMismatch,
    ENERGY_BENCHMARK_REASON_CODES.outsideEffectivePeriod
  ].forEach((reasonCode) => assert(incompatible.result.reasonCodes.includes(reasonCode), `缺少原因码 ${reasonCode}`));

  const energyDefinition = createBenchmarkDefinition(createDefinitionInput({
    benchmarkCode: 'BENCH-ENERGY',
    benchmarkName: '电力对标',
    metricCode: 'energy_usage',
    unit: 'kWh',
    scopeType: 'energy',
    scopeReference: 'electricity',
    version: 'energy-definition:v1'
  }));
  const energyTarget = createBenchmarkTarget(createTargetInput(energyDefinition.id, {
    targetValue: 500,
    version: 'energy-target:v1'
  }));
  const energyMismatch = evaluateEnergyBenchmark({
    definitionId: energyDefinition.id,
    targetId: energyTarget.id,
    actual: createActual(400, {
      metricCode: 'energy_usage',
      unit: 'kWh',
      scopeType: 'energy',
      scopeReference: 'electricity',
      benchmarkScopeReference: 'electricity',
      objectLevel: 'energy',
      energyTypeCode: 'natural_gas'
    })
  });
  assert(energyMismatch.result.reasonCodes.includes(ENERGY_BENCHMARK_REASON_CODES.energyTypeMismatch));
}

/**
 * 验证同层级排名、并列、排除、合格率和结构化导出。
 * @param {object} base 基础定义和目标。
 */
function testRankingQualificationAndExport(base) {
  const actuals = [
    createActual(80, { objectId: 'A', objectName: 'A车间' }),
    createActual(80, { objectId: 'B', objectName: 'B车间' }),
    createActual(90, { objectId: 'C', objectName: 'C车间' }),
    createActual(120, { objectId: 'D', objectName: 'D车间' }),
    createActual(70, { objectId: 'E', objectName: 'E车间', unit: 'kWh' })
  ];
  const ranking = rankEnergyBenchmark({ definitionId: base.definition.id, targetId: base.target.id, actuals });
  assert.deepStrictEqual(ranking.ranked.map((item) => [item.objectId, item.rank]), [
    ['A', 1], ['B', 1], ['C', 3], ['D', 4]
  ]);
  assert.strictEqual(ranking.excluded.length, 1);
  assert(ranking.excluded[0].reasonCodes.includes(ENERGY_BENCHMARK_REASON_CODES.unitMismatch));

  const qualification = calculateBenchmarkQualificationRate({
    definitionId: base.definition.id,
    targetId: base.target.id,
    actuals
  });
  assert.strictEqual(qualification.qualifiedCount, 3);
  assert.strictEqual(qualification.denominator, 4);
  assert.strictEqual(qualification.qualificationRate, 0.75);
  assert.strictEqual(qualification.excluded.length, 1);

  const noComparable = calculateBenchmarkQualificationRate({
    definitionId: base.definition.id,
    targetId: base.target.id,
    actuals: [createActual(80, { unit: 'wrong' })]
  });
  assert.strictEqual(noComparable.qualificationRate, null);
  assert.deepStrictEqual(noComparable.reasonCodes, ['BENCHMARK_NO_COMPARABLE_OBJECTS']);

  const exported = buildBenchmarkExportRows({ definitionId: base.definition.id, targetId: base.target.id, actuals });
  assert.strictEqual(exported.rows.length, 5);
  assert.strictEqual(exported.meta.generatedFromExplicitActuals, true);
  assert.strictEqual(exported.rows.filter((row) => row.excluded).length, 1);
}

/**
 * 构造只含定义、参考期和显式范围的内部历史输入。
 * @param {object} definitionOverrides 定义覆盖值。
 * @returns {object} 内部历史输入。
 */
function createInternalHistoryInput(definitionOverrides = {}) {
  return {
    definition: createDefinitionInput({
      benchmarkCode: 'BENCH-INTERNAL',
      benchmarkName: '内部历史能耗基准',
      benchmarkType: 'internal_history_baseline',
      unit: 'kWh/t',
      source: '企业历史数据固化计算',
      version: 'internal-definition:v1',
      ...definitionOverrides
    }),
    referencePeriod: {
      startUtc: '2025-01-01T00:00:00Z',
      endUtc: '2025-03-01T00:00:00Z'
    },
    calculationScope: {
      productionUnitId: 1,
      energyTypeCode: 'electricity'
    }
  };
}

/**
 * 验证内部历史事实由服务端计算、派生字段被拒绝及审计失败整体回滚。
 */
function testInternalHistorySnapshotAndRollback() {
  const input = createInternalHistoryInput();
  const internal = createInternalHistoryBenchmark(input, {
    now: () => new Date('2026-01-02T00:00:00.000Z')
  });
  assert.strictEqual(internal.target.isFrozen, true);
  assert.strictEqual(internal.target.autoRefresh, false);
  assert.strictEqual(internal.target.frozenValue, 7.333333333333);
  assert.strictEqual(internal.target.targetValue, 7.333333333333);
  assert.strictEqual(internal.target.sampleCount, 2);
  assert.strictEqual(internal.target.frozenAt, '2026-01-02T00:00:00.000Z');
  assert.match(internal.target.sourceDataDigest, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(internal.target.productionSummary.totalEnergy, 220);
  assert.strictEqual(internal.target.productionSummary.totalOutput, 30);
  assert.strictEqual(internal.target.productionSummary.energyRecordCount, 2);
  assert.strictEqual(internal.target.productionSummary.outputRecordCount, 2);
  assert.strictEqual(internal.target.version, input.definition.version, '目标版本必须由定义版本派生。');

  const immutableDefinition = captureError(() => updateBenchmarkDefinition(internal.definition.id, input.definition));
  assert.strictEqual(immutableDefinition.details.code, 'INTERNAL_HISTORY_BENCHMARK_IMMUTABLE');
  const immutableTarget = captureError(() => updateBenchmarkTarget(internal.target.id, {
    targetValue: 99,
    version: 'internal-target:v1',
    status: 'active'
  }));
  assert.strictEqual(immutableTarget.details.code, 'INTERNAL_HISTORY_BENCHMARK_TARGET_IMMUTABLE');

  ['frozenValue', 'sampleCount', 'productionSummary', 'sourceDataDigest', 'frozenAt'].forEach((fieldName) => {
    const forbidden = captureError(() => createInternalHistoryBenchmark({
      ...createInternalHistoryInput({
        benchmarkCode: `BENCH-FORBIDDEN-${fieldName.toUpperCase()}`,
        version: `forbidden-${fieldName.toLowerCase()}:v1`
      }),
      [fieldName]: fieldName === 'sampleCount' ? 2 : 'client-derived'
    }));
    assert.strictEqual(forbidden.details.code, 'INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN');
    assert(forbidden.details.fields.includes(fieldName));
  });
  const oldSnapshot = captureError(() => createInternalHistoryBenchmark({ ...input, snapshot: {} }));
  assert.strictEqual(oldSnapshot.details.code, 'INTERNAL_BASELINE_DERIVED_FIELDS_FORBIDDEN');

  const unsupportedMetric = captureError(() => createInternalHistoryBenchmark(createInternalHistoryInput({
    benchmarkCode: 'BENCH-INTERNAL-UNSUPPORTED',
    metricCode: 'energy_usage',
    unit: 'kWh',
    version: 'internal-unsupported:v1'
  })));
  assert.strictEqual(unsupportedMetric.details.code, 'INTERNAL_BASELINE_METRIC_UNSUPPORTED');

  const missingActor = captureError(() => createBenchmarkDefinitionService(createDefinitionInput({
    benchmarkCode: 'BENCH-NO-ACTOR',
    version: 'no-actor:v1'
  })));
  assert.strictEqual(missingActor.details.code, 'ENERGY_BENCHMARK_AUDIT_ACTOR_REQUIRED');

  const db = openDatabase();
  try {
    const aprilInput = createInternalHistoryInput({
      benchmarkCode: 'BENCH-INTERNAL-MISSING-ENERGY',
      version: 'internal-missing-energy:v1'
    });
    aprilInput.referencePeriod = {
      startUtc: '2025-04-01T00:00:00Z',
      endUtc: '2025-05-01T00:00:00Z'
    };
    const missingEnergy = captureError(() => createInternalHistoryBenchmark(aprilInput, { db }));
    assert.strictEqual(missingEnergy.details.code, 'INTERNAL_BASELINE_ENERGY_DATA_MISSING');

    const organization = db.prepare(`SELECT id FROM organization_units WHERE unit_code = 'OU-BENCH'`).get();
    const energyType = db.prepare(`SELECT id, standard_unit AS standardUnit FROM energy_types
      WHERE code = 'electricity'`).get();
    db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2025-04', '2025-04', ?, 50, ?, 50, 'benchmark-history-2025-04', 'active')`)
      .run(energyType.id, organization.id, energyType.standardUnit, energyType.standardUnit);
    const missingProductionInput = createInternalHistoryInput({
      benchmarkCode: 'BENCH-INTERNAL-MISSING-PRODUCTION',
      version: 'internal-missing-production:v1'
    });
    missingProductionInput.referencePeriod = aprilInput.referencePeriod;
    const missingProduction = captureError(() => createInternalHistoryBenchmark(missingProductionInput, { db }));
    assert.strictEqual(missingProduction.details.code, 'INTERNAL_BASELINE_PRODUCTION_DATA_MISSING');

    db.prepare(`INSERT INTO production_output_records
      (production_unit_id, normalized_month, output_value, output_unit, data_source, record_status)
      VALUES (1, '2025-05', 10, 't', 'manual', 'active')`).run();
    db.prepare(`INSERT INTO energy_records
      (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit,
       original_value, normalized_unit, normalized_value, duplicate_key, record_status)
      VALUES (?, ?, '2025-05', '2025-05', 'kgce', 50, 'kgce', 50,
       'benchmark-history-2025-05-invalid-unit', 'active')`).run(energyType.id, organization.id);
    const incompatibleUnitInput = createInternalHistoryInput({
      benchmarkCode: 'BENCH-INTERNAL-INCOMPATIBLE-FACT',
      version: 'internal-incompatible-fact:v1'
    });
    incompatibleUnitInput.referencePeriod = {
      startUtc: '2025-05-01T00:00:00Z',
      endUtc: '2025-06-01T00:00:00Z'
    };
    const incompatibleFact = captureError(() => createInternalHistoryBenchmark(incompatibleUnitInput, { db }));
    assert.strictEqual(incompatibleFact.details.code, 'INTERNAL_BASELINE_ENERGY_UNIT_INCOMPATIBLE');

    const auditRow = db.prepare(`SELECT user_id AS userId, operation, detail_json AS detailJson
      FROM sys_operation_logs WHERE operation = 'energy.benchmark.internal-history.create'
      ORDER BY id DESC LIMIT 1`).get();
    assert.strictEqual(auditRow.userId, TEST_ACTOR.userId);
    const auditDetail = JSON.parse(auditRow.detailJson);
    assert.strictEqual(auditDetail.before, null);
    assert.strictEqual(auditDetail.after.definition.id, internal.definition.id);
    assert.strictEqual(auditDetail.after.target.frozenValue, 7.333333333333);

    const beforeDefinitions = Number(db.prepare('SELECT COUNT(*) AS count FROM benchmark_definitions').get().count);
    const beforeTargets = Number(db.prepare('SELECT COUNT(*) AS count FROM benchmark_targets').get().count);
    const beforeAudits = Number(db.prepare('SELECT COUNT(*) AS count FROM sys_operation_logs').get().count);
    assert.throws(() => createInternalHistoryBenchmark(createInternalHistoryInput({
      benchmarkCode: 'BENCH-INTERNAL-ROLLBACK',
      version: 'internal-rollback:v1'
    }), {
      db,
      afterAuditInsert: () => {
        throw new Error('TEST_AUDIT_FAILED');
      }
    }), /TEST_AUDIT_FAILED/);
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS count FROM benchmark_definitions').get().count), beforeDefinitions);
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS count FROM benchmark_targets').get().count), beforeTargets);
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS count FROM sys_operation_logs').get().count), beforeAudits);
  } finally {
    db.close();
  }
}

/**
 * 执行全部能效对标 service 测试。
 */
function run() {
  try {
    initDatabase();
    seedMasterData();
    const base = testCrudAndStatus();
    testEvaluationDirectionsAndCompatibility(base);
    testRankingQualificationAndExport(base);
    testInternalHistorySnapshotAndRollback();

    const db = openDatabase();
    try {
      assert.deepStrictEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
    console.log('energyBenchmarkService tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run();
