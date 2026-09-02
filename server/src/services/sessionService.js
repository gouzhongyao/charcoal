const crypto = require('crypto');
const { openDatabase } = require('../db/database');
const { AppError } = require('../utils/errors');

const DEFAULT_SESSION_TTL_HOURS = 8;

function now() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function getSessionTtlHours() {
  const parsed = Number(process.env.CHARCOAL_SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 168 ? parsed : DEFAULT_SESSION_TTL_HOURS;
}

function createSession(userId, context = {}) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + getSessionTtlHours() * 60 * 60 * 1000).toISOString();
  const db = openDatabase();
  try {
    const result = db.prepare(`INSERT INTO sys_sessions
      (user_id, token_hash, expires_at, created_ip, user_agent, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, hashToken(token), expiresAt, context.ip || null, context.userAgent || null, now(), now());
    return { token, sessionId: result.lastInsertRowid, expiresAt };
  } finally {
    db.close();
  }
}

function getSessionByToken(token) {
  if (!token) return null;
  const db = openDatabase();
  try {
    const session = db.prepare(`SELECT s.id, s.user_id AS userId, s.expires_at AS expiresAt,
      u.username, u.display_name AS displayName, u.status AS userStatus
      FROM sys_sessions s JOIN sys_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hashToken(token), now());
    if (!session || session.userStatus !== 'active') return null;
    db.prepare('UPDATE sys_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
    return session;
  } finally {
    db.close();
  }
}

function revokeSessionByToken(token) {
  if (!token) return false;
  const db = openDatabase();
  try {
    return db.prepare('UPDATE sys_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), hashToken(token)).changes > 0;
  } finally {
    db.close();
  }
}

function revokeUserSessions(userId, exceptSessionId = null) {
  const db = openDatabase();
  try {
    const statement = exceptSessionId
      ? db.prepare('UPDATE sys_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL')
      : db.prepare('UPDATE sys_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL');
    return exceptSessionId ? statement.run(now(), userId, exceptSessionId).changes : statement.run(now(), userId).changes;
  } finally {
    db.close();
  }
}

function requireSession(token) {
  const session = getSessionByToken(token);
  if (!session) {
    throw new AppError('UNAUTHENTICATED', '登录状态无效、已过期或账号已停用。', { statusCode: 401 });
  }
  return session;
}

function sanitizeAuditDetail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const blocked = new Set(['password', 'passwordhash', 'currentpassword', 'newpassword', 'token', 'authorization']);
  if (Array.isArray(value)) return value.map(sanitizeAuditDetail);
  return Object.entries(value).reduce((result, [key, item]) => {
    if (!blocked.has(key.toLowerCase())) result[key] = sanitizeAuditDetail(item);
    return result;
  }, {});
}

/** 在独立连接或调用者持有的 SQLite 事务中写入统一操作日志。 */
function recordOperation({ userId = null, operation, targetType = null, targetId = null, detail = null, ip = null, db: providedDb = null } = {}) {
  const ownedDb = !providedDb;
  const db = providedDb || openDatabase();
  try {
    db.prepare(`INSERT INTO sys_operation_logs (user_id, operation, target_type, target_id, detail_json, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, operation, targetType, targetId === null ? null : String(targetId), JSON.stringify(sanitizeAuditDetail(detail)), ip, now());
  } finally {
    if (ownedDb) db.close();
  }
}

module.exports = {
  createSession,
  getSessionByToken,
  hashToken,
  recordOperation,
  requireSession,
  revokeSessionByToken,
  revokeUserSessions,
  sanitizeAuditDetail
};
