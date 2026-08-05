const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-auth-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data'); process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'routes.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads'); process.env.BACKUPS_DIR = path.join(tmpDir, 'backups'); process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
const { initDatabase, openDatabase } = require('../db/database');
initDatabase();
const fixtureDb = openDatabase();
const fixtureNow = new Date().toISOString();
const energyTypeId = fixtureDb.prepare(`INSERT INTO energy_types (code, name, category, default_unit, standard_unit, is_active, display_order, created_at, updated_at)
  VALUES ('test-electricity', '测试电力', 'energy', 'kWh', 'kWh', 1, 1, ?, ?)`).run(fixtureNow, fixtureNow).lastInsertRowid;
const organizationUnitId = fixtureDb.prepare(`INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
  VALUES ('TEST-OU', '测试组织单元', '测试集团/测试组织单元', 'department', 'active', ?, ?)`).run(fixtureNow, fixtureNow).lastInsertRowid;
const meterDeviceId = fixtureDb.prepare(`INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, install_location, status, created_at, updated_at)
  VALUES ('TEST-METER-01', 'Alpha 测试仪表', 'electricity', ?, ?, '甲地点配电室', 'active', ?, ?)`).run(energyTypeId, organizationUnitId, fixtureNow, fixtureNow).lastInsertRowid;
fixtureDb.prepare(`INSERT INTO energy_records (
  energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month,
  original_unit, original_value, normalized_unit, normalized_value, organization, site,
  department, production_line, meter_code, business_dimension, remark, duplicate_key,
  record_status, created_at, updated_at
) VALUES (?, ?, ?, '2026-08', '2026-08', 'kWh', 12, 'kWh', 12, '华北组织', '甲地点',
  '生产部', '一线', 'IMPORT-E-01', 'monthly-energy', 'Alpha 导出检索备注', 'auth-route-energy-record',
  'active', ?, ?)`).run(energyTypeId, organizationUnitId, meterDeviceId, fixtureNow, fixtureNow);
fixtureDb.close();
const { app } = require('../index');
function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ port: server.address().port, host: '127.0.0.1', method, path: pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); }); res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson ? JSON.parse(raw.toString('utf8')) : raw });
      });
    }); req.on('error', reject); req.end(raw);
  });
}
(async () => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const denied = await request(server, 'GET', '/api/users');
    assert.strictEqual(denied.status, 401); assert.strictEqual(denied.body.error.code, 'UNAUTHENTICATED');
    const energyDenied = await request(server, 'GET', '/api/energy-records?keyword=Alpha');
    assert.strictEqual(energyDenied.status, 401); assert.strictEqual(energyDenied.body.error.code, 'UNAUTHENTICATED');
    const exportDenied = await request(server, 'GET', '/api/energy-records/export?format=csv');
    assert.strictEqual(exportDenied.status, 401); assert.strictEqual(exportDenied.body.error.code, 'UNAUTHENTICATED');
    const signedIn = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    assert.strictEqual(signedIn.status, 200); assert(signedIn.body.data.token);
    const token = signedIn.body.data.token;
    const keywordList = await request(server, 'GET', `/api/energy-records?organization=${encodeURIComponent('华北组织')}&keyword=Alpha`, null, token);
    assert.strictEqual(keywordList.status, 200);
    assert.strictEqual(keywordList.body.data.length, 1);
    assert.strictEqual(keywordList.body.data[0].meterDeviceName, 'Alpha 测试仪表');
    const injectionList = await request(server, 'GET', `/api/energy-records?keyword=${encodeURIComponent("Alpha' OR 1=1 --")}`, null, token);
    assert.strictEqual(injectionList.status, 200);
    assert.strictEqual(injectionList.body.data.length, 0, 'keyword 必须作为参数绑定，不能扩大查询范围。');
    const exportCsv = await request(server, 'GET', `/api/energy-records/export?format=csv&organization=${encodeURIComponent('华北组织')}&keyword=Alpha`, null, token);
    assert.strictEqual(exportCsv.status, 200);
    assert.strictEqual(exportCsv.headers['content-type'], 'text/csv; charset=utf-8');
    assert.strictEqual(exportCsv.headers['x-export-row-count'], '1');
    assert(String(exportCsv.headers['content-disposition']).includes("filename*=UTF-8''"));
    assert(exportCsv.body.toString('utf8').includes('能耗记录ID'));
    assert(exportCsv.body.toString('utf8').includes('Alpha 测试仪表'));
    assert(!exportCsv.body.toString('utf8').includes(tmpDir), '导出字段不得泄露服务器临时路径。');
    const exportXlsx = await request(server, 'GET', '/api/energy-records/export?format=xlsx&keyword=Alpha', null, token);
    assert.strictEqual(exportXlsx.status, 200);
    assert.strictEqual(exportXlsx.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert(exportXlsx.body.length > 100);
    const info = await request(server, 'GET', '/api/getInfo', null, token);
    assert.strictEqual(info.status, 200); assert.strictEqual(info.body.data.username, 'admin');
    const users = await request(server, 'GET', '/api/users', null, token);
    assert.strictEqual(users.status, 200); assert(users.body.data.some((user) => user.username === 'admin'));
    const systemUsers = await request(server, 'GET', '/api/system/users', null, token);
    assert.strictEqual(systemUsers.status, 200); assert(systemUsers.body.data.some((user) => user.username === 'admin'));
    assert.strictEqual((await request(server, 'GET', '/api/roles', null, token)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/system/roles', null, token)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/menus', null, token)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/system/menus', null, token)).status, 200);
    const created = await request(server, 'POST', '/api/system/users', { username: 'routeuser', displayName: '路由用户', password: 'Password123!', roleIds: [2] }, token);
    assert.strictEqual(created.status, 201);
    const targetId = created.body.data.id;
    const targetSession = await request(server, 'POST', '/api/login', { username: 'routeuser', password: 'Password123!' });
    assert.strictEqual(targetSession.status, 200);
    const ordinaryEnergyList = await request(server, 'GET', '/api/energy-records?keyword=Alpha', null, targetSession.body.data.token);
    assert.strictEqual(ordinaryEnergyList.status, 403); assert.strictEqual(ordinaryEnergyList.body.error.code, 'FORBIDDEN');
    const ordinaryEnergyExport = await request(server, 'GET', '/api/energy-records/export?format=csv', null, targetSession.body.data.token);
    assert.strictEqual(ordinaryEnergyExport.status, 403); assert.strictEqual(ordinaryEnergyExport.body.error.code, 'FORBIDDEN');
    const reset = await request(server, 'PUT', `/api/users/${targetId}/reset-password`, { newPassword: 'ChangedPassword123!' }, token);
    assert.strictEqual(reset.status, 200); assert.strictEqual(reset.body.data.revokedSessionCount, 1);
    const revokedProfile = await request(server, 'GET', '/api/getInfo', null, targetSession.body.data.token);
    assert.strictEqual(revokedProfile.status, 401);
    assert.strictEqual((await request(server, 'POST', '/api/login', { username: 'routeuser', password: 'ChangedPassword123!' })).status, 200);
    const auditDb = openDatabase();
    const audit = auditDb.prepare("SELECT detail_json AS detailJson FROM sys_operation_logs WHERE operation = 'system.user.reset-password'").get();
    auditDb.close();
    assert(audit && !audit.detailJson.includes('Password') && !audit.detailJson.includes('password'), '重置密码审计不得保存密码。');
    const logout = await request(server, 'POST', '/api/logout', {}, token);
    assert.strictEqual(logout.status, 200);
    const expired = await request(server, 'GET', '/api/getInfo', null, token);
    assert.strictEqual(expired.status, 401);
    console.log('auth route tests passed');
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(tmpDir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
