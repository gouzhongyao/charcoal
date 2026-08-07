'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// 路由测试仅使用随机端口、隔离 SQLite 和系统临时目录，不访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-analysis-import-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-analysis-import-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-analysis-import-route-test-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyAnalysisImportRoutes = require('../routes/energyAnalysisImports');
const {
  ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT,
  ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT,
  ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS,
  ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS
} = energyAnalysisImportRoutes;
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 隔离测试挂载路径；正式 server/src/index.js 按阶段要求保持未接入。
const ROUTE_BASE = '/api/energy-analysis/imports';

// 三类冻结模板的中文表头。
const TIMESERIES_HEADERS = Object.freeze([
  '能源类型编码', '用能单元编码', '计量器具编码', '开始时间（UTC）', '结束时间（UTC）',
  '来源时区', '粒度（分钟）', '原始单位', '原始值', '来源标识', '数据来源'
]);
const SHIFT_HEADERS = Object.freeze([
  '班次编码', '班次名称', '班次开始分钟', '班次结束分钟', '是否跨日', '来源时区',
  '定义来源', '定义版本', '定义生效开始时间（UTC）', '定义生效结束时间（UTC）',
  '用能单元编码', '排班开始时间（UTC）', '排班结束时间（UTC）', '来源标识', '数据来源', '状态'
]);
const DEVICE_HEADERS = Object.freeze([
  '计量器具编码', '用能单元编码', '设备状态', '开始时间（UTC）', '结束时间（UTC）',
  '来源时区', '来源标识', '数据来源'
]);

/** 将 CSV 单元格转义为安全文本。 */
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

/** 创建合法时序能耗数据行。 */
function createTimeseriesRow(overrides = {}) {
  return {
    能源类型编码: 'electricity',
    用能单元编码: 'W-001',
    计量器具编码: 'M-WORKSHOP',
    '开始时间（UTC）': '2026-08-01T00:00:00Z',
    '结束时间（UTC）': '2026-08-01T00:15:00Z',
    来源时区: 'Asia/Shanghai',
    '粒度（分钟）': 15,
    原始单位: 'kWh',
    原始值: 12.5,
    来源标识: 'route:timeseries:normal',
    数据来源: 'upload',
    ...overrides
  };
}

/** 创建合法排班数据行。 */
function createShiftRow(overrides = {}) {
  return {
    班次编码: 'DAY',
    班次名称: '白班',
    班次开始分钟: 360,
    班次结束分钟: 840,
    是否跨日: 0,
    来源时区: 'Asia/Shanghai',
    定义来源: '企业排班制度',
    定义版本: 'shift:v1',
    '定义生效开始时间（UTC）': '2026-01-01T00:00:00Z',
    '定义生效结束时间（UTC）': '2027-01-01T00:00:00Z',
    用能单元编码: 'W-001',
    '排班开始时间（UTC）': '2026-08-01T22:00:00Z',
    '排班结束时间（UTC）': '2026-08-02T06:00:00Z',
    来源标识: 'route:shift:normal',
    数据来源: 'upload',
    状态: 'active',
    ...overrides
  };
}

/** 创建合法设备状态数据行。 */
function createDeviceRow(overrides = {}) {
  return {
    计量器具编码: 'M-DEVICE',
    用能单元编码: 'E-001',
    设备状态: 'running',
    '开始时间（UTC）': '2026-08-01T00:00:00Z',
    '结束时间（UTC）': '2026-08-01T01:00:00Z',
    来源时区: 'Asia/Shanghai',
    来源标识: 'route:device:normal',
    数据来源: 'upload',
    ...overrides
  };
}

/** 创建一个真实旧版 XLS Buffer，用于触发领域模板格式校验。 */
function buildLegacyXlsBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    TIMESERIES_HEADERS,
    TIMESERIES_HEADERS.map((header) => createTimeseriesRow()[header])
  ]), '能耗时序');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
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
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
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

/** 发起原始 JSON 请求，用于验证畸形和超限正文不会在认证前解析。 */
function requestRawJson(server, method, pathname, rawBody, token) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseBuffer = Buffer.concat(chunks);
        const text = responseBuffer.toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (_error) {
          body = text;
        }
        resolve({ status: response.statusCode, headers: response.headers, body, text });
      });
    });
    request.on('error', reject);
    request.end(bodyBuffer);
  });
}

/** 发起单文件 multipart 请求；file=null 时发送不含文件的空表单。 */
function requestMultipart(server, pathname, file, token, fieldName = 'file') {
  return new Promise((resolve, reject) => {
    const boundary = `----energy-analysis-route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers
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

/** 断言响应或审计中不含测试机绝对路径。 */
function assertNoAbsolutePath(value, label) {
  const serialized = JSON.stringify(value).replace(/\\\\/g, '\\');
  const normalizedTmp = tmpDir.replace(/\\/g, '/');
  const normalizedUploads = process.env.UPLOADS_DIR.replace(/\\/g, '/');
  assert(!serialized.replace(/\\/g, '/').includes(normalizedTmp), `${label} 不得包含临时目录绝对路径。`);
  assert(!serialized.replace(/\\/g, '/').includes(normalizedUploads), `${label} 不得包含上传目录绝对路径。`);
  assert(!serialized.includes('C:\\private') && !serialized.includes('/var/private'), `${label} 不得包含底层路径片段。`);
}

/** 从 preview 响应构造完整性见证请求；服务端仍会用原文件重算。 */
function createExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    backupReason: preview.backupReason,
    duplicateStrategy: preview.duplicateStrategy,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport,
    candidateRowIds: [...preview.candidateRowIds],
    candidateRows: preview.candidateRows.map((row) => ({ ...row }))
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
    ).run(`route-${username}`, `${username} 能源分析导入角色`, now, now).lastInsertRowid);
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

/** 初始化三类导入依赖的组织、表计和班次定义。 */
function seedMasterData() {
  const db = openDatabase();
  try {
    const workshopId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('W-001', '一号车间', '/W-001', 'workshop', 'active')`
    ).run().lastInsertRowid);
    const equipmentId = Number(db.prepare(
      `INSERT INTO organization_units (parent_id, unit_code, unit_name, unit_path, unit_type, status)
       VALUES (?, 'E-001', '一号设备', '/W-001/E-001', 'equipment', 'active')`
    ).run(workshopId).lastInsertRowid);
    const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
    db.prepare(
      `INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
       VALUES ('M-WORKSHOP', '车间总表', 'electricity', ?, ?, 'active')`
    ).run(electricity.id, workshopId);
    db.prepare(
      `INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
       VALUES ('M-DEVICE', '设备电表', 'electricity', ?, ?, 'active')`
    ).run(electricity.id, equipmentId);
    db.prepare(
      `INSERT INTO shift_definitions (
         shift_code, shift_name, start_minute, end_minute, crosses_midnight, source_timezone,
         source, version, effective_start_utc, effective_end_utc, status
       ) VALUES ('DAY', '白班', 360, 840, 0, 'Asia/Shanghai', '企业排班制度', 'shift:v1',
         '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active')`
    ).run();
  } finally {
    db.close();
  }
}

/** 创建并启动隔离 Express 应用，冻结“独立路由先于全局 JSON parser”挂载要求。 */
async function startIsolatedServer() {
  const app = express();
  app.use(ROUTE_BASE, energyAnalysisImportRoutes);
  app.use(express.json({ limit: '2mb' }));
  app.post('/api/json-echo', (req, res) => res.status(200).json({ success: true, data: req.body || null }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 校验一个 preview 响应并返回数据。 */
function assertSuccessfulPreview(response, expectedImportType) {
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.success, true);
  assert.strictEqual(response.body.data.summary.wouldImport, 1);
  assert.strictEqual(response.body.data.auditBatch.importType, expectedImportType);
  assert.strictEqual(response.body.data.auditBatch.auditPhase, 'preview');
  assertNoAbsolutePath(response.body, `${expectedImportType} preview 响应`);
  return response.body.data;
}

/** 校验六条路由的认证、权限与维护态顺序，三个 preview 在维护态均不得落盘。 */
async function testPermissionAndMaintenanceBoundaries(server, tokens) {
  const routes = [
    {
      label: 'timeseries',
      previewPath: `${ROUTE_BASE}/timeseries/preview`,
      executePath: `${ROUTE_BASE}/timeseries/execute`,
      previewToken: tokens.timeseriesPreview,
      executeToken: tokens.timeseriesExecute,
      csv: buildCsv(TIMESERIES_HEADERS, [createTimeseriesRow({ 来源标识: 'permission:timeseries' })])
    },
    {
      label: 'shift-schedules',
      previewPath: `${ROUTE_BASE}/shift-schedules/preview`,
      executePath: `${ROUTE_BASE}/shift-schedules/execute`,
      previewToken: tokens.operationsPreview,
      executeToken: tokens.operationsExecute,
      csv: buildCsv(SHIFT_HEADERS, [createShiftRow({ 来源标识: 'permission:shift' })])
    },
    {
      label: 'device-states',
      previewPath: `${ROUTE_BASE}/device-states/preview`,
      executePath: `${ROUTE_BASE}/device-states/execute`,
      previewToken: tokens.operationsPreview,
      executeToken: tokens.operationsExecute,
      csv: buildCsv(DEVICE_HEADERS, [createDeviceRow({ 来源标识: 'permission:device' })])
    }
  ];

  for (const route of routes) {
    const beforeFiles = listUploadFiles();
    const anonymousPreview = await requestMultipart(server, route.previewPath, {
      filename: `${route.label}-anonymous.csv`, content: route.csv
    });
    assert.strictEqual(anonymousPreview.status, 401, `${route.label} preview 必须先认证。`);
    assert.strictEqual(anonymousPreview.body.error.code, 'UNAUTHENTICATED');
    const anonymousExecute = await requestJson(server, 'POST', route.executePath, {}, null);
    assert.strictEqual(anonymousExecute.status, 401, `${route.label} execute 必须先认证。`);

    const deniedPreview = await requestMultipart(server, route.previewPath, {
      filename: `${route.label}-denied.csv`, content: route.csv
    }, tokens.denied);
    assert.strictEqual(deniedPreview.status, 403, `${route.label} preview 必须校验权限。`);
    assert.strictEqual(deniedPreview.body.error.code, 'FORBIDDEN');
    const deniedExecute = await requestJson(server, 'POST', route.executePath, {}, tokens.denied);
    assert.strictEqual(deniedExecute.status, 403, `${route.label} execute 必须校验权限。`);
    assert.deepStrictEqual(listUploadFiles(), beforeFiles, `${route.label} 的 401/403 必须发生在上传落盘前。`);

    await runWithMaintenance(`route-${route.label}-maintenance`, async () => {
      const maintenancePreview = await requestMultipart(server, route.previewPath, {
        filename: `${route.label}-maintenance.csv`, content: route.csv
      }, route.previewToken);
      assert.strictEqual(maintenancePreview.status, 423);
      assert.strictEqual(maintenancePreview.body.error.code, 'MAINTENANCE_IN_PROGRESS');
      const maintenanceExecute = await requestJson(server, 'POST', route.executePath, {}, route.executeToken);
      assert.strictEqual(maintenanceExecute.status, 423);
      assert.strictEqual(maintenanceExecute.body.error.code, 'MAINTENANCE_IN_PROGRESS');
      assert.deepStrictEqual(listUploadFiles(), beforeFiles, `${route.label} 维护态 preview 不得触发 Multer 落盘。`);
    });
  }
}

/** 校验四个最小权限账号对六条路由的 preview-only/execute-only 允许与拒绝矩阵。 */
async function testMinimalPermissionMatrix(server, tokens) {
  const cases = [
    {
      label: 'timeseries',
      previewPath: `${ROUTE_BASE}/timeseries/preview`,
      executePath: `${ROUTE_BASE}/timeseries/execute`,
      previewToken: tokens.timeseriesPreview,
      executeToken: tokens.timeseriesExecute,
      importType: 'energy_timeseries',
      file: {
        filename: 'permission-timeseries.csv',
        content: buildCsv(TIMESERIES_HEADERS, [createTimeseriesRow({
          '开始时间（UTC）': '2026-10-01T00:00:00Z',
          '结束时间（UTC）': '2026-10-01T00:15:00Z',
          来源标识: 'permission-matrix:timeseries'
        })])
      }
    },
    {
      label: 'shift-schedules',
      previewPath: `${ROUTE_BASE}/shift-schedules/preview`,
      executePath: `${ROUTE_BASE}/shift-schedules/execute`,
      previewToken: tokens.operationsPreview,
      executeToken: tokens.operationsExecute,
      importType: 'shift_schedule',
      file: {
        filename: 'permission-shift.csv',
        content: buildCsv(SHIFT_HEADERS, [createShiftRow({
          '排班开始时间（UTC）': '2026-10-01T22:00:00Z',
          '排班结束时间（UTC）': '2026-10-02T06:00:00Z',
          来源标识: 'permission-matrix:shift'
        })])
      }
    },
    {
      label: 'device-states',
      previewPath: `${ROUTE_BASE}/device-states/preview`,
      executePath: `${ROUTE_BASE}/device-states/execute`,
      previewToken: tokens.operationsPreview,
      executeToken: tokens.operationsExecute,
      importType: 'device_state',
      file: {
        filename: 'permission-device.csv',
        content: buildCsv(DEVICE_HEADERS, [createDeviceRow({
          '开始时间（UTC）': '2026-10-01T00:00:00Z',
          '结束时间（UTC）': '2026-10-01T01:00:00Z',
          来源标识: 'permission-matrix:device'
        })])
      }
    }
  ];

  for (const testCase of cases) {
    const previewResponse = await requestMultipart(server, testCase.previewPath, testCase.file, testCase.previewToken);
    const preview = assertSuccessfulPreview(previewResponse, testCase.importType);
    const previewOnlyExecute = await requestJson(server, 'POST', testCase.executePath, createExecuteBody(preview), testCase.previewToken);
    assert.strictEqual(previewOnlyExecute.status, 403, `${testCase.label} preview-only 不得执行。`);

    const beforeDeniedPreviewFiles = listUploadFiles();
    const executeOnlyPreview = await requestMultipart(server, testCase.previewPath, {
      ...testCase.file,
      filename: `execute-only-${testCase.file.filename}`
    }, testCase.executeToken);
    assert.strictEqual(executeOnlyPreview.status, 403, `${testCase.label} execute-only 不得预演。`);
    assert.deepStrictEqual(listUploadFiles(), beforeDeniedPreviewFiles, `${testCase.label} execute-only 拒绝不得落盘。`);

    const executeResponse = await requestJson(server, 'POST', testCase.executePath, createExecuteBody(preview), testCase.executeToken);
    assert.strictEqual(executeResponse.status, 200, `${testCase.label} execute-only 必须能够执行合法批次。`);
    assert.strictEqual(executeResponse.body.data.imported, 1);
  }
}

/** 校验 execute JSON 只在认证、权限和维护态后解析，并稳定脱敏 400/413。 */
async function testExecuteJsonParsingBoundary(server, tokens) {
  const executePath = `${ROUTE_BASE}/timeseries/execute`;
  const oversizedJson = Buffer.from(`"${'a'.repeat(2 * 1024 * 1024 + 1024)}"`, 'utf8');

  const anonymousValid = await requestRawJson(server, 'POST', executePath, '{}', null);
  assert.strictEqual(anonymousValid.status, 401, '匿名合法 JSON 必须先返回 401。');
  const anonymousMalformed = await requestRawJson(server, 'POST', executePath, '{', null);
  assert.strictEqual(anonymousMalformed.status, 401, '匿名畸形 JSON 不得在认证前解析。');
  const anonymousOversized = await requestRawJson(server, 'POST', executePath, oversizedJson, null);
  assert.strictEqual(anonymousOversized.status, 401, '匿名超限 JSON 不得在认证前解析。');

  const deniedMalformed = await requestRawJson(server, 'POST', executePath, '{', tokens.denied);
  assert.strictEqual(deniedMalformed.status, 403, '无权限畸形 JSON 必须先返回 403。');

  const authorizedMalformed = await requestRawJson(server, 'POST', executePath, '{', tokens.timeseriesExecute);
  assert.strictEqual(authorizedMalformed.status, 400);
  assert.strictEqual(authorizedMalformed.body.error.code, 'ENERGY_ANALYSIS_EXECUTE_JSON_INVALID');
  assert.strictEqual(authorizedMalformed.body.error.details.code, 'ENERGY_ANALYSIS_EXECUTE_JSON_INVALID');
  assert(!authorizedMalformed.text.includes('SyntaxError'));
  assert(!authorizedMalformed.text.includes('Unexpected'));

  const authorizedOversized = await requestRawJson(server, 'POST', executePath, oversizedJson, tokens.timeseriesExecute);
  assert.strictEqual(authorizedOversized.status, 413);
  assert.strictEqual(authorizedOversized.body.error.code, 'ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE');
  assert.strictEqual(authorizedOversized.body.error.details.code, 'ENERGY_ANALYSIS_EXECUTE_BODY_TOO_LARGE');
  assert.strictEqual(authorizedOversized.body.error.details.maxBodySize, '2mb');
  assert(!authorizedOversized.text.includes('entity.too.large'));
  assertNoAbsolutePath(authorizedOversized.body, 'execute 超限 JSON 响应');

  const globalParserProbe = await requestJson(server, 'POST', '/api/json-echo', { stillAvailable: true });
  assert.strictEqual(globalParserProbe.status, 200, '独立路由之后的其余路由仍必须可使用全局 JSON parser。');
  assert.deepStrictEqual(globalParserProbe.body.data, { stillAvailable: true });
}

/** 校验三类 preview+execute 正常链路、业务来源批次和统一审计。 */
async function testSuccessfulImports(server, adminToken) {
  const definitions = [
    {
      name: 'timeseries',
      previewPath: `${ROUTE_BASE}/timeseries/preview`,
      executePath: `${ROUTE_BASE}/timeseries/execute`,
      importType: 'energy_timeseries',
      tableName: 'energy_timeseries_records',
      file: { filename: 'timeseries-normal.csv', content: buildCsv(TIMESERIES_HEADERS, [createTimeseriesRow()]) }
    },
    {
      name: 'shift',
      previewPath: `${ROUTE_BASE}/shift-schedules/preview`,
      executePath: `${ROUTE_BASE}/shift-schedules/execute`,
      importType: 'shift_schedule',
      tableName: 'shift_schedule_records',
      file: { filename: 'shift-normal.csv', content: buildCsv(SHIFT_HEADERS, [createShiftRow()]) }
    },
    {
      name: 'device',
      previewPath: `${ROUTE_BASE}/device-states/preview`,
      executePath: `${ROUTE_BASE}/device-states/execute`,
      importType: 'device_state',
      tableName: 'device_state_records',
      file: { filename: 'device-normal.csv', content: buildCsv(DEVICE_HEADERS, [createDeviceRow()]) }
    }
  ];
  const results = {};

  for (const definition of definitions) {
    const beforeFiles = listUploadFiles().length;
    const previewResponse = await requestMultipart(server, definition.previewPath, definition.file, adminToken);
    const preview = assertSuccessfulPreview(previewResponse, definition.importType);
    assert.strictEqual(listUploadFiles().length, beforeFiles + 1, `${definition.name} 成功 preview 必须保留原文件。`);

    const executeResponse = await requestJson(server, 'POST', definition.executePath, createExecuteBody(preview), adminToken);
    assert.strictEqual(executeResponse.status, 200);
    assert.strictEqual(executeResponse.body.success, true);
    assert.strictEqual(executeResponse.body.data.imported, 1);
    assert.strictEqual(executeResponse.body.data.batchId, preview.batchId);
    assertNoAbsolutePath(executeResponse.body, `${definition.name} execute 响应`);

    const db = openDatabase();
    try {
      const inserted = db.prepare(`SELECT source_batch_id AS sourceBatchId FROM ${definition.tableName} WHERE source_batch_id = ?`).get(preview.batchId);
      assert.deepStrictEqual(inserted, { sourceBatchId: preview.batchId });
      const audit = getImportAuditBatchDetail(preview.batchId, { db });
      assert.strictEqual(audit.auditPhase, 'execute');
      assert.strictEqual(audit.status, 'completed');
      assert.strictEqual(audit.executeResult.imported, 1);
      assert.strictEqual(audit.backup.reason, 'energy-analysis-import');
      assertNoAbsolutePath(audit, `${definition.name} 数据库审计`);
    } finally {
      db.close();
    }
    results[definition.name] = { preview, execute: executeResponse.body.data };
  }
  return results;
}

/** 校验上传、解析和领域服务失败后只清理当前失败文件。 */
async function testUploadFailureCleanup(server, adminToken) {
  const previewPath = `${ROUTE_BASE}/timeseries/preview`;
  const cases = [
    {
      name: '缺文件',
      file: null,
      expectedTopCode: 'BAD_REQUEST',
      expectedDetailCode: 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED'
    },
    {
      name: '错误扩展名',
      file: { filename: 'wrong-extension.txt', content: 'not allowed', mimeType: 'text/plain' },
      expectedTopCode: 'UNSUPPORTED_IMPORT_FILE_TYPE'
    },
    {
      name: '伪装 XLSX',
      file: { filename: 'disguised.xlsx', content: 'not a real xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      expectedTopCode: 'BAD_REQUEST',
      expectedDetailCode: 'INVALID_EXCEL_FILE_SIGNATURE'
    },
    {
      name: 'CSV 解析失败',
      file: { filename: 'broken.csv', content: Buffer.from('﻿"未闭合标题\n值\n', 'utf8') },
      expectedTopCode: 'BAD_REQUEST',
      expectedDetailCode: 'CSV_PARSE_FAILED'
    },
    {
      name: '领域格式校验失败',
      file: { filename: 'unsupported-template.xls', content: buildLegacyXlsBuffer(), mimeType: 'application/vnd.ms-excel' },
      expectedTopCode: 'BAD_REQUEST',
      expectedDetailCode: 'ENERGY_TIMESERIES_TEMPLATE_FILE_TYPE_UNSUPPORTED'
    },
    {
      name: '文件过大',
      file: { filename: 'too-large.csv', content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) },
      expectedTopCode: 'IMPORT_FILE_TOO_LARGE'
    }
  ];

  for (const testCase of cases) {
    const beforeFiles = listUploadFiles();
    const response = await requestMultipart(server, previewPath, testCase.file, adminToken);
    assert.strictEqual(response.status, 400, `${testCase.name} 必须返回 400。`);
    assert.strictEqual(response.body.error.code, testCase.expectedTopCode, `${testCase.name} 顶层错误码必须稳定。`);
    if (testCase.expectedDetailCode) {
      assert.strictEqual(response.body.error.details.code, testCase.expectedDetailCode, `${testCase.name} 领域错误码必须稳定。`);
    }
    assert.deepStrictEqual(listUploadFiles(), beforeFiles, `${testCase.name} 后不得残留当前上传文件。`);
    assertNoAbsolutePath(response.body, `${testCase.name} 错误响应`);
  }
}

/** 创建指定类型的新 preview，供安全和批次绑定测试复用。 */
async function createPreview(server, adminToken, type, suffix) {
  const unique = String(suffix).replace(/[^A-Za-z0-9-]+/g, '-');
  if (type === 'timeseries') {
    const minute = Number(suffix) % 40;
    return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/timeseries/preview`, {
      filename: `timeseries-${unique}.csv`,
      content: buildCsv(TIMESERIES_HEADERS, [createTimeseriesRow({
        '开始时间（UTC）': `2026-09-01T${String(Math.floor(minute / 4)).padStart(2, '0')}:${String((minute % 4) * 15).padStart(2, '0')}:00Z`,
        '结束时间（UTC）': new Date(Date.parse(`2026-09-01T${String(Math.floor(minute / 4)).padStart(2, '0')}:${String((minute % 4) * 15).padStart(2, '0')}:00Z`) + 15 * 60000).toISOString(),
        来源标识: `route:timeseries:${unique}`
      })])
    }, adminToken), 'energy_timeseries');
  }
  if (type === 'shift') {
    const day = 10 + (Number(suffix) % 10);
    return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/shift-schedules/preview`, {
      filename: `shift-${unique}.csv`,
      content: buildCsv(SHIFT_HEADERS, [createShiftRow({
        '排班开始时间（UTC）': `2026-09-${String(day).padStart(2, '0')}T22:00:00Z`,
        '排班结束时间（UTC）': `2026-09-${String(day + 1).padStart(2, '0')}T06:00:00Z`,
        来源标识: `route:shift:${unique}`
      })])
    }, adminToken), 'shift_schedule');
  }
  const hour = Number(suffix) % 20;
  return assertSuccessfulPreview(await requestMultipart(server, `${ROUTE_BASE}/device-states/preview`, {
    filename: `device-${unique}.csv`,
    content: buildCsv(DEVICE_HEADERS, [createDeviceRow({
      '开始时间（UTC）': `2026-09-02T${String(hour).padStart(2, '0')}:00:00Z`,
      '结束时间（UTC）': `2026-09-02T${String(hour + 1).padStart(2, '0')}:00:00Z`,
      来源标识: `route:device:${unique}`
    })])
  }, adminToken), 'device_state');
}

/** 校验文件篡改、错误确认和 stale 批次均稳定 4xx 且零业务写。 */
async function testExecuteSafetyRejections(server, adminToken) {
  const db = openDatabase();
  try {
    const tamperedPreview = await createPreview(server, adminToken, 'timeseries', 1);
    const tamperedBatch = getImportAuditBatchDetail(tamperedPreview.batchId, { db });
    const tamperedPath = path.join(process.env.UPLOADS_DIR, tamperedBatch.storedFilename);
    const tamperedBuffer = fs.readFileSync(tamperedPath);
    const markerIndex = tamperedBuffer.indexOf(Buffer.from('route:timeseries:1'));
    assert(markerIndex >= 0, '篡改测试必须定位来源标识。');
    tamperedBuffer[markerIndex] = tamperedBuffer[markerIndex] === 0x72 ? 0x52 : 0x72;
    fs.writeFileSync(tamperedPath, tamperedBuffer);
    const beforeTamperCount = db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total;
    const tamperedResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/timeseries/execute`,
      createExecuteBody(tamperedPreview),
      adminToken
    );
    assert.strictEqual(tamperedResponse.status, 400);
    assert.strictEqual(tamperedResponse.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total, beforeTamperCount);
    assertNoAbsolutePath(tamperedResponse.body, '原文件 SHA 篡改响应');

    const confirmPreview = await createPreview(server, adminToken, 'timeseries', 2);
    const wrongConfirmBody = createExecuteBody(confirmPreview);
    wrongConfirmBody.confirmText = '错误确认文本';
    const beforeConfirmCount = db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total;
    const wrongConfirmResponse = await requestJson(server, 'POST', `${ROUTE_BASE}/timeseries/execute`, wrongConfirmBody, adminToken);
    assert.strictEqual(wrongConfirmResponse.status, 400);
    assert.strictEqual(wrongConfirmResponse.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_timeseries_records').get().total, beforeConfirmCount);
    const confirmAudit = getImportAuditBatchDetail(confirmPreview.batchId, { db });
    assert.strictEqual(confirmAudit.auditPhase, 'preview', '错误确认不得污染可信度尚未建立的原批次。');
    assert.strictEqual(confirmAudit.executeResult, null);
    const correctConfirmResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/timeseries/execute`,
      createExecuteBody(confirmPreview),
      adminToken
    );
    assert.strictEqual(correctConfirmResponse.status, 200, '错误确认后正确请求仍应可执行。');

    const stalePreview = await createPreview(server, adminToken, 'device', 3);
    db.prepare("UPDATE import_batches SET status = 'processing' WHERE id = ?").run(stalePreview.batchId);
    const beforeStaleCount = db.prepare('SELECT COUNT(*) AS total FROM device_state_records').get().total;
    const staleResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/device-states/execute`,
      createExecuteBody(stalePreview),
      adminToken
    );
    assert.strictEqual(staleResponse.status, 400);
    assert.strictEqual(staleResponse.body.error.details.code, 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM device_state_records').get().total, beforeStaleCount);
  } finally {
    db.close();
  }
}

/** 校验三类路由不能串用批次，错误调用不污染原批次且正确路由随后可执行。 */
async function testCrossRouteBatchIsolation(server, adminToken) {
  const cases = [
    {
      type: 'timeseries',
      suffix: 11,
      wrongPath: `${ROUTE_BASE}/shift-schedules/execute`,
      correctPath: `${ROUTE_BASE}/timeseries/execute`,
      tableName: 'energy_timeseries_records'
    },
    {
      type: 'shift',
      suffix: 12,
      wrongPath: `${ROUTE_BASE}/device-states/execute`,
      correctPath: `${ROUTE_BASE}/shift-schedules/execute`,
      tableName: 'shift_schedule_records'
    },
    {
      type: 'device',
      suffix: 13,
      wrongPath: `${ROUTE_BASE}/timeseries/execute`,
      correctPath: `${ROUTE_BASE}/device-states/execute`,
      tableName: 'device_state_records'
    }
  ];

  for (const testCase of cases) {
    const preview = await createPreview(server, adminToken, testCase.type, testCase.suffix);
    const db = openDatabase();
    try {
      const beforeCount = db.prepare(`SELECT COUNT(*) AS total FROM ${testCase.tableName}`).get().total;
      const wrongResponse = await requestJson(server, 'POST', testCase.wrongPath, createExecuteBody(preview), adminToken);
      assert.strictEqual(wrongResponse.status, 400, `${testCase.type} 批次串用必须返回稳定 4xx。`);
      assert(/^ENERGY_ANALYSIS_/.test(wrongResponse.body.error.details.code));
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS total FROM ${testCase.tableName}`).get().total, beforeCount);
      const unchangedAudit = getImportAuditBatchDetail(preview.batchId, { db });
      assert.strictEqual(unchangedAudit.auditPhase, 'preview', `${testCase.type} 错误路由不得污染原批次阶段。`);
      assert.strictEqual(unchangedAudit.executeResult, null, `${testCase.type} 错误路由不得写失败 execute 审计。`);
    } finally {
      db.close();
    }

    const correctResponse = await requestJson(server, 'POST', testCase.correctPath, createExecuteBody(preview), adminToken);
    assert.strictEqual(correctResponse.status, 200, `${testCase.type} 原批次随后必须可由正确路由执行。`);
    assert.strictEqual(correctResponse.body.data.imported, 1);
  }
}

(async () => {
  let server;
  try {
    assert.deepStrictEqual(ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS, {
      preview: 'energy:analysis:timeseries:preview',
      execute: 'energy:analysis:timeseries:execute'
    });
    assert.deepStrictEqual(ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS, {
      preview: 'energy:analysis:operations:preview',
      execute: 'energy:analysis:operations:execute'
    });
    assert.strictEqual(ENERGY_ANALYSIS_EXECUTE_JSON_LIMIT, '2mb');
    assert.deepStrictEqual(ENERGY_ANALYSIS_IMPORT_ROUTER_MOUNT_REQUIREMENT, {
      beforeGlobalJsonParser: true,
      recommendedBasePath: ROUTE_BASE
    });

    initDatabase();
    seedMasterData();
    register({ username: 'route-denied', password: 'Password123!' });
    register({ username: 'route-ts-preview', password: 'Password123!' });
    register({ username: 'route-ts-execute', password: 'Password123!' });
    register({ username: 'route-ops-preview', password: 'Password123!' });
    register({ username: 'route-ops-execute', password: 'Password123!' });
    grantPermissions('route-ts-preview', [ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.preview]);
    grantPermissions('route-ts-execute', [ENERGY_ANALYSIS_TIMESERIES_PERMISSIONS.execute]);
    grantPermissions('route-ops-preview', [ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.preview]);
    grantPermissions('route-ops-execute', [ENERGY_ANALYSIS_OPERATIONS_PERMISSIONS.execute]);

    const tokens = {
      admin: login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token,
      denied: login({ username: 'route-denied', password: 'Password123!' }).token,
      timeseriesPreview: login({ username: 'route-ts-preview', password: 'Password123!' }).token,
      timeseriesExecute: login({ username: 'route-ts-execute', password: 'Password123!' }).token,
      operationsPreview: login({ username: 'route-ops-preview', password: 'Password123!' }).token,
      operationsExecute: login({ username: 'route-ops-execute', password: 'Password123!' }).token
    };
    server = await startIsolatedServer();

    await testPermissionAndMaintenanceBoundaries(server, tokens);
    await testExecuteJsonParsingBoundary(server, tokens);
    await testMinimalPermissionMatrix(server, tokens);
    await testSuccessfulImports(server, tokens.admin);
    await testUploadFailureCleanup(server, tokens.admin);
    await testExecuteSafetyRejections(server, tokens.admin);
    await testCrossRouteBatchIsolation(server, tokens.admin);

    const db = openDatabase();
    try {
      assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
      const allAuditRows = db.prepare('SELECT * FROM import_batches ORDER BY id').all();
      assertNoAbsolutePath(allAuditRows, 'import_batches 原始审计行');
    } finally {
      db.close();
    }

    console.log('energy analysis import route tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
