'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 平衡服务测试仅使用系统临时目录和隔离 SQLite，不访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-balance-service-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-balance-service.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const {
  calculateAndSaveBalanceSnapshots: calculateAndSaveBalanceSnapshotsService,
  createBalanceBoundary: createBalanceBoundaryService,
  createBalanceItem: createBalanceItemService,
  getBalanceBoundary,
  getBalanceSnapshot,
  getBalanceSnapshotRun,
  getEnergyBalanceContract,
  listBalanceBoundaries,
  listBalanceItems,
  listBalanceSnapshotRuns,
  listBalanceSnapshots,
  listBalanceSuggestions,
  setBalanceBoundaryStatus: setBalanceBoundaryStatusService,
  setBalanceItemStatus: setBalanceItemStatusService,
  updateBalanceBoundary: updateBalanceBoundaryService,
  updateBalanceItem: updateBalanceItemService,
  updateBalanceSuggestionStatus: updateBalanceSuggestionStatusService
} = require('../services/energyBalanceService');

// 测试统计窗口采用严格 UTC 左闭右开区间。
const START_UTC = '2026-07-01T00:00:00.000Z';
// 测试统计窗口结束时间。
const END_UTC = '2026-08-01T00:00:00.000Z';
// 测试边界有效期开始时间。
const EFFECTIVE_START_UTC = '2026-01-01T00:00:00.000Z';
// 测试边界有效期结束时间。
const EFFECTIVE_END_UTC = '2027-01-01T00:00:00.000Z';
// 测试来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 月度来源窗口按上海自然月边界换算为 UTC。
const MONTH_START_UTC = '2026-06-30T16:00:00.000Z';
// 月度来源窗口结束于下一自然月首零点。
const MONTH_END_UTC = '2026-07-31T16:00:00.000Z';
// 所有服务写操作使用隔离库内置管理员作为认证操作者。
const TEST_ACTOR = Object.freeze({ userId: 1, username: 'admin', ip: '127.0.0.1' });

/**
 * 合并测试数据库依赖和统一认证操作者。
 * @param {object} options 原始服务选项。
 * @returns {object} 已注入操作者的服务选项。
 */
function auditedOptions(options = {}) {
  return { ...options, actor: TEST_ACTOR };
}

/** 平衡边界创建测试包装。 */
function createBalanceBoundary(input, options) {
  return createBalanceBoundaryService(input, auditedOptions(options));
}

/** 平衡边界更新测试包装。 */
function updateBalanceBoundary(boundaryId, input, options) {
  return updateBalanceBoundaryService(boundaryId, input, auditedOptions(options));
}

/** 平衡边界状态测试包装。 */
function setBalanceBoundaryStatus(boundaryId, input, options) {
  return setBalanceBoundaryStatusService(boundaryId, input, auditedOptions(options));
}

/** 平衡项目创建测试包装。 */
function createBalanceItem(boundaryId, input, options) {
  return createBalanceItemService(boundaryId, input, auditedOptions(options));
}

/** 平衡项目更新测试包装。 */
function updateBalanceItem(boundaryId, itemId, input, options) {
  return updateBalanceItemService(boundaryId, itemId, input, auditedOptions(options));
}

/** 平衡项目状态测试包装。 */
function setBalanceItemStatus(boundaryId, itemId, input, options) {
  return setBalanceItemStatusService(boundaryId, itemId, input, auditedOptions(options));
}

/** 平衡快照计算测试包装。 */
function calculateAndSaveBalanceSnapshots(boundaryId, input, options) {
  return calculateAndSaveBalanceSnapshotsService(boundaryId, input, auditedOptions(options));
}

/** 平衡建议复核测试包装。 */
function updateBalanceSuggestionStatus(suggestionId, input, options) {
  return updateBalanceSuggestionStatusService(suggestionId, input, auditedOptions(options));
}

/**
 * 向隔离数据库插入组织单元并返回 ID。
 * @param {object} db SQLite 连接。
 * @param {string} code 组织编码。
 * @returns {number} 组织 ID。
 */
function insertOrganization(db, code) {
  const result = db.prepare(
    `INSERT INTO organization_units (
       unit_code, unit_name, unit_path, unit_type, status
     ) VALUES (?, ?, ?, 'enterprise', 'active')`
  ).run(code, `${code}组织`, `/${code}`);
  return Number(result.lastInsertRowid);
}

/**
 * 查询启用能源类型。
 * @param {object} db SQLite 连接。
 * @param {string} code 能源类型编码。
 * @returns {object} 能源类型。
 */
function getEnergyType(db, code) {
  const row = db.prepare(
    `SELECT id, code, default_unit AS defaultUnit, standard_unit AS standardUnit
     FROM energy_types WHERE code = ? AND is_active = 1`
  ).get(code);
  assert(row, `测试需要能源类型 ${code}`);
  return row;
}

/**
 * 插入有效折标系数。
 * @param {object} db SQLite 连接。
 * @param {object} energyType 能源类型。
 * @param {string} unit 来源单位。
 * @param {string} factorCode 系数编码。
 * @param {string} version 系数版本。
 * @param {number} factorValue 系数值。
 * @returns {number} 系数 ID。
 */
function insertFactor(db, energyType, unit, factorCode, version, factorValue) {
  const result = db.prepare(
    `INSERT INTO energy_conversion_factors (
       factor_code, energy_type_id, source_unit, factor_value, target_unit,
       display_unit, display_divisor, source, document_no, version,
       effective_start_utc, effective_end_utc, source_timezone, status
     ) VALUES (?, ?, ?, ?, 'kgce', 'tce', 1000, 'test', 'TEST-DOC', ?, ?, ?, ?, 'active')`
  ).run(
    factorCode,
    energyType.id,
    unit,
    factorValue,
    version,
    EFFECTIVE_START_UTC,
    EFFECTIVE_END_UTC,
    SOURCE_TIME_ZONE
  );
  return Number(result.lastInsertRowid);
}

/**
 * 创建标准测试边界。
 * @param {number} organizationUnitId 组织 ID。
 * @param {string} suffix 编码后缀。
 * @param {boolean} generationBoundaryConfirmed 是否确认发电边界。
 * @returns {object} 边界。
 */
function createTestBoundary(organizationUnitId, suffix, generationBoundaryConfirmed = false) {
  return createBalanceBoundary({
    boundaryCode: `BAL-${suffix}`,
    boundaryName: `测试边界-${suffix}`,
    organizationUnitId,
    source: '测试定义',
    documentNo: `DOC-${suffix}`,
    version: 'v1',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    generationBoundaryConfirmed
  });
}

/**
 * 创建显式值平衡项目。
 * @param {number} boundaryId 边界 ID。
 * @param {object} energyType 能源类型。
 * @param {string} role 九角色。
 * @param {number} value 显式值。
 * @param {string} suffix 唯一后缀。
 * @returns {object} 平衡项目。
 */
function createExplicitItem(boundaryId, energyType, role, value, suffix) {
  return createBalanceItem(boundaryId, {
    itemCode: `ITEM-${suffix}-${role}`,
    itemName: `${role}项目`,
    role,
    energyTypeId: energyType.id,
    originalUnit: energyType.standardUnit,
    sourceType: 'explicit_balance_value',
    sourceMapping: {
      reference: `explicit:${suffix}:${role}`,
      value
    }
  });
}

/**
 * 断言服务错误详情包含指定业务详情码。
 * @param {Function} operation 待执行操作。
 * @param {string} detailsCode 详情码。
 */
function assertThrowsDetailsCode(operation, detailsCode) {
  assert.throws(operation, (error) => (
    error
    && error.code === 'BAD_REQUEST'
    && error.details
    && error.details.code === detailsCode
  ));
}

/**
 * 直接插入 run summary 分页夹具，避免分页测试依赖计算分面数量。
 * @param {object} db SQLite 连接。
 * @param {object} boundary 平衡边界。
 * @param {number} energyTypeId 能源类型 ID。
 * @param {string} runId 运行编号。
 * @param {number} facetCount 分面数量。
 * @param {number} orderIndex 排序序号。
 * @param {boolean} freezeLastFacet 是否冻结最后一个分面。
 */
function insertSnapshotRunFixture(
  db,
  boundary,
  energyTypeId,
  runId,
  facetCount,
  orderIndex,
  freezeLastFacet = false
) {
  const createdAt = new Date(Date.UTC(2026, 7, 1, 0, 0, orderIndex)).toISOString();
  const digest = `digest-${runId}`.padEnd(64, '0').slice(0, 64);
  db.prepare(`INSERT INTO energy_balance_calculation_runs (
    calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
    source_timezone, source_data_digest, formula_version,
    conversion_formula_version, created_by_user_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runId,
    boundary.id,
    START_UTC,
    END_UTC,
    SOURCE_TIME_ZONE,
    digest,
    'energy-balance:v1',
    'energy-conversion:v1',
    TEST_ACTOR.userId,
    createdAt
  );
  const insertSnapshot = db.prepare(`INSERT INTO energy_balance_snapshots (
    calculation_run_id, energy_balance_boundary_id, energy_type_id, start_utc, end_utc,
    source_timezone, original_unit, input_total_original, output_total_original,
    unexplained_original, formula_version, completeness_rate, confirmation_status,
    reason_codes_json, source_data_digest, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?)`);
  for (let facetIndex = 0; facetIndex < facetCount; facetIndex += 1) {
    const frozen = freezeLastFacet && facetIndex === facetCount - 1;
    insertSnapshot.run(
      runId,
      boundary.id,
      energyTypeId,
      START_UTC,
      END_UTC,
      SOURCE_TIME_ZONE,
      `fixture-unit-${facetIndex}`,
      1,
      1,
      0,
      'energy-balance:v1',
      frozen ? 0.5 : 1,
      frozen ? JSON.stringify(['COVERAGE_BELOW_THRESHOLD']) : null,
      digest,
      createdAt,
      createdAt
    );
  }
}

/**
 * 运行平衡服务专项测试。
 */
function run() {
  initDatabase();
  const db = openDatabase();
  let organizationId;
  let electricity;
  let naturalGas;
  let heat;
  try {
    organizationId = insertOrganization(db, 'BALANCE-ORG');
    electricity = getEnergyType(db, 'electricity');
    naturalGas = getEnergyType(db, 'natural_gas');
    heat = getEnergyType(db, 'heat');
    insertFactor(
      db,
      electricity,
      electricity.standardUnit,
      'BAL-ELECTRICITY',
      'electricity:v1',
      0.1229
    );
  } finally {
    db.close();
  }

  // 稳定契约必须冻结九角色、来源和自动化边界。
  const contract = getEnergyBalanceContract();
  assert.strictEqual(contract.roles.length, 9);
  assert(contract.roles.includes('inventory_increase'));
  assert.strictEqual(contract.generation.explicitMappingRequired, true);
  assert.strictEqual(contract.suggestions.usesAI, false);
  assert.strictEqual(contract.suggestions.automaticExecution, false);

  // 边界 CRUD、分页、修改和启停。
  const boundary = createTestBoundary(organizationId, 'CRUD', false);
  assert.strictEqual(boundary.status, 'active');
  assert.strictEqual(getBalanceBoundary(boundary.id).roles.length, 9);
  assert.strictEqual(listBalanceBoundaries({ page: 1, pageSize: 10 }).pagination.total, 1);
  const updatedBoundary = updateBalanceBoundary(boundary.id, { boundaryName: '已更新平衡边界' });
  assert.strictEqual(updatedBoundary.boundaryName, '已更新平衡边界');
  assert.strictEqual(setBalanceBoundaryStatus(boundary.id, { status: 'inactive' }).status, 'inactive');
  assert.strictEqual(setBalanceBoundaryStatus(boundary.id, { status: 'active' }).status, 'active');

  // 九角色项目 CRUD、单位校验、项目归属和启停。
  const roleValues = {
    input: 100,
    self_generation: 20,
    inventory_decrease: 5,
    adjustment_increase: 0,
    output: 10,
    useful_utilization: 80,
    known_loss: 5,
    inventory_increase: 10,
    adjustment_decrease: 2
  };
  const items = Object.entries(roleValues).map(([role, value]) => (
    createExplicitItem(boundary.id, electricity, role, value, 'CRUD')
  ));
  assert.strictEqual(listBalanceItems(boundary.id, { pageSize: 20 }).pagination.total, 9);
  const updatedItem = updateBalanceItem(boundary.id, items[0].id, { itemName: '更新后的输入项目' });
  assert.strictEqual(updatedItem.itemName, '更新后的输入项目');
  assert.strictEqual(
    setBalanceItemStatus(boundary.id, items[0].id, { status: 'inactive' }).status,
    'inactive'
  );
  assert.strictEqual(setBalanceItemStatus(boundary.id, items[0].id, { status: 'active' }).status, 'active');
  assertThrowsDetailsCode(() => createBalanceItem(boundary.id, {
    itemCode: 'BAD-UNIT',
    itemName: '错误单位',
    role: 'input',
    energyTypeId: electricity.id,
    originalUnit: 'm3',
    sourceType: 'explicit_balance_value',
    sourceMapping: { reference: 'bad:unit', value: 1 }
  }), 'BALANCE_ENERGY_UNIT_NOT_COMPARABLE');
  assert.throws(() => updateBalanceItem(boundary.id + 999, items[0].id, { itemName: '越界修改' }), {
    code: 'NOT_FOUND'
  });

  // 原单位分面、折标综合、储能变化、差额和确定性建议在同一事务中落库。
  const calculation = calculateAndSaveBalanceSnapshots(boundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  });
  assert.strictEqual(calculation.originalFacets.length, 1);
  const facet = calculation.originalFacets[0];
  assert.strictEqual(facet.inputTotalOriginal, 125);
  assert.strictEqual(facet.outputTotalOriginal, 107);
  assert.strictEqual(facet.storageChangeOriginal, 5);
  assert.strictEqual(facet.unexplainedOriginal, 18);
  assert.strictEqual(facet.calculationStatus, 'available');
  assert.strictEqual(calculation.comprehensive.calculationStatus, 'available');
  assert.strictEqual(calculation.comprehensive.inputTotalKgce, 15.3625);
  assert.strictEqual(calculation.comprehensive.outputTotalKgce, 13.1503);
  assert.strictEqual(calculation.comprehensive.unexplainedKgce, 2.2122);
  assert(calculation.suggestions.some((item) => item.ruleCode === 'BALANCE_IMBALANCE_RATE_REVIEW'));
  assert(calculation.suggestions.some((item) => item.ruleCode === 'BALANCE_KNOWN_LOSS_RATE_REVIEW'));
  assert(calculation.suggestions.every((item) => item.estimatedSaving === null));
  assert(calculation.suggestions.every((item) => item.automationBoundary.issuesControlCommand === false));

  // 快照查询可按摘要重建综合结果，并固化来源和系数版本。
  const snapshot = getBalanceSnapshot(facet.snapshotId);
  assert.strictEqual(snapshot.items.length, 9);
  assert.strictEqual(snapshot.calculationGroup.facets.length, 1);
  assert.strictEqual(snapshot.storageChangeOriginal, 5);
  assert.strictEqual(snapshot.storageChangeKgce, 0.6145);
  assert.strictEqual(snapshot.imbalanceRate, 0.144);
  assert.strictEqual(snapshot.calculationGroup.comprehensive.inputTotalKgce, 15.3625);
  assert.strictEqual(snapshot.calculationGroup.comprehensive.completenessRate, 1);
  assert(snapshot.items.every((item) => item.sourceMapping._snapshot.formulaVersion === 'energy-balance:v1'));
  assert(snapshot.items.every((item) => item.actualFactorVersion === 'electricity:v1'));
  assert.strictEqual(
    listBalanceSnapshots({ sourceDataDigest: calculation.sourceDataDigest }).pagination.total,
    1
  );

  // 相同内容重复计算必须生成不同运行 ID，详情和建议只能聚合当前运行。
  const repeatedCalculation = calculateAndSaveBalanceSnapshots(boundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  });
  assert.strictEqual(repeatedCalculation.sourceDataDigest, calculation.sourceDataDigest);
  assert.notStrictEqual(repeatedCalculation.calculationRunId, calculation.calculationRunId);
  assert.strictEqual(
    listBalanceSnapshots({ sourceDataDigest: calculation.sourceDataDigest }).pagination.total,
    2
  );
  assert.strictEqual(
    listBalanceSnapshots({ calculationRunId: calculation.calculationRunId }).pagination.total,
    1
  );
  const isolatedSnapshot = getBalanceSnapshot(facet.snapshotId);
  assert.strictEqual(isolatedSnapshot.calculationGroup.calculationRunId, calculation.calculationRunId);
  assert.strictEqual(isolatedSnapshot.calculationGroup.facets.length, 1);
  assert(isolatedSnapshot.items.every((item) => item.calculationRunId === calculation.calculationRunId));
  assert(isolatedSnapshot.suggestions.every((item) => item.calculationRunId === calculation.calculationRunId));

  // 历史快照项目标识在计算时冻结，后续主项目改名或改码不得污染历史详情。
  const frozenIdentityItem = isolatedSnapshot.items.find((item) => item.balanceItemId === items[0].id);
  assert(frozenIdentityItem);
  updateBalanceItem(boundary.id, items[0].id, {
    itemCode: 'ITEM-CRUD-input-RENAMED',
    itemName: '计算后修改的主项目名称'
  });
  const historicalSnapshot = getBalanceSnapshot(facet.snapshotId);
  const historicalItem = historicalSnapshot.items.find((item) => item.balanceItemId === items[0].id);
  assert.strictEqual(historicalItem.itemCode, frozenIdentityItem.itemCode);
  assert.strictEqual(historicalItem.itemName, frozenIdentityItem.itemName);
  const immutableIdentityDb = openDatabase();
  try {
    assert.throws(
      () => immutableIdentityDb.prepare(
        'UPDATE energy_balance_snapshot_items SET item_name = ? WHERE id = ?'
      ).run('不得改写的历史名称', frozenIdentityItem.id),
      /energy balance snapshot item identity immutable/
    );
  } finally {
    immutableIdentityDb.close();
  }

  // run 级分页总数不得按分面计数，大运行列表只返回轻量摘要且质量聚合必须完整。
  const runPagingBoundary = createTestBoundary(organizationId, 'RUN-PAGING', false);
  // 多分面运行中人工设置的最晚快照创建时间，用于校验列表与详情汇总一致。
  const oversizedLatestCreatedAt = '2026-08-01T00:10:00.000Z';
  const runPagingDb = openDatabase();
  try {
    for (let runIndex = 1; runIndex <= 23; runIndex += 1) {
      insertSnapshotRunFixture(
        runPagingDb,
        runPagingBoundary,
        electricity.id,
        `run-page-${String(runIndex).padStart(2, '0')}`,
        1,
        runIndex
      );
    }
    insertSnapshotRunFixture(
      runPagingDb,
      runPagingBoundary,
      electricity.id,
      'run-over-100-facets',
      101,
      30,
      true
    );
    runPagingDb.prepare(
      `UPDATE energy_balance_snapshots
       SET created_at = ?, updated_at = ?
       WHERE calculation_run_id = ?
         AND id = (SELECT MAX(id) FROM energy_balance_snapshots WHERE calculation_run_id = ?)`
    ).run(
      oversizedLatestCreatedAt,
      oversizedLatestCreatedAt,
      'run-over-100-facets',
      'run-over-100-facets'
    );
    for (let largeRunIndex = 1; largeRunIndex <= 10; largeRunIndex += 1) {
      const largeRunId = `run-large-${String(largeRunIndex).padStart(2, '0')}`;
      insertSnapshotRunFixture(
        runPagingDb,
        runPagingBoundary,
        electricity.id,
        largeRunId,
        150,
        30 + largeRunIndex,
        true
      );
      runPagingDb.prepare(
        `UPDATE energy_balance_snapshots
         SET confirmation_status = 'accepted',
             reason_codes_json = ?
         WHERE calculation_run_id = ?
           AND id = (SELECT MIN(id) FROM energy_balance_snapshots WHERE calculation_run_id = ?)`
      ).run(
        JSON.stringify(['NO_TIMESERIES_DATA', 'COVERAGE_BELOW_THRESHOLD']),
        largeRunId,
        largeRunId
      );
      runPagingDb.prepare(
        `UPDATE energy_balance_snapshots
         SET confirmation_status = 'resolved'
         WHERE calculation_run_id = ?
           AND id = (SELECT MAX(id) FROM energy_balance_snapshots WHERE calculation_run_id = ?)`
      ).run(largeRunId, largeRunId);
    }
  } finally {
    runPagingDb.close();
  }
  const firstRunPage = listBalanceSnapshotRuns({
    boundaryId: runPagingBoundary.id,
    page: 1,
    pageSize: 10
  });
  const secondRunPage = listBalanceSnapshotRuns({
    boundaryId: runPagingBoundary.id,
    page: 2,
    pageSize: 10
  });
  assert.strictEqual(firstRunPage.pagination.total, 34);
  assert.strictEqual(firstRunPage.pagination.totalPages, 4);
  assert.strictEqual(firstRunPage.rows.length, 10);
  assert.strictEqual(secondRunPage.rows.length, 10);
  assert(firstRunPage.rows.every((row) => Number.isInteger(row.representativeSnapshotId)));
  assert(firstRunPage.rows.every((row) => !Object.prototype.hasOwnProperty.call(row, 'snapshots')));
  assert.strictEqual(new Set([
    ...firstRunPage.rows.map((row) => row.calculationRunId),
    ...secondRunPage.rows.map((row) => row.calculationRunId)
  ]).size, 20, '跨页运行不得重复或按分面拆开。');
  assert.strictEqual(
    firstRunPage.rows.filter((row) => row.calculationRunId.startsWith('run-large-')).length,
    10
  );
  firstRunPage.rows.forEach((row) => {
    assert.strictEqual(row.facetCount, 150);
    assert.strictEqual(row.calculationStatus, 'frozen');
    assert.deepStrictEqual(
      row.reasonCodes,
      ['NO_TIMESERIES_DATA', 'COVERAGE_BELOW_THRESHOLD']
    );
    assert.deepStrictEqual(row.confirmationStatuses, ['accepted', 'unconfirmed', 'resolved']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'snapshots'), false);
  });
  const oversizedRunSummary = [...firstRunPage.rows, ...secondRunPage.rows].find(
    (row) => row.calculationRunId === 'run-over-100-facets'
  );
  assert(oversizedRunSummary);
  assert.strictEqual(oversizedRunSummary.facetCount, 101);
  assert.strictEqual(oversizedRunSummary.calculationStatus, 'frozen');
  assert(oversizedRunSummary.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'));
  assert.strictEqual(oversizedRunSummary.latestCreatedAt, oversizedLatestCreatedAt);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(oversizedRunSummary, 'snapshots'), false);
  assert(Buffer.byteLength(JSON.stringify(oversizedRunSummary)) < 5000);
  const oversizedRun = getBalanceSnapshotRun('run-over-100-facets');
  assert.strictEqual(oversizedRun.facetCount, 101);
  assert.strictEqual(oversizedRun.snapshots.length, 101);
  assert.strictEqual(oversizedRun.calculationStatus, 'frozen');
  assert(oversizedRun.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'));
  assert.strictEqual(oversizedRun.latestCreatedAt, oversizedLatestCreatedAt);
  assert.strictEqual(oversizedRun.latestCreatedAt, oversizedRunSummary.latestCreatedAt);
  assert.strictEqual(
    listBalanceSnapshots({ boundaryId: runPagingBoundary.id, page: 1, pageSize: 100 }).pagination.total,
    1624,
    '旧分面分页调用必须保持兼容。'
  );
  const balanceServiceSource = fs.readFileSync(
    path.join(__dirname, '../services/energyBalanceService.js'),
    'utf8'
  );
  assert.match(balanceServiceSource, /COUNT\(\*\) AS facetCount/);
  assert.match(balanceServiceSource, /COUNT\(DISTINCT CASE/);
  assert.match(balanceServiceSource, /JOIN json_each\(/);
  assert.match(balanceServiceSource, /ROW_NUMBER\(\) OVER \(/);
  assert.match(balanceServiceSource, /WHERE reasonRank = 1/);
  assert.doesNotMatch(balanceServiceSource, /function listSnapshotRunFacetQualityRows\(/);

  // 建议状态只能按人工状态机接受、拒绝和解决，终态不可回退。
  const suggestionList = listBalanceSuggestions({
    calculationRunId: calculation.calculationRunId,
    pageSize: 20
  });
  assert(suggestionList.pagination.total >= 2);
  const suggestionId = suggestionList.rows[0].id;
  const accepted = updateBalanceSuggestionStatus(suggestionId, {
    manualStatus: 'accepted',
    reviewNote: '已安排人工核查'
  });
  assert.strictEqual(accepted.manualStatus, 'accepted');
  const resolved = updateBalanceSuggestionStatus(suggestionId, {
    manualStatus: 'resolved',
    reviewNote: '已完成人工核查并留存证据'
  });
  assert.strictEqual(resolved.manualStatus, 'resolved');
  assert.throws(() => updateBalanceSuggestionStatus(suggestionId, {
    manualStatus: 'accepted'
  }), { code: 'BALANCE_SUGGESTION_STATUS_CONFLICT' });

  // 时序来源可按相邻 UTC 有效期精确分段，并在快照中固化多版本应用明细。
  const segmentedDb = openDatabase();
  let firstTimeseriesId;
  let secondTimeseriesId;
  try {
    segmentedDb.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, target_unit,
         display_unit, display_divisor, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('BAL-HEAT-A', ?, ?, 2, 'kgce', 'tce', 1000,
                 'test', 'TEST-DOC', 'heat-a:v1', ?, '2026-07-15T01:00:00.000Z', ?, 'active')`
    ).run(heat.id, heat.standardUnit, EFFECTIVE_START_UTC, SOURCE_TIME_ZONE);
    segmentedDb.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, target_unit,
         display_unit, display_divisor, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('BAL-HEAT-B', ?, ?, 3, 'kgce', 'tce', 1000,
                 'test', 'TEST-DOC', 'heat-b:v1', '2026-07-15T01:00:00.000Z', ?, ?, 'active')`
    ).run(heat.id, heat.standardUnit, EFFECTIVE_END_UTC, SOURCE_TIME_ZONE);
    const insertTimeseries = segmentedDb.prepare(
      `INSERT INTO energy_timeseries_records (
         organization_unit_id, energy_type_id, start_utc, end_utc, source_timezone,
         granularity_minutes, original_unit, original_value, normalized_unit,
         normalized_value, source_reference, data_source, record_status
       ) VALUES (?, ?, ?, ?, ?, 60, ?, 10, ?, 10, ?, 'manual', 'active')`
    );
    firstTimeseriesId = Number(insertTimeseries.run(
      organizationId,
      heat.id,
      '2026-07-15T00:00:00.000Z',
      '2026-07-15T01:00:00.000Z',
      SOURCE_TIME_ZONE,
      heat.standardUnit,
      heat.standardUnit,
      'balance:heat:segment-a'
    ).lastInsertRowid);
    secondTimeseriesId = Number(insertTimeseries.run(
      organizationId,
      heat.id,
      '2026-07-15T01:00:00.000Z',
      '2026-07-15T02:00:00.000Z',
      SOURCE_TIME_ZONE,
      heat.standardUnit,
      heat.standardUnit,
      'balance:heat:segment-b'
    ).lastInsertRowid);
  } finally {
    segmentedDb.close();
  }
  const segmentedBoundary = createTestBoundary(organizationId, 'SEGMENTED', false);
  createBalanceItem(segmentedBoundary.id, {
    itemCode: 'HEAT-TIMESERIES-INPUT',
    itemName: '热力时序输入',
    role: 'input',
    energyTypeId: heat.id,
    originalUnit: heat.standardUnit,
    sourceType: 'timeseries',
    sourceMapping: {
      reference: 'timeseries:heat:segmented',
      recordIds: [firstTimeseriesId, secondTimeseriesId]
    }
  });
  const segmentedCalculation = calculateAndSaveBalanceSnapshots(segmentedBoundary.id, {
    startUtc: '2026-07-15T00:00:00.000Z',
    endUtc: '2026-07-15T02:00:00.000Z'
  });
  assert.strictEqual(segmentedCalculation.comprehensive.calculationStatus, 'available');
  assert.strictEqual(segmentedCalculation.comprehensive.inputTotalKgce, 50);
  const segmentedSnapshot = getBalanceSnapshot(segmentedCalculation.originalFacets[0].snapshotId);
  assert.deepStrictEqual(
    JSON.parse(segmentedSnapshot.items[0].actualFactorVersion),
    ['heat-a:v1', 'heat-b:v1']
  );
  assert.strictEqual(segmentedSnapshot.items[0].conversionFactorId, null);
  assert.strictEqual(segmentedSnapshot.items[0].actualFactorValue, 2.5);
  assert.strictEqual(segmentedSnapshot.items[0].sourceMapping._snapshot.factorApplications.length, 2);
  assert.deepStrictEqual(segmentedSnapshot.actualFactorVersions, {
    'BAL-HEAT-A@2026-01-01T00:00:00.000Z': 'heat-a:v1',
    'BAL-HEAT-B@2026-07-15T01:00:00.000Z': 'heat-b:v1'
  });

  // 缺失折标系数时保留原单位事实并冻结综合 kgce/tce。
  const missingFactorBoundary = createTestBoundary(organizationId, 'MISSING-FACTOR', false);
  createExplicitItem(missingFactorBoundary.id, naturalGas, 'input', 10, 'MISSING-FACTOR');
  const missingFactorCalculation = calculateAndSaveBalanceSnapshots(missingFactorBoundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  });
  assert.strictEqual(missingFactorCalculation.originalFacets[0].inputTotalOriginal, 10);
  assert.strictEqual(missingFactorCalculation.comprehensive.calculationStatus, 'frozen');
  assert(missingFactorCalculation.comprehensive.reasonCodes.includes('MISSING_CONVERSION_FACTOR'));
  assert.strictEqual(missingFactorCalculation.comprehensive.inputTotalKgce, null);

  // 同一统计期存在多个有效系数时必须判定歧义，禁止任选或平均。
  const ambiguousDb = openDatabase();
  try {
    insertFactor(
      ambiguousDb,
      naturalGas,
      naturalGas.standardUnit,
      'BAL-GAS-A',
      'gas-a:v1',
      1.1
    );
    insertFactor(
      ambiguousDb,
      naturalGas,
      naturalGas.standardUnit,
      'BAL-GAS-B',
      'gas-b:v1',
      1.2
    );
  } finally {
    ambiguousDb.close();
  }
  const ambiguousBoundary = createTestBoundary(organizationId, 'AMBIGUOUS', false);
  createExplicitItem(ambiguousBoundary.id, naturalGas, 'input', 10, 'AMBIGUOUS');
  const ambiguousCalculation = calculateAndSaveBalanceSnapshots(ambiguousBoundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  });
  assert(ambiguousCalculation.comprehensive.reasonCodes.includes('FACTOR_PERIOD_AMBIGUOUS'));
  assert.strictEqual(ambiguousCalculation.comprehensive.inputTotalKgce, null);

  // 月度能耗来源必须按来源时区完整自然月对齐，非整月不得计入整月值。
  const monthlyDb = openDatabase();
  let monthlyRecordId;
  try {
    monthlyRecordId = Number(monthlyDb.prepare(`INSERT INTO energy_records (
      energy_type_id, organization_unit_id, original_month, normalized_month,
      original_unit, original_value, normalized_unit, normalized_value,
      duplicate_key, record_status
    ) VALUES (?, ?, '2026-07', '2026-07', ?, 100, ?, 100, 'balance-monthly-full-window', 'active')`)
      .run(electricity.id, organizationId, electricity.standardUnit, electricity.standardUnit).lastInsertRowid);
  } finally {
    monthlyDb.close();
  }
  const monthlyBoundary = createTestBoundary(organizationId, 'MONTHLY-WINDOW', false);
  createBalanceItem(monthlyBoundary.id, {
    itemCode: 'MONTHLY-INPUT',
    itemName: '月度能耗输入',
    role: 'input',
    energyTypeId: electricity.id,
    originalUnit: electricity.standardUnit,
    sourceType: 'monthly_energy',
    sourceMapping: {
      reference: 'monthly:2026-07',
      recordIds: [monthlyRecordId]
    }
  });
  assertThrowsDetailsCode(() => calculateAndSaveBalanceSnapshots(monthlyBoundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  }), 'BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH');
  const monthlyCalculation = calculateAndSaveBalanceSnapshots(monthlyBoundary.id, {
    startUtc: MONTH_START_UTC,
    endUtc: MONTH_END_UTC
  });
  assert.strictEqual(monthlyCalculation.originalFacets[0].inputTotalOriginal, 100);

  // 发电记录仅在显式项目、允许角色、确认边界和防重复键约束下参与。
  const generationDb = openDatabase();
  let generationRecordId;
  try {
    const generationResult = generationDb.prepare(
      `INSERT INTO generation_records (
         organization_unit_id, energy_type_id, normalized_month,
         generation_value_kwh, self_use_value_kwh, grid_export_value_kwh,
         data_source, record_status
       ) VALUES (?, ?, '2026-07', 100, 60, 40, 'manual', 'active')`
    ).run(organizationId, electricity.id);
    generationRecordId = Number(generationResult.lastInsertRowid);
  } finally {
    generationDb.close();
  }
  const generationBoundary = createTestBoundary(organizationId, 'GENERATION', true);
  const generationItem = createBalanceItem(generationBoundary.id, {
    itemCode: 'GEN-SELF-USE',
    itemName: '发电自用',
    role: 'self_generation',
    energyTypeId: electricity.id,
    originalUnit: electricity.standardUnit,
    sourceType: 'generation',
    sourceMapping: {
      reference: 'generation:self-use:2026-07',
      recordIds: [generationRecordId],
      valueField: 'self_use_value_kwh'
    },
    generationAntiDoubleCountKey: 'generation-record-1-self-use'
  });
  assert.strictEqual(generationItem.role, 'self_generation');
  assert.throws(() => createBalanceItem(generationBoundary.id, {
    itemCode: 'GEN-DUPLICATE-KEY',
    itemName: '重复发电键',
    role: 'self_generation',
    energyTypeId: electricity.id,
    originalUnit: electricity.standardUnit,
    sourceType: 'generation',
    sourceMapping: {
      reference: 'generation:duplicate',
      recordIds: [generationRecordId],
      valueField: 'self_use_value_kwh'
    },
    generationAntiDoubleCountKey: 'generation-record-1-self-use'
  }), { code: 'ENERGY_BALANCE_GENERATION_KEY_CONFLICT' });
  assertThrowsDetailsCode(() => createBalanceItem(generationBoundary.id, {
    itemCode: 'GEN-BAD-ROLE',
    itemName: '错误发电角色',
    role: 'input',
    energyTypeId: electricity.id,
    originalUnit: electricity.standardUnit,
    sourceType: 'generation',
    sourceMapping: {
      reference: 'generation:bad-role',
      recordIds: [generationRecordId],
      valueField: 'generation_value_kwh'
    },
    generationAntiDoubleCountKey: 'generation-record-1-total'
  }), 'INVALID_GENERATION_BALANCE_ROLE');
  assertThrowsDetailsCode(() => calculateAndSaveBalanceSnapshots(generationBoundary.id, {
    startUtc: START_UTC,
    endUtc: END_UTC
  }), 'BALANCE_MONTHLY_SOURCE_WINDOW_NOT_FULL_MONTH');
  const generationCalculation = calculateAndSaveBalanceSnapshots(generationBoundary.id, {
    startUtc: MONTH_START_UTC,
    endUtc: MONTH_END_UTC
  });
  assert.strictEqual(generationCalculation.originalFacets[0].inputTotalOriginal, 60);
  assert(!generationCalculation.originalFacets[0].reasonCodes.includes('GENERATION_BOUNDARY_UNCONFIRMED'));
  const unconfirmedGenerationBoundary = createTestBoundary(organizationId, 'GENERATION-UNCONFIRMED', false);
  createBalanceItem(unconfirmedGenerationBoundary.id, {
    itemCode: 'GEN-UNCONFIRMED',
    itemName: '未确认发电自用',
    role: 'self_generation',
    energyTypeId: electricity.id,
    originalUnit: electricity.standardUnit,
    sourceType: 'generation',
    sourceMapping: {
      reference: 'generation:unconfirmed',
      recordIds: [generationRecordId],
      valueField: 'self_use_value_kwh'
    },
    generationAntiDoubleCountKey: 'generation-record-1-unconfirmed'
  });
  const unconfirmedGenerationCalculation = calculateAndSaveBalanceSnapshots(
    unconfirmedGenerationBoundary.id,
    { startUtc: MONTH_START_UTC, endUtc: MONTH_END_UTC }
  );
  assert(unconfirmedGenerationCalculation.comprehensive.reasonCodes
    .includes('GENERATION_BOUNDARY_UNCONFIRMED'));

  // 任一建议写入失败时，快照、快照项目和建议必须整体回滚。
  const rollbackBoundary = createTestBoundary(organizationId, 'ROLLBACK', false);
  createExplicitItem(rollbackBoundary.id, electricity, 'input', 100, 'ROLLBACK');
  const rollbackDb = openDatabase();
  let snapshotsBefore;
  try {
    snapshotsBefore = Number(rollbackDb.prepare(
      'SELECT COUNT(*) AS total FROM energy_balance_snapshots'
    ).get().total);
    rollbackDb.exec(
      `CREATE TEMP TRIGGER fail_balance_suggestion_insert
       BEFORE INSERT ON energy_balance_suggestions
       BEGIN
         SELECT RAISE(ABORT, 'forced balance suggestion failure');
       END;`
    );
    assert.throws(() => calculateAndSaveBalanceSnapshots(
      rollbackBoundary.id,
      { startUtc: START_UTC, endUtc: END_UTC },
      { db: rollbackDb }
    ), { code: 'ENERGY_BALANCE_OPERATION_FAILED' });
    const snapshotsAfter = Number(rollbackDb.prepare(
      'SELECT COUNT(*) AS total FROM energy_balance_snapshots'
    ).get().total);
    assert.strictEqual(snapshotsAfter, snapshotsBefore, '事务失败不得残留快照。');
    const orphanItems = Number(rollbackDb.prepare(
      `SELECT COUNT(*) AS total
       FROM energy_balance_snapshot_items AS item
       LEFT JOIN energy_balance_snapshots AS snapshot ON snapshot.id = item.energy_balance_snapshot_id
       WHERE snapshot.id IS NULL`
    ).get().total);
    assert.strictEqual(orphanItems, 0);
  } finally {
    rollbackDb.close();
  }

  // 操作审计失败必须回滚同事务中的计算运行、快照、项目和建议。
  const auditRollbackDb = openDatabase();
  try {
    const beforeCounts = auditRollbackDb.prepare(`SELECT
      (SELECT COUNT(*) FROM energy_balance_calculation_runs) AS runs,
      (SELECT COUNT(*) FROM energy_balance_snapshots) AS snapshots,
      (SELECT COUNT(*) FROM energy_balance_snapshot_items) AS snapshotItems,
      (SELECT COUNT(*) FROM energy_balance_suggestions) AS suggestions`).get();
    assert.throws(() => calculateAndSaveBalanceSnapshots(
      rollbackBoundary.id,
      { startUtc: START_UTC, endUtc: END_UTC },
      {
        db: auditRollbackDb,
        beforeAuditInsert: () => {
          throw new Error('forced balance audit failure');
        }
      }
    ), { code: 'ENERGY_BALANCE_OPERATION_FAILED' });
    const afterCounts = auditRollbackDb.prepare(`SELECT
      (SELECT COUNT(*) FROM energy_balance_calculation_runs) AS runs,
      (SELECT COUNT(*) FROM energy_balance_snapshots) AS snapshots,
      (SELECT COUNT(*) FROM energy_balance_snapshot_items) AS snapshotItems,
      (SELECT COUNT(*) FROM energy_balance_suggestions) AS suggestions`).get();
    assert.deepStrictEqual(afterCounts, beforeCounts);
  } finally {
    auditRollbackDb.close();
  }

  // 所有平衡业务写均记录认证操作者和可追溯前后状态。
  const auditDb = openDatabase();
  try {
    const operationRows = auditDb.prepare(`SELECT operation, user_id AS userId, detail_json AS detailJson
      FROM sys_operation_logs WHERE operation LIKE 'energy.balance.%' ORDER BY id`).all();
    assert(operationRows.length > 0);
    assert(operationRows.every((row) => Number(row.userId) === TEST_ACTOR.userId));
    assert(operationRows.every((row) => {
      const detail = JSON.parse(row.detailJson);
      return Object.prototype.hasOwnProperty.call(detail, 'before')
        && Object.prototype.hasOwnProperty.call(detail, 'after');
    }));
  } finally {
    auditDb.close();
  }

  // 隔离库必须保持外键完整性。
  const verificationDb = openDatabase();
  try {
    assert.deepStrictEqual(verificationDb.pragma('foreign_key_check'), []);
  } finally {
    verificationDb.close();
  }

  console.log('energyBalanceService tests passed');
}

try {
  run();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
