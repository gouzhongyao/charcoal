const { badRequest } = require('../utils/errors');

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DEFAULT_REGION = 'default';
const DEFAULT_CALCULATION_METHOD = 'standard-factor';
const DEFAULT_EMISSION_UNIT = 'kgCO2e';
const DEFAULT_PRECISION = 6;

const EMISSION_GROUP_COLUMNS = Object.freeze({
  month: 'er.normalized_month',
  energyType: 'et.code',
  organization: 'er.organization',
  site: 'er.site'
});

const EMISSION_SORT_COLUMNS = Object.freeze({
  calculatedAt: 'ce.calculated_at',
  normalizedMonth: 'er.normalized_month',
  energyTypeCode: 'et.code',
  emissionValue: 'ce.emission_value',
  status: 'ce.status',
  organization: 'er.organization',
  site: 'er.site'
});

function normalizeText(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function normalizeRegion(value) {
  const text = normalizeText(value);
  if (!text) {
    return DEFAULT_REGION;
  }

  const lowered = text.toLowerCase();
  if (['default', 'national', 'nationwide', 'all'].includes(lowered) || ['全国', '默认', '通用'].includes(text)) {
    return DEFAULT_REGION;
  }

  return text;
}

function normalizeCalculationMethod(value) {
  return normalizeText(value) || DEFAULT_CALCULATION_METHOD;
}

function normalizeYear(value, fieldName = 'factorYear') {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  if (!/^\d{4}$/.test(text)) {
    throw badRequest(`${fieldName} 必须为四位年份。`, {
      code: 'INVALID_YEAR',
      fieldName,
      rawValue: text
    });
  }

  const year = Number.parseInt(text, 10);
  if (year < 1900 || year > 2200) {
    throw badRequest(`${fieldName} 必须在 1900-2200 之间。`, {
      code: 'INVALID_YEAR',
      fieldName,
      rawValue: text
    });
  }

  return year;
}

function extractYearFromMonth(month) {
  const text = normalizeText(month);
  if (!text || !MONTH_PATTERN.test(text)) {
    throw badRequest('月份必须使用 YYYY-MM 格式，且月份范围为 01-12。', {
      code: 'INVALID_MONTH',
      rawValue: text
    });
  }

  return Number.parseInt(text.slice(0, 4), 10);
}

function normalizePositiveNumber(value, fieldName) {
  const text = normalizeText(value);
  if (!text || !/^\d+(\.\d+)?$/.test(text)) {
    throw badRequest(`${fieldName} 必须是大于 0 的数字。`, {
      code: 'INVALID_POSITIVE_NUMBER',
      fieldName,
      rawValue: text
    });
  }

  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是大于 0 的数字。`, {
      code: 'INVALID_POSITIVE_NUMBER',
      fieldName,
      rawValue: text
    });
  }

  return numberValue;
}

function normalizeBooleanFlag(value, fieldName = 'isActive') {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return 1;
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return 0;
  }

  throw badRequest(`${fieldName} 仅支持 true/false 或 1/0。`, {
    code: 'INVALID_BOOLEAN_FLAG',
    fieldName,
    rawValue: value
  });
}

function roundToPrecision(value, precision = DEFAULT_PRECISION) {
  const multiplier = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function calculateEmissionValue(activityValue, factorValue, precision = DEFAULT_PRECISION) {
  const activityNumber = Number(activityValue);
  const factorNumber = Number(factorValue);
  if (!Number.isFinite(activityNumber) || activityNumber < 0) {
    throw badRequest('activityValue 必须是大于等于 0 的数字。', {
      code: 'INVALID_ACTIVITY_VALUE',
      activityValue
    });
  }
  if (!Number.isFinite(factorNumber) || factorNumber <= 0) {
    throw badRequest('factorValue 必须是大于 0 的数字。', {
      code: 'INVALID_FACTOR_VALUE',
      factorValue
    });
  }

  return roundToPrecision(activityNumber * factorNumber, precision);
}

function factorPriority(candidate, requestedRegion, factorYear) {
  const candidateRegion = normalizeRegion(candidate.region);
  const candidateYear = candidate.factorYear === undefined ? null : candidate.factorYear;
  const activePriority = candidate.isActive === 1 || candidate.isActive === true ? 0 : 1;
  const yearPriority = candidateYear === factorYear ? 0 : 1;
  const regionPriority = candidateRegion === requestedRegion ? 0 : 1;
  return [activePriority, yearPriority, regionPriority, candidate.id || 0];
}

function compareFactorPriority(left, right, requestedRegion, factorYear) {
  const leftPriority = factorPriority(left, requestedRegion, factorYear);
  const rightPriority = factorPriority(right, requestedRegion, factorYear);

  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] !== rightPriority[index]) {
      if (index === 3) {
        return rightPriority[index] - leftPriority[index];
      }
      return leftPriority[index] - rightPriority[index];
    }
  }

  return 0;
}

function selectBestCarbonFactor(record, candidates, options = {}) {
  const requestedRegion = normalizeRegion(options.region);
  const factorYear = options.factorYear || extractYearFromMonth(record.normalizedMonth);
  const energyTypeCode = record.energyTypeCode;
  const normalizedUnit = record.normalizedUnit;

  const usableCandidates = (candidates || []).filter((candidate) => {
    const candidateActive = candidate.isActive === 1 || candidate.isActive === true;
    const sameEnergyType = candidate.energyTypeCode === energyTypeCode;
    const sameUnit = candidate.unit === normalizedUnit;
    const candidateRegion = normalizeRegion(candidate.region);
    const candidateYear = candidate.factorYear === undefined ? null : candidate.factorYear;
    const regionMatched = candidateRegion === requestedRegion || candidateRegion === DEFAULT_REGION;
    const yearMatched = candidateYear === factorYear || candidateYear === null;
    return candidateActive && sameEnergyType && sameUnit && regionMatched && yearMatched;
  });

  if (usableCandidates.length === 0) {
    return {
      factor: null,
      missing: {
        energyRecordId: record.id,
        energyTypeCode,
        energyTypeName: record.energyTypeName,
        normalizedMonth: record.normalizedMonth,
        normalizedUnit,
        normalizedValue: record.normalizedValue,
        requestedRegion,
        factorYear,
        reason: '未找到匹配的启用碳因子。'
      }
    };
  }

  usableCandidates.sort((left, right) => compareFactorPriority(left, right, requestedRegion, factorYear));
  return { factor: usableCandidates[0], missing: null };
}

function normalizeEmissionGroupBy(value) {
  const groupBy = normalizeText(value) || 'month';
  if (!Object.prototype.hasOwnProperty.call(EMISSION_GROUP_COLUMNS, groupBy)) {
    throw badRequest('groupBy 仅支持 month、energyType、organization、site。', {
      code: 'UNSUPPORTED_EMISSION_GROUP_BY',
      groupBy,
      allowedGroupBy: Object.keys(EMISSION_GROUP_COLUMNS)
    });
  }

  return {
    groupBy,
    columnSql: EMISSION_GROUP_COLUMNS[groupBy]
  };
}

function normalizeEmissionSort(query = {}) {
  const sortBy = normalizeText(query.sortBy) || 'calculatedAt';
  const sortOrder = (normalizeText(query.sortOrder) || 'desc').toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(EMISSION_SORT_COLUMNS, sortBy)) {
    throw badRequest('sortBy 不在碳排放结果排序字段白名单内。', {
      code: 'UNSUPPORTED_EMISSION_SORT_FIELD',
      sortBy,
      allowedSortFields: Object.keys(EMISSION_SORT_COLUMNS)
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
    orderSql: `${EMISSION_SORT_COLUMNS[sortBy]} ${sortOrder.toUpperCase()}, ce.id DESC`
  };
}

module.exports = {
  DEFAULT_CALCULATION_METHOD,
  DEFAULT_EMISSION_UNIT,
  DEFAULT_PRECISION,
  DEFAULT_REGION,
  EMISSION_GROUP_COLUMNS,
  EMISSION_SORT_COLUMNS,
  calculateEmissionValue,
  extractYearFromMonth,
  normalizeBooleanFlag,
  normalizeCalculationMethod,
  normalizeEmissionGroupBy,
  normalizeEmissionSort,
  normalizePositiveNumber,
  normalizeRegion,
  normalizeText,
  normalizeYear,
  roundToPrecision,
  selectBestCarbonFactor
};
