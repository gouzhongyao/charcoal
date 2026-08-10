'use strict';

const database = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const {
  ENERGY_ANALYSIS_VERSIONS,
  TIME_INTERVAL_BOUNDARY,
  isStrictUtcIso,
  validateIanaTimeZone
} = require('./energyAnalysisContracts');
const {
  FIXED_UTC_OUTPUT_INTERVAL_MINUTES,
  buildFixedUtcLoadBuckets,
  roundAnalysisValue
} = require('./energyAnalysisUtils');

// 高峰贡献分析公式版本，明确独立于固定 UTC 负荷曲线展示契约。
const PEAK_CONTRIBUTION_FORMULA_VERSION = 'peak-contribution-analysis:v1';
// 高峰贡献查询允许的最大自然时长。
const MAX_PEAK_CONTRIBUTION_RANGE_DAYS = 31;
// 高峰贡献查询允许参与分析的最大表计数量。
const MAX_PEAK_CONTRIBUTION_METERS = 500;
// 表计查询多取一条，仅用于识别超限并拒绝。
const PEAK_CONTRIBUTION_METER_QUERY_LIMIT = MAX_PEAK_CONTRIBUTION_METERS + 1;
// 高峰贡献查询允许参与计算的最大时序事实数量。
const MAX_PEAK_CONTRIBUTION_RECORDS = 50000;
// 时序事实查询多取一条，仅用于识别超限并拒绝。
const PEAK_CONTRIBUTION_RECORD_QUERY_LIMIT = MAX_PEAK_CONTRIBUTION_RECORDS + 1;
// 默认返回的贡献对象数量。
const DEFAULT_TOP_CONTRIBUTORS = 20;
// 单个高峰区间允许返回的最大贡献对象数量。
const MAX_TOP_CONTRIBUTORS = 100;
// 并列高峰或候选高峰区间返回上限，避免全零长窗口产生无界响应。
const MAX_PEAK_CONTRIBUTION_INTERVALS = 100;
// 固定毫秒换算常量。
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * 判断输入是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范正整数输入。
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
 * 规范必填文本输入。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @param {string} code 稳定错误码。
 * @returns {string} 规范文本。
 */
function normalizeRequiredText(value, fieldName, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} 必须是非空字符串。`, { code, fieldName });
  }
  return value.trim();
}

/**
 * 规范严格 UTC 时间。
 * @param {*} value 原始值。
 * @param {string} fieldName 字段名。
 * @returns {string} 标准 ISO UTC 文本。
 */
function normalizeStrictUtc(value, fieldName) {
  if (!isStrictUtcIso(value)) {
    throw badRequest(`${fieldName} 必须使用严格 ISO UTC Z 格式。`, {
      code: fieldName === 'startUtc' ? 'INVALID_START_UTC' : 'INVALID_END_UTC',
      fieldName
    });
  }
  return new Date(Date.parse(value)).toISOString();
}

/**
 * 规范高峰贡献查询输入并冻结字段和数量边界。
 * @param {*} input 原始输入。
 * @returns {object} 规范输入。
 */
function normalizePeakContributionInput(input) {
  if (!isPlainObject(input)) {
    throw badRequest('高峰贡献查询参数必须是对象。', {
      code: 'INVALID_PEAK_CONTRIBUTION_INPUT'
    });
  }
  const organizationUnitId = normalizePositiveInteger(
    input.organizationUnitId,
    'organizationUnitId',
    'INVALID_ORGANIZATION_UNIT_ID'
  );
  const energyTypeCode = normalizeRequiredText(
    input.energyTypeCode,
    'energyTypeCode',
    'INVALID_ENERGY_TYPE_CODE'
  );
  const unit = normalizeRequiredText(input.unit, 'unit', 'INVALID_ENERGY_UNIT');
  const sourceTimeZone = normalizeRequiredText(
    input.sourceTimeZone,
    'sourceTimeZone',
    'INVALID_SOURCE_TIME_ZONE'
  );
  const timeZoneValidation = validateIanaTimeZone(sourceTimeZone);
  if (timeZoneValidation.status !== 'valid') {
    throw badRequest('sourceTimeZone 必须是有效 IANA 时区。', {
      code: 'INVALID_SOURCE_TIME_ZONE',
      fieldName: 'sourceTimeZone'
    });
  }
  const startUtc = normalizeStrictUtc(input.startUtc, 'startUtc');
  const endUtc = normalizeStrictUtc(input.endUtc, 'endUtc');
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (startMs >= endMs) {
    throw badRequest('查询范围必须满足左闭右开且开始时间早于结束时间。', {
      code: 'INVALID_PEAK_CONTRIBUTION_TIME_RANGE',
      startUtc,
      endUtc
    });
  }
  if (endMs - startMs > MAX_PEAK_CONTRIBUTION_RANGE_DAYS * DAY_MS) {
    throw badRequest(`查询范围不得超过 ${MAX_PEAK_CONTRIBUTION_RANGE_DAYS} 天。`, {
      code: 'PEAK_CONTRIBUTION_TIME_RANGE_EXCEEDED',
      maximumRangeDays: MAX_PEAK_CONTRIBUTION_RANGE_DAYS
    });
  }
  const outputIntervalMinutes = normalizePositiveInteger(
    input.outputIntervalMinutes,
    'outputIntervalMinutes',
    'INVALID_OUTPUT_INTERVAL_MINUTES'
  );
  if (!FIXED_UTC_OUTPUT_INTERVAL_MINUTES.includes(outputIntervalMinutes)) {
    throw badRequest('outputIntervalMinutes 仅允许 15、30 或 60。', {
      code: 'INVALID_OUTPUT_INTERVAL_MINUTES',
      supportedValues: [...FIXED_UTC_OUTPUT_INTERVAL_MINUTES]
    });
  }
  const outputIntervalMs = outputIntervalMinutes * MINUTE_MS;
  if (startMs % outputIntervalMs !== 0 || endMs % outputIntervalMs !== 0) {
    throw badRequest('查询起止时间必须对齐 UTC epoch 固定输出网格。', {
      code: 'PEAK_CONTRIBUTION_TIME_NOT_ALIGNED',
      outputIntervalMinutes
    });
  }
  const topContributors = input.topContributors === undefined
    ? DEFAULT_TOP_CONTRIBUTORS
    : normalizePositiveInteger(
      input.topContributors,
      'topContributors',
      'INVALID_TOP_CONTRIBUTORS'
    );
  if (topContributors > MAX_TOP_CONTRIBUTORS) {
    throw badRequest(`topContributors 不得超过 ${MAX_TOP_CONTRIBUTORS}。`, {
      code: 'TOP_CONTRIBUTORS_LIMIT_EXCEEDED',
      maximumTopContributors: MAX_TOP_CONTRIBUTORS
    });
  }
  return {
    organizationUnitId,
    energyTypeCode,
    unit,
    sourceTimeZone,
    startUtc,
    endUtc,
    startMs,
    endMs,
    outputIntervalMinutes,
    bucketCount: (endMs - startMs) / outputIntervalMs,
    topContributors
  };
}

/**
 * 查询精确组织、能源和单位范围内的表计对象。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @returns {object} 组织、能源和表计范围。
 */
function resolvePeakContributionScope(db, input) {
  const organizationUnit = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, status
       FROM organization_units
      WHERE id = ?`
  ).get(input.organizationUnitId);
  if (!organizationUnit) {
    throw notFound('用能单元不存在。', { organizationUnitId: input.organizationUnitId });
  }
  const energyType = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
       FROM energy_types
      WHERE code = ?`
  ).get(input.energyTypeCode);
  if (!energyType) {
    throw notFound('能源类型不存在。', { energyTypeCode: input.energyTypeCode });
  }
  const meters = db.prepare(
    `SELECT id, meter_code AS meterCode, meter_name AS meterName, status
       FROM meter_devices
      WHERE organization_unit_id = ?
        AND energy_type_id = ?
      ORDER BY meter_code ASC, id ASC
      LIMIT ${PEAK_CONTRIBUTION_METER_QUERY_LIMIT}`
  ).all(input.organizationUnitId, energyType.id);
  if (meters.length > MAX_PEAK_CONTRIBUTION_METERS) {
    throw badRequest(`匹配表计超过 ${MAX_PEAK_CONTRIBUTION_METERS} 个，请缩小分析范围。`, {
      code: 'PEAK_CONTRIBUTION_METER_LIMIT_EXCEEDED',
      maximumMeters: MAX_PEAK_CONTRIBUTION_METERS
    });
  }
  return {
    organizationUnit,
    energyType,
    meters,
    comparable: input.unit === energyType.standardUnit
  };
}

/**
 * 查询全部表计的时序事实，LIMIT 多取一条识别总量超限。
 * @param {object} db SQLite 连接。
 * @param {object} input 规范输入。
 * @param {object} scope 已解析范围。
 * @returns {object[]} 时序事实。
 */
function queryPeakContributionRows(db, input, scope) {
  if (scope.meters.length === 0) return [];
  const parameters = {
    organizationUnitId: input.organizationUnitId,
    energyTypeId: scope.energyType.id,
    unit: input.unit,
    sourceTimeZone: input.sourceTimeZone,
    startUtc: input.startUtc,
    endUtc: input.endUtc
  };
  return db.prepare(
    `SELECT record.id,
            record.meter_device_id AS meterDeviceId,
            record.start_utc AS startUtc,
            record.end_utc AS endUtc,
            record.source_timezone AS sourceTimeZone,
            record.granularity_minutes AS granularityMinutes,
            record.normalized_value AS normalizedValue
       FROM energy_timeseries_records AS record
       JOIN meter_devices AS meter ON meter.id = record.meter_device_id
      WHERE record.record_status = 'active'
        AND record.organization_unit_id = @organizationUnitId
        AND meter.organization_unit_id = @organizationUnitId
        AND record.energy_type_id = @energyTypeId
        AND meter.energy_type_id = @energyTypeId
        AND record.normalized_unit = @unit
        AND record.source_timezone = @sourceTimeZone
        AND record.start_utc < @endUtc
        AND record.end_utc > @startUtc
      ORDER BY record.meter_device_id ASC, record.start_utc ASC, record.end_utc ASC, record.id ASC
      LIMIT ${PEAK_CONTRIBUTION_RECORD_QUERY_LIMIT}`
  ).all(parameters);
}

/**
 * 将数据库行映射为公共固定 UTC 桶算法输入。
 * @param {object} row 数据库行。
 * @param {object} input 规范输入。
 * @returns {object} 公共算法记录。
 */
function mapPeakContributionRecord(row, input) {
  return {
    id: `energy-timeseries:${row.id}`,
    sourceReference: `energy-timeseries:${row.id}`,
    energyTypeCode: input.energyTypeCode,
    unit: input.unit,
    value: Number(row.normalizedValue),
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    sourceTimeZone: row.sourceTimeZone,
    granularityMinutes: Number(row.granularityMinutes)
  };
}

/**
 * 合并原因码并保持首次出现顺序。
 * @param {...string[]} reasonCodeLists 原因码数组或单值。
 * @returns {string[]} 去重原因码。
 */
function mergeReasonCodes(...reasonCodeLists) {
  return [...new Set(reasonCodeLists.flat().filter(Boolean))];
}

/**
 * 构造单表计固定 UTC 桶和覆盖事实。
 * @param {object} meter 表计对象。
 * @param {object[]} meterRows 表计时序行。
 * @param {object} input 规范输入。
 * @returns {object} 表计贡献事实。
 */
function buildMeterContribution(meter, meterRows, input) {
  const records = meterRows.map((row) => mapPeakContributionRecord(row, input));
  const curve = buildFixedUtcLoadBuckets(
    records,
    {
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      sourceTimeZone: input.sourceTimeZone
    },
    input.outputIntervalMinutes
  );
  if (curve.numericOverflow) {
    throw new AppError('ANALYSIS_NUMERIC_OVERFLOW', '高峰贡献分析出现超出安全范围的数值。', {
      statusCode: 500,
      details: null
    });
  }
  return {
    meterDeviceId: Number(meter.id),
    meterCode: meter.meterCode,
    meterName: meter.meterName,
    meterStatus: meter.status,
    recordCount: meterRows.length,
    coverageRate: curve.coverageRate,
    coveredMinutes: curve.coveredMinutes,
    expectedMinutes: curve.expectedMinutes,
    reasonCodes: curve.reasonCodes,
    buckets: curve.buckets
  };
}

/**
 * 构造聚合区间，并仅在全部对象区间可比且完整时认定事实高峰。
 * @param {object[]} meterContributions 表计贡献事实。
 * @param {object} input 规范输入。
 * @param {boolean} comparable 单位是否与能源标准单位一致。
 * @returns {object} 聚合区间、质量与高峰结果。
 */
function buildAggregatePeakResult(meterContributions, input, comparable) {
  const expectedContributionMinutes = input.bucketCount
    * input.outputIntervalMinutes
    * meterContributions.length;
  const coveredContributionMinutes = meterContributions.reduce(
    (sum, meter) => sum + meter.coveredMinutes,
    0
  );
  const aggregateCoverageRate = expectedContributionMinutes === 0
    ? 0
    : roundAnalysisValue(coveredContributionMinutes / expectedContributionMinutes);
  const meterReasonCodes = meterContributions.flatMap((meter) => meter.reasonCodes);
  const reasonCodes = mergeReasonCodes(
    meterContributions.length === 0 ? ['NO_TIMESERIES_DATA'] : [],
    aggregateCoverageRate < 1 ? ['COVERAGE_BELOW_THRESHOLD'] : [],
    comparable ? [] : ['UNIT_NOT_COMPARABLE'],
    meterReasonCodes
  );
  const bucketFacts = Array.from({ length: input.bucketCount }, (_unused, bucketIndex) => {
    const contributors = meterContributions.map((meter) => {
      const meterBucket = meter.buckets[bucketIndex];
      return {
        meterDeviceId: meter.meterDeviceId,
        meterCode: meter.meterCode,
        meterName: meter.meterName,
        energy: meterBucket && Number.isFinite(meterBucket.energy) ? meterBucket.energy : null,
        coverageRate: meterBucket ? meterBucket.coverageRate : 0,
        observationMode: meterBucket ? meterBucket.observationMode : 'missing'
      };
    });
    const complete = comparable
      && contributors.length > 0
      && contributors.every((contributor) => contributor.energy !== null
        && contributor.coverageRate === 1
        && contributor.observationMode !== 'unavailable');
    const observedContributors = contributors.filter((contributor) => contributor.energy !== null);
    const observedEnergy = observedContributors.length === 0
      ? null
      : roundAnalysisValue(observedContributors.reduce(
        (sum, contributor) => sum + contributor.energy,
        0
      ));
    const totalEnergy = complete ? observedEnergy : null;
    const bucketTemplate = meterContributions[0] && meterContributions[0].buckets[bucketIndex];
    const startUtc = bucketTemplate
      ? bucketTemplate.startUtc
      : new Date(input.startMs + bucketIndex * input.outputIntervalMinutes * MINUTE_MS).toISOString();
    const endUtc = bucketTemplate
      ? bucketTemplate.endUtc
      : new Date(input.startMs + (bucketIndex + 1) * input.outputIntervalMinutes * MINUTE_MS).toISOString();
    const sortedContributors = [...contributors].sort((left, right) => {
      if (left.energy === null && right.energy !== null) return 1;
      if (left.energy !== null && right.energy === null) return -1;
      if (left.energy !== right.energy) return (right.energy || 0) - (left.energy || 0);
      return left.meterCode.localeCompare(right.meterCode);
    });
    return {
      startUtc,
      endUtc,
      observedEnergy,
      totalEnergy,
      complete,
      contributors: sortedContributors
    };
  });
  const completePeakEnergy = reasonCodes.length === 0
    ? Math.max(...bucketFacts.map((bucket) => bucket.totalEnergy))
    : null;
  const candidateEnergies = bucketFacts
    .map((bucket) => bucket.observedEnergy)
    .filter(Number.isFinite);
  const candidatePeakEnergy = candidateEnergies.length > 0 ? Math.max(...candidateEnergies) : null;
  const peakBuckets = Number.isFinite(completePeakEnergy)
    ? bucketFacts.filter((bucket) => bucket.totalEnergy === completePeakEnergy)
    : [];
  const candidateBuckets = !Number.isFinite(completePeakEnergy) && Number.isFinite(candidatePeakEnergy)
    ? bucketFacts.filter((bucket) => bucket.observedEnergy === candidatePeakEnergy)
    : [];
  return {
    bucketFacts,
    quality: {
      status: reasonCodes.length === 0 ? 'sufficient' : 'insufficient',
      sufficient: reasonCodes.length === 0,
      coverageRate: aggregateCoverageRate,
      coveredContributionMinutes,
      expectedContributionMinutes,
      meterCount: meterContributions.length,
      completeMeterCount: meterContributions.filter((meter) => (
        meter.coverageRate === 1 && meter.reasonCodes.length === 0
      )).length,
      reasonCodes
    },
    peakEnergy: completePeakEnergy,
    peakBuckets,
    candidatePeakEnergy,
    candidateBuckets
  };
}

/**
 * 将区间事实映射为对外高峰贡献契约。
 * @param {object} bucket 区间事实。
 * @param {number} intervalEnergy 区间总能耗。
 * @param {object} input 规范输入。
 * @param {boolean} candidateOnly 是否仅为数据不完整下的候选区间。
 * @returns {object} 对外区间结果。
 */
function mapPeakBucket(bucket, intervalEnergy, input, candidateOnly) {
  const returnedContributors = bucket.contributors.slice(0, input.topContributors).map((contributor) => ({
    ...contributor,
    contributionShare: Number.isFinite(intervalEnergy) && intervalEnergy > 0
      && Number.isFinite(contributor.energy)
      ? roundAnalysisValue(contributor.energy / intervalEnergy)
      : (intervalEnergy === 0 && contributor.energy === 0 ? 0 : null),
    evidenceType: 'measured_timeseries_contribution'
  }));
  return {
    startUtc: bucket.startUtc,
    endUtc: bucket.endUtc,
    intervalMinutes: input.outputIntervalMinutes,
    energy: intervalEnergy,
    energyUnit: input.unit,
    candidateOnly,
    complete: bucket.complete,
    contributors: returnedContributors,
    contributorCount: bucket.contributors.length,
    contributorsTruncated: bucket.contributors.length > returnedContributors.length,
    interpretation: candidateOnly
      ? '数据覆盖不足，仅表示已观测对象形成的候选高峰区间，不代表完整峰值或根因。'
      : '贡献值仅表示该区间的可比能耗事实，不自动认定任何对象为峰值根因。'
  };
}

/**
 * 查询精确组织下的高峰贡献事实，不推断根因、不估算节能量。
 * @param {*} input 查询输入。
 * @param {object} options 可注入调用方 SQLite 连接。
 * @returns {object} 高峰贡献结果。
 */
function getPeakContributionAnalysis(input, options = {}) {
  const normalizedInput = normalizePeakContributionInput(input);
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
    const scope = resolvePeakContributionScope(db, normalizedInput);
    const rows = queryPeakContributionRows(db, normalizedInput, scope);
    if (rows.length > MAX_PEAK_CONTRIBUTION_RECORDS) {
      throw badRequest(`匹配时序记录超过 ${MAX_PEAK_CONTRIBUTION_RECORDS} 条，请缩小查询范围。`, {
        code: 'PEAK_CONTRIBUTION_RECORD_LIMIT_EXCEEDED',
        maximumRecords: MAX_PEAK_CONTRIBUTION_RECORDS
      });
    }
    const rowsByMeter = new Map();
    rows.forEach((row) => {
      const meterRows = rowsByMeter.get(Number(row.meterDeviceId)) || [];
      meterRows.push(row);
      rowsByMeter.set(Number(row.meterDeviceId), meterRows);
    });
    const meterContributions = scope.meters.map((meter) => buildMeterContribution(
      meter,
      rowsByMeter.get(Number(meter.id)) || [],
      normalizedInput
    ));
    const aggregate = buildAggregatePeakResult(
      meterContributions,
      normalizedInput,
      scope.comparable
    );
    const response = {
      contractVersion: ENERGY_ANALYSIS_VERSIONS.contract,
      formulaVersion: PEAK_CONTRIBUTION_FORMULA_VERSION,
      scope: {
        organizationUnitId: Number(scope.organizationUnit.id),
        organizationUnitCode: scope.organizationUnit.unitCode,
        organizationUnitName: scope.organizationUnit.unitName,
        exactOrganizationScope: true,
        energyTypeId: Number(scope.energyType.id),
        energyTypeCode: scope.energyType.code,
        energyTypeName: scope.energyType.name,
        energyStandardUnit: scope.energyType.standardUnit,
        unit: normalizedInput.unit,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        comparable: scope.comparable
      },
      dataRange: {
        startUtc: normalizedInput.startUtc,
        endUtc: normalizedInput.endUtc,
        sourceTimeZone: normalizedInput.sourceTimeZone,
        outputIntervalMinutes: normalizedInput.outputIntervalMinutes,
        bucketCount: normalizedInput.bucketCount,
        intervalConvention: TIME_INTERVAL_BOUNDARY,
        gridAlignment: 'utc_epoch'
      },
      recordCount: rows.length,
      quality: aggregate.quality,
      peak: {
        calculable: aggregate.quality.sufficient,
        energy: aggregate.peakEnergy,
        energyUnit: aggregate.peakEnergy === null ? null : normalizedInput.unit,
        tiedIntervalCount: aggregate.peakBuckets.length,
        intervals: aggregate.peakBuckets.slice(0, MAX_PEAK_CONTRIBUTION_INTERVALS)
          .map((bucket) => mapPeakBucket(
            bucket,
            bucket.totalEnergy,
            normalizedInput,
            false
          )),
        intervalsTruncated: aggregate.peakBuckets.length > MAX_PEAK_CONTRIBUTION_INTERVALS,
        reasonCodes: aggregate.quality.sufficient ? [] : aggregate.quality.reasonCodes
      },
      candidatePeak: {
        available: aggregate.candidateBuckets.length > 0,
        energy: aggregate.candidatePeakEnergy,
        energyUnit: aggregate.candidatePeakEnergy === null ? null : normalizedInput.unit,
        tiedIntervalCount: aggregate.candidateBuckets.length,
        intervals: aggregate.candidateBuckets.slice(0, MAX_PEAK_CONTRIBUTION_INTERVALS)
          .map((bucket) => mapPeakBucket(
            bucket,
            bucket.observedEnergy,
            normalizedInput,
            true
          )),
        intervalsTruncated: aggregate.candidateBuckets.length > MAX_PEAK_CONTRIBUTION_INTERVALS,
        reasonCodes: aggregate.candidateBuckets.length > 0 ? aggregate.quality.reasonCodes : []
      },
      contributors: meterContributions.map((meter) => ({
        meterDeviceId: meter.meterDeviceId,
        meterCode: meter.meterCode,
        meterName: meter.meterName,
        meterStatus: meter.meterStatus,
        recordCount: meter.recordCount,
        coverageRate: meter.coverageRate,
        coveredMinutes: meter.coveredMinutes,
        expectedMinutes: meter.expectedMinutes,
        reasonCodes: meter.reasonCodes
      })),
      automationBoundary: {
        usesAI: false,
        infersRootCause: false,
        estimatesSaving: false,
        issuesControlCommand: false,
        changesDeviceState: false
      },
      meta: {
        sourceTable: 'energy_timeseries_records',
        recordStatus: 'active',
        allocationAlgorithm: 'buildFixedUtcLoadBuckets',
        allocationAssumption: 'uniform_within_interval',
        exactOrganizationScope: true,
        maximumRangeDays: MAX_PEAK_CONTRIBUTION_RANGE_DAYS,
        maximumMeters: MAX_PEAK_CONTRIBUTION_METERS,
        maximumRecords: MAX_PEAK_CONTRIBUTION_RECORDS,
        maximumReturnedPeakIntervals: MAX_PEAK_CONTRIBUTION_INTERVALS,
        topContributors: normalizedInput.topContributors,
        generationOffsetApplied: false,
        rootCauseInferenceApplied: false,
        savingEstimateApplied: false,
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
    throw new AppError('ENERGY_ANALYSIS_QUERY_FAILED', '高峰贡献分析暂时不可用。', {
      statusCode: 500,
      details: null
    });
  } finally {
    if (shouldCloseDatabase) db.close();
  }
}

module.exports = {
  DEFAULT_TOP_CONTRIBUTORS,
  MAX_PEAK_CONTRIBUTION_INTERVALS,
  MAX_PEAK_CONTRIBUTION_METERS,
  MAX_PEAK_CONTRIBUTION_RANGE_DAYS,
  MAX_PEAK_CONTRIBUTION_RECORDS,
  MAX_TOP_CONTRIBUTORS,
  PEAK_CONTRIBUTION_FORMULA_VERSION,
  getPeakContributionAnalysis,
  normalizePeakContributionInput
};
