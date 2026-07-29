const { badRequest } = require('../utils/errors');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const STATISTICS_MAX_PAGE_SIZE = 1000;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const DIMENSION_COLUMNS = Object.freeze({
  organization: 'er.organization',
  site: 'er.site',
  department: 'er.department'
});

const DETAIL_SORT_COLUMNS = Object.freeze({
  normalizedMonth: 'er.normalized_month',
  energyTypeCode: 'et.code',
  normalizedValue: 'er.normalized_value',
  organization: 'er.organization',
  site: 'er.site',
  department: 'er.department',
  sourceBatchId: 'er.source_batch_id',
  createdAt: 'er.created_at'
});

function firstDefined(query, keys) {
  for (const key of keys) {
    if (query[key] !== undefined && query[key] !== null && String(query[key]).trim() !== '') {
      return query[key];
    }
  }
  return undefined;
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function normalizeMonth(value, fieldName) {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }

  if (!MONTH_PATTERN.test(text)) {
    throw badRequest(`${fieldName} 必须使用 YYYY-MM 格式，且月份范围为 01-12。`, {
      code: 'INVALID_MONTH_FILTER',
      fieldName,
      rawValue: text
    });
  }

  return text;
}

function normalizePositiveInteger(value, fieldName) {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }

  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code: 'INVALID_POSITIVE_INTEGER',
      fieldName,
      rawValue: text
    });
  }

  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, {
      code: 'INVALID_POSITIVE_INTEGER',
      fieldName,
      rawValue: text
    });
  }

  return numberValue;
}

function normalizePagination(query = {}, options = {}) {
  const defaultPageSize = options.defaultPageSize || DEFAULT_PAGE_SIZE;
  const maxPageSize = options.maxPageSize || MAX_PAGE_SIZE;
  const page = normalizePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = normalizePositiveInteger(query.pageSize, 'pageSize') || defaultPageSize;
  const pageSize = Math.min(requestedPageSize, maxPageSize);

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    maxPageSize
  };
}

function normalizeEnergyRecordFilters(query = {}) {
  const normalizedMonthStart = normalizeMonth(
    firstDefined(query, ['normalizedMonthStart', 'monthStart', 'startMonth']),
    'normalizedMonthStart'
  );
  const normalizedMonthEnd = normalizeMonth(
    firstDefined(query, ['normalizedMonthEnd', 'monthEnd', 'endMonth']),
    'normalizedMonthEnd'
  );

  if (normalizedMonthStart && normalizedMonthEnd && normalizedMonthStart > normalizedMonthEnd) {
    throw badRequest('月份范围开始值不能晚于结束值。', {
      code: 'INVALID_MONTH_RANGE',
      normalizedMonthStart,
      normalizedMonthEnd
    });
  }

  return {
    normalizedMonthStart,
    normalizedMonthEnd,
    energyTypeCode: normalizeText(query.energyTypeCode),
    organization: normalizeText(query.organization),
    site: normalizeText(query.site),
    department: normalizeText(query.department),
    organizationUnitId: normalizePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id', 'orgId']), 'organizationUnitId'),
    meterDeviceId: normalizePositiveInteger(firstDefined(query, ['meterDeviceId', 'meter_device_id', 'meterId']), 'meterDeviceId'),
    sourceBatchId: normalizePositiveInteger(query.sourceBatchId, 'sourceBatchId')
  };
}

function buildEnergyRecordWhere(filters = {}) {
  const where = ["er.record_status = 'active'"];
  const params = {};

  if (filters.normalizedMonthStart) {
    where.push('er.normalized_month >= @normalizedMonthStart');
    params.normalizedMonthStart = filters.normalizedMonthStart;
  }
  if (filters.normalizedMonthEnd) {
    where.push('er.normalized_month <= @normalizedMonthEnd');
    params.normalizedMonthEnd = filters.normalizedMonthEnd;
  }
  if (filters.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.organization) {
    where.push('er.organization = @organization');
    params.organization = filters.organization;
  }
  if (filters.site) {
    where.push('er.site = @site');
    params.site = filters.site;
  }
  if (filters.department) {
    where.push('er.department = @department');
    params.department = filters.department;
  }
  if (filters.organizationUnitId) {
    where.push('er.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = filters.organizationUnitId;
  }
  if (filters.meterDeviceId) {
    where.push('er.meter_device_id = @meterDeviceId');
    params.meterDeviceId = filters.meterDeviceId;
  }
  if (filters.sourceBatchId) {
    where.push('er.source_batch_id = @sourceBatchId');
    params.sourceBatchId = filters.sourceBatchId;
  }

  return {
    whereSql: `WHERE ${where.join(' AND ')}`,
    params
  };
}

function normalizeDetailSort(query = {}) {
  const sortBy = normalizeText(query.sortBy) || 'normalizedMonth';
  const sortOrder = (normalizeText(query.sortOrder) || 'desc').toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(DETAIL_SORT_COLUMNS, sortBy)) {
    throw badRequest('sortBy 不在允许排序字段白名单内。', {
      code: 'UNSUPPORTED_SORT_FIELD',
      sortBy,
      allowedSortFields: Object.keys(DETAIL_SORT_COLUMNS)
    });
  }

  if (!['asc', 'desc'].includes(sortOrder)) {
    throw badRequest('sortOrder 仅支持 asc 或 desc。', {
      code: 'UNSUPPORTED_SORT_ORDER',
      sortOrder,
      allowedSortOrders: ['asc', 'desc']
    });
  }

  return {
    sortBy,
    sortOrder,
    orderSql: `${DETAIL_SORT_COLUMNS[sortBy]} ${sortOrder.toUpperCase()}, et.display_order ASC, er.id DESC`
  };
}

function normalizeDimension(value) {
  const dimension = normalizeText(value) || 'organization';
  if (!Object.prototype.hasOwnProperty.call(DIMENSION_COLUMNS, dimension)) {
    throw badRequest('dimension 仅支持 organization、site、department。', {
      code: 'UNSUPPORTED_DIMENSION',
      dimension,
      allowedDimensions: Object.keys(DIMENSION_COLUMNS)
    });
  }

  return {
    dimension,
    columnSql: DIMENSION_COLUMNS[dimension]
  };
}

function buildPaginationMeta(page, pageSize, total) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize)
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  DETAIL_SORT_COLUMNS,
  DIMENSION_COLUMNS,
  MAX_PAGE_SIZE,
  STATISTICS_MAX_PAGE_SIZE,
  buildEnergyRecordWhere,
  buildPaginationMeta,
  normalizeDetailSort,
  normalizeDimension,
  normalizeEnergyRecordFilters,
  normalizeMonth,
  normalizePagination,
  normalizePositiveInteger
};
