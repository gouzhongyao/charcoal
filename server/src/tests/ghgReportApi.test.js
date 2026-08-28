'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-ghg-report-api-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'ghg-report-api.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'GhgReportApi123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'ghg-report-api-hmac-secret-2026';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const authRoutes = require('../routes/auth');
const ghgReportRoutes = require('../routes/ghgReports');
const importRoutes = require('../routes/imports');
const templateRoutes = require('../routes/templates');
const { getUserPermissions, login, register } = require('../services/authService');
const { getUserMenus } = require('../services/menuService');
const backupService = require('../services/backupService');
const { runWithMaintenance } = require('../services/maintenanceState');
const {
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_SHEETS,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION
} = require('../services/ghgReportContracts');

/** 发起 JSON 或二进制 HTTP 请求。 */
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

/** 发起只包含单个 file 字段的 multipart 预演请求。 */
function requestMultipart(server, pathname, file, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----ghg-report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

/** 生成含排放、清除和固定汇总的 N7 六表工作簿。 */
function createGhgReportXlsx(reportCode = 'GHG-API-001') {
  const workbook = XLSX.utils.book_new();
  const rows = {
    report: [[reportCode, '=API温室气体报告', 'API测试组织', '2026-01-01', '2026-12-31',
      GHG_REPORT_TEMPLATE_TYPE, GHG_REPORT_TEMPLATE_VERSION, '@报告备注']],
    organizationBoundaries: [
      ['ORG-API-001', 'API测试组织全部受控设施', '运营控制法', '全部受控设施']
    ],
    operationalBoundaries: [
      ['范围一', '固定燃烧', '天然气锅炉与园区碳汇'],
      ['范围二', '购入电力', '购入电力间接排放']
    ],
    items: [
      ['ITEM-API-001', '排放', '范围二', '购入电力', 'CO2', '购入电力', 12000, 'kWh', 6.84, 1, 6.84, 'tCO2e', '活动数据法', 'EVID-API-001', '=项目备注'],
      ['ITEM-API-002', '清除', '范围一', '固定燃烧', 'CO2', '园区碳汇', 10, 'tCO2', 0.5, 1, 0.5, 'tCO2e', '碳汇监测法', 'EVID-API-002', '清除量保持正数']
    ],
    summaries: [
      ['TOTAL-API-001', '总计', '全部', 6.84, 0.5, 6.34, 'tCO2e', '总计'],
      ['TYPE-API-001', '记录类型', '排放', 6.84, 0, 6.84, 'tCO2e', '排放'],
      ['TYPE-API-002', '记录类型', '清除', 0, 0.5, -0.5, 'tCO2e', '清除']
    ],
    evidence: [
      ['EVID-API-001', '+电力证据', '计量记录', '电力计量汇总', '@证据备注'],
      ['EVID-API-002', '碳汇证据', '监测记录', '园区碳汇监测记录', '证据备注']
    ]
  };
  GHG_REPORT_SHEETS.forEach((contract) => {
    const worksheet = XLSX.utils.aoa_to_sheet([contract.headers, ...rows[contract.key]]);
    XLSX.utils.book_append_sheet(workbook, worksheet, contract.name);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

// N7 自有 HTTP 和通用详情递归禁止的内部安全链字段。
const GHG_REPORT_FORBIDDEN_HTTP_FIELDS = Object.freeze(new Set([
  'storedFilename',
  'fileSha256',
  'sourceFileSha256',
  'candidateRowId',
  'candidateRows',
  'candidateRowIds',
  'previewSignature',
  'previewAuditDigest',
  'previewAudit',
  'auditContext',
  'executeResult',
  'auditBatch',
  'witness'
]));

/** 递归断言 HTTP JSON 未公开 N7 内部安全链字段。 */
function assertNoGhgReportInternalFields(value, valuePath = 'response') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoGhgReportInternalFields(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([fieldName, fieldValue]) => {
    assert(!GHG_REPORT_FORBIDDEN_HTTP_FIELDS.has(fieldName),
      `N7 HTTP 响应不得在 ${valuePath}.${fieldName} 暴露内部字段。`);
    assertNoGhgReportInternalFields(fieldValue, `${valuePath}.${fieldName}`);
  });
}

/** 按服务端顺序扁平化菜单树，用于验证结构祖先和页面路由合同。 */
function flattenMenus(menus = []) {
  return menus.flatMap((menu) => [menu, ...flattenMenus(menu.children || [])]);
}

/** 为隔离测试账号创建角色并授予固定权限。 */
function grantPermissions(userId, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(
      `ghg-report-api-${userId}`,
      `温室气体报告 API 角色 ${userId}`,
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
    const ordinaryUser = register({
      username: 'ghgordinary',
      password: 'GhgOrdinary123!',
      displayName: '温室气体报告普通账号'
    });
    const viewUser = register({
      username: 'ghgviewer',
      password: 'GhgViewer123!',
      displayName: '温室气体报告只读账号'
    });
    const previewUser = register({
      username: 'ghgpreviewer',
      password: 'GhgPreviewer123!',
      displayName: '温室气体报告预演账号'
    });
    const genericImportUser = register({
      username: 'ghggenericimport',
      password: 'GhgGenericImport123!',
      displayName: '通用导入账号'
    });
    const combinedImportUser = register({
      username: 'ghgcombinedimport',
      password: 'GhgCombinedImport123!',
      displayName: '温室气体报告导入查询账号'
    });
    grantPermissions(viewUser.id, ['carbon:ghg-reports:view']);
    grantPermissions(previewUser.id, ['carbon:ghg-reports:import:preview']);
    grantPermissions(genericImportUser.id, ['imports:view', 'imports:download']);
    grantPermissions(combinedImportUser.id, [
      'imports:view',
      'imports:download',
      'carbon:ghg-reports:view',
      'carbon:ghg-reports:export'
    ]);
    const ordinaryToken = login({ username: ordinaryUser.username, password: 'GhgOrdinary123!' }).token;
    const viewToken = login({ username: viewUser.username, password: 'GhgViewer123!' }).token;
    const previewToken = login({ username: previewUser.username, password: 'GhgPreviewer123!' }).token;
    const genericImportToken = login({ username: genericImportUser.username, password: 'GhgGenericImport123!' }).token;
    const combinedImportToken = login({ username: combinedImportUser.username, password: 'GhgCombinedImport123!' }).token;
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    initDatabase();
    assert(!getUserPermissions(ordinaryUser.id).some((permission) => permission.startsWith('carbon:ghg-reports:')),
      '重复初始化不得给普通角色自动增加 N7 权限。');
    const viewPermissions = getUserPermissions(viewUser.id);
    assert(viewPermissions.includes('carbon:ghg-reports:view'), 'N7 只读账号必须保留显式查看权限。');
    assert(!viewPermissions.includes('carbon:emissions:view'), '结构祖先投影不得写入旧碳排查看权限。');
    assert(!viewPermissions.includes('carbon:ghg-reports:export'), '结构祖先投影不得写入 N7 兄弟按钮权限。');
    const viewMenuRows = flattenMenus(getUserMenus(viewUser.id));
    assert.deepStrictEqual(viewMenuRows.map((menu) => menu.routePath), ['/carbon'],
      '仅授权 N7 查看按钮时必须安全投影 /carbon 页面祖先。');
    assert.strictEqual(viewMenuRows[0].component, 'carbon/index');
    assert.strictEqual(viewMenuRows[0].permissionCode, null,
      '结构祖先只承载页面路由，不得伪造业务权限编码。');
    assert.deepStrictEqual(getUserMenus(viewUser.id), getUserMenus(viewUser.id),
      '相同授权的结构祖先投影必须保持幂等。');
    const ancestorStateDb = openDatabase();
    try {
      ancestorStateDb.prepare("UPDATE sys_menus SET visible = 0 WHERE route_path = '/carbon'").run();
      assert.deepStrictEqual(getUserMenus(viewUser.id), [], '隐藏祖先时 N7 按钮授权必须 fail-closed。');
      ancestorStateDb.prepare("UPDATE sys_menus SET visible = 1, status = 'inactive' WHERE route_path = '/carbon'").run();
      assert.deepStrictEqual(getUserMenus(viewUser.id), [], '停用祖先时 N7 按钮授权必须 fail-closed。');
      ancestorStateDb.prepare("UPDATE sys_menus SET status = 'active' WHERE route_path = '/carbon'").run();
    } finally {
      ancestorStateDb.close();
    }

    const app = express();
    app.use('/api/carbon/ghg-reports', ghgReportRoutes);
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', authRoutes);
    app.use('/api/imports', importRoutes);
    app.use('/api/templates', templateRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const importFile = { filename: 'ghg-report.xlsx', content: createGhgReportXlsx() };
    const viewMenusResponse = await request(server, 'GET', '/api/auth/menus', undefined, viewToken);
    assert.strictEqual(viewMenusResponse.status, 200);
    const viewHttpMenuRows = flattenMenus(viewMenusResponse.body.data);
    assert.deepStrictEqual(viewHttpMenuRows.map((menu) => menu.routePath), ['/carbon'],
      '/auth/menus 必须为 N7 view-only 账号返回 /carbon 动态路由页面。');
    assert.strictEqual(viewHttpMenuRows[0].component, 'carbon/index');
    const legacyViewMenusResponse = await request(server, 'GET', '/api/getRouters', undefined, viewToken);
    assert.strictEqual(legacyViewMenusResponse.status, 200);
    assert.deepStrictEqual(legacyViewMenusResponse.body.data, viewMenusResponse.body.data,
      '兼容菜单接口必须共享同一安全祖先投影。');
    const viewProfileResponse = await request(server, 'GET', '/api/getInfo', undefined, viewToken);
    assert.strictEqual(viewProfileResponse.status, 200);
    assert(viewProfileResponse.body.data.permissions.includes('carbon:ghg-reports:view'));
    assert(!viewProfileResponse.body.data.permissions.includes('carbon:ghg-reports:export'),
      '菜单祖先投影不得扩大 profile 中的兄弟按钮权限。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/ghg-reports')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/ghg-reports', undefined, ordinaryToken)).status, 403);
    const emptyList = await request(server, 'GET', '/api/carbon/ghg-reports', undefined, viewToken);
    assert.strictEqual(emptyList.status, 200);
    assertNoGhgReportInternalFields(emptyList.body);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', importFile)).status, 401);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', importFile, ordinaryToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/templates/ghg-report.xlsx', undefined, ordinaryToken)).status, 403);
    const templateDownload = await request(server, 'GET', '/api/templates/ghg-report.xlsx', undefined, previewToken);
    assert.strictEqual(templateDownload.status, 200);
    assert.deepStrictEqual(XLSX.read(templateDownload.buffer, { type: 'buffer' }).SheetNames,
      GHG_REPORT_SHEETS.map((sheet) => sheet.name));
    const csvRejected = await request(server, 'GET', '/api/templates/ghg-report.csv', undefined, previewToken);
    assert.strictEqual(csvRejected.status, 400);

    const uploadsBeforeDemoReject = fs.existsSync(process.env.UPLOADS_DIR)
      ? fs.readdirSync(process.env.UPLOADS_DIR).sort()
      : [];
    const demoRejected = await requestMultipart(
      server,
      '/api/carbon/ghg-reports/imports/preview',
      importFile,
      adminToken,
      { 'X-Demo-Context': 'z'.repeat(43) }
    );
    assert.strictEqual(demoRejected.status, 409);
    assert.strictEqual(demoRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    assert.deepStrictEqual(
      fs.existsSync(process.env.UPLOADS_DIR) ? fs.readdirSync(process.env.UPLOADS_DIR).sort() : [],
      uploadsBeforeDemoReject
    );
    const maintenanceRejected = await runWithMaintenance('ghg-report-test', async () => (
      requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', importFile, adminToken)
    ));
    assert.strictEqual(maintenanceRejected.status, 423);
    assert.strictEqual(maintenanceRejected.body.error.code, 'MAINTENANCE_IN_PROGRESS');

    // 只有通用导入权限的账号在列表和 COUNT 中都不能枚举 N7 批次。
    const previewOnly = await requestMultipart(
      server,
      '/api/carbon/ghg-reports/imports/preview',
      importFile,
      previewToken
    );
    assert.strictEqual(previewOnly.status, 200, JSON.stringify(previewOnly.body));
    assertNoGhgReportInternalFields(previewOnly.body);
    assert.strictEqual(previewOnly.body.data.summary.wouldImport, 1);
    const genericList = await request(server, 'GET', '/api/imports/batches?pageSize=100', undefined, genericImportToken);
    assert.strictEqual(genericList.status, 200);
    assert(!genericList.body.data.some((row) => row.id === previewOnly.body.data.batchId));
    const genericExplicitList = await request(server, 'GET', '/api/imports/batches?importType=ghg_report&pageSize=100', undefined, genericImportToken);
    assert.strictEqual(genericExplicitList.status, 200);
    assert.deepStrictEqual(genericExplicitList.body.data, []);
    assert.strictEqual(genericExplicitList.body.meta.pagination.total, 0);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}`, undefined, genericImportToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/errors`, undefined, genericImportToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/download`, undefined, genericImportToken)).status, 403);

    // 同时具备通用和 N7 权限时仍只能获得显式安全 DTO。
    const combinedList = await request(server, 'GET', '/api/imports/batches?importType=ghg_report&pageSize=100', undefined, combinedImportToken);
    assert.strictEqual(combinedList.status, 200);
    const combinedListRow = combinedList.body.data.find((row) => row.id === previewOnly.body.data.batchId);
    assert(combinedListRow);
    assert.strictEqual(combinedListRow.importTypeLabel, '温室气体报告导入');
    assertNoGhgReportInternalFields(combinedListRow);
    const combinedDetail = await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}`, undefined, combinedImportToken);
    assert.strictEqual(combinedDetail.status, 200);
    assertNoGhgReportInternalFields(combinedDetail.body);
    assert(!JSON.stringify(combinedDetail.body.data).includes(process.env.UPLOADS_DIR));
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/errors`, undefined, combinedImportToken)).status, 200);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/download`, undefined, combinedImportToken)).status, 200);

    assert.strictEqual((await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      batchId: previewOnly.body.data.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, previewToken)).status, 403);

    const preview = await requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', importFile, adminToken);
    assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
    assertNoGhgReportInternalFields(preview.body);
    const rejectedWitness = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      previewSignature: 'client-controlled'
    }, adminToken);
    assert.strictEqual(rejectedWitness.status, 400);
    assert.strictEqual(rejectedWitness.body.error.details.code, 'GHG_REPORT_UNKNOWN_FIELDS_REJECTED');
    const demoExecuteRejected = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken, { 'X-Demo-Context': 'y'.repeat(43) });
    assert.strictEqual(demoExecuteRejected.status, 409);

    // 并发占用报告编码必须在 HTTP 边界收口为 N7 409 且不公开共享内部错误码。
    const staleFile = { filename: 'ghg-report-stale.xlsx', content: createGhgReportXlsx('GHG-API-STALE') };
    const stalePreview = await requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', staleFile, adminToken);
    assert.strictEqual(stalePreview.status, 200);
    let staleDb = openDatabase();
    try {
      const occupiedBatchId = staleDb.prepare(`INSERT INTO import_batches
        (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
        VALUES ('ghg_report', 'occupied.xlsx', 'occupied.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
      staleDb.prepare(`INSERT INTO ghg_reports
        (report_code, report_code_key, report_name, report_organization, period_start, period_end,
         source_batch_id, source_row_number)
        VALUES ('GHG-API-STALE', 'GHG-API-STALE', '并发占用报告', 'API测试组织',
         '2026-01-01', '2026-12-31', ?, 2)`).run(occupiedBatchId);
    } finally {
      staleDb.close();
    }
    const staleExecute = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      batchId: stalePreview.body.data.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(staleExecute.status, 409, JSON.stringify(staleExecute.body));
    assert.strictEqual(staleExecute.body.error.code, 'GHG_REPORT_PREVIEW_STALE');
    assert.deepStrictEqual(staleExecute.body.error.details, { requiresNewPreview: true });
    assertNoGhgReportInternalFields(staleExecute.body);
    assert(!JSON.stringify(staleExecute.body).includes('ENERGY_ANALYSIS_'));

    // 真实备份目录故障必须保留 503，但只能公开 N7 领域码和固定脱敏字段。
    const backupFailureFile = { filename: 'ghg-report-backup-failure.xlsx', content: createGhgReportXlsx('GHG-API-BACKUP-FAILURE') };
    const backupFailurePreview = await requestMultipart(
      server,
      '/api/carbon/ghg-reports/imports/preview',
      backupFailureFile,
      adminToken
    );
    assert.strictEqual(backupFailurePreview.status, 200);
    const originalCreateBackup = backupService.createBackup;
    let backupFailureExecute;
    backupService.createBackup = async () => {
      throw new Error(`sensitive backup failure at ${process.env.BACKUPS_DIR}`);
    };
    try {
      backupFailureExecute = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
        batchId: backupFailurePreview.body.data.batchId,
        confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, adminToken);
    } finally {
      backupService.createBackup = originalCreateBackup;
    }
    assert.strictEqual(backupFailureExecute.status, 503, JSON.stringify(backupFailureExecute.body));
    assert.strictEqual(backupFailureExecute.body.error.code, 'GHG_REPORT_IMPORT_BACKUP_FAILED');
    assert.strictEqual(backupFailureExecute.body.error.message, '温室气体报告导入备份失败，未写入业务数据。');
    assert.deepStrictEqual(backupFailureExecute.body.error.details, { retryable: true });
    assertNoGhgReportInternalFields(backupFailureExecute.body);
    assert(!JSON.stringify(backupFailureExecute.body).includes('ENERGY_ANALYSIS_'));
    assert(!JSON.stringify(backupFailureExecute.body).includes(process.env.SQLITE_PATH));
    assert(!JSON.stringify(backupFailureExecute.body).includes(process.env.BACKUPS_DIR));

    // 真实 SQLite 触发器故障注入必须回滚业务事实并以 N7 领域 500 脱敏返回。
    const transactionFailureFile = { filename: 'ghg-report-transaction-failure.xlsx', content: createGhgReportXlsx('GHG-API-TRANSACTION-FAILURE') };
    const transactionFailurePreview = await requestMultipart(
      server,
      '/api/carbon/ghg-reports/imports/preview',
      transactionFailureFile,
      adminToken
    );
    assert.strictEqual(transactionFailurePreview.status, 200);
    const transactionFaultDb = openDatabase();
    try {
      transactionFaultDb.exec(`CREATE TRIGGER ghg_api_transaction_failure
        BEFORE INSERT ON ghg_reports
        BEGIN
          SELECT RAISE(ABORT, 'sensitive SQL and local path transaction failure');
        END;`);
    } finally {
      transactionFaultDb.close();
    }
    let transactionFailureExecute;
    try {
      transactionFailureExecute = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
        batchId: transactionFailurePreview.body.data.batchId,
        confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
        requireBackup: true,
        acknowledgeSkippedRisks: true
      }, adminToken);
    } finally {
      const cleanupFaultDb = openDatabase();
      try {
        cleanupFaultDb.exec('DROP TRIGGER IF EXISTS ghg_api_transaction_failure');
      } finally {
        cleanupFaultDb.close();
      }
    }
    assert.strictEqual(transactionFailureExecute.status, 500, JSON.stringify(transactionFailureExecute.body));
    assert.strictEqual(transactionFailureExecute.body.error.code, 'GHG_REPORT_IMPORT_TRANSACTION_FAILED');
    assert.strictEqual(transactionFailureExecute.body.error.message, '温室气体报告导入事务失败，业务数据已回滚。');
    assert.deepStrictEqual(transactionFailureExecute.body.error.details, { rolledBack: true });
    assertNoGhgReportInternalFields(transactionFailureExecute.body);
    const transactionFailureBodyText = JSON.stringify(transactionFailureExecute.body);
    assert(!transactionFailureBodyText.includes('ENERGY_ANALYSIS_'));
    assert(!transactionFailureBodyText.includes('sensitive SQL'));
    assert(!transactionFailureBodyText.includes(process.env.SQLITE_PATH));
    const transactionVerifyDb = openDatabase();
    try {
      assert.strictEqual(transactionVerifyDb.prepare(`SELECT COUNT(*) AS total FROM ghg_reports
        WHERE report_code_key = 'GHG-API-TRANSACTION-FAILURE'`).get().total, 0);
    } finally {
      transactionVerifyDb.close();
    }

    const executed = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: GHG_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.body));
    assertNoGhgReportInternalFields(executed.body);
    assert.deepStrictEqual(Object.keys(executed.body.data).sort(), ['batchId', 'imported', 'importedIds']);
    assert.strictEqual(executed.body.data.imported, 1);
    const reportId = executed.body.data.importedIds[0];

    const list = await request(server, 'GET', `/api/carbon/ghg-reports?recordType=removal&scope=scope_1&category=${encodeURIComponent('固定燃烧')}&greenhouseGas=CO2&reportCode=ghg-api-001`, undefined, adminToken);
    assert.strictEqual(list.status, 200);
    assertNoGhgReportInternalFields(list.body);
    assert.strictEqual(list.body.data.length, 1);
    assert.strictEqual(list.body.meta.pagination.total, 1);
    const detail = await request(server, 'GET', `/api/carbon/ghg-reports/${reportId}`, undefined, viewToken);
    assert.strictEqual(detail.status, 200);
    assertNoGhgReportInternalFields(detail.body);
    assert.strictEqual(detail.body.data.report.reportCode, 'GHG-API-001');
    const reportCreatedAt = detail.body.data.report.createdAt;
    assert.match(reportCreatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
      'GHG 报告详情 API 必须继续返回严格 UTC 技术值。');
    const reportCreatedAtUserVisible = reportCreatedAt.replace(/\.\d{3}Z$/, 'Z').replace('T', ' ').replace(/Z$/, '');
    assert.strictEqual(detail.body.data.report.periodStart, '2026-01-01', '报告开始日期必须继续保持 YYYY-MM-DD。');
    assert.strictEqual(detail.body.data.report.periodEnd, '2026-12-31', '报告结束日期必须继续保持 YYYY-MM-DD。');
    assert.strictEqual(detail.body.data.organizationBoundaries.length, 1);
    assert.strictEqual(detail.body.data.operationalBoundaries.length, 2);
    assert.strictEqual(detail.body.data.items.length, 2);
    assert.strictEqual(detail.body.data.items[1].recordType, 'removal');
    assert.strictEqual(detail.body.data.items[1].co2eValue, 0.5);
    assert.strictEqual(detail.body.data.summaries[0].netCo2e, 6.34);
    const traced = await request(server, 'GET', `/api/carbon/ghg-reports/batches/${preview.body.data.batchId}`, undefined, viewToken);
    assert.strictEqual(traced.status, 200);
    assert.strictEqual(traced.body.data.report.id, reportId);
    const unknownQuery = await request(server, 'GET', '/api/carbon/ghg-reports?unknown=1', undefined, adminToken);
    assert.strictEqual(unknownQuery.status, 400);
    assert.strictEqual(unknownQuery.body.error.details.code, 'GHG_REPORT_QUERY_FIELDS_INVALID');
    const missingReport = await request(server, 'GET', '/api/carbon/ghg-reports/999999999', undefined, viewToken);
    assert.strictEqual(missingReport.status, 404);
    assert.strictEqual(missingReport.body.error.code, 'NOT_FOUND');
    const oversizedJson = await request(server, 'POST', '/api/carbon/ghg-reports/imports/execute', {
      padding: 'x'.repeat(70 * 1024)
    }, adminToken);
    assert.strictEqual(oversizedJson.status, 413);
    assert.strictEqual(oversizedJson.body.error.code, 'GHG_REPORT_JSON_TOO_LARGE');

    const exportDenied = await request(server, 'GET', `/api/carbon/ghg-reports/${reportId}/export`, undefined, viewToken);
    assert.strictEqual(exportDenied.status, 403);
    const exported = await request(server, 'GET', `/api/carbon/ghg-reports/${reportId}/export`, undefined, adminToken);
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers['x-exported-row-count'], '11');
    assert(String(exported.headers['content-disposition']).includes(`filename="ghg-report-${reportId}.xlsx"`));
    const exportedWorkbook = XLSX.read(exported.buffer, { type: 'buffer' });
    assert.deepStrictEqual(exportedWorkbook.SheetNames, GHG_REPORT_SHEETS.map((sheet) => sheet.name));
    assert.strictEqual(exportedWorkbook.Sheets['报告信息'].B2.v, "'=API温室气体报告");
    assert.strictEqual(exportedWorkbook.Sheets['报告信息'].L2.v, reportCreatedAtUserVisible,
      'GHG 报告导出创建时间必须使用用户可见空格秒格式。');
    assert.strictEqual(exportedWorkbook.Sheets['报告信息'].D2.v, '2026-01-01');
    assert.strictEqual(exportedWorkbook.Sheets['报告信息'].E2.v, '2026-12-31');
    assert.strictEqual(exportedWorkbook.Sheets['报告项目'].O2.v, "'=项目备注");
    assert.strictEqual(exportedWorkbook.Sheets['证据说明'].B2.v, "'+电力证据");
    assert.strictEqual(exportedWorkbook.Sheets['证据说明'].E2.v, "'@证据备注");
    ['G2', 'I2', 'J2', 'K2'].forEach((address) => {
      assert.strictEqual(exportedWorkbook.Sheets['报告项目'][address].t, 'n', `报告项目 ${address} 必须保持数值单元格。`);
    });
    ['D2', 'E2', 'F2'].forEach((address) => {
      assert.strictEqual(exportedWorkbook.Sheets['汇总'][address].t, 'n', `汇总 ${address} 必须保持数值单元格。`);
    });

    const duplicatePreview = await requestMultipart(server, '/api/carbon/ghg-reports/imports/preview', importFile, adminToken);
    assert.strictEqual(duplicatePreview.status, 200);
    assert.strictEqual(duplicatePreview.body.data.summary.blocked, 1);
    assert.strictEqual(duplicatePreview.body.data.summary.skipped, 0);
    assert.strictEqual(duplicatePreview.body.data.summary.wouldImport, 0);

    // 通用删除必须继续只允许 energy_record，N7 批次即使管理员也不可删除。
    const genericDeleteRejected = await request(server, 'DELETE', `/api/imports/batches/${preview.body.data.batchId}`, undefined, adminToken);
    assert.strictEqual(genericDeleteRejected.status, 400);
    assert.strictEqual(genericDeleteRejected.body.error.details.code, 'IMPORT_AUDIT_GENERIC_DELETE_FORBIDDEN');

    // 隔离库制造查询故障，验证未知异常统一脱敏为可控 500。
    const faultDb = openDatabase();
    try {
      faultDb.exec('ALTER TABLE ghg_reports RENAME TO ghg_reports_fault_probe');
    } finally {
      faultDb.close();
    }
    const controlledFailure = await request(server, 'GET', '/api/carbon/ghg-reports', undefined, adminToken);
    assert.strictEqual(controlledFailure.status, 500);
    assert.strictEqual(controlledFailure.body.error.code, 'GHG_REPORT_INTERNAL_ERROR');
    assert.strictEqual(controlledFailure.body.error.message, '温室气体报告服务暂时不可用。');
    assert(!JSON.stringify(controlledFailure.body).includes('no such table'));
    assert(!JSON.stringify(controlledFailure.body).includes(process.env.SQLITE_PATH));
    const restoreDb = openDatabase();
    try {
      restoreDb.exec('ALTER TABLE ghg_reports_fault_probe RENAME TO ghg_reports');
    } finally {
      restoreDb.close();
    }

    console.log('ghgReportApi tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
