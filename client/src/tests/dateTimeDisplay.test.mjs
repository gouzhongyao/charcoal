import assert from 'node:assert/strict';
import {
  formatSourceWallClockDisplay,
  formatStrictUtcDateTimeDisplay
} from '../utils/dateTimeDisplay.js';

// 严格 UTC 展示模块：保持原始 UTC 钟面，不依赖运行环境本地时区。
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03Z'), '2026-08-27 01:02:03');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03.000Z'), '2026-08-27 01:02:03');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03.987Z'), '2026-08-27 01:02:03');
assert.equal(formatStrictUtcDateTimeDisplay('2024-02-29T23:59:59Z'), '2024-02-29 23:59:59');
assert.equal(formatStrictUtcDateTimeDisplay('2023-02-29T01:02:03Z'), '2023-02-29T01:02:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('1900-02-29T01:02:03Z'), '1900-02-29T01:02:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('2000-02-29T01:02:03Z'), '2000-02-29 01:02:03');
assert.equal(formatStrictUtcDateTimeDisplay('2026-04-31T01:02:03Z'), '2026-04-31T01:02:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-13-01T01:02:03Z'), '2026-13-01T01:02:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T24:02:03Z'), '2026-08-27T24:02:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:60:03Z'), '2026-08-27T01:60:03Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:60Z'), '2026-08-27T01:02:60Z');
assert.equal(formatStrictUtcDateTimeDisplay('0000-01-01T00:00:00Z'), '0000-01-01T00:00:00Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03.12Z'), '2026-08-27T01:02:03.12Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03.1234Z'), '2026-08-27T01:02:03.1234Z');
assert.equal(formatStrictUtcDateTimeDisplay('2026-08-27T01:02:03+08:00'), '2026-08-27T01:02:03+08:00');
assert.equal(formatStrictUtcDateTimeDisplay(null), '—');
assert.equal(formatStrictUtcDateTimeDisplay('', '尚未成功更新'), '尚未成功更新');

// 来源墙钟展示模块：不追加 Z、不转换时区，只补齐用户可见秒。
assert.equal(formatSourceWallClockDisplay('2026-08-27T09:10'), '2026-08-27 09:10:00');
assert.equal(formatSourceWallClockDisplay('2024-02-29T09:10'), '2024-02-29 09:10:00');
assert.equal(formatSourceWallClockDisplay('2023-02-29T09:10'), '2023-02-29T09:10');
assert.equal(formatSourceWallClockDisplay('2026-04-31T09:10'), '2026-04-31T09:10');
assert.equal(formatSourceWallClockDisplay('2026-08-27T24:10'), '2026-08-27T24:10');
assert.equal(formatSourceWallClockDisplay('2026-08-27T09:60'), '2026-08-27T09:60');
assert.equal(formatSourceWallClockDisplay('2026-08-27 09:10'), '2026-08-27 09:10');
assert.equal(formatSourceWallClockDisplay(undefined), '—');
assert.equal(formatSourceWallClockDisplay('', '-'), '-');

console.log('dateTimeDisplay tests passed');
