const express = require('express');
const { openDatabase } = require('../db/database');
const {
  TEMPLATE_REQUIRED_PERMISSIONS,
  listTemplates,
  getTemplateCsv,
  getTemplateXlsx
} = require('../services/templateService');
const {
  generateDemoParkArtifact,
  getDemoParkArtifact,
  getDemoParkManifest,
  listDemoParkArtifacts
} = require('../services/demoParkDatasetService');
const {
  DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES,
  getDemoArtifactRegistration
} = require('../services/demoArtifactRegistry');
const { createDemoContext, revokeDemoContext, sha256Buffer } = require('../services/demoContextService');
const {
  assertDemoRuntimeEnabled,
  getOrCreateActiveDemoDatasetRun,
  readActiveDemoDatasetRunProjection
} = require('../services/demoRunService');
const { sendSuccess } = require('../utils/response');
const { AppError, notFound } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireWritable } = require('../middleware/maintenance');
const { requirePermission } = require('../middleware/permission');
const { getUserPermissions, isSuperAdmin } = require('../services/authService');

const router = express.Router();

function buildContentDisposition(fileName, fallbackName) {
  const fallback = String(fallbackName || fileName).replace(/[^A-Za-z0-9._-]+/g, '-') || 'yewu-template.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// 受保护模板统一复用中央服务的领域预演或导入权限映射，避免路由和元数据漂移。
const PROTECTED_TEMPLATE_PERMISSIONS = TEMPLATE_REQUIRED_PERMISSIONS;

// 模板路由为不支持 filename* 的旧客户端提供唯一且可辨识的拼音业务文件名。
const TEMPLATE_ASCII_NAMES = Object.freeze({
  'energy-budgets': 'yongneng-yusuan-template',
  'energy-records': 'nenghao-jilu-template',
  'meter-readings': 'jiliang-chaobiao-template',
  'production-units': 'channeng-danyuan-template',
  'production-outputs': 'yuedu-chanliang-template',
  suppliers: 'gongyingshang-template',
  'generation-records': 'fadian-ziyong-template',
  'organization-units': 'yongneng-danyuan-template',
  meters: 'jiliang-qiju-template',
  'carbon-factors': 'tan-yinzi-template',
  'carbon-activities': 'carbon-activities',
  'carbon-emission-report': 'carbon-emission-report',
  'ghg-report': 'ghg-report',
  'prediction-configs': 'yuce-peizhi-template',
  'prediction-history': 'yuce-lishi-template'
});

/** 返回模板对应的稳定 ASCII 业务文件名。 */
function getTemplateAsciiName(templateType) {
  return TEMPLATE_ASCII_NAMES[templateType] || 'yewu-template';
}

/** 优先使用模板服务返回的 ASCII fallback，历史模板继续使用既有拼音映射。 */
function getTemplateAsciiFileName(result, extension) {
  return result.asciiFileName || `${getTemplateAsciiName(result.template.type)}.${extension}`;
}

/** 严格规范化路由模板 ID，拒绝点号、额外扩展名和其他非 ID 字符。 */
function normalizeRouteTemplateType(templateType) {
  const rawTemplateType = String(templateType || '');
  return /^[A-Za-z0-9-]+$/.test(rawTemplateType)
    ? rawTemplateType.toLowerCase()
    : null;
}

function templateNotFound(req, next) {
  next(notFound('导入模板不存在', {
    templateType: req.params.templateType,
    supportedTemplateTypes: listTemplates().map((template) => template.type)
  }));
}

function requireTemplateDownloadPermission(req, res, next) {
  const templateType = normalizeRouteTemplateType(req.params.templateType);
  if (!templateType) {
    templateNotFound(req, next);
    return;
  }

  // 后续权限判断与模板生成必须复用同一个严格规范化值。
  req.normalizedTemplateType = templateType;
  const permission = Object.prototype.hasOwnProperty.call(PROTECTED_TEMPLATE_PERMISSIONS, templateType)
    ? PROTECTED_TEMPLATE_PERMISSIONS[templateType]
    : null;
  if (!permission) {
    next('route');
    return;
  }

  authenticate(req, res, (authenticationError) => {
    if (authenticationError) {
      next(authenticationError);
      return;
    }
    requirePermission(permission)(req, res, next);
  });
}

/** 判断注册项是否只生成文件并沿正式无 context 导入链路继续处理。 */
function isStatelessDemoArtifact(registration) {
  return registration?.downloadLifecycle === DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.STATELESS_FORMAL_IMPORT;
}

/** 判断注册项是否需要在已开启 runtime 下复用 active run 并签发一次性 context。 */
function isManagedDemoArtifact(registration) {
  return registration?.downloadLifecycle === DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME;
}

/** 未知下载生命周期必须 fail-closed，避免新 registry 项被静默降级为无状态文件。 */
function assertSupportedDemoDownloadLifecycle(registration) {
  if (!isStatelessDemoArtifact(registration) && !isManagedDemoArtifact(registration)) {
    throw new AppError('DEMO_ARTIFACT_DOWNLOAD_LIFECYCLE_INVALID', '演示 artifact 下载生命周期未受服务端支持。', {
      statusCode: 500,
      details: { artifactKey: registration?.artifactKey || null }
    });
  }
}

/** 演示 artifact 下载必须同时通过系统演示权限和真实领域权限；托管下载额外受维护态保护。 */
function requireDemoParkArtifactPermission(req, res, next) {
  const artifactKey = normalizeRouteTemplateType(req.params.artifactKey);
  const artifact = getDemoParkArtifact(artifactKey);
  const registration = getDemoArtifactRegistration(artifactKey);
  if (!artifact || !registration) {
    next(notFound('演示数据文件不存在', {
      artifactKey: req.params.artifactKey,
      supportedArtifactKeys: listDemoParkArtifacts().map((item) => item.artifactKey)
    }));
    return;
  }
  try {
    assertSupportedDemoDownloadLifecycle(registration);
  } catch (error) {
    next(error);
    return;
  }
  req.demoParkArtifact = artifact;
  req.demoArtifactRegistration = registration;
  authenticate(req, res, (authenticationError) => {
    if (authenticationError) {
      next(authenticationError);
      return;
    }
    requirePermission('system:demo:download', registration.permissions.download)(req, res, (permissionError) => {
      if (permissionError) {
        next(permissionError);
        return;
      }
      try {
        // 演示开关是独立业务边界，普通用户和超级管理员都必须先由显式 toggle 开启。
        assertDemoRuntimeEnabled();
      } catch (runtimeError) {
        next(runtimeError);
        return;
      }
      if (isStatelessDemoArtifact(registration)) {
        next();
        return;
      }
      requireWritable('system:demo:managed-download')(req, res, next);
    });
  });
}

/** 设置天坤集团示例文件的公共下载响应头，不包含任何运行期或 context 状态。 */
function setDemoParkArtifactFileHeaders(res, result) {
  res.setHeader('Content-Type', result.mimeType);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, result.asciiFileName));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Recommended-Format', 'xlsx');
}

/** 在同一 immediate 事务中校验已开启 runtime，并准备 active run 与下载 context。 */
function prepareManagedDemoArtifactDownload(req, result) {
  const db = openDatabase();
  try {
    return db.transaction(() => {
      const runtime = assertDemoRuntimeEnabled({ db });
      const run = getOrCreateActiveDemoDatasetRun({ actorUserId: req.user.id, actorIp: req.ip, db });
      const context = createDemoContext({
        userId: req.user.id,
        runId: run.runId,
        artifactKey: result.artifact.artifactKey,
        handlerKey: req.demoArtifactRegistration.handlerKey,
        artifactFileSha256: sha256Buffer(result.buffer),
        db
      });
      return { runtime, run, context };
    }).immediate();
  } finally {
    db.close();
  }
}

/** 按 registry 生命周期发送无状态文件或签发托管 context 的演示文件。 */
function sendDemoParkArtifact(req, res, next, format) {
  const result = generateDemoParkArtifact(req.demoParkArtifact.artifactKey, format);
  if (!result) {
    next(notFound('演示数据文件不存在', { artifactKey: req.params.artifactKey }));
    return;
  }
  if (isStatelessDemoArtifact(req.demoArtifactRegistration)) {
    try {
      setDemoParkArtifactFileHeaders(res, result);
      res.status(200).send(result.buffer);
    } catch (error) {
      next(error);
    }
    return;
  }

  let context;
  try {
    ({ context } = prepareManagedDemoArtifactDownload(req, result));
  } catch (error) {
    next(error);
    return;
  }
  let responseCompleted = false;
  const revokeIfSendFailed = () => {
    if (responseCompleted || res.writableFinished) return;
    try {
      revokeDemoContext({ token: context.token, reason: 'download_send_failed' });
    } catch (_error) {
      // 客户端已经断开时不能再改变响应；context 保持短 TTL 且 runtime epoch 可整体撤销。
    }
  };
  res.once('finish', () => { responseCompleted = true; });
  res.once('close', revokeIfSendFailed);
  res.once('error', revokeIfSendFailed);

  try {
    setDemoParkArtifactFileHeaders(res, result);
    res.setHeader('X-Demo-Dataset-Id', context.datasetId);
    res.setHeader('X-Demo-Run-Id', context.runId);
    res.setHeader('X-Demo-Artifact-Key', context.artifactKey);
    res.setHeader('X-Demo-Handler-Key', context.handlerKey);
    res.setHeader('X-Demo-Manifest-Version', context.manifestVersion);
    res.setHeader('X-Demo-Manifest-Digest', context.manifestDigest);
    res.setHeader('X-Demo-Artifact-Sha256', context.artifactFileSha256);
    res.setHeader('X-Demo-Context', context.token);
    res.status(200).send(result.buffer);
  } catch (error) {
    revokeIfSendFailed();
    next(error);
  }
}

router.get('/', (req, res) => {
  sendSuccess(res, listTemplates(), {
    meta: {
      recommendedFormat: 'xlsx',
      csvEncoding: 'UTF-8 with BOM',
      routes: [
        'GET /api/templates',
        'GET /api/templates/:templateType.xlsx',
        'GET /api/templates/:templateType.csv',
        'GET /api/templates/demo-park/manifest',
        'GET /api/templates/demo-park/:artifactKey.xlsx',
        'GET /api/templates/demo-park/:artifactKey.csv'
      ]
    }
  });
});

// 演示目录必须先于通用 :templateType 参数路由注册，避免被识别为普通模板。
router.get('/demo-park/manifest', authenticate, requirePermission('system:demo:download'), (req, res, next) => {
  try {
    assertDemoRuntimeEnabled();
    const userPermissions = new Set(getUserPermissions(req.user.id));
    const superAdmin = isSuperAdmin(req.user.id);
    const manifest = getDemoParkManifest();
    const artifacts = manifest.artifacts.filter((artifact) => (
      superAdmin || userPermissions.has(artifact.permissions.download)
    ));
    // manifest 只读取当前 run 投影，旧 manifest 冲突不得阻断当前清单和 artifact 过滤结果。
    const runProjection = readActiveDemoDatasetRunProjection();
    sendSuccess(res, {
      parkCode: 'QL-PARK',
      parkName: '天坤集团',
      datasetId: manifest.datasetId,
      manifestVersion: manifest.manifestVersion,
      canonicalizationVersion: manifest.canonicalizationVersion,
      manifestDigest: manifest.manifestDigest,
      run: runProjection.activeRun,
      activeRunCompatibility: runProjection.compatibility,
      codePrefix: manifest.codePrefix,
      sourceTimeZone: manifest.sourceTimeZone,
      artifactCount: artifacts.length,
      artifacts
    });
  } catch (error) {
    next(error);
  }
});
router.get('/demo-park/:artifactKey.xlsx', requireDemoParkArtifactPermission, (req, res, next) => {
  sendDemoParkArtifact(req, res, next, 'xlsx');
});
router.get('/demo-park/:artifactKey.csv', requireDemoParkArtifactPermission, (req, res, next) => {
  sendDemoParkArtifact(req, res, next, 'csv');
});

// 用能预算模板属于受保护业务能力；其他历史模板路由保持既有兼容性，不在本次全局改造范围内。
router.get('/energy-budgets.xlsx', authenticate, requirePermission(TEMPLATE_REQUIRED_PERMISSIONS['energy-budgets']), (req, res, next) => {
  const result = getTemplateXlsx('energy-budgets');
  if (!result) { templateNotFound(req, next); return; }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'xlsx')));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/energy-budgets.csv', authenticate, requirePermission(TEMPLATE_REQUIRED_PERMISSIONS['energy-budgets']), (req, res, next) => {
  const result = getTemplateCsv('energy-budgets');
  if (!result) { templateNotFound(req, next); return; }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'csv')));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

// 该参数化拦截器必须先于通用下载路由注册，以覆盖大小写与 URL 编码后的全部受保护模板请求。
router.get('/:templateType.xlsx', requireTemplateDownloadPermission);
router.get('/:templateType.csv', requireTemplateDownloadPermission);

router.get('/:templateType.xlsx', (req, res, next) => {
  const result = getTemplateXlsx(req.normalizedTemplateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'xlsx')));
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.buffer);
});

router.get('/:templateType.csv', (req, res, next) => {
  const result = getTemplateCsv(req.normalizedTemplateType);
  if (!result) {
    templateNotFound(req, next);
    return;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, getTemplateAsciiFileName(result, 'csv')));
  res.setHeader('Content-Length', String(Buffer.byteLength(result.csv, 'utf8')));
  res.setHeader('X-Template-Type', result.template.type);
  res.setHeader('X-Recommended-Format', 'xlsx');
  res.status(200).send(result.csv);
});

module.exports = router;
