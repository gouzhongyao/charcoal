'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-emission-report-api-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-emission-report-api.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'CarbonEmissionReportApi123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'carbon-emission-report-api-hmac-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const carbonEmissionReportRoutes = require('../routes/carbonEmissionReports');
const importRoutes = require('../routes/imports');
const templateRoutes = require('../routes/templates');
const { getUserPermissions, login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');
const {
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION
} = require('../services/carbonEmissionReportContracts');

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

function requestMultipart(server, pathname, file, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----carbon-emission-report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function createCarbonEmissionReportXlsx(reportCode = 'CER-API-001') {
  const workbook = XLSX.utils.book_new();
  const rows = {
    report: [[reportCode, '=API报告名称', 'API测试组织', '2026-01-01', '2026-12-31',
      CARBON_EMISSION_REPORT_TEMPLATE_TYPE, CARBON_EMISSION_REPORT_TEMPLATE_VERSION, '@报告备注']],
    boundaries: [
      ['组织边界', 'API测试组织全部受控设施', '运营控制法'],
      ['核算边界', '范围一和范围二', '报告项目中的排放源']
    ],
    items: [
      ['ITEM-API-001', '范围一', '固定燃烧', '天然气', '100', 'm3', '0.02', 'tCO2e/m3', '2', 'tCO2e', 'EVID-API-001', '=项目备注'],
      ['ITEM-API-002', '范围二', '购入电力', '电力', '3000', 'kWh', '0.001', 'tCO2e/kWh', '3', 'tCO2e', 'EVID-API-002', '项目备注']
    ],
    summaries: [
      ['TOTAL-API-001', '总计', '全部', '5', 'tCO2e', '总计'],
      ['SCOPE-API-001', '排放范围', '范围一', '2', 'tCO2e', '范围一'],
      ['SCOPE-API-002', '排放范围', '范围二', '3', 'tCO2e', '范围二']
    ],
    evidence: [
      ['EVID-API-001', '+燃气证据', '原始凭证', '燃气结算凭证', '@证据备注'],
      ['EVID-API-002', '电力证据', '计量记录', '电力计量汇总', '证据备注']
    ]
  };
  CARBON_EMISSION_REPORT_SHEETS.forEach((contract) => {
    const worksheet = XLSX.utils.aoa_to_sheet([contract.headers, ...rows[contract.key]]);
    XLSX.utils.book_append_sheet(workbook, worksheet, contract.name);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

// N6 自有 HTTP 响应递归禁止的服务端内部安全链字段。
const CARBON_EMISSION_REPORT_FORBIDDEN_HTTP_FIELDS = Object.freeze(new Set([
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

/** 递归断言 N6 自有 HTTP JSON 没有公开内部安全链字段。 */
function assertNoCarbonEmissionReportInternalFields(value, valuePath = 'response') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCarbonEmissionReportInternalFields(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([fieldName, fieldValue]) => {
    assert(!CARBON_EMISSION_REPORT_FORBIDDEN_HTTP_FIELDS.has(fieldName),
      `N6 自有 HTTP 响应不得在 ${valuePath}.${fieldName} 暴露内部字段。`);
    assertNoCarbonEmissionReportInternalFields(fieldValue, `${valuePath}.${fieldName}`);
  });
}

function grantPermissions(userId, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(
      `carbon-emission-report-api-${userId}`,
      `碳排放报告 API 角色 ${userId}`,
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
      username: 'reportordinary',
      password: 'ReportOrdinary123!',
      displayName: '报告普通账号'
    });
    const viewUser = register({
      username: 'reportviewer',
      password: 'ReportViewer123!',
      displayName: '报告只读账号'
    });
    const previewUser = register({
      username: 'reportpreviewer',
      password: 'ReportPreviewer123!',
      displayName: '报告预演账号'
    });
    const genericImportUser = register({
      username: 'reportgenericimport',
      password: 'ReportGenericImport123!',
      displayName: '通用导入账号'
    });
    const combinedImportUser = register({
      username: 'reportcombinedimport',
      password: 'ReportCombinedImport123!',
      displayName: '报告导入查询账号'
    });
    grantPermissions(viewUser.id, ['carbon:emission-reports:view']);
    grantPermissions(previewUser.id, ['carbon:emission-reports:import:preview']);
    grantPermissions(genericImportUser.id, ['imports:view', 'imports:download']);
    grantPermissions(combinedImportUser.id, [
      'imports:view',
      'imports:download',
      'carbon:emission-reports:view',
      'carbon:emission-reports:export'
    ]);
    const ordinaryToken = login({ username: ordinaryUser.username, password: 'ReportOrdinary123!' }).token;
    const viewToken = login({ username: viewUser.username, password: 'ReportViewer123!' }).token;
    const previewToken = login({ username: previewUser.username, password: 'ReportPreviewer123!' }).token;
    const genericImportToken = login({ username: genericImportUser.username, password: 'ReportGenericImport123!' }).token;
    const combinedImportToken = login({ username: combinedImportUser.username, password: 'ReportCombinedImport123!' }).token;
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;
    initDatabase();
    assert(!getUserPermissions(ordinaryUser.id).some((permission) => permission.startsWith('carbon:emission-reports:')),
      '重复初始化不得给普通角色自动增加 N6 权限。');

    const app = express();
    app.use('/api/carbon/emission-reports', carbonEmissionReportRoutes);
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/imports', importRoutes);
    app.use('/api/templates', templateRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const importFile = { filename: 'carbon-emission-report.xlsx', content: createCarbonEmissionReportXlsx() };
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emission-reports')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emission-reports', undefined, ordinaryToken)).status, 403);
    const emptyList = await request(server, 'GET', '/api/carbon/emission-reports', undefined, viewToken);
    assert.strictEqual(emptyList.status, 200);
    assertNoCarbonEmissionReportInternalFields(emptyList.body);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/emission-reports/imports/preview', importFile)).status, 401);
    assert.strictEqual((await requestMultipart(server, '/api/carbon/emission-reports/imports/preview', importFile, ordinaryToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/templates/carbon-emission-report.xlsx', undefined, ordinaryToken)).status, 403);
    const templateDownload = await request(server, 'GET', '/api/templates/carbon-emission-report.xlsx', undefined, previewToken);
    assert.strictEqual(templateDownload.status, 200);
    assert.deepStrictEqual(XLSX.read(templateDownload.buffer, { type: 'buffer' }).SheetNames,
      CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));
    const csvRejected = await request(server, 'GET', '/api/templates/carbon-emission-report.csv', undefined, previewToken);
    assert.strictEqual(csvRejected.status, 400);

    const uploadsBeforeDemoReject = fs.existsSync(process.env.UPLOADS_DIR)
      ? fs.readdirSync(process.env.UPLOADS_DIR).sort()
      : [];
    const demoRejected = await requestMultipart(
      server,
      '/api/carbon/emission-reports/imports/preview',
      importFile,
      adminToken,
      { 'X-Demo-Context': 'z'.repeat(43) }
    );
    assert.strictEqual(demoRejected.status, 409);
    assert.strictEqual(demoRejected.body.error.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED');
    assert.deepStrictEqual(fs.existsSync(process.env.UPLOADS_DIR) ? fs.readdirSync(process.env.UPLOADS_DIR).sort() : [], uploadsBeforeDemoReject);

    const maintenanceRejected = await runWithMaintenance('carbon-report-test', async () => (
      requestMultipart(server, '/api/carbon/emission-reports/imports/preview', importFile, adminToken)
    ));
    assert.strictEqual(maintenanceRejected.status, 423);
    assert.strictEqual(maintenanceRejected.body.error.code, 'MAINTENANCE_IN_PROGRESS');

    const previewOnly = await requestMultipart(
      server,
      '/api/carbon/emission-reports/imports/preview',
      importFile,
      previewToken
    );
    assert.strictEqual(previewOnly.status, 200, JSON.stringify(previewOnly.body));
    assertNoCarbonEmissionReportInternalFields(previewOnly.body);
    assert.strictEqual(previewOnly.body.data.summary.wouldImport, 1);
    const genericList = await request(server, 'GET', '/api/imports/batches?pageSize=100', undefined, genericImportToken);
    assert.strictEqual(genericList.status, 200);
    assert(!genericList.body.data.some((row) => row.id === previewOnly.body.data.batchId),
      '只有通用导入权限的账号不得在列表中枚举 N6 批次。');
    const genericExplicitList = await request(server, 'GET', '/api/imports/batches?importType=carbon_emission_report&pageSize=100', undefined, genericImportToken);
    assert.strictEqual(genericExplicitList.status, 200);
    assert.deepStrictEqual(genericExplicitList.body.data, [], '显式筛选 N6 类型时也必须隐藏无领域权限批次。');
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}`, undefined, genericImportToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/errors`, undefined, genericImportToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/download`, undefined, genericImportToken)).status, 403);

    const combinedList = await request(server, 'GET', '/api/imports/batches?importType=carbon_emission_report&pageSize=100', undefined, combinedImportToken);
    assert.strictEqual(combinedList.status, 200);
    const combinedListRow = combinedList.body.data.find((row) => row.id === previewOnly.body.data.batchId);
    assert(combinedListRow, '同时具备通用和领域权限的账号应可查询 N6 批次。');
    assert(!Object.prototype.hasOwnProperty.call(combinedListRow, 'fileSha256'));
    assert(!Object.prototype.hasOwnProperty.call(combinedListRow, 'previewAuditDigest'));
    const combinedDetail = await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}`, undefined, combinedImportToken);
    assert.strictEqual(combinedDetail.status, 200);
    ['storedFilename', 'fileSha256', 'previewSignature', 'previewAuditDigest', 'auditContext', 'executeResult', 'candidateRows']
      .forEach((fieldName) => assert(!Object.prototype.hasOwnProperty.call(combinedDetail.body.data, fieldName),
        `N6 通用详情不得暴露内部字段 ${fieldName}。`));
    assert(!JSON.stringify(combinedDetail.body.data).includes(process.env.UPLOADS_DIR), 'N6 通用详情不得暴露上传目录。');
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/errors`, undefined, combinedImportToken)).status, 200);
    assert.strictEqual((await request(server, 'GET', `/api/imports/batches/${previewOnly.body.data.batchId}/download`, undefined, combinedImportToken)).status, 200);

    assert.strictEqual((await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      batchId: previewOnly.body.data.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, previewToken)).status, 403);

    const preview = await requestMultipart(
      server,
      '/api/carbon/emission-reports/imports/preview',
      importFile,
      adminToken
    );
    assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
    assertNoCarbonEmissionReportInternalFields(preview.body);
    const rejectedWitness = await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      previewSignature: 'client-controlled'
    }, adminToken);
    assert.strictEqual(rejectedWitness.status, 400);
    assert.strictEqual(rejectedWitness.body.error.details.code, 'CARBON_EMISSION_REPORT_UNKNOWN_FIELDS_REJECTED');

    const demoExecuteRejected = await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken, { 'X-Demo-Context': 'y'.repeat(43) });
    assert.strictEqual(demoExecuteRejected.status, 409);

    const staleFile = {
      filename: 'carbon-emission-report-stale.xlsx',
      content: createCarbonEmissionReportXlsx('CER-API-STALE')
    };
    const stalePreview = await requestMultipart(
      server,
      '/api/carbon/emission-reports/imports/preview',
      staleFile,
      adminToken
    );
    assert.strictEqual(stalePreview.status, 200);
    let staleDb = openDatabase();
    try {
      const occupiedBatchId = staleDb.prepare(`INSERT INTO import_batches
        (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count, failure_count, skipped_count)
        VALUES ('carbon_emission_report', 'occupied.xlsx', 'occupied.xlsx', 'xlsx', 'completed', 1, 1, 0, 0)`).run().lastInsertRowid;
      staleDb.prepare(`INSERT INTO carbon_emission_reports
        (report_code, report_code_key, report_name, report_organization, period_start, period_end,
         source_batch_id, source_row_number)
        VALUES ('CER-API-STALE', 'CER-API-STALE', '并发占用报告', 'API测试组织', '2026-01-01', '2026-12-31', ?, 2)`)
        .run(occupiedBatchId);
    } finally {
      staleDb.close();
    }
    const staleExecute = await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      batchId: stalePreview.body.data.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(staleExecute.status, 409, JSON.stringify(staleExecute.body));
    assert.strictEqual(staleExecute.body.error.code, 'CARBON_EMISSION_REPORT_PREVIEW_STALE');
    assert.deepStrictEqual(staleExecute.body.error.details, { requiresNewPreview: true });
    assertNoCarbonEmissionReportInternalFields(staleExecute.body);
    assert(!JSON.stringify(staleExecute.body).includes('ENERGY_ANALYSIS_'));

    const executed = await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.body));
    assertNoCarbonEmissionReportInternalFields(executed.body);
    assert.deepStrictEqual(Object.keys(executed.body.data).sort(), ['batchId', 'imported', 'importedIds']);
    assert.strictEqual(executed.body.data.imported, 1);
    const reportId = executed.body.data.importedIds[0];

    const list = await request(server, 'GET', `/api/carbon/emission-reports?scope=scope_1&category=${encodeURIComponent('固定燃烧')}&reportCode=cer-api-001`, undefined, adminToken);
    assert.strictEqual(list.status, 200);
    assertNoCarbonEmissionReportInternalFields(list.body);
    assert.strictEqual(list.body.data.length, 1);
    assert.strictEqual(list.body.meta.pagination.total, 1);
    const detail = await request(server, 'GET', `/api/carbon/emission-reports/${reportId}`, undefined, viewToken);
    assert.strictEqual(detail.status, 200);
    assertNoCarbonEmissionReportInternalFields(detail.body);
    assert.strictEqual(detail.body.data.report.reportCode, 'CER-API-001');
    assert.strictEqual(detail.body.data.items.length, 2);
    const traced = await request(server, 'GET', `/api/carbon/emission-reports/batches/${preview.body.data.batchId}`, undefined, viewToken);
    assert.strictEqual(traced.status, 200);
    assertNoCarbonEmissionReportInternalFields(traced.body);
    assert.strictEqual(traced.body.data.report.id, reportId);
    const unknownQuery = await request(server, 'GET', '/api/carbon/emission-reports?unknown=1', undefined, adminToken);
    assert.strictEqual(unknownQuery.status, 400);
    assert.strictEqual(unknownQuery.body.error.details.code, 'CARBON_EMISSION_REPORT_QUERY_FIELDS_INVALID');
    const missingReport = await request(server, 'GET', '/api/carbon/emission-reports/999999999', undefined, viewToken);
    assert.strictEqual(missingReport.status, 404);
    assert.strictEqual(missingReport.body.error.code, 'NOT_FOUND');
    const oversizedJson = await request(server, 'POST', '/api/carbon/emission-reports/imports/execute', {
      padding: 'x'.repeat(70 * 1024)
    }, adminToken);
    assert.strictEqual(oversizedJson.status, 413);
    assert.strictEqual(oversizedJson.body.error.code, 'CARBON_EMISSION_REPORT_JSON_TOO_LARGE');

    const exportDenied = await request(server, 'GET', `/api/carbon/emission-reports/${reportId}/export`, undefined, viewToken);
    assert.strictEqual(exportDenied.status, 403);
    const exported = await request(server, 'GET', `/api/carbon/emission-reports/${reportId}/export`, undefined, adminToken);
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers['x-exported-row-count'], '10');
    assert(String(exported.headers['content-disposition']).includes(`filename="carbon-emission-report-${reportId}.xlsx"`));
    const exportedWorkbook = XLSX.read(exported.buffer, { type: 'buffer' });
    assert.deepStrictEqual(exportedWorkbook.SheetNames, CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name));
    assert.strictEqual(exportedWorkbook.Sheets['报告信息'].B2.v, "'=API报告名称");
    assert.strictEqual(exportedWorkbook.Sheets['报告项目'].L2.v, "'=项目备注");
    assert.strictEqual(exportedWorkbook.Sheets['证据说明'].B2.v, "'+燃气证据");
    assert.strictEqual(exportedWorkbook.Sheets['证据说明'].E2.v, "'@证据备注");
    ['E2', 'G2', 'I2', 'M2'].forEach((address) => {
      assert.strictEqual(exportedWorkbook.Sheets['报告项目'][address].t, 'n', `报告项目 ${address} 必须保持数值单元格。`);
    });
    ['D2', 'G2'].forEach((address) => {
      assert.strictEqual(exportedWorkbook.Sheets['汇总'][address].t, 'n', `汇总 ${address} 必须保持数值单元格。`);
    });

    const duplicatePreview = await requestMultipart(
      server,
      '/api/carbon/emission-reports/imports/preview',
      importFile,
      adminToken
    );
    assert.strictEqual(duplicatePreview.status, 200);
    assertNoCarbonEmissionReportInternalFields(duplicatePreview.body);
    assert.strictEqual(duplicatePreview.body.data.summary.blocked, 1);
    assert.strictEqual(duplicatePreview.body.data.summary.skipped, 0);
    assert.strictEqual(duplicatePreview.body.data.summary.wouldImport, 0);
    assert.strictEqual(duplicatePreview.body.data.items.length, 1);
    assert.strictEqual(duplicatePreview.body.data.items[0].status, 'blocked');

    // 隔离库中制造可恢复的查询故障，验证 N6 路由未知异常统一脱敏为可控 500。
    const faultDb = openDatabase();
    try {
      faultDb.exec('ALTER TABLE carbon_emission_reports RENAME TO carbon_emission_reports_fault_probe');
    } finally {
      faultDb.close();
    }
    const controlledFailure = await request(server, 'GET', '/api/carbon/emission-reports', undefined, adminToken);
    assert.strictEqual(controlledFailure.status, 500);
    assert.strictEqual(controlledFailure.body.error.code, 'CARBON_EMISSION_REPORT_INTERNAL_ERROR');
    assert.strictEqual(controlledFailure.body.error.message, '碳排放报告服务暂时不可用。');
    assert(!JSON.stringify(controlledFailure.body).includes('no such table'));
    assert(!JSON.stringify(controlledFailure.body).includes(process.env.SQLITE_PATH));
    const restoreDb = openDatabase();
    try {
      restoreDb.exec('ALTER TABLE carbon_emission_reports_fault_probe RENAME TO carbon_emission_reports');
    } finally {
      restoreDb.close();
    }

    console.log('carbonEmissionReportApi tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
