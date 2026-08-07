const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
// Excel 模板解析模块，用于校验下载文件中的用户可见表头。
const XLSX = require('xlsx');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-template-route-permissions-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'templates.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase } = require('../db/database');
const { register } = require('../services/authService');
const { parseImportFile } = require('../services/import/parser');
const { mapRowFields } = require('../services/import/normalization');
const { exportEnergyRecords, exportEnergyRecordLedgerBackfillPreview } = require('../services/energyRecordStatisticsService');
const { exportEnergyBudgets } = require('../services/energyBudgetService');
const { exportMeters, exportOrganizationUnits } = require('../services/ledgerService');
const { exportMeterReadingEnergyRecordGenerationPreview, exportMeterReadings } = require('../services/meterReadingService');
const { exportGenerationRecords } = require('../services/generationService');
const { exportProductionOutputs, exportProductionUnits } = require('../services/productionService');
const { exportCarbonEmissions, exportCarbonFactors } = require('../services/carbonAccountingService');
const { exportPredictionConfigs, exportPredictionResults } = require('../services/predictionService');

// 各模板用户可见首行的完整顺序契约。
const EXPECTED_TEMPLATE_HEADERS = Object.freeze({
  'energy-budgets': ['预算月份', '能源类型编码', '组织范围', '预算值', '单位', '备注', '状态'],
  'energy-records': ['月份', '能源类型编码', '能源类型名称', '用量', '单位', '用能单元', '厂区', '部门', '产线', '仪表编码', '数据时间', '业务维度', '备注'],
  'meter-readings': ['抄表日期', '计量器具编码', '计量器具名称', '上期表码', '本期表码', '倍率', '用量', '单位', '用能单元', '备注'],
  'production-units': ['产能单元编码', '产能单元名称', '所属用能单元编码', '产品名称', '产量单位', '备注', '状态'],
  'production-outputs': ['产能单元编码', '产能单元名称', '月份', '产量值', '产量单位', '数据来源', '备注'],
  'generation-records': ['用能单元编码', '用能单元名称', '月份', '发电量 kWh', '自发自用 kWh', '上网电量 kWh', '数据来源', '备注'],
  'organization-units': ['用能单元编码', '用能单元名称', '父级编码', '父级名称', '用能单元类型', '面积', '排序', '状态', '备注'],
  meters: ['计量器具编码', '计量器具名称', '计量器具类型', '能源类型编码', '用能单元编码', '用能单元', '在线状态', '网关ID', '倍率', '允许手工抄表', '流向', '安装位置', '状态', '备注'],
  'carbon-factors': ['能源类型编码', '地区', '因子年份', '活动数据单位', '因子值', '排放单位', '因子来源', '来源链接', '有效开始日期', '有效结束日期', '状态'],
  'prediction-configs': ['配置名称', '备注', '能源类型编码', '组织范围', '厂区', '部门', '能耗批次ID', '训练开始月份', '训练结束月份', '预测开始月份', '预测结束月份', '算法', '窗口大小', '状态'],
  'prediction-history': ['月份', '能源类型编码', '能源类型名称', '用量', '单位', '用能单元', '厂区', '部门', '产线', '仪表编码', '数据时间', '业务维度', '备注']
});

// 各 Excel 模板的用户可见工作表名称契约。
const EXPECTED_TEMPLATE_SHEET_NAMES = Object.freeze({
  'energy-budgets': '用能预算导入模板',
  'energy-records': '能耗导入模板',
  'meter-readings': '抄表导入模板',
  'production-units': '产能单元导入模板',
  'production-outputs': '月度产量导入模板',
  'generation-records': '发电自用记录导入模板',
  'organization-units': '用能单元模板',
  meters: '计量器具模板',
  'carbon-factors': '碳因子模板',
  'prediction-configs': '预测配置草稿',
  'prediction-history': '预测历史模板'
});

// 十一类模板的旧客户端 ASCII 文件名采用唯一、稳定的拼音业务名称。
const EXPECTED_TEMPLATE_ASCII_NAMES = Object.freeze({
  'energy-budgets': 'yongneng-yusuan-template',
  'energy-records': 'nenghao-jilu-template',
  'meter-readings': 'jiliang-chaobiao-template',
  'production-units': 'channeng-danyuan-template',
  'production-outputs': 'yuedu-chanliang-template',
  'generation-records': 'fadian-ziyong-template',
  'organization-units': 'yongneng-danyuan-template',
  meters: 'jiliang-qiju-template',
  'carbon-factors': 'tan-yinzi-template',
  'prediction-configs': 'yuce-peizhi-template',
  'prediction-history': 'yuce-lishi-template'
});

// 十一类模板的 UTF-8 下载文件名与工作表名称分别独立约束。
const EXPECTED_TEMPLATE_FILE_NAMES = Object.freeze({
  'energy-budgets': '用能预算导入模板',
  'energy-records': '能耗数据导入模板',
  'meter-readings': '计量抄表导入模板',
  'production-units': '产能单元导入模板',
  'production-outputs': '月度产量导入模板',
  'generation-records': '发电自用记录导入模板',
  'organization-units': '用能单元导入模板',
  meters: '计量器具导入模板',
  'carbon-factors': '碳因子导入模板',
  'prediction-configs': '预测配置草稿导入模板',
  'prediction-history': '预测历史数据模板'
});

// 十二类常规数据导出的独立中文标题和工作表契约。
const EXPECTED_EXPORT_CONTRACTS = Object.freeze([
  { name: '能耗明细', sheetName: '能耗明细', run: exportEnergyRecords, headers: ['能耗记录ID', '来源批次ID', '来源行号', '月份', '能源类型编码', '能源类型名称', '原始值', '原始单位', '标准化值', '标准化单位', '组织', '地点', '部门', '产线', '原始仪表编码', '关联仪表编码', '关联仪表名称', '关联用能单元编码', '关联用能单元名称', '关联用能单元路径', '业务维度', '备注', '创建时间'] },
  { name: '用能预算', sheetName: '用能预算', run: exportEnergyBudgets, headers: ['预算月份', '能源类型编码', '组织范围', '预算值', '单位', '备注', '状态'] },
  { name: '用能单元', sheetName: '用能单元', run: exportOrganizationUnits, headers: ['用能单元编码', '用能单元名称', '用能单元路径', '父级编码', '父级名称', '类型', '面积', '排序', '状态', '备注'] },
  { name: '计量器具', sheetName: '计量器具', run: exportMeters, headers: ['计量器具编码', '计量器具名称', '类型', '能源类型编码', '能源类型', '用能单元编码', '用能单元', '在线状态', '网关ID', '倍率', '允许手工抄表', '流向', '安装位置', '状态', '备注'] },
  { name: '计量抄表', sheetName: '计量抄表', run: exportMeterReadings, headers: ['仪表编码', '仪表名称', '用能单元', '能源类型编码', '能源类型', '抄表日期', '上期表码', '本期表码', '倍率', '用量', '单位', '标准化用量', '标准单位', '状态', '备注', '导入批次'] },
  { name: '发电自用', sheetName: '发电自用记录', run: exportGenerationRecords, headers: ['用能单元编码', '用能单元名称', '用能单元路径', '月份', '能源类型编码', '能源类型', '发电量 kWh', '自发自用 kWh', '上网电量 kWh', '自用率', '上网率', '数据来源', '状态', '备注', '创建时间', '更新时间'] },
  { name: '产能单元', sheetName: '产能单元', run: exportProductionUnits, headers: ['产能单元编码', '产能单元名称', '所属用能单元编码', '产品名称', '产量单位', '备注', '状态'] },
  { name: '月度产量', sheetName: '月度产量', run: exportProductionOutputs, headers: ['产能单元编码', '产能单元名称', '所属用能单元', '产品名称', '月份', '产量值', '产量单位', '数据来源', '状态', '备注'] },
  { name: '碳因子', sheetName: '碳因子', run: exportCarbonFactors, headers: ['能源类型编码', '地区', '因子年份', '活动数据单位', '因子值', '排放单位', '因子来源', '来源链接', '有效开始日期', '有效结束日期', '状态'] },
  { name: '碳排放结果', sheetName: '碳排放结果', run: exportCarbonEmissions, headers: ['碳排放记录ID', '月份', '能源类型编码', '能源类型名称', '组织', '厂区', '部门', '核算方法', '活动数据值', '活动数据单位', '因子值', '排放量', '排放单位', '状态', '因子地区', '因子年份', '因子来源', '核算时间'] },
  { name: '预测配置', sheetName: '预测配置草稿', run: exportPredictionConfigs, headers: ['配置名称', '备注', '能源类型编码', '组织范围', '厂区', '部门', '能耗批次ID', '训练开始月份', '训练结束月份', '预测开始月份', '预测结束月份', '算法', '窗口大小', '状态'] },
  { name: '预测结果', sheetName: '预测结果', run: exportPredictionResults, headers: ['预测运行ID', '预测运行名称', '算法', '运行状态', '能源类型编码', '预测月份', '预测值', '预测单位', '置信区间下限', '置信区间上限', '方法说明'] }
]);

// 十二类常规导出与两类预演审计的真实 HTTP 下载契约。
const EXPECTED_HTTP_EXPORT_CONTRACTS = Object.freeze([
  { name: '能耗明细', path: '/api/energy-records/export', asciiBase: 'nenghao-mingxi', chinesePrefix: '能耗明细-' },
  { name: '用能预算', path: '/api/energy-budgets/export', asciiBase: 'yongneng-yusuan', chinesePrefix: '用能预算导出-' },
  { name: '用能单元', path: '/api/organization/units/export', asciiBase: 'yongneng-danyuan', chinesePrefix: '用能单元导出-' },
  { name: '计量器具', path: '/api/meters/export', asciiBase: 'jiliang-qiju', chinesePrefix: '计量器具导出-' },
  { name: '计量抄表', path: '/api/meter-readings/export', asciiBase: 'jiliang-chaobiao', chinesePrefix: '计量抄表导出-' },
  { name: '发电自用', path: '/api/generation/records/export', asciiBase: 'fadian-ziyong', chinesePrefix: '发电自用记录导出-' },
  { name: '产能单元', path: '/api/production/units/export', asciiBase: 'channeng-danyuan', chinesePrefix: '产能单元导出-' },
  { name: '月度产量', path: '/api/production/outputs/export', asciiBase: 'yuedu-chanliang', chinesePrefix: '月度产量导出-' },
  { name: '碳因子', path: '/api/carbon/factors/export', asciiBase: 'tan-yinzi', chinesePrefix: '碳因子导出-' },
  { name: '碳排放结果', path: '/api/carbon/emissions/export', asciiBase: 'tan-paifang-jieguo', chinesePrefix: '碳排放结果导出-' },
  { name: '预测配置', path: '/api/predictions/configs/export', asciiBase: 'yuce-peizhi', chinesePrefix: '预测配置草稿导出-' },
  { name: '预测结果', path: '/api/predictions/results/export', asciiBase: 'yuce-jieguo', chinesePrefix: '预测结果导出-' },
  { name: '历史能耗台账回填预演审计', path: '/api/energy-records/ledger-backfill/preview/export', asciiBase: 'lishi-nenghao-huitian-preview', chinesePrefix: '能耗记录-台账回填预演审计预案-' },
  { name: '抄表生成能耗记录预演审计', path: '/api/meter-readings/energy-record-generation/preview/export', asciiBase: 'chaobiao-nenghao-preview', chinesePrefix: '抄表生成能耗记录预演审计预案-' }
]);

/** 读取模板首行表头，统一校验 CSV 与 Excel 下载内容。 */
function readTemplateHeaders(format, body) {
  if (format === 'csv') {
    return body.toString('utf8').replace(/^﻿/, '').split(/\r?\n/, 1)[0].split(',').map((header) => header.replace(/^"|"$/g, '').replace(/""/g, '"'));
  }
  const workbook = XLSX.read(body, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false })[0] || [];
}

/** 精确校验模板表头的内容、顺序与唯一性。 */
function assertExactTemplateHeaders(templateType, format, body) {
  const actualHeaders = readTemplateHeaders(format, body);
  const expectedHeaders = EXPECTED_TEMPLATE_HEADERS[templateType];
  assert.deepStrictEqual(actualHeaders, expectedHeaders, `${templateType}.${format} 表头必须与中文模板契约完整且顺序一致。`);
  assert.strictEqual(new Set(actualHeaders).size, actualHeaders.length, `${templateType}.${format} 表头不得重复。`);
  assert(!actualHeaders.some((header) => {
    const text = String(header);
    return /^[a-z]+(?:_[a-z0-9]+)+$/i.test(text) || (/^[A-Za-z][A-Za-z0-9]*$/.test(text) && /[a-z][A-Z]/.test(text));
  }), `${templateType}.${format} 不得使用 camelCase 或 snake_case 技术标题。`);
  if (format === 'xlsx') {
    const workbook = XLSX.read(body, { type: 'buffer' });
    assert.deepStrictEqual(workbook.SheetNames, [EXPECTED_TEMPLATE_SHEET_NAMES[templateType]], `${templateType}.xlsx 工作表名称必须使用中文业务名称。`);
  }
}

/** 解析真实 HTTP Content-Disposition 中的 ASCII 与 UTF-8 文件名。 */
function parseContentDisposition(value) {
  const header = String(value || '');
  const asciiName = header.match(/filename="([^"]+)"/i)?.[1] || '';
  const encodedName = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || '';
  return {
    asciiName,
    utf8Name: encodedName ? decodeURIComponent(encodedName) : ''
  };
}

/** 校验真实 HTTP 文件响应的文件名、扩展名和 CSV BOM。 */
function assertHttpDownloadResponse(response, contract, format, observedAsciiNames) {
  assert.strictEqual(response.status, 200, `${contract.name}.${format} HTTP 下载必须成功。`);
  const names = parseContentDisposition(response.headers['content-disposition']);
  const expectedAsciiName = `${contract.asciiBase}.${format}`;
  assert.strictEqual(names.asciiName, expectedAsciiName, `${contract.name}.${format} ASCII fallback 必须唯一、稳定且扩展名正确。`);
  assert(!observedAsciiNames.has(names.asciiName), `${contract.name}.${format} ASCII fallback 不得与其他用户可见文件碰撞。`);
  observedAsciiNames.add(names.asciiName);
  assert(names.utf8Name.startsWith(contract.chinesePrefix), `${contract.name}.${format} filename* 必须使用正确中文业务名称。`);
  assert(names.utf8Name.endsWith(`.${format}`), `${contract.name}.${format} filename* 扩展名必须正确。`);
  if (format === 'csv') {
    assert.deepStrictEqual([...response.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${contract.name}.csv 必须带 UTF-8 BOM。`);
  } else {
    assert.strictEqual(response.body.subarray(0, 2).toString('ascii'), 'PK', `${contract.name}.xlsx 必须返回有效 Excel ZIP 文件。`);
  }
}

/** 校验常规导出的 CSV 首行、Excel 首行与工作表名称。 */
function assertExportContract(contract) {
  for (const format of ['csv', 'xlsx']) {
    const result = contract.run({ format });
    assert.deepStrictEqual(result.fields, contract.headers, `${contract.name}.${format} 返回字段必须与独立中文契约一致。`);
    assert.strictEqual(new Set(result.fields).size, result.fields.length, `${contract.name}.${format} 表头不得重复。`);
    if (format === 'csv') {
      assert.deepStrictEqual(readTemplateHeaders('csv', result.body), contract.headers, `${contract.name}.csv 首行必须完整使用中文业务标题。`);
    } else {
      const workbook = XLSX.read(result.body, { type: 'buffer' });
      assert.deepStrictEqual(workbook.SheetNames, [contract.sheetName], `${contract.name}.xlsx 工作表名称必须使用中文业务名称。`);
      const worksheet = workbook.Sheets[contract.sheetName];
      assert.deepStrictEqual(XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false })[0], contract.headers, `${contract.name}.xlsx 首行必须完整使用中文业务标题。`);
    }
  }
}

/** 校验两类预演审计文件的顶部标题、元信息和明细工作表。 */
function assertPreviewExportContracts() {
  const previews = [
    {
      name: '历史能耗台账回填预演审计',
      run: exportEnergyRecordLedgerBackfillPreview,
      title: '历史能耗记录台账回填预演审计预案（仅预演、不写入）',
      headers: ['能耗记录ID', '月份', '能源类型编码', '能源类型名称', '原始组织', '原始地点', '原始部门', '原始仪表字段', '预演状态', '是否可作为回填候选', '原因编码', '原因说明', '原用能单元ID', '原计量器具ID', '候选用能单元ID', '候选用能单元编码', '候选用能单元名称', '候选用能单元路径', '候选计量器具ID', '候选计量器具编码', '候选计量器具名称', '候选计量器具能源类型', '候选计量器具所属用能单元ID', '候选计量器具所属用能单元编码', '候选计量器具所属用能单元名称', '候选计量器具所属用能单元路径', '只读审计说明']
    },
    {
      name: '抄表生成能耗记录预演审计',
      run: exportMeterReadingEnergyRecordGenerationPreview,
      title: '抄表生成能耗记录预演审计预案',
      headers: ['抄表记录ID', '仪表编码', '仪表名称', '用能单元', '能源类型编码', '能源类型名称', '抄表日期', '月份', '原始用量', '原始单位', '标准化用量', '标准单位', '预演状态', '是否可生成', '原因编码', '原因说明', '已有生成能耗记录ID', '冲突能耗记录ID', '拟生成重复键']
    }
  ];
  previews.forEach((contract) => {
    const csvResult = contract.run({ format: 'csv' });
    const csvText = csvResult.body.toString('utf8').replace(/^﻿/, '');
    assert(csvText.startsWith(`"${contract.title}"`), `${contract.name}.csv 顶部标题必须使用中文业务名称。`);
    assert(csvText.includes(contract.headers.map((header) => `"${header}"`).join(',')), `${contract.name}.csv 明细首行必须完整使用中文标题。`);
    assert(!csvText.includes('unexpectedInternalKey'), `${contract.name}.csv 不得暴露未知内部 key。`);
    const xlsxResult = contract.run({ format: 'xlsx' });
    const workbook = XLSX.read(xlsxResult.body, { type: 'buffer' });
    assert.deepStrictEqual(workbook.SheetNames, ['预案元信息', '预演明细'], `${contract.name}.xlsx 必须使用中文工作表名称。`);
    const metaSheet = workbook.Sheets['预案元信息'];
    const metaRows = XLSX.utils.sheet_to_json(metaSheet, { header: 1, blankrows: false });
    assert.deepStrictEqual(metaRows[0], [contract.title], `${contract.name}.xlsx 第一行必须是独立中文顶部标题。`);
    assert.deepStrictEqual(metaRows[1], ['字段', '值'], `${contract.name}.xlsx 第二行必须使用中文元信息标签。`);
    assert.deepStrictEqual(metaSheet['!merges'], [{ s: { c: 0, r: 0 }, e: { c: 1, r: 0 } }], `${contract.name}.xlsx 顶部标题必须合并 A1:B1。`);
    const detailRows = XLSX.utils.sheet_to_json(workbook.Sheets['预演明细'], { header: 1, blankrows: false });
    assert.deepStrictEqual(detailRows[0], contract.headers, `${contract.name}.xlsx 明细首行必须完整使用中文标题。`);
  });
}

/** 请求模板下载接口并保留二进制响应。 */
function request(server, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson && body.length ? JSON.parse(body.toString('utf8')) : body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let server;
  try {
    initDatabase();
    EXPECTED_EXPORT_CONTRACTS.forEach(assertExportContract);
    assertPreviewExportContracts();
    register({ username: 'template-reader', password: 'Password123!' });
    const { app } = require('../index');
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const login = (username, password) => new Promise((resolve, reject) => {
      const raw = JSON.stringify({ username, password });
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/api/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', reject);
      req.end(raw);
    });
    const adminToken = (await login('admin', 'AdminPassword123!')).data.token;
    const ordinaryToken = (await login('template-reader', 'Password123!')).data.token;
    const observedAsciiNames = new Set();

    const ledgerTemplates = [
      'organization-units',
      'meters',
      'meter-readings',
      'production-units',
      'production-outputs',
      'generation-records'
    ];
    for (const templateType of ledgerTemplates) {
      for (const format of ['xlsx', 'csv']) {
        const pathname = `/api/templates/${templateType}.${format}`;
        const anonymous = await request(server, pathname);
        assert.strictEqual(anonymous.status, 401, `${pathname} 必须拒绝匿名下载。`);
        assert.strictEqual(anonymous.body.error.code, 'UNAUTHENTICATED');

        const forbidden = await request(server, pathname, ordinaryToken);
        assert.strictEqual(forbidden.status, 403, `${pathname} 必须拒绝无权限普通用户。`);
        assert.strictEqual(forbidden.body.error.code, 'FORBIDDEN');

        const allowed = await request(server, pathname, adminToken);
        assert.strictEqual(allowed.status, 200, `${pathname} 必须允许超级管理员下载。`);
        assert.strictEqual(allowed.headers['x-template-type'], templateType);
        assert(allowed.body.length > 0, `${pathname} 必须返回非空模板内容。`);
        assertExactTemplateHeaders(templateType, format, allowed.body);
        assertHttpDownloadResponse(allowed, {
          name: `${templateType} 模板`,
          asciiBase: EXPECTED_TEMPLATE_ASCII_NAMES[templateType],
          chinesePrefix: `${EXPECTED_TEMPLATE_FILE_NAMES[templateType]}.`
        }, format, observedAsciiNames);
      }
    }

    for (const pathname of ['/api/templates/METERS.XLSX', '/api/templates/%6deters.csv']) {
      assert.strictEqual((await request(server, pathname)).status, 401, `${pathname} 不得绕过认证。`);
      assert.strictEqual((await request(server, pathname, ordinaryToken)).status, 403, `${pathname} 不得绕过权限校验。`);
      assert.strictEqual((await request(server, pathname, adminToken)).status, 200, `${pathname} 应保持合法模板下载。`);
    }

    const protectedBusinessTemplates = ['energy-budgets', 'carbon-factors', 'prediction-configs'];
    for (const templateType of protectedBusinessTemplates) {
      for (const format of ['xlsx', 'csv']) {
        const pathname = `/api/templates/${templateType}.${format}`;
        assert.strictEqual((await request(server, pathname)).status, 401, `${templateType} 模板必须拒绝匿名下载。`);
        assert.strictEqual((await request(server, pathname, ordinaryToken)).status, 403, `${templateType} 模板必须拒绝无权限用户。`);
        const allowed = await request(server, pathname, adminToken);
        assert.strictEqual(allowed.status, 200, `${templateType} 模板必须允许超级管理员下载。`);
        assertExactTemplateHeaders(templateType, format, allowed.body);
        assertHttpDownloadResponse(allowed, {
          name: `${templateType} 模板`,
          asciiBase: EXPECTED_TEMPLATE_ASCII_NAMES[templateType],
          chinesePrefix: `${EXPECTED_TEMPLATE_FILE_NAMES[templateType]}.`
        }, format, observedAsciiNames);
      }
    }
    assert.strictEqual((await request(server, '/api/templates/%65nergy-budgets.csv', ordinaryToken)).status, 403, '编码路径不得绕过预算模板保护。');

    for (const templateType of ['energy-records', 'prediction-history']) {
      for (const format of ['xlsx', 'csv']) {
        const response = await request(server, `/api/templates/${templateType}.${format}`);
        assert.strictEqual(response.status, 200, `${templateType} 历史模板必须保持匿名可下载。`);
        assert.strictEqual(response.headers['x-template-type'], templateType);
        assertExactTemplateHeaders(templateType, format, response.body);
        assertHttpDownloadResponse(response, {
          name: `${templateType} 模板`,
          asciiBase: EXPECTED_TEMPLATE_ASCII_NAMES[templateType],
          chinesePrefix: `${EXPECTED_TEMPLATE_FILE_NAMES[templateType]}.`
        }, format, observedAsciiNames);
      }
    }

    for (const contract of EXPECTED_HTTP_EXPORT_CONTRACTS) {
      for (const format of ['csv', 'xlsx']) {
        const separator = contract.path.includes('?') ? '&' : '?';
        const response = await request(server, `${contract.path}${separator}format=${format}`, adminToken);
        assertHttpDownloadResponse(response, contract, format, observedAsciiNames);
      }
    }
    assert.strictEqual(observedAsciiNames.size, 50, '11 类模板、12 类常规导出和 2 类预演的 CSV/XLSX ASCII fallback 必须全部唯一。');

    // 将实际下载的中文能耗模板回导解析，验证首行可被现有导入映射识别。
    const energyTemplateResponse = await request(server, '/api/templates/energy-records.csv');
    const energyTemplatePath = path.join(tmpDir, '能耗数据导入模板.csv');
    fs.writeFileSync(energyTemplatePath, energyTemplateResponse.body);
    const parsedEnergyTemplate = parseImportFile(energyTemplatePath, '能耗数据导入模板.csv');
    assert(parsedEnergyTemplate.rows.length > 0, '中文能耗模板回导后必须包含示例数据。');
    assert.deepStrictEqual(Object.keys(parsedEnergyTemplate.rows[0]), EXPECTED_TEMPLATE_HEADERS['energy-records'], '中文模板首行回导后必须保持完整顺序。');
    const mappedChineseRow = mapRowFields(parsedEnergyTemplate.rows[0]).mapped;
    assert.strictEqual(mappedChineseRow.month, '2026-01');
    assert.strictEqual(mappedChineseRow.energyType, 'electricity');
    assert.strictEqual(mappedChineseRow.value, '1000');
    assert.strictEqual(mappedChineseRow.meterCode, 'E-001');

    // 旧英文表头继续映射到同一内部字段，作为历史文件兼容回归。
    const mappedEnglishRow = mapRowFields({ period: '2026-01', energy_type: 'electricity', value: '1000', unit: 'kWh', meter_name: 'E-001' }).mapped;
    assert.deepStrictEqual(mappedEnglishRow, { month: '2026-01', energyType: 'electricity', value: '1000', unit: 'kWh', meterCode: 'E-001' });

    console.log('template route permission tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
