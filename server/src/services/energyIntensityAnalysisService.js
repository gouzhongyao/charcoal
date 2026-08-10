'use strict';

const database = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const { ENERGY_ANALYSIS_VERSIONS } = require('./energyAnalysisContracts');
const { roundAnalysisValue } = require('./energyAnalysisUtils');

// 严格单位产品能耗公式版本，不沿用 productionService 的首期混合口径。
const ENERGY_INTENSITY_FORMULA_VERSION = 'energy-intensity-analysis:v1';
// 强度分析允许查询的最少月份数。
const MIN_ENERGY_INTENSITY_MONTHS = 1;
// 强度分析允许查询的最大月份数。
const MAX_ENERGY_INTENSITY_MONTHS = 36;
// 分子和分母单表查询允许的最大事实数量。
const MAX_ENERGY_INTENSITY_RECORDS = 50000;
// 查询多取一条，仅用于识别超限并拒绝。
const ENERGY_INTENSITY_QUERY_LIMIT = MAX_ENERGY_INTENSITY_RECORDS + 1;
// 单次响应允许返回的最大能源和单位分面数量。
const MAX_ENERGY_INTENSITY_FACETS = 100;
// 单个月份公开的分子或分母记录引用上限，避免证据数组无界增长。
const MAX_ENERGY_INTENSITY_EVIDENCE_IDS = 100;
// 月份参数必须严格采用 YYYY-MM。
const STRICT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// 可选文本筛选拒绝 SQL 分隔符、注释和控制字符。
const UNSAFE_FILTER_TEXT_PATTERN = /['";]|--|\/\*|\*\/|[\x00-\x1F\x7F]/;

/**
 * 判断输入是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范正整数 ID。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {number} 正整数。
 */
function normalizePositiveInteger(value, fieldName, code) {
  const normalizedText = typeof value === 'number' ? String(value) : value;
  if (typeof normalizedText !== 'string' || !/^\d+$/.test(normalizedText.trim())) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code, fieldName });
  }
  const normalizedValue = Number(normalizedText.trim());
  if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code, fieldName });
  }
  return normalizedValue;
}

/**
 * 规范严格月份参数。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @returns {string} YYYY-MM 月份。
 */
function normalizeMonth(value, fieldName) {
  if (typeof value !== 'string' || !STRICT_MONTH_PATTERN.test(value.trim())) {
    throw badRequest(`${fieldName} 必须使用 YYYY-MM 格式。`, {
      code: 'INVALID_ENERGY_INTENSITY_MONTH',
      fieldName
    });
  }
  return value.trim();
}

/**
 * 规范可选安全文本筛选。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @returns {string|null} 规范文本或空值。
 */
function normalizeOptionalFilter(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === ''
    || value.length > 100 || UNSAFE_FILTER_TEXT_PATTERN.test(value)) {
    throw badRequest(`${fieldName} 不是安全的筛选文本。`, {
      code: 'INVALID_ENERGY_INTENSITY_FILTER',
      fieldName
    });
  }
  return value.trim();
}

/**
 * 将月份转换为连续月份序号。
 * @param {string} month YYYY-MM。
 * @returns {number} 连续月份序号。
 */
function monthToIndex(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return year * 12 + monthNumber - 1;
}

/**
 * 将连续月份序号转换为 YYYY-MM。
 * @param {number} monthIndex 连续月份序号。
 * @returns {string} YYYY-MM。
 */
function indexToMonth(monthIndex) {
  const year = Math.floor(monthIndex / 12);
  const monthNumber = monthIndex % 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

/**
 * 构造闭区间月份列表。
 * @param {string} startMonth 起始月份。
 * @param {string} endMonth 结束月份。
 * @returns {string[]} 月份列表。
 */
function buildMonthRange(startMonth, endMonth) {
  const startIndex = monthToIndex(startMonth);
  const endIndex = monthToIndex(endMonth);
  return Array.from(
    { length: endIndex - startIndex + 1 },
    (_unused, offset) => indexToMonth(startIndex + offset)
  );
}

/**
 * 规范严格强度分析输入。
 * @param {*} input 原始输入。
 * @returns {object} 规范输入。
 */
function normalizeEnergyIntensityInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('消费量和强度查询参数必须是对象。', {
      code: 'INVALID_ENERGY_INTENSITY_INPUT'
    });
  }
  const productionUnitId = normalizePositiveInteger(
    input.productionUnitId,
    'productionUnitId',
    'INVALID_PRODUCTION_UNIT_ID'
  );
  const startMonth = normalizeMonth(input.startMonth, 'startMonth');
  const endMonth = normalizeMonth(input.endMonth, 'endMonth');
  const startIndex = monthToIndex(startMonth);
  const endIndex = monthToIndex(endMonth);
  if (startIndex > endIndex) {
    throw badRequest('startMonth 不得晚于 endMonth。', {
      code: 'INVALID_ENERGY_INTENSITY_MONTH_RANGE',
      startMonth,
      endMonth
    });
  }
  const monthCount = endIndex - startIndex + 1;
  if (monthCount < MIN_ENERGY_INTENSITY_MONTHS || monthCount > MAX_ENERGY_INTENSITY_MONTHS) {
    throw badRequest(`强度分析月份数必须在 ${MIN_ENERGY_INTENSITY_MONTHS} 至 ${MAX_ENERGY_INTENSITY_MONTHS} 之间。`, {
      code: 'ENERGY_INTENSITY_MONTH_RANGE_EXCEEDED',
      minimumMonths: MIN_ENERGY_INTENSITY_MONTHS,
      maximumMonths: MAX_ENERGY_INTENSITY_MONTHS,
      actualMonths: monthCount
    });
  }
  return {
    productionUnitId,
    startMonth,
    endMonth,
    monthCount,
    months: buildMonthRange(startMonth, endMonth),
    energyTypeCode: normalizeOptionalFilter(input.energyTypeCode, 'energyTypeCode'),
    unit: normalizeOptionalFilter(input.unit, 'unit')
  };
}

/**
 * 查询产能单元和精确所属用能单元。
 * @param {object} db SQLite 连接。
 * @param {number} productionUnitId 产能单元 ID。
 * @returns {object} 产能单元范围。
 */
function resolveProductionScope(db, productionUnitId) {
  const productionUnit = db.prepare(
    `SELECT production.id,
            production.unit_code AS unitCode,
            production.unit_name AS unitName,
            production.organization_unit_id AS organizationUnitId,
            production.product_name AS productName,
            production.output_unit AS outputUnit,
            production.status,
            organization.unit_code AS organizationUnitCode,
            organization.unit_name AS organizationUnitName
       FROM production_units AS production
       JOIN organization_units AS organization
         ON organization.id = production.organization_unit_id
      WHERE production.id = ?`
  ).get(productionUnitId);
  if (!productionUnit) {
    throw notFound('产能单元不存在。', { productionUnitId });
  }
  return productionUnit;
}

/**
 * 查询 active 产量分母事实。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @returns {object[]} 产量事实。
 */
function queryOutputRows(db, input) {
  return db.prepare(
    `SELECT id,
            normalized_month AS normalizedMonth,
            output_value AS outputValue,
            output_unit AS outputUnit,
            data_source AS dataSource
       FROM production_output_records
      WHERE production_unit_id = @productionUnitId
        AND record_status = 'active'
        AND normalized_month BETWEEN @startMonth AND @endMonth
      ORDER BY normalized_month ASC, id ASC
      LIMIT ${ENERGY_INTENSITY_QUERY_LIMIT}`
  ).all(input);
}

/**
 * 查询精确组织 active 能耗分子事实，按白名单筛选参数化执行。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @param {object} scope 产能单元范围。
 * @returns {object[]} 能耗事实。
 */
function queryEnergyRows(db, input, scope) {
  const parameters = {
    organizationUnitId: scope.organizationUnitId,
    startMonth: input.startMonth,
    endMonth: input.endMonth,
    energyTypeCode: input.energyTypeCode,
    unit: input.unit
  };
  const energyTypeFilter = input.energyTypeCode ? ' AND energy.code = @energyTypeCode' : '';
  const unitFilter = input.unit ? ' AND record.normalized_unit = @unit' : '';
  return db.prepare(
    `SELECT record.id,
            record.normalized_month AS normalizedMonth,
            record.normalized_value AS normalizedValue,
            record.normalized_unit AS normalizedUnit,
            energy.id AS energyTypeId,
            energy.code AS energyTypeCode,
            energy.name AS energyTypeName,
            energy.standard_unit AS energyStandardUnit
       FROM energy_records AS record
       JOIN energy_types AS energy ON energy.id = record.energy_type_id
      WHERE record.organization_unit_id = @organizationUnitId
        AND record.record_status = 'active'
        AND record.normalized_month BETWEEN @startMonth AND @endMonth
        ${energyTypeFilter}
        ${unitFilter}
      ORDER BY energy.code ASC, record.normalized_unit ASC,
               record.normalized_month ASC, record.id ASC
      LIMIT ${ENERGY_INTENSITY_QUERY_LIMIT}`
  ).all(parameters);
}

/**
 * 按月份构造分母事实，并区分缺失、真实零值和单位不兼容。
 * @param {object[]} outputRows 产量事实。
 * @param {object} scope 产能单元范围。
 * @param {string[]} months 月份列表。
 * @returns {Map<string, object>} 月份到分母事实的映射。
 */
function buildDenominatorByMonth(outputRows, scope, months) {
  const rowsByMonth = new Map();
  outputRows.forEach((row) => {
    const monthRows = rowsByMonth.get(row.normalizedMonth) || [];
    monthRows.push(row);
    rowsByMonth.set(row.normalizedMonth, monthRows);
  });
  return new Map(months.map((month) => {
    const monthRows = rowsByMonth.get(month) || [];
    const units = [...new Set(monthRows.map((row) => row.outputUnit))].sort();
    const values = monthRows.map((row) => Number(row.outputValue));
    const total = values.length === 0
      ? null
      : roundAnalysisValue(values.reduce((sum, value) => sum + value, 0));
    let status = 'available';
    const reasonCodes = [];
    if (monthRows.length === 0) {
      status = 'denominator_missing';
      reasonCodes.push('MISSING_PRODUCTION_OUTPUT');
    } else if (units.length !== 1 || units[0] !== scope.outputUnit) {
      status = 'denominator_unit_incompatible';
      reasonCodes.push('UNIT_NOT_COMPARABLE');
    } else if (!Number.isFinite(total)) {
      status = 'numeric_overflow';
      reasonCodes.push('UNIT_NOT_COMPARABLE');
    } else if (total === 0) {
      status = 'denominator_zero';
    }
    return [month, {
      status,
      value: Number.isFinite(total) ? total : null,
      unit: units.length === 1 ? units[0] : null,
      expectedUnit: scope.outputUnit,
      recordCount: monthRows.length,
      recordIds: monthRows.slice(0, MAX_ENERGY_INTENSITY_EVIDENCE_IDS)
        .map((row) => Number(row.id)),
      recordIdsTruncated: monthRows.length > MAX_ENERGY_INTENSITY_EVIDENCE_IDS,
      dataSources: [...new Set(monthRows.map((row) => row.dataSource))].sort(),
      reasonCodes
    }];
  }));
}

/**
 * 构造能源类型和单位分面键。
 * @param {object} row 能耗事实。
 * @returns {string} 分面键。
 */
function buildFacetKey(row) {
  return `${row.energyTypeId}::${row.normalizedUnit}`;
}

/**
 * 将分面事实转换为逐月强度，并严格保留不可计算状态。
 * @param {object[]} facetRows 分面能耗事实。
 * @param {object} facetIdentity 分面身份。
 * @param {object} input 规范输入。
 * @param {Map<string, object>} denominatorByMonth 分母映射。
 * @returns {object} 强度分面。
 */
function buildIntensityFacet(facetRows, facetIdentity, input, denominatorByMonth) {
  const rowsByMonth = new Map();
  facetRows.forEach((row) => {
    const monthRows = rowsByMonth.get(row.normalizedMonth) || [];
    monthRows.push(row);
    rowsByMonth.set(row.normalizedMonth, monthRows);
  });
  const unitComparable = facetIdentity.unit === facetIdentity.energyStandardUnit;
  const monthly = input.months.map((month) => {
    const energyRows = rowsByMonth.get(month) || [];
    const numeratorValue = energyRows.length === 0
      ? null
      : roundAnalysisValue(energyRows.reduce(
        (sum, row) => sum + Number(row.normalizedValue),
        0
      ));
    const denominator = denominatorByMonth.get(month);
    let status = 'calculable';
    const reasonCodes = [];
    let intensityValue = null;
    if (energyRows.length === 0) {
      status = 'numerator_missing';
    } else if (!unitComparable) {
      status = 'unit_incompatible';
      reasonCodes.push('UNIT_NOT_COMPARABLE');
    } else if (denominator.status !== 'available') {
      status = denominator.status;
      reasonCodes.push(...denominator.reasonCodes);
    } else if (!Number.isFinite(numeratorValue) || !Number.isFinite(denominator.value)) {
      status = 'numeric_overflow';
      reasonCodes.push('UNIT_NOT_COMPARABLE');
    } else {
      intensityValue = roundAnalysisValue(numeratorValue / denominator.value);
      if (!Number.isFinite(intensityValue)) {
        intensityValue = null;
        status = 'numeric_overflow';
        reasonCodes.push('UNIT_NOT_COMPARABLE');
      } else if (numeratorValue === 0) {
        status = 'numerator_zero';
      }
    }
    return {
      month,
      status,
      calculable: status === 'calculable' || status === 'numerator_zero',
      numerator: {
        value: Number.isFinite(numeratorValue) ? numeratorValue : null,
        unit: facetIdentity.unit,
        recordCount: energyRows.length,
        recordIds: energyRows.slice(0, MAX_ENERGY_INTENSITY_EVIDENCE_IDS)
          .map((row) => Number(row.id)),
        recordIdsTruncated: energyRows.length > MAX_ENERGY_INTENSITY_EVIDENCE_IDS,
        sourceTable: 'energy_records',
        recordStatus: 'active'
      },
      denominator,
      intensity: {
        value: intensityValue,
        unit: intensityValue === null
          ? null
          : `${facetIdentity.unit}/${denominator.unit}`
      },
      reasonCodes: [...new Set(reasonCodes)]
    };
  });
  const calculableMonths = monthly.filter((row) => row.calculable);
  const allMonthsCalculable = calculableMonths.length === monthly.length;
  const aggregateNumerator = allMonthsCalculable
    ? roundAnalysisValue(monthly.reduce((sum, row) => sum + row.numerator.value, 0))
    : null;
  const aggregateDenominator = allMonthsCalculable
    ? roundAnalysisValue(monthly.reduce((sum, row) => sum + row.denominator.value, 0))
    : null;
  const aggregateIntensity = allMonthsCalculable
    ? roundAnalysisValue(aggregateNumerator / aggregateDenominator)
    : null;
  return {
    energyTypeId: Number(facetIdentity.energyTypeId),
    energyTypeCode: facetIdentity.energyTypeCode,
    energyTypeName: facetIdentity.energyTypeName,
    energyStandardUnit: facetIdentity.energyStandardUnit,
    numeratorUnit: facetIdentity.unit,
    denominatorUnit: denominatorByMonth.values().next().value
      ? denominatorByMonth.values().next().value.expectedUnit
      : null,
    unitComparable,
    status: allMonthsCalculable ? 'calculable' : 'partially_or_not_calculable',
    coverage: {
      expectedMonthCount: monthly.length,
      calculableMonthCount: calculableMonths.length,
      coverageRate: roundAnalysisValue(calculableMonths.length / monthly.length)
    },
    aggregate: {
      calculable: allMonthsCalculable && Number.isFinite(aggregateIntensity),
      numeratorValue: aggregateNumerator,
      denominatorValue: aggregateDenominator,
      intensityValue: Number.isFinite(aggregateIntensity) ? aggregateIntensity : null,
      intensityUnit: Number.isFinite(aggregateIntensity)
        ? `${facetIdentity.unit}/${denominatorByMonth.values().next().value.expectedUnit}`
        : null
    },
    monthly,
    reasonCodes: [...new Set(monthly.flatMap((row) => row.reasonCodes))]
  };
}

/**
 * 构造显式筛选但没有分子事实时的空分面身份。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @returns {object|null} 空分面身份。
 */
function resolveRequestedEmptyFacet(db, input) {
  if (!input.energyTypeCode || !input.unit) return null;
  const energyType = db.prepare(
    `SELECT id AS energyTypeId,
            code AS energyTypeCode,
            name AS energyTypeName,
            standard_unit AS energyStandardUnit
       FROM energy_types
      WHERE code = ?`
  ).get(input.energyTypeCode);
  if (!energyType) {
    throw notFound('能源类型不存在。', { energyTypeCode: input.energyTypeCode });
  }
  return { ...energyType, unit: input.unit };
}

/**
 * 查询严格消费量和单位产品能耗，不跨能源或单位求和。
 * @param {*} input 查询输入。
 * @param {object} options 可注入调用方 SQLite 连接。
 * @returns {object} 严格强度契约。
 */
function getEnergyIntensityAnalysis(input, options = {}) {
  const normalizedInput = normalizeEnergyIntensityInput(input);
  const callerDatabase = isPlainObject(options) && options.db ? options.db : null;
  const db = callerDatabase || database.openDatabase();
  const shouldCloseDatabase = callerDatabase === null;
  const shouldOwnReadTransaction = db.inTransaction !== true;
  let ownedReadTransactionActive = false;
  try {
    if (shouldOwnReadTransaction) {
      db.exec('BEGIN DEFERRED');
      ownedReadTransactionActive = true;
    }
    const scope = resolveProductionScope(db, normalizedInput.productionUnitId);
    const outputRows = queryOutputRows(db, normalizedInput);
    if (outputRows.length > MAX_ENERGY_INTENSITY_RECORDS) {
      throw badRequest(`匹配产量记录超过 ${MAX_ENERGY_INTENSITY_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_INTENSITY_OUTPUT_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_ENERGY_INTENSITY_RECORDS
      });
    }
    const energyRows = queryEnergyRows(db, normalizedInput, scope);
    if (energyRows.length > MAX_ENERGY_INTENSITY_RECORDS) {
      throw badRequest(`匹配能耗记录超过 ${MAX_ENERGY_INTENSITY_RECORDS} 条，请缩小查询范围。`, {
        code: 'ENERGY_INTENSITY_ENERGY_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_ENERGY_INTENSITY_RECORDS
      });
    }
    const denominatorByMonth = buildDenominatorByMonth(
      outputRows,
      scope,
      normalizedInput.months
    );
    const rowsByFacet = new Map();
    const facetIdentityByKey = new Map();
    energyRows.forEach((row) => {
      const facetKey = buildFacetKey(row);
      const facetRows = rowsByFacet.get(facetKey) || [];
      facetRows.push(row);
      rowsByFacet.set(facetKey, facetRows);
      facetIdentityByKey.set(facetKey, {
        energyTypeId: row.energyTypeId,
        energyTypeCode: row.energyTypeCode,
        energyTypeName: row.energyTypeName,
        energyStandardUnit: row.energyStandardUnit,
        unit: row.normalizedUnit
      });
    });
    const requestedEmptyFacet = energyRows.length === 0
      ? resolveRequestedEmptyFacet(db, normalizedInput)
      : null;
    if (requestedEmptyFacet) {
      const facetKey = `${requestedEmptyFacet.energyTypeId}::${requestedEmptyFacet.unit}`;
      rowsByFacet.set(facetKey, []);
      facetIdentityByKey.set(facetKey, requestedEmptyFacet);
    }
    if (rowsByFacet.size > MAX_ENERGY_INTENSITY_FACETS) {
      throw badRequest(`匹配能源和单位分面超过 ${MAX_ENERGY_INTENSITY_FACETS} 个，请增加筛选条件。`, {
        code: 'ENERGY_INTENSITY_FACET_LIMIT_EXCEEDED',
        maximumFacets: MAX_ENERGY_INTENSITY_FACETS
      });
    }
    const facets = [...rowsByFacet.keys()].sort().map((facetKey) => buildIntensityFacet(
      rowsByFacet.get(facetKey),
      facetIdentityByKey.get(facetKey),
      normalizedInput,
      denominatorByMonth
    ));
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: ENERGY_INTENSITY_FORMULA_VERSION,
      formula: {
        expression: '单位产品能耗 = 同一能源类型、同一 normalized_unit 的 active energy_records.normalized_value 汇总 / 同一产能单元 active production_output_records.output_value 汇总',
        numeratorSource: 'energy_records',
        denominatorSources: ['production_units', 'production_output_records'],
        crossEnergyAggregation: false,
        crossUnitAggregation: false,
        exactOrganizationScope: true
      },
      scope: {
        productionUnitId: Number(scope.id),
        productionUnitCode: scope.unitCode,
        productionUnitName: scope.unitName,
        productionUnitStatus: scope.status,
        productName: scope.productName,
        organizationUnitId: Number(scope.organizationUnitId),
        organizationUnitCode: scope.organizationUnitCode,
        organizationUnitName: scope.organizationUnitName,
        exactOrganizationScope: true,
        outputUnit: scope.outputUnit,
        energyTypeCode: normalizedInput.energyTypeCode,
        unit: normalizedInput.unit
      },
      dataRange: {
        startMonth: normalizedInput.startMonth,
        endMonth: normalizedInput.endMonth,
        monthCount: normalizedInput.monthCount,
        months: normalizedInput.months
      },
      sourceRecordCounts: {
        energyRecords: energyRows.length,
        productionOutputRecords: outputRows.length
      },
      denominatorByMonth: normalizedInput.months.map((month) => ({
        month,
        ...denominatorByMonth.get(month)
      })),
      facets,
      quality: {
        status: facets.length === 0
          ? 'no_numerator_facets'
          : (facets.every((facet) => facet.aggregate.calculable) ? 'sufficient' : 'partial'),
        facetCount: facets.length,
        calculableFacetCount: facets.filter((facet) => facet.aggregate.calculable).length,
        denominatorMissingMonths: normalizedInput.months.filter((month) => (
          denominatorByMonth.get(month).status === 'denominator_missing'
        )),
        denominatorZeroMonths: normalizedInput.months.filter((month) => (
          denominatorByMonth.get(month).status === 'denominator_zero'
        )),
        denominatorUnitIncompatibleMonths: normalizedInput.months.filter((month) => (
          denominatorByMonth.get(month).status === 'denominator_unit_incompatible'
        ))
      },
      meta: {
        readOnly: true,
        numeratorRecordStatus: 'active',
        denominatorRecordStatus: 'active',
        maximumMonths: MAX_ENERGY_INTENSITY_MONTHS,
        maximumEnergyRecords: MAX_ENERGY_INTENSITY_RECORDS,
        maximumOutputRecords: MAX_ENERGY_INTENSITY_RECORDS,
        maximumFacets: MAX_ENERGY_INTENSITY_FACETS,
        maximumEvidenceIdsPerMonth: MAX_ENERGY_INTENSITY_EVIDENCE_IDS,
        generationRecordsRead: false,
        meterReadingRecordsRead: false,
        timeseriesRecordsRead: false,
        generationOffsetApplied: false,
        writesEnergyRecords: false,
        writesProductionOutputRecords: false,
        callerDatabaseConnection: callerDatabase !== null,
        reusedCallerTransaction: !shouldOwnReadTransaction
      }
    };
    if (ownedReadTransactionActive) {
      db.exec('COMMIT');
      ownedReadTransactionActive = false;
    }
    return response;
  } catch (error) {
    if (ownedReadTransactionActive && db.inTransaction === true) {
      try {
        db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // 回滚失败不覆盖原始错误。
      }
    }
    if (error instanceof AppError) throw error;
    throw new AppError('ENERGY_ANALYSIS_QUERY_FAILED', '消费量和强度分析暂时不可用。', {
      statusCode: 500,
      details: null
    });
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

module.exports = {
  ENERGY_INTENSITY_FORMULA_VERSION,
  MAX_ENERGY_INTENSITY_EVIDENCE_IDS,
  MAX_ENERGY_INTENSITY_FACETS,
  MAX_ENERGY_INTENSITY_MONTHS,
  MAX_ENERGY_INTENSITY_RECORDS,
  getEnergyIntensityAnalysis,
  normalizeEnergyIntensityInput
};
