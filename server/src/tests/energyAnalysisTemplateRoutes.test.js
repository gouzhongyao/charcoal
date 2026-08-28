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
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { parseEnergyAnalysisTemplateWorkbook } = require('../services/energyAnalysisTemplateService');

// 十四类能源分析与配置模板的下载契约独立硬编码，避免从生产列表反向生成预期。
const ENERGY_ANALYSIS_TEMPLATE_CONTRACTS = Object.freeze([
  Object.freeze({ id: 'energy-timeseries', permission: 'energy:analysis:timeseries:preview', baseFileName: '能耗时序数据导入模板', asciiBaseFileName: 'nenghao-shixu-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能耗时序']) }),
  Object.freeze({ id: 'shift-definitions', permission: 'energy:analysis:config:import:preview', baseFileName: '班次定义导入模板', asciiBaseFileName: 'banci-dingyi-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['班次定义']) }),
  Object.freeze({ id: 'tou-schemes', permission: 'energy:analysis:config:import:preview', baseFileName: 'TOU方案与时段导入模板', asciiBaseFileName: 'tou-fangan-shiduan-template', formats: Object.freeze(['xlsx']), sheetNames: Object.freeze(['TOU方案', '时段规则']) }),
  Object.freeze({ id: 'strategy-rules', permission: 'energy:analysis:config:import:preview', baseFileName: '策略规则导入模板', asciiBaseFileName: 'celue-guize-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['策略规则']) }),
  Object.freeze({ id: 'shift-schedules', permission: 'energy:analysis:operations:preview', baseFileName: '排班计划导入模板', asciiBaseFileName: 'paiban-jihua-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['排班计划']) }),
  Object.freeze({ id: 'device-states', permission: 'energy:analysis:operations:preview', baseFileName: '设备状态导入模板', asciiBaseFileName: 'shebei-zhuangtai-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['设备状态']) }),
  Object.freeze({ id: 'energy-conversion-factors', permission: 'energy:benchmarks:import:preview', baseFileName: '能源折标系数导入模板', asciiBaseFileName: 'nengyuan-zhebiao-xishu-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能源折标系数']) }),
  Object.freeze({ id: 'energy-benchmark-definitions', permission: 'energy:benchmarks:import:preview', baseFileName: '能效对标定义导入模板', asciiBaseFileName: 'nengxiao-duibiao-dingyi-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['对标定义']) }),
  Object.freeze({ id: 'energy-benchmark-targets', permission: 'energy:benchmarks:import:preview', baseFileName: '能效对标目标导入模板', asciiBaseFileName: 'nengxiao-duibiao-mubiao-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['对标目标']) }),
  Object.freeze({ id: 'energy-flow-models', permission: 'energy:flows:import:preview', baseFileName: '能流模型导入模板', asciiBaseFileName: 'nengliu-moxing-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能流模型']) }),
  Object.freeze({ id: 'energy-flow-workbook', permission: 'energy:flows:import:preview', baseFileName: '完整能流工作簿模板', asciiBaseFileName: 'energy-flow-workbook-template', formats: Object.freeze(['xlsx']), sheetNames: Object.freeze(['模型', '设备资产与节点', '有向边', '期间流量', '余热事实', '损耗证据']) }),
  Object.freeze({ id: 'energy-balance-configs', permission: 'energy:balance:import:preview', baseFileName: '能效平衡配置导入模板', asciiBaseFileName: 'nengxiao-pingheng-peizhi-template', formats: Object.freeze(['xlsx']), sheetNames: Object.freeze(['平衡边界', '九角色项目']) }),
  Object.freeze({ id: 'energy-flow-nodes', permission: 'energy:flows:import:preview', baseFileName: '能流节点导入模板', asciiBaseFileName: 'nengliu-jiedian-template', formats: Object.freeze(['xlsx', 'csv']), sheetNames: Object.freeze(['能流节点']) }),
  Object.freeze({ id: 'energy-flow-edges', permission: 'energy:flows:import:preview', baseFileName: '能流边及显式边值导入模板', asciiBaseFileName: 'nengliu-bian-xianshi-bianzhi-template', formats: Object.freeze(['xlsx']), sheetNames: Object.freeze(['能流边', '显式边值']) })
]);

// 中央模板列表必须精确披露当前已经开放的真实预演与执行路由。
const ENERGY_ANALYSIS_TEMPLATE_IMPORT_ROUTES = Object.freeze({
  'energy-timeseries': 'POST /api/energy-analysis/imports/timeseries/preview -> POST /api/energy-analysis/imports/timeseries/execute',
  'shift-definitions': 'POST /api/energy-analysis/imports/shift-definitions/preview -> POST /api/energy-analysis/imports/shift-definitions/execute',
  'tou-schemes': 'POST /api/energy-analysis/imports/tou-schemes/preview -> POST /api/energy-analysis/imports/tou-schemes/execute',
  'strategy-rules': 'POST /api/energy-analysis/imports/strategy-rules/preview -> POST /api/energy-analysis/imports/strategy-rules/execute',
  'shift-schedules': 'POST /api/energy-analysis/imports/shift-schedules/preview -> POST /api/energy-analysis/imports/shift-schedules/execute',
  'device-states': 'POST /api/energy-analysis/imports/device-states/preview -> POST /api/energy-analysis/imports/device-states/execute',
  'energy-conversion-factors': 'POST /api/energy-benchmarks/imports/conversion-factors/preview -> POST /api/energy-benchmarks/imports/conversion-factors/execute',
  'energy-benchmark-definitions': 'POST /api/energy-benchmarks/imports/definitions/preview -> POST /api/energy-benchmarks/imports/definitions/execute',
  'energy-benchmark-targets': 'POST /api/energy-benchmarks/imports/targets/preview -> POST /api/energy-benchmarks/imports/targets/execute',
  'energy-flow-models': 'POST /api/energy-flow-imports/models/preview -> POST /api/energy-flow-imports/models/execute',
  'energy-flow-workbook': 'POST /api/energy-flow-imports/workbook/preview -> POST /api/energy-flow-imports/workbook/execute',
  'energy-flow-nodes': 'POST /api/energy-flow-imports/nodes/preview -> POST /api/energy-flow-imports/nodes/execute',
  'energy-flow-edges': 'POST /api/energy-flow-imports/bundle/preview -> POST /api/energy-flow-imports/bundle/execute',
  'energy-balance-configs': 'POST /api/energy-balance-imports/bundle/preview -> POST /api/energy-balance-imports/bundle/execute'
});

// 十五类基础领域中央模板 ID 用于防止既有顺序、供应商、N6 碳排放报告和 N7 温室气体报告模板入口回归。
const BASE_TEMPLATE_IDS = Object.freeze([
  'energy-budgets',
  'energy-records',
  'meter-readings',
  'production-units',
  'suppliers',
  'production-outputs',
  'generation-records',
  'organization-units',
  'meters',
  'carbon-factors',
  'carbon-activities',
  'carbon-emission-report',
  'ghg-report',
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
  assert(parsed.sheets.every((sheet) => sheet.rows.length >= 1), '每张模板工作表必须至少包含一行可解析样例。');
}

(async () => {
  let server;
  try {
    initDatabase();

    // 创建无权限账号与拥有全部领域 preview 权限的账号，验证模板不再统一依赖 imports:view。
    register({ username: 'analysis-denied', password: 'Password123!' });
    const allowedUser = register({ username: 'analysis-allowed', password: 'Password123!' });
    const requiredPermissions = [...new Set([
      'system:demo:download',
      ...ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.map((contract) => contract.permission)
    ])];
    const menusByPermission = new Map(listMenus().rows.map((menu) => [menu.permissionCode, menu]));
    const permissionMenus = requiredPermissions.map((permission) => {
      const menu = menusByPermission.get(permission);
      assert(menu, `测试数据库必须包含 ${permission} 菜单权限。`);
      return menu;
    });
    const templateRole = createRole({
      roleCode: 'analysis_template_reader',
      roleName: '能源分析模板读取'
    });
    assignRoleMenus(templateRole.id, permissionMenus.map((menu) => menu.id));
    assignUserRoles(allowedUser.id, [templateRole.id]);
    // 隔离测试显式开启演示运行期，避免依赖默认关闭状态。
    toggleDemoRuntime({ enabled: true, actorUserId: allowedUser.id });

    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const deniedToken = await login(server, 'analysis-denied', 'Password123!');
    const allowedToken = await login(server, 'analysis-allowed', 'Password123!');

    // 中央列表必须精确保留十五类基础模板，并正式提供十四类能源分析与配置模板及其格式元数据。
    const listResponse = await request(server, 'GET', '/api/templates');
    assert.strictEqual(listResponse.status, 200);
    const listedTemplates = listResponse.body.data;
    assert.deepStrictEqual(
      listedTemplates.slice(0, BASE_TEMPLATE_IDS.length).map((template) => template.type),
      BASE_TEMPLATE_IDS,
      '基础模板列表顺序、供应商入口和 ID 不得回归。'
    );
    assert.strictEqual(listedTemplates.length, BASE_TEMPLATE_IDS.length + ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.length);
    ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.forEach((contract) => {
      const listed = listedTemplates.find((template) => template.type === contract.id);
      assert(listed, `${contract.id} 必须出现在中央模板列表。`);
      assert.deepStrictEqual(listed.formats, contract.formats);
      assert.deepStrictEqual(listed.sheetNames, contract.sheetNames);
      assert.strictEqual(listed.route, `/api/templates/${contract.id}.xlsx`);
      assert.strictEqual(listed.fileName, `${contract.baseFileName}.xlsx`);
      assert.strictEqual(listed.asciiFileName, `${contract.asciiBaseFileName}.xlsx`);
      assert.strictEqual(listed.recommendedFormat, 'xlsx');
      assert.strictEqual(listed.requiredPermission, contract.permission);
      assert.strictEqual(
        listed.contractRoute,
        ENERGY_ANALYSIS_TEMPLATE_IMPORT_ROUTES[contract.id],
        `${contract.id} 必须指向真实 preview/execute 路由。`
      );
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

    // 新模板下载必须先认证，再校验对应领域 preview 权限。
    const protectedPath = '/api/templates/energy-timeseries.xlsx';
    const anonymous = await request(server, 'GET', protectedPath);
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');
    const forbidden = await request(server, 'GET', protectedPath, undefined, deniedToken);
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');
    assert.deepStrictEqual(forbidden.body.error.details.requiredPermissions, ['energy:analysis:timeseries:preview']);

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
    assert.strictEqual(
      observedAsciiNames.size,
      ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.reduce((total, contract) => total + contract.formats.length, 0),
      '全部已声明格式的 ASCII fallback 必须唯一。'
    );

    // 三类多工作表模板必须精确保留两张工作表，CSV 必须返回稳定领域错误而不是静默降级。
    for (const contract of ENERGY_ANALYSIS_TEMPLATE_CONTRACTS.filter((item) => item.formats.length === 1)) {
      const xlsxResponse = await request(server, 'GET', `/api/templates/${contract.id}.xlsx`, undefined, allowedToken);
      const workbook = XLSX.read(xlsxResponse.body, { type: 'buffer' });
      assert.deepStrictEqual(workbook.SheetNames, contract.sheetNames);
      const csvResponse = await request(server, 'GET', `/api/templates/${contract.id}.csv`, undefined, allowedToken);
      assert.strictEqual(csvResponse.status, 400);
      assert.strictEqual(csvResponse.body.error.code, 'TEMPLATE_FORMAT_UNSUPPORTED');
      assert.deepStrictEqual(csvResponse.body.error.details, {
        templateId: contract.id,
        format: 'csv',
        supportedFormats: ['xlsx']
      });
    }

    // 天坤集团 manifest 按当前账号权限过滤，并能下载精确多表演示文件。
    const manifestResponse = await request(server, 'GET', '/api/templates/demo-park/manifest', undefined, allowedToken);
    assert.strictEqual(manifestResponse.status, 200);
    assert.strictEqual(manifestResponse.body.data.parkCode, 'QL-PARK');
    assert.strictEqual(manifestResponse.body.data.artifactCount, manifestResponse.body.data.artifacts.length);
    assert.deepStrictEqual(
      manifestResponse.body.data.artifacts.map((artifact) => artifact.templateType).sort(),
      ENERGY_ANALYSIS_TEMPLATE_CONTRACTS
        .filter((contract) => contract.id !== 'energy-flow-workbook')
        .map((contract) => contract.id)
        .sort(),
      '仅领域 preview 权限账号应精确看到已注册演示条目的能源分析模板。'
    );
    assert(manifestResponse.body.data.artifacts.every((artifact) => requiredPermissions.includes(artifact.requiredPermission)));
    const demoTou = await request(server, 'GET', '/api/templates/demo-park/17-tou-schemes.xlsx', undefined, allowedToken);
    assert.strictEqual(demoTou.status, 200);
    assert.strictEqual(demoTou.headers['x-demo-artifact-key'], '17-tou-schemes');
    assert.deepStrictEqual(XLSX.read(demoTou.body, { type: 'buffer' }).SheetNames, ['TOU方案', '时段规则']);
    const demoTouCsv = await request(server, 'GET', '/api/templates/demo-park/17-tou-schemes.csv', undefined, allowedToken);
    assert.strictEqual(demoTouCsv.status, 400);
    assert.strictEqual(demoTouCsv.body.error.code, 'DEMO_ARTIFACT_FORMAT_UNSUPPORTED');

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
