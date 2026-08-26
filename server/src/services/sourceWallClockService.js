'use strict';

const { badRequest } = require('../utils/errors');

// 来源墙钟只接受无秒、无时区后缀的整分钟文本。
const STRICT_WALL_CLOCK_MINUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
// IANA 来源时区必须包含区域与地点分段；Etc/UTC 合法，裸 UTC 拒绝。
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)+$/;
// 时区 offset 候选缓存按来源时区和墙钟日期复用，避免批量导入重复扫描。
const TIME_ZONE_OFFSET_CACHE = new Map();
// Intl formatter 按来源时区复用，并固定拉丁数字和 24 小时制。
const TIME_ZONE_FORMATTER_CACHE = new Map();
// offset 扫描覆盖目标墙钟前后 48 小时，能够同时观察 DST 切换前后的候选偏移量。
const OFFSET_SCAN_RANGE_HOURS = 48;
// 每 3 小时采样一次偏移量，兼顾历史半小时切换与批量导入性能。
const OFFSET_SCAN_STEP_HOURS = 3;

/**
 * 创建不会触发 Date.UTC 对 0—99 年特殊映射的 UTC 日期。
 * @param {number} year 年。
 * @param {number} month 月。
 * @param {number} day 日。
 * @param {number} hour 时。
 * @param {number} minute 分。
 * @returns {Date} UTC 日期。
 */
function createUtcDate(year, month, day, hour, minute) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

/**
 * 严格解析真实日历中的 YYYY-MM-DDTHH:mm 来源墙钟。
 * @param {*} value 待解析值。
 * @returns {{text:string,year:number,month:number,day:number,hour:number,minute:number,naiveUtcMs:number}|null} 解析结果。
 */
function parseStrictWallClockMinute(value) {
  if (typeof value !== 'string') return null;
  const matched = STRICT_WALL_CLOCK_MINUTE_PATTERN.exec(value);
  if (!matched) return null;
  const parts = matched.slice(1).map(Number);
  const [year, month, day, hour, minute] = parts;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = createUtcDate(year, month, day, hour, minute);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute) return null;
  return {
    text: value,
    year,
    month,
    day,
    hour,
    minute,
    naiveUtcMs: date.getTime()
  };
}

/**
 * 判断值是否为严格、真实且精确到分钟的来源墙钟。
 * @param {*} value 待校验值。
 * @returns {boolean} 是否有效。
 */
function isStrictWallClockMinute(value) {
  return Boolean(parseStrictWallClockMinute(value));
}

/**
 * 判断值是否为项目允许的 IANA 时区。
 * @param {*} value 待校验值。
 * @returns {boolean} 是否有效。
 */
function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || !IANA_TIME_ZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 获取指定 IANA 时区的稳定墙钟格式化器。
 * @param {string} timeZone IANA 时区。
 * @returns {Intl.DateTimeFormat} 格式化器。
 */
function getTimeZoneFormatter(timeZone) {
  if (!TIME_ZONE_FORMATTER_CACHE.has(timeZone)) {
    TIME_ZONE_FORMATTER_CACHE.set(timeZone, new Intl.DateTimeFormat('en-CA-u-nu-latn', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }));
  }
  return TIME_ZONE_FORMATTER_CACHE.get(timeZone);
}

/**
 * 把 UTC 瞬间投影为指定来源时区的墙钟字段。
 * @param {number} utcMs UTC 毫秒。
 * @param {string} timeZone IANA 时区。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number}} 墙钟字段。
 */
function formatUtcAsWallClockParts(utcMs, timeZone) {
  const values = {};
  getTimeZoneFormatter(timeZone).formatToParts(new Date(utcMs)).forEach((part) => {
    if (['year', 'month', 'day', 'hour', 'minute'].includes(part.type)) {
      values[part.type] = Number(part.value);
    }
  });
  return values;
}

/**
 * 计算指定 UTC 瞬间在来源时区中的分钟偏移量。
 * @param {number} utcMs UTC 毫秒。
 * @param {string} timeZone IANA 时区。
 * @returns {number} 来源墙钟相对 UTC 的分钟偏移量。
 */
function getUtcOffsetMinutes(utcMs, timeZone) {
  const parts = formatUtcAsWallClockParts(utcMs, timeZone);
  const projectedUtcMs = createUtcDate(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute
  ).getTime();
  const minuteUtcMs = Math.trunc(utcMs / 60000) * 60000;
  return Math.round((projectedUtcMs - minuteUtcMs) / 60000);
}

/**
 * 读取目标日期附近所有可观察到的时区 offset。
 * @param {object} parsedWallClock 已解析墙钟。
 * @param {string} timeZone IANA 时区。
 * @returns {number[]} 唯一 offset 列表。
 */
function getCandidateOffsets(parsedWallClock, timeZone) {
  const cacheKey = `${timeZone}|${parsedWallClock.text.slice(0, 10)}`;
  if (TIME_ZONE_OFFSET_CACHE.has(cacheKey)) return TIME_ZONE_OFFSET_CACHE.get(cacheKey);
  const offsets = new Set();
  for (let hourDelta = -OFFSET_SCAN_RANGE_HOURS;
    hourDelta <= OFFSET_SCAN_RANGE_HOURS;
    hourDelta += OFFSET_SCAN_STEP_HOURS) {
    offsets.add(getUtcOffsetMinutes(parsedWallClock.naiveUtcMs + hourDelta * 3600000, timeZone));
  }
  const result = Object.freeze([...offsets].sort((left, right) => left - right));
  TIME_ZONE_OFFSET_CACHE.set(cacheKey, result);
  return result;
}

/**
 * 判断 UTC 候选投影后是否与目标来源墙钟完全一致。
 * @param {number} utcMs UTC 候选毫秒。
 * @param {object} parsedWallClock 已解析墙钟。
 * @param {string} timeZone IANA 时区。
 * @returns {boolean} 是否精确匹配。
 */
function doesUtcCandidateMatch(utcMs, parsedWallClock, timeZone) {
  const parts = formatUtcAsWallClockParts(utcMs, timeZone);
  return parts.year === parsedWallClock.year
    && parts.month === parsedWallClock.month
    && parts.day === parsedWallClock.day
    && parts.hour === parsedWallClock.hour
    && parts.minute === parsedWallClock.minute;
}

/**
 * 将唯一有效的来源墙钟转换为严格 UTC 整分钟文本；DST gap/fold 均拒绝。
 * @param {*} wallClock 来源墙钟。
 * @param {*} timeZone IANA 来源时区。
 * @returns {string} YYYY-MM-DDTHH:mm:00Z。
 */
function convertSourceWallClockToUtc(wallClock, timeZone) {
  const parsedWallClock = parseStrictWallClockMinute(wallClock);
  if (!parsedWallClock) {
    throw badRequest('来源时间必须是有效且精确到分钟的 YYYY-MM-DDTHH:mm 墙钟时间。', {
      code: 'SOURCE_WALL_CLOCK_MINUTE_INVALID'
    });
  }
  if (!isValidIanaTimezone(timeZone)) {
    throw badRequest('来源时区必须是项目允许的 IANA 时区。', {
      code: 'SOURCE_TIMEZONE_INVALID'
    });
  }
  const candidates = getCandidateOffsets(parsedWallClock, timeZone)
    .map((offsetMinutes) => parsedWallClock.naiveUtcMs - offsetMinutes * 60000)
    .filter((utcMs) => doesUtcCandidateMatch(utcMs, parsedWallClock, timeZone));
  const uniqueCandidates = [...new Set(candidates)].sort((left, right) => left - right);
  if (uniqueCandidates.length === 0) {
    throw badRequest('来源时间落在夏令时跳时空洞中，无法唯一转换为 UTC。', {
      code: 'SOURCE_WALL_CLOCK_DST_GAP'
    });
  }
  if (uniqueCandidates.length > 1) {
    throw badRequest('来源时间落在夏令时重复时段中，无法唯一转换为 UTC。', {
      code: 'SOURCE_WALL_CLOCK_DST_FOLD'
    });
  }
  return new Date(uniqueCandidates[0]).toISOString().replace('.000Z', 'Z');
}

/**
 * 转换并校验来源墙钟半开区间 [start,end)。
 * @param {*} startWallClock 开始墙钟。
 * @param {*} endWallClock 结束墙钟。
 * @param {*} timeZone IANA 来源时区。
 * @returns {{startUtc:string,endUtc:string}} UTC 区间。
 */
function convertSourceWallClockRangeToUtc(startWallClock, endWallClock, timeZone) {
  const startUtc = convertSourceWallClockToUtc(startWallClock, timeZone);
  const endUtc = convertSourceWallClockToUtc(endWallClock, timeZone);
  if (Date.parse(startUtc) >= Date.parse(endUtc)) {
    throw badRequest('活动时间必须满足 startUtc < endUtc。', {
      code: 'SOURCE_WALL_CLOCK_RANGE_INVALID'
    });
  }
  return { startUtc, endUtc };
}

module.exports = {
  IANA_TIME_ZONE_PATTERN,
  STRICT_WALL_CLOCK_MINUTE_PATTERN,
  convertSourceWallClockRangeToUtc,
  convertSourceWallClockToUtc,
  isStrictWallClockMinute,
  isValidIanaTimezone,
  parseStrictWallClockMinute
};
