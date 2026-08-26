'use strict';

const assert = require('assert');
const {
  convertSourceWallClockRangeToUtc,
  convertSourceWallClockToUtc,
  isStrictWallClockMinute,
  isValidIanaTimezone
} = require('../services/sourceWallClockService');

/** 断言稳定领域错误码。 */
function assertErrorCode(action, expectedCode, message) {
  assert.throws(action, (error) => error?.details?.code === expectedCode, message);
}

assert.strictEqual(isStrictWallClockMinute('2026-08-24T09:05'), true);
assert.strictEqual(isStrictWallClockMinute('2026-02-29T09:05'), false);
assert.strictEqual(isStrictWallClockMinute('2024-02-29T09:05'), true);
[
  '2026-08-24T09:05:00',
  '2026-08-24T09:05Z',
  '2026-08-24T09:05+08:00',
  ' 2026-08-24T09:05',
  '2026-08-24 09:05',
  '2026-13-01T00:00',
  '2026-01-01T24:00'
].forEach((value) => assert.strictEqual(isStrictWallClockMinute(value), false, `${value} 必须被拒绝。`));

assert.strictEqual(isValidIanaTimezone('Asia/Shanghai'), true);
assert.strictEqual(isValidIanaTimezone('Etc/UTC'), true);
assert.strictEqual(isValidIanaTimezone('UTC'), false);
assert.strictEqual(isValidIanaTimezone('Invalid/Timezone'), false);

assert.strictEqual(
  convertSourceWallClockToUtc('2026-08-24T09:05', 'Asia/Shanghai'),
  '2026-08-24T01:05:00Z'
);
assert.strictEqual(
  convertSourceWallClockToUtc('2026-08-24T09:05', 'Etc/UTC'),
  '2026-08-24T09:05:00Z'
);
assert.deepStrictEqual(
  convertSourceWallClockRangeToUtc('2026-08-24T09:05', '2026-08-24T10:35', 'Asia/Shanghai'),
  { startUtc: '2026-08-24T01:05:00Z', endUtc: '2026-08-24T02:35:00Z' }
);

assertErrorCode(
  () => convertSourceWallClockToUtc('2026-03-08T02:30', 'America/New_York'),
  'SOURCE_WALL_CLOCK_DST_GAP',
  'DST gap 必须拒绝。'
);
assertErrorCode(
  () => convertSourceWallClockToUtc('2026-11-01T01:30', 'America/New_York'),
  'SOURCE_WALL_CLOCK_DST_FOLD',
  'DST fold 必须拒绝。'
);
assertErrorCode(
  () => convertSourceWallClockToUtc('2026-08-24T09:05Z', 'Asia/Shanghai'),
  'SOURCE_WALL_CLOCK_MINUTE_INVALID',
  '带 Z 的来源墙钟必须拒绝。'
);
assertErrorCode(
  () => convertSourceWallClockToUtc('2026-08-24T09:05', 'UTC'),
  'SOURCE_TIMEZONE_INVALID',
  '裸 UTC 必须拒绝。'
);
assertErrorCode(
  () => convertSourceWallClockRangeToUtc('2026-08-24T10:00', '2026-08-24T10:00', 'Asia/Shanghai'),
  'SOURCE_WALL_CLOCK_RANGE_INVALID',
  '空区间必须拒绝。'
);
assertErrorCode(
  () => convertSourceWallClockRangeToUtc('2026-08-24T11:00', '2026-08-24T10:00', 'Asia/Shanghai'),
  'SOURCE_WALL_CLOCK_RANGE_INVALID',
  '逆序区间必须拒绝。'
);

console.log('sourceWallClockService tests passed');
