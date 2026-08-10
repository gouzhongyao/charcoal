'use strict';

const { openDatabase: defaultOpenDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const {
  ENERGY_ANALYSIS_VERSIONS,
  ENERGY_FLOW_NODE_TYPES,
  ENERGY_FLOW_SOURCE_TYPES,
  isIanaTimeZone,
  isStrictUtcIso
} = require('./energyAnalysisContracts');
const {
  calculateEnergyFlowNodeDifference,
  roundAnalysisValue
} = require('./energyAnalysisUtils');
const { normalizeUnitAndValue } = require('./import/normalization');

// 能流配置状态白名单。
const ENERGY_FLOW_CONFIG_STATUSES = Object.freeze(['active', 'inactive']);
// 发电来源可显式选择的数值字段白名单。
const GENERATION_VALUE_FIELDS = Object.freeze(['generation', 'self_use', 'grid_export']);
// 能流查询默认分页大小。
const DEFAULT_PAGE_SIZE = 50;
// 能流查询单页最大记录数。
const MAX_PAGE_SIZE = 200;
// 单次来源解析允许读取的最大事实记录数。
const MAX_SOURCE_RECORDS = 50000;
// 单次完整拓扑读取允许的最大节点数。
const MAX_TOPOLOGY_NODES = 5000;
// 单次完整拓扑读取允许的最大边数。
const MAX_TOPOLOGY_EDGES = 10000;
// 单次分析允许逐边解析的最大 active 边数。
const MAX_ANALYSIS_EDGES = 2000;
// 显式 recordIds 选择器允许的最大 ID 数量。
const MAX_EXPLICIT_RECORD_IDS = 500;
// 月份输入格式。
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
// 模型编码、节点编码、边编码和版本允许的稳定字符集合。
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// 差额率计算使用的零值容差。
const BALANCE_ZERO_TOLERANCE = 1e-9;

/**
 * 打开可注入数据库，并记录连接所有权。
 * @param {object} options 依赖注入选项。
 * @returns {{db:object,shouldClose:boolean}} 数据库上下文。
 */
function openServiceDatabase(options = {}) {
  if (options.db) return { db: options.db, shouldClose: false };
  const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
  return { db: openDatabase(), shouldClose: true };
}

/**
 * 清理写操作审计详情中的凭据字段。
 * @param {*} value 原始详情。
 * @returns {*} 可持久化详情。
 */
function sanitizeAuditDetail(value) {
  if (!value || typeof value !== 'object') return value || null;
  const blockedFields = new Set(['password', 'passwordhash', 'currentpassword', 'newpassword', 'token', 'authorization']);
  if (Array.isArray(value)) return value.map(sanitizeAuditDetail);
  return Object.entries(value).reduce((result, [key, item]) => {
    if (!blockedFields.has(key.toLowerCase())) result[key] = sanitizeAuditDetail(item);
    return result;
  }, {});
}

/**
 * 在业务写入使用的同一连接和事务内写入操作审计。
 * @param {object} db SQLite 连接。
 * @param {object|null} audit 审计上下文。
 * @param {object} result 业务结果。
 */
function writeOperationAudit(db, audit, result) {
  const normalizedAudit = normalizeBusinessAudit(audit);
  db.prepare(
    `INSERT INTO sys_operation_logs (
       user_id, operation, target_type, target_id, detail_json, ip, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).run(
    normalizedAudit.userId,
    normalizedAudit.operation,
    normalizedAudit.targetType,
    result?.id === null || result?.id === undefined ? null : String(result.id),
    JSON.stringify(sanitizeAuditDetail(result)),
    normalizedAudit.ip
  );
}

/**
 * 规范并强制能流业务写操作审计上下文。
 * @param {object} audit 原始审计上下文。
 * @returns {object} 规范审计上下文。
 */
function normalizeBusinessAudit(audit) {
  const operation = normalizeText(audit && audit.operation);
  const targetType = normalizeText(audit && audit.targetType);
  const userId = audit && audit.userId;
  if (!operation || !targetType || !Number.isSafeInteger(userId) || userId <= 0) {
    throw badRequest('能流写操作必须提供完整审计上下文和有效正整数操作者。', {
      code: 'ENERGY_FLOW_AUDIT_CONTEXT_INVALID',
      field: !Number.isSafeInteger(userId) || userId <= 0 ? 'audit.userId' : 'audit'
    });
  }
  return {
    userId,
    operation,
    targetType,
    ip: normalizeText(audit.ip)
  };
}

/**
 * 以 IMMEDIATE 事务执行单次业务写和审计；调用方已有事务时使用保存点隔离失败。
 * @param {object} db SQLite 连接。
 * @param {object} options 依赖和审计选项。
 * @param {Function} action 业务写函数。
 * @returns {*} 业务结果。
 */
function executeBusinessWrite(db, options, action) {
  const audit = normalizeBusinessAudit(options && options.audit);
  const ownsTransaction = !db.inTransaction;
  const savepointName = `energy_flow_write_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepointName}`);
  try {
    const result = action();
    writeOperationAudit(db, audit, result);
    if (ownsTransaction) db.exec('COMMIT');
    else db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    return result;
  } catch (error) {
    if (ownsTransaction && db.inTransaction) db.exec('ROLLBACK');
    else if (!ownsTransaction) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    }
    throw error;
  }
}

/**
 * 在同一 SQLite 读事务内执行完整分析，固定首次读取建立的 WAL 快照。
 * @param {object} db SQLite 连接。
 * @param {Function} action 只读分析函数。
 * @returns {*} 分析结果。
 */
function executeReadSnapshot(db, action) {
  const ownsTransaction = !db.inTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    const result = action();
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 将任意输入规范为去除首尾空白的文本。
 * @param {*} value 原始值。
 * @returns {string|null} 规范文本。
 */
function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * 读取对象中的第一个已定义字段。
 * @param {object} source 来源对象。
 * @param {string[]} keys 候选字段名。
 * @returns {*} 第一个已定义值。
 */
function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

/**
 * 解析正整数。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {object} options 解析选项。
 * @returns {number|undefined} 正整数或 undefined。
 */
function parsePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    if (options.required) throw badRequest(`${fieldName} 为必填正整数。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName });
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName });
  }
  return parsed;
}

/**
 * 解析有限数值。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {object} options 解析选项。
 * @returns {number|undefined} 有限数值或 undefined。
 */
function parseFiniteNumber(value, fieldName, options = {}) {
  if (value === '' || value === null || value === undefined) {
    if (options.required) throw badRequest(`${fieldName} 为必填数值。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (options.nonNegative && parsed < 0)) {
    throw badRequest(`${fieldName} 必须是${options.nonNegative ? '大于等于 0 的' : ''}有限数值。`, {
      code: 'INVALID_FINITE_NUMBER',
      fieldName
    });
  }
  return parsed;
}

/**
 * 断言字段值属于白名单。
 * @param {*} value 字段值。
 * @param {string} fieldName 字段名。
 * @param {string[]} allowedValues 白名单。
 */
function assertWhitelist(value, fieldName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, {
      code: 'UNSUPPORTED_ENERGY_FLOW_VALUE',
      fieldName,
      allowedValues
    });
  }
}

/**
 * 解析分页参数并施加单页上限。
 * @param {object} query 查询参数。
 * @returns {{page:number,pageSize:number,offset:number}} 分页结果。
 */
function normalizePagination(query = {}) {
  const page = parsePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = parsePositiveInteger(query.pageSize, 'pageSize') || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 将查询状态规范为 active/inactive。
 * @param {*} value 原始状态。
 * @returns {string|null} 状态。
 */
function normalizeOptionalStatus(value) {
  const status = normalizeText(value);
  if (status) assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  return status;
}

/**
 * 校验稳定业务编码或版本文本。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @returns {string} 合法文本。
 */
function normalizeIdentity(value, fieldName) {
  const text = normalizeText(value);
  if (!text) throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
  if (!IDENTITY_PATTERN.test(text)) {
    throw badRequest(`${fieldName} 格式无效。`, { code: 'INVALID_ENERGY_FLOW_IDENTITY', fieldName });
  }
  return text;
}

/**
 * 校验严格 UTC 半开区间。
 * @param {*} startValue 开始时间。
 * @param {*} endValue 结束时间。
 * @param {string} startField 开始字段名。
 * @param {string} endField 结束字段名。
 * @returns {{startUtc:string,endUtc:string,startMs:number,endMs:number}} 时间范围。
 */
function normalizeUtcRange(startValue, endValue, startField = 'startUtc', endField = 'endUtc') {
  const startUtc = normalizeText(startValue);
  const endUtc = normalizeText(endValue);
  if (!isStrictUtcIso(startUtc)) {
    throw badRequest(`${startField} 必须是严格 UTC Z 时间。`, { code: 'INVALID_START_UTC', fieldName: startField });
  }
  if (!isStrictUtcIso(endUtc)) {
    throw badRequest(`${endField} 必须是严格 UTC Z 时间。`, { code: 'INVALID_END_UTC', fieldName: endField });
  }
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (!(startMs < endMs)) {
    throw badRequest('时间范围必须满足左闭右开且开始早于结束。', { code: 'INVALID_HALF_OPEN_RANGE' });
  }
  return { startUtc, endUtc, startMs, endMs };
}

/**
 * 将 YYYY-MM 规范为合法月份。
 * @param {*} value 原始月份。
 * @param {string} fieldName 字段名。
 * @returns {string} 月份。
 */
function normalizeMonth(value, fieldName) {
  const month = normalizeText(value);
  if (!month || !MONTH_PATTERN.test(month)) {
    throw badRequest(`${fieldName} 必须是 YYYY-MM。`, { code: 'INVALID_MONTH', fieldName });
  }
  return month;
}

/**
 * 返回指定月份下一月。
 * @param {string} month YYYY-MM。
 * @returns {string} 下一月。
 */
function nextMonth(month) {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 列出闭区间月份。
 * @param {string} startMonth 开始月份。
 * @param {string} endMonth 结束月份。
 * @returns {string[]} 月份数组。
 */
function listMonths(startMonth, endMonth) {
  const months = [];
  let current = startMonth;
  while (current <= endMonth && months.length <= 36) {
    months.push(current);
    current = nextMonth(current);
  }
  return months;
}

/**
 * 将月份范围或 UTC 范围统一为分析区间。
 * @param {object} input 分析输入。
 * @returns {object} 统一分析范围。
 */
function normalizeAnalysisRange(input = {}) {
  const hasMonthRange = input.startMonth !== undefined || input.endMonth !== undefined;
  const hasUtcRange = input.startUtc !== undefined || input.endUtc !== undefined;
  if (hasMonthRange && hasUtcRange) {
    throw badRequest('月份范围和 UTC 时间范围不能同时提交。', { code: 'ENERGY_FLOW_RANGE_MODE_CONFLICT' });
  }
  if (hasMonthRange) {
    const startMonth = normalizeMonth(input.startMonth, 'startMonth');
    const endMonth = normalizeMonth(input.endMonth, 'endMonth');
    if (startMonth > endMonth) throw badRequest('startMonth 不能晚于 endMonth。', { code: 'INVALID_MONTH_RANGE' });
    const months = listMonths(startMonth, endMonth);
    if (months.length === 0 || months.length > 36 || months[months.length - 1] !== endMonth) {
      throw badRequest('月份范围最多支持 36 个月。', { code: 'ENERGY_FLOW_RANGE_TOO_LARGE', maxMonths: 36 });
    }
    const startUtc = `${startMonth}-01T00:00:00Z`;
    const endUtc = `${nextMonth(endMonth)}-01T00:00:00Z`;
    return {
      mode: 'month',
      startMonth,
      endMonth,
      months,
      monthAligned: true,
      ...normalizeUtcRange(startUtc, endUtc)
    };
  }
  const range = normalizeUtcRange(input.startUtc, input.endUtc);
  const maximumDurationMs = 366 * 3 * 24 * 60 * 60 * 1000;
  if (range.endMs - range.startMs > maximumDurationMs) {
    throw badRequest('UTC 时间范围最多支持约 36 个月。', { code: 'ENERGY_FLOW_RANGE_TOO_LARGE', maxDays: 1098 });
  }
  const monthAligned = /^\d{4}-\d{2}-01T00:00:00(?:\.000)?Z$/.test(range.startUtc)
    && /^\d{4}-\d{2}-01T00:00:00(?:\.000)?Z$/.test(range.endUtc);
  const startMonth = range.startUtc.slice(0, 7);
  const endMonthExclusive = range.endUtc.slice(0, 7);
  const endMonth = monthAligned ? (() => {
    const date = new Date(Date.UTC(Number(endMonthExclusive.slice(0, 4)), Number(endMonthExclusive.slice(5, 7)) - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  })() : null;
  const months = monthAligned && endMonth && startMonth <= endMonth ? listMonths(startMonth, endMonth) : [];
  return { mode: 'utc', startMonth, endMonth, months, monthAligned, ...range };
}

/**
 * 安全解析 JSON 对象。
 * @param {*} value JSON 文本或对象。
 * @returns {object|null} 普通对象。
 */
function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 将 JSON 对象按键排序为稳定文本。
 * @param {*} value JSON 对象。
 * @returns {string} 稳定 JSON。
 */
function stableJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.keys(item).sort().reduce((result, key) => {
      result[key] = normalize(item[key]);
      return result;
    }, {});
  };
  return JSON.stringify(normalize(value));
}

/**
 * 规范显式记录 ID 数组。
 * @param {*} value 原始数组。
 * @returns {number[]|null} ID 数组或 null。
 */
function normalizeRecordIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXPLICIT_RECORD_IDS) return null;
  const ids = value.map((item) => Number(item));
  if (ids.some((item) => !Number.isSafeInteger(item) || item <= 0)) return null;
  return [...new Set(ids)];
}

/**
 * 只保留能流来源契约允许的显式选择器，避免额外 JSON 字段进入响应和审计。
 * @param {*} value 原始来源映射。
 * @returns {object|null} 白名单来源映射。
 */
function sanitizeSourceMapping(value) {
  const mapping = parseJsonObject(value);
  if (!mapping) return null;
  const sanitized = {};
  const reference = normalizeText(mapping.reference);
  const recordIds = normalizeRecordIds(firstDefined(mapping, ['recordIds', 'record_ids']));
  const meterDeviceId = parseMappingPositiveInteger(firstDefined(mapping, ['meterDeviceId', 'meter_device_id']));
  const organizationUnitId = parseMappingPositiveInteger(firstDefined(mapping, ['organizationUnitId', 'organization_unit_id']));
  const sourceTimeZone = normalizeText(firstDefined(mapping, ['sourceTimeZone', 'source_timezone']));
  const valueField = normalizeText(firstDefined(mapping, ['valueField', 'value_field']));
  if (reference) sanitized.reference = reference;
  if (recordIds) sanitized.recordIds = recordIds;
  if (meterDeviceId) sanitized.meterDeviceId = meterDeviceId;
  if (organizationUnitId) sanitized.organizationUnitId = organizationUnitId;
  if (sourceTimeZone) sanitized.sourceTimeZone = sourceTimeZone;
  if (valueField) sanitized.valueField = valueField;
  return sanitized;
}

/**
 * 解析边的显式来源映射，不从组织树、父子关系或表计位置猜测来源。
 * @param {object} edge 能流边。
 * @returns {object} 来源映射解析结果。
 */
function resolveSourceMapping(edge) {
  const mapping = parseJsonObject(edge.sourceMappingJson);
  const reference = normalizeText(mapping?.reference);
  if (!mapping || !reference) {
    return { valid: false, mapping: null, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_MAPPING_REFERENCE_MISSING'] };
  }
  if (edge.sourceType === 'explicit_edge_value') {
    return { valid: true, mapping: { reference }, reasonCodes: [], configurationErrors: [] };
  }
  const rawRecordIds = firstDefined(mapping, ['recordIds', 'record_ids']);
  const rawMeterDeviceId = firstDefined(mapping, ['meterDeviceId', 'meter_device_id']);
  const rawOrganizationUnitId = firstDefined(mapping, ['organizationUnitId', 'organization_unit_id']);
  const recordIds = normalizeRecordIds(rawRecordIds);
  const meterDeviceId = parseMappingPositiveInteger(rawMeterDeviceId);
  const organizationUnitId = parseMappingPositiveInteger(rawOrganizationUnitId);
  const sourceTimeZone = normalizeText(firstDefined(mapping, ['sourceTimeZone', 'source_timezone']));
  if (rawRecordIds !== undefined && !recordIds) {
    return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_MAPPING_RECORD_IDS_INVALID'] };
  }
  if (rawMeterDeviceId !== undefined && !meterDeviceId) {
    return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_MAPPING_METER_ID_INVALID'] };
  }
  if (rawOrganizationUnitId !== undefined && !organizationUnitId) {
    return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_MAPPING_ORGANIZATION_ID_INVALID'] };
  }
  if (sourceTimeZone && !isIanaTimeZone(sourceTimeZone)) {
    return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_MAPPING_TIME_ZONE_INVALID'] };
  }
  if (edge.sourceType === 'timeseries') {
    if (!recordIds && !meterDeviceId) {
      return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['TIMESERIES_SELECTOR_MISSING'] };
    }
  } else if (edge.sourceType === 'monthly_energy') {
    if (!recordIds && !meterDeviceId && !organizationUnitId) {
      return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['MONTHLY_ENERGY_SELECTOR_MISSING'] };
    }
  } else if (edge.sourceType === 'generation') {
    const valueField = normalizeText(firstDefined(mapping, ['valueField', 'value_field']));
    if ((!recordIds && !organizationUnitId) || !GENERATION_VALUE_FIELDS.includes(valueField)) {
      return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['GENERATION_SELECTOR_OR_VALUE_FIELD_MISSING'] };
    }
    mapping.valueField = valueField;
  } else {
    return { valid: false, mapping, reasonCodes: ['TOPOLOGY_SOURCE_UNMAPPED'], configurationErrors: ['SOURCE_TYPE_UNSUPPORTED'] };
  }
  return {
    valid: true,
    mapping: sanitizeSourceMapping({
      reference,
      recordIds,
      meterDeviceId,
      organizationUnitId,
      sourceTimeZone,
      valueField: mapping.valueField
    }),
    reasonCodes: [],
    configurationErrors: []
  };
}

/**
 * 解析来源映射中的可选正整数，不对无效映射抛出全局请求错误。
 * @param {*} value 原始值。
 * @returns {number|null} 正整数或 null。
 */
function parseMappingPositiveInteger(value) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

/**
 * 将数据库模型行映射为公开契约。
 * @param {object} row 数据库行。
 * @returns {object|null} 模型。
 */
function mapModelRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    modelCode: row.modelCode,
    modelName: row.modelName,
    source: row.source,
    documentNo: row.documentNo,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    sourceTimeZone: row.sourceTimeZone,
    status: row.status,
    nodeCount: row.nodeCount === undefined ? undefined : Number(row.nodeCount),
    edgeCount: row.edgeCount === undefined ? undefined : Number(row.edgeCount),
    recordCount: row.recordCount === undefined ? undefined : Number(row.recordCount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 将数据库节点行映射为公开契约。
 * @param {object} row 数据库行。
 * @returns {object|null} 节点。
 */
function mapNodeRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    energyFlowModelId: Number(row.energyFlowModelId),
    nodeCode: row.nodeCode,
    nodeName: row.nodeName,
    nodeType: row.nodeType,
    organizationUnitId: row.organizationUnitId === null ? null : Number(row.organizationUnitId),
    organizationUnitCode: row.organizationUnitCode || null,
    organizationUnitName: row.organizationUnitName || null,
    x: Number(row.x),
    y: Number(row.y),
    status: row.status,
    sourceBatchId: row.sourceBatchId === null || row.sourceBatchId === undefined ? null : Number(row.sourceBatchId),
    sourceRowNumber: row.sourceRowNumber === null || row.sourceRowNumber === undefined ? null : Number(row.sourceRowNumber),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * 将数据库边行映射为公开契约。
 * @param {object} row 数据库行。
 * @returns {object|null} 边。
 */
function mapEdgeRow(row) {
  if (!row) return null;
  const mapped = {
    id: Number(row.id),
    energyFlowModelId: Number(row.energyFlowModelId),
    edgeCode: row.edgeCode,
    fromNodeId: Number(row.fromNodeId),
    fromNodeCode: row.fromNodeCode,
    fromNodeName: row.fromNodeName,
    toNodeId: Number(row.toNodeId),
    toNodeCode: row.toNodeCode,
    toNodeName: row.toNodeName,
    energyTypeId: Number(row.energyTypeId),
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    standardUnit: row.standardUnit,
    unit: row.unit,
    sourceType: row.sourceType,
    sourceMapping: sanitizeSourceMapping(row.sourceMappingJson),
    status: row.status,
    sourceBatchId: row.sourceBatchId === null || row.sourceBatchId === undefined ? null : Number(row.sourceBatchId),
    sourceRowNumber: row.sourceRowNumber === null || row.sourceRowNumber === undefined ? null : Number(row.sourceRowNumber),
    recordCount: row.recordCount === undefined ? undefined : Number(row.recordCount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  // 原始 JSON 仅供领域校验，不枚举、不进入 HTTP 响应或操作日志。
  Object.defineProperty(mapped, '_sourceMappingJson', { value: row.sourceMappingJson, enumerable: false });
  return mapped;
}

// 模型详情公共查询列。
const MODEL_SELECT_SQL = `
  SELECT model.id, model.model_code AS modelCode, model.model_name AS modelName,
         model.source, model.document_no AS documentNo, model.version,
         model.effective_start_utc AS effectiveStartUtc, model.effective_end_utc AS effectiveEndUtc,
         model.source_timezone AS sourceTimeZone, model.status,
         model.created_at AS createdAt, model.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM energy_flow_nodes node WHERE node.energy_flow_model_id = model.id) AS nodeCount,
         (SELECT COUNT(*) FROM energy_flow_edges edge WHERE edge.energy_flow_model_id = model.id) AS edgeCount,
         (SELECT COUNT(*) FROM energy_flow_records record WHERE record.energy_flow_model_id = model.id) AS recordCount
  FROM energy_flow_models model`;

// 节点公共查询列。
const NODE_SELECT_SQL = `
  SELECT node.id, node.energy_flow_model_id AS energyFlowModelId,
         node.node_code AS nodeCode, node.node_name AS nodeName, node.node_type AS nodeType,
         node.organization_unit_id AS organizationUnitId,
         organization.unit_code AS organizationUnitCode, organization.unit_name AS organizationUnitName,
         node.x, node.y, node.status, node.source_batch_id AS sourceBatchId,
         node.source_row_number AS sourceRowNumber, node.created_at AS createdAt, node.updated_at AS updatedAt
  FROM energy_flow_nodes node
  LEFT JOIN organization_units organization ON organization.id = node.organization_unit_id`;

// 边公共查询列。
const EDGE_SELECT_SQL = `
  SELECT edge.id, edge.energy_flow_model_id AS energyFlowModelId, edge.edge_code AS edgeCode,
         edge.from_node_id AS fromNodeId, from_node.node_code AS fromNodeCode, from_node.node_name AS fromNodeName,
         edge.to_node_id AS toNodeId, to_node.node_code AS toNodeCode, to_node.node_name AS toNodeName,
         edge.energy_type_id AS energyTypeId, energy_type.code AS energyTypeCode,
         energy_type.name AS energyTypeName, energy_type.standard_unit AS standardUnit,
         edge.unit, edge.source_type AS sourceType, edge.source_mapping_json AS sourceMappingJson,
         edge.status, edge.source_batch_id AS sourceBatchId, edge.source_row_number AS sourceRowNumber,
         edge.created_at AS createdAt, edge.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM energy_flow_records record WHERE record.energy_flow_edge_id = edge.id) AS recordCount
  FROM energy_flow_edges edge
  JOIN energy_flow_nodes from_node ON from_node.id = edge.from_node_id
  JOIN energy_flow_nodes to_node ON to_node.id = edge.to_node_id
  JOIN energy_types energy_type ON energy_type.id = edge.energy_type_id`;

/**
 * 读取能流模型，不存在时抛出 404。
 * @param {object} db SQLite 连接。
 * @param {*} modelId 模型 ID。
 * @returns {object} 模型。
 */
function requireModel(db, modelId) {
  const id = parsePositiveInteger(modelId, 'modelId', { required: true });
  const row = db.prepare(`${MODEL_SELECT_SQL} WHERE model.id = ?`).get(id);
  if (!row) throw notFound('能流模型不存在。', { id });
  return mapModelRow(row);
}

/**
 * 读取模型内节点，不存在或归属不符时抛出 404。
 * @param {object} db SQLite 连接。
 * @param {*} modelId 模型 ID。
 * @param {*} nodeId 节点 ID。
 * @returns {object} 节点。
 */
function requireNode(db, modelId, nodeId) {
  const normalizedModelId = parsePositiveInteger(modelId, 'modelId', { required: true });
  const normalizedNodeId = parsePositiveInteger(nodeId, 'nodeId', { required: true });
  const row = db.prepare(`${NODE_SELECT_SQL} WHERE node.energy_flow_model_id = ? AND node.id = ?`).get(normalizedModelId, normalizedNodeId);
  if (!row) throw notFound('能流节点不存在或不属于指定模型。', { modelId: normalizedModelId, nodeId: normalizedNodeId });
  return mapNodeRow(row);
}

/**
 * 读取模型内边，不存在或归属不符时抛出 404。
 * @param {object} db SQLite 连接。
 * @param {*} modelId 模型 ID。
 * @param {*} edgeId 边 ID。
 * @returns {object} 边。
 */
function requireEdge(db, modelId, edgeId) {
  const normalizedModelId = parsePositiveInteger(modelId, 'modelId', { required: true });
  const normalizedEdgeId = parsePositiveInteger(edgeId, 'edgeId', { required: true });
  const row = db.prepare(`${EDGE_SELECT_SQL} WHERE edge.energy_flow_model_id = ? AND edge.id = ?`).get(normalizedModelId, normalizedEdgeId);
  if (!row) throw notFound('能流边不存在或不属于指定模型。', { modelId: normalizedModelId, edgeId: normalizedEdgeId });
  return mapEdgeRow(row);
}

/**
 * 查询能流模型列表。
 * @param {object} query 查询条件。
 * @param {object} options 依赖注入选项。
 * @returns {{rows:object[],pagination:object}} 分页结果。
 */
function listEnergyFlowModels(query = {}, options = {}) {
  const pagination = normalizePagination(query);
  const status = normalizeOptionalStatus(query.status);
  const keyword = normalizeText(query.keyword || query.search);
  const modelCode = normalizeText(query.modelCode);
  const version = normalizeText(query.version);
  const where = [];
  const params = { limit: pagination.pageSize, offset: pagination.offset };
  if (status) { where.push('model.status = @status'); params.status = status; }
  if (modelCode) { where.push('model.model_code = @modelCode'); params.modelCode = modelCode; }
  if (version) { where.push('model.version = @version'); params.version = version; }
  if (keyword) {
    where.push('(model.model_code LIKE @keyword OR model.model_name LIKE @keyword OR model.source LIKE @keyword OR COALESCE(model.document_no, \'\') LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const databaseContext = openServiceDatabase(options);
  try {
    const total = Number(databaseContext.db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_models model ${whereSql}`).get(params).total);
    const rows = databaseContext.db.prepare(`${MODEL_SELECT_SQL} ${whereSql} ORDER BY model.updated_at DESC, model.id DESC LIMIT @limit OFFSET @offset`).all(params).map(mapModelRow);
    return {
      rows,
      pagination: { page: pagination.page, pageSize: pagination.pageSize, total, totalPages: Math.ceil(total / pagination.pageSize) }
    };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 查询单个能流模型详情。
 * @param {*} modelId 模型 ID。
 * @param {object} options 依赖注入选项。
 * @returns {object} 模型详情。
 */
function getEnergyFlowModel(modelId, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return requireModel(databaseContext.db, modelId);
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 校验模型新增或修改载荷。
 * @param {object} input 输入载荷。
 * @param {object|null} existing 已有模型。
 * @returns {object} 规范载荷。
 */
function normalizeModelPayload(input = {}, existing = null) {
  const modelCode = existing ? existing.modelCode : normalizeIdentity(input.modelCode, 'modelCode');
  const version = existing ? existing.version : normalizeIdentity(input.version, 'version');
  if (existing && input.modelCode !== undefined && normalizeIdentity(input.modelCode, 'modelCode') !== existing.modelCode) {
    throw badRequest('模型编码是版本追溯标识，创建后不可修改；请新建模型版本。', { code: 'ENERGY_FLOW_MODEL_IDENTITY_IMMUTABLE', fieldName: 'modelCode' });
  }
  if (existing && input.version !== undefined && normalizeIdentity(input.version, 'version') !== existing.version) {
    throw badRequest('模型版本创建后不可修改；请新建模型版本。', { code: 'ENERGY_FLOW_MODEL_IDENTITY_IMMUTABLE', fieldName: 'version' });
  }
  if (existing) {
    const immutableFields = [
      ['source', input.source === undefined ? undefined : normalizeText(input.source), existing.source],
      ['documentNo', input.documentNo === undefined ? undefined : normalizeText(input.documentNo), existing.documentNo],
      ['effectiveStartUtc', input.effectiveStartUtc === undefined ? undefined : normalizeText(input.effectiveStartUtc), existing.effectiveStartUtc],
      ['effectiveEndUtc', input.effectiveEndUtc === undefined ? undefined : normalizeText(input.effectiveEndUtc), existing.effectiveEndUtc],
      ['sourceTimeZone', input.sourceTimeZone === undefined ? undefined : normalizeText(input.sourceTimeZone), existing.sourceTimeZone]
    ];
    const changedField = immutableFields.find(([_fieldName, nextValue, currentValue]) => nextValue !== undefined && nextValue !== currentValue);
    if (changedField) {
      throw badRequest('模型来源、文号、有效期和来源时区属于版本追溯口径，创建后不可修改；请新建模型版本。', {
        code: 'ENERGY_FLOW_MODEL_PROVENANCE_IMMUTABLE',
        fieldName: changedField[0]
      });
    }
  }
  const modelName = normalizeText(input.modelName) || existing?.modelName;
  const source = normalizeText(input.source) || existing?.source;
  if (!modelName) throw badRequest('modelName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'modelName' });
  if (!source) throw badRequest('source 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'source' });
  const effectiveStartUtc = normalizeText(input.effectiveStartUtc) || existing?.effectiveStartUtc;
  const effectiveEndUtc = normalizeText(input.effectiveEndUtc) || existing?.effectiveEndUtc;
  normalizeUtcRange(effectiveStartUtc, effectiveEndUtc, 'effectiveStartUtc', 'effectiveEndUtc');
  const sourceTimeZone = normalizeText(input.sourceTimeZone) || existing?.sourceTimeZone;
  if (!isIanaTimeZone(sourceTimeZone)) {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', { code: 'INVALID_SOURCE_TIME_ZONE', fieldName: 'sourceTimeZone' });
  }
  const status = normalizeText(input.status) || existing?.status || 'active';
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  return {
    modelCode,
    modelName,
    source,
    documentNo: input.documentNo !== undefined ? normalizeText(input.documentNo) : (existing?.documentNo || null),
    version,
    effectiveStartUtc,
    effectiveEndUtc,
    sourceTimeZone,
    status
  };
}

/**
 * 新增可追溯能流模型版本。
 * @param {object} input 模型载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 新模型。
 */
function createEnergyFlowModel(input = {}, options = {}) {
  const payload = normalizeModelPayload(input);
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const duplicate = databaseContext.db.prepare('SELECT id FROM energy_flow_models WHERE model_code = ? AND version = ?').get(payload.modelCode, payload.version);
      if (duplicate) throw badRequest('相同模型编码和版本已存在。', { code: 'DUPLICATE_ENERGY_FLOW_MODEL_VERSION' });
      const result = databaseContext.db.prepare(
        `INSERT INTO energy_flow_models (
           model_code, model_name, source, document_no, version,
           effective_start_utc, effective_end_utc, source_timezone, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        payload.modelCode, payload.modelName, payload.source, payload.documentNo, payload.version,
        payload.effectiveStartUtc, payload.effectiveEndUtc, payload.sourceTimeZone, payload.status
      );
      return requireModel(databaseContext.db, Number(result.lastInsertRowid));
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 修改模型非身份字段。
 * @param {*} modelId 模型 ID。
 * @param {object} input 修改载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后模型。
 */
function updateEnergyFlowModel(modelId, input = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const existing = requireModel(databaseContext.db, modelId);
      const payload = normalizeModelPayload(input, existing);
      databaseContext.db.prepare(
        `UPDATE energy_flow_models
         SET model_name = ?, source = ?, document_no = ?, effective_start_utc = ?,
             effective_end_utc = ?, source_timezone = ?, status = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(
        payload.modelName, payload.source, payload.documentNo, payload.effectiveStartUtc,
        payload.effectiveEndUtc, payload.sourceTimeZone, payload.status, existing.id
      );
      return requireModel(databaseContext.db, existing.id);
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 启用或停用模型，不执行物理删除。
 * @param {*} modelId 模型 ID。
 * @param {*} statusValue 目标状态或含 status 的对象。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后模型。
 */
function setEnergyFlowModelStatus(modelId, statusValue, options = {}) {
  const status = normalizeText(typeof statusValue === 'object' ? statusValue?.status : statusValue);
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  return updateEnergyFlowModel(modelId, { status }, options);
}

/**
 * 查询模型节点列表。
 * @param {*} modelId 模型 ID。
 * @param {object} query 查询条件。
 * @param {object} options 依赖注入选项。
 * @returns {{rows:object[],pagination:object}} 分页节点。
 */
function listEnergyFlowNodes(modelId, query = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    const model = requireModel(databaseContext.db, modelId);
    const pagination = normalizePagination(query);
    const status = normalizeOptionalStatus(query.status);
    const nodeType = normalizeText(query.nodeType);
    if (nodeType) assertWhitelist(nodeType, 'nodeType', ENERGY_FLOW_NODE_TYPES);
    const keyword = normalizeText(query.keyword || query.search);
    const where = ['node.energy_flow_model_id = @modelId'];
    const params = { modelId: model.id, limit: pagination.pageSize, offset: pagination.offset };
    if (status) { where.push('node.status = @status'); params.status = status; }
    if (nodeType) { where.push('node.node_type = @nodeType'); params.nodeType = nodeType; }
    if (keyword) { where.push('(node.node_code LIKE @keyword OR node.node_name LIKE @keyword)'); params.keyword = `%${keyword}%`; }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number(databaseContext.db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_nodes node ${whereSql}`).get(params).total);
    const rows = databaseContext.db.prepare(`${NODE_SELECT_SQL} ${whereSql} ORDER BY node.id LIMIT @limit OFFSET @offset`).all(params).map(mapNodeRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total, totalPages: Math.ceil(total / pagination.pageSize) } };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 解析可空组织 ID并校验组织存在。
 * @param {object} db SQLite 连接。
 * @param {*} value 组织 ID。
 * @returns {number|null} 组织 ID。
 */
function resolveOptionalOrganizationId(db, value) {
  if (value === null || value === '') return null;
  const organizationUnitId = parsePositiveInteger(value, 'organizationUnitId');
  if (organizationUnitId === undefined) return null;
  const organization = db.prepare('SELECT id, status FROM organization_units WHERE id = ?').get(organizationUnitId);
  if (!organization) throw notFound('用能单元不存在。', { id: organizationUnitId });
  return organizationUnitId;
}

/**
 * 校验节点新增或修改载荷。
 * @param {object} db SQLite 连接。
 * @param {object} input 输入载荷。
 * @param {object|null} existing 已有节点。
 * @returns {object} 规范节点载荷。
 */
function normalizeNodePayload(db, input = {}, existing = null) {
  const nodeCode = input.nodeCode !== undefined ? normalizeIdentity(input.nodeCode, 'nodeCode') : existing?.nodeCode;
  if (!nodeCode) throw badRequest('nodeCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'nodeCode' });
  const nodeName = normalizeText(input.nodeName) || existing?.nodeName;
  if (!nodeName) throw badRequest('nodeName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'nodeName' });
  const nodeType = normalizeText(input.nodeType) || existing?.nodeType;
  assertWhitelist(nodeType, 'nodeType', ENERGY_FLOW_NODE_TYPES);
  const organizationUnitId = input.organizationUnitId !== undefined
    ? resolveOptionalOrganizationId(db, input.organizationUnitId)
    : (existing?.organizationUnitId || null);
  const x = input.x !== undefined ? parseFiniteNumber(input.x, 'x', { required: true }) : existing?.x;
  const y = input.y !== undefined ? parseFiniteNumber(input.y, 'y', { required: true }) : existing?.y;
  const status = normalizeText(input.status) || existing?.status || 'active';
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  return { nodeCode, nodeName, nodeType, organizationUnitId, x, y, status };
}

/**
 * 新增模型节点。
 * @param {*} modelId 模型 ID。
 * @param {object} input 节点载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 新节点。
 */
function createEnergyFlowNode(modelId, input = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const model = requireModel(databaseContext.db, modelId);
      const payload = normalizeNodePayload(databaseContext.db, input);
      const duplicate = databaseContext.db.prepare('SELECT id FROM energy_flow_nodes WHERE energy_flow_model_id = ? AND node_code = ?').get(model.id, payload.nodeCode);
      if (duplicate) throw badRequest('模型内节点编码已存在。', { code: 'DUPLICATE_ENERGY_FLOW_NODE_CODE' });
      const result = databaseContext.db.prepare(
        `INSERT INTO energy_flow_nodes (
           energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(model.id, payload.nodeCode, payload.nodeName, payload.nodeType, payload.organizationUnitId, payload.x, payload.y, payload.status);
      return requireNode(databaseContext.db, model.id, Number(result.lastInsertRowid));
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 修改模型节点；已被边引用时节点编码保持不可变。
 * @param {*} modelId 模型 ID。
 * @param {*} nodeId 节点 ID。
 * @param {object} input 修改载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后节点。
 */
function updateEnergyFlowNode(modelId, nodeId, input = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const existing = requireNode(databaseContext.db, modelId, nodeId);
      const payload = normalizeNodePayload(databaseContext.db, input, existing);
      const referenceCount = Number(databaseContext.db.prepare(
        'SELECT COUNT(*) AS total FROM energy_flow_edges WHERE from_node_id = ? OR to_node_id = ?'
      ).get(existing.id, existing.id).total);
      if (referenceCount > 0 && payload.nodeCode !== existing.nodeCode) {
        throw badRequest('节点已被物理边引用，节点编码不可修改。', { code: 'ENERGY_FLOW_NODE_CODE_IMMUTABLE' });
      }
      if (referenceCount > 0 && (payload.nodeType !== existing.nodeType || payload.organizationUnitId !== existing.organizationUnitId)) {
        throw badRequest('节点已被物理边引用，节点类型和组织关联不可重写；请新建模型版本。', {
          code: 'ENERGY_FLOW_NODE_BINDING_IMMUTABLE'
        });
      }
      const duplicate = databaseContext.db.prepare(
        'SELECT id FROM energy_flow_nodes WHERE energy_flow_model_id = ? AND node_code = ? AND id <> ?'
      ).get(existing.energyFlowModelId, payload.nodeCode, existing.id);
      if (duplicate) throw badRequest('模型内节点编码已存在。', { code: 'DUPLICATE_ENERGY_FLOW_NODE_CODE' });
      databaseContext.db.prepare(
        `UPDATE energy_flow_nodes
         SET node_code = ?, node_name = ?, node_type = ?, organization_unit_id = ?, x = ?, y = ?, status = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(payload.nodeCode, payload.nodeName, payload.nodeType, payload.organizationUnitId, payload.x, payload.y, payload.status, existing.id);
      return requireNode(databaseContext.db, existing.energyFlowModelId, existing.id);
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 启用或停用节点；被 active 边引用的节点不能停用。
 * @param {*} modelId 模型 ID。
 * @param {*} nodeId 节点 ID。
 * @param {*} statusValue 目标状态或对象。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后节点。
 */
function setEnergyFlowNodeStatus(modelId, nodeId, statusValue, options = {}) {
  const status = normalizeText(typeof statusValue === 'object' ? statusValue?.status : statusValue);
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const existing = requireNode(databaseContext.db, modelId, nodeId);
      if (status === 'inactive') {
        const activeEdge = databaseContext.db.prepare(
          `SELECT id FROM energy_flow_edges
           WHERE energy_flow_model_id = ? AND status = 'active' AND (from_node_id = ? OR to_node_id = ?)
           LIMIT 1`
        ).get(existing.energyFlowModelId, existing.id, existing.id);
        if (activeEdge) throw badRequest('节点仍被 active 物理边引用，需先停用相关边。', { code: 'ENERGY_FLOW_NODE_HAS_ACTIVE_EDGES' });
      }
      databaseContext.db.prepare(
        `UPDATE energy_flow_nodes
         SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(status, existing.id);
      return requireNode(databaseContext.db, existing.energyFlowModelId, existing.id);
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 查询模型边列表。
 * @param {*} modelId 模型 ID。
 * @param {object} query 查询条件。
 * @param {object} options 依赖注入选项。
 * @returns {{rows:object[],pagination:object}} 分页边。
 */
function listEnergyFlowEdges(modelId, query = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    const model = requireModel(databaseContext.db, modelId);
    const pagination = normalizePagination(query);
    const status = normalizeOptionalStatus(query.status);
    const sourceType = normalizeText(query.sourceType);
    if (sourceType) assertWhitelist(sourceType, 'sourceType', ENERGY_FLOW_SOURCE_TYPES);
    const energyTypeCode = normalizeText(query.energyTypeCode);
    const keyword = normalizeText(query.keyword || query.search);
    const where = ['edge.energy_flow_model_id = @modelId'];
    const params = { modelId: model.id, limit: pagination.pageSize, offset: pagination.offset };
    if (status) { where.push('edge.status = @status'); params.status = status; }
    if (sourceType) { where.push('edge.source_type = @sourceType'); params.sourceType = sourceType; }
    if (energyTypeCode) { where.push('energy_type.code = @energyTypeCode'); params.energyTypeCode = energyTypeCode; }
    if (keyword) { where.push('(edge.edge_code LIKE @keyword OR from_node.node_code LIKE @keyword OR to_node.node_code LIKE @keyword)'); params.keyword = `%${keyword}%`; }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number(databaseContext.db.prepare(
      `SELECT COUNT(*) AS total FROM energy_flow_edges edge
       JOIN energy_types energy_type ON energy_type.id = edge.energy_type_id
       JOIN energy_flow_nodes from_node ON from_node.id = edge.from_node_id
       JOIN energy_flow_nodes to_node ON to_node.id = edge.to_node_id ${whereSql}`
    ).get(params).total);
    const rows = databaseContext.db.prepare(`${EDGE_SELECT_SQL} ${whereSql} ORDER BY edge.id LIMIT @limit OFFSET @offset`).all(params).map(mapEdgeRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total, totalPages: Math.ceil(total / pagination.pageSize) } };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 解析 active 能源类型。
 * @param {object} db SQLite 连接。
 * @param {object} input 输入载荷。
 * @param {object|null} existing 已有边。
 * @returns {object} 能源类型。
 */
function resolveEnergyType(db, input, existing = null) {
  const energyTypeId = input.energyTypeId !== undefined
    ? parsePositiveInteger(input.energyTypeId, 'energyTypeId', { required: true })
    : existing?.energyTypeId;
  const energyTypeCode = normalizeText(input.energyTypeCode);
  const row = energyTypeId
    ? db.prepare('SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types WHERE id = ?').get(energyTypeId)
    : energyTypeCode
      ? db.prepare('SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types WHERE code = ?').get(energyTypeCode)
      : null;
  if (!row) throw notFound('能源类型不存在。', { energyTypeId: energyTypeId || null, energyTypeCode: energyTypeCode || null });
  if (Number(row.isActive) !== 1) throw badRequest('能源类型已停用。', { code: 'ENERGY_TYPE_INACTIVE' });
  return { ...row, id: Number(row.id) };
}

/**
 * 校验边单位与能源类型标准化口径兼容。
 * @param {object} energyType 能源类型。
 * @param {string} unit 单位。
 * @returns {string} 单位。
 */
function validateEnergyUnit(energyType, unit) {
  const normalizedUnit = normalizeText(unit);
  if (!normalizedUnit) throw badRequest('unit 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unit' });
  const normalized = normalizeUnitAndValue(energyType.code, normalizedUnit, 1);
  if (!normalized || String(normalized.normalizedUnit).toLowerCase() !== String(energyType.standardUnit).toLowerCase()) {
    throw badRequest('单位与能源类型不可比较。', { code: 'ENERGY_FLOW_UNIT_INCOMPATIBLE', energyTypeCode: energyType.code, unit: normalizedUnit });
  }
  return normalizedUnit;
}

/**
 * 将兼容能源数值换算到边配置单位，保留原单位分面而不直接折标。
 * @param {string} energyTypeCode 能源类型编码。
 * @param {string} sourceUnit 来源单位。
 * @param {number} sourceValue 来源数值。
 * @param {string} targetUnit 目标边单位。
 * @returns {{unit:string,value:number,normalizedUnit:string,normalizedValue:number}|null} 换算结果。
 */
function convertEnergyValueToUnit(energyTypeCode, sourceUnit, sourceValue, targetUnit) {
  const source = normalizeUnitAndValue(energyTypeCode, sourceUnit, Number(sourceValue));
  const targetScale = normalizeUnitAndValue(energyTypeCode, targetUnit, 1);
  if (!source || !targetScale || !Number.isFinite(Number(source.normalizedValue))
    || !Number.isFinite(Number(targetScale.normalizedValue)) || Number(targetScale.normalizedValue) === 0
    || String(source.normalizedUnit).toLowerCase() !== String(targetScale.normalizedUnit).toLowerCase()) {
    return null;
  }
  return {
    unit: targetUnit,
    value: Number(source.normalizedValue) / Number(targetScale.normalizedValue),
    normalizedUnit: source.normalizedUnit,
    normalizedValue: Number(source.normalizedValue)
  };
}

/**
 * 校验来源映射至少包含 reference，并返回稳定 JSON。
 * @param {*} value 来源映射。
 * @param {string} sourceType 来源类型。
 * @returns {string} JSON 文本。
 */
function normalizeSourceMappingJson(value, sourceType) {
  const mapping = parseJsonObject(value);
  if (!mapping || !normalizeText(mapping.reference)) {
    throw badRequest('sourceMapping 必须是包含非空 reference 的对象。', { code: 'TOPOLOGY_SOURCE_UNMAPPED' });
  }
  const analysisProbe = resolveSourceMapping({ sourceType, sourceMappingJson: stableJson(mapping) });
  if (!analysisProbe.valid) {
    throw badRequest('来源映射缺少该来源类型所需的显式选择器。', {
      code: 'TOPOLOGY_SOURCE_UNMAPPED',
      configurationErrors: analysisProbe.configurationErrors
    });
  }
  return stableJson(analysisProbe.mapping);
}

/**
 * 校验边新增或修改载荷。
 * @param {object} db SQLite 连接。
 * @param {number} modelId 模型 ID。
 * @param {object} input 输入载荷。
 * @param {object|null} existing 已有边。
 * @returns {object} 规范边载荷。
 */
function normalizeEdgePayload(db, modelId, input = {}, existing = null) {
  const edgeCode = input.edgeCode !== undefined ? normalizeIdentity(input.edgeCode, 'edgeCode') : existing?.edgeCode;
  if (!edgeCode) throw badRequest('edgeCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'edgeCode' });
  const fromNodeId = input.fromNodeId !== undefined ? parsePositiveInteger(input.fromNodeId, 'fromNodeId', { required: true }) : existing?.fromNodeId;
  const toNodeId = input.toNodeId !== undefined ? parsePositiveInteger(input.toNodeId, 'toNodeId', { required: true }) : existing?.toNodeId;
  if (Number(fromNodeId) === Number(toNodeId)) throw badRequest('能流边禁止自环。', { code: 'ENERGY_FLOW_SELF_LOOP_UNSUPPORTED' });
  const fromNode = requireNode(db, modelId, fromNodeId);
  const toNode = requireNode(db, modelId, toNodeId);
  if (fromNode.status !== 'active' || toNode.status !== 'active') {
    throw badRequest('能流边端点必须为 active 节点。', { code: 'ENERGY_FLOW_EDGE_ENDPOINT_INACTIVE' });
  }
  const energyType = resolveEnergyType(db, input, existing);
  const unit = input.unit !== undefined ? validateEnergyUnit(energyType, input.unit) : existing?.unit;
  const sourceType = normalizeText(input.sourceType) || existing?.sourceType;
  assertWhitelist(sourceType, 'sourceType', ENERGY_FLOW_SOURCE_TYPES);
  if (!existing && input.sourceMapping === undefined) {
    throw badRequest('sourceMapping 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'sourceMapping' });
  }
  const sourceMappingJson = input.sourceMapping !== undefined
    ? normalizeSourceMappingJson(input.sourceMapping, sourceType)
    : normalizeSourceMappingJson(existing?.sourceMapping, sourceType);
  const status = normalizeText(input.status) || existing?.status || 'active';
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  return { edgeCode, fromNodeId, toNodeId, energyType, unit, sourceType, sourceMappingJson, status };
}

/**
 * 检查模型内是否存在相同物理端点、能源分面和来源映射的重复边。
 * @param {object} db SQLite 连接。
 * @param {number} modelId 模型 ID。
 * @param {object} payload 边载荷。
 * @param {number|null} excludeId 排除边 ID。
 */
function assertNoDuplicateEdge(db, modelId, payload, excludeId = null) {
  const rows = db.prepare(
    `SELECT id, source_mapping_json AS sourceMappingJson
     FROM energy_flow_edges
     WHERE energy_flow_model_id = ? AND from_node_id = ? AND to_node_id = ?
       AND energy_type_id = ? AND lower(unit) = lower(?) AND source_type = ?
       AND (? IS NULL OR id <> ?)`
  ).all(modelId, payload.fromNodeId, payload.toNodeId, payload.energyType.id, payload.unit, payload.sourceType, excludeId, excludeId);
  if (rows.some((row) => stableJson(parseJsonObject(row.sourceMappingJson)) === payload.sourceMappingJson)) {
    throw badRequest('相同端点、能源分面和来源映射的边已存在。', { code: 'DUPLICATE_ENERGY_FLOW_EDGE' });
  }
}

/**
 * 新增显式物理能流边。
 * @param {*} modelId 模型 ID。
 * @param {object} input 边载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 新边。
 */
function createEnergyFlowEdge(modelId, input = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const model = requireModel(databaseContext.db, modelId);
      const payload = normalizeEdgePayload(databaseContext.db, model.id, input);
      const duplicateCode = databaseContext.db.prepare('SELECT id FROM energy_flow_edges WHERE energy_flow_model_id = ? AND edge_code = ?').get(model.id, payload.edgeCode);
      if (duplicateCode) throw badRequest('模型内边编码已存在。', { code: 'DUPLICATE_ENERGY_FLOW_EDGE_CODE' });
      assertNoDuplicateEdge(databaseContext.db, model.id, payload);
      const result = databaseContext.db.prepare(
        `INSERT INTO energy_flow_edges (
           energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
           unit, source_type, source_mapping_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(model.id, payload.edgeCode, payload.fromNodeId, payload.toNodeId, payload.energyType.id, payload.unit, payload.sourceType, payload.sourceMappingJson, payload.status);
      return requireEdge(databaseContext.db, model.id, Number(result.lastInsertRowid));
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 修改能流边；已有边值时物理范围和来源绑定不可重写。
 * @param {*} modelId 模型 ID。
 * @param {*} edgeId 边 ID。
 * @param {object} input 修改载荷。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后边。
 */
function updateEnergyFlowEdge(modelId, edgeId, input = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const existing = requireEdge(databaseContext.db, modelId, edgeId);
      const payload = normalizeEdgePayload(databaseContext.db, existing.energyFlowModelId, input, existing);
      const duplicateCode = databaseContext.db.prepare(
        'SELECT id FROM energy_flow_edges WHERE energy_flow_model_id = ? AND edge_code = ? AND id <> ?'
      ).get(existing.energyFlowModelId, payload.edgeCode, existing.id);
      if (duplicateCode) throw badRequest('模型内边编码已存在。', { code: 'DUPLICATE_ENERGY_FLOW_EDGE_CODE' });
      const hasRecords = Number(existing.recordCount || 0) > 0;
      if (hasRecords && payload.edgeCode !== existing.edgeCode) {
        throw badRequest('边已有可追溯边值，边编码不可修改；请新建边或模型版本。', {
          code: 'ENERGY_FLOW_EDGE_CODE_IMMUTABLE'
        });
      }
      const bindingChanged = payload.fromNodeId !== existing.fromNodeId
        || payload.toNodeId !== existing.toNodeId
        || payload.energyType.id !== existing.energyTypeId
        || payload.unit.toLowerCase() !== existing.unit.toLowerCase()
        || payload.sourceType !== existing.sourceType
        || payload.sourceMappingJson !== stableJson(existing.sourceMapping);
      if (hasRecords && bindingChanged) {
        throw badRequest('边已有可追溯边值，物理端点、能源分面和来源映射不可重写；请新建边。', { code: 'ENERGY_FLOW_EDGE_BINDING_IMMUTABLE' });
      }
      assertNoDuplicateEdge(databaseContext.db, existing.energyFlowModelId, payload, existing.id);
      databaseContext.db.prepare(
        `UPDATE energy_flow_edges
         SET edge_code = ?, from_node_id = ?, to_node_id = ?, energy_type_id = ?, unit = ?,
             source_type = ?, source_mapping_json = ?, status = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(payload.edgeCode, payload.fromNodeId, payload.toNodeId, payload.energyType.id, payload.unit, payload.sourceType, payload.sourceMappingJson, payload.status, existing.id);
      return requireEdge(databaseContext.db, existing.energyFlowModelId, existing.id);
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 启用或停用边，不物理删除边或历史记录。
 * @param {*} modelId 模型 ID。
 * @param {*} edgeId 边 ID。
 * @param {*} statusValue 目标状态或对象。
 * @param {object} options 依赖注入选项。
 * @returns {object} 修改后边。
 */
function setEnergyFlowEdgeStatus(modelId, edgeId, statusValue, options = {}) {
  const status = normalizeText(typeof statusValue === 'object' ? statusValue?.status : statusValue);
  assertWhitelist(status, 'status', ENERGY_FLOW_CONFIG_STATUSES);
  const databaseContext = openServiceDatabase(options);
  try {
    return executeBusinessWrite(databaseContext.db, options, () => {
      const existing = requireEdge(databaseContext.db, modelId, edgeId);
      // 停用用于隔离不完整或历史配置，不能因映射缺陷阻止风险收敛；重新启用前必须通过完整校验。
      if (status === 'active') {
        const mappingCheck = resolveSourceMapping({
          sourceType: existing.sourceType,
          sourceMappingJson: existing._sourceMappingJson || stableJson(existing.sourceMapping)
        });
        if (!mappingCheck.valid) {
          throw badRequest('来源映射未通过显式选择器校验，不能重新启用。', {
            code: 'TOPOLOGY_SOURCE_UNMAPPED',
            configurationErrors: mappingCheck.configurationErrors
          });
        }
        normalizeEdgePayload(databaseContext.db, existing.energyFlowModelId, { status }, existing);
      }
      databaseContext.db.prepare(
        `UPDATE energy_flow_edges
         SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(status, existing.id);
      return requireEdge(databaseContext.db, existing.energyFlowModelId, existing.id);
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 读取完整显式拓扑。
 * @param {*} modelId 模型 ID。
 * @param {object} query 查询选项。
 * @param {object} options 依赖注入选项。
 * @returns {object} 模型、节点、边和拓扑质量。
 */
function getEnergyFlowTopology(modelId, query = {}, options = {}) {
  const databaseContext = openServiceDatabase(options);
  try {
    const model = requireModel(databaseContext.db, modelId);
    const includeInactive = String(query.includeInactive || '').toLowerCase() === 'true';
    const statusSql = includeInactive ? '' : " AND node.status = 'active'";
    const edgeStatusSql = includeInactive ? '' : " AND edge.status = 'active'";
    const nodes = databaseContext.db.prepare(
      `${NODE_SELECT_SQL} WHERE node.energy_flow_model_id = ?${statusSql} ORDER BY node.id LIMIT ${MAX_TOPOLOGY_NODES + 1}`
    ).all(model.id).map(mapNodeRow);
    const edges = databaseContext.db.prepare(
      `${EDGE_SELECT_SQL} WHERE edge.energy_flow_model_id = ?${edgeStatusSql} ORDER BY edge.id LIMIT ${MAX_TOPOLOGY_EDGES + 1}`
    ).all(model.id).map(mapEdgeRow);
    if (nodes.length > MAX_TOPOLOGY_NODES || edges.length > MAX_TOPOLOGY_EDGES) {
      throw badRequest('完整拓扑超过单次查询上限，请按模型版本拆分物理拓扑。', {
        code: 'ENERGY_FLOW_TOPOLOGY_LIMIT_EXCEEDED',
        maxNodes: MAX_TOPOLOGY_NODES,
        maxEdges: MAX_TOPOLOGY_EDGES
      });
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    const anomalies = [];
    edges.forEach((edge) => {
      if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) anomalies.push({ code: 'ENERGY_FLOW_EDGE_ENDPOINT_NOT_VISIBLE', edgeId: edge.id });
      const mapping = resolveSourceMapping({ sourceType: edge.sourceType, sourceMappingJson: edge._sourceMappingJson || stableJson(edge.sourceMapping) });
      if (!mapping.valid) anomalies.push({ code: 'TOPOLOGY_SOURCE_UNMAPPED', edgeId: edge.id, configurationErrors: mapping.configurationErrors });
      const normalizedUnit = normalizeUnitAndValue(edge.energyTypeCode, edge.unit, 1);
      if (!normalizedUnit || String(normalizedUnit.normalizedUnit).toLowerCase() !== String(edge.standardUnit).toLowerCase()) {
        anomalies.push({ code: 'UNIT_NOT_COMPARABLE', edgeId: edge.id });
      }
    });
    const connectedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
    nodes.filter((node) => !connectedNodeIds.has(node.id)).forEach((node) => anomalies.push({ code: 'ENERGY_FLOW_NODE_ISOLATED', nodeId: node.id }));
    return {
      model,
      nodes,
      edges,
      quality: {
        complete: nodes.length > 0 && edges.length > 0 && anomalies.length === 0,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        anomalyCount: anomalies.length,
        anomalies
      },
      contract: {
        topologyMode: 'explicit_only',
        infersOrganizationTree: false,
        autoCreatesLossEdges: false,
        formulaVersion: ENERGY_ANALYSIS_VERSIONS.energyFlow
      }
    };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 返回两个 UTC 区间的重叠毫秒数。
 * @param {number} leftStart 左开始。
 * @param {number} leftEnd 左结束。
 * @param {number} rightStart 右开始。
 * @param {number} rightEnd 右结束。
 * @returns {number} 重叠毫秒。
 */
function overlapMilliseconds(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

/**
 * 合并区间并返回覆盖毫秒数。
 * @param {Array<{startMs:number,endMs:number}>} intervals 区间。
 * @returns {number} 覆盖毫秒。
 */
function calculateCoveredMilliseconds(intervals) {
  const sorted = intervals.filter((item) => item.startMs < item.endMs).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  sorted.forEach((item) => {
    if (currentStart === null) { currentStart = item.startMs; currentEnd = item.endMs; return; }
    if (item.startMs <= currentEnd) { currentEnd = Math.max(currentEnd, item.endMs); return; }
    total += currentEnd - currentStart;
    currentStart = item.startMs;
    currentEnd = item.endMs;
  });
  return currentStart === null ? 0 : total + currentEnd - currentStart;
}

/**
 * 判断区间列表是否存在重叠。
 * @param {Array<{startMs:number,endMs:number}>} intervals 区间。
 * @returns {boolean} 是否重叠。
 */
function hasIntervalOverlap(intervals) {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let maximumEnd = null;
  for (const item of sorted) {
    if (maximumEnd !== null && item.startMs < maximumEnd) return true;
    maximumEnd = maximumEnd === null ? item.endMs : Math.max(maximumEnd, item.endMs);
  }
  return false;
}

/**
 * 构造边值不可用结果。
 * @param {object} edge 边。
 * @param {string} status 质量状态。
 * @param {string[]} reasonCodes 原因码。
 * @param {string[]} configurationErrors 配置错误。
 * @param {object} extra 附加字段。
 * @returns {object} 边值结果。
 */
function createUnavailableEdgeValue(edge, status, reasonCodes, configurationErrors = [], extra = {}) {
  return {
    edgeId: edge.id,
    edgeCode: edge.edgeCode,
    fromNodeId: edge.fromNodeId,
    fromNodeCode: edge.fromNodeCode,
    toNodeId: edge.toNodeId,
    toNodeCode: edge.toNodeCode,
    energyTypeId: edge.energyTypeId,
    energyTypeCode: edge.energyTypeCode,
    unit: edge.unit,
    normalizedUnit: edge.standardUnit,
    sourceType: edge.sourceType,
    sourceMapping: edge.sourceMapping,
    status,
    value: null,
    observedValue: extra.observedValue ?? null,
    trueZero: false,
    coverageRate: extra.coverageRate ?? 0,
    observedRecordCount: extra.observedRecordCount ?? 0,
    sourceRecordIds: extra.sourceRecordIds || [],
    allocationUsed: extra.allocationUsed === true,
    allocationAssumption: extra.allocationUsed ? 'uniform_within_interval' : null,
    reasonCodes: [...new Set(reasonCodes)],
    configurationErrors: [...new Set(configurationErrors)]
  };
}

/**
 * 构造完整或部分边值结果。
 * @param {object} edge 边。
 * @param {number} observedValue 已观测值。
 * @param {number} coverageRate 覆盖率。
 * @param {number[]} sourceRecordIds 来源记录。
 * @param {object} extra 附加字段。
 * @returns {object} 边值结果。
 */
function createObservedEdgeValue(edge, observedValue, coverageRate, sourceRecordIds, extra = {}) {
  const complete = coverageRate >= 1 - BALANCE_ZERO_TOLERANCE;
  const roundedValue = roundAnalysisValue(observedValue);
  const result = {
    edgeId: edge.id,
    edgeCode: edge.edgeCode,
    fromNodeId: edge.fromNodeId,
    fromNodeCode: edge.fromNodeCode,
    toNodeId: edge.toNodeId,
    toNodeCode: edge.toNodeCode,
    energyTypeId: edge.energyTypeId,
    energyTypeCode: edge.energyTypeCode,
    unit: edge.unit,
    normalizedUnit: edge.standardUnit,
    sourceType: edge.sourceType,
    sourceMapping: edge.sourceMapping,
    status: complete ? 'complete' : 'partial',
    value: complete ? roundedValue : null,
    observedValue: roundedValue,
    trueZero: complete && roundedValue === 0,
    coverageRate: roundAnalysisValue(Math.min(1, Math.max(0, coverageRate))),
    observedRecordCount: sourceRecordIds.length,
    sourceRecordIds,
    allocationUsed: extra.allocationUsed === true,
    allocationAssumption: extra.allocationUsed ? 'uniform_within_interval' : null,
    reasonCodes: complete ? [] : ['COVERAGE_BELOW_THRESHOLD'],
    configurationErrors: []
  };
  // 折标分段仅供同次分析计算，不直接暴露为未固化的内部中间结构。
  Object.defineProperty(result, '_conversionSegments', {
    value: Array.isArray(extra.conversionSegments) ? extra.conversionSegments : [],
    enumerable: false
  });
  return result;
}

/**
 * 为来源 SQL 追加显式选择器条件。
 * @param {string[]} where SQL 条件。
 * @param {object} params 命名参数。
 * @param {object} mapping 来源映射。
 * @param {string} idColumn ID 列。
 */
function appendSourceSelector(where, params, mapping, idColumn = 'record.id') {
  if (mapping.recordIds) {
    const placeholders = mapping.recordIds.map((_id, index) => `@recordId${index}`);
    mapping.recordIds.forEach((id, index) => { params[`recordId${index}`] = id; });
    where.push(`${idColumn} IN (${placeholders.join(', ')})`);
  }
  if (mapping.meterDeviceId) { where.push('record.meter_device_id = @meterDeviceId'); params.meterDeviceId = mapping.meterDeviceId; }
  if (mapping.organizationUnitId) { where.push('record.organization_unit_id = @organizationUnitId'); params.organizationUnitId = mapping.organizationUnitId; }
  if (mapping.sourceTimeZone) { where.push('record.source_timezone = @sourceTimeZone'); params.sourceTimeZone = mapping.sourceTimeZone; }
}

/**
 * 解析时序或显式区间事实。
 * @param {object} edge 边。
 * @param {object[]} rows 来源记录。
 * @param {object} range 分析范围。
 * @returns {object} 边值。
 */
function aggregateIntervalRows(edge, rows, range) {
  if (rows.length > MAX_SOURCE_RECORDS) {
    return createUnavailableEdgeValue(edge, 'unavailable', [], ['SOURCE_RECORD_LIMIT_EXCEEDED'], { observedRecordCount: rows.length });
  }
  if (rows.length === 0) return createUnavailableEdgeValue(edge, 'missing', ['NO_TIMESERIES_DATA']);
  const intervals = [];
  const conversionSegments = [];
  const sourceRecordIds = [];
  let observedValue = 0;
  let allocationUsed = false;
  for (const row of rows) {
    const startMs = Date.parse(row.startUtc);
    const endMs = Date.parse(row.endUtc);
    const overlapMs = overlapMilliseconds(startMs, endMs, range.startMs, range.endMs);
    if (!(overlapMs > 0) || !(startMs < endMs)) continue;
    const converted = convertEnergyValueToUnit(edge.energyTypeCode, row.unit, Number(row.value), edge.unit);
    if (!converted || String(converted.normalizedUnit).toLowerCase() !== String(edge.standardUnit).toLowerCase()) {
      return createUnavailableEdgeValue(edge, 'unit_not_comparable', ['UNIT_NOT_COMPARABLE'], [], {
        observedRecordCount: sourceRecordIds.length,
        sourceRecordIds
      });
    }
    const durationMs = endMs - startMs;
    const allocatedValue = Number(converted.value) * overlapMs / durationMs;
    if (!Number.isFinite(allocatedValue) || !Number.isFinite(observedValue + allocatedValue)) {
      return createUnavailableEdgeValue(edge, 'unavailable', [], ['ANALYSIS_NUMERIC_OVERFLOW']);
    }
    if (overlapMs < durationMs) allocationUsed = true;
    observedValue += allocatedValue;
    sourceRecordIds.push(Number(row.id));
    const overlapStartMs = Math.max(startMs, range.startMs);
    const overlapEndMs = Math.min(endMs, range.endMs);
    intervals.push({ startMs: overlapStartMs, endMs: overlapEndMs });
    conversionSegments.push({
      startMs: overlapStartMs,
      endMs: overlapEndMs,
      value: allocatedValue,
      sourceRecordId: Number(row.id),
      splittable: true
    });
  }
  if (sourceRecordIds.length === 0) return createUnavailableEdgeValue(edge, 'missing', ['NO_TIMESERIES_DATA']);
  if (hasIntervalOverlap(intervals)) {
    return createUnavailableEdgeValue(edge, 'unavailable', ['SOURCE_OVERLAP_OR_DUPLICATE'], [], {
      observedRecordCount: sourceRecordIds.length,
      sourceRecordIds,
      allocationUsed
    });
  }
  const coverageRate = calculateCoveredMilliseconds(intervals) / (range.endMs - range.startMs);
  return createObservedEdgeValue(edge, observedValue, coverageRate, sourceRecordIds, { allocationUsed, conversionSegments });
}

/**
 * 解析 explicit_edge_value 边值。
 * @param {object} db SQLite 连接。
 * @param {object} edge 边。
 * @param {object} range 分析范围。
 * @returns {object} 边值。
 */
function resolveExplicitEdgeValue(db, edge, range) {
  const rows = db.prepare(
    `SELECT record.id, record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.original_unit AS unit, record.original_value AS value
     FROM energy_flow_records record
     WHERE record.energy_flow_model_id = ? AND record.energy_flow_edge_id = ?
       AND record.record_status = 'active' AND record.start_utc < ? AND record.end_utc > ?
     ORDER BY record.start_utc, record.end_utc, record.id
     LIMIT ${MAX_SOURCE_RECORDS + 1}`
  ).all(edge.energyFlowModelId, edge.id, range.endUtc, range.startUtc);
  return aggregateIntervalRows(edge, rows, range);
}

/**
 * 解析 timeseries 显式映射边值。
 * @param {object} db SQLite 连接。
 * @param {object} edge 边。
 * @param {object} range 分析范围。
 * @param {object} mapping 来源映射。
 * @returns {object} 边值。
 */
function resolveTimeseriesEdgeValue(db, edge, range, mapping) {
  const where = [
    "record.record_status = 'active'",
    'record.energy_type_id = @energyTypeId',
    'record.start_utc < @endUtc',
    'record.end_utc > @startUtc'
  ];
  const params = { energyTypeId: edge.energyTypeId, startUtc: range.startUtc, endUtc: range.endUtc };
  appendSourceSelector(where, params, mapping);
  const rows = db.prepare(
    `SELECT record.id, record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.normalized_unit AS unit, record.normalized_value AS value
     FROM energy_timeseries_records record
     WHERE ${where.join(' AND ')}
     ORDER BY record.start_utc, record.end_utc, record.id
     LIMIT ${MAX_SOURCE_RECORDS + 1}`
  ).all(params);
  return aggregateIntervalRows(edge, rows, range);
}

/**
 * 解析月度来源事实并区分真实零和缺月。
 * @param {object} edge 边。
 * @param {object[]} rows 来源记录。
 * @param {object} range 分析范围。
 * @param {Function} valueResolver 行值解析器。
 * @returns {object} 边值。
 */
function aggregateMonthlyRows(edge, rows, range, valueResolver) {
  if (!range.monthAligned || range.months.length === 0) {
    return createUnavailableEdgeValue(edge, 'unavailable', ['COVERAGE_BELOW_THRESHOLD'], ['MONTHLY_SOURCE_REQUIRES_MONTH_ALIGNED_RANGE']);
  }
  if (rows.length > MAX_SOURCE_RECORDS) {
    return createUnavailableEdgeValue(edge, 'unavailable', [], ['SOURCE_RECORD_LIMIT_EXCEEDED'], { observedRecordCount: rows.length });
  }
  const sourceRecordIds = [];
  const conversionSegments = [];
  const observedMonths = new Set();
  let observedValue = 0;
  for (const row of rows) {
    const resolved = valueResolver(row);
    const converted = resolved
      ? convertEnergyValueToUnit(edge.energyTypeCode, resolved.unit, resolved.value, edge.unit)
      : null;
    if (!converted || String(converted.normalizedUnit).toLowerCase() !== String(edge.standardUnit).toLowerCase()) {
      return createUnavailableEdgeValue(edge, 'unit_not_comparable', ['UNIT_NOT_COMPARABLE'], [], {
        observedRecordCount: sourceRecordIds.length,
        sourceRecordIds
      });
    }
    if (!Number.isFinite(observedValue + converted.value)) {
      return createUnavailableEdgeValue(edge, 'unavailable', [], ['ANALYSIS_NUMERIC_OVERFLOW']);
    }
    observedValue += converted.value;
    observedMonths.add(row.month);
    sourceRecordIds.push(Number(row.id));
    conversionSegments.push({
      startMs: Date.parse(`${row.month}-01T00:00:00Z`),
      endMs: Date.parse(`${nextMonth(row.month)}-01T00:00:00Z`),
      value: converted.value,
      sourceRecordId: Number(row.id),
      splittable: false
    });
  }
  if (sourceRecordIds.length === 0) return createUnavailableEdgeValue(edge, 'missing', ['NO_TIMESERIES_DATA']);
  const coverageRate = observedMonths.size / range.months.length;
  return createObservedEdgeValue(edge, observedValue, coverageRate, sourceRecordIds, { conversionSegments });
}

/**
 * 解析 monthly_energy 显式映射边值。
 * @param {object} db SQLite 连接。
 * @param {object} edge 边。
 * @param {object} range 分析范围。
 * @param {object} mapping 来源映射。
 * @returns {object} 边值。
 */
function resolveMonthlyEnergyEdgeValue(db, edge, range, mapping) {
  if (!range.monthAligned || range.months.length === 0) return aggregateMonthlyRows(edge, [], range, () => null);
  const where = [
    "record.record_status = 'active'",
    'record.energy_type_id = @energyTypeId',
    'record.normalized_month >= @startMonth',
    'record.normalized_month <= @endMonth'
  ];
  const params = { energyTypeId: edge.energyTypeId, startMonth: range.startMonth, endMonth: range.endMonth };
  appendSourceSelector(where, params, mapping);
  const rows = db.prepare(
    `SELECT record.id, record.normalized_month AS month,
            record.normalized_unit AS unit, record.normalized_value AS value
     FROM energy_records record
     WHERE ${where.join(' AND ')}
     ORDER BY record.normalized_month, record.id
     LIMIT ${MAX_SOURCE_RECORDS + 1}`
  ).all(params);
  return aggregateMonthlyRows(edge, rows, range, (row) => ({ unit: row.unit, value: Number(row.value) }));
}

/**
 * 解析 generation 显式映射边值，不自动选择发电、自用或上网角色。
 * @param {object} db SQLite 连接。
 * @param {object} edge 边。
 * @param {object} range 分析范围。
 * @param {object} mapping 来源映射。
 * @returns {object} 边值。
 */
function resolveGenerationEdgeValue(db, edge, range, mapping) {
  if (!range.monthAligned || range.months.length === 0) return aggregateMonthlyRows(edge, [], range, () => null);
  const valueColumns = {
    generation: 'record.generation_value_kwh',
    self_use: 'record.self_use_value_kwh',
    grid_export: 'record.grid_export_value_kwh'
  };
  const where = [
    "record.record_status = 'active'",
    'record.energy_type_id = @energyTypeId',
    'record.normalized_month >= @startMonth',
    'record.normalized_month <= @endMonth'
  ];
  const params = { energyTypeId: edge.energyTypeId, startMonth: range.startMonth, endMonth: range.endMonth };
  if (mapping.recordIds) {
    const placeholders = mapping.recordIds.map((_id, index) => `@recordId${index}`);
    mapping.recordIds.forEach((id, index) => { params[`recordId${index}`] = id; });
    where.push(`record.id IN (${placeholders.join(', ')})`);
  }
  if (mapping.organizationUnitId) { where.push('record.organization_unit_id = @organizationUnitId'); params.organizationUnitId = mapping.organizationUnitId; }
  const rows = db.prepare(
    `SELECT record.id, record.normalized_month AS month, 'kWh' AS unit,
            ${valueColumns[mapping.valueField]} AS value
     FROM generation_records record
     WHERE ${where.join(' AND ')}
     ORDER BY record.normalized_month, record.id
     LIMIT ${MAX_SOURCE_RECORDS + 1}`
  ).all(params);
  return aggregateMonthlyRows(edge, rows, range, (row) => ({ unit: row.unit, value: Number(row.value) }));
}

/**
 * 解析单条 active 边的值。
 * @param {object} db SQLite 连接。
 * @param {object} edge 边。
 * @param {object} range 分析范围。
 * @returns {object} 边值。
 */
function resolveEnergyFlowEdgeValue(db, edge, range) {
  const normalizedConfiguredUnit = normalizeUnitAndValue(edge.energyTypeCode, edge.unit, 1);
  if (!normalizedConfiguredUnit
    || String(normalizedConfiguredUnit.normalizedUnit).toLowerCase() !== String(edge.standardUnit).toLowerCase()) {
    return createUnavailableEdgeValue(edge, 'unit_not_comparable', ['UNIT_NOT_COMPARABLE']);
  }
  const mappingResult = resolveSourceMapping({ sourceType: edge.sourceType, sourceMappingJson: edge._sourceMappingJson || stableJson(edge.sourceMapping) });
  if (!mappingResult.valid) {
    return createUnavailableEdgeValue(edge, 'unmapped', mappingResult.reasonCodes, mappingResult.configurationErrors);
  }
  if (edge.sourceType === 'explicit_edge_value') return resolveExplicitEdgeValue(db, edge, range);
  if (edge.sourceType === 'timeseries') return resolveTimeseriesEdgeValue(db, edge, range, mappingResult.mapping);
  if (edge.sourceType === 'monthly_energy') return resolveMonthlyEnergyEdgeValue(db, edge, range, mappingResult.mapping);
  if (edge.sourceType === 'generation') return resolveGenerationEdgeValue(db, edge, range, mappingResult.mapping);
  return createUnavailableEdgeValue(edge, 'unmapped', ['TOPOLOGY_SOURCE_UNMAPPED'], ['SOURCE_TYPE_UNSUPPORTED']);
}

/**
 * 查询与能源分面和分析范围相交的 active 折标系数版本。
 * @param {object} db SQLite 连接。
 * @param {object} facet 能源分面。
 * @param {object} range 查询范围。
 * @returns {object[]} 系数版本。
 */
function loadConversionFactors(db, facet, range) {
  return db.prepare(
    `SELECT factor.id, factor.factor_code AS factorCode, factor.factor_value AS factorValue,
            factor.source_unit AS sourceUnit, factor.target_unit AS targetUnit,
            factor.source, factor.document_no AS documentNo, factor.version,
            factor.effective_start_utc AS effectiveStartUtc,
            factor.effective_end_utc AS effectiveEndUtc, factor.source_timezone AS sourceTimeZone
     FROM energy_conversion_factors factor
     WHERE factor.energy_type_id = ? AND factor.status = 'active' AND factor.target_unit = 'kgce'
       AND lower(factor.source_unit) = lower(?)
       AND factor.effective_start_utc < ? AND factor.effective_end_utc > ?
     ORDER BY factor.effective_start_utc, factor.id`
  ).all(facet.energyTypeId, facet.unit, range.endUtc, range.startUtc).map((factor) => ({
    ...factor,
    id: Number(factor.id),
    factorValue: Number(factor.factorValue),
    startMs: Date.parse(factor.effectiveStartUtc),
    endMs: Date.parse(factor.effectiveEndUtc)
  }));
}

/**
 * 构造折标不可用结果。
 * @param {string} reasonCode 稳定原因码。
 * @returns {object} 折标结果。
 */
function createUnavailableStandardCoal(reasonCode) {
  return { kgce: null, tce: null, factor: null, applications: [], reasonCodes: [reasonCode] };
}

/**
 * 按事实区间和系数有效期分段折标，月度与发电总量不在单月内部拆分。
 * @param {object} db SQLite 连接。
 * @param {object} facet 能源分面。
 * @param {object[]} segments 事实数值分段。
 * @param {object} range 查询范围。
 * @returns {object} kgce/tce 与应用系数版本明细。
 */
function convertSegmentsToStandardCoal(db, facet, segments, range) {
  if (!Array.isArray(segments) || segments.length === 0) return createUnavailableStandardCoal('MISSING_CONVERSION_FACTOR');
  const factors = loadConversionFactors(db, facet, range);
  if (factors.length === 0) return createUnavailableStandardCoal('MISSING_CONVERSION_FACTOR');
  const allocations = [];
  for (const segment of segments) {
    const segmentDuration = segment.endMs - segment.startMs;
    if (!(segmentDuration > 0) || !Number.isFinite(segment.value)) return createUnavailableStandardCoal('MISSING_CONVERSION_FACTOR');
    if (segment.splittable === false) {
      const fullMatches = factors.filter((factor) => factor.startMs <= segment.startMs && factor.endMs >= segment.endMs);
      if (fullMatches.length > 1) return createUnavailableStandardCoal('FACTOR_PERIOD_AMBIGUOUS');
      if (fullMatches.length === 0) {
        const intersections = factors.map((factor) => ({
          startMs: Math.max(segment.startMs, factor.startMs),
          endMs: Math.min(segment.endMs, factor.endMs)
        })).filter((item) => item.startMs < item.endMs);
        const coveredMs = calculateCoveredMilliseconds(intersections);
        return createUnavailableStandardCoal(coveredMs >= segmentDuration - 1
          ? 'FACTOR_PERIOD_AMBIGUOUS'
          : 'MISSING_CONVERSION_FACTOR');
      }
      allocations.push({
        factor: fullMatches[0],
        startMs: segment.startMs,
        endMs: segment.endMs,
        sourceValue: segment.value,
        sourceRecordId: segment.sourceRecordId
      });
      continue;
    }
    const boundaryValues = new Set([segment.startMs, segment.endMs]);
    factors.forEach((factor) => {
      if (factor.startMs > segment.startMs && factor.startMs < segment.endMs) boundaryValues.add(factor.startMs);
      if (factor.endMs > segment.startMs && factor.endMs < segment.endMs) boundaryValues.add(factor.endMs);
    });
    const boundaries = [...boundaryValues].sort((left, right) => left - right);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startMs = boundaries[index];
      const endMs = boundaries[index + 1];
      const matches = factors.filter((factor) => factor.startMs <= startMs && factor.endMs >= endMs);
      if (matches.length === 0) return createUnavailableStandardCoal('MISSING_CONVERSION_FACTOR');
      if (matches.length > 1) return createUnavailableStandardCoal('FACTOR_PERIOD_AMBIGUOUS');
      allocations.push({
        factor: matches[0],
        startMs,
        endMs,
        sourceValue: segment.value * (endMs - startMs) / segmentDuration,
        sourceRecordId: segment.sourceRecordId
      });
    }
  }
  const applicationByFactor = new Map();
  allocations.forEach((allocation) => {
    const current = applicationByFactor.get(allocation.factor.id) || {
      factor: {
        id: allocation.factor.id,
        factorCode: allocation.factor.factorCode,
        factorValue: allocation.factor.factorValue,
        sourceUnit: allocation.factor.sourceUnit,
        targetUnit: allocation.factor.targetUnit,
        source: allocation.factor.source,
        documentNo: allocation.factor.documentNo,
        version: allocation.factor.version,
        effectiveStartUtc: allocation.factor.effectiveStartUtc,
        effectiveEndUtc: allocation.factor.effectiveEndUtc,
        sourceTimeZone: allocation.factor.sourceTimeZone
      },
      sourceValue: 0,
      kgce: 0,
      segments: []
    };
    const kgce = allocation.sourceValue * allocation.factor.factorValue;
    current.sourceValue += allocation.sourceValue;
    current.kgce += kgce;
    current.segments.push({
      startUtc: new Date(allocation.startMs).toISOString(),
      endUtc: new Date(allocation.endMs).toISOString(),
      sourceRecordId: allocation.sourceRecordId,
      sourceValue: roundAnalysisValue(allocation.sourceValue),
      kgce: roundAnalysisValue(kgce)
    });
    applicationByFactor.set(allocation.factor.id, current);
  });
  const applications = [...applicationByFactor.values()].map((application) => ({
    ...application,
    sourceValue: roundAnalysisValue(application.sourceValue),
    kgce: roundAnalysisValue(application.kgce)
  }));
  const kgce = roundAnalysisValue(applications.reduce((sum, application) => sum + application.kgce, 0));
  return {
    kgce,
    tce: roundAnalysisValue(kgce / 1000),
    factor: applications.length === 1 ? applications[0].factor : null,
    applications,
    reasonCodes: []
  };
}

/**
 * 检测同一次分析中跨边重复占用的规范事实来源并阻止重复计入。
 * @param {object[]} edgeValues 已解析边值。
 * @returns {object[]} 重复来源摘要。
 */
function rejectReusedSourcesAcrossEdges(edgeValues) {
  const usageByKey = new Map();
  edgeValues.forEach((edge) => {
    const valueField = edge.sourceType === 'generation' ? normalizeText(edge.sourceMapping?.valueField) : null;
    [...new Set(edge.sourceRecordIds || [])].forEach((recordId) => {
      const key = edge.sourceType === 'generation'
        ? `${edge.sourceType}\0${valueField}\0${recordId}`
        : `${edge.sourceType}\0${recordId}`;
      const usage = usageByKey.get(key) || {
        sourceType: edge.sourceType,
        recordId: Number(recordId),
        valueField,
        edgeIds: []
      };
      usage.edgeIds.push(edge.edgeId);
      usageByKey.set(key, usage);
    });
  });
  const duplicates = [...usageByKey.values()].filter((usage) => new Set(usage.edgeIds).size > 1).map((usage) => ({
    ...usage,
    edgeIds: [...new Set(usage.edgeIds)].sort((left, right) => left - right)
  }));
  const duplicatedEdgeIds = new Set(duplicates.flatMap((usage) => usage.edgeIds));
  edgeValues.forEach((edge) => {
    if (!duplicatedEdgeIds.has(edge.edgeId)) return;
    edge.status = 'unavailable';
    edge.value = null;
    edge.trueZero = false;
    edge.reasonCodes = [...new Set([...(edge.reasonCodes || []), 'SOURCE_OVERLAP_OR_DUPLICATE'])];
    edge.configurationErrors = [...new Set([...(edge.configurationErrors || []), 'SOURCE_RECORD_REUSED_ACROSS_EDGES'])];
  });
  return duplicates;
}

/**
 * 将显式储能变化输入按节点和能源分面建立索引。
 * @param {*} storageChanges 原始储能变化。
 * @param {object[]} nodes 节点。
 * @returns {{byKey:Map<string,object>,errors:object[]}} 储能索引。
 */
function buildStorageChangeIndex(storageChanges, nodes) {
  const byKey = new Map();
  const errors = [];
  if (storageChanges === undefined || storageChanges === null) return { byKey, errors };
  if (!Array.isArray(storageChanges) || storageChanges.length > MAX_EXPLICIT_RECORD_IDS) {
    throw badRequest('storageChanges 必须是有限长度数组。', { code: 'INVALID_STORAGE_CHANGES' });
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeByCode = new Map(nodes.map((node) => [node.nodeCode, node]));
  storageChanges.forEach((item, index) => {
    const node = item && item.nodeId ? nodeById.get(Number(item.nodeId)) : nodeByCode.get(normalizeText(item?.nodeCode));
    const energyTypeCode = normalizeText(item?.energyTypeCode);
    const unit = normalizeText(item?.unit);
    const sourceMapping = parseJsonObject(item?.sourceMapping);
    const value = Number(item?.value);
    if (!node || !energyTypeCode || !unit || !Number.isFinite(value) || !normalizeText(sourceMapping?.reference)) {
      errors.push({ index, code: 'BALANCE_ITEM_UNMAPPED' });
      return;
    }
    const key = `${node.id}\0${energyTypeCode}\0${unit.toLowerCase()}`;
    if (byKey.has(key)) {
      errors.push({ index, code: 'DUPLICATE_STORAGE_CHANGE_FACET' });
      return;
    }
    byKey.set(key, { nodeId: node.id, energyTypeCode, unit, value, sourceMapping });
  });
  return { byKey, errors };
}

/**
 * 根据完整边值构造节点分面平衡。
 * @param {object} db SQLite 快照连接。
 * @param {object[]} nodes 节点。
 * @param {object[]} edgeValues 边值。
 * @param {Map<string,object>} storageChangeIndex 储能变化索引。
 * @param {object} range 分析范围。
 * @returns {object[]} 节点平衡结果。
 */
function buildNodeBalances(db, nodes, edgeValues, storageChangeIndex, range) {
  return nodes.map((node) => {
    const incidentEdges = edgeValues.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id);
    const facetKeys = [...new Set(incidentEdges.map((edge) => `${edge.energyTypeId}\0${edge.energyTypeCode}\0${edge.unit}`))];
    const facets = facetKeys.map((facetKey) => {
      const [energyTypeIdText, energyTypeCode, unit] = facetKey.split('\0');
      const facetEdges = incidentEdges.filter((edge) => edge.energyTypeCode === energyTypeCode && edge.unit === unit);
      const storageKey = `${node.id}\0${energyTypeCode}\0${unit.toLowerCase()}`;
      const storageInput = storageChangeIndex.get(storageKey) || null;
      const storageMissing = node.nodeType === 'storage' && !storageInput;
      const incompleteEdges = facetEdges.filter((edge) => edge.value === null);
      const observedInflow = facetEdges.filter((edge) => edge.toNodeId === node.id && Number.isFinite(edge.observedValue)).reduce((sum, edge) => sum + edge.observedValue, 0);
      const observedOutflow = facetEdges.filter((edge) => edge.fromNodeId === node.id && Number.isFinite(edge.observedValue)).reduce((sum, edge) => sum + edge.observedValue, 0);
      const edgeReasons = [...new Set(facetEdges.flatMap((edge) => edge.reasonCodes || []))];
      if (storageMissing || incompleteEdges.length > 0) {
        const reasonCodes = [...new Set([...edgeReasons, ...(storageMissing ? ['BALANCE_ITEM_UNMAPPED'] : [])])];
        return {
          energyTypeId: Number(energyTypeIdText),
          energyTypeCode,
          unit,
          status: storageMissing ? 'storage_unmapped' : 'incomplete',
          inflow: null,
          outflow: null,
          observedInflow: roundAnalysisValue(observedInflow),
          observedOutflow: roundAnalysisValue(observedOutflow),
          storageChange: storageInput ? roundAnalysisValue(storageInput.value) : (node.nodeType === 'storage' ? null : 0),
          difference: null,
          imbalanceRate: null,
          trueZero: false,
          autoClassifiedLoss: false,
          reasonCodes,
          incompleteEdgeIds: incompleteEdges.map((edge) => edge.edgeId),
          standardCoal: null
        };
      }
      const difference = calculateEnergyFlowNodeDifference({
        nodeCode: node.nodeCode,
        energyTypeCode,
        unit,
        storageChange: storageInput ? storageInput.value : 0,
        edges: facetEdges.map((edge) => ({
          fromNodeCode: edge.fromNodeCode,
          toNodeCode: edge.toNodeCode,
          energyTypeCode: edge.energyTypeCode,
          unit: edge.unit,
          value: edge.value,
          sourceMapping: edge.sourceMapping
        }))
      });
      const denominator = Math.max(Math.abs(difference.inflow || 0), Math.abs((difference.outflow || 0) + (difference.storageChange || 0)));
      const imbalanceRate = denominator <= BALANCE_ZERO_TOLERANCE
        ? (Math.abs(difference.difference || 0) <= BALANCE_ZERO_TOLERANCE ? 0 : null)
        : roundAnalysisValue(Math.abs(difference.difference) / denominator);
      const coalUnavailableEdge = facetEdges.find((edge) => !Number.isFinite(edge.standardCoal?.kgce));
      const storageCoal = storageInput ? convertSegmentsToStandardCoal(
        db,
        { energyTypeId: Number(energyTypeIdText), energyTypeCode, unit },
        [{
          startMs: range.startMs,
          endMs: range.endMs,
          value: storageInput.value,
          sourceRecordId: null,
          splittable: false
        }],
        range
      ) : { kgce: 0, tce: 0, factor: null, applications: [], reasonCodes: [] };
      let standardCoal;
      if (coalUnavailableEdge || storageCoal.kgce === null) {
        standardCoal = {
          kgce: null,
          tce: null,
          factor: null,
          applications: [],
          reasonCodes: [...new Set([
            ...(coalUnavailableEdge?.standardCoal?.reasonCodes || []),
            ...(storageCoal.reasonCodes || [])
          ])]
        };
      } else {
        const inflowKgce = roundAnalysisValue(facetEdges
          .filter((edge) => edge.toNodeId === node.id)
          .reduce((sum, edge) => sum + edge.standardCoal.kgce, 0));
        const outflowKgce = roundAnalysisValue(facetEdges
          .filter((edge) => edge.fromNodeId === node.id)
          .reduce((sum, edge) => sum + edge.standardCoal.kgce, 0));
        const roundedKgce = roundAnalysisValue(inflowKgce - outflowKgce - storageCoal.kgce);
        const kgce = Object.is(roundedKgce, -0) ? 0 : roundedKgce;
        standardCoal = {
          kgce,
          tce: roundAnalysisValue(kgce / 1000),
          inflowKgce,
          outflowKgce,
          storageChangeKgce: storageCoal.kgce,
          factor: null,
          applications: [
            ...facetEdges.flatMap((edge) => (edge.standardCoal.applications || []).map((application) => ({
              role: edge.toNodeId === node.id ? 'inflow' : 'outflow',
              edgeId: edge.edgeId,
              ...application
            }))),
            ...(storageCoal.applications || []).map((application) => ({ role: 'storage_change', edgeId: null, ...application }))
          ],
          reasonCodes: []
        };
      }
      return {
        energyTypeId: Number(energyTypeIdText),
        energyTypeCode,
        unit,
        status: difference.reasonCodes.length === 0 ? 'calculated' : 'unavailable',
        inflow: difference.inflow,
        outflow: difference.outflow,
        observedInflow: difference.inflow,
        observedOutflow: difference.outflow,
        storageChange: difference.storageChange,
        difference: difference.difference,
        imbalanceRate,
        trueZero: difference.difference === 0,
        autoClassifiedLoss: false,
        reasonCodes: difference.reasonCodes,
        incompleteEdgeIds: [],
        standardCoal
      };
    });
    return {
      nodeId: node.id,
      nodeCode: node.nodeCode,
      nodeName: node.nodeName,
      nodeType: node.nodeType,
      status: facets.length === 0 ? 'isolated' : facets.every((facet) => facet.status === 'calculated') ? 'calculated' : 'incomplete',
      facets
    };
  });
}

/**
 * 分析显式能流模型的边值、节点差额、覆盖与异常。
 * @param {*} modelId 模型 ID。
 * @param {object} input 时间范围和显式储能变化。
 * @param {object} options 依赖注入选项。
 * @returns {object} 能流分析结果。
 */
function analyzeEnergyFlow(modelId, input = {}, options = {}) {
  const range = normalizeAnalysisRange(input);
  const databaseContext = openServiceDatabase(options);
  try {
    return executeReadSnapshot(databaseContext.db, () => {
      const model = requireModel(databaseContext.db, modelId);
    if (range.startMs < Date.parse(model.effectiveStartUtc) || range.endMs > Date.parse(model.effectiveEndUtc)) {
      throw badRequest('分析范围超出模型版本有效期。', {
        code: 'ENERGY_FLOW_MODEL_RANGE_OUTSIDE_EFFECTIVE_PERIOD',
        effectiveStartUtc: model.effectiveStartUtc,
        effectiveEndUtc: model.effectiveEndUtc
      });
    }
    const nodes = databaseContext.db.prepare(
      `${NODE_SELECT_SQL} WHERE node.energy_flow_model_id = ? AND node.status = 'active' ORDER BY node.id LIMIT ${MAX_TOPOLOGY_NODES + 1}`
    ).all(model.id).map(mapNodeRow);
    const edges = databaseContext.db.prepare(
      `${EDGE_SELECT_SQL} WHERE edge.energy_flow_model_id = ? AND edge.status = 'active' ORDER BY edge.id LIMIT ${MAX_ANALYSIS_EDGES + 1}`
    ).all(model.id).map(mapEdgeRow);
    if (nodes.length > MAX_TOPOLOGY_NODES || edges.length > MAX_ANALYSIS_EDGES) {
      throw badRequest('能流分析超过单次查询上限，请拆分模型或缩小 active 拓扑。', {
        code: 'ENERGY_FLOW_ANALYSIS_LIMIT_EXCEEDED',
        maxNodes: MAX_TOPOLOGY_NODES,
        maxEdges: MAX_ANALYSIS_EDGES
      });
    }
    if (typeof options.onAfterTopologyRead === 'function') {
      options.onAfterTopologyRead({ db: databaseContext.db, model, nodes, edges, range });
    }
    const storageChanges = buildStorageChangeIndex(input.storageChanges, nodes);
    const edgeValues = edges.map((edge) => resolveEnergyFlowEdgeValue(databaseContext.db, edge, range));
    const duplicatedSources = rejectReusedSourcesAcrossEdges(edgeValues);
    const facetDefinitions = [...new Map(edgeValues.map((edge) => [
      `${edge.energyTypeId}\0${edge.unit}`,
      { energyTypeId: edge.energyTypeId, energyTypeCode: edge.energyTypeCode, unit: edge.unit }
    ])).entries()];
    edgeValues.forEach((edge) => {
      edge.standardCoal = edge.value !== null
        ? convertSegmentsToStandardCoal(
          databaseContext.db,
          { energyTypeId: edge.energyTypeId, energyTypeCode: edge.energyTypeCode, unit: edge.unit },
          edge._conversionSegments,
          range
        )
        : {
          kgce: null,
          tce: null,
          factor: null,
          applications: [],
          reasonCodes: [...edge.reasonCodes]
        };
    });
    const nodeBalances = buildNodeBalances(databaseContext.db, nodes, edgeValues, storageChanges.byKey, range);
    const facets = facetDefinitions.map(([_key, facet]) => {
      const facetEdges = edgeValues.filter((edge) => edge.energyTypeId === facet.energyTypeId && edge.unit === facet.unit);
      const standardCoalAvailable = facetEdges.every((edge) => edge.value !== null && edge.standardCoal?.kgce !== null);
      const reasonCodes = [...new Set(facetEdges.flatMap((edge) => edge.standardCoal?.reasonCodes || []))];
      const applications = facetEdges.flatMap((edge) => (edge.standardCoal?.applications || []).map((application) => ({
        edgeId: edge.edgeId,
        ...application
      })));
      return {
        ...facet,
        edgeCount: facetEdges.length,
        completeEdgeCount: facetEdges.filter((edge) => edge.value !== null).length,
        coverageRate: facetEdges.length === 0 ? 0 : roundAnalysisValue(facetEdges.reduce((sum, edge) => sum + edge.coverageRate, 0) / facetEdges.length),
        standardCoalAvailable,
        factor: applications.length === 1 ? applications[0].factor : null,
        applications,
        reasonCodes
      };
    });
    const anomalyItems = [];
    edgeValues.filter((edge) => edge.status !== 'complete').forEach((edge) => anomalyItems.push({
      type: 'edge',
      edgeId: edge.edgeId,
      edgeCode: edge.edgeCode,
      status: edge.status,
      reasonCodes: edge.reasonCodes,
      configurationErrors: edge.configurationErrors
    }));
    nodeBalances.forEach((node) => node.facets.forEach((facet) => {
      if (facet.status !== 'calculated' || (facet.difference !== null && Math.abs(facet.difference) > BALANCE_ZERO_TOLERANCE)) {
        anomalyItems.push({
          type: 'node_balance',
          nodeId: node.nodeId,
          nodeCode: node.nodeCode,
          energyTypeCode: facet.energyTypeCode,
          unit: facet.unit,
          status: facet.status,
          difference: facet.difference,
          imbalanceRate: facet.imbalanceRate,
          reasonCodes: facet.reasonCodes
        });
      }
    }));
    storageChanges.errors.forEach((error) => anomalyItems.push({ type: 'storage_change', ...error }));
    duplicatedSources.forEach((duplicate) => anomalyItems.push({
      type: 'source_reuse',
      reasonCodes: ['SOURCE_OVERLAP_OR_DUPLICATE'],
      configurationErrors: ['SOURCE_RECORD_REUSED_ACROSS_EDGES'],
      ...duplicate
    }));
    return {
      model,
      range: {
        mode: range.mode,
        startUtc: range.startUtc,
        endUtc: range.endUtc,
        startMonth: range.startMonth,
        endMonth: range.endMonth,
        monthAligned: range.monthAligned,
        boundary: '[start,end)'
      },
      topology: { nodes, edges },
      edgeValues,
      nodeBalances,
      facets,
      sourceUsage: {
        duplicatedSourceCount: duplicatedSources.length,
        duplicates: duplicatedSources
      },
      coverage: {
        edgeCount: edgeValues.length,
        completeEdgeCount: edgeValues.filter((edge) => edge.status === 'complete').length,
        partialEdgeCount: edgeValues.filter((edge) => edge.status === 'partial').length,
        missingEdgeCount: edgeValues.filter((edge) => edge.status === 'missing').length,
        unmappedEdgeCount: edgeValues.filter((edge) => edge.status === 'unmapped').length,
        unavailableEdgeCount: edgeValues.filter((edge) => ['unavailable', 'unit_not_comparable'].includes(edge.status)).length,
        completeRate: edgeValues.length === 0 ? 0 : roundAnalysisValue(edgeValues.filter((edge) => edge.status === 'complete').length / edgeValues.length)
      },
      anomalies: {
        count: anomalyItems.length,
        items: anomalyItems.slice(0, 1000),
        truncated: anomalyItems.length > 1000
      },
      contract: {
        formulaVersion: ENERGY_ANALYSIS_VERSIONS.energyFlow,
        topologyMode: 'explicit_only',
        sourceMode: 'explicit_mapping_only',
        autoOffsetsGeneration: false,
        autoWritesCarbon: false,
        autoCreatesLossEdges: false,
        standardCoalRule: 'timeseries_and_explicit_intervals_split_by_factor_period;monthly_and_generation_totals_require_one_factor_per_month'
      }
    };
    });
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  ENERGY_FLOW_CONFIG_STATUSES,
  GENERATION_VALUE_FIELDS,
  MAX_ANALYSIS_EDGES,
  MAX_PAGE_SIZE,
  MAX_SOURCE_RECORDS,
  MAX_TOPOLOGY_EDGES,
  MAX_TOPOLOGY_NODES,
  analyzeEnergyFlow,
  createEnergyFlowEdge,
  createEnergyFlowModel,
  createEnergyFlowNode,
  getEnergyFlowModel,
  getEnergyFlowTopology,
  listEnergyFlowEdges,
  listEnergyFlowModels,
  listEnergyFlowNodes,
  normalizeAnalysisRange,
  resolveEnergyFlowEdgeValue,
  resolveSourceMapping,
  setEnergyFlowEdgeStatus,
  setEnergyFlowModelStatus,
  setEnergyFlowNodeStatus,
  updateEnergyFlowEdge,
  updateEnergyFlowModel,
  updateEnergyFlowNode
};
