'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// 路由测试只使用系统临时目录、隔离 SQLite 和随机端口。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-benchmark-import-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-benchmark-import-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-benchmark-import-route-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyBenchmarkImportRoutes = require('../routes/energyBenchmarkImports');
const {
  ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION,
  ENERGY_BENCHMARK_IMPORT_PERMISSIONS,
  ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION
} = energyBenchmarkImportRoutes;
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 隔离测试挂载路径；正式 server/src/index.js 按阶段要求保持未接入。
const ROUTE_BASE = '/api/energy-benchmarks/imports';
// 三类冻结模板中文表头必须与模板服务契约一致。
const FACTOR_HEADERS = Object.freeze([
  '系数编码', '能源类型编码', '源单位', '折标系数值', '目标单位', '展示单位', '展示除数',
  '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);
const DEFINITION_HEADERS = Object.freeze([
  '对标编码', '对标名称', '对标类型', '指标编码', '指标单位', '周期类型', '范围类型', '范围标识',
  '指标方向', '来源', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
]);
const TARGET_HEADERS = Object.freeze([
  '对标编码', '目标值', '下限值', '上限值', '参考期开始时间（UTC）',
  '参考期结束时间（UTC）', '固化值', '固化时间（UTC）', '样本数量', '产量摘要 JSON',
  '来源数据摘要', '是否固化', '是否自动刷新', '状态'
]);

/** 转义 CSV 单元格。 */
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 根据中文表头和数据行构造 UTF-8 BOM CSV。 */
function buildCsv(headers, rows) {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))
  ];
  return Buffer.from(`﻿${lines.join('\n')}\n`, 'utf8');
}

/** 根据冻结工作表名称、中文表头和数据行构造 XLSX。 */
function buildXlsx(sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]),
    sheetName
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 创建合法折标系数行。 */
function createFactorRow(overrides = {}) {
  return {
    系数编码: 'ROUTE-FACTOR', 能源类型编码: 'electricity', 源单位: 'kWh-route', 折标系数值: 0.1229,
    目标单位: 'kgce', 展示单位: 'tce', 展示除数: 1000, 来源: '企业能源折标制度', 文号: 'Q/ROUTE-2026',
    版本: 'route-factor:v1', '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z', 来源时区: 'Asia/Shanghai', 状态: 'active', ...overrides
  };
}

/** 创建合法对标定义行。 */
function createDefinitionRow(overrides = {}) {
  return {
    对标编码: 'ROUTE-BENCH', 对标名称: '路由单位产品能耗基准', 对标类型: 'external_standard',
    指标编码: 'energy_intensity', 指标单位: 'kgce/t', 周期类型: 'month', 范围类型: 'organization',
    范围标识: 'OU-ROUTE', 指标方向: 'lower_better', 来源: '行业标准',
    '生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '生效结束时间（UTC）': '2027-01-01T00:00:00Z', 来源时区: 'Asia/Shanghai', 状态: 'active', ...overrides
  };
}

/** 创建合法对标目标行。 */
function createTargetRow(overrides = {}) {
  return {
    对标编码: 'ROUTE-BENCH', 目标值: 120,
    下限值: '', 上限值: '', '参考期开始时间（UTC）': '', '参考期结束时间（UTC）': '', 固化值: '',
    '固化时间（UTC）': '', 样本数量: '', '产量摘要 JSON': '', 来源数据摘要: '', 是否固化: 0,
    是否自动刷新: 0, 状态: 'active', ...overrides
  };
}

/** 发起 JSON 请求并解析统一响应。 */
function requestJson(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: pathname, headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    request.on('error', reject);
    if (rawBody !== null) request.write(rawBody);
    request.end();
  });
}

/** 发起原始 JSON 请求，用于验证认证与畸形、超限解析顺序。 */
function requestRawJson(server, pathname, rawBody, token) {
  return new Promise((resolve, reject) => {
    const requestBody = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': requestBody.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    request.on('error', reject);
    request.end(requestBody);
  });
}

/** 发起单文件 multipart 请求；file=null 时发送不含文件的空表单。 */
function requestMultipart(server, pathname, file, token, fieldName = 'file') {
  return new Promise((resolve, reject) => {
    const boundary = `----energy-benchmark-route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const parts = [];
    if (file) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType || 'text/csv'}\r\n\r\n`,
        'utf8'
      ));
      parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8'));
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const requestBody = Buffer.concat(parts);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': requestBody.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    request.on('error', reject);
    request.end(requestBody);
  });
}

/** 递归列出上传目录中的文件相对路径。 */
function listUploadFiles(currentDir = process.env.UPLOADS_DIR, rootDir = process.env.UPLOADS_DIR) {
  if (!fs.existsSync(currentDir)) return [];
  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    return entry.isDirectory()
      ? listUploadFiles(absolutePath, rootDir)
      : [path.relative(rootDir, absolutePath).replace(/\\/g, '/')];
  }).sort();
}

/** 递归列出备份目录中的文件相对路径。 */
function listBackupFiles(currentDir = process.env.BACKUPS_DIR, rootDir = process.env.BACKUPS_DIR) {
  if (!fs.existsSync(currentDir)) return [];
  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    return entry.isDirectory()
      ? listBackupFiles(absolutePath, rootDir)
      : [path.relative(rootDir, absolutePath).replace(/\\/g, '/')];
  }).sort();
}

/** 断言响应或审计不含路径、密钥和原始内部异常。 */
function assertNoSensitiveData(value, label) {
  const serialized = JSON.stringify(value).replace(/\\\\/g, '\\').replace(/\\/g, '/');
  assert(!serialized.includes(tmpDir.replace(/\\/g, '/')), `${label} 不得包含临时目录。`);
  assert(!serialized.includes(process.env.UPLOADS_DIR.replace(/\\/g, '/')), `${label} 不得包含上传目录。`);
  assert(!serialized.includes(process.env.BACKUPS_DIR.replace(/\\/g, '/')), `${label} 不得包含备份目录。`);
  assert(!serialized.includes(process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET), `${label} 不得包含 HMAC 密钥。`);
  assert(!serialized.includes('SqliteError') && !serialized.includes('SQLITE_CONSTRAINT') && !serialized.includes(' at Database.'), `${label} 不得包含 SQLite 原始异常。`);
}

/** execute 客户端只提交批次 ID 与三项确认字段。 */
function createMinimalExecuteBody(preview, overrides = {}) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    ...overrides
  };
}

/** 向隔离库插入权限菜单并授予指定账号。 */
function grantPermissions(username, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    assert(user, `测试账号 ${username} 必须存在。`);
    const roleId = Number(db.prepare(
      `INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`
    ).run(`benchmark-route-${username}`, `${username} 对标导入角色`, now, now).lastInsertRowid);
    const insertMenu = db.prepare(
      `INSERT INTO sys_menus (
         menu_type, menu_name, permission_code, sort_order, visible, status, is_builtin, created_at, updated_at
       ) VALUES ('button', ?, ?, 0, 0, 'active', 0, ?, ?)
       ON CONFLICT(permission_code) DO NOTHING`
    );
    permissionCodes.forEach((permissionCode) => {
      insertMenu.run(permissionCode, permissionCode, now, now);
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)').run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

/** 初始化对标范围与内部历史伪造测试所需主数据。 */
function seedMasterData() {
  const db = openDatabase();
  try {
    db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('OU-ROUTE', '路由测试车间', '/OU-ROUTE', 'workshop', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO benchmark_definitions (
         benchmark_code, benchmark_name, benchmark_type, metric_code, unit, period_type,
         scope_type, scope_reference, direction, source, version, internal_revision,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES (
         'ROUTE-INTERNAL', '内部历史基准', 'internal_history_baseline', 'energy_intensity', 'kgce/t', 'month',
         'organization', 'OU-ROUTE', 'lower_better', '内部计算', 'route-internal:v1', 1,
         '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active'
       )`
    ).run();
  } finally {
    db.close();
  }
}

/** 创建并启动只挂载当前独立路由的隔离 Express 应用。 */
async function startIsolatedServer() {
  const app = express();
  // 冻结阶段 8 挂载顺序：对标导入 router 必须先于全局 JSON parser，确保认证先于请求体解析。
  app.use(ROUTE_BASE, energyBenchmarkImportRoutes);
  app.use(express.json({ limit: '2mb' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 校验成功 preview 响应并返回领域数据。 */
function assertSuccessfulPreview(response, expectedImportType, expectedTemplateType) {
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.success, true);
  assert.strictEqual(response.body.data.summary.wouldImport, 1);
  assert.strictEqual(response.body.data.auditBatch.importType, expectedImportType);
  assert.strictEqual(response.body.data.auditBatch.auditPhase, 'preview');
  assert.strictEqual(response.body.data.templateType, expectedTemplateType);
  assertNoSensitiveData(response.body, `${expectedTemplateType} preview 响应`);
  return response.body.data;
}

/** 校验认证、独立权限、维护态顺序，并确认维护态 preview 不落盘。 */
async function testPermissionAndMaintenanceBoundaries(server, tokens) {
  const previewPath = `${ROUTE_BASE}/conversion-factors/preview`;
  const executePath = `${ROUTE_BASE}/conversion-factors/execute`;
  const file = { filename: 'permission-factor.csv', content: buildCsv(FACTOR_HEADERS, [createFactorRow({ 系数编码: 'PERMISSION-FACTOR' })]) };
  const beforeFiles = listUploadFiles();

  await runWithMaintenance('benchmark-route-maintenance', async () => {
    const anonymousPreview = await requestMultipart(server, previewPath, file, null);
    assert.strictEqual(anonymousPreview.status, 401);
    assert.strictEqual(anonymousPreview.body.error.code, 'UNAUTHENTICATED');
    const anonymousExecute = await requestJson(server, 'POST', executePath, {}, null);
    assert.strictEqual(anonymousExecute.status, 401);

    const deniedPreview = await requestMultipart(server, previewPath, file, tokens.denied);
    assert.strictEqual(deniedPreview.status, 403);
    assert.strictEqual(deniedPreview.body.error.code, 'FORBIDDEN');
    const deniedExecute = await requestJson(server, 'POST', executePath, {}, tokens.denied);
    assert.strictEqual(deniedExecute.status, 403);

    const previewOnlyExecute = await requestJson(server, 'POST', executePath, {}, tokens.previewOnly);
    assert.strictEqual(previewOnlyExecute.status, 403, '仅预演权限不得执行。');
    const executeOnlyPreview = await requestMultipart(server, previewPath, file, tokens.executeOnly);
    assert.strictEqual(executeOnlyPreview.status, 403, '仅执行权限不得预演。');

    const maintenancePreview = await requestMultipart(server, previewPath, file, tokens.full);
    assert.strictEqual(maintenancePreview.status, 423);
    assert.strictEqual(maintenancePreview.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    const maintenanceExecute = await requestJson(server, 'POST', executePath, {}, tokens.full);
    assert.strictEqual(maintenanceExecute.status, 423);
    assert.strictEqual(maintenanceExecute.body.error.code, 'MAINTENANCE_IN_PROGRESS');
  });

  assert.deepStrictEqual(listUploadFiles(), beforeFiles, '401/403/423 preview 均不得触发上传落盘。');
}

/** 校验三个 execute 均在认证、权限和维护态之后才解析受限 JSON。 */
async function testExecuteJsonAuthenticationOrder(server, tokens) {
  const executePaths = [
    `${ROUTE_BASE}/conversion-factors/execute`,
    `${ROUTE_BASE}/definitions/execute`,
    `${ROUTE_BASE}/targets/execute`
  ];
  const malformedBody = '{"batchId":';
  const oversizedBody = JSON.stringify({ padding: 'x'.repeat(72 * 1024) });

  for (const executePath of executePaths) {
    const anonymousValid = await requestRawJson(server, executePath, '{}', null);
    assert.strictEqual(anonymousValid.status, 401, `${executePath} 匿名合法 JSON 必须先返回 401。`);
    assert.strictEqual(anonymousValid.body.error.code, 'UNAUTHENTICATED');

    const anonymousMalformed = await requestRawJson(server, executePath, malformedBody, null);
    assert.strictEqual(anonymousMalformed.status, 401, `${executePath} 匿名畸形 JSON 必须先返回 401。`);
    assert.strictEqual(anonymousMalformed.body.error.code, 'UNAUTHENTICATED');

    const anonymousOversized = await requestRawJson(server, executePath, oversizedBody, null);
    assert.strictEqual(anonymousOversized.status, 401, `${executePath} 匿名超限 JSON 必须先返回 401。`);
    assert.strictEqual(anonymousOversized.body.error.code, 'UNAUTHENTICATED');

    const authorizedMalformed = await requestRawJson(server, executePath, malformedBody, tokens.full);
    assert.strictEqual(authorizedMalformed.status, 400, `${executePath} 授权畸形 JSON 必须返回 400。`);
    assert.strictEqual(authorizedMalformed.body.error.code, 'BAD_REQUEST');
    assert.strictEqual(authorizedMalformed.body.error.details.code, 'ENERGY_BENCHMARK_IMPORT_JSON_INVALID');

    const authorizedOversized = await requestRawJson(server, executePath, oversizedBody, tokens.full);
    assert.strictEqual(authorizedOversized.status, 413, `${executePath} 授权超限 JSON 必须返回 413。`);
    assert.strictEqual(authorizedOversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');
    assert.strictEqual(authorizedOversized.body.error.details.code, 'ENERGY_BENCHMARK_IMPORT_JSON_TOO_LARGE');
    assert.strictEqual(authorizedOversized.body.error.details.maxBodyBytes, 64 * 1024);

    [anonymousValid, anonymousMalformed, anonymousOversized, authorizedMalformed, authorizedOversized]
      .forEach((response, index) => assertNoSensitiveData(response.body, `${executePath} JSON 顺序响应 ${index}`));
  }
}

/** 校验三类正常 preview/execute、原文件保留、最小 execute body 和审计来源。 */
async function testSuccessfulImports(server, adminToken) {
  const factorBefore = listUploadFiles().length;
  const factorPreview = assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/conversion-factors/preview`, {
    filename: 'factor-normal.csv', content: buildCsv(FACTOR_HEADERS, [createFactorRow()])
  }, adminToken), 'energy_conversion_factor', 'energy-conversion-factors');
  assert.strictEqual(listUploadFiles().length, factorBefore + 1, '折标系数成功 preview 必须保留原文件。');
  const factorExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(factorPreview), adminToken
  );
  assert.strictEqual(factorExecute.status, 200);
  assert.strictEqual(factorExecute.body.data.imported, 1);

  const definitionBefore = listUploadFiles().length;
  const definitionPreview = assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/definitions/preview`, {
    filename: 'definition-normal.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: buildXlsx('对标定义', DEFINITION_HEADERS, [createDefinitionRow()])
  }, adminToken), 'energy_benchmark', 'energy-benchmark-definitions');
  assert.strictEqual(listUploadFiles().length, definitionBefore + 1, '对标定义成功 preview 必须保留原文件。');
  const definitionExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/definitions/execute`, createMinimalExecuteBody(definitionPreview), adminToken
  );
  assert.strictEqual(definitionExecute.status, 200);
  assert.strictEqual(definitionExecute.body.data.imported, 1);

  const targetBefore = listUploadFiles().length;
  const targetPreview = assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/targets/preview`, {
    filename: 'target-normal.csv', content: buildCsv(TARGET_HEADERS, [createTargetRow()])
  }, adminToken), 'energy_benchmark', 'energy-benchmark-targets');
  assert.strictEqual(listUploadFiles().length, targetBefore + 1, '对标目标成功 preview 必须保留原文件。');
  const targetExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/targets/execute`, createMinimalExecuteBody(targetPreview), adminToken
  );
  assert.strictEqual(targetExecute.status, 200);
  assert.strictEqual(targetExecute.body.data.imported, 1);

  const db = openDatabase();
  try {
    const factor = db.prepare("SELECT source_batch_id AS batchId FROM energy_conversion_factors WHERE factor_code = 'ROUTE-FACTOR'").get();
    const definition = db.prepare(
      "SELECT id, source_batch_id AS batchId, version, internal_revision AS internalRevision FROM benchmark_definitions WHERE benchmark_code = 'ROUTE-BENCH'"
    ).get();
    const target = db.prepare(
      `SELECT source_batch_id AS batchId, version, internal_revision AS internalRevision
       FROM benchmark_targets
       WHERE benchmark_definition_id = ? AND source_batch_id = ?`
    ).get(definition.id, targetPreview.batchId);
    assert.deepStrictEqual(factor, { batchId: factorPreview.batchId });
    assert.deepStrictEqual(definition, {
      id: definition.id,
      batchId: definitionPreview.batchId,
      version: 'benchmark-definition-internal-revision:v1',
      internalRevision: 1
    });
    assert.deepStrictEqual(target, {
      batchId: targetPreview.batchId,
      version: 'benchmark-target-internal-revision:v1',
      internalRevision: 1
    });
    [factorPreview, definitionPreview, targetPreview].forEach((preview) => {
      const audit = getImportAuditBatchDetail(preview.batchId, { db });
      assert.strictEqual(audit.auditPhase, 'execute');
      assert.strictEqual(audit.status, 'completed');
      assert.strictEqual(audit.executeResult.imported, 1);
      assert.strictEqual(audit.backup.reason, 'energy-analysis-import');
      assertNoSensitiveData(audit, `成功批次 ${preview.batchId} 审计`);
    });
    assertNoSensitiveData(factorExecute.body, '折标 execute 响应');
    assertNoSensitiveData(definitionExecute.body, '定义 execute 响应');
    assertNoSensitiveData(targetExecute.body, '目标 execute 响应');
  } finally {
    db.close();
  }
}

/** 校验上传、格式和领域解析失败会清理当前文件，且严格拒绝 XLS。 */
async function testUploadFailureCleanup(server, adminToken) {
  const previewPath = `${ROUTE_BASE}/conversion-factors/preview`;
  const cases = [
    {
      name: '缺文件', file: null, expectedTopCode: 'BAD_REQUEST', expectedDetailCode: 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED'
    },
    {
      name: '错误字段', file: { filename: 'wrong-field.csv', content: buildCsv(FACTOR_HEADERS, [createFactorRow()]) },
      fieldName: 'upload', expectedTopCode: 'IMPORT_UPLOAD_FAILED'
    },
    {
      name: '错误扩展名', file: { filename: 'wrong-extension.txt', content: 'not allowed', mimeType: 'text/plain' },
      expectedTopCode: 'UNSUPPORTED_IMPORT_FILE_TYPE'
    },
    {
      name: '伪装 XLSX',
      file: { filename: 'disguised.xlsx', content: 'not a real xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      expectedTopCode: 'BAD_REQUEST', expectedDetailCode: 'INVALID_TEMPLATE_WORKBOOK_FORMAT'
    },
    {
      name: '严格拒绝 XLS',
      file: { filename: 'legacy.xls', content: Buffer.from('legacy-xls', 'utf8'), mimeType: 'application/vnd.ms-excel' },
      expectedTopCode: 'BAD_REQUEST', expectedDetailCode: 'TEMPLATE_FORMAT_UNSUPPORTED'
    },
    {
      name: '文件过大', file: { filename: 'too-large.csv', content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) },
      expectedTopCode: 'IMPORT_FILE_TOO_LARGE'
    }
  ];

  for (const testCase of cases) {
    const beforeFiles = listUploadFiles();
    const response = await requestMultipart(server, previewPath, testCase.file, adminToken, testCase.fieldName || 'file');
    assert.strictEqual(response.status, 400, `${testCase.name} 必须返回 400。`);
    assert.strictEqual(response.body.error.code, testCase.expectedTopCode, `${testCase.name} 顶层错误码必须稳定。`);
    if (testCase.expectedDetailCode) {
      assert.strictEqual(response.body.error.details.code, testCase.expectedDetailCode, `${testCase.name} 领域错误码必须稳定。`);
    }
    assert.deepStrictEqual(listUploadFiles(), beforeFiles, `${testCase.name} 后不得残留当前上传文件。`);
    assertNoSensitiveData(response.body, `${testCase.name} 错误响应`);
  }
}

/** 创建指定类型的唯一 preview，供安全与串用测试复用。 */
async function createPreview(server, adminToken, type, suffix) {
  const unique = String(suffix).replace(/[^A-Za-z0-9-]+/g, '-');
  if (type === 'factor') {
    return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/conversion-factors/preview`, {
      filename: `factor-${unique}.csv`, content: buildCsv(FACTOR_HEADERS, [createFactorRow({
        系数编码: `FACTOR-${unique}`, 源单位: `unit-${unique}`, 版本: `factor-${unique.toLowerCase()}:v1`,
        '生效开始时间（UTC）': '2028-01-01T00:00:00Z', '生效结束时间（UTC）': '2029-01-01T00:00:00Z'
      })])
    }, adminToken), 'energy_conversion_factor', 'energy-conversion-factors');
  }
  if (type === 'definition') {
    return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/definitions/preview`, {
      filename: `definition-${unique}.csv`, content: buildCsv(DEFINITION_HEADERS, [createDefinitionRow({
        对标编码: `BENCH-${unique}`, 对标名称: `对标定义 ${unique}`,
        '生效开始时间（UTC）': '2028-01-01T00:00:00Z', '生效结束时间（UTC）': '2029-01-01T00:00:00Z'
      })])
    }, adminToken), 'energy_benchmark', 'energy-benchmark-definitions');
  }
  return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/targets/preview`, {
    filename: `target-${unique}.csv`, content: buildCsv(TARGET_HEADERS, [createTargetRow({
      目标值: 130 + unique.length
    })])
  }, adminToken), 'energy_benchmark', 'energy-benchmark-targets');
}

/** 校验 definitions/targets 共用 importType 时仍双向防串用，且错误请求后正确路由可成功。 */
async function testDefinitionTargetRouteIsolation(server, adminToken) {
  const definitionPreview = await createPreview(server, adminToken, 'definition', 'cross');
  const wrongDefinitionResponse = await requestJson(server, 'POST', `${ROUTE_BASE}/targets/execute`, createMinimalExecuteBody(definitionPreview, {
    confirmText: '确认导入能效对标目标'
  }), adminToken);
  assert.strictEqual(wrongDefinitionResponse.status, 400);
  assert(/^ENERGY_ANALYSIS_/.test(wrongDefinitionResponse.body.error.details.code));

  const db = openDatabase();
  try {
    const audit = getImportAuditBatchDetail(definitionPreview.batchId, { db });
    assert.strictEqual(audit.importType, 'energy_benchmark');
    assert.strictEqual(audit.auditPhase, 'preview');
    assert.strictEqual(audit.executeResult, null);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM benchmark_definitions WHERE benchmark_code = 'BENCH-cross'").get().total, 0);
  } finally {
    db.close();
  }
  const correctDefinitionResponse = await requestJson(
    server, 'POST', `${ROUTE_BASE}/definitions/execute`, createMinimalExecuteBody(definitionPreview), adminToken
  );
  assert.strictEqual(correctDefinitionResponse.status, 200);

  const targetPreview = assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/targets/preview`, {
    filename: 'target-cross.csv', content: buildCsv(TARGET_HEADERS, [createTargetRow({
      对标编码: 'BENCH-cross', 目标值: 88
    })])
  }, adminToken), 'energy_benchmark', 'energy-benchmark-targets');
  const wrongTargetResponse = await requestJson(server, 'POST', `${ROUTE_BASE}/definitions/execute`, createMinimalExecuteBody(targetPreview, {
    confirmText: '确认导入能效对标标准'
  }), adminToken);
  assert.strictEqual(wrongTargetResponse.status, 400);
  assert(/^ENERGY_ANALYSIS_/.test(wrongTargetResponse.body.error.details.code));

  const targetDb = openDatabase();
  try {
    const audit = getImportAuditBatchDetail(targetPreview.batchId, { db: targetDb });
    assert.strictEqual(audit.importType, 'energy_benchmark');
    assert.strictEqual(audit.auditPhase, 'preview');
    assert.strictEqual(audit.executeResult, null);
    assert.strictEqual(targetDb.prepare(
      `SELECT COUNT(*) AS total
       FROM benchmark_targets target
       INNER JOIN benchmark_definitions definition ON definition.id = target.benchmark_definition_id
       WHERE definition.benchmark_code = 'BENCH-cross'`
    ).get().total, 0);
  } finally {
    targetDb.close();
  }
  const correctTargetResponse = await requestJson(
    server, 'POST', `${ROUTE_BASE}/targets/execute`, createMinimalExecuteBody(targetPreview), adminToken
  );
  assert.strictEqual(correctTargetResponse.status, 200);
}

/** 校验原文件 SHA 篡改、错误确认、stale 和受信失败审计真实性。 */
async function testExecuteSafetyAndFailureAudit(server, adminToken) {
  const tamperedPreview = await createPreview(server, adminToken, 'factor', 'tampered');
  const db = openDatabase();
  try {
    const tamperedBatch = getImportAuditBatchDetail(tamperedPreview.batchId, { db });
    const tamperedPath = path.join(process.env.UPLOADS_DIR, tamperedBatch.storedFilename);
    const originalContent = fs.readFileSync(tamperedPath);
    const tamperedContent = Buffer.from(originalContent);
    const marker = tamperedContent.indexOf(Buffer.from('FACTOR-tampered'));
    assert(marker >= 0, '篡改测试必须定位系数编码。');
    tamperedContent[marker] = tamperedContent[marker] === 0x46 ? 0x66 : 0x46;
    fs.writeFileSync(tamperedPath, tamperedContent);
    const beforeCount = db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total;
    const beforeBackups = listBackupFiles();
    const response = await requestJson(
      server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(tamperedPreview), adminToken
    );
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_conversion_factors').get().total, beforeCount);
    assert.deepStrictEqual(listBackupFiles(), beforeBackups, '备份前原文件预检失败不得创建备份。');
    const retryableAudit = getImportAuditBatchDetail(tamperedPreview.batchId, { db });
    assert.strictEqual(retryableAudit.status, tamperedPreview.auditBatch.status);
    assert(['completed', 'completed_with_errors'].includes(retryableAudit.status), '原文件预检失败后批次仍必须可执行。');
    assert.strictEqual(retryableAudit.auditPhase, 'preview');
    assert.strictEqual(retryableAudit.executeResult, null, '备份前的原文件篡改拒绝不得写入 execute failure audit。');
    assert.strictEqual(retryableAudit.backup, null, '备份前的原文件篡改拒绝不得写入备份摘要。');
    assertNoSensitiveData(response.body, '文件篡改响应');
    assertNoSensitiveData(retryableAudit, '文件篡改预演审计');

    fs.writeFileSync(tamperedPath, originalContent);
    const retryResponse = await requestJson(
      server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(tamperedPreview), adminToken
    );
    assert.strictEqual(retryResponse.status, 200, '恢复原文件后必须允许同一 preview 批次重试。');
    assert.strictEqual(retryResponse.body.data.imported, 1);
    const completedAudit = getImportAuditBatchDetail(tamperedPreview.batchId, { db });
    assert.strictEqual(completedAudit.status, 'completed');
    assert.strictEqual(completedAudit.auditPhase, 'execute');
    assert.strictEqual(completedAudit.executeResult.executed, true);
  } finally {
    db.close();
  }

  const confirmPreview = await createPreview(server, adminToken, 'factor', 'confirm');
  const wrongConfirmResponse = await requestJson(server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(confirmPreview, {
    confirmText: '错误确认'
  }), adminToken);
  assert.strictEqual(wrongConfirmResponse.status, 400);
  assert.strictEqual(wrongConfirmResponse.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH');
  const confirmDb = openDatabase();
  try {
    const audit = getImportAuditBatchDetail(confirmPreview.batchId, { db: confirmDb });
    assert.strictEqual(audit.auditPhase, 'preview');
    assert.strictEqual(audit.executeResult, null, '错误确认不得污染合法 preview 批次。');
    assert.strictEqual(confirmDb.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'FACTOR-confirm'").get().total, 0);
  } finally {
    confirmDb.close();
  }
  const correctConfirmResponse = await requestJson(
    server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(confirmPreview), adminToken
  );
  assert.strictEqual(correctConfirmResponse.status, 200, '错误确认后正确请求仍必须可执行。');

  const stalePreview = await createPreview(server, adminToken, 'factor', 'stale');
  const staleDb = openDatabase();
  try {
    staleDb.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(stalePreview.batchId);
  } finally {
    staleDb.close();
  }
  const staleResponse = await requestJson(
    server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(stalePreview), adminToken
  );
  assert.strictEqual(staleResponse.status, 400);
  assert.strictEqual(staleResponse.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID');
  const staleCheckDb = openDatabase();
  try {
    assert.strictEqual(staleCheckDb.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'FACTOR-stale'").get().total, 0);
    const audit = getImportAuditBatchDetail(stalePreview.batchId, { db: staleCheckDb });
    assert.strictEqual(audit.status, 'processing');
    assert.strictEqual(audit.auditPhase, 'preview');
    assert.strictEqual(audit.executeResult, null);
  } finally {
    staleCheckDb.close();
  }
}

/** 校验毫秒级重叠、空候选和内部历史伪造均经 API 稳定阻断且零业务写。 */
async function testBlockedCandidateApiBoundaries(server, adminToken) {
  const db = openDatabase();
  try {
    const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
    db.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES (
         'MS-ROUTE-EXISTING', ?, 'ms-route-overlap', 0.2, '毫秒测试', 'MS-ROUTE', 'ms-route-existing:v1',
         '2030-01-01T00:00:00.500Z', '2030-01-01T01:00:00.500Z', 'Asia/Shanghai', 'active'
       )`
    ).run(energyTypeId);
  } finally {
    db.close();
  }

  const overlapResponse = await requestMultipart(server, `${ROUTE_BASE}/conversion-factors/preview`, {
    filename: 'factor-ms-overlap.csv', content: buildCsv(FACTOR_HEADERS, [createFactorRow({
      系数编码: 'MS-ROUTE-CANDIDATE', 源单位: 'ms-route-overlap', 版本: 'ms-route-candidate:v1',
      '生效开始时间（UTC）': '2030-01-01T01:00:00Z', '生效结束时间（UTC）': '2030-01-01T02:00:00Z'
    })])
  }, adminToken);
  assert.strictEqual(overlapResponse.status, 200);
  assert.strictEqual(overlapResponse.body.data.summary.blocked, 1);
  assert.strictEqual(overlapResponse.body.data.expectedWouldImport, 0);
  assert(overlapResponse.body.data.auditIssues.some((issue) => issue.code === 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP'));
  const overlapExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/conversion-factors/execute`, createMinimalExecuteBody(overlapResponse.body.data), adminToken
  );
  assert.strictEqual(overlapExecute.status, 400);
  assert(/^ENERGY_ANALYSIS_/.test(overlapExecute.body.error.details.code));

  const forgedDefinitionResponse = await requestMultipart(server, `${ROUTE_BASE}/definitions/preview`, {
    filename: 'definition-internal-forged.csv', content: buildCsv(DEFINITION_HEADERS, [createDefinitionRow({
      对标编码: 'FORGED-INTERNAL-DEFINITION', 对标类型: 'internal_history_baseline'
    })])
  }, adminToken);
  assert.strictEqual(forgedDefinitionResponse.status, 200);
  assert.strictEqual(forgedDefinitionResponse.body.data.expectedWouldImport, 0);
  assert(forgedDefinitionResponse.body.data.auditIssues.some((issue) => issue.code === 'INTERNAL_HISTORY_BENCHMARK_IMPORT_FORBIDDEN'));
  const forgedDefinitionExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/definitions/execute`, createMinimalExecuteBody(forgedDefinitionResponse.body.data), adminToken
  );
  assert.strictEqual(forgedDefinitionExecute.status, 400);

  const forgedTargetResponse = await requestMultipart(server, `${ROUTE_BASE}/targets/preview`, {
    filename: 'target-internal-forged.csv', content: buildCsv(TARGET_HEADERS, [createTargetRow({
      对标编码: 'ROUTE-INTERNAL',
      '参考期开始时间（UTC）': '2025-01-01T00:00:00Z', 固化值: 99, 来源数据摘要: 'sha256:forged', 是否固化: 1
    })])
  }, adminToken);
  assert.strictEqual(forgedTargetResponse.status, 200);
  assert.strictEqual(forgedTargetResponse.body.data.expectedWouldImport, 0);
  assert(forgedTargetResponse.body.data.auditIssues.some((issue) => issue.code === 'INTERNAL_HISTORY_BENCHMARK_TARGET_IMPORT_FORBIDDEN'));
  assert(forgedTargetResponse.body.data.auditIssues.some((issue) => issue.code === 'BENCHMARK_INTERNAL_SNAPSHOT_FIELDS_FORBIDDEN'));
  const forgedTargetExecute = await requestJson(
    server, 'POST', `${ROUTE_BASE}/targets/execute`, createMinimalExecuteBody(forgedTargetResponse.body.data), adminToken
  );
  assert.strictEqual(forgedTargetExecute.status, 400);

  const checkDb = openDatabase();
  try {
    assert.strictEqual(checkDb.prepare("SELECT COUNT(*) AS total FROM energy_conversion_factors WHERE factor_code = 'MS-ROUTE-CANDIDATE'").get().total, 0);
    assert.strictEqual(checkDb.prepare("SELECT COUNT(*) AS total FROM benchmark_definitions WHERE benchmark_code = 'FORGED-INTERNAL-DEFINITION'").get().total, 0);
    assert.strictEqual(checkDb.prepare(
      `SELECT COUNT(*) AS total
       FROM benchmark_targets target
       INNER JOIN benchmark_definitions definition ON definition.id = target.benchmark_definition_id
       WHERE definition.benchmark_code = 'ROUTE-INTERNAL'`
    ).get().total, 0);
  } finally {
    checkDb.close();
  }
}

/** 校验旧 standards 路径和其他未知路径均不提供。 */
async function testUnknownRoutes(server, adminToken) {
  const oldPreview = await requestMultipart(server, `${ROUTE_BASE}/standards/preview`, {
    filename: 'old-standards.csv', content: buildCsv(DEFINITION_HEADERS, [createDefinitionRow()])
  }, adminToken);
  assert.strictEqual(oldPreview.status, 404);
  assert.strictEqual(oldPreview.body.error.code, 'NOT_FOUND');
  const oldExecute = await requestJson(server, 'POST', `${ROUTE_BASE}/standards/execute`, {}, adminToken);
  assert.strictEqual(oldExecute.status, 404);
  const unknown = await requestJson(server, 'POST', `${ROUTE_BASE}/unknown`, {}, adminToken);
  assert.strictEqual(unknown.status, 404);
  assertNoSensitiveData(oldPreview.body, '旧 standards preview 404');
  assertNoSensitiveData(oldExecute.body, '旧 standards execute 404');
  assertNoSensitiveData(unknown.body, '未知路径 404');
}

(async () => {
  let server;
  try {
    assert.strictEqual(ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION, 'energy:benchmarks:import:preview');
    assert.strictEqual(ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION, 'energy:benchmarks:import:execute');
    assert.deepStrictEqual(ENERGY_BENCHMARK_IMPORT_PERMISSIONS, {
      preview: 'energy:benchmarks:import:preview',
      execute: 'energy:benchmarks:import:execute'
    });

    initDatabase();
    seedMasterData();
    register({ username: 'benchmark-route-denied', password: 'Password123!' });
    register({ username: 'benchmark-route-preview', password: 'Password123!' });
    register({ username: 'benchmark-route-execute', password: 'Password123!' });
    register({ username: 'benchmark-route-full', password: 'Password123!' });
    grantPermissions('benchmark-route-preview', [ENERGY_BENCHMARK_IMPORT_PREVIEW_PERMISSION]);
    grantPermissions('benchmark-route-execute', [ENERGY_BENCHMARK_IMPORT_EXECUTE_PERMISSION]);
    grantPermissions('benchmark-route-full', Object.values(ENERGY_BENCHMARK_IMPORT_PERMISSIONS));

    const tokens = {
      admin: login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token,
      denied: login({ username: 'benchmark-route-denied', password: 'Password123!' }).token,
      previewOnly: login({ username: 'benchmark-route-preview', password: 'Password123!' }).token,
      executeOnly: login({ username: 'benchmark-route-execute', password: 'Password123!' }).token,
      full: login({ username: 'benchmark-route-full', password: 'Password123!' }).token
    };
    server = await startIsolatedServer();

    await testPermissionAndMaintenanceBoundaries(server, tokens);
    await testExecuteJsonAuthenticationOrder(server, tokens);
    await testSuccessfulImports(server, tokens.admin);
    await testUploadFailureCleanup(server, tokens.admin);
    await testDefinitionTargetRouteIsolation(server, tokens.admin);
    await testExecuteSafetyAndFailureAudit(server, tokens.admin);
    await testBlockedCandidateApiBoundaries(server, tokens.admin);
    await testUnknownRoutes(server, tokens.admin);

    const db = openDatabase();
    try {
      assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
      const allAuditRows = db.prepare('SELECT * FROM import_batches ORDER BY id').all();
      assertNoSensitiveData(allAuditRows, 'import_batches 原始审计行');
    } finally {
      db.close();
    }

    console.log('energy benchmark import route tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
