const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { buildPaginationMeta, normalizePagination } = require('./energyRecordQuery');
const {
  PREDICTION_RESULT_SORT_COLUMNS,
  PREDICTION_SORT_COLUMNS,
  buildForecast,
  detectHistoryWarnings,
  generateMonthSequence,
  normalizeMonth,
  normalizePositiveInteger,
  normalizePredictionAlgorithm,
  normalizePredictionStatus,
  normalizeSort,
  normalizeText,
  resolveMovingAverageRequiredHistoryMonths,
  summarizeHistorySufficiency,
  validatePredictionRange
} = require('./predictionUtils');

const RUN_PAGE_SIZE_MAX = 200;
const RESULT_PAGE_SIZE_MAX = 500;

function nullableText(value) {
  return normalizeText(value) || null;
}

function normalizeTrainingFilters(payload = {}) {
  return {
    energyTypeCode: normalizeText(payload.energyTypeCode),
    organization: normalizeText(payload.organization),
    site: normalizeText(payload.site || payload.location),
    department: normalizeText(payload.department),
    sourceBatchId: normalizePositiveInteger(payload.sourceBatchId, 'sourceBatchId')
  };
}

function normalizePredictionPayload(payload = {}) {
  const algorithm = normalizePredictionAlgorithm(payload.algorithm);
  const trainStartMonth = normalizeMonth(payload.trainStartMonth || payload.train_start_month, 'trainStartMonth');
  const trainEndMonth = normalizeMonth(payload.trainEndMonth || payload.train_end_month, 'trainEndMonth');
  const predictStartMonth = normalizeMonth(payload.predictStartMonth || payload.predict_start_month, 'predictStartMonth');
  const predictEndMonth = normalizeMonth(payload.predictEndMonth || payload.predict_end_month, 'predictEndMonth');

  const requiredMonthFields = [
    ['trainStartMonth', trainStartMonth],
    ['trainEndMonth', trainEndMonth],
    ['predictStartMonth', predictStartMonth],
    ['predictEndMonth', predictEndMonth]
  ];
  const missingFields = requiredMonthFields.filter(([, value]) => !value).map(([fieldName]) => fieldName);
  if (missingFields.length > 0) {
    throw badRequest('创建预测运行必须提供训练月份和预测月份范围。', {
      code: 'REQUIRED_PREDICTION_MONTH_RANGE',
      missingFields
    });
  }

  const { trainMonths, predictionMonths } = validatePredictionRange({
    trainStartMonth,
    trainEndMonth,
    predictStartMonth,
    predictEndMonth
  });
  const windowSize = algorithm === 'moving_average'
    ? (normalizePositiveInteger(payload.windowSize, 'windowSize', { min: 2, max: 12 }) || 3)
    : undefined;
  const filters = normalizeTrainingFilters(payload);
  const requiredHistoryMonths = algorithm === 'moving_average'
    ? resolveMovingAverageRequiredHistoryMonths(windowSize)
    : 3;
  const name = normalizeText(payload.name) || `轻量预测 ${filters.energyTypeCode || '全部能源'} ${predictStartMonth}~${predictEndMonth}`;

  return {
    name,
    algorithm,
    trainStartMonth,
    trainEndMonth,
    predictStartMonth,
    predictEndMonth,
    trainMonths,
    predictionMonths,
    windowSize,
    filters,
    requiredHistoryMonths
  };
}

function resolveEnergyTypeId(db, energyTypeCode) {
  if (!energyTypeCode) {
    return null;
  }
  const energyType = db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types
     WHERE code = @energyTypeCode`
  ).get({ energyTypeCode });
  if (!energyType) {
    throw badRequest('未找到 energyTypeCode 对应的能源类型。', {
      code: 'UNKNOWN_ENERGY_TYPE',
      energyTypeCode
    });
  }
  if (energyType.isActive !== 1) {
    throw badRequest('能源类型已停用，不能创建预测运行。', {
      code: 'INACTIVE_ENERGY_TYPE',
      energyTypeCode
    });
  }
  return energyType.id;
}

function buildHistoryWhere(normalizedPayload) {
  const where = ["er.record_status = 'active'", 'er.normalized_month >= @trainStartMonth', 'er.normalized_month <= @trainEndMonth'];
  const params = {
    trainStartMonth: normalizedPayload.trainStartMonth,
    trainEndMonth: normalizedPayload.trainEndMonth
  };
  const filters = normalizedPayload.filters;

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
  if (filters.sourceBatchId) {
    where.push('er.source_batch_id = @sourceBatchId');
    params.sourceBatchId = filters.sourceBatchId;
  }

  return {
    whereSql: `WHERE ${where.join(' AND ')}`,
    params
  };
}

function loadHistoricalGroups(db, normalizedPayload) {
  const { whereSql, params } = buildHistoryWhere(normalizedPayload);
  const rows = db.prepare(
    `SELECT
       er.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       er.normalized_unit AS unit,
       er.normalized_month AS month,
       COALESCE(SUM(er.normalized_value), 0) AS value,
       COUNT(er.id) AS recordCount
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     ${whereSql}
     GROUP BY er.energy_type_id, et.code, et.name, er.normalized_unit, er.normalized_month
     ORDER BY et.display_order ASC, et.code ASC, er.normalized_unit ASC, er.normalized_month ASC`
  ).all(params);

  const groupMap = new Map();
  rows.forEach((row) => {
    const key = `${row.energyTypeId}:${row.unit}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        energyTypeId: row.energyTypeId,
        energyTypeCode: row.energyTypeCode,
        energyTypeName: row.energyTypeName,
        unit: row.unit,
        points: []
      });
    }
    groupMap.get(key).points.push({
      month: row.month,
      value: Number(row.value || 0),
      recordCount: row.recordCount
    });
  });

  return Array.from(groupMap.values());
}

function serializeRunParameters(normalizedPayload, warnings = []) {
  return JSON.stringify({
    algorithm: normalizedPayload.algorithm,
    windowSize: normalizedPayload.windowSize || null,
    filters: normalizedPayload.filters,
    trainMonths: normalizedPayload.trainMonths,
    predictionMonths: normalizedPayload.predictionMonths,
    requiredHistoryMonths: normalizedPayload.requiredHistoryMonths,
    warnings
  });
}

function createRunRow(db, normalizedPayload, targetEnergyTypeId) {
  const result = db.prepare(
    `INSERT INTO prediction_runs (
       name, algorithm, status, target_energy_type_id,
       train_start_month, train_end_month, predict_start_month, predict_end_month,
       parameters_json, note
     ) VALUES (
       @name, @algorithm, 'running', @targetEnergyTypeId,
       @trainStartMonth, @trainEndMonth, @predictStartMonth, @predictEndMonth,
       @parametersJson, @note
     )`
  ).run({
    name: normalizedPayload.name,
    algorithm: normalizedPayload.algorithm,
    targetEnergyTypeId,
    trainStartMonth: normalizedPayload.trainStartMonth,
    trainEndMonth: normalizedPayload.trainEndMonth,
    predictStartMonth: normalizedPayload.predictStartMonth,
    predictEndMonth: normalizedPayload.predictEndMonth,
    parametersJson: serializeRunParameters(normalizedPayload),
    note: '轻量预测运行已创建，计算结果仅作本地趋势参考。'
  });
  return result.lastInsertRowid;
}

function updateRunStatus(db, runId, status, note, parametersJson) {
  db.prepare(
    `UPDATE prediction_runs
     SET status = @status,
         completed_at = CASE WHEN @status IN ('completed', 'failed') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE completed_at END,
         parameters_json = @parametersJson,
         note = @note
     WHERE id = @runId`
  ).run({ runId, status, note, parametersJson });
}

function saveForecastResults(db, runId, group, forecastRows) {
  const insert = db.prepare(
    `INSERT INTO prediction_results (
       prediction_run_id, energy_type_id, target_month, predicted_value, predicted_unit,
       confidence_low, confidence_high, method_note
     ) VALUES (
       @runId, @energyTypeId, @targetMonth, @predictedValue, @predictedUnit,
       @confidenceLow, @confidenceHigh, @methodNote
     )`
  );

  forecastRows.forEach((row) => {
    insert.run({
      runId,
      energyTypeId: group.energyTypeId,
      targetMonth: row.targetMonth,
      predictedValue: row.predictedValue,
      predictedUnit: group.unit,
      confidenceLow: row.confidenceLow,
      confidenceHigh: row.confidenceHigh,
      methodNote: `${row.methodNote} 能源类型=${group.energyTypeCode}，单位=${group.unit}。`
    });
  });
}

function createPredictionRun(payload = {}) {
  const normalizedPayload = normalizePredictionPayload(payload);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const targetEnergyTypeId = resolveEnergyTypeId(db, normalizedPayload.filters.energyTypeCode);
      const runId = createRunRow(db, normalizedPayload, targetEnergyTypeId);
      const historicalGroups = loadHistoricalGroups(db, normalizedPayload);
      const createdResults = [];
      const skippedGroups = [];
      const warnings = [];

      historicalGroups.forEach((group) => {
        const sufficiency = summarizeHistorySufficiency(group.points, normalizedPayload.trainMonths, {
          minHistoryMonths: normalizedPayload.requiredHistoryMonths
        });
        const groupLabel = `${group.energyTypeCode}/${group.unit}`;
        if (!sufficiency.sufficient) {
          skippedGroups.push({ group: groupLabel, ...sufficiency });
          warnings.push(`${groupLabel} ${sufficiency.warnings.join('；')}`);
          return;
        }

        detectHistoryWarnings(group.points).forEach((warning) => warnings.push(`${groupLabel} ${warning}`));
        const forecastRows = buildForecast(group.points, normalizedPayload.predictionMonths, {
          algorithm: normalizedPayload.algorithm,
          windowSize: normalizedPayload.windowSize
        });
        saveForecastResults(db, runId, group, forecastRows);
        createdResults.push({
          group: groupLabel,
          energyTypeId: group.energyTypeId,
          energyTypeCode: group.energyTypeCode,
          unit: group.unit,
          sampleMonths: sufficiency.sampleMonths,
          resultCount: forecastRows.length,
          warnings: sufficiency.warnings
        });
      });

      if (createdResults.length === 0) {
        const failureNote = historicalGroups.length === 0
          ? '未找到符合筛选条件的历史能耗记录，预测运行失败，未写入预测结果。'
          : `历史样本月份不足，预测运行失败，未写入预测结果。${warnings.join('；')}`;
        const finalWarnings = warnings.length > 0 ? warnings : [failureNote];
        updateRunStatus(db, runId, 'failed', failureNote, serializeRunParameters(normalizedPayload, finalWarnings));
        return {
          run: getPredictionRunById(db, runId),
          summary: {
            status: 'failed',
            resultCount: 0,
            skippedGroups,
            warnings: finalWarnings
          }
        };
      }

      const note = [
        `预测完成：生成 ${createdResults.reduce((sum, group) => sum + group.resultCount, 0)} 条结果。`,
        '算法为本地轻量趋势/移动平均，不代表高精度 AI 或机器学习预测。',
        warnings.length > 0 ? `提示：${warnings.join('；')}` : null
      ].filter(Boolean).join(' ');
      updateRunStatus(db, runId, 'completed', note, serializeRunParameters(normalizedPayload, warnings));

      return {
        run: getPredictionRunById(db, runId),
        summary: {
          status: 'completed',
          resultCount: createdResults.reduce((sum, group) => sum + group.resultCount, 0),
          groups: createdResults,
          skippedGroups,
          warnings
        }
      };
    });

    return transaction();
  } finally {
    db.close();
  }
}

function mapRunRow(row) {
  if (!row) {
    return null;
  }
  let parameters = null;
  try {
    parameters = row.parametersJson ? JSON.parse(row.parametersJson) : null;
  } catch (error) {
    parameters = { parseError: 'parameters_json 不是有效 JSON', raw: row.parametersJson };
  }
  return { ...row, parameters };
}

function getPredictionRunById(db, runId) {
  const row = db.prepare(
    `SELECT
       pr.id,
       pr.name,
       pr.algorithm,
       pr.status,
       pr.target_energy_type_id AS targetEnergyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       pr.train_start_month AS trainStartMonth,
       pr.train_end_month AS trainEndMonth,
       pr.predict_start_month AS predictStartMonth,
       pr.predict_end_month AS predictEndMonth,
       pr.parameters_json AS parametersJson,
       pr.created_at AS createdAt,
       pr.completed_at AS completedAt,
       pr.note,
       COUNT(pres.id) AS resultCount
     FROM prediction_runs pr
     LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id
     LEFT JOIN prediction_results pres ON pres.prediction_run_id = pr.id
     WHERE pr.id = @runId
     GROUP BY pr.id`
  ).get({ runId });
  return mapRunRow(row);
}

function getPredictionRun(runIdRaw) {
  const runId = normalizePositiveInteger(runIdRaw, 'runId');
  const db = openDatabase();
  try {
    const run = getPredictionRunById(db, runId);
    if (!run) {
      throw notFound('预测运行不存在。', { runId });
    }
    const results = db.prepare(
      `SELECT
         pres.id,
         pres.prediction_run_id AS predictionRunId,
         pres.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         pres.target_month AS targetMonth,
         pres.predicted_value AS predictedValue,
         pres.predicted_unit AS predictedUnit,
         pres.confidence_low AS confidenceLow,
         pres.confidence_high AS confidenceHigh,
         pres.method_note AS methodNote,
         pres.created_at AS createdAt
       FROM prediction_results pres
       LEFT JOIN energy_types et ON et.id = pres.energy_type_id
       WHERE pres.prediction_run_id = @runId
       ORDER BY pres.target_month ASC, et.display_order ASC, et.code ASC, pres.id ASC`
    ).all({ runId });
    return { ...run, results };
  } finally {
    db.close();
  }
}

function normalizeRunListFilters(query = {}) {
  const algorithm = normalizeText(query.algorithm);
  const status = normalizePredictionStatus(query.status);
  const energyTypeCode = normalizeText(query.energyTypeCode);
  const createdAtStart = nullableText(query.createdAtStart);
  const createdAtEnd = nullableText(query.createdAtEnd);
  if (algorithm) {
    normalizePredictionAlgorithm(algorithm);
  }
  return { algorithm, status, energyTypeCode, createdAtStart, createdAtEnd };
}

function buildRunListWhere(filters = {}) {
  const where = [];
  const params = {};
  if (filters.algorithm) {
    where.push('pr.algorithm = @algorithm');
    params.algorithm = filters.algorithm;
  }
  if (filters.status) {
    where.push('pr.status = @status');
    params.status = filters.status;
  }
  if (filters.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.createdAtStart) {
    where.push('pr.created_at >= @createdAtStart');
    params.createdAtStart = filters.createdAtStart;
  }
  if (filters.createdAtEnd) {
    where.push('pr.created_at <= @createdAtEnd');
    params.createdAtEnd = filters.createdAtEnd;
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

function listPredictionRuns(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: RUN_PAGE_SIZE_MAX });
  const sort = normalizeSort(query, PREDICTION_SORT_COLUMNS, { sortBy: 'createdAt', sortOrder: 'desc' });
  const filters = normalizeRunListFilters(query);
  const { whereSql, params } = buildRunListWhere(filters);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM prediction_runs pr
       LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         pr.id,
         pr.name,
         pr.algorithm,
         pr.status,
         pr.target_energy_type_id AS targetEnergyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         pr.train_start_month AS trainStartMonth,
         pr.train_end_month AS trainEndMonth,
         pr.predict_start_month AS predictStartMonth,
         pr.predict_end_month AS predictEndMonth,
         pr.parameters_json AS parametersJson,
         pr.created_at AS createdAt,
         pr.completed_at AS completedAt,
         pr.note,
         COUNT(pres.id) AS resultCount
       FROM prediction_runs pr
       LEFT JOIN energy_types et ON et.id = pr.target_energy_type_id
       LEFT JOIN prediction_results pres ON pres.prediction_run_id = pr.id
       ${whereSql}
       GROUP BY pr.id
       ORDER BY ${sort.orderSql}, pr.id DESC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapRunRow);

    return {
      rows,
      pagination: buildPaginationMeta(page, pageSize, total),
      sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder }
    };
  } finally {
    db.close();
  }
}

function normalizeResultFilters(query = {}) {
  const runId = normalizePositiveInteger(query.runId || query.predictionRunId, 'runId');
  const energyTypeCode = normalizeText(query.energyTypeCode);
  const targetMonthStart = normalizeMonth(query.targetMonthStart || query.monthStart || query.startMonth, 'targetMonthStart');
  const targetMonthEnd = normalizeMonth(query.targetMonthEnd || query.monthEnd || query.endMonth, 'targetMonthEnd');
  if (targetMonthStart && targetMonthEnd) {
    generateMonthSequence(targetMonthStart, targetMonthEnd);
  }
  return { runId, energyTypeCode, targetMonthStart, targetMonthEnd };
}

function buildResultWhere(filters = {}) {
  const where = [];
  const params = {};
  if (filters.runId) {
    where.push('pres.prediction_run_id = @runId');
    params.runId = filters.runId;
  }
  if (filters.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.targetMonthStart) {
    where.push('pres.target_month >= @targetMonthStart');
    params.targetMonthStart = filters.targetMonthStart;
  }
  if (filters.targetMonthEnd) {
    where.push('pres.target_month <= @targetMonthEnd');
    params.targetMonthEnd = filters.targetMonthEnd;
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

function listPredictionResults(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 50, maxPageSize: RESULT_PAGE_SIZE_MAX });
  const sort = normalizeSort(query, PREDICTION_RESULT_SORT_COLUMNS, { sortBy: 'targetMonth', sortOrder: 'asc' });
  const filters = normalizeResultFilters(query);
  const { whereSql, params } = buildResultWhere(filters);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM prediction_results pres
       LEFT JOIN energy_types et ON et.id = pres.energy_type_id
       JOIN prediction_runs pr ON pr.id = pres.prediction_run_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         pres.id,
         pres.prediction_run_id AS predictionRunId,
         pr.name AS predictionRunName,
         pr.algorithm,
         pr.status AS runStatus,
         pres.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         pres.target_month AS targetMonth,
         pres.predicted_value AS predictedValue,
         pres.predicted_unit AS predictedUnit,
         pres.confidence_low AS confidenceLow,
         pres.confidence_high AS confidenceHigh,
         pres.method_note AS methodNote,
         pres.created_at AS createdAt
       FROM prediction_results pres
       LEFT JOIN energy_types et ON et.id = pres.energy_type_id
       JOIN prediction_runs pr ON pr.id = pres.prediction_run_id
       ${whereSql}
       ORDER BY ${sort.orderSql}, et.display_order ASC, et.code ASC, pres.id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset });

    return {
      rows,
      pagination: buildPaginationMeta(page, pageSize, total),
      sort: { sortBy: sort.sortBy, sortOrder: sort.sortOrder }
    };
  } finally {
    db.close();
  }
}

module.exports = {
  createPredictionRun,
  getPredictionRun,
  listPredictionResults,
  listPredictionRuns,
  normalizePredictionPayload,
  buildHistoryWhere,
  buildRunListWhere,
  buildResultWhere
};
