// 用户可见日期时间展示模块：严格 UTC 与来源时区墙钟分别按字面分量格式化，不执行浏览器时区换算。

// 严格 UTC 展示格式：与后端展示合同一致，仅兼容无毫秒或三位毫秒，非零毫秒只在展示时隐藏。
const STRICT_UTC_DISPLAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/;
// 来源墙钟展示格式：来源值按既有分钟精度保存，不附加 Z，也不转换时区。
const SOURCE_WALL_CLOCK_DISPLAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
// 各月份基础天数：下标与自然月一致，二月闰日由公历规则单独处理。
const DAYS_IN_MONTH = Object.freeze([0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/** 返回空时间值对应的展示占位符。 */
function displayFallback(value, fallback) {
  return value === null || value === undefined || value === '' ? fallback : null;
}

/** 判断指定年份是否为严格公历闰年。 */
function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** 校验日期时间分量是否属于真实公历并落在合法时分秒范围内。 */
function isValidDateTimeParts(parts) {
  // 数值分量顺序固定为年、月、日、时、分、秒。
  const [year, month, day, hour, minute, second] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1
    || hour < 0 || hour > 23 || minute < 0 || minute > 59
    || second < 0 || second > 59) {
    return false;
  }
  // 二月按严格公历闰年规则扩展一天，其余月份使用固定天数。
  const maximumDay = month === 2 && isGregorianLeapYear(year) ? 29 : DAYS_IN_MONTH[month];
  return day <= maximumDay;
}

/**
 * 格式化严格 UTC 日期时间，保留 UTC 原始钟面并固定显示秒。
 * @param {unknown} value 严格 UTC 字符串。
 * @param {string} fallback 空值展示文本。
 * @returns {string} YYYY-MM-DD HH:mm:ss，非法非空值原样返回以便追溯。
 */
export function formatStrictUtcDateTimeDisplay(value, fallback = '—') {
  const emptyText = displayFallback(value, fallback);
  if (emptyText !== null) return emptyText;
  if (typeof value !== 'string') return String(value);
  const match = STRICT_UTC_DISPLAY_PATTERN.exec(value);
  return match && isValidDateTimeParts(match.slice(1, 7))
    ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`
    : value;
}

/**
 * 格式化来源时区墙钟值，保留墙钟分量并补齐显示秒 00。
 * @param {unknown} value YYYY-MM-DDTHH:mm 来源墙钟字符串。
 * @param {string} fallback 空值展示文本。
 * @returns {string} YYYY-MM-DD HH:mm:00，非法非空值原样返回以便追溯。
 */
export function formatSourceWallClockDisplay(value, fallback = '—') {
  const emptyText = displayFallback(value, fallback);
  if (emptyText !== null) return emptyText;
  if (typeof value !== 'string') return String(value);
  const match = SOURCE_WALL_CLOCK_DISPLAY_PATTERN.exec(value);
  return match && isValidDateTimeParts([...match.slice(1, 6), '00'])
    ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:00`
    : value;
}
