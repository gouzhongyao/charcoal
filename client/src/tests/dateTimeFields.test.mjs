import assert from 'node:assert/strict';
import {
  MINUTES_PER_DAY,
  daysInGregorianMonth,
  formatMinutesAsTimeOfDay,
  isGregorianLeapYear,
  isMinuteOfDay,
  isStrictUtcDateTime,
  normalizeStrictUtcDateTime,
  parseStrictUtcDateTime,
  parseTimeOfDayToMinutes
} from '../utils/dateTimeFields.js';

// 方法模块：测试断言辅助。

/**
 * 断言 UTC 值无效并匹配错误编码。
 * @param {unknown} value 待校验值。
 * @param {string} code 预期错误编码。
 * @returns {void}
 */
function assertInvalidUtc(value, code) {
  // 解析结果：用于同时核对失败状态与禁止输出规范值。
  const result = parseStrictUtcDateTime(value);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
  assert.equal(result.code, code);
}

/**
 * 断言 HH:mm 值无效并匹配错误编码。
 * @param {unknown} value 待校验值。
 * @param {string} code 预期错误编码。
 * @returns {void}
 */
function assertInvalidTime(value, code) {
  // 解析结果：用于核对非法时间不会被转换为分钟数。
  const result = parseTimeOfDayToMinutes(value);
  assert.equal(result.valid, false);
  assert.equal(result.value, null);
  assert.equal(result.code, code);
}

// 日历模块测试：覆盖普通闰年、世纪年与 400 年规则。
assert.equal(isGregorianLeapYear(2024), true);
assert.equal(isGregorianLeapYear(1900), false);
assert.equal(isGregorianLeapYear(2000), true);
assert.equal(isGregorianLeapYear(2100), false);
assert.equal(isGregorianLeapYear(0), false);
assert.equal(daysInGregorianMonth(2024, 2), 29);
assert.equal(daysInGregorianMonth(2023, 2), 28);
assert.equal(daysInGregorianMonth(2024, 4), 30);
assert.equal(daysInGregorianMonth(2024, 13), null);

// UTC 模块测试：合法值保持字面 UTC 字段，不依赖本机时区。
const validUtc = parseStrictUtcDateTime('2024-02-29T23:59:59Z');
assert.equal(validUtc.valid, true);
assert.equal(validUtc.value, '2024-02-29T23:59:59Z');
assert.deepEqual(validUtc.parts, {
  year: 2024,
  month: 2,
  day: 29,
  hour: 23,
  minute: 59,
  second: 59,
  millisecond: 0
});
assert.equal(validUtc.hadZeroMilliseconds, false);
assert.equal(isStrictUtcDateTime('0001-01-01T00:00:00Z'), true);
assert.equal(isStrictUtcDateTime('9999-12-31T23:59:59Z'), true);

// 零毫秒测试：.000Z 可无损接受并规范为默认秒精度。
const zeroMillisecondUtc = parseStrictUtcDateTime('2024-06-30T08:09:10.000Z');
assert.equal(zeroMillisecondUtc.valid, true);
assert.equal(zeroMillisecondUtc.value, '2024-06-30T08:09:10Z');
assert.equal(zeroMillisecondUtc.hadZeroMilliseconds, true);
assert.equal(normalizeStrictUtcDateTime('2024-06-30T08:09:10.000Z'), '2024-06-30T08:09:10Z');

// 非法 UTC 测试：覆盖格式、真实日历、范围、秒与毫秒精度。
assertInvalidUtc(null, 'type');
assertInvalidUtc('', 'format');
assertInvalidUtc(' 2024-01-01T00:00:00Z', 'format');
assertInvalidUtc('2024-01-01 00:00:00Z', 'format');
assertInvalidUtc('2024-01-01T00:00:00z', 'format');
assertInvalidUtc('2024-01-01T00:00:00+00:00', 'format');
assertInvalidUtc('2024-01-01T00:00Z', 'format');
assertInvalidUtc('0000-01-01T00:00:00Z', 'year-range');
assertInvalidUtc('2024-00-01T00:00:00Z', 'month-range');
assertInvalidUtc('2024-13-01T00:00:00Z', 'month-range');
assertInvalidUtc('2023-02-29T00:00:00Z', 'day-range');
assertInvalidUtc('1900-02-29T00:00:00Z', 'day-range');
assertInvalidUtc('2100-02-29T00:00:00Z', 'day-range');
assertInvalidUtc('2024-04-31T00:00:00Z', 'day-range');
assertInvalidUtc('2024-01-01T24:00:00Z', 'hour-range');
assertInvalidUtc('2024-01-01T23:60:00Z', 'minute-range');
assertInvalidUtc('2024-01-01T23:59:60Z', 'second-range');
assertInvalidUtc('2024-01-01T00:00:00.001Z', 'millisecond-precision');
assertInvalidUtc('2024-01-01T00:00:00.999Z', 'millisecond-precision');
assertInvalidUtc('2024-01-01T00:00:00.0000Z', 'format');
assert.equal(normalizeStrictUtcDateTime('2024-01-01T00:00:00.001Z'), null);

// UTC 往返测试：所有合法规范值再次解析后保持完全一致。
const utcRoundTripValues = [
  '0001-01-01T00:00:00Z',
  '2000-02-29T12:34:56Z',
  '2024-12-31T23:59:59Z',
  '9999-12-31T23:59:59Z'
];
utcRoundTripValues.forEach((value) => {
  // 规范值：第一次解析的输出作为第二次解析输入。
  const normalizedValue = normalizeStrictUtcDateTime(value);
  assert.equal(normalizeStrictUtcDateTime(normalizedValue), value);
});

// 分钟模型测试：明确区分午夜 0 与清空 null。
assert.equal(MINUTES_PER_DAY, 1440);
assert.equal(isMinuteOfDay(0), true);
assert.equal(isMinuteOfDay(1439), true);
assert.equal(isMinuteOfDay(-1), false);
assert.equal(isMinuteOfDay(1440), false);
assert.equal(isMinuteOfDay(1.5), false);
assert.equal(isMinuteOfDay('60'), false);
assert.equal(formatMinutesAsTimeOfDay(null), '');
assert.equal(formatMinutesAsTimeOfDay(undefined), '');
assert.equal(formatMinutesAsTimeOfDay(0), '00:00');
assert.equal(formatMinutesAsTimeOfDay(59), '00:59');
assert.equal(formatMinutesAsTimeOfDay(60), '01:00');
assert.equal(formatMinutesAsTimeOfDay(1439), '23:59');
assert.equal(formatMinutesAsTimeOfDay(-1), null);
assert.equal(formatMinutesAsTimeOfDay(1440), null);
assert.equal(formatMinutesAsTimeOfDay(2.5), null);

// HH:mm 解析测试：清空统一为 null，合法时间转换为整数分钟。
assert.deepEqual(parseTimeOfDayToMinutes(null), { valid: true, value: null, cleared: true, code: null, message: null });
assert.deepEqual(parseTimeOfDayToMinutes(undefined), { valid: true, value: null, cleared: true, code: null, message: null });
assert.deepEqual(parseTimeOfDayToMinutes(''), { valid: true, value: null, cleared: true, code: null, message: null });
assert.deepEqual(parseTimeOfDayToMinutes('00:00'), { valid: true, value: 0, cleared: false, code: null, message: null });
assert.deepEqual(parseTimeOfDayToMinutes('23:59'), { valid: true, value: 1439, cleared: false, code: null, message: null });
assertInvalidTime(0, 'type');
assertInvalidTime('0:00', 'format');
assertInvalidTime('00:00 ', 'format');
assertInvalidTime('24:00', 'hour-range');
assertInvalidTime('23:60', 'minute-range');
assertInvalidTime('12:34:00', 'format');

// 分钟往返测试：覆盖完整 0 至 1439 范围，确保没有边界漂移。
for (let minuteOfDay = 0; minuteOfDay < MINUTES_PER_DAY; minuteOfDay += 1) {
  // 时间字符串：由分钟模型生成后必须严格解析回原整数。
  const timeText = formatMinutesAsTimeOfDay(minuteOfDay);
  // 解析结果：用于核对完整范围的双向转换。
  const parsedTime = parseTimeOfDayToMinutes(timeText);
  assert.equal(parsedTime.valid, true);
  assert.equal(parsedTime.value, minuteOfDay);
  assert.equal(parsedTime.cleared, false);
}

console.log('dateTimeFields.test.mjs passed');
