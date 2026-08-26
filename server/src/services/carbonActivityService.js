'use strict';

const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  CARBON_ACTIVITY_FIELD_LIMITS,
  buildCarbonActivityCodeKey,
  normalizeCarbonActivityScope,
  normalizeCarbonActivityText
} = require('./carbonActivityContracts');

// 列表筛选允许的活动状态和来源类型。
const CARBON_ACTIVITY_STATUSES = Object.freeze(['active', 'superseded', 'void']);
const CARBON_ACTIVITY_SOURCE_TYPES = Object.freeze(['independent_activity', 'energy_record']);
// 列表与导出共享固定字段投影，确保 sourceType 和追溯字段不会漂移。
const CARBON_ACTIVITY_SELECT_SQL = `SELECT activity.id,
  activity.source_type AS sourceType,
  activity.source_batch_id AS sourceBatchId,
  activity.source_row_number AS sourceRowNumber,
  activity.energy_record_id AS energyRecordId,
  activity.activity_code AS activityCode,
  activity.activity_code_key AS activityCodeKey,
  activity.supersedes_activity_id AS supersedesActivityId,
  superseded.activity_code AS supersedesActivityCode,
  activity.superseded_by_activity_id AS supersededByActivityId,
  successor.activity_code AS supersededByActivityCode,
  activity.emission_scope AS emissionScope,
  activity.activity_category AS activityCategory,
  activity.organization_unit_id AS organizationUnitId,
  organization.unit_code AS organizationUnitCode,
  organization.unit_name AS organizationUnitName,
  activity.energy_type_id AS energyTypeId,
  energy.code AS energyTypeCode,
  energy.name AS energyTypeName,
  activity.start_wall_clock AS startWallClock,
  activity.end_wall_clock AS endWallClock,
  activity.source_timezone AS sourceTimezone,
  activity.start_utc AS startUtc,
  activity.end_utc AS endUtc,
  activity.activity_value AS activityValue,
  activity.activity_unit AS activityUnit,
  activity.factor_region AS factorRegion,
  activity.source_reference AS sourceReference,
  activity.evidence_reference AS evidenceReference,
  activity.note,
  activity.duplicate_key AS duplicateKey,
  activity.record_status AS status,
  activity.void_reason AS voidReason,
  activity.voided_at AS voidedAt,
  activity.voided_by AS voidedBy,
  voider.display_name AS voidedByName,
  activity.created_by AS createdBy,
  creator.display_name AS createdByName,
  activity.created_at AS createdAt,
  activity.updated_at AS updatedAt
FROM carbon_activity_records activity
JOIN organization_units organization ON organization.id = activity.organization_unit_id
JOIN energy_types energy ON energy.id = activity.energy_type_id
LEFT JOIN carbon_activity_records superseded ON superseded.id = activity.supersedes_activity_id
LEFT JOIN carbon_activity_records successor ON successor.id = activity.superseded_by_activity_id
LEFT JOIN sys_users voider ON voider.id = activity.voided_by
LEFT JOIN sys_users creator ON creator.id = activity.created_by`;
// LIKE 转义使用固定字符，确保关键词百分号和下划线按文本处理。
const LIKE_ESCAPE_CHARACTER = '!';
// UTC 筛选只接受秒精度或可显式规范化的零毫秒 UTC 形式。
const STRICT_FILTER_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

/** 将活动 ID 规范化为正安全整数。 */
function normalizeCarbonActivityId(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw badRequest('独立碳活动 ID 必须是正整数。', { code: 'CARBON_ACTIVITY_ID_INVALID', id: value });
  }
  const activityId = Number(text);
  if (!Number.isSafeInteger(activityId)) {
    throw badRequest('独立碳活动 ID 超出安全整数范围。', { code: 'CARBON_ACTIVITY_ID_INVALID', id: value });
  }
  return activityId;
}

/** 将可选正整数筛选规范化。 */
function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const numberValue = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'CARBON_ACTIVITY_FILTER_ID_INVALID', fieldName });
  }
  return numberValue;
}

/** 校验查询使用的严格 UTC ISO 时间，并把零毫秒形式规范化为秒精度。 */
function normalizeOptionalUtc(value, fieldName) {
  const text = normalizeCarbonActivityText(value);
  if (!text) return null;
  const match = STRICT_FILTER_UTC_PATTERN.exec(text);
  const milliseconds = match?.[7] || '';
  if (!match || (milliseconds && milliseconds !== '000')) {
    throw badRequest(`${fieldName} 必须是严格秒精度 UTC ISO 时间。`, {
      code: 'CARBON_ACTIVITY_FILTER_UTC_INVALID',
      fieldName
    });
  }

  const calendarParts = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = calendarParts;
  const normalizedDate = new Date(0);
  normalizedDate.setUTCFullYear(year, month - 1, day);
  normalizedDate.setUTCHours(hour, minute, second, 0);
  const calendarMatches = normalizedDate.getUTCFullYear() === year
    && normalizedDate.getUTCMonth() === month - 1
    && normalizedDate.getUTCDate() === day
    && normalizedDate.getUTCHours() === hour
    && normalizedDate.getUTCMinutes() === minute
    && normalizedDate.getUTCSeconds() === second;
  if (!calendarMatches) {
    throw badRequest(`${fieldName} 必须是有效的严格 UTC 日历时间。`, {
      code: 'CARBON_ACTIVITY_FILTER_UTC_INVALID',
      fieldName
    });
  }

  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/** 将分页参数限制在本地列表允许范围内。 */
function normalizeCarbonActivityPagination(query = {}) {
  const rawPage = Number(query.page || 1);
  const rawPageSize = Number(query.pageSize || query.page_size || 20);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Number.isSafeInteger(rawPageSize) && rawPageSize > 0 && rawPageSize <= 500 ? rawPageSize : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 转义 SQLite LIKE 元字符。 */
function escapeLikePattern(value) {
  return String(value)
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);
}

/** 构造列表和导出共用的筛选 SQL 与参数。 */
function buildCarbonActivityWhere(query = {}) {
  const clauses = [];
  const params = {};
  const keyword = normalizeCarbonActivityText(query.keyword || query.search);
  if (keyword) {
    params.keyword = `%${escapeLikePattern(keyword)}%`;
    params.keywordCodeKey = `%${escapeLikePattern(buildCarbonActivityCodeKey(keyword))}%`;
    clauses.push(`(activity.activity_code_key LIKE @keywordCodeKey ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR activity.activity_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR activity.activity_category LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR organization.unit_code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR organization.unit_name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR energy.code LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR energy.name LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR activity.source_reference LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR activity.evidence_reference LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}'
      OR activity.note LIKE @keyword ESCAPE '${LIKE_ESCAPE_CHARACTER}')`);
  }
  const rawScope = normalizeCarbonActivityText(query.scope);
  if (rawScope) {
    const scope = normalizeCarbonActivityScope(rawScope);
    if (!scope) throw badRequest('scope 筛选无效。', { code: 'CARBON_ACTIVITY_SCOPE_INVALID', scope: rawScope });
    clauses.push('activity.emission_scope = @scope');
    params.scope = scope;
  }
  const status = normalizeCarbonActivityText(query.status);
  if (status) {
    if (!CARBON_ACTIVITY_STATUSES.includes(status)) {
      throw badRequest('status 筛选无效。', { code: 'CARBON_ACTIVITY_STATUS_INVALID', status });
    }
    clauses.push('activity.record_status = @status');
    params.status = status;
  }
  const sourceType = normalizeCarbonActivityText(query.sourceType || query.source_type);
  if (sourceType) {
    if (!CARBON_ACTIVITY_SOURCE_TYPES.includes(sourceType)) {
      throw badRequest('sourceType 筛选无效。', { code: 'CARBON_ACTIVITY_SOURCE_TYPE_INVALID', sourceType });
    }
    clauses.push('activity.source_type = @sourceType');
    params.sourceType = sourceType;
  }
  [
    ['organizationUnitId', 'activity.organization_unit_id'],
    ['energyTypeId', 'activity.energy_type_id'],
    ['sourceBatchId', 'activity.source_batch_id']
  ].forEach(([fieldName, columnName]) => {
    const value = normalizeOptionalPositiveInteger(query[fieldName] ?? query[fieldName.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)], fieldName);
    if (value !== null) {
      clauses.push(`${columnName} = @${fieldName}`);
      params[fieldName] = value;
    }
  });
  const startUtc = normalizeOptionalUtc(query.startUtc || query.start_utc, 'startUtc');
  const endUtc = normalizeOptionalUtc(query.endUtc || query.end_utc, 'endUtc');
  if (startUtc && endUtc && Date.parse(startUtc) >= Date.parse(endUtc)) {
    throw badRequest('筛选区间必须满足 startUtc < endUtc。', { code: 'CARBON_ACTIVITY_FILTER_RANGE_INVALID' });
  }
  if (startUtc) {
    clauses.push('unixepoch(activity.end_utc) > unixepoch(@startUtc)');
    params.startUtc = startUtc;
  }
  if (endUtc) {
    clauses.push('unixepoch(activity.start_utc) < unixepoch(@endUtc)');
    params.endUtc = endUtc;
  }
  return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 将 SQLite 行投影为稳定 API 对象。 */
function mapCarbonActivityRow(row) {
  if (!row) return null;
  const nullableNumber = (value) => value === null || value === undefined ? null : Number(value);
  return {
    ...row,
    id: Number(row.id),
    sourceBatchId: nullableNumber(row.sourceBatchId),
    sourceRowNumber: nullableNumber(row.sourceRowNumber),
    energyRecordId: nullableNumber(row.energyRecordId),
    supersedesActivityId: nullableNumber(row.supersedesActivityId),
    supersededByActivityId: nullableNumber(row.supersededByActivityId),
    organizationUnitId: Number(row.organizationUnitId),
    energyTypeId: Number(row.energyTypeId),
    activityValue: Number(row.activityValue),
    voidedBy: nullableNumber(row.voidedBy),
    createdBy: nullableNumber(row.createdBy)
  };
}

/** 分页查询独立碳活动事实。 */
function listCarbonActivities(query = {}) {
  const pagination = normalizeCarbonActivityPagination(query);
  const { whereSql, params } = buildCarbonActivityWhere(query);
  const db = openDatabase();
  try {
    const countSql = `SELECT COUNT(*) AS total FROM carbon_activity_records activity
      JOIN organization_units organization ON organization.id = activity.organization_unit_id
      JOIN energy_types energy ON energy.id = activity.energy_type_id ${whereSql}`;
    const total = Number(db.prepare(countSql).get(params).total || 0);
    const rows = db.prepare(`${CARBON_ACTIVITY_SELECT_SQL} ${whereSql}
      ORDER BY activity.start_utc DESC, activity.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pagination.pageSize, offset: pagination.offset })
      .map(mapCarbonActivityRow);
    return { rows, pagination: { page: pagination.page, pageSize: pagination.pageSize, total } };
  } finally {
    db.close();
  }
}

/** 按 ID 查询独立碳活动详情。 */
function getCarbonActivity(activityIdValue) {
  const activityId = normalizeCarbonActivityId(activityIdValue);
  const db = openDatabase();
  try {
    const row = db.prepare(`${CARBON_ACTIVITY_SELECT_SQL} WHERE activity.id = ?`).get(activityId);
    if (!row) throw notFound('独立碳活动不存在。', { id: activityId });
    return mapCarbonActivityRow(row);
  } finally {
    db.close();
  }
}

/** 防止导出值被 Excel/WPS 解释为公式。 */
function escapeSpreadsheetFormula(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/** 将 CSV 单元格按 UTF-8 CSV 规则转义。 */
function escapeCsvCell(value) {
  return `"${escapeSpreadsheetFormula(value).replace(/"/g, '""')}"`;
}

/** 按列表同一筛选合同安全导出 CSV 或 XLSX。 */
function exportCarbonActivities(query = {}) {
  const { whereSql, params } = buildCarbonActivityWhere(query);
  const format = normalizeCarbonActivityText(query.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'csv'].includes(format)) {
    throw badRequest('导出格式仅支持 xlsx 或 csv。', { code: 'CARBON_ACTIVITY_EXPORT_FORMAT_INVALID', format });
  }
  const db = openDatabase();
  let rows;
  try {
    rows = db.prepare(`${CARBON_ACTIVITY_SELECT_SQL} ${whereSql}
      ORDER BY activity.start_utc DESC, activity.id DESC`).all(params).map(mapCarbonActivityRow);
  } finally {
    db.close();
  }
  const headers = [
    '活动ID', '来源类型', '活动记录编码', '替代活动记录编码', '排放范围', '活动类别',
    '用能单元编码', '用能单元名称', '能源类型编码', '能源类型名称', '活动开始时间',
    '活动结束时间', '来源时区', '开始UTC', '结束UTC', '活动数据值', '活动数据单位',
    '因子地区', '来源标识', '证据引用', '备注', '状态', '来源批次ID', '来源行号',
    '作废原因', '作废时间', '创建时间', '更新时间'
  ];
  const values = rows.map((row) => [
    row.id, row.sourceType, row.activityCode, row.supersedesActivityCode, row.emissionScope,
    row.activityCategory, row.organizationUnitCode, row.organizationUnitName, row.energyTypeCode,
    row.energyTypeName, row.startWallClock, row.endWallClock, row.sourceTimezone, row.startUtc,
    row.endUtc, row.activityValue, row.activityUnit, row.factorRegion, row.sourceReference,
    row.evidenceReference, row.note, row.status, row.sourceBatchId, row.sourceRowNumber,
    row.voidReason, row.voidedAt, row.createdAt, row.updatedAt
  ].map(escapeSpreadsheetFormula));
  if (format === 'csv') {
    const csv = `﻿${[headers, ...values].map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
    return {
      body: Buffer.from(csv, 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      fileName: '独立碳活动导出.csv',
      asciiFileName: 'carbon-activities.csv',
      rowCount: rows.length
    };
  }
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
  worksheet['!cols'] = headers.map((_header, index) => ({ wch: Math.min(36, Math.max(12,
    ...values.map((row) => String(row[index] ?? '').length + 2))) }));
  XLSX.utils.book_append_sheet(workbook, worksheet, '独立碳活动');
  return {
    body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: '独立碳活动导出.xlsx',
    asciiFileName: 'carbon-activities.xlsx',
    rowCount: rows.length
  };
}

/** 在同一事务写入活动操作审计。 */
function insertCarbonActivityOperationLog(db, actor = {}, operation, activityId, detail = {}) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, ?, 'carbon_activity', ?, ?, ?, ?)`)
    .run(actor.userId || null, operation, String(activityId), JSON.stringify(detail || {}),
      actor.ip || null, new Date().toISOString());
}

/** 使用 expectedUpdatedAt 乐观锁专用作废 active 活动事实。 */
function voidCarbonActivity(activityIdValue, input = {}, actor = {}) {
  const activityId = normalizeCarbonActivityId(activityIdValue);
  const reason = normalizeCarbonActivityText(input.reason);
  const expectedUpdatedAt = normalizeCarbonActivityText(input.expectedUpdatedAt);
  if (!reason || reason.length > CARBON_ACTIVITY_FIELD_LIMITS.voidReason) {
    throw badRequest(`作废原因必填且不能超过 ${CARBON_ACTIVITY_FIELD_LIMITS.voidReason} 个字符。`, {
      code: 'CARBON_ACTIVITY_VOID_REASON_INVALID'
    });
  }
  if (!expectedUpdatedAt) {
    throw badRequest('expectedUpdatedAt 为作废乐观锁必填项。', {
      code: 'CARBON_ACTIVITY_EXPECTED_UPDATED_AT_REQUIRED'
    });
  }
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const existing = db.prepare('SELECT id, activity_code AS activityCode, record_status AS status, updated_at AS updatedAt FROM carbon_activity_records WHERE id = ?')
        .get(activityId);
      if (!existing) throw notFound('独立碳活动不存在。', { id: activityId });
      if (existing.status !== 'active') {
        throw badRequest('仅 active 独立碳活动允许作废。', {
          code: 'CARBON_ACTIVITY_VOID_STATUS_INVALID',
          status: existing.status
        });
      }
      if (existing.updatedAt !== expectedUpdatedAt) {
        throw new AppError('CARBON_ACTIVITY_OPTIMISTIC_LOCK_CONFLICT', '独立碳活动已被其他操作更新，请刷新后重试。', {
          statusCode: 409,
          details: { code: 'CARBON_ACTIVITY_OPTIMISTIC_LOCK_CONFLICT' }
        });
      }
      const now = new Date().toISOString();
      const result = db.prepare(`UPDATE carbon_activity_records
        SET record_status = 'void', void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ?
        WHERE id = ? AND record_status = 'active' AND updated_at = ?`)
        .run(reason, now, actor.userId || null, now, activityId, expectedUpdatedAt);
      if (result.changes !== 1) {
        throw new AppError('CARBON_ACTIVITY_OPTIMISTIC_LOCK_CONFLICT', '独立碳活动已被其他操作更新，请刷新后重试。', {
          statusCode: 409,
          details: { code: 'CARBON_ACTIVITY_OPTIMISTIC_LOCK_CONFLICT' }
        });
      }
      insertCarbonActivityOperationLog(db, actor, 'carbon.activity.void', activityId, {
        activityCode: existing.activityCode,
        reason,
        previousUpdatedAt: expectedUpdatedAt
      });
      const row = db.prepare(`${CARBON_ACTIVITY_SELECT_SQL} WHERE activity.id = ?`).get(activityId);
      return mapCarbonActivityRow(row);
    }).immediate();
  } finally {
    db.close();
  }
}

module.exports = {
  CARBON_ACTIVITY_SELECT_SQL,
  CARBON_ACTIVITY_SOURCE_TYPES,
  CARBON_ACTIVITY_STATUSES,
  buildCarbonActivityWhere,
  escapeSpreadsheetFormula,
  exportCarbonActivities,
  getCarbonActivity,
  listCarbonActivities,
  mapCarbonActivityRow,
  normalizeCarbonActivityId,
  voidCarbonActivity
};
