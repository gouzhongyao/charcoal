'use strict';

const { AppError, badRequest, notFound } = require('../utils/errors');
const { MANUAL_HANDLING_STATUSES } = require('./energyAnalysisContracts');

// 平衡优化建议使用的固定本地规则版本。
const BALANCE_SUGGESTION_RULE_VERSION = 'energy-balance-suggestion:v1';
// 平衡优化建议引用的固定平衡公式版本。
const BALANCE_SUGGESTION_FORMULA_VERSION = 'energy-balance:v1';
// 不平衡率核查阈值，达到 5% 时生成确定性核查建议。
const IMBALANCE_RATE_THRESHOLD = 0.05;
// 已知损耗率核查阈值，达到 3% 时生成确定性核查建议。
const KNOWN_LOSS_RATE_THRESHOLD = 0.03;
// 建议状态允许的人工流转关系。
const SUGGESTION_STATUS_TRANSITIONS = Object.freeze({
  unconfirmed: Object.freeze(['accepted', 'rejected']),
  accepted: Object.freeze(['rejected', 'resolved']),
  rejected: Object.freeze([]),
  resolved: Object.freeze([])
});

/**
 * 判断值是否为非数组普通对象。
 * @param {*} value 待判断值。
 * @returns {boolean} 是否为普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范可选人工备注，拒绝对象、数组和超长文本。
 * @param {*} value 原始备注。
 * @returns {string|null} 规范备注。
 */
function normalizeReviewNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest('reviewNote 必须是字符串。', { code: 'INVALID_BALANCE_SUGGESTION_REVIEW_NOTE' });
  }
  const normalizedNote = value.trim();
  if (normalizedNote.length > 1000) {
    throw badRequest('reviewNote 最长 1000 个字符。', {
      code: 'BALANCE_SUGGESTION_REVIEW_NOTE_TOO_LONG',
      maximumLength: 1000
    });
  }
  return normalizedNote || null;
}

/**
 * 安全解析 JSON 字段，历史异常值按空值返回而不泄露数据库细节。
 * @param {*} value JSON 文本。
 * @param {*} fallback 解析失败时的回退值。
 * @returns {*} 解析结果。
 */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

/**
 * 将建议数据库行投影为稳定公开契约。
 * @param {object|null} row 数据库行。
 * @returns {object|null} 建议公开对象。
 */
function mapSuggestionRow(row) {
  if (!row) return null;
  const threshold = parseJson(row.thresholdJson, null);
  const evidence = parseJson(row.evidenceJson, []);
  return {
    id: Number(row.id),
    calculationRunId: row.calculationRunId,
    snapshotId: Number(row.snapshotId),
    sourceDataDigest: row.sourceDataDigest || null,
    suggestionCode: row.suggestionCode,
    ruleCode: threshold?.ruleCode || row.suggestionCode,
    ruleVersion: threshold?.ruleVersion || null,
    formulaVersion: threshold?.formulaVersion || null,
    title: row.title,
    content: row.content,
    priority: row.priority,
    threshold,
    evidence: Array.isArray(evidence) ? evidence : [],
    estimatedSaving: row.estimatedSaving === null ? null : Number(row.estimatedSaving),
    estimatedSavingUnit: row.estimatedSavingUnit,
    manualStatus: row.manualStatus,
    reviewedAt: row.reviewedAt,
    reviewedByUserId: row.reviewedByUserId === null || row.reviewedByUserId === undefined
      ? null
      : Number(row.reviewedByUserId),
    reviewNote: row.reviewNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    automationBoundary: {
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      changesBudgetOrLedger: false,
      requiresManualReview: true
    }
  };
}

/**
 * 构造可追溯的规则阈值快照。
 * @param {string} ruleCode 规则编码。
 * @param {string} metricCode 指标编码。
 * @param {number} thresholdValue 阈值。
 * @param {string} thresholdUnit 阈值单位。
 * @returns {object} 阈值快照。
 */
function buildThreshold(ruleCode, metricCode, thresholdValue, thresholdUnit) {
  return {
    ruleCode,
    ruleVersion: BALANCE_SUGGESTION_RULE_VERSION,
    formulaVersion: BALANCE_SUGGESTION_FORMULA_VERSION,
    metricCode,
    operator: 'gte',
    value: thresholdValue,
    unit: thresholdUnit,
    estimatedSavingConfigured: false
  };
}

/**
 * 根据单个平衡分面快照构造本地确定性建议候选。
 * @param {object} facetResult 分面计算结果。
 * @param {object} context 计算批次上下文。
 * @returns {object[]} 仅包含有事实证据的建议候选。
 */
function buildDeterministicSuggestions(facetResult, context) {
  const suggestions = [];
  const commonEvidence = {
    calculationRunId: context.calculationRunId,
    snapshotId: facetResult.snapshotId,
    sourceDataDigest: context.sourceDataDigest,
    boundaryId: context.boundaryId,
    boundaryCode: context.boundaryCode,
    energyTypeCode: facetResult.energyTypeCode,
    originalUnit: facetResult.originalUnit,
    startUtc: context.startUtc,
    endUtc: context.endUtc,
    completenessRate: facetResult.completenessRate,
    reasonCodes: facetResult.reasonCodes
  };

  if (facetResult.completenessRate < 1 || facetResult.reasonCodes.length > 0) {
    suggestions.push({
      suggestionCode: 'BALANCE_DATA_COMPLETENESS_REVIEW',
      title: '核查平衡数据完整性',
      content: '当前平衡分面存在来源缺口或不可计算原因，请人工核对显式来源映射、周期覆盖、单位和折标系数后重新计算。',
      priority: facetResult.completenessRate < 0.8 ? 'high' : 'medium',
      threshold: buildThreshold('BALANCE_DATA_COMPLETENESS_REVIEW', 'completeness_rate', 1, 'ratio'),
      evidence: [{
        ...commonEvidence,
        actualValue: facetResult.completenessRate
      }]
    });
  }

  if (Number.isFinite(facetResult.imbalanceRate)
    && facetResult.imbalanceRate >= IMBALANCE_RATE_THRESHOLD) {
    suggestions.push({
      suggestionCode: 'BALANCE_IMBALANCE_RATE_REVIEW',
      title: '核查平衡差额来源',
      content: '当前不平衡率达到规则阈值，请人工核查计量边界、库存变化、调整项和已知损耗证据；系统不会把差额自动认定为损耗。',
      priority: facetResult.imbalanceRate >= 0.1 ? 'high' : 'medium',
      threshold: buildThreshold(
        'BALANCE_IMBALANCE_RATE_REVIEW',
        'imbalance_rate',
        IMBALANCE_RATE_THRESHOLD,
        'ratio'
      ),
      evidence: [{
        ...commonEvidence,
        actualValue: facetResult.imbalanceRate,
        inputTotal: facetResult.inputTotalOriginal,
        outputTotal: facetResult.outputTotalOriginal,
        unexplainedDifference: facetResult.unexplainedOriginal
      }]
    });
  }

  if (Number.isFinite(facetResult.lossRate)
    && facetResult.lossRate >= KNOWN_LOSS_RATE_THRESHOLD) {
    suggestions.push({
      suggestionCode: 'BALANCE_KNOWN_LOSS_RATE_REVIEW',
      title: '核查已知损耗率',
      content: '当前已知损耗率达到规则阈值，请人工核对损耗项目证据和改善措施；未配置可削减比例，因此不生成预计节能量。',
      priority: facetResult.lossRate >= 0.08 ? 'high' : 'medium',
      threshold: buildThreshold(
        'BALANCE_KNOWN_LOSS_RATE_REVIEW',
        'known_loss_rate',
        KNOWN_LOSS_RATE_THRESHOLD,
        'ratio'
      ),
      evidence: [{
        ...commonEvidence,
        actualValue: facetResult.lossRate,
        knownLossOriginal: facetResult.knownLossOriginal,
        inputTotal: facetResult.inputTotalOriginal
      }]
    });
  }

  return suggestions;
}

/**
 * 在调用方事务中持久化确定性建议，不产生控制、预算或台账副作用。
 * @param {object} db SQLite 连接。
 * @param {object[]} facetResults 已落库的分面结果。
 * @param {object} context 计算批次上下文。
 * @returns {object[]} 新增建议列表。
 */
function createSuggestionsForSnapshots(db, facetResults, context) {
  const insertSuggestion = db.prepare(
    `INSERT INTO energy_balance_suggestions (
       calculation_run_id, energy_balance_snapshot_id, suggestion_code, title, content, priority,
       threshold_json, evidence_json, estimated_saving, estimated_saving_unit,
       manual_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'unconfirmed', ?, ?)`
  );
  const createdSuggestions = [];
  const now = new Date().toISOString();
  facetResults.forEach((facetResult) => {
    buildDeterministicSuggestions(facetResult, context).forEach((candidate) => {
      const insertResult = insertSuggestion.run(
        context.calculationRunId,
        facetResult.snapshotId,
        candidate.suggestionCode,
        candidate.title,
        candidate.content,
        candidate.priority,
        JSON.stringify(candidate.threshold),
        JSON.stringify(candidate.evidence),
        now,
        now
      );
      const createdRow = db.prepare(
        `SELECT suggestion.id,
                suggestion.calculation_run_id AS calculationRunId,
                suggestion.energy_balance_snapshot_id AS snapshotId,
                snapshot.source_data_digest AS sourceDataDigest,
                suggestion.suggestion_code AS suggestionCode,
                suggestion.title,
                suggestion.content,
                suggestion.priority,
                suggestion.threshold_json AS thresholdJson,
                suggestion.evidence_json AS evidenceJson,
                suggestion.estimated_saving AS estimatedSaving,
                suggestion.estimated_saving_unit AS estimatedSavingUnit,
                suggestion.manual_status AS manualStatus,
                suggestion.reviewed_at AS reviewedAt,
                suggestion.reviewed_by_user_id AS reviewedByUserId,
                suggestion.review_note AS reviewNote,
                suggestion.created_at AS createdAt,
                suggestion.updated_at AS updatedAt
         FROM energy_balance_suggestions AS suggestion
         JOIN energy_balance_snapshots AS snapshot ON snapshot.id = suggestion.energy_balance_snapshot_id
         WHERE suggestion.id = ?`
      ).get(insertResult.lastInsertRowid);
      createdSuggestions.push(mapSuggestionRow(createdRow));
    });
  });
  return createdSuggestions;
}

/**
 * 构造建议筛选和绑定参数。
 * @param {object} query 查询参数。
 * @returns {{ whereSql: string, params: object }} SQL 条件与参数。
 */
function buildSuggestionWhere(query) {
  const where = [];
  const params = {};
  if (query.snapshotId) {
    where.push('suggestion.energy_balance_snapshot_id = @snapshotId');
    params.snapshotId = query.snapshotId;
  }
  if (query.boundaryId) {
    where.push('snapshot.energy_balance_boundary_id = @boundaryId');
    params.boundaryId = query.boundaryId;
  }
  if (query.calculationRunId) {
    where.push('suggestion.calculation_run_id = @calculationRunId');
    params.calculationRunId = query.calculationRunId;
  }
  if (query.sourceDataDigest) {
    where.push('snapshot.source_data_digest = @sourceDataDigest');
    params.sourceDataDigest = query.sourceDataDigest;
  }
  if (query.manualStatus) {
    where.push('suggestion.manual_status = @manualStatus');
    params.manualStatus = query.manualStatus;
  }
  if (query.priority) {
    where.push('suggestion.priority = @priority');
    params.priority = query.priority;
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

/**
 * 分页查询平衡优化建议。
 * @param {object} db SQLite 连接。
 * @param {object} query 已规范查询参数。
 * @returns {{ rows: object[], pagination: object }} 建议和分页信息。
 */
function listBalanceSuggestionsWithDb(db, query) {
  const { whereSql, params } = buildSuggestionWhere(query);
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS total
     FROM energy_balance_suggestions AS suggestion
     JOIN energy_balance_snapshots AS snapshot ON snapshot.id = suggestion.energy_balance_snapshot_id
     ${whereSql}`
  ).get(params).total);
  const rows = db.prepare(
    `SELECT suggestion.id,
            suggestion.calculation_run_id AS calculationRunId,
            suggestion.energy_balance_snapshot_id AS snapshotId,
            snapshot.source_data_digest AS sourceDataDigest,
            suggestion.suggestion_code AS suggestionCode,
            suggestion.title,
            suggestion.content,
            suggestion.priority,
            suggestion.threshold_json AS thresholdJson,
            suggestion.evidence_json AS evidenceJson,
            suggestion.estimated_saving AS estimatedSaving,
            suggestion.estimated_saving_unit AS estimatedSavingUnit,
            suggestion.manual_status AS manualStatus,
            suggestion.reviewed_at AS reviewedAt,
            suggestion.reviewed_by_user_id AS reviewedByUserId,
            suggestion.review_note AS reviewNote,
            suggestion.created_at AS createdAt,
            suggestion.updated_at AS updatedAt
     FROM energy_balance_suggestions AS suggestion
     JOIN energy_balance_snapshots AS snapshot ON snapshot.id = suggestion.energy_balance_snapshot_id
     ${whereSql}
     ORDER BY CASE suggestion.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              suggestion.created_at DESC, suggestion.id DESC
     LIMIT @pageSize OFFSET @offset`
  ).all({ ...params, pageSize: query.pageSize, offset: query.offset }).map(mapSuggestionRow);
  return {
    rows,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      hasMore: query.page * query.pageSize < total,
      nextPage: query.page * query.pageSize < total ? query.page + 1 : null
    }
  };
}

/**
 * 更新建议人工状态并保留复核用户、时间和备注审计。
 * @param {object} db SQLite 连接。
 * @param {number} suggestionId 建议 ID。
 * @param {*} input 状态更新输入。
 * @param {number} reviewedByUserId 复核用户 ID。
 * @returns {object} 更新后的建议。
 */
function updateBalanceSuggestionStatusWithDb(db, suggestionId, input, reviewedByUserId) {
  if (!isPlainObject(input)) {
    throw badRequest('建议状态输入必须是对象。', { code: 'INVALID_BALANCE_SUGGESTION_STATUS_INPUT' });
  }
  const manualStatus = typeof input.manualStatus === 'string' ? input.manualStatus.trim() : '';
  if (!MANUAL_HANDLING_STATUSES.includes(manualStatus) || manualStatus === 'unconfirmed') {
    throw badRequest('manualStatus 只允许 accepted、rejected 或 resolved。', {
      code: 'INVALID_BALANCE_SUGGESTION_STATUS',
      allowedValues: ['accepted', 'rejected', 'resolved']
    });
  }
  const reviewNote = normalizeReviewNote(input.reviewNote);
  if ((manualStatus === 'rejected' || manualStatus === 'resolved') && !reviewNote) {
    throw badRequest('拒绝或解决建议时必须填写 reviewNote。', {
      code: 'BALANCE_SUGGESTION_REVIEW_NOTE_REQUIRED',
      manualStatus
    });
  }
  const existing = db.prepare(
    `SELECT id, manual_status AS manualStatus
     FROM energy_balance_suggestions
     WHERE id = ?`
  ).get(suggestionId);
  if (!existing) {
    throw notFound('平衡优化建议不存在。', { suggestionId });
  }
  const allowedTargets = SUGGESTION_STATUS_TRANSITIONS[existing.manualStatus] || [];
  if (!allowedTargets.includes(manualStatus)) {
    throw new AppError('BALANCE_SUGGESTION_STATUS_CONFLICT', '建议状态不允许执行该流转。', {
      statusCode: 409,
      details: {
        suggestionId,
        currentStatus: existing.manualStatus,
        targetStatus: manualStatus,
        allowedTargets
      }
    });
  }
  const reviewedAt = new Date().toISOString();
  db.prepare(
    `UPDATE energy_balance_suggestions
     SET manual_status = ?, reviewed_at = ?, reviewed_by_user_id = ?, review_note = ?, updated_at = ?
     WHERE id = ?`
  ).run(manualStatus, reviewedAt, reviewedByUserId, reviewNote, reviewedAt, suggestionId);
  const updated = db.prepare(
    `SELECT suggestion.id,
            suggestion.calculation_run_id AS calculationRunId,
            suggestion.energy_balance_snapshot_id AS snapshotId,
            snapshot.source_data_digest AS sourceDataDigest,
            suggestion.suggestion_code AS suggestionCode,
            suggestion.title,
            suggestion.content,
            suggestion.priority,
            suggestion.threshold_json AS thresholdJson,
            suggestion.evidence_json AS evidenceJson,
            suggestion.estimated_saving AS estimatedSaving,
            suggestion.estimated_saving_unit AS estimatedSavingUnit,
            suggestion.manual_status AS manualStatus,
            suggestion.reviewed_at AS reviewedAt,
            suggestion.reviewed_by_user_id AS reviewedByUserId,
            suggestion.review_note AS reviewNote,
            suggestion.created_at AS createdAt,
            suggestion.updated_at AS updatedAt
     FROM energy_balance_suggestions AS suggestion
     JOIN energy_balance_snapshots AS snapshot ON snapshot.id = suggestion.energy_balance_snapshot_id
     WHERE suggestion.id = ?`
  ).get(suggestionId);
  return mapSuggestionRow(updated);
}

module.exports = {
  BALANCE_SUGGESTION_FORMULA_VERSION,
  BALANCE_SUGGESTION_RULE_VERSION,
  IMBALANCE_RATE_THRESHOLD,
  KNOWN_LOSS_RATE_THRESHOLD,
  SUGGESTION_STATUS_TRANSITIONS,
  buildDeterministicSuggestions,
  createSuggestionsForSnapshots,
  listBalanceSuggestionsWithDb,
  mapSuggestionRow,
  updateBalanceSuggestionStatusWithDb
};
