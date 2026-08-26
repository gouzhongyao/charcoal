'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

// 路由测试使用随机端口、临时目录和隔离 SQLite。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-supplier-routes-'));
process.env.DATA_DIR = path.join(tempDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'supplier-routes.sqlite');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tempDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'SupplierRoutes123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'supplier-routes-test-hmac-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const supplierRoutes = require('../routes/suppliers');
const templateRoutes = require('../routes/templates');
const { login, register } = require('../services/authService');
const { runWithMaintenance } = require('../services/maintenanceState');
const { SUPPLIER_IMPORT_CONFIRM_TEXT, SUPPLIER_IMPORT_HEADERS } = require('../services/supplierService');

/** 发起 JSON 请求并兼容二进制响应。 */
function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = rawBody.length;
    }
    const clientRequest = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: pathname, headers
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
          body: contentType.includes('application/json') && buffer.length ? JSON.parse(buffer.toString('utf8')) : null
        });
      });
    });
    clientRequest.on('error', reject);
    if (rawBody) clientRequest.write(rawBody);
    clientRequest.end();
  });
}

/** 发起单文件 multipart 供应商预演请求。 */
function requestMultipart(server, pathname, file, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----supplier-route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`, 'utf8'),
      file.content,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const clientRequest = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, body: buffer.length ? JSON.parse(buffer.toString('utf8')) : null });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(body);
  });
}

/** 构造固定 Excel v1 供应商文件。 */
function createSupplierXlsx(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SUPPLIER_IMPORT_HEADERS, ...rows]), '供应商');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 向普通账号授予明确权限，不复制其他供应商节点。 */
function grantPermissions(userId, permissionCodes) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const roleId = Number(db.prepare(`INSERT INTO sys_roles
      (role_code, role_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(`supplier-route-${userId}`, `供应商路由角色 ${userId}`, now, now).lastInsertRowid);
    const insertGrant = db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    permissionCodes.forEach((permissionCode) => {
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      assert(menu, `权限菜单 ${permissionCode} 必须存在。`);
      insertGrant.run(roleId, menu.id, now);
    });
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(userId, roleId, now);
  } finally {
    db.close();
  }
}

(async () => {
  let server;
  try {
    initDatabase();
    const ordinaryUser = register({ username: 'supplierordinary', password: 'SupplierOrdinary123!', displayName: '供应商普通账号' });
    const ordinaryToken = login({ username: 'supplierordinary', password: 'SupplierOrdinary123!' }).token;
    const adminToken = login({ username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }).token;

    const app = express();
    // 自带解析器的供应商路由必须位于全局 JSON 解析器之前。
    app.use('/api/suppliers', supplierRoutes);
    app.use('/api/templates', templateRoutes);
    app.use(express.json({ limit: '2mb' }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    assert.strictEqual((await request(server, 'GET', '/api/suppliers')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/suppliers', undefined, ordinaryToken)).status, 403);
    assert.strictEqual((await request(server, 'POST', '/api/suppliers', { supplierCode: 'DENIED', supplierName: '无权限' }, ordinaryToken)).status, 403);

    grantPermissions(ordinaryUser.id, ['ledger:suppliers:create']);
    assert.strictEqual((await request(server, 'GET', '/api/suppliers', undefined, ordinaryToken)).status, 403, '新增权限不得隐式获得查看权限。');
    const created = await request(server, 'POST', '/api/suppliers', {
      supplierCode: 'SUP-ROUTE-001', supplierName: '路由供应商', contactPhone: '0010-22 +86 转 8'
    }, ordinaryToken);
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.data.contactPhone, '0010-22 +86 转 8');

    await runWithMaintenance('supplier-route-maintenance', async () => {
      const blocked = await request(server, 'POST', '/api/suppliers', {
        supplierCode: 'SUP-LOCKED', supplierName: '维护态阻断'
      }, ordinaryToken);
      assert.strictEqual(blocked.status, 423);
      assert.strictEqual(blocked.body.error.code, 'MAINTENANCE_IN_PROGRESS');
    });

    // super_admin 后端兜底可访问全部供应商路由，普通编辑含 status 必须 fail-closed。
    const list = await request(server, 'GET', '/api/suppliers?page=1&pageSize=20', undefined, adminToken);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.meta.pagination.total, 1);
    const supplierId = created.body.data.id;

    // 真实列表和导出接口必须按服务端规范键识别大小写与 NFKC 变体，同时保留内部空白差异。
    const internalWhitespaceCreated = await request(server, 'POST', '/api/suppliers', {
      supplierCode: 'Sup -Route-001', supplierName: '内部空白路由供应商'
    }, adminToken);
    assert.strictEqual(internalWhitespaceCreated.status, 201);
    for (const keyword of ['Sup-Route-001', 'sup-route-001', 'ＳＵＰ－ＲＯＵＴＥ－００１']) {
      const keywordList = await request(
        server,
        'GET',
        `/api/suppliers?keyword=${encodeURIComponent(keyword)}`,
        undefined,
        adminToken
      );
      assert.strictEqual(keywordList.status, 200);
      assert.deepStrictEqual(keywordList.body.data.map((row) => row.id), [supplierId]);
    }
    const internalWhitespaceList = await request(
      server,
      'GET',
      `/api/suppliers?keyword=${encodeURIComponent('Sup -Route-001')}`,
      undefined,
      adminToken
    );
    assert.deepStrictEqual(
      internalWhitespaceList.body.data.map((row) => row.id),
      [internalWhitespaceCreated.body.data.id]
    );
    const filteredExport = await request(
      server,
      'GET',
      `/api/suppliers/export.xlsx?keyword=${encodeURIComponent('ＳＵＰ－ＲＯＵＴＥ－００１')}`,
      undefined,
      adminToken
    );
    assert.strictEqual(filteredExport.status, 200);
    assert.strictEqual(filteredExport.headers['x-exported-row-count'], '1');
    const filteredExportSheet = XLSX.read(filteredExport.buffer, { type: 'buffer' }).Sheets['供应商'];
    assert.strictEqual(filteredExportSheet.A2.v, 'SUP-ROUTE-001');

    const rejectedStatusEdit = await request(server, 'PATCH', `/api/suppliers/${supplierId}`, { status: 'inactive' }, adminToken);
    assert.strictEqual(rejectedStatusEdit.status, 400);
    assert.strictEqual(rejectedStatusEdit.body.error.details.code, 'SUPPLIER_STATUS_UPDATE_REQUIRES_DEDICATED_ENDPOINT');
    const kickedOut = await request(server, 'PATCH', `/api/suppliers/${supplierId}/status`, { status: 'inactive' }, adminToken);
    assert.strictEqual(kickedOut.status, 200);
    assert.strictEqual(kickedOut.body.data.status, 'inactive');
    assert.strictEqual((await request(server, 'DELETE', `/api/suppliers/${supplierId}`, undefined, adminToken)).status, 404);

    // 固定模板和导出均受独立权限保护，管理员下载内容为 XLSX。
    assert.strictEqual((await request(server, 'GET', '/api/templates/suppliers.xlsx', undefined, ordinaryToken)).status, 403);
    const template = await request(server, 'GET', '/api/templates/suppliers.xlsx', undefined, adminToken);
    assert.strictEqual(template.status, 200);
    assert(template.buffer.length > 0);
    const exported = await request(server, 'GET', '/api/suppliers/export.xlsx', undefined, adminToken);
    assert.strictEqual(exported.status, 200);
    assert(exported.buffer.length > 0);

    // preview 操作审计故障必须回滚批次和问题，并由路由清理未被批次引用的上传文件。
    let db = openDatabase();
    const batchesBeforeAuditFailure = db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total;
    const issuesBeforeAuditFailure = db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total;
    db.exec(`CREATE TRIGGER supplier_preview_audit_failure
      BEFORE INSERT ON sys_operation_logs
      WHEN NEW.operation = 'supplier.import.preview'
      BEGIN
        SELECT RAISE(ABORT, 'private supplier preview audit failure');
      END;`);
    db.close();
    const uploadsBeforeAuditFailure = fs.readdirSync(process.env.UPLOADS_DIR).sort();
    const auditFailureResponse = await requestMultipart(server, '/api/suppliers/imports/preview', {
      filename: '供应商审计故障.xlsx',
      content: createSupplierXlsx([['SUP-AUDIT-ROUTE', '路由审计故障', '', '', '', '', '未知状态']])
    }, adminToken);
    assert.strictEqual(auditFailureResponse.status, 500);
    assert.deepStrictEqual(fs.readdirSync(process.env.UPLOADS_DIR).sort(), uploadsBeforeAuditFailure, '失败且无批次引用的上传文件必须清理。');
    db = openDatabase();
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total, batchesBeforeAuditFailure);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total, issuesBeforeAuditFailure);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'supplier.import.preview'").get().total, 0);
    db.exec('DROP TRIGGER supplier_preview_audit_failure');
    db.close();

    // 预演、客户端见证拒绝和最小正文执行完整走真实 HTTP 安全链。
    const importFile = {
      filename: '供应商路由导入.xlsx',
      content: createSupplierXlsx([['SUP-ROUTE-IMPORT', '路由导入供应商', '', '', '0001 +86-33', '', '在库']])
    };
    assert.strictEqual((await requestMultipart(server, '/api/suppliers/imports/preview', importFile)).status, 401);
    assert.strictEqual((await requestMultipart(server, '/api/suppliers/imports/preview', importFile, ordinaryToken)).status, 403);
    const preview = await requestMultipart(server, '/api/suppliers/imports/preview', importFile, adminToken);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.data.summary.wouldImport, 1);
    const rejectedWitness = await request(server, 'POST', '/api/suppliers/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true,
      candidateRows: [{ supplierCode: 'ATTACKER' }]
    }, adminToken);
    assert.strictEqual(rejectedWitness.status, 400);
    assert.strictEqual(rejectedWitness.body.error.details.code, 'SUPPLIER_IMPORT_CLIENT_WITNESS_REJECTED');
    const executed = await request(server, 'POST', '/api/suppliers/imports/execute', {
      batchId: preview.body.data.batchId,
      confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(executed.status, 200);
    assert.strictEqual(executed.body.data.imported, 1);

    db = openDatabase();
    const imported = db.prepare("SELECT contact_phone AS phone FROM suppliers WHERE supplier_code = 'SUP-ROUTE-IMPORT'").get();
    assert.strictEqual(imported.phone, '0001 +86-33');
    assert(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE target_type = 'supplier'").get().total >= 4);
    db.close();

    console.log('供应商 HTTP 认证、RBAC、维护态和受控导入测试通过。');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
