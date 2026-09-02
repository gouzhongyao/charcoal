'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 本测试只使用系统临时目录，禁止访问项目真实 data、uploads 与 backups。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-unconnected-http-'));
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'demo-unconnected-http.sqlite');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'DemoUnconnectedHttp123!';
process.env.PRODUCTION_UNIT_IMPORT_HMAC_SECRET = 'demo-unconnected-production-unit-secret';
process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET = 'demo-unconnected-generation-secret';
process.env.PREDICTION_IMPORT_HMAC_SECRET = 'demo-unconnected-prediction-secret';
process.env.CHARCOAL_HMAC_SECRET = 'demo-unconnected-shared-secret';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { createOrganizationUnit } = require('../services/ledgerService');
const { generateDemoParkArtifact } = require('../services/demoParkDatasetService');

// 合法形态的 43 字符 context；未接入路由必须先返回 capability fail-closed，而不是降级为正式导入。
const demoContextToken = 'D'.repeat(43);
// 所有被测业务表均为静态白名单，禁止把表名从外部输入拼入 SQL。
const snapshotTableNames = new Set([
  'import_batches',
  'import_errors',
  'organization_units',
  'meter_devices',
  'production_units',
  'production_output_records',
  'energy_records',
  'meter_reading_records',
  'generation_records',
  'energy_budgets',
  'carbon_factors',
  'prediction_configs',
  'prediction_runs',
  'prediction_results'
]);

/** 发起真实本机 HTTP 请求，JSON 与二进制响应均保留。 */
function request(server, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : (options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8'));
    const headers = { ...(options.headers || {}) };
    if (rawBody.length > 0 && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (rawBody.length > 0) headers['Content-Length'] = String(rawBody.length);
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
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
          body: contentType.includes('application/json') && buffer.length > 0
            ? JSON.parse(buffer.toString('utf8'))
            : null
        });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(rawBody);
  });
}

/** 将任意内存文件构造成单文件 multipart 请求体。 */
function createBufferMultipart(filename, mimeType, buffer) {
  const boundary = `----charcoal-unconnected-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);
  return { boundary, body };
}

/** 将服务端生成的 artifact 构造成单文件 multipart 请求体。 */
function createArtifactMultipart(artifactKey) {
  const generated = generateDemoParkArtifact(artifactKey, 'xlsx');
  assert(generated, `缺少服务端 artifact ${artifactKey}`);
  return createBufferMultipart(generated.asciiFileName, generated.mimeType, generated.buffer);
}

/** 递归快照上传目录的相对文件名、大小与 SHA-256。 */
function snapshotUploadDirectory() {
  const root = process.env.UPLOADS_DIR;
  if (!fs.existsSync(root)) return [];
  const rows = [];
  const visit = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolutePath);
          return;
        }
        if (!entry.isFile()) return;
        const buffer = fs.readFileSync(absolutePath);
        rows.push({
          name: path.relative(root, absolutePath).split(path.sep).join('/'),
          size: buffer.length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex')
        });
      });
  };
  visit(root);
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/** 完整读取指定表全部列和全部行，用于证明请求没有产生任何数据库副作用。 */
function snapshotTables(tableNames) {
  const db = openDatabase();
  try {
    return Object.fromEntries(tableNames.map((tableName) => {
      assert(snapshotTableNames.has(tableName), `快照表未加入静态白名单：${tableName}`);
      return [tableName, db.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all()];
    }));
  } finally {
    db.close();
  }
}

/** 读取 stateless 下载不得触发的演示 runtime、run 与 context 状态。 */
function readStatelessDownloadGovernance() {
  const db = openDatabase();
  try {
    return {
      runtime: db.prepare('SELECT enabled, runtime_epoch AS runtimeEpoch, revision FROM demo_runtime_settings WHERE id = 1').get(),
      runCount: db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total,
      contextCount: db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total,
      autoEnableAuditCount: db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'system.demo.runtime.auto-enable'").get().total
    };
  } finally {
    db.close();
  }
}

/** 通过真实模板下载响应直接走页面既定 multipart 导入路由。 */
async function downloadAndDirectImport(server, token, artifactKey, importPath) {
  const downloadResponse = await request(server, 'GET', `/api/templates/demo-park/${artifactKey}.xlsx`, { token });
  assert.strictEqual(downloadResponse.status, 200, `${artifactKey} 真实下载失败：${JSON.stringify(downloadResponse.body)}`);
  assert(downloadResponse.buffer.length > 0, `${artifactKey} 下载文件不能为空。`);
  assert.strictEqual(downloadResponse.headers['x-demo-context'], undefined, `${artifactKey} stateless 下载不得签发 context。`);
  const multipart = createBufferMultipart(
    `${artifactKey}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    downloadResponse.buffer
  );
  const importResponse = await request(server, 'POST', importPath, {
    token,
    headers: { 'Content-Type': `multipart/form-data; boundary=${multipart.boundary}` },
    rawBody: multipart.body
  });
  assert.strictEqual(importResponse.status, 201, `${artifactKey} 直接导入失败：${JSON.stringify(importResponse.body)}`);
  assert.strictEqual(importResponse.body?.success, true, `${artifactKey} 直接导入必须返回 success=true。`);
  return importResponse.body.data;
}

/** 根据真实 preview 响应构造正式产能单元 execute 请求。 */
function buildProductionUnitExecuteBody(preview) {
  return {
    batchId: preview.batchId,
    confirmText: preview.confirmText,
    previewSignature: preview.previewSignature,
    expectedWouldImport: preview.summary.wouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows,
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 为尚未进入领域处理的 execute 路由提供语法有效、字段类型明确的 JSON 正文。 */
function buildBlockedExecuteBody(confirmText) {
  return {
    batchId: 1,
    confirmText,
    previewSignature: 'a'.repeat(64),
    previewAuditDigest: `hmac-sha256:v1:audit:${'b'.repeat(64)}`,
    expectedWouldImport: 1,
    candidateRowIds: ['row-1'],
    candidateRows: [{ rowId: 'row-1' }],
    requireBackup: true,
    acknowledgeSkippedRisks: true
  };
}

/** 执行单个 fail-closed 用例并核对上传目录、审计表与领域表完整快照。 */
async function assertUnconnectedCase(server, adminToken, testCase) {
  const tables = ['import_batches', 'import_errors', ...testCase.businessTables];
  const databaseBefore = snapshotTables(tables);
  const uploadsBefore = snapshotUploadDirectory();
  let response;
  if (testCase.kind === 'multipart') {
    const multipart = createArtifactMultipart(testCase.artifactKey);
    response = await request(server, 'POST', testCase.pathname, {
      token: adminToken,
      headers: {
        'X-Demo-Context': demoContextToken,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`
      },
      rawBody: multipart.body
    });
  } else {
    response = await request(server, 'POST', testCase.pathname, {
      token: adminToken,
      headers: { 'X-Demo-Context': demoContextToken },
      body: testCase.body
    });
  }
  assert.strictEqual(response.status, 409, `${testCase.name} 必须返回 HTTP 409：${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body?.error?.code, 'DEMO_CONTEXT_CAPABILITY_NOT_CONNECTED', `${testCase.name} 必须稳定返回未接入能力错误码。`);
  assert.deepStrictEqual(snapshotUploadDirectory(), uploadsBefore, `${testCase.name} 必须在 Multer 落盘前阻断，上传目录完整快照不得变化。`);
  assert.deepStrictEqual(snapshotTables(tables), databaseBefore, `${testCase.name} 不得改写导入审计表或相关业务表。`);
}

(async () => {
  let server;
  try {
    initDatabase();
    const park = createOrganizationUnit({ unitCode: 'QL-PARK', unitName: '天坤集团', unitType: 'enterprise' });
    createOrganizationUnit({ unitCode: 'QL-WORKSHOP-A', unitName: '精密制造一车间', unitType: 'workshop', parentId: park.id });
    createOrganizationUnit({ unitCode: 'QL-WORKSHOP-B', unitName: '装配二车间', unitType: 'workshop', parentId: park.id });

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const loginResponse = await request(server, 'POST', '/api/login', {
      body: { username: 'admin', password: process.env.CHARCOAL_ADMIN_PASSWORD }
    });
    assert.strictEqual(loginResponse.status, 200, JSON.stringify(loginResponse.body));
    const adminToken = loginResponse.body.data.token;

    // stateless 下载同样受独立 runtime 开关保护，先通过显式 toggle 接口开启再验证正式 direct-upload 导入链路。
    const toggleResponse = await request(server, 'POST', '/api/system/demo-data/toggle', {
      token: adminToken,
      body: { enabled: true }
    });
    assert.strictEqual(toggleResponse.status, 200, JSON.stringify(toggleResponse.body));
    assert.strictEqual(toggleResponse.body?.data?.runtime?.enabled, true);
    const statelessGovernanceBefore = readStatelessDownloadGovernance();
    assert.strictEqual(statelessGovernanceBefore.runtime.enabled, 1, '显式 toggle 后 stateless 下载必须看到 runtime 已开启。');
    assert.strictEqual(statelessGovernanceBefore.runCount, 0);
    assert.strictEqual(statelessGovernanceBefore.contextCount, 0);
    assert.strictEqual(statelessGovernanceBefore.autoEnableAuditCount, 0);
    await downloadAndDirectImport(server, adminToken, '02-organization-departments', '/api/organization/units/import');
    await downloadAndDirectImport(server, adminToken, '03-organization-process-equipment', '/api/organization/units/import');
    await downloadAndDirectImport(server, adminToken, '04-meters', '/api/meters/import');
    await downloadAndDirectImport(server, adminToken, '08-meter-readings-2026-08', '/api/meter-readings/import');
    assert.deepStrictEqual(readStatelessDownloadGovernance(), statelessGovernanceBefore, '02、03、04、08 下载与正式导入不得开启 runtime、创建 run/context 或写自动激活审计。');
    const statelessDb = openDatabase();
    try {
      assert.strictEqual(statelessDb.prepare("SELECT COUNT(*) AS total FROM meter_devices WHERE meter_code IN ('QL-M-ELEC-PARK', 'QL-M-ELEC-CNC01', 'QL-M-GAS-UTILITY')").get().total, 3, '04 下载文件必须真实完整导入三项计量器具。');
      assert.deepStrictEqual(statelessDb.prepare("SELECT meter_type AS meterType FROM meter_devices WHERE meter_code = 'QL-M-GAS-UTILITY'").get(), { meterType: 'gas' }, '天然气器具的 natural_gas 导入别名必须归一为 gas。');
      assert.strictEqual(statelessDb.prepare(`SELECT COUNT(*) AS total FROM meter_reading_records reading
        JOIN meter_devices meter ON meter.id = reading.meter_device_id
        WHERE meter.meter_code IN ('QL-M-ELEC-PARK', 'QL-M-ELEC-CNC01')
          AND reading.reading_date = '2026-08-01'`).get().total, 2, '08 下载文件必须真实导入两项计量抄表。');
      assert.strictEqual(statelessDb.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total, 0, '计量抄表直接导入不得自动生成能耗记录。');
    } finally {
      statelessDb.close();
    }

    // 代表性无 context 正式链路：真实 multipart preview 与 JSON execute 必须继续成功并写入产能单元。
    const formalMultipart = createArtifactMultipart('05-production-units');
    const formalPreviewResponse = await request(server, 'POST', '/api/production/units/import/preview', {
      token: adminToken,
      headers: { 'Content-Type': `multipart/form-data; boundary=${formalMultipart.boundary}` },
      rawBody: formalMultipart.body
    });
    assert.strictEqual(formalPreviewResponse.status, 200, JSON.stringify(formalPreviewResponse.body));
    assert.strictEqual(formalPreviewResponse.body.data.summary.wouldImport, 2);
    const formalExecuteBody = buildProductionUnitExecuteBody(formalPreviewResponse.body.data);
    const formalExecuteResponse = await request(server, 'POST', '/api/production/units/import/execute', {
      token: adminToken,
      body: formalExecuteBody
    });
    assert.strictEqual(formalExecuteResponse.status, 200, JSON.stringify(formalExecuteResponse.body));
    assert.strictEqual(formalExecuteResponse.body.data.imported, 2);
    const formalDb = openDatabase();
    try {
      assert.strictEqual(formalDb.prepare("SELECT COUNT(*) AS total FROM production_units WHERE unit_code IN ('QL-PU-PRECISION', 'QL-PU-ASSEMBLY')").get().total, 2, '无 context 正式导入必须真实写入两条产能单元。');
    } finally {
      formalDb.close();
    }

    const blockedExecuteBodies = {
      productionUnit: formalExecuteBody,
      productionOutput: buildBlockedExecuteBody('确认导入月度产量'),
      generation: buildBlockedExecuteBody('确认导入发电记录'),
      budget: buildBlockedExecuteBody('确认导入能源预算')
    };
    // execute 断言只证明在领域 handler 前阻断；Express 应用级 express.json 已在路由前解析，本测试不声称阻断位于其之前。
    const matrix = [
      { name: '组织 artifact 01 direct', kind: 'multipart', artifactKey: '01-organization-root', pathname: '/api/organization/units/import', businessTables: ['organization_units'] },
      { name: '组织 artifact 02 direct', kind: 'multipart', artifactKey: '02-organization-departments', pathname: '/api/organization/units/import', businessTables: ['organization_units'] },
      { name: '组织 artifact 03 direct', kind: 'multipart', artifactKey: '03-organization-process-equipment', pathname: '/api/organization/units/import', businessTables: ['organization_units'] },
      { name: '计量器具 artifact 04 direct', kind: 'multipart', artifactKey: '04-meters', pathname: '/api/meters/import', businessTables: ['meter_devices'] },
      { name: '产能单元 artifact 05 preview', kind: 'multipart', artifactKey: '05-production-units', pathname: '/api/production/units/import/preview', businessTables: ['production_units'] },
      { name: '产能单元 artifact 05 execute', kind: 'json', pathname: '/api/production/units/import/execute', body: blockedExecuteBodies.productionUnit, businessTables: ['production_units'] },
      { name: '月度产量 artifact 06 preview', kind: 'multipart', artifactKey: '06-production-outputs', pathname: '/api/production/outputs/import/preview', businessTables: ['production_output_records'] },
      { name: '月度产量 artifact 06 execute', kind: 'json', pathname: '/api/production/outputs/import/execute', body: blockedExecuteBodies.productionOutput, businessTables: ['production_output_records'] },
      { name: '计量抄表 artifact 08 direct', kind: 'multipart', artifactKey: '08-meter-readings-2026-08', pathname: '/api/meter-readings/import', businessTables: ['meter_reading_records'] },
      { name: '发电记录 artifact 09 preview', kind: 'multipart', artifactKey: '09-generation-records', pathname: '/api/generation/records/import/preview', businessTables: ['generation_records'] },
      { name: '发电记录 artifact 09 execute', kind: 'json', pathname: '/api/generation/records/import/execute', body: blockedExecuteBodies.generation, businessTables: ['generation_records'] },
      { name: '能源预算 artifact 10 preview', kind: 'multipart', artifactKey: '10-energy-budgets', pathname: '/api/energy-budgets/import/preview', businessTables: ['energy_budgets'] },
      { name: '能源预算 artifact 10 execute', kind: 'json', pathname: '/api/energy-budgets/import/execute', body: blockedExecuteBodies.budget, businessTables: ['energy_budgets'] }
    ];

    for (const testCase of matrix) {
      await assertUnconnectedCase(server, adminToken, testCase);
    }

    console.log(`demo unconnected context HTTP matrix tests passed (${matrix.length} fail-closed requests + 4 stateless download/import flows + 1 formal preview/execute flow)`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Windows SQLite 句柄释放可能稍晚，临时目录清理不得覆盖测试主结论。
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
