// 严格 UTC 日期时间字段模块：集中处理不依赖浏览器本地时区的字符串校验与规范化。

// 严格 UTC 日期时间正则：允许秒精度，或仅允许可无损规范化的三位毫秒。
export const STRICT_UTC_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

// 每日分钟数：用于限制 0 至 1439 的分钟模型范围。
export const MINUTES_PER_DAY = 1440;

// 每小时分钟数：用于分钟模型与 HH:mm 字符串互转。
const MINUTES_PER_HOUR = 60;

// 常规月份天数：闰年二月由方法单独修正。
const DAYS_PER_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

// 时间字符串正则：严格要求 24 小时制 HH:mm。
const TIME_OF_DAY_PATTERN = /^(\d{2}):(\d{2})$/;

// 方法模块：日历校验。

/**
 * 判断公历年份是否为闰年。
 * @param {number} year 年份。
 * @returns {boolean} 是否为闰年。
 */
export function isGregorianLeapYear(year) {
  return Number.isInteger(year) && year > 0 && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
}

/**
 * 返回指定公历年月的实际天数。
 * @param {number} year 年份。
 * @param {number} month 月份，范围 1 至 12。
 * @returns {number|null} 月份天数；年月非法时返回 null。
 */
export function daysInGregorianMonth(year, month) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (month === 2 && isGregorianLeapYear(year)) return 29;
  return DAYS_PER_MONTH[month - 1];
}

// 方法模块：严格 UTC 日期时间。

/**
 * 创建统一的 UTC 日期时间校验失败结果。
 * @param {string} code 失败编码。
 * @param {string} message 可读错误消息。
 * @returns {{ valid: false, value: null, parts: null, hadZeroMilliseconds: false, code: string, message: string }} 失败结果。
 */
function createUtcFailure(code, message) {
  return { valid: false, value: null, parts: null, hadZeroMilliseconds: false, code, message };
}

/**
 * 严格解析 UTC 日期时间字符串，不使用 Date、Date.parse 或本地时区换算。
 * @param {unknown} value 待解析值。
 * @returns {{ valid: boolean, value: string|null, parts: object|null, hadZeroMilliseconds: boolean, code: string|null, message: string|null }} 解析结果。
 */
export function parseStrictUtcDateTime(value) {
  if (typeof value !== 'string') return createUtcFailure('type', 'UTC 日期时间必须是字符串。');

  // 匹配结果：严格保留输入字符，不自动 trim，避免接受隐藏空白。
  const match = STRICT_UTC_DATE_TIME_PATTERN.exec(value);
  if (!match) return createUtcFailure('format', 'UTC 日期时间必须使用 YYYY-MM-DDTHH:mm:ssZ 格式。');

  // 日期时间分量：直接按十进制读取，不经过浏览器日期对象。
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7]);

  if (year < 1 || year > 9999) return createUtcFailure('year-range', 'UTC 年份必须在 0001 至 9999 之间。');
  if (month < 1 || month > 12) return createUtcFailure('month-range', 'UTC 月份必须在 01 至 12 之间。');

  // 月份天数：按公历闰年规则校验真实日期。
  const maximumDay = daysInGregorianMonth(year, month);
  if (day < 1 || day > maximumDay) return createUtcFailure('day-range', 'UTC 日期不是有效的公历日期。');
  if (hour < 0 || hour > 23) return createUtcFailure('hour-range', 'UTC 小时必须在 00 至 23 之间。');
  if (minute < 0 || minute > 59) return createUtcFailure('minute-range', 'UTC 分钟必须在 00 至 59 之间。');
  if (second < 0 || second > 59) return createUtcFailure('second-range', 'UTC 秒必须在 00 至 59 之间。');
  if (millisecond !== 0) return createUtcFailure('millisecond-precision', 'UTC 日期时间仅支持秒精度，非零毫秒不能被截断。');

  // 规范值：零毫秒与秒精度表示同一时刻，因此统一为秒精度字符串。
  const normalizedValue = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  // 分量对象：供调用方在不重新解析字符串的情况下读取字段。
  const parts = Object.freeze({ year, month, day, hour, minute, second, millisecond });

  return {
    valid: true,
    value: normalizedValue,
    parts,
    hadZeroMilliseconds: match[7] !== undefined,
    code: null,
    message: null
  };
}

/**
 * 判断值是否为本模块支持的严格 UTC 日期时间。
 * @param {unknown} value 待判断值。
 * @returns {boolean} 是否有效。
 */
export function isStrictUtcDateTime(value) {
  return parseStrictUtcDateTime(value).valid;
}

/**
 * 将有效 UTC 日期时间规范为秒精度；非法值返回 null，且不会截断非零毫秒。
 * @param {unknown} value 待规范化值。
 * @returns {string|null} 秒精度 UTC 字符串或 null。
 */
export function normalizeStrictUtcDateTime(value) {
  // 解析结果：保留失败状态，避免依赖异常控制常规表单流程。
  const result = parseStrictUtcDateTime(value);
  return result.valid ? result.value : null;
}

// 方法模块：日内分钟字段。

/**
 * 判断值是否为 0 至 1439 的整数分钟。
 * @param {unknown} value 待判断值。
 * @returns {boolean} 是否为有效日内分钟。
 */
export function isMinuteOfDay(value) {
  return Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;
}

/**
 * 将 0 至 1439 的分钟模型格式化为 HH:mm。
 * @param {unknown} value 分钟模型；null 或 undefined 表示清空。
 * @returns {string|null} HH:mm、空字符串或非法值对应的 null。
 */
export function formatMinutesAsTimeOfDay(value) {
  if (value === null || value === undefined) return '';
  if (!isMinuteOfDay(value)) return null;

  // 小时分量：按整小时向下取整。
  const hour = Math.floor(value / MINUTES_PER_HOUR);
  // 分钟分量：保留当前小时内的余数。
  const minute = value % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 严格解析 HH:mm；null、undefined 和空字符串都明确表示清空并返回 null。
 * @param {unknown} value 待解析值。
 * @returns {{ valid: boolean, value: number|null, cleared: boolean, code: string|null, message: string|null }} 解析结果。
 */
export function parseTimeOfDayToMinutes(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, value: null, cleared: true, code: null, message: null };
  }
  if (typeof value !== 'string') {
    return { valid: false, value: null, cleared: false, code: 'type', message: '日内时间必须是 HH:mm 字符串。' };
  }

  // 匹配结果：不 trim 输入，确保显示、输入和接口契约完全一致。
  const match = TIME_OF_DAY_PATTERN.exec(value);
  if (!match) {
    return { valid: false, value: null, cleared: false, code: 'format', message: '日内时间必须使用 HH:mm 格式。' };
  }

  // 时间分量：仅接受 24 小时制范围。
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23) {
    return { valid: false, value: null, cleared: false, code: 'hour-range', message: '小时必须在 00 至 23 之间。' };
  }
  if (minute < 0 || minute > 59) {
    return { valid: false, value: null, cleared: false, code: 'minute-range', message: '分钟必须在 00 至 59 之间。' };
  }

  // 分钟模型：从当天零点开始计数，范围固定为 0 至 1439。
  const minuteOfDay = hour * MINUTES_PER_HOUR + minute;
  return { valid: true, value: minuteOfDay, cleared: false, code: null, message: null };
}
