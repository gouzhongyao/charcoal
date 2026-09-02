const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-carbon-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'carbon-api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { getImportAuditBatchDetail } = require('../services/importAuditService');
const { register } = require('../services/authService');

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf8')) : bodyBuffer });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function grantViewRole(username, permissionCode) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    const roleId = db.prepare(`INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(`${username}-${permissionCode.replaceAll(':', '-')}`, `${username} 查看角色`, now, now).lastInsertRowid;
    const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
    assert(menu, `缺少 ${permissionCode} 菜单权限种子`);
    db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)').run(roleId, menu.id, now);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----carbon-factor-${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    register({ username: 'carbon-reader', password: 'Password123!' });
    register({ username: 'carbon-factor-reader', password: 'Password123!' });
    register({ username: 'carbon-emission-reader', password: 'Password123!' });
    grantViewRole('carbon-factor-reader', 'carbon:factors:view');
    grantViewRole('carbon-emission-reader', 'carbon:emissions:view');
    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const adminLogin = await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' });
    const readerLogin = await request(server, 'POST', '/api/login', { username: 'carbon-reader', password: 'Password123!' });
    const adminToken = adminLogin.body.data.token;
    const readerToken = readerLogin.body.data.token;
    const factorToken = (await request(server, 'POST', '/api/login', { username: 'carbon-factor-reader', password: 'Password123!' })).body.data.token;
    const emissionToken = (await request(server, 'POST', '/api/login', { username: 'carbon-emission-reader', password: 'Password123!' })).body.data.token;

    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors')).status, 401, '碳因子列表必须拒绝匿名访问。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, readerToken)).status, 403, '无因子权限用户必须被服务端拒绝。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, factorToken)).status, 200, '仅因子查看角色必须能读取因子列表。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/emissions', undefined, factorToken)).status, 403, '仅因子查看角色不得读取排放列表。');
    for (const pathname of ['/api/carbon/emissions/stats', '/api/carbon/emissions/statistics', '/api/carbon/emissions/missing-factors']) {
      assert.strictEqual((await request(server, 'GET', pathname, undefined, factorToken)).status, 403, `仅因子查看角色不得读取 ${pathname}。`);
    }
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, emissionToken)).status, 403, '仅排放查看角色不得读取因子列表。');
    for (const pathname of ['/api/carbon/emissions', '/api/carbon/emissions/stats', '/api/carbon/emissions/statistics', '/api/carbon/emissions/missing-factors']) {
      assert.strictEqual((await request(server, 'GET', pathname, undefined, emissionToken)).status, 200, `仅排放查看角色必须能读取 ${pathname}。`);
    }
    const factorContractResponse = await request(server, 'GET', '/api/carbon/contract', undefined, factorToken);
    assert.strictEqual(factorContractResponse.status, 200, '任一碳查看角色必须能读取通用契约。');
    // 内部契约字段与用户可见模板标题必须分别保持稳定。
    const expectedFactorFields = ['energyTypeCode', 'region', 'factorYear', 'unit', 'factorValue', 'factorUnit', 'source', 'sourceUrl', 'effectiveFrom', 'effectiveTo', 'status'];
    const expectedFactorHeaders = ['能源类型编码', '地区', '因子年份', '活动数据单位', '因子值', '排放单位', '因子来源', '来源链接', '有效开始日期', '有效结束日期', '状态'];
    assert.deepStrictEqual(factorContractResponse.body.data.factorFields, expectedFactorFields, '碳因子内部 API 契约字段必须保持英文 JSON key，不得被中文模板标题替换。');
    assert.deepStrictEqual(factorContractResponse.body.data.factors.export.fields.map((field) => field.key), expectedFactorFields, '碳因子导出契约 key 必须保持内部 JSON 字段。');
    assert.deepStrictEqual(factorContractResponse.body.data.factors.template.headers, expectedFactorHeaders, '碳因子模板契约必须单独使用中文用户标题。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/contract', undefined, emissionToken)).status, 200, '任一碳查看角色必须能读取通用契约。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors', undefined, adminToken)).status, 200, '超级管理员必须绕过细粒度碳权限。');
    assert.strictEqual((await request(server, 'GET', '/api/templates/carbon-factors.csv')).status, 401, '碳因子模板必须拒绝匿名下载。');
    assert.strictEqual((await request(server, 'GET', '/api/templates/carbon-factors.csv', undefined, readerToken)).status, 403, '碳因子模板必须拒绝无权限用户。');
    const template = await request(server, 'GET', '/api/templates/carbon-factors.csv', undefined, adminToken);
    assert.strictEqual(template.status, 200);
    assert.strictEqual(template.headers['x-template-type'], 'carbon-factors');
    assert(template.body.toString('utf8').startsWith('﻿"能源类型编码","地区","因子年份","活动数据单位","因子值","排放单位","因子来源","来源链接","有效开始日期","有效结束日期","状态"'), '碳因子模板必须使用中文字段头。');

    const created = await request(server, 'POST', '/api/carbon/factors', {
      energyTypeCode: 'electricity', region: 'default', factorYear: 2028, unit: 'kWh', factorValue: 0.5, factorUnit: 'kg CO₂e', source: 'API 测试因子', status: 'active'
    }, adminToken);
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.data.factorUnit, 'kgCO2e', 'create 必须在写入前规范化合法单位别名。');
    const factorId = created.body.data.id;
    assert.strictEqual((await request(server, 'GET', `/api/carbon/factors/${factorId}`, undefined, factorToken)).status, 200, '仅因子查看角色必须能读取因子详情。');
    assert.strictEqual((await request(server, 'GET', `/api/carbon/factors/${factorId}`, undefined, emissionToken)).status, 403, '仅排放查看角色不得读取因子详情。');
    assert.strictEqual((await request(server, 'GET', `/api/carbon/factors/${factorId}`, undefined, adminToken)).body.data.status, 'active');

    const defaultUnitCreated = await request(server, 'POST', '/api/carbon/factors', {
      energyTypeCode: 'coal', region: 'default', factorYear: 2029, unit: 't', factorValue: 0.6,
      source: 'API 缺省单位因子', status: 'active'
    }, adminToken);
    assert.strictEqual(defaultUnitCreated.status, 201);
    assert.strictEqual(defaultUnitCreated.body.data.factorUnit, 'kgCO2e', '仅字段完全缺失时 create 才可采用默认单位。');
    for (const invalidUnit of ['', null, {}, []]) {
      const rejected = await request(server, 'POST', '/api/carbon/factors', {
        energyTypeCode: 'heat', region: 'default', factorYear: 2029, unit: 'MJ', factorValue: 0.1,
        factorUnit: invalidUnit, source: `API 非法单位-${typeof invalidUnit}`, status: 'active'
      }, adminToken);
      assert.strictEqual(rejected.status, 400);
      assert.strictEqual(rejected.body.error.code, 'CARBON_EMISSION_UNIT_INVALID');
      assert.deepStrictEqual(Object.keys(rejected.body.error.details).sort(), ['field', 'reason']);
      assert.strictEqual(JSON.stringify(rejected.body.error).includes('API 非法单位'), false);
    }

    const aliasUpdated = await request(server, 'PUT', `/api/carbon/factors/${factorId}`, {
      factor_unit: 't CO2e / MWh'
    }, adminToken);
    assert.strictEqual(aliasUpdated.status, 200);
    assert.strictEqual(aliasUpdated.body.data.factorUnit, 'tCO2e/MWh');
    const preservedUnit = await request(server, 'PUT', `/api/carbon/factors/${factorId}`, {
      factorValue: 0.5
    }, adminToken);
    assert.strictEqual(preservedUnit.status, 200);
    assert.strictEqual(preservedUnit.body.data.factorUnit, 'tCO2e/MWh');
    const explicitEmptyUpdate = await request(server, 'PUT', `/api/carbon/factors/${factorId}`, {
      factorUnit: ''
    }, adminToken);
    assert.strictEqual(explicitEmptyUpdate.status, 400);
    assert.strictEqual(explicitEmptyUpdate.body.error.code, 'CARBON_EMISSION_UNIT_INVALID');
    const restoreUnit = await request(server, 'PUT', `/api/carbon/factors/${factorId}`, {
      factorUnit: 'kgCO2e'
    }, adminToken);
    assert.strictEqual(restoreUnit.status, 200);

    let invalidHistoricalFactorId;
    const db = openDatabase();
    try {
      const electricityId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const organizationUnitId = db.prepare(`INSERT INTO organization_units
        (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
        VALUES ('CARBON-API-OU', '碳统计组织', '/CARBON-API-OU', 'department', 'active', datetime('now'), datetime('now'))`).run().lastInsertRowid;
      const meterDeviceId = db.prepare(`INSERT INTO meter_devices
        (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, install_location, status, created_at, updated_at)
        VALUES ('CARBON-API-METER', '碳统计电表', 'electricity', ?, ?, '碳统计厂区', 'active', datetime('now'), datetime('now'))`)
        .run(electricityId, organizationUnitId).lastInsertRowid;
      db.prepare(`INSERT INTO energy_records (
        energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month,
        original_unit, original_value, normalized_unit, normalized_value, remark, duplicate_key,
        record_status, created_at, updated_at
      ) VALUES (?, ?, ?, '2028-01', '2028-01', 'kWh', 100, 'kWh', 100,
        '碳统计部门', 'carbon-api-energy-record', 'active', datetime('now'), datetime('now'))`)
        .run(electricityId, organizationUnitId, meterDeviceId);
      invalidHistoricalFactorId = Number(db.prepare(`INSERT INTO carbon_factors
        (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
        VALUES (?, 'default', 2031, 'kWh', 0.7, 'legacyUnit', 'API 历史非法单位', 1)`)
        .run(electricityId).lastInsertRowid);
    } finally { db.close(); }

    const invalidHistoricalUpdate = await request(server, 'PUT', `/api/carbon/factors/${invalidHistoricalFactorId}`, {
      factorValue: 0.8
    }, adminToken);
    assert.strictEqual(invalidHistoricalUpdate.status, 409);
    assert.strictEqual(invalidHistoricalUpdate.body.error.code, 'CARBON_FACTOR_UNIT_INVALID');
    assert.deepStrictEqual(invalidHistoricalUpdate.body.error.details, { factorId: invalidHistoricalFactorId });
    assert.strictEqual(JSON.stringify(invalidHistoricalUpdate.body.error).includes('legacyUnit'), false);
    const repairedHistorical = await request(server, 'PUT', `/api/carbon/factors/${invalidHistoricalFactorId}`, {
      factor_unit: 'kg CO₂e / kWh'
    }, adminToken);
    assert.strictEqual(repairedHistorical.status, 200);
    assert.strictEqual(repairedHistorical.body.data.factorUnit, 'kgCO2e/kWh');

    const calculated = await request(server, 'POST', '/api/carbon/emissions/calculate', { normalizedMonth: '2028-01' }, adminToken);
    assert.strictEqual(calculated.status, 201);
    assert.strictEqual(calculated.body.data.calculatedCount, 1);
    const emissions = await request(server, 'GET', '/api/carbon/emissions?normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(emissions.status, 200);
    assert.strictEqual(emissions.body.meta.pagination.total, 1);
    const emissionId = emissions.body.data[0].id;

    const stats = await request(server, 'GET', '/api/carbon/emissions/stats?normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.data.totalRecords, 1);
    assert.strictEqual(stats.body.data.calculatedCount, 1);
    assert.strictEqual(stats.body.data.byMonth[0].normalizedMonth, '2028-01');
    assert.strictEqual(stats.body.data.byEnergyType[0].energyTypeCode, 'electricity');
    assert.strictEqual(stats.body.data.byOrganizationUnit[0].organizationUnitCode, 'CARBON-API-OU');
    assert.strictEqual(stats.body.data.byOrganizationUnit[0].organizationUnitName, '碳统计组织');
    assert.strictEqual(stats.body.data.totalsByEmissionUnit[0].totalEmissionValue, 50);

    let invalidCalculationFactorId;
    const invalidCalculationDb = openDatabase();
    try {
      const electricityId = invalidCalculationDb.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const organizationUnitId = invalidCalculationDb.prepare("SELECT id FROM organization_units WHERE unit_code = 'CARBON-API-OU'").get().id;
      const meterDeviceId = invalidCalculationDb.prepare("SELECT id FROM meter_devices WHERE meter_code = 'CARBON-API-METER'").get().id;
      invalidCalculationFactorId = Number(invalidCalculationDb.prepare(`INSERT INTO carbon_factors
        (energy_type_id, region, factor_year, unit, factor_value, factor_unit, source, is_active)
        VALUES (?, 'default', 2032, 'kWh', 0.9, 'PRIVATE_LEGACY_UNIT', 'API 计算非法单位', 1)`)
        .run(electricityId).lastInsertRowid);
      invalidCalculationDb.prepare(`INSERT INTO energy_records (
        energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month,
        original_unit, original_value, normalized_unit, normalized_value, duplicate_key, record_status
      ) VALUES (?, ?, ?, '2032-01', '2032-01', 'kWh', 10, 'kWh', 10,
        'carbon-api-invalid-unit-record', 'active')`)
        .run(electricityId, organizationUnitId, meterDeviceId);
    } finally { invalidCalculationDb.close(); }
    const invalidCalculation = await request(server, 'POST', '/api/carbon/emissions/calculate', {
      normalizedMonth: '2032-01'
    }, adminToken);
    assert.strictEqual(invalidCalculation.status, 409);
    assert.strictEqual(invalidCalculation.body.error.code, 'CARBON_FACTOR_UNIT_INVALID');
    assert.deepStrictEqual(invalidCalculation.body.error.details, { factorId: invalidCalculationFactorId });
    assert.strictEqual(JSON.stringify(invalidCalculation.body.error).includes('PRIVATE_LEGACY_UNIT'), false);
    const invalidCalculationCheckDb = openDatabase();
    try {
      assert.strictEqual(invalidCalculationCheckDb.prepare(`SELECT COUNT(*) AS total FROM carbon_emissions ce
        JOIN energy_records er ON er.id = ce.energy_record_id WHERE er.normalized_month = '2032-01'`).get().total, 0);
    } finally { invalidCalculationCheckDb.close(); }

    const safeKeyword = await request(server, 'GET', '/api/carbon/factors?keyword=%25', undefined, adminToken);
    assert.strictEqual(safeKeyword.status, 200);
    assert.strictEqual(safeKeyword.body.meta.pagination.total, 0, 'LIKE 通配符必须被转义，不能扩大因子查询。');
    const safeEmissionKeyword = await request(server, 'GET', '/api/carbon/emissions?keyword=%25', undefined, adminToken);
    assert.strictEqual(safeEmissionKeyword.status, 200);
    assert.strictEqual(safeEmissionKeyword.body.meta.pagination.total, 0, 'LIKE 通配符必须被转义，不能扩大排放查询。');
    assert.strictEqual((await request(server, 'GET', '/api/carbon/factors?factorYear=2028%3BDROP%20TABLE%20carbon_factors', undefined, adminToken)).status, 400, '年份注入输入必须被拒绝。');

    const statusChange = await request(server, 'PATCH', `/api/carbon/factors/${factorId}/status`, { status: 'inactive' }, adminToken);
    assert.strictEqual(statusChange.status, 200);
    assert.strictEqual(statusChange.body.data.status, 'inactive');
    const historyDb = openDatabase();
    try {
      const historical = historyDb.prepare('SELECT id, carbon_factor_id AS carbonFactorId, factor_value AS factorValue, emission_value AS emissionValue, status FROM carbon_emissions WHERE id = ?').get(emissionId);
      assert.strictEqual(historical.carbonFactorId, factorId, '停用因子不得断开历史排放关联。');
      assert.strictEqual(historical.factorValue, 0.5, '停用因子不得篡改历史快照因子值。');
      assert.strictEqual(historical.emissionValue, 50, '停用因子不得篡改历史排放结果。');
      assert.strictEqual(historical.status, 'calculated');
    } finally { historyDb.close(); }

    const englishCsv = 'energyTypeCode,region,factorYear,unit,factorValue,factorUnit,source,sourceUrl,effectiveFrom,effectiveTo,status\ncoal,default,2028,t,0.3,kg CO₂e / (kWh),英文表头兼容来源,,,,active\n';
    const englishPreviewResponse = await multipart(server, '/api/carbon/factors/import/preview', 'carbon-factors-english.csv', englishCsv, adminToken);
    assert.strictEqual(englishPreviewResponse.status, 200);
    assert.strictEqual(englishPreviewResponse.body.data.summary.wouldImport, 1, '碳因子导入必须继续兼容旧英文表头。');
    assert.strictEqual(englishPreviewResponse.body.data.candidateRows[0].factorUnit, 'kgCO2e/kWh');

    const invalidImportCsv = '能源类型编码,地区,因子年份,活动数据单位,因子值,排放单位,因子来源,来源链接,有效开始日期,有效结束日期,状态\nheat,default,2029,MJ,0.1,,导入空单位来源,,,,active\nheat,default,2030,MJ,0.2,kgCO2e/GJ,导入非法单位来源,,,,active\n';
    const invalidImportPreview = await multipart(server, '/api/carbon/factors/import/preview', 'carbon-factors-invalid-unit.csv', invalidImportCsv, adminToken);
    assert.strictEqual(invalidImportPreview.status, 200);
    assert.strictEqual(invalidImportPreview.body.data.summary.wouldImport, 0);
    assert.strictEqual(invalidImportPreview.body.data.summary.blocked, 2);
    invalidImportPreview.body.data.items.forEach((item) => {
      assert(item.reasonCodes.includes('CARBON_EMISSION_UNIT_INVALID'));
      assert.strictEqual(JSON.stringify(item.reasons).includes('kgCO2e/GJ'), false);
    });

    const csv = '能源类型编码,地区,因子年份,活动数据单位,因子值,排放单位,因子来源,来源链接,有效开始日期,有效结束日期,状态\nheat,default,2028,MJ,0.1,t CO₂e / m³,导入测试来源,,, ,active\nheat,default,2028,MJ,0.2,tCO2e/m3,导入测试来源,,,,active\n';
    const previewResponse = await multipart(server, '/api/carbon/factors/import/preview', 'carbon-factors.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.summary.wouldImport, 1);
    assert.strictEqual(preview.summary.skipped, 1);
    assert.strictEqual(preview.writesCarbonFactors, false);
    assert.strictEqual(preview.writesCarbonEmissions, false);
    assert.strictEqual(preview.candidateRows[0].factorUnit, 'tCO2e/m3');
    const tamperedExecute = await request(server, 'POST', '/api/carbon/factors/import/execute', {
      confirmText: preview.confirmText,
      previewSignature: preview.previewSignature,
      expectedWouldImport: preview.summary.wouldImport,
      candidateRowIds: preview.candidateRowIds,
      candidateRows: preview.candidateRows.map((row) => ({ ...row, factorUnit: 'kgCO2e/GJ' })),
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(tamperedExecute.status, 400);
    assert.strictEqual(tamperedExecute.body.error.code, 'CARBON_EMISSION_UNIT_INVALID');
    assert.deepStrictEqual(Object.keys(tamperedExecute.body.error.details).sort(), ['field', 'reason']);
    assert.strictEqual(JSON.stringify(tamperedExecute.body.error).includes('kgCO2e/GJ'), false);
    const auditPreview = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditPreview.importType, 'carbon_factor');
    assert.strictEqual(auditPreview.auditPhase, 'preview');
    assert.strictEqual(auditPreview.issueCounts.warning, 1);

    const execute = await request(server, 'POST', '/api/carbon/factors/import/execute', {
      batchId: preview.batchId,
      confirmText: preview.confirmText,
      previewSignature: preview.previewSignature,
      expectedWouldImport: preview.summary.wouldImport,
      candidateRowIds: preview.candidateRowIds,
      candidateRows: preview.candidateRows,
      requireBackup: true,
      acknowledgeSkippedRisks: true
    }, adminToken);
    assert.strictEqual(execute.status, 200);
    assert.strictEqual(execute.body.data.imported, 1);
    assert.strictEqual(execute.body.data.importedRecords.length, 1);
    assert.strictEqual(execute.body.data.importedRecords[0].factorUnit, 'tCO2e/m3', '正式导入 execute 响应必须返回规范化后的非默认排放单位。');
    assert.strictEqual(execute.body.data.writesCarbonEmissions, false);
    assert(!JSON.stringify(execute.body).includes(tmpDir), '导入执行响应不得泄露本地路径。');
    // 导入结果标识用于直接核对隔离 SQLite 中的原始 factor_unit 列。
    const importedFactorId = execute.body.data.importedIds[0];
    // 持久化检查数据库仍由本测试顶部环境变量固定指向临时 SQLite。
    const executeCheckDb = openDatabase();
    try {
      // 持久化行用于证明 execute 写入的是 canonical 单位而非默认值或原始别名。
      const persistedImportedFactor = executeCheckDb.prepare('SELECT factor_unit FROM carbon_factors WHERE id = ?').get(importedFactorId);
      assert(persistedImportedFactor, '正式导入 execute 必须在隔离 SQLite 中写入碳因子。');
      assert.strictEqual(persistedImportedFactor.factor_unit, 'tCO2e/m3', '隔离 SQLite 的 factor_unit 必须持久化 canonical 非默认单位。');
    } finally {
      executeCheckDb.close();
    }
    const auditExecute = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(auditExecute.auditPhase, 'execute');
    assert.strictEqual(auditExecute.status, 'completed_with_errors');

    const factorExport = await request(server, 'GET', '/api/carbon/factors/export?format=csv&energyTypeCode=electricity', undefined, adminToken);
    assert.strictEqual(factorExport.status, 200);
    assert(factorExport.body.toString('utf8').startsWith('﻿"能源类型编码","地区","因子年份","活动数据单位","因子值","排放单位","因子来源","来源链接","有效开始日期","有效结束日期","状态"'), '碳因子导出必须输出中文表头。');
    assert(!factorExport.body.toString('utf8').includes(tmpDir), '因子导出不得泄露本地路径。');
    const emissionExport = await request(server, 'GET', '/api/carbon/emissions/export?format=csv&normalizedMonth=2028-01', undefined, adminToken);
    assert.strictEqual(emissionExport.status, 200);
    assert(emissionExport.body.toString('utf8').startsWith('﻿"碳排放记录ID","月份","能源类型编码"'), '碳排放导出必须输出中文表头。');
    assert(!emissionExport.body.toString('utf8').includes(tmpDir), '排放导出不得泄露本地路径。');

    console.log('carbon accounting API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
