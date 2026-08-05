const { AppError } = require('../utils/errors');
const { requireSession } = require('../services/sessionService');

function extractBearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function authenticate(req, res, next) {
  try {
    const session = requireSession(extractBearerToken(req));
    req.auth = { sessionId: session.id, token: extractBearerToken(req) };
    req.user = { id: session.userId, username: session.username, displayName: session.displayName };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError('UNAUTHENTICATED', '登录状态无效。', { statusCode: 401 }));
  }
}

module.exports = { authenticate, extractBearerToken };
