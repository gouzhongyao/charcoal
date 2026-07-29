const { openDatabase } = require('../db/database');
const {
  buildEnergyRecordLedgerBackfillPreview,
  loadLedgerBackfillPreviewIndexes
} = require('./ledgerService');
const {
  MAX_PAGE_SIZE,
  STATISTICS_MAX_PAGE_SIZE,
  buildEnergyRecordWhere,
  buildPaginationMeta,
  normalizeDetailSort,
  normalizeDimension,
  normalizeEnergyRecordFilters,
  normalizePagination,
  normalizePositiveInteger
} = require('./energyRecordQuery');

function normalizeBreakdownLimit(query = {}, defaultLimit = 50, maxLimit = 200) {
  const requestedLimit = normalizePositiveInteger(query.limit, 'limit') || defaultLimit;
  return Math.min(requestedLimit, maxLimit);
}

function withEnergyRecordFilter(query, callback) {
  const filters = normalizeEnergyRecordFilters(query);
  const { whereSql, params } = buildEnergyRecordWhere(filters);
  return callback({ filters, whereSql, params });
}

function listEnergyRecords(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { defaultPageSize: 20, maxPageSize: MAX_PAGE_SIZE });
  const sort = normalizeDetailSort(query);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const total = db.prepare(
        `SELECT COUNT(*) AS total
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}`
      ).get(params).total;
      const rows = db.prepare(
        `SELECT
           er.id,
           er.source_batch_id AS sourceBatchId,
           er.source_row_number AS sourceRowNumber,
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.original_month AS originalMonth,
           er.normalized_month AS normalizedMonth,
           er.original_unit AS originalUnit,
           er.original_value AS originalValue,
           er.normalized_unit AS normalizedUnit,
           er.normalized_value AS normalizedValue,
           er.organization_unit_id AS organizationUnitId,
           ou.unit_code AS organizationUnitCode,
           ou.unit_name AS organizationUnitName,
           ou.unit_path AS organizationUnitPath,
           er.meter_device_id AS meterDeviceId,
           md.meter_code AS ledgerMeterCode,
           md.meter_name AS meterDeviceName,
           er.organization,
           er.site,
           er.department,
           er.production_line AS productionLine,
           er.meter_code AS meterCode,
           er.business_dimension AS businessDimension,
           er.remark,
           er.duplicate_key AS duplicateKey,
           er.created_at AS createdAt,
           er.updated_at AS updatedAt,
           CASE
             WHEN er.meter_device_id IS NOT NULL THEN 'meter-linked'
             WHEN er.organization_unit_id IS NOT NULL THEN 'organization-linked'
             ELSE 'unlinked'
           END AS ledgerAssociationStatus
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id
         LEFT JOIN meter_devices md ON md.id = er.meter_device_id
         ${whereSql}
         ORDER BY ${sort.orderSql}
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
  });
}

function getEnergyRecordSummary(query = {}) {
  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const summary = db.prepare(
        `SELECT
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COUNT(DISTINCT et.code) AS energyTypeCount,
           COUNT(DISTINCT er.source_batch_id) AS sourceBatchCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.organization, '')), '')) AS organizationCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.site, '')), '')) AS siteCount,
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(er.department, '')), '')) AS departmentCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}`
      ).get(params);

      return {
        ...summary,
        totalNormalizedValue: Number(summary.totalNormalizedValue || 0),
        monthRange: {
          start: summary.monthStart,
          end: summary.monthEnd
        },
        mixedUnitNotice: summary.energyTypeCount > 1
          ? 'totalNormalizedValue 为跨能源类型标准化数值直接求和，仅用于工作台快速摘要；精确对比请按能源类型查看。'
          : null
      };
    } finally {
      db.close();
    }
  });
}

function getMonthlyTrend(query = {}) {
  const limit = normalizeBreakdownLimit(query, STATISTICS_MAX_PAGE_SIZE, STATISTICS_MAX_PAGE_SIZE);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(
        `SELECT
           er.normalized_month AS month,
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           er.normalized_unit AS normalizedUnit,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}
         GROUP BY er.normalized_month, et.code, et.name, er.normalized_unit
         ORDER BY er.normalized_month ASC, et.display_order ASC, et.code ASC
         LIMIT @limit`
      ).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

function getEnergyTypeBreakdown(query = {}) {
  const limit = normalizeBreakdownLimit(query, 100, 200);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      return db.prepare(
        `SELECT
           et.code AS energyTypeCode,
           et.name AS energyTypeName,
           et.category AS category,
           er.normalized_unit AS normalizedUnit,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COALESCE(AVG(er.normalized_value), 0) AS averageNormalizedValue,
           COUNT(DISTINCT er.normalized_month) AS monthCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}
         GROUP BY et.code, et.name, et.category, er.normalized_unit, et.display_order
         ORDER BY totalNormalizedValue DESC, et.display_order ASC, et.code ASC
         LIMIT @limit`
      ).all({ ...params, limit });
    } finally {
      db.close();
    }
  });
}

function getDimensionBreakdown(query = {}) {
  const { dimension, columnSql } = normalizeDimension(query.dimension);
  const limit = normalizeBreakdownLimit(query, 100, 200);

  return withEnergyRecordFilter(query, ({ whereSql, params }) => {
    const db = openDatabase();
    try {
      const rows = db.prepare(
        `SELECT
           COALESCE(NULLIF(TRIM(${columnSql}), ''), '未填写') AS dimensionValue,
           COUNT(er.id) AS recordCount,
           COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
           COUNT(DISTINCT et.code) AS energyTypeCount,
           COUNT(DISTINCT er.normalized_month) AS monthCount,
           MIN(er.normalized_month) AS monthStart,
           MAX(er.normalized_month) AS monthEnd
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}
         GROUP BY dimensionValue
         ORDER BY totalNormalizedValue DESC, recordCount DESC, dimensionValue ASC
         LIMIT @limit`
      ).all({ ...params, limit });

      return { dimension, rows };
    } finally {
      db.close();
    }
  });
}

function normalizePreviewDetailLimit(query = {}) {
  const requestedLimit = normalizePositiveInteger(query.limit || query.detailLimit, 'limit') || 100;
  return Math.min(requestedLimit, 500);
}

function summarizeLedgerBackfillPreview(items = []) {
  const summary = {
    totalScanned: items.length,
    alreadyLinked: 0,
    alreadyPartial: 0,
    candidateByMeter: 0,
    candidateByOrganization: 0,
    ambiguous: 0,
    missing: 0,
    blocked: 0,
    wouldUpdate: 0
  };

  items.forEach((item) => {
    if (item.status === 'already-linked') summary.alreadyLinked += 1;
    else if (item.status === 'already-partial') summary.alreadyPartial += 1;
    else if (item.status === 'candidate-by-meter') summary.candidateByMeter += 1;
    else if (item.status === 'candidate-by-organization') summary.candidateByOrganization += 1;
    else if (item.status === 'ambiguous') summary.ambiguous += 1;
    else if (item.status === 'blocked') summary.blocked += 1;
    else summary.missing += 1;
    if (item.wouldUpdate) summary.wouldUpdate += 1;
  });

  return summary;
}

function getEnergyRecordLedgerBackfillPreview(query = {}) {
  return withEnergyRecordFilter(query, ({ whereSql, params, filters }) => {
    const db = openDatabase();
    try {
      const indexes = loadLedgerBackfillPreviewIndexes(db);
      const records = db.prepare(
        `SELECT
           er.id,
           er.energy_type_id AS energyTypeId,
           et.code AS energyTypeCode,
           er.organization_unit_id AS organizationUnitId,
           er.meter_device_id AS meterDeviceId,
           er.organization,
           er.site,
           er.department,
           er.meter_code AS meterCode,
           er.normalized_month AS normalizedMonth
         FROM energy_records er
         JOIN energy_types et ON et.id = er.energy_type_id
         ${whereSql}
         ORDER BY er.id ASC`
      ).all(params);
      const items = records.map((record) => buildEnergyRecordLedgerBackfillPreview(record, indexes));
      const detailLimit = normalizePreviewDetailLimit(query);
      return {
        dryRun: true,
        previewOnly: true,
        writesEnergyRecords: false,
        operation: 'energy-record-ledger-backfill-preview',
        scope: 'active-energy-records-only',
        filters,
        summary: summarizeLedgerBackfillPreview(items),
        detailLimit,
        items: items.slice(0, detailLimit),
        notices: [
          '本接口仅预演历史 energy_records 台账关联候选，不写入、不回填、不更新 energy_records。',
          '计量器具候选必须与能耗记录能源类型一致；同时存在组织候选时还必须满足计量器具归属组织一致。',
          '原始字段不足、多匹配或组织/仪表归属冲突时只返回原因，不给出确定回填。'
        ]
      };
    } finally {
      db.close();
    }
  });
}

function getDashboardSummary() {
  const db = openDatabase();
  try {
    const energy = db.prepare(
      `SELECT
         COUNT(er.id) AS activeRecordCount,
         COALESCE(SUM(er.normalized_value), 0) AS totalNormalizedValue,
         COUNT(DISTINCT et.code) AS energyTypeCount,
         MIN(er.normalized_month) AS monthStart,
         MAX(er.normalized_month) AS monthEnd,
         MAX(er.created_at) AS latestRecordAt
       FROM energy_records er
       JOIN energy_types et ON et.id = er.energy_type_id
       WHERE er.record_status = 'active'`
    ).get();
    const batches = db.prepare(
      `SELECT
         COUNT(*) AS batchCount,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedBatchCount,
         SUM(CASE WHEN status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completedWithErrorsBatchCount,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedBatchCount,
         COALESCE(SUM(success_count), 0) AS importedRowCount,
         COALESCE(SUM(failure_count), 0) AS failedRowCount,
         COALESCE(SUM(skipped_count), 0) AS skippedRowCount,
         MAX(created_at) AS latestBatchAt
       FROM import_batches`
    ).get();
    const errors = db.prepare(
      `SELECT
         COUNT(*) AS importErrorCount,
         SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) AS blockingErrorCount,
         SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warningCount
       FROM import_errors`
    ).get();

    return {
      scope: 'energy-records-and-imports-only',
      excludes: ['carbon-accounting', 'prediction'],
      energy: {
        ...energy,
        totalNormalizedValue: Number(energy.totalNormalizedValue || 0),
        monthRange: {
          start: energy.monthStart,
          end: energy.monthEnd
        }
      },
      imports: {
        ...batches,
        completedBatchCount: Number(batches.completedBatchCount || 0),
        completedWithErrorsBatchCount: Number(batches.completedWithErrorsBatchCount || 0),
        failedBatchCount: Number(batches.failedBatchCount || 0),
        importedRowCount: Number(batches.importedRowCount || 0),
        failedRowCount: Number(batches.failedRowCount || 0),
        skippedRowCount: Number(batches.skippedRowCount || 0)
      },
      errors: {
        ...errors,
        blockingErrorCount: Number(errors.blockingErrorCount || 0),
        warningCount: Number(errors.warningCount || 0)
      },
      notices: [
        '工作台摘要仅基于能耗明细、导入批次和导入错误数量生成。',
        '本接口不包含碳核算结果、预测结果或伪造图表数据。'
      ]
    };
  } finally {
    db.close();
  }
}

module.exports = {
  getDashboardSummary,
  getDimensionBreakdown,
  getEnergyRecordSummary,
  getEnergyRecordLedgerBackfillPreview,
  getEnergyTypeBreakdown,
  getMonthlyTrend,
  listEnergyRecords,
  normalizeBreakdownLimit
};
