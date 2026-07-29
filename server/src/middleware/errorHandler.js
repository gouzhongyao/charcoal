const { normalizeError, notFound } = require('../utils/errors');
const { sendError } = require('../utils/response');

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function notFoundHandler(req, res, next) {
  next(notFound('接口不存在', { method: req.method, path: req.originalUrl }));
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  return sendError(res, normalizeError(error));
}

module.exports = {
  asyncHandler,
  errorHandler,
  notFoundHandler
};
