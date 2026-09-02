const assert = require('assert');
const {
  buildCarbonEmissionsStatusMigrationSql,
  carbonEmissionsStatusCheckAllowsSuperseded
} = require('../db/database');
const {
  DEFAULT_EMISSION_UNIT,
  EMISSION_GROUP_COLUMNS,
  EMISSION_SORT_COLUMNS,
  calculateEmissionValue,
  normalizeEmissionGroupBy,
  normalizeEmissionSort,
  normalizeYear,
  selectBestCarbonFactor
} = require('../services/carbonAccountingUtils');
const {
  DEFAULT_CARBON_EMISSION_UNIT
} = require('../services/carbonEmissionUnitContract');

assert.strictEqual(DEFAULT_EMISSION_UNIT, DEFAULT_CARBON_EMISSION_UNIT);
assert.strictEqual(DEFAULT_EMISSION_UNIT, 'kgCO2e');

const baseRecord = {
  id: 101,
  energyTypeCode: 'electricity',
  energyTypeName: '电力',
  normalizedMonth: '2026-03',
  normalizedUnit: 'kWh',
  normalizedValue: 123.45
};

const candidates = [
  {
    id: 1,
    energyTypeCode: 'electricity',
    energyTypeName: '电力',
    region: 'default',
    factorYear: 2026,
    unit: 'kWh',
    factorValue: 0.58,
    factorUnit: 'kgCO2e',
    source: 'default-year',
    isActive: 1
  },
  {
    id: 2,
    energyTypeCode: 'electricity',
    energyTypeName: '电力',
    region: '华东',
    factorYear: null,
    unit: 'kWh',
    factorValue: 0.61,
    factorUnit: 'kgCO2e',
    source: 'regional-generic',
    isActive: 1
  },
  {
    id: 3,
    energyTypeCode: 'electricity',
    energyTypeName: '电力',
    region: '华东',
    factorYear: 2026,
    unit: 'kWh',
    factorValue: 0.55,
    factorUnit: 'kgCO2e',
    source: 'regional-year',
    isActive: 1
  },
  {
    id: 4,
    energyTypeCode: 'electricity',
    energyTypeName: '电力',
    region: '华东',
    factorYear: 2026,
    unit: 'MWh',
    factorValue: 550,
    factorUnit: 'kgCO2e',
    source: 'wrong-unit',
    isActive: 1
  },
  {
    id: 5,
    energyTypeCode: 'electricity',
    energyTypeName: '电力',
    region: '华东',
    factorYear: 2026,
    unit: 'kWh',
    factorValue: 0.1,
    factorUnit: 'kgCO2e',
    source: 'inactive',
    isActive: 0
  }
];

const best = selectBestCarbonFactor(baseRecord, candidates, { region: '华东', factorYear: 2026 });
assert.strictEqual(best.factor.id, 3);
assert.strictEqual(best.missing, null);

const fallbackToDefaultYear = selectBestCarbonFactor(baseRecord, candidates, { region: '华北', factorYear: 2026 });
assert.strictEqual(fallbackToDefaultYear.factor.id, 1);

const defaultCurrentYearBeatsRegionalGeneric = selectBestCarbonFactor(baseRecord, candidates.filter((candidate) => candidate.id !== 3), {
  region: '华东',
  factorYear: 2026
});
assert.strictEqual(defaultCurrentYearBeatsRegionalGeneric.factor.id, 1);

const fallbackToRegionalGeneric = selectBestCarbonFactor(
  baseRecord,
  candidates.filter((candidate) => candidate.id !== 1 && candidate.id !== 3),
  {
    region: '华东',
    factorYear: 2026
  }
);
assert.strictEqual(fallbackToRegionalGeneric.factor.id, 2);

const nationalAliasAsDefault = selectBestCarbonFactor(
  baseRecord,
  [
    {
      ...candidates[0],
      id: 6,
      region: '全国',
      source: 'national-year'
    }
  ],
  { region: '默认', factorYear: 2026 }
);
assert.strictEqual(nationalAliasAsDefault.factor.id, 6);

const missing = selectBestCarbonFactor(
  { ...baseRecord, energyTypeCode: 'natural_gas', energyTypeName: '天然气', normalizedUnit: 'm3' },
  candidates,
  { region: '华东', factorYear: 2026 }
);
assert.strictEqual(missing.factor, null);
assert.deepStrictEqual(missing.missing, {
  energyRecordId: 101,
  energyTypeCode: 'natural_gas',
  energyTypeName: '天然气',
  normalizedMonth: '2026-03',
  normalizedUnit: 'm3',
  normalizedValue: 123.45,
  requestedRegion: '华东',
  factorYear: 2026,
  reason: '未找到匹配的启用碳因子。'
});

assert.strictEqual(calculateEmissionValue(123.456789, 0.581234), 71.757283);
assert.strictEqual(calculateEmissionValue(0, 0.581234), 0);
assert.throws(
  () => calculateEmissionValue(1, 0),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_FACTOR_VALUE'
);
assert.throws(
  () => calculateEmissionValue(-1, 0.5),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_ACTIVITY_VALUE'
);

assert.strictEqual(normalizeYear('2026', 'factorYear'), 2026);
assert.strictEqual(normalizeYear('', 'factorYear'), null);
assert.throws(
  () => normalizeYear('2026;DROP TABLE carbon_factors', 'factorYear'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_YEAR'
);

Object.keys(EMISSION_GROUP_COLUMNS).forEach((groupBy) => {
  assert.strictEqual(normalizeEmissionGroupBy(groupBy).groupBy, groupBy);
});
assert.throws(
  () => normalizeEmissionGroupBy('carbonFactorId;DROP TABLE carbon_emissions'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_EMISSION_GROUP_BY'
);

Object.keys(EMISSION_SORT_COLUMNS).forEach((sortBy) => {
  assert.strictEqual(normalizeEmissionSort({ sortBy, sortOrder: 'asc' }).sortBy, sortBy);
  assert.strictEqual(normalizeEmissionSort({ sortBy, sortOrder: 'desc' }).sortOrder, 'desc');
});
assert.throws(
  () => normalizeEmissionSort({ sortBy: 'calculated_at;DROP TABLE carbon_emissions' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_EMISSION_SORT_FIELD'
);
assert.throws(
  () => normalizeEmissionSort({ sortBy: 'calculatedAt', sortOrder: 'delete' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_SORT_ORDER'
);

const oldCarbonEmissionsTableSql = `CREATE TABLE carbon_emissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'factor_missing', 'invalid_record'))
)`;
const newCarbonEmissionsTableSql = `CREATE TABLE carbon_emissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'factor_missing', 'invalid_record', 'superseded'))
)`;
assert.strictEqual(carbonEmissionsStatusCheckAllowsSuperseded(oldCarbonEmissionsTableSql), false);
assert.strictEqual(carbonEmissionsStatusCheckAllowsSuperseded(newCarbonEmissionsTableSql), true);

const migrationSql = buildCarbonEmissionsStatusMigrationSql().join('\n');
assert.match(migrationSql, /CREATE TABLE carbon_emissions__migration_new/);
assert.match(migrationSql, /'superseded'/);
assert.match(migrationSql, /INSERT INTO carbon_emissions__migration_new/);
assert.match(migrationSql, /FROM carbon_emissions/);
assert.match(migrationSql, /DROP TABLE carbon_emissions/);
assert.match(migrationSql, /ALTER TABLE carbon_emissions__migration_new RENAME TO carbon_emissions/);

console.log('carbon accounting utility tests passed');
