function createMeta(extra = {}) {
  return {
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function sendSuccess(res, data = null, options = {}) {
  const { statusCode = 200, meta = {} } = options;
  return res.status(statusCode).json({
    success: true,
    data,
    meta: createMeta(meta)
  });
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || '服务内部错误',
      details: error.details || null
    },
    meta: createMeta()
  });
}

module.exports = {
  sendSuccess,
  sendError
};
