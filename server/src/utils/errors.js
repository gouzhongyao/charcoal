class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode || 500;
    this.details = options.details || null;
  }
}

/** 数据库恢复切换或安全锁定期间使用的稳定应用错误类型。 */
class DatabaseAvailabilityError extends AppError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = 'DatabaseAvailabilityError';
  }
}

/** 构造正式数据库处于恢复切换屏障时的可重试错误。 */
function databaseAdmissionBlocked() {
  return new DatabaseAvailabilityError(
    'DATABASE_ADMISSION_BLOCKED',
    '正式数据库正在切换，暂不接受新连接。',
    {
      statusCode: 423,
      details: {
        retryable: true
      }
    }
  );
}

/** 构造正式数据库状态不可确认时的不可重试安全锁定错误。 */
function databasePoisoned() {
  return new DatabaseAvailabilityError(
    'DATABASE_POISONED',
    '数据库处于安全锁定状态，请联系运维人员处理。',
    {
      statusCode: 503,
      details: {
        retryable: false,
        operationalActionRequired: true
      }
    }
  );
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

/** 判断错误是否为 Express JSON 解析器报告的正文超限。 */
function isPayloadTooLargeError(error) {
  return error?.type === 'entity.too.large'
    || Number(error?.statusCode || error?.status) === 413;
}

/** 将框架和领域错误规范化为稳定、无敏感信息的应用错误。 */
function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }
  if (isPayloadTooLargeError(error)) {
    return new AppError('PAYLOAD_TOO_LARGE', '请求正文超过允许大小。', {
      statusCode: 413,
      details: null
    });
  }

  return new AppError('INTERNAL_ERROR', '服务内部错误', {
    statusCode: 500,
    details: process.env.NODE_ENV === 'development' ? { message: error.message } : null
  });
}

module.exports = {
  AppError,
  DatabaseAvailabilityError,
  badRequest,
  databaseAdmissionBlocked,
  databasePoisoned,
  featurePending,
  invalidBackup,
  isPayloadTooLargeError,
  normalizeError,
  notFound
};
