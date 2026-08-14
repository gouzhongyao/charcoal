'use strict';

const { AppError, badRequest } = require('../utils/errors');
const {
  DEMO_CONTEXT_TOKEN_LENGTH,
  bindDemoContextPreview,
  markDemoContextExecuted,
  sha256File,
  validateDemoContext,
  validateDemoContextToken
} = require('../services/demoContextService');
const { requireDemoArtifactHandler } = require('../services/demoArtifactRegistry');

const DEMO_CONTEXT_HEADER = 'x-demo-context';

/** 从 rawHeaders 大小写不敏感统计并提取唯一 X-Demo-Context，拒绝 Node/Express 合并后的重复头。 */
function readRawDemoContextHeader(req) {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index] || '').toLowerCase() === DEMO_CONTEXT_HEADER) {
      values.push(String(rawHeaders[index + 1] || ''));
    }
  }
  if (values.length > 1) {
    throw new AppError('DEMO_CONTEXT_HEADER_DUPLICATE', 'X-Demo-Context 请求头只能出现一次。', { statusCode: 400 });
  }
  if (values.length === 0) return null;
  const token = values[0];
  if (token.length > 128 || token.length !== DEMO_CONTEXT_TOKEN_LENGTH || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new AppError('DEMO_CONTEXT_HEADER_INVALID', 'X-Demo-Context 请求头格式无效。', { statusCode: 400 });
  }
  return validateDemoContextToken(token);
}

/** 对尚未接入演示 context 的真实导入路由执行 fail-closed 阻断。 */
function rejectUnconnectedDemoContext(req, _res, next) {
  try {
    const token = readRawDemoContextHeader(req);
    if (!token) {
      next();
      return;
    }
    throw new AppError(
      'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED',
      '该导入能力尚未接入演示 context，已拒绝以避免降级为正式导入。',
      { statusCode: 409 }
    );
  } catch (error) {
    next(error);
  }
}

/** 创建仅用于显式 demo-aware 路由的 context 预校验中间件，必须挂载在 Multer 之前。 */
function demoContextPreflight(options = {}) {
  const artifactKey = String(options.artifactKey || '').trim();
  const handlerKey = String(options.handlerKey || '').trim();
  const phase = String(options.phase || '').trim();
  const allowFormal = options.allowFormal !== false;
  requireDemoArtifactHandler(artifactKey, handlerKey);
  if (!['preview', 'execute'].includes(phase)) throw new Error('demoContextPreflight phase 必须为 preview 或 execute。');

  return (req, _res, next) => {
    try {
      const token = readRawDemoContextHeader(req);
      if (!token) {
        if (!allowFormal) throw new AppError('DEMO_CONTEXT_REQUIRED', '该请求必须携带演示 context。', { statusCode: 400 });
        req.demoContext = null;
        next();
        return;
      }
      // preflight 不从 URL、query 或 body 接受 token；preview 必须在 Multer 落盘前完成全部非文件绑定校验。
      const context = phase === 'preview'
        ? validateDemoContext({
          token,
          userId: req.user.id,
          artifactKey,
          handlerKey,
          phase
        })
        : null;
      req.demoContext = {
        token,
        artifactKey,
        handlerKey,
        phase,
        preflightRecord: context,
        validated: false
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Multer 成功后按受控服务端文件计算 SHA 并完成 preview context 校验。 */
function validateDemoPreviewUpload(req) {
  if (!req.demoContext) return null;
  if (!req.file?.path) throw badRequest('演示预演缺少受控上传文件。', { code: 'DEMO_PREVIEW_FILE_REQUIRED' });
  const uploadFileSha256 = sha256File(req.file.path);
  const context = validateDemoContext({
    token: req.demoContext.token,
    userId: req.user.id,
    artifactKey: req.demoContext.artifactKey,
    handlerKey: req.demoContext.handlerKey,
    phase: 'preview',
    uploadFileSha256
  });
  req.demoContext.uploadFileSha256 = uploadFileSha256;
  req.demoContext.record = context;
  req.demoContext.validated = true;
  return { context, uploadFileSha256 };
}

/** Preview 服务成功返回稳定 digest 后绑定 context。 */
function bindDemoPreviewResult(req, previewDigest) {
  if (!req.demoContext) return null;
  if (!req.demoContext.validated || !req.demoContext.uploadFileSha256) {
    throw new AppError('DEMO_CONTEXT_PREVIEW_NOT_VALIDATED', '演示预演 context 尚未完成文件校验。', { statusCode: 409 });
  }
  return bindDemoContextPreview({
    token: req.demoContext.token,
    userId: req.user.id,
    artifactKey: req.demoContext.artifactKey,
    handlerKey: req.demoContext.handlerKey,
    uploadFileSha256: req.demoContext.uploadFileSha256,
    previewDigest
  });
}

/** Execute 服务成功后将 context 标记为一次性已执行。 */
function markDemoExecuteResult(req, binding) {
  if (!req.demoContext) return null;
  return markDemoContextExecuted({
    token: req.demoContext.token,
    userId: req.user.id,
    artifactKey: req.demoContext.artifactKey,
    handlerKey: req.demoContext.handlerKey,
    uploadFileSha256: binding.uploadFileSha256,
    previewDigest: binding.previewDigest
  });
}

module.exports = {
  DEMO_CONTEXT_HEADER,
  bindDemoPreviewResult,
  demoContextPreflight,
  markDemoExecuteResult,
  readRawDemoContextHeader,
  rejectUnconnectedDemoContext,
  validateDemoPreviewUpload
};
