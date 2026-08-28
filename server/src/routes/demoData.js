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
const {
  getOrCreateActiveDemoDatasetRun,
  assertDemoRuntimeEnabled,
  getReadableDemoOwnershipSummary,
  readActiveDemoDatasetRunProjection,
  readDemoDatasetRunProjection
} = require('../services/demoRunService');
const { cleanupUploadedImportFile, normalizeUploadError, uploadImportFile } = require('../middleware/upload');
const { readRawDemoContextHeader } = require('../middleware/demoContext');
const {
  reassociateDemoContext,
  validateDemoContextReassociateCandidate,
  validateDemoContextReassociateUpload
} = require('../services/demoContextService');
const { getDemoOwnershipSummary } = require('../services/demoOwnershipService');
const {
  executeDemoCleanup,
  getDemoCleanupRunStatus,
  previewDemoCleanup
} = require('../services/demoCleanupService');
const {
  executeDemoPostAction,
  getDemoPostActionRegistry,
  getDemoPostActionStatus,
  previewDemoPostAction
} = require('../services/demoPostActionService');
const { requireDemoPostAction } = require('../services/demoPostActionRegistry');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');
const { AppError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// 演示数据治理路由提供运行期、context、只读 ownership 汇总和静态白名单清理闭环。
const router = express.Router();

// allowedActions 只反映当前用户 RBAC 授权，绝不把服务端 capability 当作用户权限。
const DEMO_ACTION_PERMISSIONS = Object.freeze({
  toggleRuntime: 'system:demo:toggle',
  loadCatalog: 'system:demo:download',
  prepareRun: 'system:demo:download',
  downloadArtifacts: 'system:demo:download',
  reassociateContext: 'system:demo:download',
  readOwnershipSummary: 'system:demo:view',
  previewCleanup: 'system:demo:cleanup:preview',
  executeCleanup: 'system:demo:cleanup:execute',
  readCleanupRunStatus: 'system:demo:view'
});

/** 按真实服务端 RBAC 计算状态页 allowedActions，不读取或改写任何业务状态。 */
function getDemoAllowedActions(userId) {
  const permissions = new Set(getUserPermissions(userId));
  const superAdmin = isSuperAdmin(userId);
  return Object.fromEntries(Object.entries(DEMO_ACTION_PERMISSIONS).map(([action, permission]) => [
    action,
    superAdmin || permissions.has(permission)
  ]));
}

/** 按 URL 中的 actionKey 读取正式权限，再交给统一 RBAC 中间件校验。 */
function requirePostActionPermission(permissionField) {
  return (req, res, next) => {
    try {
      const definition = requireDemoPostAction(req.params.actionKey);
      requirePermission(definition[permissionField])(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/** execute 路径不接受 actionKey，先按 actor 安全读取运行记录再校验正式执行权限。 */
function requirePostActionRunExecutePermission(req, res, next) {
  try {
    const run = getDemoPostActionStatus({ actionRunId: req.params.actionRunId, actorUserId: req.user.id });
    const definition = requireDemoPostAction(run.actionKey);
    requirePermission(definition.executePermission)(req, res, next);
  } catch (error) {
    next(error);
  }
}

/** 读取 active run 投影失败时保持状态接口可读且 fail-closed。 */
function buildUnavailableActiveRunProjection() {
  return {
    activeRun: null,
    compatibility: {
      readable: false,
      readOnly: true,
      writeEligible: false,
      state: 'unavailable',
      code: 'DEMO_ACTIVE_RUN_PROJECTION_UNAVAILABLE',
      manifestCompatible: false,
      historical: false,
      active: false
    }
  };
}

/**
 * 组合运行期状态、固定确认文本、能力声明、active run 只读投影和真实 RBAC 动作。
 * @param {number} userId 当前认证用户主键。
 * @returns {object} 演示数据治理基础状态。
 */
function buildDemoStatusPayload(userId) {
  let activeRunProjection;
  try {
    activeRunProjection = readActiveDemoDatasetRunProjection();
  } catch (_error) {
    activeRunProjection = buildUnavailableActiveRunProjection();
  }
  return {
    runtime: getDemoRuntimeStatus(),
    confirmationTexts: getDemoConfirmationTexts(),
    capabilities: getDemoCapabilities(),
    allowedActions: getDemoAllowedActions(userId),
    activeRun: activeRunProjection.activeRun,
    activeRunCompatibility: activeRunProjection.compatibility
  };
}

router.get('/status', authenticate, requirePermission('system:demo:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, buildDemoStatusPayload(req.user.id));
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
  // catalog 只读取当前 run 投影，旧 manifest 冲突不得阻断当前 manifest/artifact 清单。
  const runProjection = readActiveDemoDatasetRunProjection();
  sendSuccess(res, {
    ...manifest,
    artifacts,
    artifactCount: artifacts.length,
    run: runProjection.activeRun,
    activeRunCompatibility: runProjection.compatibility
  });
}));

router.post('/run', authenticate, requirePermission('system:demo:download'), requireWritable('system:demo:download'), asyncHandler(async (req, res) => {
  sendSuccess(res, getOrCreateActiveDemoDatasetRun({ actorUserId: req.user.id }));
}));

router.get('/post-actions', authenticate, requirePermission('system:demo:view'), asyncHandler(async (_req, res) => {
  sendSuccess(res, getDemoPostActionRegistry());
}));

router.post('/runs/:runId/post-actions/:actionKey/preview', authenticate, requirePermission('system:demo:download'), requirePostActionPermission('previewPermission'), requireWritable('system:demo:post-action:preview'), asyncHandler(async (req, res) => {
  sendSuccess(res, previewDemoPostAction({
    runId: req.params.runId,
    actionKey: req.params.actionKey,
    body: req.body,
    actorUserId: req.user.id,
    actorIp: req.ip
  }));
}));

router.post('/post-action-runs/:actionRunId/execute', authenticate, requirePermission('system:demo:download'), requirePostActionRunExecutePermission, requireWritable('system:demo:post-action:execute'), asyncHandler(async (req, res) => {
  sendSuccess(res, executeDemoPostAction({
    actionRunId: req.params.actionRunId,
    body: req.body,
    actorUserId: req.user.id,
    actorIp: req.ip
  }));
}));

router.get('/post-action-runs/:actionRunId', authenticate, requirePermission('system:demo:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, getDemoPostActionStatus({ actionRunId: req.params.actionRunId, actorUserId: req.user.id }));
}));

router.get('/runs/:runId/ownership-summary', authenticate, requirePermission('system:demo:view'), asyncHandler(async (req, res) => {
  try {
    sendSuccess(res, getDemoOwnershipSummary({ runId: req.params.runId }));
  } catch (error) {
    // 历史或 manifest 冲突 run 只读可见，但不得降级为任何 context/ownership 写入资格。
    if (error?.code !== 'DEMO_RUN_INVALID') throw error;
    const projection = readDemoDatasetRunProjection({ runId: req.params.runId });
    if (!projection.compatibility.readable || projection.compatibility.writeEligible) throw error;
    sendSuccess(res, getReadableDemoOwnershipSummary({ runId: req.params.runId }));
  }
}));

router.post('/cleanup/preview', authenticate, requirePermission('system:demo:cleanup:preview'), requireWritable('system:demo:cleanup:preview'), asyncHandler(async (req, res) => {
  sendSuccess(res, previewDemoCleanup({
    runId: req.body && req.body.runId,
    clientRequestId: req.body && req.body.clientRequestId,
    actorUserId: req.user.id,
    actorIp: req.ip
  }));
}));

router.post('/cleanup/execute', authenticate, requirePermission('system:demo:cleanup:execute'), requireWritable('system:demo:cleanup:execute'), asyncHandler(async (req, res) => {
  sendSuccess(res, executeDemoCleanup({
    cleanupRunId: req.body && req.body.cleanupRunId,
    clientRequestId: req.body && req.body.clientRequestId,
    previewDigest: req.body && req.body.previewDigest,
    confirmationText: req.body && (req.body.confirmationText ?? req.body.confirmText),
    actorUserId: req.user.id,
    actorIp: req.ip
  }));
}));

router.get('/cleanup-runs/:cleanupRunId', authenticate, requirePermission('system:demo:view'), asyncHandler(async (req, res) => {
  sendSuccess(res, getDemoCleanupRunStatus({ cleanupRunId: req.params.cleanupRunId }));
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
