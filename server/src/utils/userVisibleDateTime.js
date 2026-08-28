'use strict';

// 用户可见严格 UTC 日期时间采用空格分隔且固定到秒。
const USER_VISIBLE_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// 历史严格 UTC 输入仅兼容 Z 后缀和可无损折叠的三位毫秒。
const STRICT_UTC_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
// 用户可见来源墙钟日期时间采用空格分隔并显式补零秒。
const USER_VISIBLE_WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// 内部来源墙钟合同继续保持 T 分隔的分钟精度。
const INTERNAL_WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** 创建携带稳定错误码的日期时间格式错误。 */
function createDateTimeFormatError(code, message, rawValue) {
  // 格式错误对象只携带安全原值，不执行任何时区推断。
  const error = new TypeError(message);
  error.code = code;
  error.rawValue = rawValue;
  return error;
}

/** 创建不受 JavaScript 0 至 99 年特殊规则影响的 UTC 日历值。 */
function createUtcCalendarDate(year, month, day, hour, minute, second) {
  // UTC 日期仅用于日历分量校验，不代表对来源墙钟执行时区转换。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

/** 校验已由正则拆分的日期时间分量是否属于真实日历。 */
function isValidDateTimeParts(parts) {
  // 数值分量顺序固定为年、月、日、时、分、秒。
  const [year, month, day, hour, minute, second] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59
    || second < 0 || second > 59) {
    return false;
  }
  // UTC 分量回读只用于阻止日期溢出被静默修复。
  const date = createUtcCalendarDate(year, month, day, hour, minute, second);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

/** 把正则结果中的六个日期时间分量拼接为用户可见格式。 */
function buildUserVisibleDateTime(matched) {
  return `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}`;
}

/** 把正则结果中的六个日期时间分量拼接为内部严格 UTC 格式。 */
function buildStrictUtcDateTime(matched) {
  return `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6]}Z`;
}

/** 把正则结果中的五个日期时间分量拼接为内部墙钟分钟格式。 */
function buildInternalWallClock(matched) {
  return `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}`;
}

/** 严格格式化 UTC 技术值，不基于服务器本地时区换算。 */
function formatStrictUtcForUser(value) {
  if (value === null || value === undefined || value === '') return '';
  // 内部 UTC 文本必须明确携带 Z，允许审计时间保留的三位毫秒仅在展示时隐藏。
  const text = String(value).trim();
  const matched = STRICT_UTC_INPUT_PATTERN.exec(text);
  if (!matched || !isValidDateTimeParts(matched.slice(1, 7))) {
    throw createDateTimeFormatError(
      'STRICT_UTC_DISPLAY_VALUE_INVALID',
      '用户可见 UTC 输出只接受有效的 YYYY-MM-DDTHH:mm:ssZ 或三位毫秒 Z 时间。',
      value
    );
  }
  return buildUserVisibleDateTime(matched);
}

/** 解析用户可见或历史严格 UTC 输入并归一化为秒精度 Z 合同。 */
function normalizeUserVisibleStrictUtcInput(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  // 输入文本仅按显式 UTC 列语义解释，空格格式不经过 Date 本地时区解析。
  const text = String(value).trim();
  const visibleMatched = USER_VISIBLE_UTC_PATTERN.exec(text);
  if (visibleMatched) {
    if (!isValidDateTimeParts(visibleMatched.slice(1, 7))) {
      throw createDateTimeFormatError('STRICT_UTC_INPUT_INVALID', 'UTC 时间不是有效的日历日期时间。', value);
    }
    return buildStrictUtcDateTime(visibleMatched);
  }
  // 历史 ISO 输入继续兼容，但非零毫秒不得静默丢失。
  const isoMatched = STRICT_UTC_INPUT_PATTERN.exec(text);
  if (!isoMatched || !isValidDateTimeParts(isoMatched.slice(1, 7))) {
    throw createDateTimeFormatError(
      'STRICT_UTC_INPUT_INVALID',
      'UTC 时间必须使用 YYYY-MM-DD HH:mm:ss 或历史 YYYY-MM-DDTHH:mm:ssZ 格式。',
      value
    );
  }
  if (isoMatched[7] && isoMatched[7] !== '000') {
    throw createDateTimeFormatError(
      'STRICT_UTC_INPUT_PRECISION_INVALID',
      'UTC 导入只允许秒精度；历史毫秒格式仅兼容 .000Z。',
      value
    );
  }
  return buildStrictUtcDateTime(isoMatched);
}

/** 格式化内部来源墙钟分钟值，保持墙钟分量并补零秒。 */
function formatWallClockMinuteForUser(value) {
  if (value === null || value === undefined || value === '') return '';
  // 墙钟显示禁止调用 Date 或 Intl，避免把来源墙钟误当 UTC 或服务器本地时间。
  const text = String(value).trim();
  const matched = INTERNAL_WALL_CLOCK_PATTERN.exec(text);
  if (!matched || !isValidDateTimeParts([...matched.slice(1, 6), '00'])) {
    throw createDateTimeFormatError(
      'WALL_CLOCK_DISPLAY_VALUE_INVALID',
      '用户可见来源墙钟输出只接受有效的 YYYY-MM-DDTHH:mm 内部值。',
      value
    );
  }
  return `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:00`;
}

/** 解析用户可见或历史墙钟输入并归一化为内部分钟合同。 */
function normalizeUserVisibleWallClockMinuteInput(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  // 历史 T 分钟格式继续兼容并保持原分量。
  const text = String(value).trim();
  const internalMatched = INTERNAL_WALL_CLOCK_PATTERN.exec(text);
  if (internalMatched) {
    if (!isValidDateTimeParts([...internalMatched.slice(1, 6), '00'])) {
      throw createDateTimeFormatError('WALL_CLOCK_INPUT_INVALID', '来源墙钟不是有效的日历日期时间。', value);
    }
    return buildInternalWallClock(internalMatched);
  }
  // 新用户格式必须显式携带零秒，非零秒单独返回稳定精度错误。
  const visibleMatched = USER_VISIBLE_WALL_CLOCK_PATTERN.exec(text);
  if (!visibleMatched || !isValidDateTimeParts(visibleMatched.slice(1, 7))) {
    throw createDateTimeFormatError(
      'WALL_CLOCK_INPUT_INVALID',
      '来源墙钟必须使用 YYYY-MM-DD HH:mm:00 或历史 YYYY-MM-DDTHH:mm 格式。',
      value
    );
  }
  if (visibleMatched[6] !== '00') {
    throw createDateTimeFormatError(
      'WALL_CLOCK_INPUT_SECOND_MUST_BE_ZERO',
      '来源墙钟仅支持分钟精度，秒必须为 00。',
      value
    );
  }
  return buildInternalWallClock(visibleMatched);
}

module.exports = {
  INTERNAL_WALL_CLOCK_PATTERN,
  STRICT_UTC_INPUT_PATTERN,
  USER_VISIBLE_UTC_PATTERN,
  USER_VISIBLE_WALL_CLOCK_PATTERN,
  formatStrictUtcForUser,
  formatWallClockMinuteForUser,
  normalizeUserVisibleStrictUtcInput,
  normalizeUserVisibleWallClockMinuteInput
};
