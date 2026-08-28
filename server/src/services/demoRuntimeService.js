const { openDatabase } = require('../db/database');
const { badRequest } = require('../utils/errors');

// 演示运行期设置固定使用单行主键，避免出现多套相互冲突的系统开关。
const DEMO_RUNTIME_SETTINGS_ID = 1;
// 历史纳管确认文本由服务端固定返回，后续执行阶段必须原样校验。
const LEGACY_CLAIM_CONFIRMATION_TEXT = '确认纳管天坤集团历史演示数据 qinglan-park-v1';
// 全量清理确认文本由服务端固定返回，后续执行阶段必须原样校验。
const CLEANUP_CONFIRMATION_TEXT = '确认清除天坤集团演示数据 qinglan-park-v1';
// 恢复数据库后的安全重置原因写入设置和操作审计。
const DATABASE_RESTORE_SAFETY_REASON = 'database_restore_safety_reset';

/**
 * 将数据库行映射为稳定的运行期状态响应。
 * @param {object} row demo_runtime_settings 数据库行。
 * @returns {object} 对外运行期状态。
 */
function assertCanonicalRuntimeRow(row) {
  if (!row || typeof row.enabled !== 'number' || !Number.isSafeInteger(row.enabled) || ![0, 1].includes(row.enabled)
    || typeof row.runtimeEpoch !== 'number' || !Number.isSafeInteger(row.runtimeEpoch) || row.runtimeEpoch < 1
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || (row.updatedBy !== null && (typeof row.updatedBy !== 'number' || !Number.isSafeInteger(row.updatedBy) || row.updatedBy < 1))
    || !isCanonicalUtcTimestamp(row.updatedAt)
    || typeof row.changeReason !== 'string'
    || row.changeReason.trim().length < 1
    || row.changeReason.trim().length > 500) {
    throw new Error('演示运行期设置不是严格 canonical 行。');
  }
  return row;
}

function mapRuntimeStatus(row) {
  try {
    const canonicalRow = assertCanonicalRuntimeRow(row);
    return {
      available: true,
      enabled: canonicalRow.enabled === 1,
      runtimeEpoch: canonicalRow.runtimeEpoch,
      revision: canonicalRow.revision,
      updatedBy: canonicalRow.updatedBy,
      updatedAt: canonicalRow.updatedAt,
      changeReason: canonicalRow.changeReason
    };
  } catch (_error) {
    return buildFailClosedStatus();
  }
}

/**
 * 校验运行期审计时间为规范 UTC ISO 字符串，拒绝日期归一化和本地时区输入。
 * @param {unknown} value 待校验时间值。
 * @returns {boolean} 是否为规范 UTC 时间。
 */
function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonicalTimestamp = new Date(timestamp).toISOString();
  return value.includes('.')
    ? canonicalTimestamp === value
    : canonicalTimestamp.replace('.000Z', 'Z') === value;
}

/**
 * 生成 fail-closed 状态；读取异常时绝不把演示能力误判为已开启。
 * @returns {object} 关闭且不可用的安全状态。
 */
function buildFailClosedStatus() {
  return {
    available: false,
    enabled: false,
    runtimeEpoch: null,
    revision: null,
    updatedBy: null,
    updatedAt: null,
    changeReason: 'runtime_status_unavailable'
  };
}

/**
 * 返回本阶段已经实现和后续尚未实现的基础能力声明。
 * @returns {object} 演示治理能力声明。
 */
function getDemoCapabilities() {
  return {
    status: true,
    toggle: true,
    catalog: true,
    activeRun: true,
    download: true,
    contextIssue: true,
    contextReassociate: true,
    centralPreviewExecuteContext: true,
    retainedUploadReplayContext: false,
    ownershipRegistration: false,
    ownershipSummary: true,
    legacyClaimPreview: false,
    legacyClaimExecute: false,
    cleanupPreview: true,
    cleanupExecute: false,
    cleanupRunStatus: true,
    postActionRegistry: true,
    postActionPreview: true,
    postActionExecute: true,
    postActionRunStatus: true,
    postActionRetry: false
  };
}

/**
 * 返回服务端固定确认文本，未实现的执行接口不得据此伪装为可用。
 * @returns {object} 固定确认文本。
 */
function getDemoConfirmationTexts() {
  return {
    legacyClaim: LEGACY_CLAIM_CONFIRMATION_TEXT,
    cleanup: CLEANUP_CONFIRMATION_TEXT
  };
}

/** 在清理事务内关闭演示运行期并递增 epoch/revision，使全部旧 context 失效。 */
function disableDemoRuntimeAfterCleanup(input = {}) {
  const actorUserId = validateActorUserId(input.actorUserId);
  const actorIp = input.actorIp ? String(input.actorIp) : null;
  const db = input.db;
  if (!db || db.inTransaction !== true) {
    throw new Error('演示清理关闭 runtime 必须位于 IMMEDIATE 事务内。');
  }
  const current = assertCanonicalRuntimeRow(readRuntimeSettingRow(db));
  const updatedAt = new Date().toISOString();
  db.prepare(`UPDATE demo_runtime_settings
    SET enabled = 0, runtime_epoch = runtime_epoch + 1, revision = revision + 1,
      updated_by = ?, updated_at = ?, change_reason = 'demo_cleanup_completed'
    WHERE id = ? AND revision = ?`).run(
    actorUserId,
    updatedAt,
    DEMO_RUNTIME_SETTINGS_ID,
    current.revision
  );
  const next = assertCanonicalRuntimeRow(readRuntimeSettingRow(db));
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, 'system.demo.runtime.cleanup-close', 'demo_runtime_settings', ?, ?, ?, ?)`).run(
    actorUserId,
    String(DEMO_RUNTIME_SETTINGS_ID),
    JSON.stringify({
      previousEnabled: current.enabled === 1,
      runtimeEpoch: next.runtimeEpoch,
      revision: next.revision,
      changeReason: 'demo_cleanup_completed'
    }),
    actorIp,
    updatedAt
  );
  return {
    available: true,
    enabled: next.enabled === 1,
    runtimeEpoch: next.runtimeEpoch,
    revision: next.revision,
    updatedBy: next.updatedBy,
    updatedAt: next.updatedAt,
    changeReason: next.changeReason
  };
}

/**
 * 从指定连接读取单行运行期设置。
 * @param {object} db SQLite 数据库连接。
 * @returns {object} 数据库行。
 */
function readRuntimeSettingRow(db) {
  return db.prepare(`SELECT enabled, runtime_epoch AS runtimeEpoch, revision,
      updated_by AS updatedBy, updated_at AS updatedAt, change_reason AS changeReason
    FROM demo_runtime_settings WHERE id = ?`).get(DEMO_RUNTIME_SETTINGS_ID);
}

/**
 * 读取演示运行期开关；表缺失、单行缺失或数据库异常时统一 fail-closed。
 * @returns {object} 演示运行期状态。
 */
function getDemoRuntimeStatus() {
  let db;
  try {
    db = openDatabase();
    const row = readRuntimeSettingRow(db);
    return row ? mapRuntimeStatus(row) : buildFailClosedStatus();
  } catch (error) {
    return buildFailClosedStatus();
  } finally {
    if (db) db.close();
  }
}

/** 从正式库读取严格 canonical runtime；恢复冻结窗口中任何异常必须拒绝继续。 */
function readCanonicalDemoRuntime(options = {}) {
  const ownedDb = !options.db;
  const db = options.db || openDatabase({ admissionPermit: options.admissionPermit });
  try {
    return assertCanonicalRuntimeRow(readRuntimeSettingRow(db));
  } finally {
    if (ownedDb) db.close();
  }
}

/**
 * 严格校验开关输入，禁止字符串或数字被隐式转换为布尔值。
 * @param {unknown} enabled 请求中的开关值。
 * @returns {boolean} 已校验布尔值。
 */
function validateEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw badRequest('enabled 必须为布尔值。', { code: 'INVALID_DEMO_RUNTIME_ENABLED' });
  }
  return enabled;
}

/** 严格校验认证 actor 主键，禁止布尔值和数字字符串被隐式归属。 */
function validateActorUserId(actorUserId) {
  if (typeof actorUserId !== 'number' || !Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw badRequest('actorUserId 必须为正安全整数。', { code: 'INVALID_DEMO_RUNTIME_ACTOR_USER_ID' });
  }
  return actorUserId;
}

/** 恢复请求 actor 仅保留原始 number 正整数，其余输入安全置空。 */
function normalizeOptionalActorUserId(actorUserId) {
  return typeof actorUserId === 'number' && Number.isSafeInteger(actorUserId) && actorUserId > 0
    ? actorUserId : null;
}

/**
 * 在同一事务中写入开关、递增 epoch/revision 并记录操作审计。
 * @param {object} input 开关变更输入。
 * @returns {object} 变更后的运行期状态。
 */
function toggleDemoRuntime(input = {}) {
  const enabled = validateEnabled(input.enabled);
  const actorUserId = validateActorUserId(input.actorUserId);
  const actorIp = input.actorIp ? String(input.actorIp) : null;
  const changeReason = enabled ? 'runtime_toggle_enabled' : 'runtime_toggle_disabled';
  const updatedAt = new Date().toISOString();
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const current = readRuntimeSettingRow(db);
      if (!current) {
        throw new Error('演示运行期设置未初始化。');
      }
      const canonicalCurrent = assertCanonicalRuntimeRow(current);
      db.prepare(`UPDATE demo_runtime_settings
        SET enabled = ?, runtime_epoch = runtime_epoch + 1, revision = revision + 1,
          updated_by = ?, updated_at = ?, change_reason = ?
        WHERE id = ?`).run(enabled ? 1 : 0, actorUserId, updatedAt, changeReason, DEMO_RUNTIME_SETTINGS_ID);
      const canonicalNext = assertCanonicalRuntimeRow(readRuntimeSettingRow(db));
      db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, ip, created_at)
        VALUES (?, 'system.demo.runtime.toggle', 'demo_runtime_settings', ?, ?, ?, ?)`)
        .run(actorUserId, String(DEMO_RUNTIME_SETTINGS_ID), JSON.stringify({
          enabled,
          previousEnabled: canonicalCurrent.enabled === 1,
          runtimeEpoch: canonicalNext.runtimeEpoch,
          revision: canonicalNext.revision,
          changeReason
        }), actorIp, updatedAt);
      return {
        available: true,
        enabled: canonicalNext.enabled === 1,
        runtimeEpoch: canonicalNext.runtimeEpoch,
        revision: canonicalNext.revision,
        updatedBy: canonicalNext.updatedBy,
        updatedAt: canonicalNext.updatedAt,
        changeReason: canonicalNext.changeReason
      };
    })();
  } finally {
    db.close();
  }
}

/**
 * 数据库恢复后强制关闭演示开关并提升 epoch/revision，使备份内旧上下文全部失效。
 * @returns {object} 安全归一化后的运行期状态。
 */
function normalizeDemoRuntimeAfterRestore(actor = {}, options = {}) {
  const updatedAt = new Date().toISOString();
  const actorUserId = normalizeOptionalActorUserId(actor.userId);
  const actorIp = actor.ip ? String(actor.ip) : null;
  const requestActorSnapshot = {
    userId: actorUserId,
    username: actor.username ? String(actor.username) : null,
    displayName: actor.displayName ? String(actor.displayName) : null,
    ip: actorIp
  };
  const ownedDb = !options.db;
  const db = options.db || openDatabase({ databasePath: options.databasePath });
  try {
    return db.transaction(() => {
      const current = readRuntimeSettingRow(db);
      if (!current) {
        throw new Error('数据库恢复后缺少演示运行期设置。');
      }
      const canonicalCurrent = assertCanonicalRuntimeRow(current);
      const minimumEpoch = options.minimumRuntimeEpoch === undefined
        ? canonicalCurrent.runtimeEpoch : options.minimumRuntimeEpoch;
      const minimumRevision = options.minimumRevision === undefined
        ? canonicalCurrent.revision : options.minimumRevision;
      if (typeof minimumEpoch !== 'number' || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 1
        || typeof minimumRevision !== 'number' || !Number.isSafeInteger(minimumRevision) || minimumRevision < 1) {
        throw new Error('数据库恢复运行期下限不是严格 canonical 整数。');
      }
      const nextEpoch = Math.max(canonicalCurrent.runtimeEpoch, minimumEpoch) + 1;
      const nextRevision = Math.max(canonicalCurrent.revision, minimumRevision) + 1;
      const matchingActor = actorUserId && actor.username
        ? db.prepare(`SELECT id, username, display_name AS displayName FROM sys_users
          WHERE id = ? AND username = ?`).get(actorUserId, String(actor.username))
        : null;
      db.prepare(`UPDATE demo_runtime_settings
        SET enabled = 0, runtime_epoch = ?, revision = ?,
          updated_by = ?, updated_at = ?, change_reason = ?
        WHERE id = ?`).run(nextEpoch, nextRevision, matchingActor ? actorUserId : null,
        updatedAt, DATABASE_RESTORE_SAFETY_REASON, DEMO_RUNTIME_SETTINGS_ID);
      const canonicalNext = assertCanonicalRuntimeRow(readRuntimeSettingRow(db));
      db.prepare(`INSERT INTO sys_operation_logs
        (user_id, operation, target_type, target_id, detail_json, ip, created_at)
        VALUES (?, 'system.demo.runtime.restore-safety-reset', 'demo_runtime_settings', ?, ?, ?, ?)`)
        .run(matchingActor ? matchingActor.id : null, String(DEMO_RUNTIME_SETTINGS_ID), JSON.stringify({
          requestActorSnapshot,
          actorResolvedInRestoredDatabase: Boolean(matchingActor),
          resolvedActor: matchingActor ? {
            userId: matchingActor.id,
            username: matchingActor.username,
            displayName: matchingActor.displayName
          } : null,
          previousEnabled: canonicalCurrent.enabled === 1,
          runtimeEpoch: canonicalNext.runtimeEpoch,
          revision: canonicalNext.revision,
          changeReason: DATABASE_RESTORE_SAFETY_REASON
        }), actorIp, updatedAt);
      return {
        available: true,
        enabled: canonicalNext.enabled === 1,
        runtimeEpoch: canonicalNext.runtimeEpoch,
        revision: canonicalNext.revision,
        updatedBy: canonicalNext.updatedBy,
        updatedAt: canonicalNext.updatedAt,
        changeReason: canonicalNext.changeReason
      };
    })();
  } finally {
    if (ownedDb) db.close();
  }
}

module.exports = {
  CLEANUP_CONFIRMATION_TEXT,
  DATABASE_RESTORE_SAFETY_REASON,
  disableDemoRuntimeAfterCleanup,
  LEGACY_CLAIM_CONFIRMATION_TEXT,
  getDemoCapabilities,
  getDemoConfirmationTexts,
  getDemoRuntimeStatus,
  readCanonicalDemoRuntime,
  normalizeDemoRuntimeAfterRestore,
  toggleDemoRuntime,
  validateEnabled,
  _test: {
    assertCanonicalRuntimeRow,
    mapRuntimeStatus
  }
};
