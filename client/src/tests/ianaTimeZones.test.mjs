import assert from 'node:assert/strict';
import {
  IANA_TIME_ZONE_PATTERN,
  STATIC_IANA_TIME_ZONES,
  buildIanaTimeZoneCandidates,
  buildIanaTimeZoneOptions,
  isIanaTimeZone,
  readRuntimeIanaTimeZones
} from '../utils/ianaTimeZones.js';

// 方法模块：构造可控 Intl 测试替身。

/**
 * 构造只接受指定时区的 Intl 兼容对象。
 * @param {string[]} supportedValues supportedValuesOf 返回值。
 * @param {string[]} validValues DateTimeFormat 可实例化值。
 * @param {boolean} throwOnSupportedValues supportedValuesOf 是否抛错。
 * @returns {object} Intl 兼容测试对象。
 */
function createIntlStub(supportedValues, validValues, throwOnSupportedValues = false) {
  // 可实例化集合：用于模拟浏览器实际支持的时区子集。
  const validValueSet = new Set(validValues);
  /**
   * 模拟可由 new 调用的 Intl.DateTimeFormat 构造器。
   * @param {string} _locale 区域标识。
   * @param {{ timeZone?: string }} options 格式化选项。
   */
  function DateTimeFormat(_locale, options = {}) {
    if (!validValueSet.has(options.timeZone)) throw new RangeError('invalid time zone');
    this.format = () => 'formatted';
  }

  return {
    supportedValuesOf(key) {
      if (throwOnSupportedValues) throw new Error('runtime enumeration failed');
      assert.equal(key, 'timeZone');
      return supportedValues;
    },
    DateTimeFormat
  };
}

// 静态清单契约：不依赖当前 Node 返回固定数量，只断言关键稳定值、排序与去重。
assert(STATIC_IANA_TIME_ZONES.length > 0);
assert(STATIC_IANA_TIME_ZONES.includes('Asia/Shanghai'));
assert(STATIC_IANA_TIME_ZONES.includes('America/New_York'));
assert(STATIC_IANA_TIME_ZONES.includes('Pacific/Chatham'));
assert(STATIC_IANA_TIME_ZONES.includes('Etc/UTC'));
assert(!STATIC_IANA_TIME_ZONES.includes('UTC'));
assert.equal(new Set(STATIC_IANA_TIME_ZONES).size, STATIC_IANA_TIME_ZONES.length);
assert.deepEqual([...STATIC_IANA_TIME_ZONES].sort((left, right) => left.localeCompare(right, 'en')), [...STATIC_IANA_TIME_ZONES]);

// 形态与当前运行时校验：至少包含斜杠，并由 Intl 实际实例化确认。
assert.equal(IANA_TIME_ZONE_PATTERN.test('Asia/Shanghai'), true);
assert.equal(IANA_TIME_ZONE_PATTERN.test('Etc/UTC'), true);
assert.equal(IANA_TIME_ZONE_PATTERN.test('UTC'), false);
assert.equal(IANA_TIME_ZONE_PATTERN.test('+08:00'), false);
assert.equal(isIanaTimeZone('Asia/Shanghai'), true);
assert.equal(isIanaTimeZone('Etc/UTC'), true);
assert.equal(isIanaTimeZone('UTC'), false);
assert.equal(isIanaTimeZone('Mars/Olympus_Mons'), false);

// supportedValuesOf 缺失或抛错时必须安全退化，不影响静态候选可用性。
const missingEnumerationIntl = createIntlStub([], ['Asia/Shanghai', 'Etc/UTC']);
delete missingEnumerationIntl.supportedValuesOf;
assert.deepEqual(readRuntimeIanaTimeZones(missingEnumerationIntl), []);
assert.deepEqual(buildIanaTimeZoneCandidates(missingEnumerationIntl), ['Asia/Shanghai', 'Etc/UTC']);
const throwingEnumerationIntl = createIntlStub([], ['Asia/Shanghai', 'Etc/UTC'], true);
assert.deepEqual(readRuntimeIanaTimeZones(throwingEnumerationIntl), []);
assert.deepEqual(buildIanaTimeZoneCandidates(throwingEnumerationIntl), ['Asia/Shanghai', 'Etc/UTC']);

// 运行时补充必须合并、去重、排序，同时排除裸 UTC 和不可实例化值。
const supplementalIntl = createIntlStub(
  ['Pacific/Chatham', 'UTC', 'Mars/Olympus_Mons', 'Asia/Shanghai'],
  ['Asia/Shanghai', 'Etc/UTC', 'Pacific/Chatham']
);
assert.deepEqual(readRuntimeIanaTimeZones(supplementalIntl), ['Pacific/Chatham', 'Asia/Shanghai']);
assert.deepEqual(buildIanaTimeZoneCandidates(supplementalIntl), ['Asia/Shanghai', 'Etc/UTC', 'Pacific/Chatham']);

// 历史值不在候选时必须增加禁用回显项，不能静默清空或伪装为可选候选。
const historicalOptions = buildIanaTimeZoneOptions('Legacy/Removed_Zone', supplementalIntl);
assert.deepEqual(historicalOptions[0], {
  value: 'Legacy/Removed_Zone',
  label: 'Legacy/Removed_Zone（历史值，不在当前候选）',
  disabled: true,
  historical: true
});
assert(historicalOptions.slice(1).every((option) => option.disabled === false && option.historical === false));
const knownOptions = buildIanaTimeZoneOptions('Asia/Shanghai', supplementalIntl);
assert.equal(knownOptions.filter((option) => option.value === 'Asia/Shanghai').length, 1);
assert.equal(knownOptions.some((option) => option.historical), false);

console.log('ianaTimeZones.test.mjs passed');
