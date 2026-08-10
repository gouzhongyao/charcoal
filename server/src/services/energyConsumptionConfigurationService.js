'use strict';

const database = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  SUPPORTED_FORMULA_VERSION,
  SUPPORTED_METRIC_CODES,
  insertOperationLogWithDb,
  parseEvidenceRequirements
} = require('./energyStrategyEvaluationService');

// 配置列表单次最多返回的记录数量，避免本地接口无界读取。
const CONFIGURATION_QUERY_LIMIT = 200;
// 配置状态白名单，停用代替物理删除。
const CONFIGURATION_STATUSES = Object.freeze(['active', 'inactive']);
// 峰平谷周期类型白名单。
const TOU_PERIOD_TYPES = Object.freeze(['peak', 'flat', 'valley']);
// 策略阈值操作符白名单，禁止配置动态表达式。
const STRATEGY_THRESHOLD_OPERATORS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'between']);
// 策略优先级白名单。
const STRATEGY_PRIORITIES = Object.freeze(['low', 'medium', 'high']);
// 严格 UTC ISO Z 时间格式。
const STRICT_UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 构造配置冲突错误。
 * @param {string} message 错误说明。
 * @param {object} details 安全错误详情。
 * @returns {AppError} 冲突错误。
 */
function conflict(message, details) {
  return new AppError('CONFIGURATION_CONFLICT', message, { statusCode: 409, details });
}

/**
 * 规范正整数主键。
 * @param {*} value 原始主键。
 * @param {string} fieldName 字段名。
 * @returns {number} 正整数主键。
 */
function normalizePositiveId(value, fieldName) {
  const normalizedText = typeof value === 'number' ? String(value) : value;
  if (typeof normalizedText !== 'string' || !/^\d+$/.test(normalizedText.trim())) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_CONFIGURATION_ID', field: fieldName });
  }
  const normalizedId = Number(normalizedText.trim());
  if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_CONFIGURATION_ID', field: fieldName });
  }
  return normalizedId;
}

/**
 * 规范必填短文本。
 * @param {*} value 原始文本。
 * @param {string} fieldName 字段名。
 * @param {number} maximumLength 最大长度。
 * @returns {string} 去空白文本。
 */
function normalizeRequiredText(value, fieldName, maximumLength = 200) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maximumLength) {
    throw badRequest(`${fieldName} 必须是长度不超过 ${maximumLength} 的非空字符串。`, {
      code: 'INVALID_CONFIGURATION_TEXT',
      field: fieldName,
      maximumLength
    });
  }
  return value.trim();
}

/**
 * 规范可选短文本。
 * @param {*} value 原始文本。
 * @param {string} fieldName 字段名。
 * @param {number} maximumLength 最大长度。
 * @returns {string|null} 去空白文本或空值。
 */
function normalizeOptionalText(value, fieldName, maximumLength = 200) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeRequiredText(value, fieldName, maximumLength);
}

/**
 * 规范有限数值。
 * @param {*} value 原始数值。
 * @param {string} fieldName 字段名。
 * @param {object} options 数值边界。
 * @returns {number} 有限数值。
 */
function normalizeFiniteNumber(value, fieldName, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`${fieldName} 必须是有限数值。`, { code: 'INVALID_CONFIGURATION_NUMBER', field: fieldName });
  }
  if (options.minimum !== undefined && value < options.minimum) {
    throw badRequest(`${fieldName} 不能小于 ${options.minimum}。`, { code: 'CONFIGURATION_NUMBER_OUT_OF_RANGE', field: fieldName });
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw badRequest(`${fieldName} 不能大于 ${options.maximum}。`, { code: 'CONFIGURATION_NUMBER_OUT_OF_RANGE', field: fieldName });
  }
  return value;
}

/**
 * 规范整数分钟。
 * @param {*} value 原始分钟数。
 * @param {string} fieldName 字段名。
 * @param {number} minimum 最小值。
 * @param {number} maximum 最大值。
 * @returns {number} 整数分钟。
 */
function normalizeMinute(value, fieldName, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw badRequest(`${fieldName} 必须是 ${minimum} 至 ${maximum} 的整数。`, {
      code: 'INVALID_CONFIGURATION_MINUTE',
      field: fieldName,
      minimum,
      maximum
    });
  }
  return value;
}

/**
 * 规范严格 UTC ISO Z 时间。
 * @param {*} value 原始时间。
 * @param {string} fieldName 字段名。
 * @returns {string} 规范时间。
 */
function normalizeStrictUtc(value, fieldName) {
  if (typeof value !== 'string' || !STRICT_UTC_ISO_PATTERN.test(value)) {
    throw badRequest(`${fieldName} 必须是严格 UTC ISO Z 时间。`, { code: 'INVALID_CONFIGURATION_UTC', field: fieldName });
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw badRequest(`${fieldName} 必须是有效 UTC 时间。`, { code: 'INVALID_CONFIGURATION_UTC', field: fieldName });
  }
  return value;
}

/**
 * 规范 IANA 来源时区。
 * @param {*} value 原始时区。
 * @returns {string} IANA 时区。
 */
function normalizeTimeZone(value) {
  const sourceTimeZone = normalizeRequiredText(value, 'sourceTimeZone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: sourceTimeZone }).format(new Date(0));
  } catch (_error) {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_CONFIGURATION_TIME_ZONE'
    });
  }
  return sourceTimeZone;
}

/**
 * 规范有效期并保证左边界早于右边界。
 * @param {*} startValue 原始开始时间。
 * @param {*} endValue 原始结束时间。
 * @returns {object} 有效期。
 */
function normalizeEffectiveRange(startValue, endValue) {
  const effectiveStartUtc = normalizeStrictUtc(startValue, 'effectiveStartUtc');
  const effectiveEndUtc = normalizeStrictUtc(endValue, 'effectiveEndUtc');
  if (Date.parse(effectiveStartUtc) >= Date.parse(effectiveEndUtc)) {
    throw badRequest('effectiveStartUtc 必须早于 effectiveEndUtc。', {
      code: 'INVALID_CONFIGURATION_EFFECTIVE_RANGE'
    });
  }
  return { effectiveStartUtc, effectiveEndUtc };
}

/**
 * 规范启停状态。
 * @param {*} value 原始状态。
 * @returns {string} active 或 inactive。
 */
function normalizeStatus(value) {
  if (!CONFIGURATION_STATUSES.includes(value)) {
    throw badRequest('status 只允许 active 或 inactive。', {
      code: 'INVALID_CONFIGURATION_STATUS',
      allowedValues: CONFIGURATION_STATUSES
    });
  }
  return value;
}

/**
 * 规范配置列表查询条件。
 * @param {*} input 原始查询。
 * @returns {object} 查询条件。
 */
function normalizeListInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('配置查询参数必须是对象。', { code: 'INVALID_CONFIGURATION_QUERY' });
  }
  return {
    status: input.status === undefined || input.status === '' ? null : normalizeStatus(input.status),
    code: input.code === undefined || input.code === '' ? null : normalizeRequiredText(input.code, 'code', 100)
  };
}

/**
 * 规范写操作审计选项。
 * @param {object} options 服务选项。
 * @returns {object} 审计上下文。
 */
function normalizeAuditOptions(options) {
  const actorUserId = isPlainObject(options) ? options.actorUserId : undefined;
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw badRequest('能源消费配置写操作必须提供有效正整数操作者。', {
      code: 'ENERGY_CONFIGURATION_AUDIT_ACTOR_REQUIRED',
      field: 'actorUserId'
    });
  }
  return {
    actorUserId,
    actorIp: isPlainObject(options) ? options.actorIp || null : null,
    auditWriter: isPlainObject(options) && typeof options.auditWriter === 'function'
      ? options.auditWriter
      : insertOperationLogWithDb
  };
}

/**
 * 使用当前 SQLite 连接完成业务写入和操作审计。
 * @param {object} options 服务选项。
 * @param {Function} action 事务内业务函数。
 * @returns {*} 业务结果。
 */
function executeAtomicConfigurationWrite(options, action) {
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  const shouldOwnTransaction = db.inTransaction !== true;
  const auditOptions = normalizeAuditOptions(options);
  let ownedTransactionActive = false;
  try {
    if (shouldOwnTransaction) {
      db.exec('BEGIN IMMEDIATE');
      ownedTransactionActive = true;
    }
    const operationResult = action(db);
    const operationLogId = auditOptions.auditWriter(db, {
      userId: auditOptions.actorUserId,
      operation: operationResult.audit.operation,
      targetType: operationResult.audit.targetType,
      targetId: operationResult.audit.targetId,
      detail: operationResult.audit.detail,
      ip: auditOptions.actorIp,
      createdAt: operationResult.audit.createdAt
    });
    if (ownedTransactionActive) {
      db.exec('COMMIT');
      ownedTransactionActive = false;
    }
    return {
      ...operationResult.value,
      audit: {
        atomic: true,
        operationLogId
      }
    };
  } catch (error) {
    if (ownedTransactionActive && db.inTransaction === true) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 回滚错误不能覆盖原始业务或审计错误。
      }
    }
    if (error && (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')) {
      throw conflict('配置编码和版本组合已存在。', { code: 'CONFIGURATION_VERSION_ALREADY_EXISTS' });
    }
    throw error;
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

/**
 * 在启用一个版本前停用同编码的其他版本。
 * @param {object} db SQLite 连接。
 * @param {string} tableName 固定表名。
 * @param {string} codeColumn 固定编码列名。
 * @param {string} code 编码。
 * @param {number|null} exceptId 排除 ID。
 * @param {string} nowUtc 更新时间。
 */
function deactivateSiblingVersions(db, tableName, codeColumn, code, exceptId, nowUtc) {
  const supportedTargets = {
    shift_definitions: 'shift_code',
    tou_schemes: 'scheme_code',
    strategy_rules: 'rule_code'
  };
  if (supportedTargets[tableName] !== codeColumn) {
    throw new Error('不支持的配置版本表。');
  }
  const exceptClause = exceptId === null ? '' : ' AND id <> @exceptId';
  const parameters = exceptId === null ? { code, nowUtc } : { code, exceptId, nowUtc };
  db.prepare(
    `UPDATE ${tableName}
        SET status = 'inactive', updated_at = @nowUtc
      WHERE ${codeColumn} = @code
        AND status = 'active'${exceptClause}`
  ).run(parameters);
}

/**
 * 映射排班定义行。
 * @param {object} row 数据库行。
 * @returns {object} 排班定义。
 */
function mapShiftRow(row) {
  return {
    id: Number(row.id),
    shiftCode: row.shiftCode,
    shiftName: row.shiftName,
    startMinute: Number(row.startMinute),
    endMinute: Number(row.endMinute),
    crossesMidnight: row.crossesMidnight === 1,
    sourceTimeZone: row.sourceTimeZone,
    source: row.source,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 查询单条排班定义。
 * @param {object} db SQLite 连接。
 * @param {number} shiftDefinitionId 排班定义 ID。
 * @returns {object|null} 排班定义。
 */
function getShiftDefinitionWithDb(db, shiftDefinitionId) {
  const row = db.prepare(
    `SELECT id, shift_code AS shiftCode, shift_name AS shiftName,
            start_minute AS startMinute, end_minute AS endMinute,
            crosses_midnight AS crossesMidnight, source_timezone AS sourceTimeZone,
            source, version, effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, status,
            created_at AS createdAt, updated_at AS updatedAt
       FROM shift_definitions
      WHERE id = ?`
  ).get(shiftDefinitionId);
  return row ? mapShiftRow(row) : null;
}

/**
 * 规范排班定义写入数据。
 * @param {*} input 原始输入。
 * @param {object|null} existing 现有版本。
 * @returns {object} 规范排班定义。
 */
function normalizeShiftDefinitionInput(input, existing = null) {
  if (!isPlainObject(input)) {
    throw badRequest('排班定义输入必须是对象。', { code: 'INVALID_SHIFT_DEFINITION_INPUT' });
  }
  const merged = existing ? { ...existing, ...input, shiftCode: existing.shiftCode } : input;
  const shiftCode = normalizeRequiredText(merged.shiftCode, 'shiftCode', 100);
  const shiftName = normalizeRequiredText(merged.shiftName, 'shiftName', 200);
  const startMinute = normalizeMinute(merged.startMinute, 'startMinute', 0, 1439);
  const endMinute = normalizeMinute(merged.endMinute, 'endMinute', 0, 1439);
  if (typeof merged.crossesMidnight !== 'boolean'
    && merged.crossesMidnight !== 0
    && merged.crossesMidnight !== 1) {
    throw badRequest('crossesMidnight 必须是布尔值。', { code: 'INVALID_SHIFT_CROSSES_MIDNIGHT' });
  }
  const crossesMidnight = typeof merged.crossesMidnight === 'boolean'
    ? merged.crossesMidnight
    : merged.crossesMidnight === 1;
  if ((crossesMidnight && startMinute <= endMinute) || (!crossesMidnight && startMinute >= endMinute)) {
    throw badRequest('排班起止分钟与跨日标记不一致。', { code: 'INVALID_SHIFT_TIME_RANGE' });
  }
  const effectiveRange = normalizeEffectiveRange(merged.effectiveStartUtc, merged.effectiveEndUtc);
  return {
    shiftCode,
    shiftName,
    startMinute,
    endMinute,
    crossesMidnight,
    sourceTimeZone: normalizeTimeZone(merged.sourceTimeZone),
    source: normalizeRequiredText(merged.source, 'source', 200),
    version: normalizeRequiredText(merged.version, 'version', 100),
    ...effectiveRange,
    status: normalizeStatus(merged.status === undefined ? 'active' : merged.status)
  };
}

/**
 * 列出排班定义及历史版本。
 * @param {*} input 查询条件。
 * @param {object} options 可注入 SQLite 连接。
 * @returns {object} 排班定义列表。
 */
function listShiftDefinitions(input = {}, options = {}) {
  const normalizedInput = normalizeListInput(input);
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  try {
    const rows = db.prepare(
      `SELECT id, shift_code AS shiftCode, shift_name AS shiftName,
              start_minute AS startMinute, end_minute AS endMinute,
              crosses_midnight AS crossesMidnight, source_timezone AS sourceTimeZone,
              source, version, effective_start_utc AS effectiveStartUtc,
              effective_end_utc AS effectiveEndUtc, status,
              created_at AS createdAt, updated_at AS updatedAt
         FROM shift_definitions
        WHERE (@status IS NULL OR status = @status)
          AND (@code IS NULL OR shift_code = @code)
        ORDER BY shift_code ASC, created_at DESC, id DESC
        LIMIT ${CONFIGURATION_QUERY_LIMIT}`
    ).all(normalizedInput);
    return { items: rows.map(mapShiftRow), limit: CONFIGURATION_QUERY_LIMIT };
  } finally {
    if (!callerDatabase) db.close();
  }
}

/**
 * 创建首个排班定义版本。
 * @param {*} input 排班定义输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新排班定义。
 */
function createShiftDefinition(input, options = {}) {
  const normalizedInput = normalizeShiftDefinitionInput(input);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = db.prepare('SELECT id FROM shift_definitions WHERE shift_code = ? LIMIT 1').get(normalizedInput.shiftCode);
    if (existing) {
      throw conflict('排班编码已存在，请使用版本化修改入口。', { code: 'SHIFT_CODE_ALREADY_EXISTS' });
    }
    const nowUtc = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO shift_definitions (
         shift_code, shift_name, start_minute, end_minute, crosses_midnight,
         source_timezone, source, version, effective_start_utc, effective_end_utc,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalizedInput.shiftCode,
      normalizedInput.shiftName,
      normalizedInput.startMinute,
      normalizedInput.endMinute,
      normalizedInput.crossesMidnight ? 1 : 0,
      normalizedInput.sourceTimeZone,
      normalizedInput.source,
      normalizedInput.version,
      normalizedInput.effectiveStartUtc,
      normalizedInput.effectiveEndUtc,
      normalizedInput.status,
      nowUtc,
      nowUtc
    );
    const shiftDefinitionId = Number(result.lastInsertRowid);
    return {
      value: getShiftDefinitionWithDb(db, shiftDefinitionId),
      audit: {
        operation: 'energy.shift.configuration.create',
        targetType: 'shift_definition',
        targetId: shiftDefinitionId,
        detail: { shiftCode: normalizedInput.shiftCode, version: normalizedInput.version, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 基于既有排班创建新版本，不覆盖历史行。
 * @param {*} shiftDefinitionId 原版本 ID。
 * @param {*} input 新版本字段。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新版本。
 */
function createShiftDefinitionVersion(shiftDefinitionId, input, options = {}) {
  const normalizedId = normalizePositiveId(shiftDefinitionId, 'shiftDefinitionId');
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getShiftDefinitionWithDb(db, normalizedId);
    if (!existing) throw notFound('排班定义不存在。', { shiftDefinitionId: normalizedId });
    const normalizedInput = normalizeShiftDefinitionInput(input, existing);
    if (normalizedInput.version === existing.version) {
      throw conflict('新版本号必须不同于原版本。', { code: 'SHIFT_VERSION_UNCHANGED' });
    }
    const nowUtc = new Date().toISOString();
    if (normalizedInput.status === 'active') {
      deactivateSiblingVersions(db, 'shift_definitions', 'shift_code', existing.shiftCode, null, nowUtc);
    }
    const result = db.prepare(
      `INSERT INTO shift_definitions (
         shift_code, shift_name, start_minute, end_minute, crosses_midnight,
         source_timezone, source, version, effective_start_utc, effective_end_utc,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      existing.shiftCode,
      normalizedInput.shiftName,
      normalizedInput.startMinute,
      normalizedInput.endMinute,
      normalizedInput.crossesMidnight ? 1 : 0,
      normalizedInput.sourceTimeZone,
      normalizedInput.source,
      normalizedInput.version,
      normalizedInput.effectiveStartUtc,
      normalizedInput.effectiveEndUtc,
      normalizedInput.status,
      nowUtc,
      nowUtc
    );
    const newId = Number(result.lastInsertRowid);
    return {
      value: getShiftDefinitionWithDb(db, newId),
      audit: {
        operation: 'energy.shift.configuration.version.create',
        targetType: 'shift_definition',
        targetId: newId,
        detail: { previousId: normalizedId, shiftCode: existing.shiftCode, version: normalizedInput.version, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 启用或停用单个排班版本。
 * @param {*} shiftDefinitionId 排班定义 ID。
 * @param {*} input 状态输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 更新后版本。
 */
function setShiftDefinitionStatus(shiftDefinitionId, input, options = {}) {
  const normalizedId = normalizePositiveId(shiftDefinitionId, 'shiftDefinitionId');
  if (!isPlainObject(input)) throw badRequest('排班状态输入必须是对象。', { code: 'INVALID_SHIFT_STATUS_INPUT' });
  const status = normalizeStatus(input.status);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getShiftDefinitionWithDb(db, normalizedId);
    if (!existing) throw notFound('排班定义不存在。', { shiftDefinitionId: normalizedId });
    const nowUtc = new Date().toISOString();
    if (status === 'active') {
      deactivateSiblingVersions(db, 'shift_definitions', 'shift_code', existing.shiftCode, normalizedId, nowUtc);
    }
    db.prepare('UPDATE shift_definitions SET status = ?, updated_at = ? WHERE id = ?').run(status, nowUtc, normalizedId);
    return {
      value: getShiftDefinitionWithDb(db, normalizedId),
      audit: {
        operation: 'energy.shift.configuration.status',
        targetType: 'shift_definition',
        targetId: normalizedId,
        detail: { previousStatus: existing.status, status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 规范完整 TOU 周期规则并校验每周每天覆盖 0 至 1440 分钟。
 * @param {*} rules 原始周期规则。
 * @returns {object[]} 规范周期规则。
 */
function normalizeTouPeriodRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 168) {
    throw badRequest('periodRules 必须是 1 至 168 条规则的数组。', { code: 'INVALID_TOU_PERIOD_RULES' });
  }
  const normalizedRules = rules.map((rule, index) => {
    if (!isPlainObject(rule)) {
      throw badRequest('TOU 周期规则必须是对象。', { code: 'INVALID_TOU_PERIOD_RULE', index });
    }
    if (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 1 || rule.dayOfWeek > 7) {
      throw badRequest('dayOfWeek 必须是 1 至 7 的整数。', { code: 'INVALID_TOU_DAY_OF_WEEK', index });
    }
    if (!TOU_PERIOD_TYPES.includes(rule.periodType)) {
      throw badRequest('periodType 只允许 peak、flat 或 valley。', { code: 'INVALID_TOU_PERIOD_TYPE', index });
    }
    const startMinute = normalizeMinute(rule.startMinute, 'startMinute', 0, 1439);
    const endMinute = normalizeMinute(rule.endMinute, 'endMinute', 1, 1440);
    if (startMinute >= endMinute) {
      throw badRequest('TOU 周期规则开始分钟必须早于结束分钟。', { code: 'INVALID_TOU_PERIOD_RANGE', index });
    }
    return { dayOfWeek: rule.dayOfWeek, periodType: rule.periodType, startMinute, endMinute };
  });
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    const dailyRules = normalizedRules
      .filter((rule) => rule.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    let expectedStart = 0;
    dailyRules.forEach((rule) => {
      if (rule.startMinute !== expectedStart) {
        throw badRequest('每个自然日的 TOU 规则必须无重叠、无缺口地覆盖 0 至 1440 分钟。', {
          code: 'INCOMPLETE_TOU_DAILY_COVERAGE',
          dayOfWeek,
          expectedStart,
          actualStart: rule.startMinute
        });
      }
      expectedStart = rule.endMinute;
    });
    if (expectedStart !== 1440) {
      throw badRequest('每个自然日的 TOU 规则必须覆盖至 1440 分钟。', {
        code: 'INCOMPLETE_TOU_DAILY_COVERAGE',
        dayOfWeek,
        coveredUntil: expectedStart
      });
    }
  }
  return normalizedRules;
}

/**
 * 映射 TOU 方案主行及周期规则。
 * @param {object} db SQLite 连接。
 * @param {object} row 方案主行。
 * @returns {object} 完整 TOU 方案。
 */
function mapTouSchemeWithDb(db, row) {
  const periodRules = db.prepare(
    `SELECT id, day_of_week AS dayOfWeek, period_type AS periodType,
            start_minute AS startMinute, end_minute AS endMinute,
            created_at AS createdAt, updated_at AS updatedAt
       FROM tou_period_rules
      WHERE tou_scheme_id = ?
      ORDER BY day_of_week ASC, start_minute ASC, id ASC`
  ).all(row.id).map((rule) => ({
    id: Number(rule.id),
    dayOfWeek: Number(rule.dayOfWeek),
    periodType: rule.periodType,
    startMinute: Number(rule.startMinute),
    endMinute: Number(rule.endMinute),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt
  }));
  return {
    id: Number(row.id),
    schemeCode: row.schemeCode,
    schemeName: row.schemeName,
    sourceTimeZone: row.sourceTimeZone,
    source: row.source,
    documentNo: row.documentNo,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    status: row.status,
    periodRules,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 查询单条 TOU 方案。
 * @param {object} db SQLite 连接。
 * @param {number} touSchemeId 方案 ID。
 * @returns {object|null} 完整方案。
 */
function getTouSchemeWithDb(db, touSchemeId) {
  const row = db.prepare(
    `SELECT id, scheme_code AS schemeCode, scheme_name AS schemeName,
            source_timezone AS sourceTimeZone, source, document_no AS documentNo,
            version, effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, status,
            created_at AS createdAt, updated_at AS updatedAt
       FROM tou_schemes
      WHERE id = ?`
  ).get(touSchemeId);
  return row ? mapTouSchemeWithDb(db, row) : null;
}

/**
 * 规范 TOU 方案输入。
 * @param {*} input 原始输入。
 * @param {object|null} existing 现有版本。
 * @returns {object} 规范方案。
 */
function normalizeTouSchemeInput(input, existing = null) {
  if (!isPlainObject(input)) throw badRequest('TOU 方案输入必须是对象。', { code: 'INVALID_TOU_SCHEME_INPUT' });
  const merged = existing ? { ...existing, ...input, schemeCode: existing.schemeCode } : input;
  const effectiveRange = normalizeEffectiveRange(merged.effectiveStartUtc, merged.effectiveEndUtc);
  return {
    schemeCode: normalizeRequiredText(merged.schemeCode, 'schemeCode', 100),
    schemeName: normalizeRequiredText(merged.schemeName, 'schemeName', 200),
    sourceTimeZone: normalizeTimeZone(merged.sourceTimeZone),
    source: normalizeRequiredText(merged.source, 'source', 200),
    documentNo: normalizeOptionalText(merged.documentNo, 'documentNo', 200),
    version: normalizeRequiredText(merged.version, 'version', 100),
    ...effectiveRange,
    status: normalizeStatus(merged.status === undefined ? 'active' : merged.status),
    periodRules: normalizeTouPeriodRules(merged.periodRules)
  };
}

/**
 * 插入 TOU 方案和完整周期规则。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @param {string} nowUtc 写入时间。
 * @returns {number} 方案 ID。
 */
function insertTouSchemeWithDb(db, input, nowUtc) {
  const result = db.prepare(
    `INSERT INTO tou_schemes (
       scheme_code, scheme_name, source_timezone, source, document_no, version,
       effective_start_utc, effective_end_utc, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.schemeCode,
    input.schemeName,
    input.sourceTimeZone,
    input.source,
    input.documentNo,
    input.version,
    input.effectiveStartUtc,
    input.effectiveEndUtc,
    input.status,
    nowUtc,
    nowUtc
  );
  const touSchemeId = Number(result.lastInsertRowid);
  const insertRule = db.prepare(
    `INSERT INTO tou_period_rules (
       tou_scheme_id, day_of_week, period_type, start_minute, end_minute, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  input.periodRules.forEach((rule) => {
    insertRule.run(touSchemeId, rule.dayOfWeek, rule.periodType, rule.startMinute, rule.endMinute, nowUtc, nowUtc);
  });
  return touSchemeId;
}

/**
 * 列出 TOU 方案及完整周期规则。
 * @param {*} input 查询条件。
 * @param {object} options 可注入 SQLite 连接。
 * @returns {object} TOU 方案列表。
 */
function listTouSchemes(input = {}, options = {}) {
  const normalizedInput = normalizeListInput(input);
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  try {
    const rows = db.prepare(
      `SELECT id, scheme_code AS schemeCode, scheme_name AS schemeName,
              source_timezone AS sourceTimeZone, source, document_no AS documentNo,
              version, effective_start_utc AS effectiveStartUtc,
              effective_end_utc AS effectiveEndUtc, status,
              created_at AS createdAt, updated_at AS updatedAt
         FROM tou_schemes
        WHERE (@status IS NULL OR status = @status)
          AND (@code IS NULL OR scheme_code = @code)
        ORDER BY scheme_code ASC, created_at DESC, id DESC
        LIMIT ${CONFIGURATION_QUERY_LIMIT}`
    ).all(normalizedInput);
    return { items: rows.map((row) => mapTouSchemeWithDb(db, row)), limit: CONFIGURATION_QUERY_LIMIT };
  } finally {
    if (!callerDatabase) db.close();
  }
}

/**
 * 创建首个 TOU 方案版本和完整规则快照。
 * @param {*} input TOU 输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新方案。
 */
function createTouScheme(input, options = {}) {
  const normalizedInput = normalizeTouSchemeInput(input);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = db.prepare('SELECT id FROM tou_schemes WHERE scheme_code = ? LIMIT 1').get(normalizedInput.schemeCode);
    if (existing) throw conflict('TOU 方案编码已存在，请使用版本化修改入口。', { code: 'TOU_SCHEME_CODE_ALREADY_EXISTS' });
    const nowUtc = new Date().toISOString();
    const touSchemeId = insertTouSchemeWithDb(db, normalizedInput, nowUtc);
    return {
      value: getTouSchemeWithDb(db, touSchemeId),
      audit: {
        operation: 'energy.tou.configuration.create',
        targetType: 'tou_scheme',
        targetId: touSchemeId,
        detail: { schemeCode: normalizedInput.schemeCode, version: normalizedInput.version, periodRuleCount: normalizedInput.periodRules.length, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 基于既有 TOU 方案创建独立新版本和规则快照。
 * @param {*} touSchemeId 原方案 ID。
 * @param {*} input 新版本输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新版本方案。
 */
function createTouSchemeVersion(touSchemeId, input, options = {}) {
  const normalizedId = normalizePositiveId(touSchemeId, 'touSchemeId');
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getTouSchemeWithDb(db, normalizedId);
    if (!existing) throw notFound('TOU 方案不存在。', { touSchemeId: normalizedId });
    const normalizedInput = normalizeTouSchemeInput(input, existing);
    if (normalizedInput.version === existing.version) {
      throw conflict('新版本号必须不同于原版本。', { code: 'TOU_VERSION_UNCHANGED' });
    }
    const nowUtc = new Date().toISOString();
    if (normalizedInput.status === 'active') {
      deactivateSiblingVersions(db, 'tou_schemes', 'scheme_code', existing.schemeCode, null, nowUtc);
    }
    const newId = insertTouSchemeWithDb(db, normalizedInput, nowUtc);
    return {
      value: getTouSchemeWithDb(db, newId),
      audit: {
        operation: 'energy.tou.configuration.version.create',
        targetType: 'tou_scheme',
        targetId: newId,
        detail: { previousId: normalizedId, schemeCode: existing.schemeCode, version: normalizedInput.version, periodRuleCount: normalizedInput.periodRules.length, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 启用或停用 TOU 方案版本。
 * @param {*} touSchemeId 方案 ID。
 * @param {*} input 状态输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 更新后方案。
 */
function setTouSchemeStatus(touSchemeId, input, options = {}) {
  const normalizedId = normalizePositiveId(touSchemeId, 'touSchemeId');
  if (!isPlainObject(input)) throw badRequest('TOU 状态输入必须是对象。', { code: 'INVALID_TOU_STATUS_INPUT' });
  const status = normalizeStatus(input.status);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getTouSchemeWithDb(db, normalizedId);
    if (!existing) throw notFound('TOU 方案不存在。', { touSchemeId: normalizedId });
    const nowUtc = new Date().toISOString();
    if (status === 'active') {
      deactivateSiblingVersions(db, 'tou_schemes', 'scheme_code', existing.schemeCode, normalizedId, nowUtc);
    }
    db.prepare('UPDATE tou_schemes SET status = ?, updated_at = ? WHERE id = ?').run(status, nowUtc, normalizedId);
    return {
      value: getTouSchemeWithDb(db, normalizedId),
      audit: {
        operation: 'energy.tou.configuration.status',
        targetType: 'tou_scheme',
        targetId: normalizedId,
        detail: { previousStatus: existing.status, status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 映射策略规则行，证据要求只作为受控 JSON 对象返回。
 * @param {object} row 数据库行。
 * @returns {object} 策略规则。
 */
function mapStrategyRuleRow(row) {
  let evidenceRequirements = null;
  try {
    evidenceRequirements = JSON.parse(row.evidenceRequirementsJson);
  } catch (_error) {
    evidenceRequirements = null;
  }
  return {
    id: Number(row.id),
    ruleCode: row.ruleCode,
    ruleName: row.ruleName,
    ruleVersion: row.ruleVersion,
    formulaVersion: row.formulaVersion,
    metricCode: row.metricCode,
    thresholdOperator: row.thresholdOperator,
    thresholdValue: row.thresholdValue === null ? null : Number(row.thresholdValue),
    thresholdMin: row.thresholdMin === null ? null : Number(row.thresholdMin),
    thresholdMax: row.thresholdMax === null ? null : Number(row.thresholdMax),
    thresholdUnit: row.thresholdUnit,
    reductionRate: row.reductionRate === null ? null : Number(row.reductionRate),
    priority: row.priority,
    evidenceRequirements,
    recommendationText: row.recommendationText,
    source: row.source,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    sourceTimeZone: row.sourceTimeZone,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 查询单条策略规则。
 * @param {object} db SQLite 连接。
 * @param {number} strategyRuleId 规则 ID。
 * @returns {object|null} 策略规则。
 */
function getStrategyRuleWithDb(db, strategyRuleId) {
  const row = db.prepare(
    `SELECT id, rule_code AS ruleCode, rule_name AS ruleName,
            rule_version AS ruleVersion, formula_version AS formulaVersion,
            metric_code AS metricCode, threshold_operator AS thresholdOperator,
            threshold_value AS thresholdValue, threshold_min AS thresholdMin,
            threshold_max AS thresholdMax, threshold_unit AS thresholdUnit,
            reduction_rate AS reductionRate, priority,
            evidence_requirements_json AS evidenceRequirementsJson,
            recommendation_text AS recommendationText, source,
            effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, source_timezone AS sourceTimeZone,
            status, created_at AS createdAt, updated_at AS updatedAt
       FROM strategy_rules
      WHERE id = ?`
  ).get(strategyRuleId);
  return row ? mapStrategyRuleRow(row) : null;
}

/**
 * 规范策略规则输入并严格限制固定指标和固定阈值字段。
 * @param {*} input 原始输入。
 * @param {object|null} existing 现有版本。
 * @returns {object} 规范策略规则。
 */
function normalizeStrategyRuleInput(input, existing = null) {
  if (!isPlainObject(input)) throw badRequest('策略规则输入必须是对象。', { code: 'INVALID_STRATEGY_RULE_INPUT' });
  const merged = existing ? { ...existing, ...input, ruleCode: existing.ruleCode } : input;
  const thresholdOperator = merged.thresholdOperator;
  if (!STRATEGY_THRESHOLD_OPERATORS.includes(thresholdOperator)) {
    throw badRequest('thresholdOperator 不在固定白名单中。', { code: 'INVALID_STRATEGY_THRESHOLD_OPERATOR' });
  }
  if (merged.formulaVersion !== SUPPORTED_FORMULA_VERSION) {
    throw badRequest('formulaVersion 不在首期固定公式白名单中。', {
      code: 'UNSUPPORTED_STRATEGY_FORMULA_VERSION',
      allowedValues: [SUPPORTED_FORMULA_VERSION]
    });
  }
  if (!SUPPORTED_METRIC_CODES.includes(merged.metricCode)) {
    throw badRequest('metricCode 不在首期固定指标白名单中。', {
      code: 'UNSUPPORTED_STRATEGY_METRIC_CODE',
      allowedValues: SUPPORTED_METRIC_CODES
    });
  }
  let thresholdValue = null;
  let thresholdMin = null;
  let thresholdMax = null;
  if (thresholdOperator === 'between') {
    thresholdMin = normalizeFiniteNumber(merged.thresholdMin, 'thresholdMin');
    thresholdMax = normalizeFiniteNumber(merged.thresholdMax, 'thresholdMax');
    if (thresholdMin > thresholdMax) {
      throw badRequest('thresholdMin 不能大于 thresholdMax。', { code: 'INVALID_STRATEGY_THRESHOLD_RANGE' });
    }
  } else {
    thresholdValue = normalizeFiniteNumber(merged.thresholdValue, 'thresholdValue');
  }
  let reductionRate = null;
  if (merged.reductionRate !== undefined && merged.reductionRate !== null) {
    reductionRate = normalizeFiniteNumber(merged.reductionRate, 'reductionRate', { minimum: Number.MIN_VALUE, maximum: 1 });
  }
  if (!STRATEGY_PRIORITIES.includes(merged.priority)) {
    throw badRequest('priority 只允许 low、medium 或 high。', { code: 'INVALID_STRATEGY_PRIORITY' });
  }
  if (!isPlainObject(merged.evidenceRequirements)) {
    throw badRequest('evidenceRequirements 必须是受控对象。', { code: 'INVALID_EVIDENCE_REQUIREMENTS_OBJECT' });
  }
  const evidenceRequirementsJson = JSON.stringify(merged.evidenceRequirements);
  const evidenceValidation = parseEvidenceRequirements(evidenceRequirementsJson);
  if (!evidenceValidation.valid) {
    throw badRequest('evidenceRequirements 不符合固定证据契约。', {
      code: 'INVALID_STRATEGY_EVIDENCE_REQUIREMENTS',
      errors: evidenceValidation.errors
    });
  }
  const effectiveRange = normalizeEffectiveRange(merged.effectiveStartUtc, merged.effectiveEndUtc);
  return {
    ruleCode: normalizeRequiredText(merged.ruleCode, 'ruleCode', 100),
    ruleName: normalizeRequiredText(merged.ruleName, 'ruleName', 200),
    ruleVersion: normalizeRequiredText(merged.ruleVersion, 'ruleVersion', 100),
    formulaVersion: normalizeRequiredText(merged.formulaVersion, 'formulaVersion', 100),
    metricCode: merged.metricCode,
    thresholdOperator,
    thresholdValue,
    thresholdMin,
    thresholdMax,
    thresholdUnit: normalizeRequiredText(merged.thresholdUnit, 'thresholdUnit', 100),
    reductionRate,
    priority: merged.priority,
    evidenceRequirements: evidenceValidation.requirements,
    evidenceRequirementsJson: JSON.stringify(evidenceValidation.requirements),
    recommendationText: normalizeRequiredText(merged.recommendationText, 'recommendationText', 2000),
    source: normalizeRequiredText(merged.source, 'source', 200),
    ...effectiveRange,
    sourceTimeZone: normalizeTimeZone(merged.sourceTimeZone),
    status: normalizeStatus(merged.status === undefined ? 'active' : merged.status)
  };
}

/**
 * 插入单条策略规则版本。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @param {string} nowUtc 写入时间。
 * @returns {number} 规则 ID。
 */
function insertStrategyRuleWithDb(db, input, nowUtc) {
  const result = db.prepare(
    `INSERT INTO strategy_rules (
       rule_code, rule_name, rule_version, formula_version, metric_code,
       threshold_operator, threshold_value, threshold_min, threshold_max,
       threshold_unit, reduction_rate, priority, evidence_requirements_json,
       recommendation_text, source, effective_start_utc, effective_end_utc,
       source_timezone, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.ruleCode,
    input.ruleName,
    input.ruleVersion,
    input.formulaVersion,
    input.metricCode,
    input.thresholdOperator,
    input.thresholdValue,
    input.thresholdMin,
    input.thresholdMax,
    input.thresholdUnit,
    input.reductionRate,
    input.priority,
    input.evidenceRequirementsJson,
    input.recommendationText,
    input.source,
    input.effectiveStartUtc,
    input.effectiveEndUtc,
    input.sourceTimeZone,
    input.status,
    nowUtc,
    nowUtc
  );
  return Number(result.lastInsertRowid);
}

/**
 * 列出策略规则及历史版本。
 * @param {*} input 查询条件。
 * @param {object} options 可注入 SQLite 连接。
 * @returns {object} 策略规则列表。
 */
function listStrategyRules(input = {}, options = {}) {
  const normalizedInput = normalizeListInput(input);
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  try {
    const rows = db.prepare(
      `SELECT id, rule_code AS ruleCode, rule_name AS ruleName,
              rule_version AS ruleVersion, formula_version AS formulaVersion,
              metric_code AS metricCode, threshold_operator AS thresholdOperator,
              threshold_value AS thresholdValue, threshold_min AS thresholdMin,
              threshold_max AS thresholdMax, threshold_unit AS thresholdUnit,
              reduction_rate AS reductionRate, priority,
              evidence_requirements_json AS evidenceRequirementsJson,
              recommendation_text AS recommendationText, source,
              effective_start_utc AS effectiveStartUtc,
              effective_end_utc AS effectiveEndUtc, source_timezone AS sourceTimeZone,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM strategy_rules
        WHERE (@status IS NULL OR status = @status)
          AND (@code IS NULL OR rule_code = @code)
        ORDER BY rule_code ASC, created_at DESC, id DESC
        LIMIT ${CONFIGURATION_QUERY_LIMIT}`
    ).all(normalizedInput);
    return { items: rows.map(mapStrategyRuleRow), limit: CONFIGURATION_QUERY_LIMIT };
  } finally {
    if (!callerDatabase) db.close();
  }
}

/**
 * 创建首个策略规则版本。
 * @param {*} input 策略规则输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新策略规则。
 */
function createStrategyRule(input, options = {}) {
  const normalizedInput = normalizeStrategyRuleInput(input);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = db.prepare('SELECT id FROM strategy_rules WHERE rule_code = ? LIMIT 1').get(normalizedInput.ruleCode);
    if (existing) throw conflict('策略规则编码已存在，请使用版本化修改入口。', { code: 'STRATEGY_RULE_CODE_ALREADY_EXISTS' });
    const nowUtc = new Date().toISOString();
    const strategyRuleId = insertStrategyRuleWithDb(db, normalizedInput, nowUtc);
    return {
      value: getStrategyRuleWithDb(db, strategyRuleId),
      audit: {
        operation: 'energy.strategy.rule.configuration.create',
        targetType: 'strategy_rule',
        targetId: strategyRuleId,
        detail: { ruleCode: normalizedInput.ruleCode, ruleVersion: normalizedInput.ruleVersion, metricCode: normalizedInput.metricCode, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 基于既有策略规则创建新版本，不覆盖历史规则。
 * @param {*} strategyRuleId 原规则 ID。
 * @param {*} input 新版本输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 新规则版本。
 */
function createStrategyRuleVersion(strategyRuleId, input, options = {}) {
  const normalizedId = normalizePositiveId(strategyRuleId, 'strategyRuleId');
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getStrategyRuleWithDb(db, normalizedId);
    if (!existing) throw notFound('策略规则不存在。', { strategyRuleId: normalizedId });
    const normalizedInput = normalizeStrategyRuleInput(input, existing);
    if (normalizedInput.ruleVersion === existing.ruleVersion) {
      throw conflict('新规则版本号必须不同于原版本。', { code: 'STRATEGY_RULE_VERSION_UNCHANGED' });
    }
    const nowUtc = new Date().toISOString();
    if (normalizedInput.status === 'active') {
      deactivateSiblingVersions(db, 'strategy_rules', 'rule_code', existing.ruleCode, null, nowUtc);
    }
    const newId = insertStrategyRuleWithDb(db, normalizedInput, nowUtc);
    return {
      value: getStrategyRuleWithDb(db, newId),
      audit: {
        operation: 'energy.strategy.rule.configuration.version.create',
        targetType: 'strategy_rule',
        targetId: newId,
        detail: { previousId: normalizedId, ruleCode: existing.ruleCode, ruleVersion: normalizedInput.ruleVersion, metricCode: normalizedInput.metricCode, status: normalizedInput.status },
        createdAt: nowUtc
      }
    };
  });
}

/**
 * 启用或停用策略规则版本。
 * @param {*} strategyRuleId 规则 ID。
 * @param {*} input 状态输入。
 * @param {object} options 审计和数据库选项。
 * @returns {object} 更新后规则。
 */
function setStrategyRuleStatus(strategyRuleId, input, options = {}) {
  const normalizedId = normalizePositiveId(strategyRuleId, 'strategyRuleId');
  if (!isPlainObject(input)) throw badRequest('策略规则状态输入必须是对象。', { code: 'INVALID_STRATEGY_RULE_STATUS_INPUT' });
  const status = normalizeStatus(input.status);
  return executeAtomicConfigurationWrite(options, (db) => {
    const existing = getStrategyRuleWithDb(db, normalizedId);
    if (!existing) throw notFound('策略规则不存在。', { strategyRuleId: normalizedId });
    const nowUtc = new Date().toISOString();
    if (status === 'active') {
      deactivateSiblingVersions(db, 'strategy_rules', 'rule_code', existing.ruleCode, normalizedId, nowUtc);
    }
    db.prepare('UPDATE strategy_rules SET status = ?, updated_at = ? WHERE id = ?').run(status, nowUtc, normalizedId);
    return {
      value: getStrategyRuleWithDb(db, normalizedId),
      audit: {
        operation: 'energy.strategy.rule.configuration.status',
        targetType: 'strategy_rule',
        targetId: normalizedId,
        detail: { previousStatus: existing.status, status },
        createdAt: nowUtc
      }
    };
  });
}

module.exports = {
  CONFIGURATION_QUERY_LIMIT,
  CONFIGURATION_STATUSES,
  STRATEGY_PRIORITIES,
  STRATEGY_THRESHOLD_OPERATORS,
  TOU_PERIOD_TYPES,
  createShiftDefinition,
  createShiftDefinitionVersion,
  createStrategyRule,
  createStrategyRuleVersion,
  createTouScheme,
  createTouSchemeVersion,
  executeAtomicConfigurationWrite,
  getShiftDefinitionWithDb,
  getStrategyRuleWithDb,
  getTouSchemeWithDb,
  listShiftDefinitions,
  listStrategyRules,
  listTouSchemes,
  normalizeShiftDefinitionInput,
  normalizeStrategyRuleInput,
  normalizeTouPeriodRules,
  normalizeTouSchemeInput,
  setShiftDefinitionStatus,
  setStrategyRuleStatus,
  setTouSchemeStatus
};
