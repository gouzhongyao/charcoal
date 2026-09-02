'use strict';

const assert = require('assert');
const {
  DEFAULT_CARBON_EMISSION_UNIT,
  MAX_CARBON_EMISSION_UNIT_CODE_POINTS,
  normalizeCarbonEmissionUnit
} = require('../services/carbonEmissionUnitContract');

/** 断言单位输入成功规范化为预期正式值，并验证正式值二次规范化幂等。 */
function assertValidUnit(input, expected) {
  const result = normalizeCarbonEmissionUnit(input);
  assert.deepStrictEqual(result, { ok: true, value: expected });
  assert(Object.isFrozen(result));
  // 二次规范化结果用于覆盖全部合法样例产生的 canonical 输出集合。
  const canonicalResult = normalizeCarbonEmissionUnit(result.value);
  assert.deepStrictEqual(canonicalResult, { ok: true, value: result.value });
  assert(Object.isFrozen(canonicalResult));
}

/** 断言单位输入被合同拒绝且不回显原始输入。 */
function assertInvalidUnit(input, expectedReason = null) {
  const result = normalizeCarbonEmissionUnit(input);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(typeof result.reason, 'string');
  if (expectedReason) assert.strictEqual(result.reason, expectedReason);
  assert.deepStrictEqual(Object.keys(result).sort(), ['ok', 'reason']);
  assert(Object.isFrozen(result));
  const inputText = typeof input === 'string' ? input : '';
  if (inputText) assert.strictEqual(JSON.stringify(result).includes(inputText), false);
}

assert.strictEqual(DEFAULT_CARBON_EMISSION_UNIT, 'kgCO2e');
assert.strictEqual(MAX_CARBON_EMISSION_UNIT_CODE_POINTS, 64);
assert(Object.isFrozen(require('../services/carbonEmissionUnitContract')));
assert.deepStrictEqual(
  Reflect.ownKeys(require('../services/carbonEmissionUnitContract')).sort(),
  [
    'DEFAULT_CARBON_EMISSION_UNIT',
    'MAX_CARBON_EMISSION_UNIT_CODE_POINTS',
    'normalizeCarbonEmissionUnit'
  ].sort()
);

[
  ['CO2e', 'CO2e'],
  ['gCO2e', 'gCO2e'],
  ['kgCO2e', 'kgCO2e'],
  ['tCO2e', 'tCO2e'],
  ['ktCO2e', 'ktCO2e'],
  ['MtCO2e', 'MtCO2e'],
  ['GtCO2e', 'GtCO2e'],
  ['tCO2e/MWh', 'tCO2e/MWh'],
  ['kg CO2e/kWh', 'kgCO2e/kWh'],
  ['kgCO₂e/kWh', 'kgCO2e/kWh'],
  ['kg CO₂e / kWh', 'kgCO2e/kWh'],
  ['kgCO2e/(kWh)', 'kgCO2e/kWh'],
  ['tCO2e/m³', 'tCO2e/m3'],
  ['tCO2e/m^3', 'tCO2e/m3'],
  ['  Mt CO₂e / (MWh)  ', 'MtCO2e/MWh']
].forEach(([input, expected]) => assertValidUnit(input, expected));

[
  undefined,
  null,
  '',
  '   ',
  {},
  [],
  new String('kgCO2e'),
  'kg\tCO2e',
  'kg\rCO2e',
  'kg\nCO2e',
  String.fromCharCode(0) + 'kgCO2e',
  String.fromCharCode(127) + 'kgCO2e',
  'kg CO2e',
  'kg​CO2e',
  'kg‮CO2e',
  'kgCO2e⁄kWh',
  'kgCO2e∕kWh',
  'kgCO2e／kWh',
  'kgCO2e\\kWh',
  'kgCO2e/kWh/MWh',
  'kgCO2e/((kWh))',
  'kgco2e',
  'KGCO2e',
  'mCO2e',
  'kgCO2',
  'kgCO2eq',
  'kgCO2e/GJ',
  'kgCO2e/m2',
  'kgCO2e/kg',
  'customEmissionUnit',
  'SELECTUnit',
  'kgＣＯ2e',
  'kgCO₂ｅ',
  'kgCO2e/( kWh )',
  'kgCO2e/()',
  'kgCO2e/((MWh))',
  'kgCO2e/(m^3)/kWh',
  'kgCO2e' + ' '.repeat(59)
].forEach((input) => assertInvalidUnit(input));

assertInvalidUnit('X'.repeat(65), 'INPUT_TOO_LONG');
assertInvalidUnit('😀'.repeat(65), 'INPUT_TOO_LONG');
// 辨识输入包含 33 个 astral emoji：code point 未超限，但 UTF-16 code unit 已超过 64。
const codePointAndUtf16DivergenceInput = '😀'.repeat(33);
assert.strictEqual([...codePointAndUtf16DivergenceInput].length, 33);
assert.strictEqual(codePointAndUtf16DivergenceInput.length, 66);
assertInvalidUnit(codePointAndUtf16DivergenceInput, 'FORMAT_INVALID');
// 合法边界核心使用现有别名，前置 ASCII 空格补足到精确 64 个 Unicode code point。
const maxLengthValidUnitCore = 't CO₂e / m³';
// 合法边界输入按 Unicode code point 差值构造，不使用 UTF-16 String.length 计数。
const maxLengthValidUnitInput = ' '.repeat(MAX_CARBON_EMISSION_UNIT_CODE_POINTS - [...maxLengthValidUnitCore].length) + maxLengthValidUnitCore;
assert.strictEqual([...maxLengthValidUnitInput].length, MAX_CARBON_EMISSION_UNIT_CODE_POINTS);
assertValidUnit(maxLengthValidUnitInput, 'tCO2e/m3');

console.log('carbon emission unit contract tests passed');
