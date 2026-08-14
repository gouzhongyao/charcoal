const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const {
  getDemoCapabilities,
  getDemoConfirmationTexts,
  getDemoRuntimeStatus,
  toggleDemoRuntime
} = require('../services/demoRuntimeService');
const { getDemoParkManifest } = require('../services/demoParkDatasetService');
const { getOrCreateActiveDemoDatasetRun, assertDemoRuntimeEnabled } = require('../services/demoRunService');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { readRawDemoContextHeader } = require('../middleware/demoContext');
const {
  reassociateDemoContext,
  validateDemoContextReassociateCandidate,
  validateDemoContextReassociateUpload
} = require('../services/demoContextService');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');
const { AppError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 演示数据治理路由提供阶段 2 catalog/run/context 基础，不接入阶段 3 ownership。
const router = express.Router();

/**
 * 组合运行期状态、固定确认文本和基础能力声明。
 * @returns {object} 演示数据治理基础状态。
 */
function buildDemoStatusPayload() {
  return {
    runtime: getDemoRuntimeStatus(),
    confirmationTexts: getDemoConfirmationTexts(),
    capabilities: getDemoCapabilities()
  };
}

router.get('/status', authenticate, requirePermission('system:demo:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, buildDemoStatusPayload());
}));

router.post('/toggle', authenticate, requirePermission('system:demo:toggle'), requireWritable('system:demo:toggle'), asyncHandler(async (req, res) => {
  const runtime = toggleDemoRuntime({
    enabled: req.body && req.body.enabled,
    actorUserId: req.user.id,
    actorIp: req.ip
  });
  sendSuccess(res, {
    runtime,
    confirmationTexts: getDemoConfirmationTexts(),
    capabilities: getDemoCapabilities()
  });
}));

router.get('/catalog', authenticate, requirePermission('system:demo:download'), asyncHandler(async (req, res) => {
  assertDemoRuntimeEnabled();
  const manifest = getDemoParkManifest();
  const permissions = new Set(getUserPermissions(req.user.id));
  const superAdmin = isSuperAdmin(req.user.id);
  const artifacts = manifest.artifacts.filter((artifact) => (
    superAdmin || permissions.has(artifact.permissions.download)
  ));
  const run = getOrCreateActiveDemoDatasetRun({ actorUserId: req.user.id });
  sendSuccess(res, { ...manifest, artifacts, artifactCount: artifacts.length, run });
}));

router.post('/run', authenticate, requirePermission('system:demo:download'), requireWritable('system:demo:download'), asyncHandler(async (req, res) => {
  sendSuccess(res, getOrCreateActiveDemoDatasetRun({ actorUserId: req.user.id }));
}));

router.post('/contexts/reassociate', authenticate, requirePermission('system:demo:download'), requireWritable('system:demo:download'), asyncHandler(async () => {
  throw new AppError(
    'DEMO_CONTEXT_REASSOCIATE_PREFLIGHT_REQUIRED',
    '重新关联必须通过携带受控文件的预检接口。',
    { statusCode: 409 }
  );
}));

/** 受控上传预检并重新关联过期 context；旧 token 只允许位于唯一请求头。 */
router.post('/contexts/reassociate/:artifactKey/:handlerKey', authenticate, requirePermission('system:demo:download'), requireWritable('system:demo:download'), (req, res, next) => {
  let token;
  try {
    token = readRawDemoContextHeader(req);
    if (!token) {
      throw new AppError('DEMO_CONTEXT_REQUIRED', '重新关联必须携带唯一 X-Demo-Context 请求头。', { statusCode: 400 });
    }
    validateDemoContextReassociateCandidate({
      token,
      userId: req.user.id,
      artifactKey: req.params.artifactKey,
      handlerKey: req.params.handlerKey
    });
  } catch (error) {
    next(error);
    return;
  }
  uploadImportFile(req, res, (uploadError) => {
    const normalizedUploadError = normalizeUploadError(uploadError);
    if (normalizedUploadError) {
      cleanupUploadedImportFile(req.file);
      next(normalizedUploadError);
      return;
    }
    Promise.resolve().then(() => {
      if (!req.file?.path) {
        throw new AppError('DEMO_CONTEXT_REASSOCIATE_FILE_REQUIRED', '重新关联必须上传一个受控文件。', { statusCode: 400 });
      }
      const preflight = validateDemoContextReassociateUpload({
        artifactKey: req.params.artifactKey,
        handlerKey: req.params.handlerKey,
        filePath: req.file.path,
        originalFilename: req.file.originalname
      });
      const result = reassociateDemoContext({
        token,
        userId: req.user.id,
        artifactKey: req.params.artifactKey,
        handlerKey: req.params.handlerKey,
        preflightWitness: preflight.witness
      });
      res.setHeader('X-Demo-Context', result.token);
      sendSuccess(res, {
        contextId: result.contextId,
        runId: result.runId,
        datasetId: result.datasetId,
        manifestVersion: result.manifestVersion,
        manifestDigest: result.manifestDigest,
        artifactKey: result.artifactKey,
        handlerKey: result.handlerKey,
        artifactFileSha256: result.artifactFileSha256,
        uploadFileSha256: result.uploadFileSha256,
        issuedAt: result.issuedAt,
        expiresAt: result.expiresAt
      });
    }).catch(next).finally(() => cleanupUploadedImportFile(req.file));
  });
});

module.exports = router;
