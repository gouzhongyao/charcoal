'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 新增消费洞察测试只使用隔离临时目录和 SQLite。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-consumption-insights-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-consumption-insights.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const database = require('../db/database');
const {
  PEAK_CONTRIBUTION_FORMULA_VERSION,
  getPeakContributionAnalysis
} = require('../services/energyConsumptionPeakContributionService');
const {
  ENERGY_INTENSITY_FORMULA_VERSION,
  getEnergyIntensityAnalysis
} = require('../services/energyIntensityAnalysisService');

// 测试来源时区固定为上海。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 高峰贡献测试窗口固定为一小时。
const WINDOW_START_UTC = '2026-07-15T00:00:00.000Z';
const WINDOW_END_UTC = '2026-07-15T01:00:00.000Z';

/**
 * 断言数值在给定误差内相等。
 * @param {number} actual 实际值。
 * @param {number} expected 期望值。
 * @param {number} tolerance 误差。
 */
function assertClose(actual, expected, tolerance = 1e-10) {
  assert.strictEqual(Number.isFinite(actual), true);
  assert.strictEqual(Math.abs(actual - expected) <= tolerance, true, `${actual} 不接近 ${expected}`);
}

/**
 * 初始化组织、产能单元和两块电表。
 * @param {object} db SQLite 连接。
 * @returns {object} 主数据 ID。
 */
function seedMasterData(db) {
  const electricity = db.prepare(
    "SELECT id, standard_unit AS standardUnit FROM energy_types WHERE code = 'electricity'"
  ).get();
  const organizationUnitId = Number(db.prepare(
    `INSERT INTO organization_units
       (unit_code, unit_name, unit_path, unit_type, status)
     VALUES ('INSIGHT-OU-001', '消费洞察测试单元', '/消费洞察测试单元', 'workshop', 'active')`
  ).run().lastInsertRowid);
  const insertMeter = db.prepare(
    `INSERT INTO meter_devices
       (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
     VALUES (?, ?, 'electricity', ?, ?, 'active')`
  );
  const primaryMeterId = Number(insertMeter.run(
    'INSIGHT-METER-001',
    '消费洞察主表',
    electricity.id,
    organizationUnitId
  ).lastInsertRowid);
  const secondaryMeterId = Number(insertMeter.run(
    'INSIGHT-METER-002',
    '消费洞察次表',
    electricity.id,
    organizationUnitId
  ).lastInsertRowid);
  const productionUnitId = Number(db.prepare(
    `INSERT INTO production_units
       (unit_code, unit_name, organization_unit_id, product_name, output_unit, status)
     VALUES ('INSIGHT-PU-001', '消费洞察产能单元', ?, '测试产品', 't', 'active')`
  ).run(organizationUnitId).lastInsertRowid);
  return {
    electricityId: Number(electricity.id),
    organizationUnitId,
    primaryMeterId,
    secondaryMeterId,
    productionUnitId
  };
}

/**
 * 写入一块表的连续十五分钟时序事实。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {number} meterDeviceId 表计 ID。
 * @param {number[]} values 能源量序列。
 */
function insertQuarterHourSeries(db, ids, meterDeviceId, values) {
  const insert = db.prepare(
    `INSERT INTO energy_timeseries_records (
       organization_unit_id, meter_device_id, energy_type_id,
       start_utc, end_utc, source_timezone, granularity_minutes,
       original_unit, original_value, normalized_unit, normalized_value,
       source_reference, data_source, record_status
     ) VALUES (?, ?, ?, ?, ?, ?, 15, 'kWh', ?, 'kWh', ?, ?, 'manual', 'active')`
  );
  values.forEach((value, index) => {
    const startMs = Date.parse(WINDOW_START_UTC) + index * 15 * 60 * 1000;
    insert.run(
      ids.organizationUnitId,
      meterDeviceId,
      ids.electricityId,
      new Date(startMs).toISOString(),
      new Date(startMs + 15 * 60 * 1000).toISOString(),
      SOURCE_TIME_ZONE,
      value,
      value,
      `insight:${meterDeviceId}:${index + 1}`
    );
  });
}

/**
 * 构造标准高峰贡献输入。
 * @param {object} ids 主数据 ID。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 查询输入。
 */
function createPeakInput(ids, overrides = {}) {
  return {
    organizationUnitId: ids.organizationUnitId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: WINDOW_START_UTC,
    endUtc: WINDOW_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    outputIntervalMinutes: 15,
    topContributors: 10,
    ...overrides
  };
}

/**
 * 验证完整覆盖高峰贡献只表达贡献事实而不推断根因。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testPeakContributionFacts(db, ids) {
  db.prepare('DELETE FROM energy_timeseries_records').run();
  insertQuarterHourSeries(db, ids, ids.primaryMeterId, [10, 20, 30, 40]);
  insertQuarterHourSeries(db, ids, ids.secondaryMeterId, [5, 10, 15, 20]);
  const result = getPeakContributionAnalysis(createPeakInput(ids), { db });
  assert.strictEqual(result.formulaVersion, PEAK_CONTRIBUTION_FORMULA_VERSION);
  assert.strictEqual(result.quality.sufficient, true);
  assert.strictEqual(result.quality.coverageRate, 1);
  assert.strictEqual(result.peak.calculable, true);
  assert.strictEqual(result.peak.energy, 60);
  assert.strictEqual(result.peak.intervals.length, 1);
  assert.strictEqual(result.peak.intervals[0].startUtc, '2026-07-15T00:45:00.000Z');
  assert.deepStrictEqual(
    result.peak.intervals[0].contributors.map((item) => [item.meterCode, item.energy]),
    [['INSIGHT-METER-001', 40], ['INSIGHT-METER-002', 20]]
  );
  assertClose(result.peak.intervals[0].contributors[0].contributionShare, 2 / 3);
  assert.strictEqual(result.automationBoundary.infersRootCause, false);
  assert.strictEqual(result.automationBoundary.estimatesSaving, false);
  assert.strictEqual(result.meta.allocationAlgorithm, 'buildFixedUtcLoadBuckets');
}

/**
 * 验证覆盖不足只返回候选区间且不伪装完整峰值。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testPeakContributionCoverageGap(db, ids) {
  db.prepare('DELETE FROM energy_timeseries_records').run();
  insertQuarterHourSeries(db, ids, ids.primaryMeterId, [10, 20, 30, 40]);
  insertQuarterHourSeries(db, ids, ids.secondaryMeterId, [5, 10, 15]);
  const result = getPeakContributionAnalysis(createPeakInput(ids), { db });
  assert.strictEqual(result.quality.sufficient, false);
  assert.strictEqual(result.quality.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'), true);
  assert.strictEqual(result.peak.calculable, false);
  assert.strictEqual(result.peak.energy, null);
  assert.deepStrictEqual(result.peak.intervals, []);
  assert.strictEqual(result.candidatePeak.available, true);
  assert.strictEqual(result.candidatePeak.intervals[0].candidateOnly, true);
  assert.strictEqual(
    result.candidatePeak.intervals[0].interpretation.includes('不代表完整峰值或根因'),
    true
  );
}

/**
 * 写入 active 月度能耗事实。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {string} month 月份。
 * @param {number} value 能耗。
 * @param {string} unit 单位。
 * @param {string} suffix 唯一键后缀。
 */
function insertEnergyRecord(db, ids, month, value, unit, suffix) {
  db.prepare(
    `INSERT INTO energy_records (
       energy_type_id, organization_unit_id, meter_device_id,
       original_month, normalized_month, original_unit, original_value,
       normalized_unit, normalized_value, duplicate_key, record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(
    ids.electricityId,
    ids.organizationUnitId,
    ids.primaryMeterId,
    month,
    month,
    unit,
    value,
    unit,
    value,
    `insight-energy:${month}:${suffix}`
  );
}

/**
 * 写入 active 产量分母事实。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 * @param {string} month 月份。
 * @param {number} value 产量。
 * @param {string} unit 单位。
 */
function insertOutputRecord(db, ids, month, value, unit = 't') {
  db.prepare(
    `INSERT INTO production_output_records (
       production_unit_id, normalized_month, output_value, output_unit,
       data_source, record_status
     ) VALUES (?, ?, ?, ?, 'manual', 'active')`
  ).run(ids.productionUnitId, month, value, unit);
}

/**
 * 验证严格强度按能源和单位分面并区分零值、缺失和单位不兼容。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testStrictEnergyIntensity(db, ids) {
  db.prepare('DELETE FROM energy_records').run();
  db.prepare('DELETE FROM production_output_records').run();
  insertOutputRecord(db, ids, '2026-01', 10);
  insertOutputRecord(db, ids, '2026-03', 20);
  insertOutputRecord(db, ids, '2026-04', 30, 'kg');
  insertEnergyRecord(db, ids, '2026-01', 100, 'kWh', 'jan');
  insertEnergyRecord(db, ids, '2026-02', 50, 'kWh', 'feb');
  insertEnergyRecord(db, ids, '2026-03', 0, 'kWh', 'mar-zero');
  insertEnergyRecord(db, ids, '2026-04', 60, 'kWh', 'apr');
  insertEnergyRecord(db, ids, '2026-01', 1, 'MWh', 'jan-incompatible');

  const result = getEnergyIntensityAnalysis({
    productionUnitId: ids.productionUnitId,
    startMonth: '2026-01',
    endMonth: '2026-04'
  }, { db });
  assert.strictEqual(result.formulaVersion, ENERGY_INTENSITY_FORMULA_VERSION);
  assert.strictEqual(result.formula.crossEnergyAggregation, false);
  assert.strictEqual(result.formula.crossUnitAggregation, false);
  const kwhFacet = result.facets.find((facet) => facet.numeratorUnit === 'kWh');
  const mwhFacet = result.facets.find((facet) => facet.numeratorUnit === 'MWh');
  assert(kwhFacet);
  assert(mwhFacet);
  assert.strictEqual(kwhFacet.monthly[0].status, 'calculable');
  assert.strictEqual(kwhFacet.monthly[0].intensity.value, 10);
  assert.strictEqual(kwhFacet.monthly[0].intensity.unit, 'kWh/t');
  assert.strictEqual(kwhFacet.monthly[1].status, 'denominator_missing');
  assert.strictEqual(kwhFacet.monthly[1].intensity.value, null);
  assert.strictEqual(kwhFacet.monthly[2].status, 'numerator_zero');
  assert.strictEqual(kwhFacet.monthly[2].intensity.value, 0);
  assert.strictEqual(kwhFacet.monthly[3].status, 'denominator_unit_incompatible');
  assert.strictEqual(mwhFacet.unitComparable, false);
  assert.strictEqual(mwhFacet.monthly[0].status, 'unit_incompatible');
  assert.strictEqual(mwhFacet.monthly[0].intensity.value, null);
  assert.strictEqual(result.meta.generationRecordsRead, false);
  assert.strictEqual(result.meta.meterReadingRecordsRead, false);
  assert.strictEqual(result.meta.writesEnergyRecords, false);
}

/**
 * 验证显式能源和单位筛选在分子缺失时返回缺失而不是零。
 * @param {object} db SQLite 连接。
 * @param {object} ids 主数据 ID。
 */
function testMissingNumeratorIsNotZero(db, ids) {
  const result = getEnergyIntensityAnalysis({
    productionUnitId: ids.productionUnitId,
    startMonth: '2026-03',
    endMonth: '2026-03',
    energyTypeCode: 'electricity',
    unit: 'GWh'
  }, { db });
  assert.strictEqual(result.facets.length, 1);
  assert.strictEqual(result.facets[0].monthly[0].status, 'numerator_missing');
  assert.strictEqual(result.facets[0].monthly[0].numerator.value, null);
  assert.strictEqual(result.facets[0].monthly[0].intensity.value, null);
}

/**
 * 执行全部新增消费洞察服务测试。
 */
function run() {
  database.initDatabase();
  const db = database.openDatabase();
  try {
    const ids = seedMasterData(db);
    testPeakContributionFacts(db, ids);
    testPeakContributionCoverageGap(db, ids);
    testStrictEnergyIntensity(db, ids);
    testMissingNumeratorIsNotZero(db, ids);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('energy consumption insights service tests passed');
}

run();
