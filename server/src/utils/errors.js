class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode || 500;
    this.details = options.details || null;
  }
}

function badRequest(message, details) {
  return new AppError('BAD_REQUEST', message, { statusCode: 400, details });
}

function notFound(message = '接口不存在', details) {
  return new AppError('NOT_FOUND', message, { statusCode: 404, details });
}

function invalidBackup(message = '备份文件无效/损坏', details) {
  return new AppError('INVALID_BACKUP_FILE', message, { statusCode: 400, details });
}

function featurePending(featureName, details = {}) {
  return new AppError(`${details.code || 'FEATURE_PENDING'}`, `${featureName}尚未实现，当前仅提供接口契约占位。`, {
    statusCode: 501,
    details: {
      status: 'pending',
      contractOnly: true,
      ...details
    }
  });
}

function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError('INTERNAL_ERROR', '服务内部错误', {
    statusCode: 500,
    details: process.env.NODE_ENV === 'development' ? { message: error.message } : null
  });
}

module.exports = {
  AppError,
  badRequest,
  featurePending,
  invalidBackup,
  normalizeError,
  notFound
};
