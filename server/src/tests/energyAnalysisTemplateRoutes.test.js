'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 测试仅使用隔离临时目录，不访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-analysis-template-routes-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'templates.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { register } = require('../services/authService');
const { listMenus } = require('../services/menuService');
const { assignRoleMenus, createRole } = require('../services/roleService');
const { assignUserRoles } = require('../services/userService');
const { runWithMaintenance } = require('../services/maintenanceState');
const { parseEnergyAnalysisTemplateWorkbook } = require('../services/energyAnalysisTemplateService');

// 八类能源分析模板的用户可见下载契约独立硬编码，避免从生产列表反向生成预期。
const ENERGY_ANALYSIS_TEMPLATE_CONTRACTS = Object.freeze([
  Object.freeze({ id: 'energy-timeseries', baseFileName: '能耗时序数据导入模板', asciiBaseFileName: 'nenghao-shixu-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能耗时序']) }),
  Object.freeze({ id: 'shift-schedules', baseFileName: '排班计划导入模板', asciiBaseFileName: 'paiban-jihua-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['排班计划']) }),
  Object.freeze({ id: 'device-states', baseFileName: '设备状态导入模板', asciiBaseFileName: 'shebei-zhuangtai-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['设备状态']) }),
  Object.freeze({ id: 'energy-conversion-factors', baseFileName: '能源折标系数导入模板', asciiBaseFileName: 'nengyuan-zhebiao-xishu-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能源折标系数']) }),
  Object.freeze({ id: 'energy-benchmark-definitions', baseFileName: '能效对标定义导入模板', asciiBaseFileName: 'nengxiao-duibiao-dingyi-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['对标定义']) }),
  Object.freeze({ id: 'energy-benchmark-targets', baseFileName: '能效对标目标导入模板', asciiBaseFileName: 'nengxiao-duibiao-mubiao-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['对标目标']) }),
  Object.freeze({ id: 'energy-flow-nodes', baseFileName: '能流节点导入模板', asciiBaseFileName: 'nengliu-jiedian-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能流节点']) }),
  Object.freeze({ id: 'energy-flow-edges', baseFileName: '能流边及显式边值导入模板', asciiBaseFileName: 'nengliu-bian-xianshi-bianzhi-template', formats: Object.freeze(['xlsx']), sheetNames: Object.freeze(['能流边', '显式边值']) })
]);

// 接入前已存在的十一类中央模板 ID，用于防止历史列表或下载行为回归。
const HISTORICAL_TEMPLATE_IDS = Object.freeze([
  'energy-budgets',
  'energy-records',
  'meter-readings',
  'production-units',
  'production-outputs',
  'generation-records',
  'organization-units',
  'meters',
  'carbon-factors',
  'prediction-configs',
  'prediction-history'
]);

// 模板 GET 不得改变的能源分析业务表和统一导入审计表。
const TEMPLATE_DOWNLOAD_BUSINESS_TABLES = Object.freeze([
  'import_batches',
  'energy_timeseries_records',
  'shift_definitions',
  'shift_schedule_records',
  'device_state_records',
  'energy_conversion_factors',
  'benchmark_definitions',
  'benchmark_targets',
  'energy_flow_nodes',
  'energy_flow_edges',
  'energy_flow_records'
]);

/** 发起 HTTP 请求并按响应类型保留 JSON 或二进制正文。 */
function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: isJson && responseBody.length ? JSON.parse(responseBody.toString('utf8')) : responseBody
        });
      });
    });
    req.on('error', reject);
    if (rawBody !== null) {
      req.write(rawBody);
    }
    req.end();
  });
}

/** 登录测试账号并返回 Bearer Token。 */
async function login(server, username, password) {
  const response = await request(server, 'POST', '/api/login', { username, password });
  assert.strictEqual(response.status, 200, `${username} 必须登录成功。`);
  return response.body.data.token;
}

/** 解析 Content-Disposition 中的 ASCII 与 UTF-8 文件名。 */
function parseContentDisposition(value) {
  const header = String(value || '');
  const asciiMatch = header.match(/filename="([^"]+)"/i);
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  return {
    asciiName: asciiMatch ? asciiMatch[1] : '',
    utf8Name: utf8Match ? decodeURIComponent(utf8Match[1]) : ''
  };
}

/** 递归列出上传目录中的相对文件路径，用于检测模板下载是否产生文件副作用。 */
function listRelativeFiles(rootDir, currentDir = rootDir) {
  if (!fs.existsSync(currentDir)) {
    return [];
  }
  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return listRelativeFiles(rootDir, absolutePath);
    }
    return [path.relative(rootDir, absolutePath).replace(/\\/g, '/')];
  }).sort();
}

/** 快照能源分析业务表数量和上传文件，允许认证层自行更新会话心跳。 */
function snapshotTemplateBusinessSideEffects() {
  const db = openDatabase();
  try {
    return {
      tableCounts: Object.fromEntries(TEMPLATE_DOWNLOAD_BUSINESS_TABLES.map((tableName) => [
        tableName,
        db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total
      ])),
      uploadFiles: listRelativeFiles(process.env.UPLOADS_DIR)
    };
  } finally {
    db.close();
  }
}

/** 将 CSV 下载内容转换为带契约工作表名称的工作簿，再交由能源分析模板解析器读回。 */
function parseCsvWithEnergyAnalysisParser(templateId, sheetName, buffer) {
  const csvWorkbook = XLSX.read(buffer, { type: 'buffer', raw: true });
  const matrix = XLSX.utils.sheet_to_json(csvWorkbook.Sheets[csvWorkbook.SheetNames[0]], {
    header: 1,
    blankrows: true,
    defval: null,
    raw: true
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheetName);
  return parseEnergyAnalysisTemplateWorkbook(templateId, workbook);
}

/** 校验真实下载响应的类型、文件名、安全响应头和模板解析结果。 */
function assertSuccessfulTemplateDownload(response, contract, format, observedAsciiNames) {
  assert.strictEqual(response.status, 200, `${contract.id}.${format} 必须下载成功。`);
  assert(Buffer.isBuffer(response.body));
  assert(response.body.length > 0, `${contract.id}.${format} 正文不得为空。`);
  assert.strictEqual(response.headers['x-template-type'], contract.id);
  assert.strictEqual(response.headers['x-recommended-format'], 'xlsx');
  assert.strictEqual(Number(response.headers['content-length']), response.body.length);

  const expectedContentType = format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  assert.strictEqual(response.headers['content-type'], expectedContentType);

  const disposition = String(response.headers['content-disposition'] || '');
  assert.strictEqual(/[\r\n]/.test(disposition), false, 'Content-Disposition 不得包含 CRLF。');
  assert.strictEqual(Object.keys(response.headers).some((name) => name.toLowerCase() === 'x-injected-header'), false, '响应不得出现注入头。');
  const names = parseContentDisposition(disposition);
  assert.strictEqual(names.asciiName, `${contract.asciiBaseFileName}.${format}`);
  assert.strictEqual(names.utf8Name, `${contract.baseFileName}.${format}`);
  assert.strictEqual(observedAsciiNames.has(names.asciiName), false, '能源分析模板 ASCII fallback 必须唯一。');
  observedAsciiNames.add(names.asciiName);

  if (format === 'csv') {
    assert.deepStrictEqual([...response.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const parsed = parseCsvWithEnergyAnalysisParser(contract.id, contract.sheetNames[0], response.body);
    assert.strictEqual(parsed.valid, true, `${contract.id}.csv 必须可由能源分析模板解析器读回。`);
    assert.strictEqual(parsed.sheets[0].rows.length, 1);
    return;
  }

  assert.strictEqual(response.body.subarray(0, 2).toString('ascii'), 'PK');
  const parsed = parseEnergyAnalysisTemplateWorkbook(contract.id, response.body);
  assert.strictEqual(parsed.valid, true, `${contract.id}.xlsx 必须可由能源分析模板解析器读回。`);
  assert.deepStrictEqual(parsed.sheetNames, contract.sheetNames);
  assert(parsed.sheets.every((sheet) => sheet.rows.length === 1));
}

(async () => {
  let server;
  try {
    initDatabase();

    // 创建一个无权限账号和一个仅具 imports:view 的账号，验证真实 RBAC 边界而非仅依赖超级管理员兜底。
    register({ username: 'analysis-denied', password: 'Password123!' });
    const allowedUser = register({ username: 'analysis-allowed', password: 'Password123!' });
    const importsMenu = listMenus().rows.find((menu) => menu.permissionCode === 'imports:view');
    assert(importsMenu, '测试数据库必须包含 imports:view 菜单权限。');
    const templateRole = createRole({
      roleCode: 'analysis_template_reader',
      roleName: '能源分析模板读取'
    });
    assignRoleMenus(templateRole.id, [importsMenu.id]);
    assignUserRoles(allowedUser.id, [templateRole.id]);

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const deniedToken = await login(server, 'analysis-denied', 'Password123!');
    const allowedToken = await login(server, 'analysis-allowed', 'Password123!');

    // 中央列表必须保留十一类历史模板，并正式增加八类能源分析模板及其格式元数据。
    const listResponse = await request(server, 'GET', '/api/templates');
    assert.strictEqual(listResponse.status, 200);
    const listedTemplates = listResponse.body.data;
    assert.deepStrictEqual(
      listedTemplates.slice(0, HISTORICAL_TEMPLATE_IDS.length).map((template) => template.type),
      HISTORICAL_TEMPLATE_IDS,
      '历史模板列表顺序和 ID 不得回归。'
    );
    assert.strictEqual(listedTemplates.length, HISTORICAL_TEMPLATE_IDS.length + ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.length);
    ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.forEach((contract) => {
      const listed = listedTemplates.find((template) => template.type === contract.id);
      assert(listed, `${contract.id} 必须出现在中央模板列表。`);
      assert.deepStrictEqual(listed.formats, contract.formats);
      assert.deepStrictEqual(listed.sheetNames, contract.sheetNames);
      assert.strictEqual(listed.route, `/api/templates/${contract.id}.xlsx`);
      assert.strictEqual(listed.fileName, `${contract.baseFileName}.xlsx`);
      assert.strictEqual(listed.asciiFileName, `${contract.asciiBaseFileName}.xlsx`);
      assert.strictEqual(listed.recommendedFormat, 'xlsx');
      assert.strictEqual(listed.contractRoute, null, '本次接入不得伪造领域 preview/execute 路由。');
      if (contract.formats.includes('csv')) {
        assert.strictEqual(listed.csvRoute, `/api/templates/${contract.id}.csv`);
        assert.strictEqual(listed.csvFileName, `${contract.baseFileName}.csv`);
        assert.deepStrictEqual(listed.downloads, {
          xlsx: `/api/templates/${contract.id}.xlsx`,
          csv: `/api/templates/${contract.id}.csv`
        });
      } else {
        assert.strictEqual(listed.csvRoute, null);
        assert.strictEqual(listed.csvFileName, null);
        assert.deepStrictEqual(listed.downloads, { xlsx: `/api/templates/${contract.id}.xlsx` });
      }
    });

    // 新模板下载必须先认证，再校验 imports:view 权限。
    const protectedPath = '/api/templates/energy-timeseries.xlsx';
    const anonymous = await request(server, 'GET', protectedPath);
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');
    const forbidden = await request(server, 'GET', protectedPath, undefined, deniedToken);
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');
    assert.deepStrictEqual(forbidden.body.error.details.requiredPermissions, ['imports:view']);

    // 点号和额外扩展名必须在认证前统一拒绝，不能因权限判断与服务层规范化不一致而绕过下载保护。
    const doubleExtensionPaths = [
      '/api/templates/energy-timeseries.xlsx.csv',
      '/api/templates/energy-timeseries.csv.csv',
      '/api/templates/energy-flow-edges.csv.xlsx',
      '/api/templates/meters.xlsx.csv',
      '/api/templates/energy-budgets.csv.xlsx'
    ];
    const requestTokens = [null, deniedToken, allowedToken];
    for (const pathname of doubleExtensionPaths) {
      for (const token of requestTokens) {
        const rejected = await request(server, 'GET', pathname, undefined, token);
        assert.strictEqual(rejected.status, 404, `${pathname} 必须对所有认证状态稳定拒绝。`);
        assert.strictEqual(rejected.body.error.code, 'NOT_FOUND');
      }
    }

    // 前七类同时支持 CSV/XLSX，能流边仅下载 XLSX；每个文件都校验解析、文件名和响应类型。
    const observedAsciiNames = new Set();
    for (const contract of ENERGY_ANALYSIS_TEMPLATE_CONTRACTS) {
      for (const format of contract.formats) {
        const response = await request(server, 'GET', `/api/templates/${contract.id}.${format}`, undefined, allowedToken);
        assertSuccessfulTemplateDownload(response, contract, format, observedAsciiNames);
      }
    }
    assert.strictEqual(observedAsciiNames.size, 15, '七类双格式加一类 XLSX 的 ASCII fallback 必须全部唯一。');

    // 能流边 Excel 必须精确保留两张工作表，CSV 必须返回稳定领域错误而不是静默降级。
    const edgeXlsx = await request(server, 'GET', '/api/templates/energy-flow-edges.xlsx', undefined, allowedToken);
    const edgeWorkbook = XLSX.read(edgeXlsx.body, { type: 'buffer' });
    assert.deepStrictEqual(edgeWorkbook.SheetNames, ['能流边', '显式边值']);
    const edgeCsv = await request(server, 'GET', '/api/templates/energy-flow-edges.csv', undefined, allowedToken);
    assert.strictEqual(edgeCsv.status, 400);
    assert.strictEqual(edgeCsv.body.error.code, 'TEMPLATE_FORMAT_UNSUPPORTED');
    assert.deepStrictEqual(edgeCsv.body.error.details, {
      templateId: 'energy-flow-edges',
      format: 'csv',
      supportedFormats: ['xlsx']
    });

    // 旧 standards ID、未知模板和非法扩展名必须稳定拒绝。
    for (const pathname of [
      '/api/templates/energy-benchmark-standards.xlsx',
      '/api/templates/energy-benchmark-standards.csv',
      '/api/templates/not-a-template.xlsx',
      '/api/templates/energy-timeseries.pdf'
    ]) {
      const response = await request(server, 'GET', pathname, undefined, allowedToken);
      assert.strictEqual(response.status, 404, `${pathname} 必须返回稳定 404。`);
      assert.strictEqual(response.body.error.code, 'NOT_FOUND');
    }

    // GET 模板属于只读业务能力，维护态下仍应成功且不得写业务表或上传文件；认证层允许更新会话心跳。
    const businessSnapshotBeforeMaintenanceDownload = snapshotTemplateBusinessSideEffects();
    const maintenanceResponse = await runWithMaintenance('energy-analysis-template-route-test', () => (
      request(server, 'GET', protectedPath, undefined, allowedToken)
    ));
    const businessSnapshotAfterMaintenanceDownload = snapshotTemplateBusinessSideEffects();
    assert.strictEqual(maintenanceResponse.status, 200);
    assert.deepStrictEqual(
      businessSnapshotAfterMaintenanceDownload,
      businessSnapshotBeforeMaintenanceDownload,
      '维护态模板 GET 不得改变能源分析业务数据、导入审计或上传文件。'
    );

    // 历史匿名模板下载继续保持原行为，证明新权限映射没有扩大到历史公开模板。
    for (const format of ['csv', 'xlsx']) {
      const historicalResponse = await request(server, 'GET', `/api/templates/energy-records.${format}`);
      assert.strictEqual(historicalResponse.status, 200, `energy-records.${format} 历史匿名下载不得回归。`);
      assert(historicalResponse.body.length > 0);
    }

    console.log('energy analysis template route tests passed');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
