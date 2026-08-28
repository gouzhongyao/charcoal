const crypto = require('crypto');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const backupService = require('./backupService');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssues,
  updateExecuteAuditResult
} = require('./importAuditService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const BUDGET_STATUSES = Object.freeze(['active', 'inactive']);
const WHOLE_ORGANIZATION_SCOPE = '整体';
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const WARNING_THRESHOLD = Object.freeze({
  nearingUsageRate: 0.8,
  exceededUsageRate: 1,
  nearingPercent: 80,
  exceededPercent: 100
});
const MAX_ENERGY_BUDGET_EXPORT_ROWS = 5000;
const ENERGY_BUDGET_IMPORT_TYPE = 'energy_budget';
const ENERGY_BUDGET_IMPORT_TEMPLATE_ID = 'energy-budgets';
const ENERGY_BUDGET_IMPORT_CONFIRM_TEXT = '确认导入用能预算';
const ENERGY_BUDGET_IMPORT_BACKUP_REASON = 'energy-budget-import';
const ENERGY_BUDGET_IMPORT_SIGNATURE_PREFIX = 'hmac-sha256:v1';
const ENERGY_BUDGET_IMPORT_AUDIT_DIGEST_PREFIX = 'hmac-sha256:v1:audit';
const ENERGY_BUDGET_IMPORT_HMAC_SECRET_META_KEY = 'energy_budget_import_hmac_secret';
const ENERGY_BUDGET_IMPORT_HEADERS = Object.freeze(['预算月份', '能源类型编码', '组织范围', '预算值', '单位', '备注', '状态']);
const ENERGY_BUDGET_EXPORT_FIELDS = Object.freeze([
  { key: 'periodMonth', header: '预算月份' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'organizationScope', header: '组织范围' },
  { key: 'budgetValue', header: '预算值' },
  { key: 'unit', header: '单位' },
  { key: 'remark', header: '备注' },
  { key: 'status', header: '状态' }
]);
const ENERGY_BUDGET_IMPORT_ALIASES = Object.freeze({
  periodMonth: ['periodMonth', 'period_month', 'month', '月份', '预算月份'],
  energyTypeCode: ['energyTypeCode', 'energy_type_code', 'energyType', 'energy_type', '能源类型编码', '能源类型', '能源'],
  organizationScope: ['organizationScope', 'organization_scope', 'organization', '组织范围', '用能单元', '组织'],
  budgetValue: ['budgetValue', 'budget_value', 'value', '预算值', '预算量'],
  unit: ['unit', 'budgetUnit', 'budget_unit', '单位'],
  remark: ['remark', '备注', '说明', 'note'],
  status: ['status', '状态']
});

function getNow() {
  return new Date().toISOString();
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

function normalizeMonth(value, fieldName = 'periodMonth') {
  const text = normalizeText(value);
  if (!text) {
    throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
  }
  const normalized = text.replace(/[./]/g, '-');
  const month = /^\d{4}-\d{1,2}$/.test(normalized)
    ? normalized.replace(/^(\d{4})-(\d)$/, '$1-0$2')
    : normalized.slice(0, 7);
  if (!MONTH_PATTERN.test(month)) {
    throw badRequest(`${fieldName} 必须是 YYYY-MM 格式。`, { code: 'INVALID_MONTH', fieldName, rawValue: text });
  }
  return month;
}

function normalizeOptionalMonth(value, fieldName) {
  const text = normalizeText(value);
  return text ? normalizeMonth(text, fieldName) : null;
}

function parsePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return options.required ? null : undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parseNonNegativeNumber(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text && text !== '0') {
    return options.required ? null : undefined;
  }
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw badRequest(`${fieldName} 必须是大于等于 0 的数字。`, { code: 'INVALID_NON_NEGATIVE_NUMBER', fieldName, rawValue: text });
  }
  return numberValue;
}

function assertWhitelist(value, fieldName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, { code: 'UNSUPPORTED_ENERGY_BUDGET_VALUE', fieldName, rawValue: value, allowedValues });
  }
}

function normalizeOrganizationScope(value) {
  return normalizeText(value) || WHOLE_ORGANIZATION_SCOPE;
}

function normalizePagination(query = {}, defaults = {}) {
  const page = parsePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = parsePositiveInteger(query.pageSize, 'pageSize') || defaults.pageSize || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, defaults.maxPageSize || MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function getEnergyTypeById(db, energyTypeId, options = {}) {
  const row = db.prepare(
    `SELECT id, code, name, default_unit AS defaultUnit, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE id = ?`
  ).get(energyTypeId);
  if (!row && !options.optional) {
    throw notFound('能源类型不存在。', { id: energyTypeId });
  }
  return row || null;
}

function getEnergyTypeByCode(db, energyTypeCode, options = {}) {
  const row = db.prepare(
    `SELECT id, code, name, default_unit AS defaultUnit, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE code = ?`
  ).get(energyTypeCode);
  if (!row && !options.optional) {
    throw notFound('能源类型不存在。', { energyTypeCode });
  }
  return row || null;
}

function resolveEnergyType(db, input = {}, options = {}) {
  const energyTypeId = parsePositiveInteger(firstDefined(input, ['energyTypeId', 'energy_type_id']), 'energyTypeId');
  if (energyTypeId) {
    return getEnergyTypeById(db, energyTypeId, options);
  }
  const energyTypeCode = normalizeText(firstDefined(input, ['energyTypeCode', 'energy_type_code', 'energyType', 'energy_type']));
  if (energyTypeCode) {
    return getEnergyTypeByCode(db, energyTypeCode, options);
  }
  if (options.required) {
    throw badRequest('energyTypeId 或 energyTypeCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'energyTypeId' });
  }
  return null;
}

function normalizeBudgetPayload(input = {}, options = {}) {
  const existing = options.existing || {};
  const periodMonthRaw = firstDefined(input, ['periodMonth', 'period_month', 'normalizedMonth', 'month']);
  const budgetValueRaw = firstDefined(input, ['budgetValue', 'budget_value']);
  const status = normalizeText(input.status) || existing.status || 'active';
  assertWhitelist(status, 'status', BUDGET_STATUSES);

  return {
    periodMonth: periodMonthRaw === undefined || periodMonthRaw === null || String(periodMonthRaw).trim() === ''
      ? existing.periodMonth || null
      : normalizeMonth(periodMonthRaw, 'periodMonth'),
    energyTypeId: null,
    organizationScope: Object.prototype.hasOwnProperty.call(input, 'organizationScope') || Object.prototype.hasOwnProperty.call(input, 'organization_scope')
      ? normalizeOrganizationScope(firstDefined(input, ['organizationScope', 'organization_scope']))
      : (existing.organizationScope || WHOLE_ORGANIZATION_SCOPE),
    budgetValue: budgetValueRaw === undefined || budgetValueRaw === null || String(budgetValueRaw).trim() === ''
      ? existing.budgetValue
      : parseNonNegativeNumber(budgetValueRaw, 'budgetValue', { required: true }),
    unit: normalizeText(firstDefined(input, ['unit', 'budgetUnit', 'budget_unit'])) || existing.unit || null,
    remark: Object.prototype.hasOwnProperty.call(input, 'remark') ? normalizeText(input.remark) : (existing.remark || null),
    status
  };
}

function mapBudgetRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    periodMonth: row.periodMonth,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    organizationScope: row.organizationScope,
    budgetValue: Number(row.budgetValue),
    unit: row.unit,
    remark: row.remark,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getBudgetById(db, budgetId, options = {}) {
  const row = db.prepare(
    `SELECT
       eb.id,
       eb.period_month AS periodMonth,
       eb.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       eb.organization_scope AS organizationScope,
       eb.budget_value AS budgetValue,
       eb.unit,
       eb.remark,
       eb.status,
       eb.created_at AS createdAt,
       eb.updated_at AS updatedAt
     FROM energy_budgets eb
     JOIN energy_types et ON et.id = eb.energy_type_id
     WHERE eb.id = ?`
  ).get(budgetId);
  if (!row && !options.optional) {
    throw notFound('用能预算不存在。', { id: budgetId });
  }
  return row ? mapBudgetRow(row) : null;
}

function buildBudgetWhere(query = {}) {
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', BUDGET_STATUSES);
    where.push('eb.status = @status');
    params.status = status;
  }
  const periodMonth = normalizeOptionalMonth(firstDefined(query, ['periodMonth', 'period_month', 'normalizedMonth', 'month']), 'periodMonth');
  if (periodMonth) {
    where.push('eb.period_month = @periodMonth');
    params.periodMonth = periodMonth;
  }
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'periodMonthStart', 'period_month_start']), 'monthStart');
  if (monthStart) {
    where.push('eb.period_month >= @monthStart');
    params.monthStart = monthStart;
  }
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'periodMonthEnd', 'period_month_end']), 'monthEnd');
  if (monthEnd) {
    where.push('eb.period_month <= @monthEnd');
    params.monthEnd = monthEnd;
  }
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  const energyTypeId = parsePositiveInteger(firstDefined(query, ['energyTypeId', 'energy_type_id']), 'energyTypeId');
  if (energyTypeId) {
    where.push('eb.energy_type_id = @energyTypeId');
    params.energyTypeId = energyTypeId;
  }
  const energyTypeCode = normalizeText(firstDefined(query, ['energyTypeCode', 'energy_type_code', 'energyType', 'energy_type']));
  if (energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = energyTypeCode;
  }
  if (Object.prototype.hasOwnProperty.call(query, 'organizationScope') || Object.prototype.hasOwnProperty.call(query, 'organization_scope')) {
    where.push('eb.organization_scope = @organizationScope');
    params.organizationScope = normalizeOrganizationScope(firstDefined(query, ['organizationScope', 'organization_scope']));
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(eb.organization_scope LIKE @keyword OR eb.remark LIKE @keyword OR et.code LIKE @keyword OR et.name LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function listEnergyBudgets(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 50, maxPageSize: 500 });
  const { whereSql, params } = buildBudgetWhere(query);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM energy_budgets eb
       JOIN energy_types et ON et.id = eb.energy_type_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         eb.id,
         eb.period_month AS periodMonth,
         eb.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         eb.organization_scope AS organizationScope,
         eb.budget_value AS budgetValue,
         eb.unit,
         eb.remark,
         eb.status,
         eb.created_at AS createdAt,
         eb.updated_at AS updatedAt
       FROM energy_budgets eb
       JOIN energy_types et ON et.id = eb.energy_type_id
       ${whereSql}
       ORDER BY eb.period_month DESC, et.display_order ASC, eb.organization_scope ASC, eb.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapBudgetRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function upsertEnergyBudget(input = {}) {
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const energyType = resolveEnergyType(db, input, { required: true });
      if (energyType.isActive !== 1) {
        throw badRequest('预算能源类型必须为 active 状态。', { code: 'INACTIVE_ENERGY_TYPE', energyTypeId: energyType.id });
      }
      const normalized = normalizeBudgetPayload(input);
      if (!normalized.periodMonth) throw badRequest('periodMonth 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'periodMonth' });
      if (normalized.budgetValue === undefined || normalized.budgetValue === null) throw badRequest('budgetValue 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'budgetValue' });
      const unit = normalized.unit || energyType.standardUnit;
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO energy_budgets (
           period_month, energy_type_id, organization_scope, budget_value, unit, remark, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(period_month, energy_type_id, organization_scope) DO UPDATE SET
           budget_value = excluded.budget_value,
           unit = excluded.unit,
           remark = excluded.remark,
           status = excluded.status,
           updated_at = excluded.updated_at`
      ).run(normalized.periodMonth, energyType.id, normalized.organizationScope, normalized.budgetValue, unit, normalized.remark, normalized.status, now, now);
      const existing = db.prepare(
        `SELECT id FROM energy_budgets
         WHERE period_month = ? AND energy_type_id = ? AND organization_scope = ?`
      ).get(normalized.periodMonth, energyType.id, normalized.organizationScope);
      return { ...getBudgetById(db, existing.id), created: result.changes === 1 && result.lastInsertRowid === existing.id };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateEnergyBudget(budgetId, input = {}) {
  const id = parsePositiveInteger(budgetId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getBudgetById(db, id);
      const energyType = resolveEnergyType(db, input, { optional: true }) || getEnergyTypeById(db, existing.energyTypeId);
      if (energyType.isActive !== 1) {
        throw badRequest('预算能源类型必须为 active 状态。', { code: 'INACTIVE_ENERGY_TYPE', energyTypeId: energyType.id });
      }
      const payload = normalizeBudgetPayload(input, { existing });
      payload.energyTypeId = energyType.id;
      if (!payload.periodMonth) throw badRequest('periodMonth 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'periodMonth' });
      if (payload.budgetValue === undefined || payload.budgetValue === null) throw badRequest('budgetValue 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'budgetValue' });
      const conflict = db.prepare(
        `SELECT id FROM energy_budgets
         WHERE period_month = ?
           AND energy_type_id = ?
           AND organization_scope = ?
           AND id <> ?
         LIMIT 1`
      ).get(payload.periodMonth, payload.energyTypeId, payload.organizationScope, id);
      if (conflict) {
        throw badRequest('同一月份、能源类型和组织范围只能存在一条预算；请更新已有预算。', {
          code: 'DUPLICATE_ENERGY_BUDGET',
          existingId: conflict.id,
          periodMonth: payload.periodMonth,
          energyTypeId: payload.energyTypeId,
          organizationScope: payload.organizationScope
        });
      }
      db.prepare(
        `UPDATE energy_budgets
         SET period_month = ?, energy_type_id = ?, organization_scope = ?, budget_value = ?, unit = ?, remark = ?, status = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload.periodMonth, payload.energyTypeId, payload.organizationScope, payload.budgetValue, payload.unit || energyType.standardUnit, payload.remark, payload.status, getNow(), id);
      return getBudgetById(db, id);
    });
    return transaction();
  } finally {
    db.close();
  }
}

function setEnergyBudgetStatus(budgetId, statusInput) {
  const id = parsePositiveInteger(budgetId, 'id', { required: true });
  const status = normalizeText(typeof statusInput === 'string' ? statusInput : firstDefined(statusInput || {}, ['status']));
  if (!status) {
    throw badRequest('status 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'status' });
  }
  assertWhitelist(status, 'status', BUDGET_STATUSES);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      getBudgetById(db, id);
      db.prepare('UPDATE energy_budgets SET status = ?, updated_at = ? WHERE id = ?').run(status, getNow(), id);
      return getBudgetById(db, id);
    });
    return transaction();
  } finally {
    db.close();
  }
}

// 实际能耗组织范围匹配模块：只使用 canonical 用能单元 JOIN 派生字段。
function buildActualOrganizationMatch(where, params, organizationScope) {
  if (organizationScope && organizationScope !== WHOLE_ORGANIZATION_SCOPE) {
    where.push(`(
      ou.unit_code = @organizationScope
      OR ou.unit_name = @organizationScope
      OR ou.unit_path = @organizationScope
    )`);
    params.organizationScope = organizationScope;
  }
}

// 单月实际能耗筛选模块：保留既有导出函数契约，并为单位安全分组提供筛选条件。
function buildActualEnergyWhere(periodMonth, energyTypeId, organizationScope) {
  const where = ["er.record_status = 'active'", 'er.normalized_month = @periodMonth', 'er.energy_type_id = @energyTypeId'];
  const params = { periodMonth, energyTypeId };
  buildActualOrganizationMatch(where, params, organizationScope);
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

// 实际能耗单位分组模块：同月、同能源、同组织范围内严格按 normalized_unit 分组。
function getActualUsageGroups(db, periodMonth, energyTypeId, organizationScope) {
  const { whereSql, params } = buildActualEnergyWhere(periodMonth, energyTypeId, organizationScope);
  return db.prepare(
    `SELECT
       COALESCE(SUM(er.normalized_value), 0) AS actualValue,
       COUNT(er.id) AS recordCount,
       er.normalized_unit AS normalizedUnit
     FROM energy_records er
     JOIN organization_units ou ON ou.id = er.organization_unit_id
     ${whereSql}
     GROUP BY er.normalized_unit
     ORDER BY er.normalized_unit ASC`
  ).all(params).map((row) => ({
    actualValue: Number(row.actualValue || 0),
    recordCount: Number(row.recordCount || 0),
    normalizedUnit: row.normalizedUnit || null
  }));
}

// 执行比较筛选标准化模块：预算与实际数据共用同一月份、能源和组织范围上下文。
function normalizeExecutionComparisonFilters(db, query = {}) {
  const periodMonth = normalizeOptionalMonth(firstDefined(query, ['periodMonth', 'period_month', 'normalizedMonth', 'month']), 'periodMonth');
  const monthStart = normalizeOptionalMonth(firstDefined(query, ['monthStart', 'periodMonthStart', 'period_month_start']), 'monthStart');
  const monthEnd = normalizeOptionalMonth(firstDefined(query, ['monthEnd', 'periodMonthEnd', 'period_month_end']), 'monthEnd');
  if (monthStart && monthEnd && monthStart > monthEnd) {
    throw badRequest('月份范围无效：monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart, monthEnd });
  }
  const organizationScopeProvided = Object.prototype.hasOwnProperty.call(query, 'organizationScope') || Object.prototype.hasOwnProperty.call(query, 'organization_scope');
  return {
    periodMonth,
    monthStart,
    monthEnd,
    energyType: resolveEnergyType(db, query, { optional: true }),
    organizationScopeProvided,
    organizationScope: organizationScopeProvided ? normalizeOrganizationScope(firstDefined(query, ['organizationScope', 'organization_scope'])) : null
  };
}

// 年度或月份范围实际能耗筛选模块：只读取 active 记录，不跨单位汇总。
function buildActualRangeWhere(filters) {
  const where = ["er.record_status = 'active'"];
  const params = {};
  if (filters.periodMonth) {
    where.push('er.normalized_month = @periodMonth');
    params.periodMonth = filters.periodMonth;
  }
  if (filters.monthStart) {
    where.push('er.normalized_month >= @monthStart');
    params.monthStart = filters.monthStart;
  }
  if (filters.monthEnd) {
    where.push('er.normalized_month <= @monthEnd');
    params.monthEnd = filters.monthEnd;
  }
  if (filters.energyType) {
    where.push('er.energy_type_id = @energyTypeId');
    params.energyTypeId = filters.energyType.id;
  }
  if (filters.organizationScopeProvided) {
    buildActualOrganizationMatch(where, params, filters.organizationScope);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

// 实际能耗组合读取模块：只保留 canonical 用能单元派生字段。
function listActualUsageGroups(db, filters) {
  const { whereSql, params } = buildActualRangeWhere(filters);
  return db.prepare(
    `SELECT
       er.normalized_month AS periodMonth,
       er.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       er.normalized_unit AS normalizedUnit,
       ou.id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       COALESCE(SUM(er.normalized_value), 0) AS actualValue,
       COUNT(er.id) AS recordCount
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     JOIN organization_units ou ON ou.id = er.organization_unit_id
     ${whereSql}
     GROUP BY er.normalized_month, er.energy_type_id, et.code, et.name, er.normalized_unit,
              ou.id, ou.unit_code, ou.unit_name, ou.unit_path
     ORDER BY er.normalized_month ASC, et.display_order ASC, er.normalized_unit ASC`
  ).all(params).map((row) => ({
    ...row,
    actualValue: Number(row.actualValue || 0),
    recordCount: Number(row.recordCount || 0),
    normalizedUnit: row.normalizedUnit || null
  }));
}

// 预算覆盖判断模块：整体预算覆盖同月同能源全部组织，其他范围沿用既有组织键匹配。
function budgetMatchesActualGroup(budget, actual) {
  if (budget.periodMonth !== actual.periodMonth || budget.energyTypeId !== actual.energyTypeId) return false;
  if (budget.organizationScope === WHOLE_ORGANIZATION_SCOPE) return true;
  const organizationKeys = [
    actual.organizationUnitCode,
    actual.organizationUnitName,
    actual.organizationUnitPath
  ].map(normalizeText).filter(Boolean);
  return organizationKeys.includes(budget.organizationScope);
}

// 无预算实际组合组织键模块：仅从 canonical 用能单元派生字段选择。
function getActualOrganizationScope(actual, requestedOrganizationScope) {
  return requestedOrganizationScope || normalizeText(actual.organizationUnitName)
    || normalizeText(actual.organizationUnitCode) || normalizeText(actual.organizationUnitPath)
    || WHOLE_ORGANIZATION_SCOPE;
}

// 无预算实际组合合并模块：仅合并月份、能源、单位和组织范围完全一致的数据。
function mergeActualOnlyGroups(actualGroups, requestedOrganizationScope) {
  const merged = new Map();
  actualGroups.forEach((actual) => {
    const organizationScope = getActualOrganizationScope(actual, requestedOrganizationScope);
    const key = `${actual.periodMonth} ${actual.energyTypeId} ${actual.normalizedUnit || ''} ${organizationScope}`;
    const existing = merged.get(key);
    if (existing) {
      existing.actualValue += actual.actualValue;
      existing.recordCount += actual.recordCount;
      return;
    }
    merged.set(key, {
      periodMonth: actual.periodMonth,
      energyTypeId: actual.energyTypeId,
      energyTypeCode: actual.energyTypeCode,
      energyTypeName: actual.energyTypeName,
      organizationScope,
      normalizedUnit: actual.normalizedUnit,
      actualValue: actual.actualValue,
      recordCount: actual.recordCount
    });
  });
  return Array.from(merged.values());
}

// 预算预警模块：单位不一致时优先返回不可比较状态，不计算使用率或阈值预警。
function buildBudgetWarning(comparisonStatus, hasBudget, budgetValue, actualValue, usageRate, actualRecordCount) {
  const hasActualRecord = actualRecordCount > 0;
  const hasActualValue = hasActualRecord && actualValue > 0;
  if (comparisonStatus === 'unit_mismatch') {
    return {
      warningLevel: 'unit_mismatch',
      warningLabel: '单位不一致',
      warningReason: '预算单位与实际 normalized_unit 不一致，且没有可靠换算规则，当前组合不可比较。'
    };
  }
  if (!hasBudget) {
    return hasActualRecord
      ? {
        warningLevel: 'missing_budget',
        warningLabel: '未配置预算',
        warningReason: '当前筛选维度存在 active 实际用能记录，但未配置 active 预算。'
      }
      : {
        warningLevel: 'normal',
        warningLabel: '未触发预警',
        warningReason: '未配置 active 预算且暂无实际用能记录，未触发预算预警。'
      };
  }
  if (!hasActualValue) {
    return {
      warningLevel: 'normal',
      warningLabel: '未触发预警',
      warningReason: '暂无实际用能值，未触发预算预警。'
    };
  }
  if (budgetValue === 0) {
    return {
      warningLevel: 'exceeded',
      warningLabel: '超预算',
      warningReason: '预算值为 0 且已有实际用能值，无法计算使用率，按超预算预警处理。'
    };
  }
  if (usageRate >= WARNING_THRESHOLD.exceededUsageRate) {
    return {
      warningLevel: 'exceeded',
      warningLabel: '超预算',
      warningReason: `使用率已达到 ${WARNING_THRESHOLD.exceededPercent}% 或以上。`
    };
  }
  if (usageRate >= WARNING_THRESHOLD.nearingUsageRate) {
    return {
      warningLevel: 'nearing',
      warningLabel: '接近预算',
      warningReason: `使用率已达到 ${WARNING_THRESHOLD.nearingPercent}% 且低于 ${WARNING_THRESHOLD.exceededPercent}%。`
    };
  }
  return {
    warningLevel: 'normal',
    warningLabel: '未触发预警',
    warningReason: `使用率低于 ${WARNING_THRESHOLD.nearingPercent}%，未触发预算预警。`
  };
}

// 执行比较行构建模块：预算单位与实际单位一致时才计算差异、使用率和阈值预警。
function buildComparisonRow(budget, actual) {
  const hasBudget = Boolean(budget);
  const budgetValue = hasBudget ? Number(budget.budgetValue || 0) : null;
  const budgetUnit = hasBudget ? budget.unit : null;
  const actualValue = Number(actual.actualValue || 0);
  const actualRecordCount = Number(actual.recordCount || 0);
  const actualUnit = actual.normalizedUnit || null;
  const hasActualRecord = actualRecordCount > 0;
  const unitsMatch = !hasActualRecord || (Boolean(budgetUnit) && Boolean(actualUnit) && budgetUnit === actualUnit);
  const comparisonStatus = !hasBudget
    ? (hasActualRecord ? 'missing_budget' : 'no_data')
    : (!hasActualRecord ? 'no_actual' : (unitsMatch ? 'comparable' : 'unit_mismatch'));
  const isComparable = hasBudget && comparisonStatus !== 'unit_mismatch';
  const usageRate = isComparable && budgetValue > 0 ? actualValue / budgetValue : null;
  const warning = buildBudgetWarning(comparisonStatus, hasBudget, budgetValue, actualValue, usageRate, actualRecordCount);
  const variance = isComparable ? actualValue - budgetValue : null;
  return {
    budgetId: hasBudget ? budget.id : null,
    periodMonth: hasBudget ? budget.periodMonth : actual.periodMonth,
    energyTypeId: hasBudget ? budget.energyTypeId : actual.energyTypeId,
    energyTypeCode: hasBudget ? budget.energyTypeCode : actual.energyTypeCode,
    energyTypeName: hasBudget ? budget.energyTypeName : actual.energyTypeName,
    organizationScope: hasBudget ? budget.organizationScope : actual.organizationScope,
    budgetValue,
    actualValue,
    variance,
    usageRate,
    overBudget: isComparable ? warning.warningLevel === 'exceeded' : false,
    unit: hasBudget ? budgetUnit : actualUnit,
    budgetUnit,
    actualUnit,
    actualRecordCount,
    budgetStatus: hasBudget ? budget.status : 'none',
    comparisonStatus,
    isComparable,
    warningLevel: warning.warningLevel,
    warningLabel: warning.warningLabel,
    warningReason: warning.warningReason,
    warningThreshold: WARNING_THRESHOLD
  };
}

// 比较摘要模块：按单位返回安全合计；存在多个单位时不再输出伪可比的标量合计。
function summarizeComparisonRows(rows = []) {
  const budgetRowsById = new Map();
  rows.forEach((row) => {
    if (!row.budgetId) return;
    const existing = budgetRowsById.get(row.budgetId);
    if (!existing || row.comparisonStatus === 'comparable') budgetRowsById.set(row.budgetId, row);
  });
  const budgetRows = Array.from(budgetRowsById.values());
  const totalsByUnitMap = new Map();
  const ensureUnitTotal = (unit) => {
    const key = unit || '__NO_UNIT__';
    if (!totalsByUnitMap.has(key)) {
      totalsByUnitMap.set(key, { unit: unit || null, budgetValue: 0, actualValue: 0, budgetRowCount: 0, actualRecordCount: 0 });
    }
    return totalsByUnitMap.get(key);
  };
  budgetRows.forEach((row) => {
    const total = ensureUnitTotal(row.budgetUnit || row.unit);
    total.budgetValue += Number(row.budgetValue || 0);
    total.budgetRowCount += 1;
  });
  rows.forEach((row) => {
    if (Number(row.actualRecordCount || 0) <= 0) return;
    const total = ensureUnitTotal(row.actualUnit);
    total.actualValue += Number(row.actualValue || 0);
    total.actualRecordCount += Number(row.actualRecordCount || 0);
  });
  const totalsByUnit = Array.from(totalsByUnitMap.values()).map((item) => ({
    ...item,
    variance: item.budgetRowCount > 0 ? item.actualValue - item.budgetValue : null,
    usageRate: item.budgetValue > 0 ? item.actualValue / item.budgetValue : null
  }));
  const scalarTotal = totalsByUnit.length === 1 ? totalsByUnit[0] : null;
  const exceededBudgetIds = new Set(rows.filter((row) => row.budgetId && row.warningLevel === 'exceeded').map((row) => row.budgetId));
  return {
    rowCount: rows.length,
    budgetRowCount: budgetRows.length,
    comparableRowCount: rows.filter((row) => row.isComparable).length,
    overBudgetCount: exceededBudgetIds.size,
    nearingCount: rows.filter((row) => row.warningLevel === 'nearing').length,
    exceededCount: rows.filter((row) => row.warningLevel === 'exceeded').length,
    missingBudgetCount: rows.filter((row) => row.warningLevel === 'missing_budget').length,
    unitMismatchCount: rows.filter((row) => row.warningLevel === 'unit_mismatch').length,
    warningThreshold: WARNING_THRESHOLD,
    summaryUnit: scalarTotal?.unit || null,
    totalBudgetValue: scalarTotal ? scalarTotal.budgetValue : (totalsByUnit.length === 0 ? 0 : null),
    totalActualValue: scalarTotal ? scalarTotal.actualValue : (totalsByUnit.length === 0 ? 0 : null),
    totalVariance: scalarTotal?.budgetRowCount ? scalarTotal.variance : null,
    totalUsageRate: scalarTotal?.budgetValue > 0 ? scalarTotal.usageRate : null,
    totalsByUnit,
    note: '按月份、能源类型、组织范围和 normalized_unit 比较 active 实际能耗与 active 预算；单位不一致时返回 unit_mismatch 且不计算使用率；无 active 预算但有实际记录时返回 missing_budget；不做跨能源折标煤、不做碳预算、不联动预测、通知或审批。'
  };
}

// 预算执行比较主流程：以 active 预算组合与 active 实际能耗组合的并集生成结果。
function getEnergyBudgetExecutionComparison(query = {}) {
  const db = openDatabase();
  try {
    const filters = normalizeExecutionComparisonFilters(db, query);
    const budgetQuery = { ...query, status: 'active' };
    if (filters.periodMonth) budgetQuery.periodMonth = filters.periodMonth;
    if (filters.energyType) budgetQuery.energyTypeId = filters.energyType.id;
    if (filters.organizationScopeProvided) budgetQuery.organizationScope = filters.organizationScope;
    const { whereSql, params } = buildBudgetWhere(budgetQuery);
    const budgets = db.prepare(
      `SELECT
         eb.id,
         eb.period_month AS periodMonth,
         eb.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         eb.organization_scope AS organizationScope,
         eb.budget_value AS budgetValue,
         eb.unit,
         eb.remark,
         eb.status,
         eb.created_at AS createdAt,
         eb.updated_at AS updatedAt
       FROM energy_budgets eb
       JOIN energy_types et ON et.id = eb.energy_type_id
       ${whereSql}
       ORDER BY eb.period_month ASC, et.display_order ASC, eb.organization_scope ASC, eb.id ASC`
    ).all(params).map(mapBudgetRow);

    const rows = [];
    budgets.forEach((budget) => {
      const actualGroups = getActualUsageGroups(db, budget.periodMonth, budget.energyTypeId, budget.organizationScope);
      if (actualGroups.length === 0) {
        rows.push(buildComparisonRow(budget, { actualValue: 0, recordCount: 0, normalizedUnit: null }));
        return;
      }
      actualGroups.forEach((actual) => rows.push(buildComparisonRow(budget, actual)));
    });

    const actualGroups = listActualUsageGroups(db, filters);
    const actualOnlyGroups = actualGroups.filter((actual) => !budgets.some((budget) => budgetMatchesActualGroup(budget, actual)));
    mergeActualOnlyGroups(actualOnlyGroups, filters.organizationScopeProvided ? filters.organizationScope : null)
      .forEach((actual) => rows.push(buildComparisonRow(null, actual)));

    if (rows.length === 0 && filters.periodMonth && filters.energyType) {
      rows.push(buildComparisonRow(null, {
        actualValue: 0,
        recordCount: 0,
        normalizedUnit: null,
        periodMonth: filters.periodMonth,
        energyTypeId: filters.energyType.id,
        energyTypeCode: filters.energyType.code,
        energyTypeName: filters.energyType.name,
        organizationScope: filters.organizationScope || WHOLE_ORGANIZATION_SCOPE
      }));
    }

    rows.sort((left, right) => left.periodMonth.localeCompare(right.periodMonth)
      || String(left.energyTypeCode).localeCompare(String(right.energyTypeCode))
      || String(left.organizationScope).localeCompare(String(right.organizationScope))
      || String(left.actualUnit || left.budgetUnit || '').localeCompare(String(right.actualUnit || right.budgetUnit || '')));

    return {
      rows,
      summary: summarizeComparisonRows(rows),
      meta: {
        activeBudgetsOnly: true,
        actualRecordStatus: 'active',
        warningThreshold: WARNING_THRESHOLD,
        warningPolicy: '默认 80% 接近预算、100% 超预算；无 active 预算但有实际记录提示未配置预算；预算单位与实际单位不一致时返回 unit_mismatch 且不计算使用率；阈值不持久化。',
        organizationScopePolicy: '整体表示不限制组织范围；非整体文本按 energy_records.organization/site/department 或用能单元编码、名称、路径精确匹配。无预算实际组合优先使用用能单元名称作为组织范围键。',
        conversionPolicy: '实际数据按 periodMonth + energyTypeCode + normalizedUnit + 组织范围分组；仅同单位比较，不做单位换算或跨能源折标煤。'
      }
    };
  } finally {
    db.close();
  }
}

function selectEnergyBudgetRows(db, query = {}, limit = MAX_ENERGY_BUDGET_EXPORT_ROWS, offset = 0) {
  const { whereSql, params } = buildBudgetWhere(query);
  return db.prepare(
    `SELECT
       eb.id,
       eb.period_month AS periodMonth,
       eb.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       eb.organization_scope AS organizationScope,
       eb.budget_value AS budgetValue,
       eb.unit,
       eb.remark,
       eb.status,
       eb.created_at AS createdAt,
       eb.updated_at AS updatedAt
     FROM energy_budgets eb
     JOIN energy_types et ON et.id = eb.energy_type_id
     ${whereSql}
     ORDER BY eb.period_month DESC, et.display_order ASC, eb.organization_scope ASC, eb.id DESC
     LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map(mapBudgetRow);
}

function buildEnergyBudgetStats(query = {}) {
  const db = openDatabase();
  try {
    const { whereSql, params } = buildBudgetWhere(query);
    const summary = db.prepare(
      `SELECT COUNT(*) AS totalBudgets,
              SUM(CASE WHEN eb.status = 'active' THEN 1 ELSE 0 END) AS activeCount,
              SUM(CASE WHEN eb.status = 'inactive' THEN 1 ELSE 0 END) AS inactiveCount,
              COALESCE(SUM(eb.budget_value), 0) AS totalBudgetValue
       FROM energy_budgets eb JOIN energy_types et ON et.id = eb.energy_type_id
       ${whereSql}`
    ).get(params);
    const aggregate = (groupBy, columns) => db.prepare(
      `SELECT ${columns}, eb.unit AS unit, COUNT(*) AS budgetCount,
              SUM(CASE WHEN eb.status = 'active' THEN 1 ELSE 0 END) AS activeCount,
              SUM(CASE WHEN eb.status = 'inactive' THEN 1 ELSE 0 END) AS inactiveCount,
              COALESCE(SUM(eb.budget_value), 0) AS budgetValue
       FROM energy_budgets eb JOIN energy_types et ON et.id = eb.energy_type_id
       ${whereSql}
       GROUP BY ${groupBy}, eb.unit
       ORDER BY ${groupBy}, eb.unit`
    ).all(params).map((row) => ({ ...row, budgetCount: Number(row.budgetCount), activeCount: Number(row.activeCount), inactiveCount: Number(row.inactiveCount), budgetValue: Number(row.budgetValue) }));
    return {
      totalBudgets: Number(summary.totalBudgets || 0),
      activeCount: Number(summary.activeCount || 0),
      inactiveCount: Number(summary.inactiveCount || 0),
      totalBudgetValue: Number(summary.totalBudgetValue || 0),
      byEnergyType: aggregate('et.code, et.name', 'et.code AS energyTypeCode, et.name AS energyTypeName'),
      byOrganizationScope: aggregate('eb.organization_scope', 'eb.organization_scope AS organizationScope'),
      monthlyTrend: aggregate('eb.period_month', 'eb.period_month AS periodMonth'),
      totalsByUnit: db.prepare(
        `SELECT eb.unit AS unit, COUNT(*) AS budgetCount, COALESCE(SUM(eb.budget_value), 0) AS budgetValue
         FROM energy_budgets eb JOIN energy_types et ON et.id = eb.energy_type_id
         ${whereSql} GROUP BY eb.unit ORDER BY eb.unit`
      ).all(params).map((row) => ({ ...row, budgetCount: Number(row.budgetCount), budgetValue: Number(row.budgetValue) })),
      meta: {
        filtersApplied: { ...query },
        aggregationPolicy: '所有聚合仅使用当前筛选命中的预算；按能源类型、组织范围和月份的结果按 unit 分组，totalBudgetValue 是未换算的原始数值相加，不代表跨能源或跨单位可比值。',
        noDataFabricated: true
      }
    };
  } finally {
    db.close();
  }
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildEnergyBudgetExportRows(rows = []) {
  return rows.map((row) => ENERGY_BUDGET_EXPORT_FIELDS.reduce((output, field) => {
    output[field.header] = row[field.key] ?? '';
    return output;
  }, {}));
}

function exportEnergyBudgets(query = {}) {
  const requestedFormat = String(query.format || 'xlsx').trim().toLowerCase();
  if (!['xlsx', 'csv'].includes(requestedFormat)) {
    throw badRequest('format 仅支持 xlsx 或 csv。', { code: 'UNSUPPORTED_EXPORT_FORMAT', format: requestedFormat });
  }
  const db = openDatabase();
  try {
    const rows = selectEnergyBudgetRows(db, query, MAX_ENERGY_BUDGET_EXPORT_ROWS);
    const exportRows = buildEnergyBudgetExportRows(rows);
    const headers = ENERGY_BUDGET_EXPORT_FIELDS.map((field) => field.header);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `用能预算导出-${date}.${requestedFormat}`;
    if (requestedFormat === 'csv') {
      const lines = [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
        .map((row) => row.map(escapeCsvCell).join(','));
      return { fileName, format: 'csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${lines.join('\n')}\n`, 'utf8'), rowCount: rows.length, fields: headers, maxRows: MAX_ENERGY_BUDGET_EXPORT_ROWS };
    }
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
    worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 14), 32) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, '用能预算');
    return { fileName, format: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers, maxRows: MAX_ENERGY_BUDGET_EXPORT_ROWS };
  } finally {
    db.close();
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function timingSafeEqualText(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getEnergyBudgetImportHmacSecret() {
  const configured = normalizeText(process.env.ENERGY_BUDGET_IMPORT_HMAC_SECRET) || normalizeText(process.env.CHARCOAL_HMAC_SECRET) || normalizeText(process.env.APP_SECRET);
  if (configured) return configured;
  const db = openDatabase();
  try {
    const saved = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(ENERGY_BUDGET_IMPORT_HMAC_SECRET_META_KEY);
    if (normalizeText(saved?.value)) return saved.value;
    const generated = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO NOTHING`).run(ENERGY_BUDGET_IMPORT_HMAC_SECRET_META_KEY, generated);
    return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(ENERGY_BUDGET_IMPORT_HMAC_SECRET_META_KEY).value;
  } finally {
    db.close();
  }
}

function hmacJson(value) {
  return crypto.createHmac('sha256', getEnergyBudgetImportHmacSecret()).update(stableStringify(value)).digest('hex');
}

function getEnergyBudgetImportKey(row) {
  return `${row.periodMonth} ${row.energyTypeId} ${row.organizationScope}`;
}

function normalizeHeaderName(value) {
  return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase();
}

function mapEnergyBudgetImportFields(row = {}) {
  const mapped = {}; const fieldMapping = {};
  Object.entries(row).forEach(([header, value]) => {
    const normalizedHeader = normalizeHeaderName(header);
    const field = Object.entries(ENERGY_BUDGET_IMPORT_ALIASES).find(([, aliases]) => aliases.map(normalizeHeaderName).includes(normalizedHeader))?.[0];
    if (field && (!Object.prototype.hasOwnProperty.call(mapped, field) || !normalizeText(mapped[field]))) { mapped[field] = value; fieldMapping[field] = header; }
  });
  return { mapped, fieldMapping };
}

function createEnergyBudgetImportIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return { rowNumber, fieldName, rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue), code, message, severity };
}

function normalizeEnergyBudgetImportCandidate(row = {}) {
  return {
    candidateRowId: normalizeText(row.candidateRowId),
    rowNumber: Number(row.rowNumber),
    periodMonth: normalizeText(row.periodMonth),
    energyTypeId: Number(row.energyTypeId),
    energyTypeCode: normalizeText(row.energyTypeCode),
    organizationScope: normalizeOrganizationScope(row.organizationScope),
    budgetValue: Number(row.budgetValue),
    unit: normalizeText(row.unit),
    remark: normalizeText(row.remark),
    status: normalizeText(row.status) || 'active'
  };
}

function buildEnergyBudgetImportSignaturePayload(input = {}) {
  const candidateRows = (input.candidateRows || []).map(normalizeEnergyBudgetImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber);
  return { operation: 'energy-budget-import', importType: ENERGY_BUDGET_IMPORT_TYPE, duplicateStrategy: 'skip', targetTable: 'energy_budgets', confirmText: ENERGY_BUDGET_IMPORT_CONFIRM_TEXT, requireBackup: true, candidateRowIds: candidateRows.map((row) => row.rowNumber), candidateRows };
}

function buildEnergyBudgetImportPreviewSignature(input = {}) {
  return `${ENERGY_BUDGET_IMPORT_SIGNATURE_PREFIX}:${hmacJson(buildEnergyBudgetImportSignaturePayload(input))}`;
}

function normalizeEnergyBudgetImportAudit(preview = {}) {
  return { summary: preview.summary || {}, items: (preview.items || []).map((item) => ({ rowNumber: Number(item.rowNumber), status: item.status, reasonCodes: item.reasonCodes, reasonText: item.reasonText, reasons: item.reasons || [] })) };
}

function buildEnergyBudgetImportPreviewAuditDigest(preview = {}) {
  return `${ENERGY_BUDGET_IMPORT_AUDIT_DIGEST_PREFIX}:${hmacJson(normalizeEnergyBudgetImportAudit(preview))}`;
}

function buildEnergyBudgetImportPreviewWithDb(db, rows = []) {
  const types = new Map(db.prepare('SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types').all().map((item) => [item.code, item]));
  const existing = new Map(db.prepare('SELECT id, period_month AS periodMonth, energy_type_id AS energyTypeId, organization_scope AS organizationScope FROM energy_budgets').all().map((item) => [getEnergyBudgetImportKey(item), item]));
  const seen = new Set(); const fieldMapping = {}; const items = [];
  rows.forEach((row, index) => {
    const rowNumber = Number(row.rowNumber || row.__rowNumber || index + 2);
    const { mapped, fieldMapping: currentMapping } = mapEnergyBudgetImportFields(row);
    Object.assign(fieldMapping, currentMapping);
    const reasons = [];
    let periodMonth = null; let energyType = null; let budgetValue = null;
    try { periodMonth = normalizeMonth(mapped.periodMonth, 'periodMonth'); } catch (error) { reasons.push(createEnergyBudgetImportIssue(rowNumber, 'periodMonth', mapped.periodMonth, error.details?.code || 'INVALID_MONTH', error.message)); }
    const energyTypeCode = normalizeText(mapped.energyTypeCode);
    if (!energyTypeCode) reasons.push(createEnergyBudgetImportIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'REQUIRED_FIELD_MISSING', 'energyTypeCode / 能源类型为必填项。'));
    else { energyType = types.get(energyTypeCode); if (!energyType) reasons.push(createEnergyBudgetImportIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'UNKNOWN_ENERGY_TYPE', '未找到匹配能源类型，导入不会自动创建能源类型。')); else if (Number(energyType.isActive) !== 1) reasons.push(createEnergyBudgetImportIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'INACTIVE_ENERGY_TYPE', '预算能源类型必须为 active 状态。')); }
    try { budgetValue = parseNonNegativeNumber(mapped.budgetValue, 'budgetValue', { required: true }); if (budgetValue === null) throw badRequest('budgetValue 为必填项。', { code: 'REQUIRED_FIELD_MISSING' }); } catch (error) { reasons.push(createEnergyBudgetImportIssue(rowNumber, 'budgetValue', mapped.budgetValue, error.details?.code || 'INVALID_NON_NEGATIVE_NUMBER', error.message)); }
    const organizationScope = normalizeOrganizationScope(mapped.organizationScope);
    const unit = normalizeText(mapped.unit) || energyType?.standardUnit || null;
    const status = normalizeText(mapped.status) || 'active';
    if (!BUDGET_STATUSES.includes(status)) reasons.push(createEnergyBudgetImportIssue(rowNumber, 'status', mapped.status, 'UNSUPPORTED_ENERGY_BUDGET_VALUE', 'status 仅支持 active 或 inactive。'));
    if (normalizeText(mapped.remark)?.length > 1000) reasons.push(createEnergyBudgetImportIssue(rowNumber, 'remark', mapped.remark, 'ENERGY_BUDGET_REMARK_TOO_LONG', '备注长度不能超过 1000 个字符。'));
    const record = periodMonth && energyType && budgetValue !== null && reasons.length === 0 ? { rowNumber, periodMonth, energyTypeId: energyType.id, energyTypeCode: energyType.code, energyTypeName: energyType.name, organizationScope, budgetValue, unit, remark: normalizeText(mapped.remark), status } : null;
    let resultStatus = 'blocked';
    if (record) {
      const key = getEnergyBudgetImportKey(record);
      if (existing.has(key)) { resultStatus = 'skipped'; reasons.push(createEnergyBudgetImportIssue(rowNumber, 'periodMonth+energyTypeCode+organizationScope', `${record.periodMonth}|${record.energyTypeCode}|${record.organizationScope}`, 'DUPLICATE_ENERGY_BUDGET_SKIPPED', '已存在相同月份、能源类型和组织范围预算，按 skip 策略跳过，不覆盖已有预算。', 'warning')); }
      else if (seen.has(key)) { resultStatus = 'skipped'; reasons.push(createEnergyBudgetImportIssue(rowNumber, 'periodMonth+energyTypeCode+organizationScope', `${record.periodMonth}|${record.energyTypeCode}|${record.organizationScope}`, 'DUPLICATE_IMPORT_CANDIDATE_SKIPPED', '同一导入文件中存在重复预算候选，后续行按 skip 策略跳过。', 'warning')); }
      else { resultStatus = 'wouldImport'; seen.add(key); }
    }
    const item = { rowNumber, rowId: rowNumber, periodMonth: record?.periodMonth || normalizeText(mapped.periodMonth), energyTypeId: record?.energyTypeId || null, energyTypeCode: record?.energyTypeCode || energyTypeCode, energyTypeName: record?.energyTypeName || energyType?.name || null, organizationScope, budgetValue: record?.budgetValue ?? normalizeText(mapped.budgetValue), unit, remark: record?.remark ?? normalizeText(mapped.remark), status: resultStatus, wouldImport: resultStatus === 'wouldImport', existingBudgetId: record && existing.get(getEnergyBudgetImportKey(record))?.id || null, reasons };
    item.errors = reasons.filter((reason) => reason.severity === 'error'); item.warnings = reasons.filter((reason) => reason.severity === 'warning'); item.reasonCodes = reasons.map((reason) => reason.code).join('|'); item.reasonText = reasons.map((reason) => reason.message).join('；'); items.push(item);
  });
  const summary = { totalRows: items.length, wouldImport: items.filter((item) => item.status === 'wouldImport').length, skipped: items.filter((item) => item.status === 'skipped').length, blocked: items.filter((item) => item.status === 'blocked').length, warnings: items.reduce((count, item) => count + item.warnings.length, 0), errors: items.reduce((count, item) => count + item.errors.length, 0) };
  const candidateRows = items.filter((item) => item.wouldImport).map((item) => ({ candidateRowId: `budget:${item.periodMonth}:${item.energyTypeId}:${item.organizationScope}`, rowNumber: item.rowNumber, periodMonth: item.periodMonth, energyTypeId: item.energyTypeId, energyTypeCode: item.energyTypeCode, organizationScope: item.organizationScope, budgetValue: Number(item.budgetValue), unit: item.unit, remark: item.remark, status: 'active' }));
  const preview = { dryRun: true, previewOnly: true, writesEnergyBudgets: false, persistsImportBatch: true, duplicateStrategy: 'skip', confirmText: ENERGY_BUDGET_IMPORT_CONFIRM_TEXT, backupReason: ENERGY_BUDGET_IMPORT_BACKUP_REASON, fieldMapping, summary, candidateRowIds: candidateRows.map((item) => item.rowNumber), candidateRows, items, notices: ['preview 不写入 energy_budgets；上传 preview 会仅持久化统一导入审计批次和行级 error/warning。', 'execute 必须提供固定确认文本、previewSignature、候选行、acknowledgeSkippedRisks=true 和 requireBackup=true；签名或数据变化时拒绝写入。', '重复预算默认 skip 并保留 warning，不覆盖、不删除既有预算。'] };
  preview.previewAudit = normalizeEnergyBudgetImportAudit(preview); preview.previewAuditDigest = buildEnergyBudgetImportPreviewAuditDigest(preview); preview.previewSignature = buildEnergyBudgetImportPreviewSignature(preview); return preview;
}

function buildEnergyBudgetImportPreviewFromRows(rows = []) { const db = openDatabase(); try { return buildEnergyBudgetImportPreviewWithDb(db, rows); } finally { db.close(); } }

function collectEnergyBudgetImportAuditIssues(preview) { return (preview.items || []).flatMap((item) => (item.reasons || []).filter((reason) => ['error', 'warning'].includes(reason.severity)).map((reason) => ({ ...reason, rowNumber: item.rowNumber }))); }

function createEnergyBudgetImportPreviewFromUpload(file) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的用能预算表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  assertSupportedImportFile(file.originalname); const parsed = parseImportFile(file.path, file.originalname); const preview = buildEnergyBudgetImportPreviewFromRows(parsed.rows || []);
  const audit = createPreviewAuditBatch({ importType: ENERGY_BUDGET_IMPORT_TYPE, originalFilename: file.originalname, storedFilename: file.filename || null, filePath: file.path, fileType: String(file.originalname).split('.').pop().toLowerCase(), fileSizeBytes: file.size, duplicateStrategy: 'skip', fieldMapping: preview.fieldMapping, previewSignature: preview.previewSignature, previewAuditDigest: preview.previewAuditDigest, auditContext: { confirmText: preview.confirmText, backupReason: preview.backupReason, summary: preview.summary, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, previewAudit: preview.previewAudit, previewAuditDigest: preview.previewAuditDigest, notices: preview.notices }, statistics: { totalRows: preview.summary.totalRows, successCount: preview.summary.wouldImport, failureCount: preview.summary.blocked, skippedCount: preview.summary.skipped } });
  replaceImportAuditIssues(audit.id, collectEnergyBudgetImportAuditIssues(preview)); const auditBatch = getImportAuditSummary(audit.id);
  return { ...preview, batchId: auditBatch.id, auditBatch, persistsImportBatch: true };
}

function assertSameBudgetCandidates(actual, expected, code) {
  const left = (actual || []).map(normalizeEnergyBudgetImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber); const right = (expected || []).map(normalizeEnergyBudgetImportCandidate).sort((a, b) => a.rowNumber - b.rowNumber);
  if (stableStringify(left) !== stableStringify(right)) throw badRequest('候选行与最新预演不一致，请重新 preview 后执行。', { code, actual: left, expected: right });
}

async function executeEnergyBudgetImportInternal(body = {}) {
  const fail = (message, code) => { throw badRequest(message, { code }); };
  if (normalizeText(body.confirmText) !== ENERGY_BUDGET_IMPORT_CONFIRM_TEXT) fail('确认文本不匹配，已拒绝导入用能预算。', 'ENERGY_BUDGET_IMPORT_CONFIRM_TEXT_MISMATCH');
  if (body.acknowledgeSkippedRisks !== true) fail('必须确认已知晓重复、冲突和无效记录会被跳过。', 'ENERGY_BUDGET_IMPORT_SKIPPED_RISKS_ACK_REQUIRED');
  if (body.requireBackup !== true) fail('执行前必须要求自动备份，requireBackup 必须显式为 true。', 'ENERGY_BUDGET_IMPORT_BACKUP_REQUIRED');
  if (!Array.isArray(body.candidateRows) || !body.candidateRows.length) fail('candidateRows 必须是至少包含一条 wouldImport 候选的数组。', 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROWS_REQUIRED');
  if (!Array.isArray(body.candidateRowIds)) fail('candidateRowIds 必须是数组。', 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROW_IDS_REQUIRED');
  const candidateIds = body.candidateRowIds.map((value) => parsePositiveInteger(value, 'candidateRowIds', { required: true }));
  const candidates = body.candidateRows.map(normalizeEnergyBudgetImportCandidate);
  if (candidates.some((row) => !row.candidateRowId || !/^budget:\d{4}-\d{2}:\d+:.+$/.test(row.candidateRowId))) fail('candidateRows 必须包含 preview 生成的 candidateRowId。', 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROW_ID_INVALID');
  if (stableStringify(candidateIds) !== stableStringify(candidates.map((row) => row.rowNumber))) fail('candidateRowIds 必须与 candidateRows.rowNumber 完全一致且顺序一致。', 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROWS_IDS_MISMATCH');
  if (Number(body.expectedWouldImport) !== candidates.length) fail('expectedWouldImport 必须与 candidateRows 数量一致。', 'ENERGY_BUDGET_IMPORT_EXPECTED_COUNT_MISMATCH');
  const db = openDatabase(); let preview;
  try { preview = buildEnergyBudgetImportPreviewWithDb(db, body.candidateRows); } finally { db.close(); }
  if (!timingSafeEqualText(body.previewSignature, preview.previewSignature)) fail('当前 previewSignature 与重新计算结果不一致，请重新 preview 后执行。', 'ENERGY_BUDGET_IMPORT_PREVIEW_SIGNATURE_MISMATCH');
  if (preview.summary.wouldImport !== candidates.length) fail('执行前预演候选数量已变化，请重新 preview 后执行。', 'ENERGY_BUDGET_IMPORT_WOULD_IMPORT_MISMATCH');
  assertSameBudgetCandidates(preview.candidateRows, body.candidateRows, 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROWS_MISMATCH');
  const requestedBatchId = body.batchId ? parsePositiveInteger(body.batchId, 'batchId', { required: true }) : null;
  let auditBatch = null;
  if (requestedBatchId) { auditBatch = getImportAuditBatchDetail(requestedBatchId, { includeIssues: false }); if (auditBatch.importType !== ENERGY_BUDGET_IMPORT_TYPE || !timingSafeEqualText(auditBatch.previewSignature, body.previewSignature)) fail('batchId 与预算 previewSignature 不匹配。', 'ENERGY_BUDGET_IMPORT_AUDIT_BATCH_MISMATCH'); }
  const backup = { ...(await backupService.createBackup({ reason: ENERGY_BUDGET_IMPORT_BACKUP_REASON })), requestedReason: ENERGY_BUDGET_IMPORT_BACKUP_REASON };
  const writeDb = openDatabase();
  try {
    const result = writeDb.transaction(() => {
      const latest = buildEnergyBudgetImportPreviewWithDb(writeDb, body.candidateRows);
      if (!timingSafeEqualText(body.previewSignature, latest.previewSignature) || latest.summary.wouldImport !== candidates.length) fail('写入前预算数据已变化，请重新 preview 后执行。', 'ENERGY_BUDGET_IMPORT_EXPIRED_PREVIEW');
      assertSameBudgetCandidates(latest.candidateRows, body.candidateRows, 'ENERGY_BUDGET_IMPORT_CANDIDATE_ROWS_MISMATCH');
      const insert = writeDb.prepare(`INSERT INTO energy_budgets (source_batch_id, source_row_number, period_month, energy_type_id, organization_scope, budget_value, unit, remark, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const now = getNow(); const importedRecords = latest.candidateRows.map((row) => { const inserted = insert.run(auditBatch?.id || null, auditBatch ? row.rowNumber : null, row.periodMonth, row.energyTypeId, row.organizationScope, row.budgetValue, row.unit, row.remark, row.status, now, now); return getBudgetById(writeDb, inserted.lastInsertRowid); });
      const resultData = { executed: true, dryRun: false, writesEnergyBudgets: true, persistsImportBatch: Boolean(auditBatch), imported: importedRecords.length, skipped: auditBatch?.auditContext?.summary?.skipped ?? 0, blocked: auditBatch?.auditContext?.summary?.blocked ?? 0, warnings: auditBatch?.auditContext?.summary?.warnings ?? 0, errors: auditBatch?.auditContext?.summary?.errors ?? 0, previewSignature: latest.previewSignature, previewAuditDigest: latest.previewAuditDigest, expectedWouldImport: candidates.length, candidateRowIds: latest.candidateRowIds, importedIds: importedRecords.map((row) => row.id), importedRecords, backup, note: '已按最新 preview 的 wouldImport 候选写入预算；重复、冲突和无效行保持 skip，不覆盖也不删除既有预算。' };
      if (!auditBatch) return resultData;
      const updated = updateExecuteAuditResult(auditBatch.id, { status: resultData.skipped || resultData.blocked ? 'completed_with_errors' : 'completed', statistics: { totalRows: auditBatch.totalRows, successCount: resultData.imported, failureCount: resultData.blocked, skippedCount: resultData.skipped }, executeResult: resultData, backup }, { db: writeDb });
      return { ...resultData, batchId: updated.id, auditBatch: getImportAuditSummary(updated.id, { db: writeDb }) };
    });
    return result();
  } finally { writeDb.close(); }
}

function markEnergyBudgetImportAuditFailure(body = {}, error) {
  try {
    if (!body.batchId) return;
    const batchId = parsePositiveInteger(body.batchId, 'batchId', { required: true });
    const batch = getImportAuditBatchDetail(batchId, { includeIssues: false });
    if (batch.importType !== ENERGY_BUDGET_IMPORT_TYPE || (batch.auditPhase === 'execute' && ['completed', 'completed_with_errors'].includes(batch.status))) return;
    updateExecuteAuditResult(batchId, {
      status: 'failed',
      statistics: { totalRows: Number(batch.totalRows || 0), successCount: 0, failureCount: Number(batch.failureCount || 0), skippedCount: Number(batch.skippedCount || 0) },
      executeResult: { executed: false, writesEnergyBudgets: false, errorCode: error?.details?.code || error?.code || 'ENERGY_BUDGET_IMPORT_EXECUTE_FAILED', errorMessage: error?.message || '用能预算导入执行失败。' },
      backup: null,
      errorSummary: error?.message || '用能预算导入执行失败。'
    });
  } catch (_) {
    // 审计失败标记不得掩盖原始导入拒绝原因。
  }
}

async function executeEnergyBudgetImport(body = {}) {
  try {
    return await executeEnergyBudgetImportInternal(body);
  } catch (error) {
    markEnergyBudgetImportAuditFailure(body, error);
    throw error;
  }
}

function getEnergyBudgetContract() {
  return {
    status: 'unified-management-api-ready',
    table: 'energy_budgets',
    fields: ['periodMonth', 'energyTypeId/energyTypeCode', 'organizationScope', 'budgetValue', 'unit', 'remark', 'status'],
    statuses: BUDGET_STATUSES,
    deletionPolicy: '不提供物理删除；仅通过 PATCH /:id/status 在 active/inactive 间启停，历史记录与导入审计保留。',
    list: {
      filters: ['page', 'pageSize', 'periodMonth', 'monthStart', 'monthEnd', 'energyTypeCode', 'energyTypeId', 'organizationScope', 'status', 'keyword/search'],
      response: 'data 为兼容 rows 数组，meta.pagination 返回 page/pageSize/total/totalPages；服务层同时返回 rows + pagination。',
      searchFields: ['organizationScope', 'remark', 'energyTypeCode', 'energyTypeName']
    },
    warningThreshold: WARNING_THRESHOLD,
    routes: {
      list: 'GET /api/energy-budgets', stats: 'GET /api/energy-budgets/stats', upsert: 'POST /api/energy-budgets', update: 'PUT /api/energy-budgets/:id', setStatus: 'PATCH /api/energy-budgets/:id/status', executionComparison: 'GET /api/energy-budgets/execution-comparison', export: 'GET /api/energy-budgets/export?format=xlsx|csv', importPreview: 'POST /api/energy-budgets/import/preview', importExecute: 'POST /api/energy-budgets/import/execute', template: 'GET /api/templates/energy-budgets.xlsx|csv', contract: 'GET /api/energy-budgets/contract'
    },
    permissions: { view: 'energy:budget:view', create: 'energy:budget:create', update: 'energy:budget:update', status: 'energy:budget:status', import: 'energy:budget:import', export: 'energy:budget:export', template: 'energy:budget:template' },
    stats: { appliesCurrentFilters: true, fields: ['totalBudgets', 'activeCount', 'inactiveCount', 'totalBudgetValue', 'totalsByUnit', 'byEnergyType', 'byOrganizationScope', 'monthlyTrend'], aggregationPolicy: '不做跨能源或跨单位换算；分组结果均含 unit，totalBudgetValue 为透明的原始数值相加。' },
    export: { formats: ['xlsx', 'csv'], fields: ENERGY_BUDGET_EXPORT_FIELDS, maxRows: MAX_ENERGY_BUDGET_EXPORT_ROWS, appliesCurrentFilters: true },
    template: { type: ENERGY_BUDGET_IMPORT_TEMPLATE_ID, headers: ENERGY_BUDGET_IMPORT_HEADERS, aliases: ENERGY_BUDGET_IMPORT_ALIASES },
    import: { preview: { dryRun: true, writesEnergyBudgets: false, persistsImportBatch: true, response: ['summary', 'items', 'candidateRowIds', 'candidateRows', 'previewSignature', 'previewAuditDigest', 'batchId'], duplicateStrategy: 'skip' }, execute: { requiredFields: ['confirmText', 'previewSignature', 'expectedWouldImport', 'candidateRowIds', 'candidateRows', 'requireBackup', 'acknowledgeSkippedRisks'], confirmText: ENERGY_BUDGET_IMPORT_CONFIRM_TEXT, requireBackup: true, defaultDuplicateStrategy: 'skip', writes: '仅写入 energy_budgets 并关联统一 import_batches/import_errors 审计；不覆盖或物理删除既有预算。' } },
    executionComparisonFields: ['comparisonStatus', 'isComparable', 'budgetUnit', 'actualUnit', 'warningLevel', 'warningLabel', 'warningReason', 'warningThreshold', 'summary.nearingCount', 'summary.exceededCount', 'summary.missingBudgetCount', 'summary.unitMismatchCount', 'summary.totalsByUnit'],
    comparisonStatuses: ['comparable', 'no_actual', 'missing_budget', 'unit_mismatch', 'no_data'],
    warningLevels: ['normal', 'nearing', 'exceeded', 'missing_budget', 'unit_mismatch'],
    uniqueness: 'periodMonth + energyType + organizationScope 唯一；手工 POST 保持既有同 key 更新兼容性，导入重复始终 skip，不物理删除。',
    executionComparisonPolicy: '以 active 预算组合与 active 实际能耗组合的并集生成结果；实际数据按月份、能源类型、normalizedUnit 和现有组织范围键分组；停用预算不参与；默认 80% 接近预算、100% 超预算；无 active 预算但有实际记录返回 missing_budget；预算单位与实际单位不一致返回 unit_mismatch 且不计算差异、使用率或阈值预警；不做单位换算、跨能源折标煤、碳预算、预测联动、通知或审批。'
  };
}

module.exports = {
  BUDGET_STATUSES,
  ENERGY_BUDGET_EXPORT_FIELDS,
  ENERGY_BUDGET_IMPORT_ALIASES,
  ENERGY_BUDGET_IMPORT_CONFIRM_TEXT,
  ENERGY_BUDGET_IMPORT_HEADERS,
  ENERGY_BUDGET_IMPORT_TEMPLATE_ID,
  ENERGY_BUDGET_IMPORT_TYPE,
  MAX_ENERGY_BUDGET_EXPORT_ROWS,
  WHOLE_ORGANIZATION_SCOPE,
  buildActualEnergyWhere,
  buildEnergyBudgetImportPreviewFromRows,
  buildEnergyBudgetStats,
  createEnergyBudgetImportPreviewFromUpload,
  executeEnergyBudgetImport,
  exportEnergyBudgets,
  getEnergyBudgetContract,
  getEnergyBudgetExecutionComparison,
  listEnergyBudgets,
  normalizeBudgetPayload,
  normalizeMonth,
  normalizeOrganizationScope,
  setEnergyBudgetStatus,
  summarizeComparisonRows,
  updateEnergyBudget,
  upsertEnergyBudget
};
