'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// HTTP 专项测试使用随机端口、隔离 SQLite 和临时本地文件目录。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-activity-api-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-activity-api.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonActivityApi123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'carbon-activity-api-hmac-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const carbonActivityRoutes = require('../routes/carbonActivities');
const { login, register } = require('../services/authService');
const {
  CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_WORKSHEET_NAME
} = require('../services/carbonActivityContracts');
const {
  buildCarbonActivityWhere,
  exportCarbonActivities,
  listCarbonActivities
} = require('../services/carbonActivityService');

// 路由测试固定组织与能源类型信息。
const TEST_ORGANIZATION_CODE = 'CA-API-OU';
let energyTypeCode = '';
let energyStandardUnit = '';

/** 发起 JSON 或下载请求。 */
function request(server, method, pathname, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = rawBody.length;
    }
    const clientRequest = http.request({
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
        const contentType = String(response.headers['content-type'] || '');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          buffer,
          body: contentType.includes('application/json') && buffer.length
            ? JSON.parse(buffer.toString('utf8'))
            : null
        });
      });
    });
    clientRequest.on('error', reject);
    if (rawBody) clientRequest.write(rawBody);
    clientRequest.end();
  });
}

/** 发起单文件 multipart 预演请求。 */
function requestMultipart(server, pathname, file, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----carbon-activity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`, 'utf8'),
      file.content,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      ...extraHeaders
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const clientRequest = http.request({
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
          buffer,
          body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(body);
  });
}

/** 断言活动筛选服务稳定拒绝非法严格 UTC 时间。 */
function assertInvalidUtcFilter(query) {
  assert.throws(
    () => buildCarbonActivityWhere(query),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_FILTER_UTC_INVALID'
  );
  assert.throws(
    () => listCarbonActivities(query),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_FILTER_UTC_INVALID'
  );
  assert.throws(
    () => exportCarbonActivities({ ...query, format: 'csv' }),
    (error) => error?.details?.code === 'CARBON_ACTIVITY_FILTER_UTC_INVALID'
  );
}

/** 构造固定 Excel v1 独立碳活动文件。 */
function createCarbonActivityXlsx() {
  const workbook = XLSX.utils.book_new();
  const row = [
    'CA-API-001',
    '',
    '范围二',
    '购入电力',
    TEST_ORGANIZATION_CODE,
    energyTypeCode,
    '2026-08-24T09:00',
    '2026-08-24T10:00',
    'Asia/Shanghai',
    '100',
    energyStandardUnit,
    '',
    '+meter-api',
    '@evidence-api',
    '=SUM(1,1)'
  ];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([CARBON_ACTIVITY_IMPORT_HEADERS, row]),
    CARBON_ACTIVITY_WORKSHEET_NAME
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 为账号授予精确活动权限，不复制其他细分权限。 */
function grantPermissions(userId, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(
      `carbon-activity-api-${userId}`,
      `碳活动 API 角色 ${userId}`,
      now,
      now
    ).lastInsertRowid);
    const insertGrant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `权限 ${permissionCode} 必须已注册。`);
      insertGrant.run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)')
      .run(userId, roleId, now);
  } finally {
    db.close();
  }
}

(async () => {
  let server;
  try {
    initDatabase();
    let db = openDatabase();
    try {
      db.prepare(`INSERT INTO organization_units
        (unit_code, unit_name, unit_path, unit_type, status)
        VALUES (?, '碳活动 API 测试单元', ?, 'department', 'active')`)
        .run(TEST_ORGANIZATION_CODE, `/${TEST_ORGANIZATION_CODE}`);
      const energyType = db.prepare(`SELECT code, standard_unit AS standardUnit
        FROM energy_types WHERE is_active = 1 AND standard_unit IS NOT NULL
        ORDER BY id LIMIT 1`).get();
      assert(energyType);
      energyTypeCode = energyType.code;
      energyStandardUnit = energyType.standardUnit;
    } finally {
      db.close();
    }

    const ordinaryUser = register({
      username: 'carbonordinary',
      password: 'CarbonOrdinary123!',
      displayName: '碳活动普通账号'
    });
    const viewUser = register({
      username: 'carbonviewer',
      password: 'CarbonViewer123!',
      displayName: '碳活动只读账号'
    });
    const previewUser = register({
      username: 'carbonpreviewer',
      password: 'CarbonPreviewer123!',
      displayName: '碳活动预演账号'
    });
    grantPermissions(viewUser.id, ['carbon:activities:view']);
    grantPermissions(previewUser.id, ['carbon:activities:import:preview']);

    const ordinaryToken = login({ username: 'carbonordinary', password: 'CarbonOrdinary123!' }).token;
    const viewToken = login({ username: 'carbonviewer', password: 'CarbonViewer123!' }).token;
    const previewToken = login({ username: 'carbonpreviewer', password: 'CarbonPreviewer123!' }).token;
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;

    const app = express();
    // 活动路由必须位于全局 JSON 解析器之前，验证自己的 64 KiB 限制和上传链。
    app.use('/api/carbon/activities', carbonActivityRoutes);
    app.use(express.json({ limit: '2mb' }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const importFile = { filename: '独立碳活动.xlsx', content: createCarbonActivityXlsx() };

    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities', undefined, ordinaryToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities', undefined, viewToken)).status, 200);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/activities/imports/preview', importFile)).status, 401);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/activities/imports/preview', importFile, ordinaryToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/activities', undefined, previewToken)).status, 403);

    // 未接入 demo context 必须在 Multer 落盘前 fail-closed。
    const uploadsBeforeDemoReject = fs.existsSync(process.env.UPLOADS_DIR)
      ? fs.readdirSync(process.env.UPLOADS_DIR).sort()
      : [];
    const demoRejected = await requestMultipart(
      server,
      '/api/carbon/activities/imports/preview',
      importFile,
      adminToken,
      { 'X-Demo-Context': 'z'.repeat(43) }
    );
    assert.strictEqual(demoRejected.status, 409);
    assert.strictEqual(demoRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    const uploadsAfterDemoReject = fs.existsSync(process.env.UPLOADS_DIR)
      ? fs.readdirSync(process.env.UPLOADS_DIR).sort()
      : [];
    assert.deepStrictEqual(uploadsAfterDemoReject, uploadsBeforeDemoReject);

    // preview-only 权限允许预演，但不能 execute 或读取活动列表。
    const previewOnlyResult = await requestMultipart(
      server,
      '/api/carbon/activities/imports/preview',
      importFile,
      previewToken
    );
    assert.strictEqual(previewOnlyResult.status, 200);
    assert.strictEqual(previewOnlyResult.body.data.summary.wouldImport, 1);
    assert.strictEqual((await request(server, 'POST', '/api/carbon/activities/imports/execute', {
      batchId: previewOnlyResult.body.data.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, previewToken)).status, 403);

    // 管理员完整走真实 HTTP preview/execute，未知客户端见证字段必须先被拒绝。
    const preview = await requestMultipart(
      server,
      '/api/carbon/activities/imports/preview',
      importFile,
      adminToken
    );
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.data.summary.wouldImport, 1);
    const rejectedWitness = await request(server, 'POST', '/api/carbon/activities/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      previewSignature: 'client-controlled'
    }, adminToken);
    assert.strictEqual(rejectedWitness.status, 400);
    assert.strictEqual(rejectedWitness.body.error.details.code, 'CARBON_ACTIVITY_UNKNOWN_FIELDS_REJECTED');

    const demoExecuteRejected = await request(server, 'POST', '/api/carbon/activities/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken, { 'X-Demo-Context': 'y'.repeat(43) });
    assert.strictEqual(demoExecuteRejected.status, 409);
    assert.strictEqual(demoExecuteRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');

    const executed = await request(server, 'POST', '/api/carbon/activities/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_ACTIVITY_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.body));
    assert.strictEqual(executed.body.data.imported, 1);
    const activityId = executed.body.data.importedIds[0];

    // 列表、详情和筛选必须显式返回来源类型、UTC、来源墙钟和审计追溯。
    const list = await request(
      server,
      'GET',
      `/api/carbon/activities?scope=scope_2&sourceType=independent_activity&keyword=${encodeURIComponent('CA-API-001')}`,
      undefined,
      adminToken
    );
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.data.length, 1);
    assert.strictEqual(list.body.data[0].sourceType, 'independent_activity');
    assert.strictEqual(list.body.data[0].sourceBatchId, preview.body.data.batchId);
    assert.strictEqual(list.body.data[0].startWallClock, '2026-08-24T09:00');
    assert.strictEqual(list.body.data[0].startUtc, '2026-08-24T01:00:00Z');
    const detail = await request(server, 'GET', `/api/carbon/activities/${activityId}`, undefined, viewToken);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.data.activityCode, 'CA-API-001');

    // 列表和导出服务及 HTTP 必须拒绝非法日历、缺秒和非零毫秒 UTC，合法严格 UTC 保持可用。
    const invalidUtcFilters = [
      '2025-02-29T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-08-24T01:00Z',
      '2026-08-24T01:00:00.001Z'
    ];
    invalidUtcFilters.forEach((startUtc) => assertInvalidUtcFilter({ startUtc }));
    const normalizedZeroMillisecondWhere = buildCarbonActivityWhere({
      startUtc: '2026-08-24T00:00:00.000Z',
      endUtc: '2026-08-24T03:00:00Z'
    });
    assert.strictEqual(normalizedZeroMillisecondWhere.params.startUtc, '2026-08-24T00:00:00Z');
    assert.strictEqual(listCarbonActivities({
      startUtc: '2026-08-24T00:00:00Z',
      endUtc: '2026-08-24T03:00:00Z'
    }).rows.length, 1);
    assert.strictEqual(exportCarbonActivities({
      format: 'csv',
      startUtc: '2026-08-24T00:00:00Z',
      endUtc: '2026-08-24T03:00:00Z'
    }).rowCount, 1);

    for (const invalidUtc of invalidUtcFilters) {
      const encodedUtc = encodeURIComponent(invalidUtc);
      const invalidList = await request(
        server,
        'GET',
        `/api/carbon/activities?startUtc=${encodedUtc}`,
        undefined,
        adminToken
      );
      assert.strictEqual(invalidList.status, 400);
      assert.strictEqual(invalidList.body.error.details.code, 'CARBON_ACTIVITY_FILTER_UTC_INVALID');
      const invalidExport = await request(
        server,
        'GET',
        `/api/carbon/activities/export?format=csv&startUtc=${encodedUtc}`,
        undefined,
        adminToken
      );
      assert.strictEqual(invalidExport.status, 400);
      assert.strictEqual(invalidExport.body.error.details.code, 'CARBON_ACTIVITY_FILTER_UTC_INVALID');
    }
    const validUtcQuery = `startUtc=${encodeURIComponent('2026-08-24T00:00:00Z')}&endUtc=${encodeURIComponent('2026-08-24T03:00:00Z')}`;
    const validUtcList = await request(
      server,
      'GET',
      `/api/carbon/activities?${validUtcQuery}`,
      undefined,
      adminToken
    );
    assert.strictEqual(validUtcList.status, 200);
    assert.strictEqual(validUtcList.body.data.length, 1);
    const validUtcExport = await request(
      server,
      'GET',
      `/api/carbon/activities/export?format=csv&${validUtcQuery}`,
      undefined,
      adminToken
    );
    assert.strictEqual(validUtcExport.status, 200);
    assert.strictEqual(validUtcExport.headers['x-exported-row-count'], '1');

    // 只读权限不得调用专用作废；写操作复用冻结的 import:execute 权限。
    const viewVoidDenied = await request(server, 'POST', `/api/carbon/activities/${activityId}/void`, {
      reason: '只读账号不得作废',
      expectedUpdatedAt: detail.body.data.updatedAt
    }, viewToken);
    assert.strictEqual(viewVoidDenied.status, 403);

    // CSV 与 XLSX 导出必须防止 Excel/WPS 公式执行，并使用稳定文件名。
    const csvExport = await request(server, 'GET', '/api/carbon/activities/export?format=csv', undefined, adminToken);
    assert.strictEqual(csvExport.status, 200);
    assert.strictEqual(csvExport.headers['content-type'], 'text/csv; charset=utf-8');
    assert.strictEqual(csvExport.headers['x-exported-row-count'], '1');
    assert(String(csvExport.headers['content-disposition']).includes('filename="carbon-activities.csv"'));
    const csvText = csvExport.buffer.toString('utf8');
    assert(csvText.includes("'+meter-api"));
    assert(csvText.includes("'@evidence-api"));
    assert(csvText.includes("'=SUM(1,1)"));

    const xlsxExport = await request(server, 'GET', '/api/carbon/activities/export?format=xlsx', undefined, adminToken);
    assert.strictEqual(xlsxExport.status, 200);
    assert.strictEqual(xlsxExport.headers['x-exported-row-count'], '1');
    const exportWorkbook = XLSX.read(xlsxExport.buffer, { type: 'buffer' });
    assert.deepStrictEqual(exportWorkbook.SheetNames, ['独立碳活动']);
    const exportRows = XLSX.utils.sheet_to_json(exportWorkbook.Sheets['独立碳活动'], { header: 1, defval: '' });
    assert(exportRows[1].includes("'+meter-api"));
    assert(exportRows[1].includes("'@evidence-api"));
    assert(exportRows[1].includes("'=SUM(1,1)"));

    // 作废请求未知字段和 stale 时间戳 fail-closed，正确乐观锁保留历史事实。
    const unknownVoidField = await request(server, 'POST', `/api/carbon/activities/${activityId}/void`, {
      reason: '未知字段',
      expectedUpdatedAt: detail.body.data.updatedAt,
      status: 'void'
    }, adminToken);
    assert.strictEqual(unknownVoidField.status, 400);
    assert.strictEqual(unknownVoidField.body.error.details.code, 'CARBON_ACTIVITY_UNKNOWN_FIELDS_REJECTED');

    const staleVoid = await request(server, 'POST', `/api/carbon/activities/${activityId}/void`, {
      reason: '错误版本',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
    }, adminToken);
    assert.strictEqual(staleVoid.status, 409);
    assert.strictEqual(staleVoid.body.error.code, 'CARBON_ACTIVITY_OPTIMISTIC_LOCK_CONFLICT');

    const voided = await request(server, 'POST', `/api/carbon/activities/${activityId}/void`, {
      reason: 'API 专项测试作废',
      expectedUpdatedAt: detail.body.data.updatedAt
    }, adminToken);
    assert.strictEqual(voided.status, 200);
    assert.strictEqual(voided.body.data.status, 'void');
    assert.strictEqual(voided.body.data.voidReason, 'API 专项测试作废');
    db = openDatabase();
    try {
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_activity_records').get().total, 1);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_calculation_runs').get().total, 0);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_accounting_results').get().total, 0);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM carbon_emissions').get().total, 0);
      assert(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'carbon.activity.void'").get().total >= 1);
      assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }

    console.log('carbonActivityApi tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
