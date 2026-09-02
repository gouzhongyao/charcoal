'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES,
  DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER,
  DEMO_ACTUAL_ENERGY_ORGANIZATION,
  DEMO_ACTUAL_ENERGY_PERIODS,
  DEMO_ACTUAL_ENERGY_ROWS,
  DEMO_ACTUAL_ENERGY_SOURCE_WORKSHEET,
  buildDemoActualEnergyRows,
  convertActualEnergyValue
} = require('../services/demoActualEnergyFixture');

// Excel 第一工作表只读提取后的三段非空月值作为独立回归基准，不包含合计或其他指标。
const EXPECTED_SOURCE_PERIODS = [
  {
    label: '2024年3月至2025年2月',
    startMonth: '2024-03',
    endMonth: '2025-02',
    monthlyValues: {
      electricity: {
        '2024-03': 742169, '2024-04': 678749, '2024-05': 610530, '2024-06': 679261,
        '2024-07': 740771, '2024-08': 682580, '2024-09': 776232, '2024-10': 720078,
        '2024-11': 692543, '2024-12': 751185, '2025-01': 601512, '2025-02': 630514
      },
      water: {
        '2024-03': 1444, '2024-04': 2177, '2024-05': 2288, '2024-06': 2800,
        '2024-07': 1989, '2024-08': 2194, '2024-09': 2208, '2024-10': 1982,
        '2024-11': 1780, '2024-12': 1329, '2025-01': 1477, '2025-02': 1433
      },
      diesel: { '2024-03': 143.07 },
      natural_gas: {
        '2024-03': 3631.96, '2024-05': 4076.08, '2024-09': 4076.08, '2025-02': 1302.08
      }
    }
  },
  {
    label: '2025年3月至2026年2月',
    startMonth: '2025-03',
    endMonth: '2026-02',
    monthlyValues: {
      electricity: {
        '2025-03': 841845, '2025-04': 729326, '2025-05': 657176, '2025-06': 546243,
        '2025-07': 693206, '2025-08': 609258, '2025-09': 597909, '2025-10': 375627,
        '2025-11': 542671, '2025-12': 689996, '2026-01': 751221, '2026-02': 273046
      },
      water: {
        '2025-03': 1456, '2025-04': 1983, '2025-05': 1805, '2025-06': 1942,
        '2025-07': 1989, '2025-08': 2067, '2025-09': 2445, '2025-10': 1711,
        '2025-11': 1763, '2025-12': 1895, '2026-01': 2054, '2026-02': 1456
      },
      diesel: { '2025-03': 119.8 },
      natural_gas: { '2025-04': 7812.5, '2025-09': 3797.46, '2026-01': 6329.11 }
    }
  },
  {
    label: '2026年3月至2027年2月',
    startMonth: '2026-03',
    endMonth: '2027-02',
    monthlyValues: {
      electricity: { '2026-03': 652105 },
      water: { '2026-03': 1386 }
    }
  }
];
// 三段期间换算后的计划对账总计。
const EXPECTED_PERIOD_TOTALS = Object.freeze([
  Object.freeze({ electricity: 8306124, water: 23101, diesel: 168317.65, natural_gas: 13086.2 }),
  Object.freeze({ electricity: 7307524, water: 22566, diesel: 140941.18, natural_gas: 17939.07 }),
  Object.freeze({ electricity: 652105, water: 1386 })
]);

/** 按来源期间备注筛选正式模板行。 */
function getRowsForPeriod(periodLabel) {
  return DEMO_ACTUAL_ENERGY_ROWS.filter((row) => row[6].includes(`期间：${periodLabel}；`));
}

/** 按能源类型汇总正式模板标准值并保持两位小数对账。 */
function summarizeRows(rows) {
  const totals = {};
  rows.forEach((row) => {
    totals[row[1]] = Number(((totals[row[1]] || 0) + Number(row[2])).toFixed(2));
  });
  return totals;
}

assert.strictEqual(DEMO_ACTUAL_ENERGY_SOURCE_WORKSHEET, '1公司消耗情况表');
assert.deepStrictEqual(DEMO_ACTUAL_ENERGY_ORGANIZATION, {
  code: 'QL-ACTUAL-PARK',
  name: '实际能耗样例企业'
});
assert.strictEqual(DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER, 0.85);
assert.strictEqual(DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES, 2);
assert.deepStrictEqual(DEMO_ACTUAL_ENERGY_PERIODS, EXPECTED_SOURCE_PERIODS, '静态 fixture 必须精确匹配第一工作表三段非空月值。');
assert.deepStrictEqual(buildDemoActualEnergyRows(), DEMO_ACTUAL_ENERGY_ROWS, '动态生成与冻结运行时行必须一致。');
assert.strictEqual(DEMO_ACTUAL_ENERGY_ROWS.length, 59);
assert.deepStrictEqual(DEMO_ACTUAL_ENERGY_PERIODS.map((period) => getRowsForPeriod(period.label).length), [29, 28, 2]);
assert.deepStrictEqual(
  DEMO_ACTUAL_ENERGY_PERIODS.map((period) => summarizeRows(getRowsForPeriod(period.label))),
  EXPECTED_PERIOD_TOTALS
);

// 四类能源条数、标准单位、月份范围和跨年边界必须精确成立。
const rowsByEnergyType = DEMO_ACTUAL_ENERGY_ROWS.reduce((groups, row) => {
  groups[row[1]] = [...(groups[row[1]] || []), row];
  return groups;
}, {});
assert.deepStrictEqual(Object.fromEntries(Object.entries(rowsByEnergyType).map(([code, rows]) => [code, rows.length])), {
  electricity: 25,
  water: 25,
  diesel: 2,
  natural_gas: 7
});
assert(rowsByEnergyType.electricity.every((row) => row[3] === 'kWh'));
assert(rowsByEnergyType.water.every((row) => row[3] === 'm3'));
assert(rowsByEnergyType.diesel.every((row) => row[3] === 'L'));
assert(rowsByEnergyType.natural_gas.every((row) => row[3] === 'm3'));
assert.deepStrictEqual(rowsByEnergyType.electricity.map((row) => row[0]), [
  '2024-03', '2024-04', '2024-05', '2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12',
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
  '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'
]);
assert.strictEqual([...DEMO_ACTUAL_ENERGY_ROWS].sort((left, right) => left[0].localeCompare(right[0]))[0][0], '2024-03');
assert.strictEqual([...DEMO_ACTUAL_ENERGY_ROWS].sort((left, right) => left[0].localeCompare(right[0])).at(-1)[0], '2026-03');

// 柴油换算、水 1:1 换算、独立组织和空计量器具口径不得漂移。
assert.strictEqual(convertActualEnergyValue('diesel', 143.07), 168317.65);
assert.strictEqual(convertActualEnergyValue('diesel', 119.8), 140941.18);
assert.strictEqual(convertActualEnergyValue('water', 1386), 1386);
assert.deepStrictEqual(rowsByEnergyType.diesel.map((row) => [row[0], row[2]]), [
  ['2024-03', 168317.65],
  ['2025-03', 140941.18]
]);
assert(rowsByEnergyType.diesel.every((row) => row[6].includes('0.85 kg/L') && row[6].includes('保留 2 位小数')));
assert(rowsByEnergyType.water.every((row) => row[6].includes('按 1:1 换算为 m3')));
assert(DEMO_ACTUAL_ENERGY_ROWS.every((row) => row.length === 7 && row[2] > 0));
assert(DEMO_ACTUAL_ENERGY_ROWS.every((row) => row[4] === 'QL-ACTUAL-PARK' && row[5] === ''));
assert(DEMO_ACTUAL_ENERGY_ROWS.every((row) => row[6].includes('来源工作表：1公司消耗情况表；期间：')));
assert.strictEqual(new Set(DEMO_ACTUAL_ENERGY_ROWS.map((row) => [row[0], row[1], row[3], row[4], row[5]].join('|'))).size, 59);
assert(DEMO_ACTUAL_ENERGY_ROWS.every(Object.isFrozen));
assert(Object.isFrozen(DEMO_ACTUAL_ENERGY_ROWS));

// fixture 源事实不得混入合计、Q/R、产值、产量、折标、强度或原工作簿运行时依赖。
const serializedPeriods = JSON.stringify(DEMO_ACTUAL_ENERGY_PERIODS);
['合计', '产值', '产量', '折标', '强度'].forEach((excludedTerm) => assert(!serializedPeriods.includes(excludedTerm)));
assert.doesNotMatch(serializedPeriods, /"[QR]"/);
const fixtureSource = fs.readFileSync(path.resolve(__dirname, '../services/demoActualEnergyFixture.js'), 'utf8');
assert.doesNotMatch(fixtureSource, /require\(['"](?:fs|xlsx)['"]\)/);
assert.doesNotMatch(fixtureSource, /能源消耗情况表\.xlsx/);

console.log('demo actual energy fixture tests passed');
