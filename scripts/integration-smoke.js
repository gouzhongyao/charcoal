const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const integrationDataDir = path.join(dataDir, 'integration-smoke');
const uploadsDir = path.join(integrationDataDir, 'uploads');
const backupsDir = path.join(integrationDataDir, 'backups');
const sampleDir = path.join(integrationDataDir, 'samples');
const defaultRunId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runId = sanitizeRunId(process.env.INTEGRATION_SMOKE_RUN_ID || defaultRunId);
const sqlitePath = path.join(integrationDataDir, `integration-smoke-${runId}.sqlite`);
let port = null;
let apiBase = null;
const localBrowserOrigin = 'http://127.0.0.1:7777';

function sanitizeRunId(value) {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || defaultRunId;
}

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertPathInside(baseDir, targetPath, label) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  assert(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), `${label} 必须位于 ${base} 下。`, {
    base,
    target
  });
}

function assertExpectedPath(actualPath, expectedPath, label, details) {
  assert(typeof actualPath === 'string' && actualPath.length > 0, `${label} 必须在 bootstrap 中返回。`, details);
  assert(
    normalizeForCompare(actualPath) === normalizeForCompare(expectedPath),
    `${label} 与本轮 smoke 期望路径不一致。`,
    {
      expected: path.resolve(expectedPath),
      actual: path.resolve(actualPath),
      bootstrap: details
    }
  );
}

function ensureDirs() {
  assertSmokePaths();
  [integrationDataDir, uploadsDir, backupsDir, sampleDir].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
}

function assertSmokePaths() {
  assertPathInside(integrationDataDir, sqlitePath, 'sqlitePath');
  assertPathInside(integrationDataDir, uploadsDir, 'uploadsDir');
  assertPathInside(integrationDataDir, backupsDir, 'backupsDir');
  assertPathInside(integrationDataDir, sampleDir, 'sampleDir');
}

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selectedPort = address && typeof address === 'object' ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}

async function assertPortAvailable(candidatePort) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`INTEGRATION_SMOKE_PORT=${candidatePort} 已被占用，请释放端口或不设置该变量以使用动态端口。`));
        return;
      }
      reject(error);
    });
    server.listen(candidatePort, '127.0.0.1', () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

async function resolveSmokePort() {
  if (process.env.INTEGRATION_SMOKE_PORT) {
    const configuredPort = Number(process.env.INTEGRATION_SMOKE_PORT);
    assert(Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536, 'INTEGRATION_SMOKE_PORT 必须是 1-65535 的整数。', {
      value: process.env.INTEGRATION_SMOKE_PORT
    });
    await assertPortAvailable(configuredPort);
    return configuredPort;
  }

  const selectedPort = await getFreePort();
  assert(Number.isInteger(selectedPort) && selectedPort > 0, '未能动态选择可用本地端口。', { selectedPort });
  return selectedPort;
}

function buildFrontendApiUrl(baseValue, requestPath) {
  const normalizedPath = `/${String(requestPath || '').replace(/^\/+/, '')}`;
  const base = String(baseValue || '').trim().replace(/\/+$/, '');
  const apiPath = normalizedPath.startsWith('/api/') || normalizedPath === '/api'
    ? normalizedPath.replace(/^\/api(?=\/|$)/, '') || '/'
    : normalizedPath;

  if (!base) {
    return `/api${apiPath}`;
  }
  if (base.endsWith('/api')) {
    return `${base}${apiPath}`;
  }
  return `${base}/api${apiPath}`;
}

function assertFrontendApiUrlBuilder() {
  const apiBaseWithoutPrefix = apiBase.replace(/\/api$/, '');
  const expectedDeleteUrl = `${apiBase}/imports/batches/123`;
  const cases = [
    { base: apiBase, path: '/imports/batches/123', expected: expectedDeleteUrl },
    { base: `${apiBase}/`, path: '/imports/batches/123', expected: expectedDeleteUrl },
    { base: apiBaseWithoutPrefix, path: '/imports/batches/123', expected: expectedDeleteUrl },
    { base: apiBase, path: '/api/imports/batches/123', expected: expectedDeleteUrl },
    { base: apiBaseWithoutPrefix, path: '/api/imports/batches/123', expected: expectedDeleteUrl }
  ];
  cases.forEach((item) => {
    const actual = buildFrontendApiUrl(item.base, item.path);
    assert(actual === item.expected, '前端 API URL 构造应稳定保留单个 /api 前缀并指向后端接口。', { ...item, actual });
    assert(!actual.includes('/api/api/'), '前端 API URL 构造不应生成重复 /api。', { ...item, actual });
    assert(!actual.startsWith('http://127.0.0.1:7777'), '前端 API URL 构造不应把 DELETE 请求发往前端 dev server。', { ...item, actual });
  });
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`响应不是 JSON: ${pathname} ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok || !body || body.success !== true) {
    const error = new Error(`接口调用失败: ${pathname} HTTP ${response.status}`);
    error.details = body;
    throw error;
  }
  return body;
}

async function requestJsonWithAbsoluteUrl(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`响应不是 JSON: ${url} ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok || !body || body.success !== true) {
    const error = new Error(`接口调用失败: ${url} HTTP ${response.status}`);
    error.details = body;
    throw error;
  }
  return body;
}

async function requestJsonViaFrontendBuilder(pathname, options = {}) {
  const url = buildFrontendApiUrl(apiBase, pathname);
  const expectedPrefix = `${apiBase}/`;
  assert(url.startsWith(expectedPrefix), '通过前端 API URL 构造发起的请求必须命中真实后端 /api 前缀。', { pathname, apiBase, url, expectedPrefix });
  assert(!url.includes('/api/api/'), '通过前端 API URL 构造发起的请求不应包含重复 /api。', { pathname, apiBase, url });
  return requestJsonWithAbsoluteUrl(url, options);
}

async function requestJsonAllowFailure(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`响应不是 JSON: ${pathname} ${response.status} ${text.slice(0, 200)}`);
  }
  return { ok: response.ok, status: response.status, body };
}

async function requestBytes(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!response.ok) {
    throw new Error(`接口调用失败: ${pathname} HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return { response, bytes, text };
}

async function assertCsvTemplate(templateType, expectedHeader) {
  const result = await requestBytes(`/templates/${templateType}.csv`, { headers: { Origin: localBrowserOrigin } });
  const contentType = result.response.headers.get('content-type') || '';
  const contentDisposition = result.response.headers.get('content-disposition') || '';
  const contentLength = result.response.headers.get('content-length') || '';
  const exposedHeaders = result.response.headers.get('access-control-expose-headers') || '';
  const allowedOrigin = result.response.headers.get('access-control-allow-origin') || '';
  assert(contentType.includes('text/csv') && contentType.toLowerCase().includes('charset=utf-8'), `${templateType} 模板应返回 text/csv; charset=utf-8。`, { contentType });
  assert(contentDisposition.includes('attachment') && contentDisposition.includes('.csv'), `${templateType} 模板应作为 CSV 附件下载。`, { contentDisposition });
  assert(Number(contentLength) === result.bytes.length, `${templateType} CSV 模板应返回正确 Content-Length。`, { contentLength, bytes: result.bytes.length });
  assert(allowedOrigin === localBrowserOrigin, `${templateType} CSV 模板应允许本地前端跨源读取。`, { allowedOrigin, localBrowserOrigin });
  assert(/content-disposition/i.test(exposedHeaders) && /content-length/i.test(exposedHeaders) && /x-recommended-format/i.test(exposedHeaders), `${templateType} CSV 模板应暴露下载相关响应头。`, { exposedHeaders });
  assert(result.bytes[0] === 0xef && result.bytes[1] === 0xbb && result.bytes[2] === 0xbf, `${templateType} 模板应包含 UTF-8 BOM。`, { firstBytes: Array.from(result.bytes.slice(0, 3)) });
  assert(result.text.includes(expectedHeader), `${templateType} 模板应包含预期中文表头。`, { expectedHeader, text: result.text.slice(0, 200) });
  return {
    templateType,
    format: 'csv',
    contentType,
    contentDisposition,
    contentLength,
    exposedHeaders,
    allowedOrigin,
    bytes: result.bytes.length
  };
}

async function assertXlsxTemplate(templateType, expectedHeaders) {
  const result = await requestBytes(`/templates/${templateType}.xlsx`, { headers: { Origin: localBrowserOrigin } });
  const contentType = result.response.headers.get('content-type') || '';
  const contentDisposition = result.response.headers.get('content-disposition') || '';
  const contentLength = result.response.headers.get('content-length') || '';
  const exposedHeaders = result.response.headers.get('access-control-expose-headers') || '';
  const allowedOrigin = result.response.headers.get('access-control-allow-origin') || '';
  const recommendedFormat = result.response.headers.get('x-recommended-format') || '';
  assert(contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), `${templateType} 模板应返回 xlsx Content-Type。`, { contentType });
  assert(contentDisposition.includes('attachment') && contentDisposition.includes('.xlsx'), `${templateType} 模板应作为 xlsx 附件下载。`, { contentDisposition });
  assert(Number(contentLength) === result.bytes.length, `${templateType} xlsx 模板应返回正确 Content-Length。`, { contentLength, bytes: result.bytes.length });
  assert(allowedOrigin === localBrowserOrigin, `${templateType} xlsx 模板应允许本地前端跨源读取。`, { allowedOrigin, localBrowserOrigin });
  assert(/content-disposition/i.test(exposedHeaders) && /content-length/i.test(exposedHeaders) && /x-recommended-format/i.test(exposedHeaders), `${templateType} xlsx 模板应暴露下载相关响应头。`, { exposedHeaders });
  assert(recommendedFormat === 'xlsx', `${templateType} xlsx 模板应声明 X-Recommended-Format=xlsx。`, { recommendedFormat });
  assert(result.bytes[0] === 0x50 && result.bytes[1] === 0x4b, `${templateType} xlsx 模板应具有 ZIP/PK 文件头。`, { firstBytes: Array.from(result.bytes.slice(0, 4)) });

  const workbook = XLSX.read(Buffer.from(result.bytes), { type: 'buffer' });
  assert(workbook.SheetNames.length > 0, `${templateType} xlsx 模板应至少包含一个工作表。`, { sheetNames: workbook.SheetNames });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false });
  const header = rows[0] || [];
  assert(expectedHeaders.every((column, index) => header[index] === column), `${templateType} xlsx 模板第一行中文表头应与契约一致。`, { expectedHeaders, header });
  assert(rows.length >= 3, `${templateType} xlsx 模板应包含表头和至少两行示例。`, { rowCount: rows.length });
  return {
    templateType,
    format: 'xlsx',
    contentType,
    contentDisposition,
    contentLength,
    exposedHeaders,
    allowedOrigin,
    recommendedFormat,
    sheetName: workbook.SheetNames[0],
    rowCount: rows.length,
    bytes: result.bytes.length
  };
}

async function waitForServer(serverProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`后端进程提前退出，exitCode=${serverProcess.exitCode}`);
    }
    try {
      const health = await requestJson('/health');
      if (health.data && health.data.status === 'ok') {
        return health;
      }
    } catch (error) {
      // 服务尚未就绪，继续等待。
    }
    await delay(250);
  }
  throw new Error('等待后端启动超时。');
}

async function assertBootstrapMatchesSmokePaths() {
  const bootstrap = await requestJson('/bootstrap');
  assert(bootstrap.data && bootstrap.data.database && bootstrap.data.database.storage === 'local-file', 'bootstrap 应返回本地 SQLite 存储信息。', bootstrap);

  const database = bootstrap.data.database;
  assertExpectedPath(database.databasePath, sqlitePath, 'bootstrap.database.databasePath', bootstrap);
  assertExpectedPath(database.uploadsDir, uploadsDir, 'bootstrap.database.uploadsDir', bootstrap);
  assertExpectedPath(database.dataDir, integrationDataDir, 'bootstrap.database.dataDir', bootstrap);

  return bootstrap;
}

const ENERGY_IMPORT_HEADERS = ['月份', '能源类型', '用量', '单位', '组织', '地点', '部门', '设备', '备注'];

function createCsv(filename, rows) {
  const filePath = path.join(sampleDir, `${runId}-${filename}`);
  assertPathInside(sampleDir, filePath, '样例 CSV 路径');
  const header = ENERGY_IMPORT_HEADERS;
  const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(escapeCsv).join(',')].concat(rows.map((row) => header.map((column) => escapeCsv(row[column])).join(',')));
  fs.writeFileSync(filePath, `﻿${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function createExcel(filename, rows, options = {}) {
  const filePath = path.join(sampleDir, `${runId}-${filename}`);
  assertPathInside(sampleDir, filePath, options.pathLabel || '样例 Excel 路径');
  const header = options.headers || ENERGY_IMPORT_HEADERS;
  const sheetRows = [header].concat(rows.map((row) => header.map((column) => row[column])));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), options.sheetName || '能耗数据');
  XLSX.writeFile(workbook, filePath, options.bookType ? { bookType: options.bookType } : undefined);
  return filePath;
}

function createXlsx(filename, rows, options = {}) {
  return createExcel(filename, rows, { ...options, pathLabel: '样例 XLSX 路径' });
}

function createXls(filename, rows, options = {}) {
  return createExcel(filename, rows, { ...options, bookType: 'biff8', pathLabel: '样例 XLS 路径' });
}

async function uploadFile(filePath, uploadName = path.basename(filePath), contentType = 'application/octet-stream') {
  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  form.append('file', new Blob([fileBuffer], { type: contentType }), uploadName);
  form.append('duplicateStrategy', 'skip');
  return requestJson('/imports/batches', { method: 'POST', body: form });
}

async function uploadCsv(filePath, uploadName = path.basename(filePath)) {
  return uploadFile(filePath, uploadName, 'text/csv');
}

function assertNotMojibake(value, label) {
  const text = String(value || '');
  assert(!/[ÃÂäåæèéêìíîïðƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ€]/.test(text), `${label} 不应包含常见 mojibake 特征字符。`, { value: text });
}

function createCp1252Mojibake(value) {
  return Array.from(Buffer.from(String(value), 'utf8').toString('latin1')).map((character) => {
    const code = character.charCodeAt(0);
    if (code >= 0x80 && code <= 0x9f) {
      return new TextDecoder('windows-1252').decode(Buffer.from([code]));
    }
    return character;
  }).join('');
}

function insertHistoricalMojibakeBatch(originalFilename) {
  const mojibakeFilename = createCp1252Mojibake(originalFilename);
  const now = new Date().toISOString();
  const db = new Database(sqlitePath);
  try {
    const result = db.prepare(
      `INSERT INTO import_batches (
         original_filename,
         stored_filename,
         file_type,
         file_size_bytes,
         file_sha256,
         status,
         total_rows,
         success_count,
         failure_count,
         skipped_count,
         duplicate_strategy,
         created_at,
         updated_at
       ) VALUES (?, ?, 'xlsx', 0, ?, 'completed', 0, 0, 0, 0, 'skip', ?, ?)`
    ).run(mojibakeFilename, `historical-${runId}.xlsx`, `historical-mojibake-${runId}`, now, now);
    return { id: result.lastInsertRowid, mojibakeFilename, expectedFilename: originalFilename };
  } finally {
    db.close();
  }
}

async function uploadXlsxWithChineseFilename() {
  const xlsx = createXlsx('integration-smoke-chinese-filename.xlsx', [
    { 月份: '2026-04', 能源类型: '电力', 用量: 1300, 单位: 'kWh', 组织: '中文文件名集团', 地点: '三号园区', 部门: '生产部', 设备: 'CN-001', 备注: '中文文件名导入样例' }
  ]);
  return uploadFile(xlsx, '能耗导入中文文件名.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function getFirstBytes(filePath, size = 8) {
  return Array.from(fs.readFileSync(filePath).subarray(0, size));
}

async function assertImportErrorCodes(batchId, expectedCodes, label) {
  const importErrors = await requestJson(`/imports/batches/${batchId}/errors?pageSize=50`);
  const actualCodes = importErrors.data.map((item) => item.errorCode);
  expectedCodes.forEach((code) => {
    assert(actualCodes.includes(code), `${label} 错误明细应包含 ${code}。`, { batchId, expectedCodes, actualCodes, importErrors });
  });
  return importErrors;
}

async function uploadRealisticExcelSamples() {
  const xlsRows = [
    { 月份: '2026年07月', 能源类型: '电力', 用量: '1,560.5', 单位: '度', 组织: '真实样例集团', 地点: '总装车间', 部门: '生产一部', 设备: 'XLS-001', 备注: '旧版 Excel 成功样例' },
    { 月份: '202608', 能源类型: '天然气', 用量: 86.25, 单位: '标方', 组织: '真实样例集团', 地点: '动力站', 部门: '动力部', 设备: 'XLS-002', 备注: '旧版 Excel 天然气样例' }
  ];
  const xlsPath = createXls('integration-smoke-realistic-success.xls', xlsRows);
  const xlsFirstBytes = getFirstBytes(xlsPath);
  assert(xlsFirstBytes.join(',') === '208,207,17,224,161,177,26,225', '.xls 成功样例应由 xlsx 库生成 OLE Compound File 文件头。', { xlsPath, xlsFirstBytes });
  const xlsImport = await uploadFile(xlsPath, '真实能耗样例.xls', 'application/vnd.ms-excel');
  assert(xlsImport.data.status === 'completed', '.xls 中文文件名成功样例应完整导入。', xlsImport);
  assert(xlsImport.data.fileType === 'xls', '.xls 中文文件名成功样例批次类型应为 xls。', xlsImport);
  assert(xlsImport.data.totalRows === xlsRows.length, '.xls 中文文件名成功样例应解析全部数据行。', xlsImport);
  assert(xlsImport.data.successCount === xlsRows.length && xlsImport.data.failureCount === 0, '.xls 中文文件名成功样例不应产生校验失败。', xlsImport);
  assert(xlsImport.data.originalFilename.includes('真实能耗样例'), '.xls 中文上传文件名应保留中文。', xlsImport);
  assertNotMojibake(xlsImport.data.originalFilename, '.xls 中文文件名批次详情');

  const mixedXlsxRows = [
    { 月份: '2026年09月', 能源类型: '电力', 用量: '1,234.5', 单位: '度', 组织: '真实样例集团', 地点: '包装车间', 部门: '生产二部', 设备: 'REAL-XLSX-001', 备注: '中文表头有效数据' },
    { 月份: '202610', 能源类型: '天然气', 用量: 66, 单位: '标方', 组织: '真实样例集团', 地点: '锅炉房', 部门: '动力部', 设备: 'REAL-XLSX-002', 备注: '中文表头有效数据' },
    { 月份: '2026-13', 能源类型: '电力', 用量: 10, 单位: 'kWh', 组织: '真实样例集团', 地点: '错误车间', 部门: '验证部', 设备: 'REAL-XLSX-BAD-MONTH', 备注: '非法月份' },
    { 月份: '2026-11', 能源类型: '电力', 用量: 10, 单位: '箱', 组织: '真实样例集团', 地点: '错误车间', 部门: '验证部', 设备: 'REAL-XLSX-BAD-UNIT', 备注: '非法单位' },
    { 月份: '2026-11', 能源类型: '', 用量: 10, 单位: 'kWh', 组织: '真实样例集团', 地点: '错误车间', 部门: '验证部', 设备: 'REAL-XLSX-MISSING-TYPE', 备注: '必填字段为空' }
  ];
  const mixedXlsxPath = createXlsx('integration-smoke-realistic-mixed.xlsx', mixedXlsxRows);
  const mixedXlsxImport = await uploadFile(mixedXlsxPath, '真实用户能耗混合样例.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert(mixedXlsxImport.data.status === 'completed_with_errors', '真实用户 .xlsx 混合样例应完成且包含错误。', mixedXlsxImport);
  assert(mixedXlsxImport.data.fileType === 'xlsx', '真实用户 .xlsx 混合样例批次类型应为 xlsx。', mixedXlsxImport);
  assert(mixedXlsxImport.data.totalRows === mixedXlsxRows.length, '真实用户 .xlsx 混合样例应解析全部数据行。', mixedXlsxImport);
  assert(mixedXlsxImport.data.successCount === 2 && mixedXlsxImport.data.failureCount === 3, '真实用户 .xlsx 混合样例成功/失败数量应符合预期。', mixedXlsxImport);
  const mixedErrors = await assertImportErrorCodes(mixedXlsxImport.data.id, ['INVALID_MONTH', 'UNSUPPORTED_UNIT', 'REQUIRED_FIELD_MISSING'], '真实用户 .xlsx 混合样例');

  const missingHeaderPath = createXlsx('integration-smoke-missing-required-column.xlsx', [
    { 月份: '2026-12', 能源类型: '电力', 用量: 123, 组织: '缺字段集团', 地点: '缺字段园区', 部门: '验证部', 设备: 'MISSING-UNIT-001', 备注: '缺少单位表头' }
  ], { headers: ['月份', '能源类型', '用量', '组织', '地点', '部门', '设备', '备注'] });
  const missingHeaderImport = await uploadFile(missingHeaderPath, '缺字段样例.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert(missingHeaderImport.data.status === 'completed_with_errors', '缺字段 .xlsx 样例应完成且包含错误。', missingHeaderImport);
  assert(missingHeaderImport.data.successCount === 0 && missingHeaderImport.data.failureCount === 1, '缺字段 .xlsx 样例应整行校验失败。', missingHeaderImport);
  const missingHeaderErrors = await assertImportErrorCodes(missingHeaderImport.data.id, ['REQUIRED_FIELD_MISSING'], '缺字段 .xlsx 样例');
  assert(missingHeaderErrors.data.some((item) => item.fieldName === 'unit'), '缺字段 .xlsx 样例应明确提示缺少单位字段。', missingHeaderErrors);

  return {
    xls: {
      batchId: xlsImport.data.id,
      uploadName: xlsImport.data.originalFilename,
      firstBytes: xlsFirstBytes,
      totalRows: xlsImport.data.totalRows,
      successCount: xlsImport.data.successCount
    },
    mixedXlsx: {
      batchId: mixedXlsxImport.data.id,
      uploadName: mixedXlsxImport.data.originalFilename,
      totalRows: mixedXlsxImport.data.totalRows,
      successCount: mixedXlsxImport.data.successCount,
      failureCount: mixedXlsxImport.data.failureCount,
      errorCodes: Array.from(new Set(mixedErrors.data.map((item) => item.errorCode)))
    },
    missingHeaderXlsx: {
      batchId: missingHeaderImport.data.id,
      uploadName: missingHeaderImport.data.originalFilename,
      totalRows: missingHeaderImport.data.totalRows,
      failureCount: missingHeaderImport.data.failureCount,
      errorCodes: Array.from(new Set(missingHeaderErrors.data.map((item) => item.errorCode)))
    }
  };
}

async function uploadXlsxTemplate(templateType) {
  const result = await requestBytes(`/templates/${templateType}.xlsx`, { headers: { Origin: localBrowserOrigin } });
  const form = new FormData();
  form.append(
    'file',
    new Blob([result.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${templateType}.xlsx`
  );
  form.append('duplicateStrategy', 'skip');
  return requestJson('/imports/batches', { method: 'POST', body: form });
}

function createIncompleteSchemaBackup() {
  const backupName = `energy-carbon-incomplete-schema-${runId}.sqlite`;
  const backupPath = path.join(backupsDir, backupName);
  assertPathInside(backupsDir, backupPath, '残缺 schema 备份路径');
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }

  const db = new Database(backupPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_filename TEXT,
        file_type TEXT,
        status TEXT,
        total_rows INTEGER,
        success_count INTEGER,
        failure_count INTEGER,
        skipped_count INTEGER,
        created_at TEXT
      );
      CREATE TABLE import_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER,
        row_number INTEGER,
        field_name TEXT,
        error_code TEXT,
        error_reason TEXT
      );
      CREATE TABLE energy_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT,
        name TEXT,
        standard_unit TEXT
      );
      CREATE TABLE energy_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_batch_id INTEGER,
        energy_type_id INTEGER,
        normalized_month TEXT,
        normalized_unit TEXT,
        normalized_value REAL,
        record_status TEXT
      );
      CREATE TABLE carbon_factors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        energy_type_id INTEGER,
        unit TEXT,
        factor_value REAL,
        is_active INTEGER
      );
      CREATE TABLE carbon_emissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        energy_record_id INTEGER,
        status TEXT,
        emission_value REAL,
        calculation_method TEXT
      );
      CREATE TABLE prediction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT,
        algorithm TEXT,
        train_start_month TEXT,
        train_end_month TEXT,
        predict_start_month TEXT,
        predict_end_month TEXT
      );
      CREATE TABLE prediction_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prediction_run_id INTEGER,
        target_month TEXT,
        predicted_value REAL,
        predicted_unit TEXT
      );
      INSERT INTO app_meta (key, value) VALUES ('schema_version', 'incomplete-smoke');
    `);
    const quickCheck = db.pragma('quick_check', { simple: true });
    assert(quickCheck === 'ok', '残缺 schema 备份必须能通过 SQLite quick_check，以覆盖结构不兼容场景。', { quickCheck, backupPath });
  } finally {
    db.close();
  }
  return { backupName, backupPath };
}

async function main() {
  ensureDirs();
  port = await resolveSmokePort();
  apiBase = `http://127.0.0.1:${port}/api`;
  assertFrontendApiUrlBuilder();

  const serverEnv = {
    ...process.env,
    PORT: String(port),
    SQLITE_PATH: sqlitePath,
    DATA_DIR: integrationDataDir,
    UPLOADS_DIR: uploadsDir,
    BACKUPS_DIR: backupsDir,
    NODE_ENV: 'development'
  };
  const serverProcess = spawn(process.execPath, [path.join(rootDir, 'server/src/index.js')], {
    cwd: rootDir,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const serverOutput = [];
  serverProcess.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  serverProcess.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));

  try {
    const health = await waitForServer(serverProcess);
    assert(health.data.mode === 'local' && health.data.database === 'sqlite', 'health 应返回本地模式与 SQLite 信息。', health);

    // 写入样例文件、上传 CSV、创建碳因子或预测运行前，先确认当前服务确实使用本轮隔离目录。
    const bootstrap = await assertBootstrapMatchesSmokePaths();

    const importContract = await requestJson('/imports/contract');
    assert(importContract.data.enabledDuplicateStrategies.includes('skip'), '导入契约应启用 skip 重复策略。', importContract);
    assert(importContract.data.pendingDuplicateStrategies.includes('overwrite'), '导入契约应标记 overwrite 为 pending。', importContract);
    assert(importContract.data.templates.recommendedFormat === 'xlsx', '导入契约应声明推荐模板格式为 xlsx。', importContract);
    assert(importContract.data.templates.energyRecords === 'GET /api/templates/energy-records.xlsx', '导入契约应声明能耗 xlsx 模板下载接口。', importContract);

    const templates = await requestJson('/templates');
    const templateTypes = templates.data.map((template) => template.type);
    assert(templateTypes.includes('energy-records'), '模板列表应包含能耗导入模板。', templates);
    assert(templateTypes.includes('carbon-factors'), '模板列表应包含碳因子模板。', templates);
    assert(templateTypes.includes('prediction-history'), '模板列表应包含预测历史模板。', templates);
    templates.data.forEach((template) => {
      assert(template.route === `/api/templates/${template.type}.xlsx`, `${template.type} 模板默认 route 应为单个 /api 前缀的 xlsx 路径。`, template);
      assert(template.downloads && template.downloads.xlsx === template.route, `${template.type} 模板 downloads.xlsx 应与默认 route 一致。`, template);
      assert(template.csvRoute === `/api/templates/${template.type}.csv`, `${template.type} 模板 csvRoute 应为单个 /api 前缀的 csv 路径。`, template);
      assert(!template.route.includes('/api/api/'), `${template.type} 模板 route 不应包含重复 /api。`, template);
    });
    const energyHeaders = ['月份', '能源类型', '用量', '单位', '组织', '地点', '部门', '设备', '备注'];
    const carbonHeaders = ['能源类型', '地区', '年份', '单位', '因子值', '因子单位', '来源', '来源链接', '有效开始日期', '有效结束日期', '是否启用'];
    const energyTemplate = await assertXlsxTemplate('energy-records', energyHeaders);
    const carbonTemplate = await assertXlsxTemplate('carbon-factors', carbonHeaders);
    const predictionTemplate = await assertXlsxTemplate('prediction-history', energyHeaders);
    const carbonTemplateImport = await uploadXlsxTemplate('carbon-factors');
    assert(carbonTemplateImport.data.status === 'failed', '碳因子模板误传到能耗导入入口应直接失败并提示模板类型不匹配。', carbonTemplateImport);
    assert(carbonTemplateImport.data.errorSummary && carbonTemplateImport.data.errorSummary.includes('模板类型不匹配'), '碳因子模板误传摘要应提示模板类型不匹配。', carbonTemplateImport);
    const carbonTemplateErrors = await assertImportErrorCodes(carbonTemplateImport.data.id, ['TEMPLATE_TYPE_MISMATCH'], '碳因子模板误传');
    assert(carbonTemplateErrors.data.some((item) => String(item.errorReason || '').includes('当前入口只支持能耗数据导入')), '碳因子模板误传错误明细应说明当前入口只支持能耗数据导入。', carbonTemplateErrors);
    assert(!carbonTemplateErrors.data.some((item) => item.errorCode === 'REQUIRED_FIELD_MISSING'), '碳因子模板误传不应只显示必填字段缺失。', carbonTemplateErrors);
    const csvCompatibility = [
      await assertCsvTemplate('energy-records', '"月份","能源类型","用量","单位","组织","地点","部门","设备","备注"'),
      await assertCsvTemplate('carbon-factors', '"能源类型","地区","年份","单位","因子值","因子单位","来源","来源链接","有效开始日期","有效结束日期","是否启用"'),
      await assertCsvTemplate('prediction-history', '"月份","能源类型","用量","单位","组织","地点","部门","设备","备注"')
    ];

    const energyTypes = await requestJson('/energy-types');
    assert(Array.isArray(energyTypes.data) && energyTypes.data.some((type) => type.code === 'electricity'), '能源类型应包含 electricity 种子数据。', energyTypes);

    const mixedCsv = createCsv('integration-smoke-mixed.csv', [
      { 月份: '2026-01', 能源类型: '电力', 用量: 1000, 单位: 'kWh', 组织: '烟测集团', 地点: '一号园区', 部门: '生产部', 设备: 'E-001', 备注: '预测与碳核算样例' },
      { 月份: '2026-02', 能源类型: '电力', 用量: 1100, 单位: 'kWh', 组织: '烟测集团', 地点: '一号园区', 部门: '生产部', 设备: 'E-001', 备注: '预测与碳核算样例' },
      { 月份: '2026-03', 能源类型: '电力', 用量: 1200, 单位: 'kWh', 组织: '烟测集团', 地点: '一号园区', 部门: '生产部', 设备: 'E-001', 备注: '预测与碳核算样例' },
      { 月份: '2026-01', 能源类型: '天然气', 用量: 50, 单位: 'm3', 组织: '烟测集团', 地点: '一号园区', 部门: '动力部', 设备: 'G-001', 备注: '缺失因子样例' },
      { 月份: '2026-13', 能源类型: '电力', 用量: 5, 单位: 'kWh', 组织: '烟测集团', 地点: '一号园区', 部门: '生产部', 设备: 'BAD-001', 备注: '月份错误样例' },
      { 月份: '2026-01', 能源类型: '电力', 用量: 10, 单位: '未知单位', 组织: '烟测集团', 地点: '一号园区', 部门: '生产部', 设备: 'BAD-002', 备注: '单位错误样例' }
    ]);

    const firstImport = await uploadCsv(mixedCsv);
    assert(firstImport.data.status === 'completed_with_errors', '混合样例导入应完成且包含错误。', firstImport);
    assert(firstImport.data.successCount === 4, '混合样例应成功导入 4 行。', firstImport);
    assert(firstImport.data.failureCount === 2, '混合样例应失败 2 行。', firstImport);

    const importErrors = await requestJson(`/imports/batches/${firstImport.data.id}/errors?pageSize=20`);
    const errorCodes = importErrors.data.map((item) => item.errorCode);
    assert(errorCodes.includes('INVALID_MONTH'), '错误明细应包含 INVALID_MONTH。', importErrors);
    assert(errorCodes.includes('UNSUPPORTED_UNIT'), '错误明细应包含 UNSUPPORTED_UNIT。', importErrors);

    const duplicateImport = await uploadCsv(mixedCsv);
    assert(duplicateImport.data.successCount === 0, '重复导入不应新增成功记录。', duplicateImport);
    assert(duplicateImport.data.skippedCount === 4, '重复导入应跳过 4 条已存在有效记录。', duplicateImport);
    assert(duplicateImport.data.failureCount === 2, '重复导入仍应记录 2 条校验失败。', duplicateImport);

    const invalidDelete = await requestJsonAllowFailure(`/imports/batches/${firstImport.data.id}abc`, { method: 'DELETE' });
    assert(invalidDelete.status === 400 && invalidDelete.body && invalidDelete.body.success === false, '非法 batchId 文本应返回 400 且不成功。', invalidDelete);
    const batchesAfterInvalidDelete = await requestJson('/imports/batches?page=1&pageSize=20');
    assert(batchesAfterInvalidDelete.data.some((batch) => batch.id === firstImport.data.id), '非法 batchId 删除请求不应删除真实批次。', batchesAfterInvalidDelete);

    const records = await requestJson('/energy-records?pageSize=20&sortBy=normalizedMonth&sortOrder=asc');
    assert(records.data.length === 4, '能耗记录应有 4 条 active 样例。', records);

    const summary = await requestJson('/energy-records/statistics/summary');
    assert(summary.data.recordCount === 4, '能耗统计摘要记录数应为 4。', summary);

    const trend = await requestJson('/energy-records/statistics/monthly-trend?energyTypeCode=electricity');
    assert(trend.data.length === 3, '电力月份趋势应覆盖 3 个月。', trend);

    const dashboard = await requestJson('/dashboard/summary');
    assert(dashboard.data.energy.activeRecordCount === 4, '工作台摘要应读取 4 条能耗记录。', dashboard);

    const backupBeforeMutation = await requestJson('/system/backups', { method: 'POST' });
    assert(backupBeforeMutation.data.backupName && backupBeforeMutation.data.backupName.endsWith('.sqlite'), '创建备份应返回 .sqlite 备份文件名。', backupBeforeMutation);
    assert(backupBeforeMutation.data.reason === 'manual', '手动创建备份应标记 reason=manual。', backupBeforeMutation);
    assertPathInside(backupsDir, path.join(backupsDir, backupBeforeMutation.data.backupName), 'API 备份文件名');
    const backupList = await requestJson('/system/backups');
    assert(backupList.data.some((backup) => backup.backupName === backupBeforeMutation.data.backupName), '备份列表应包含刚创建的备份。', backupList);
    const backupDownload = await requestBytes(`/system/backups/${backupBeforeMutation.data.backupName}/download`, { headers: { Origin: localBrowserOrigin } });
    const backupDownloadLength = backupDownload.response.headers.get('content-length') || '';
    const backupDownloadName = backupDownload.response.headers.get('x-backup-name') || '';
    assert(Number(backupDownloadLength) === backupDownload.bytes.length && backupDownload.bytes.length > 0, '备份下载应返回非空文件和正确 Content-Length。', { backupDownloadLength, bytes: backupDownload.bytes.length });
    assert(backupDownloadName === backupBeforeMutation.data.backupName, '备份下载应暴露受控备份文件名。', { backupDownloadName, backup: backupBeforeMutation.data.backupName });
    const backupForDeletion = await requestJson('/system/backups', { method: 'POST' });
    assert(backupForDeletion.data.backupName && backupForDeletion.data.backupName.endsWith('.sqlite'), '备份删除验证应先创建独立测试备份。', backupForDeletion);
    const deleteBackupResult = await requestJson(`/system/backups/${backupForDeletion.data.backupName}`, { method: 'DELETE' });
    assert(deleteBackupResult.data.deleted === true && deleteBackupResult.data.deletedBackupName === backupForDeletion.data.backupName, '删除备份应返回 deleted 和 deletedBackupName。', deleteBackupResult);
    assert(deleteBackupResult.data.deletedBytes > 0, '删除备份应返回 deletedBytes。', deleteBackupResult);
    const backupListAfterDelete = await requestJson('/system/backups');
    assert(!backupListAfterDelete.data.some((backup) => backup.backupName === backupForDeletion.data.backupName), '删除备份后列表不应再包含该测试备份。', backupListAfterDelete);
    const invalidBackupDelete = await requestJsonAllowFailure('/system/backups/not-allowed.txt', { method: 'DELETE' });
    assert(invalidBackupDelete.status === 400 && invalidBackupDelete.body && invalidBackupDelete.body.success === false, '非法 backupName 删除应返回 400。', invalidBackupDelete);
    const traversalBackupDelete = await requestJsonAllowFailure('/system/backups/%2e%2e%2fenergy-carbon.sqlite', { method: 'DELETE' });
    assert(traversalBackupDelete.status === 400 && traversalBackupDelete.body && traversalBackupDelete.body.success === false, '路径穿越 backupName 删除应返回 400 且不能删除任意文件。', traversalBackupDelete);
    const invalidBackupRestore = await requestJsonAllowFailure('/system/backups/not-allowed.txt/restore', { method: 'POST' });
    assert(invalidBackupRestore.status === 400 && invalidBackupRestore.body && invalidBackupRestore.body.success === false, '非法 backupName 恢复应返回 400。', invalidBackupRestore);

    const corruptBackupName = `energy-carbon-corrupt-${runId}.sqlite`;
    const corruptBackupPath = path.join(backupsDir, corruptBackupName);
    assertPathInside(backupsDir, corruptBackupPath, '损坏备份路径');
    fs.writeFileSync(corruptBackupPath, 'not a sqlite backup', 'utf8');
    const corruptBackupRestore = await requestJsonAllowFailure(`/system/backups/${corruptBackupName}/restore`, { method: 'POST' });
    assert(corruptBackupRestore.status === 400 && corruptBackupRestore.body && corruptBackupRestore.body.error && corruptBackupRestore.body.error.code === 'INVALID_BACKUP_FILE', '损坏备份恢复应返回 INVALID_BACKUP_FILE。', corruptBackupRestore);
    assert(String(corruptBackupRestore.body.error.message || '').includes('备份文件无效/损坏'), '损坏备份恢复应提示备份文件无效/损坏。', corruptBackupRestore);
    const recordsAfterCorruptRestore = await requestJson('/energy-records?pageSize=50');
    assert(recordsAfterCorruptRestore.data.length === 4, '损坏备份不得覆盖当前隔离库数据。', recordsAfterCorruptRestore);

    const incompleteSchemaBackup = createIncompleteSchemaBackup();
    const incompleteSchemaRestore = await requestJsonAllowFailure(`/system/backups/${incompleteSchemaBackup.backupName}/restore`, { method: 'POST' });
    assert(incompleteSchemaRestore.status === 400 && incompleteSchemaRestore.body && incompleteSchemaRestore.body.error && incompleteSchemaRestore.body.error.code === 'INVALID_BACKUP_FILE', 'quick_check 通过但缺少关键列的备份恢复应返回 INVALID_BACKUP_FILE。', incompleteSchemaRestore);
    assert(String(incompleteSchemaRestore.body.error.message || '').includes('关键数据表缺少必要字段'), '残缺 schema 备份恢复应提示关键字段缺失。', incompleteSchemaRestore);
    const recordsAfterIncompleteSchemaRestore = await requestJson('/energy-records?pageSize=50');
    assert(recordsAfterIncompleteSchemaRestore.data.length === 4, '残缺 schema 备份不得覆盖当前隔离库数据。', recordsAfterIncompleteSchemaRestore);

    const restoreMutationCsv = createCsv('integration-smoke-restore-mutation.csv', [
      { 月份: '2026-04', 能源类型: '电力', 用量: 1400, 单位: 'kWh', 组织: '备份恢复验证集团', 地点: '恢复验证园区', 部门: '验证部', 设备: 'RESTORE-001', 备注: '恢复前临时变更' }
    ]);
    const restoreMutationImport = await uploadCsv(restoreMutationCsv);
    assert(restoreMutationImport.data.successCount === 1, '备份恢复验证应先成功制造隔离库临时变更。', restoreMutationImport);
    const recordsBeforeRestore = await requestJson('/energy-records?pageSize=50');
    assert(recordsBeforeRestore.data.length === 5, '恢复前隔离库应包含临时新增记录。', recordsBeforeRestore);
    const restoreResult = await requestJson(`/system/backups/${backupBeforeMutation.data.backupName}/restore`, { method: 'POST' });
    assert(restoreResult.data.restoredFrom.backupName === backupBeforeMutation.data.backupName, '恢复结果应指向所选备份。', restoreResult);
    assert(restoreResult.data.preRestoreBackup && restoreResult.data.preRestoreBackup.backupName.includes('pre-restore'), '恢复前应自动创建 pre-restore 备份。', restoreResult);
    const recordsAfterRestore = await requestJson('/energy-records?pageSize=50');
    assert(recordsAfterRestore.data.length === 4, '恢复后隔离库记录数应回到备份时状态。', recordsAfterRestore);
    assert(!recordsAfterRestore.data.some((record) => record.meterCode === 'RESTORE-001'), '恢复后应移除备份后制造的临时记录。', recordsAfterRestore);
    const backupListAfterRestore = await requestJson('/system/backups');
    assert(backupListAfterRestore.data.some((backup) => backup.backupName === restoreResult.data.preRestoreBackup.backupName), '备份列表应包含自动创建的 pre-restore 备份。', backupListAfterRestore);

    const factor = await requestJson('/carbon/factors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        energyTypeCode: 'electricity',
        region: 'default',
        factorYear: 2026,
        unit: 'kWh',
        factorValue: 0.58,
        factorUnit: 'kgCO2e',
        source: 'integration-smoke',
        isActive: true
      })
    });
    assert(factor.data.id, '应创建电力碳因子。', factor);

    const carbonCalc = await requestJson('/carbon/emissions/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '2026-03', region: 'default' })
    });
    assert(carbonCalc.data.totalRecords === 4, '碳核算应处理 4 条能耗记录。', carbonCalc);
    assert(carbonCalc.data.calculatedCount === 3, '碳核算应计算 3 条电力记录。', carbonCalc);
    assert(carbonCalc.data.missingFactorCount === 1, '碳核算应产生 1 条天然气缺失因子。', carbonCalc);

    const emissions = await requestJson('/carbon/emissions?pageSize=20&sortBy=normalizedMonth&sortOrder=asc');
    const statuses = emissions.data.map((item) => item.status);
    assert(statuses.filter((status) => status === 'calculated').length === 3, '排放结果应包含 3 条 calculated。', emissions);
    assert(statuses.includes('factor_missing'), '排放结果应包含 factor_missing。', emissions);

    const carbonRecalc = await requestJson('/carbon/emissions/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedMonthStart: '2026-01', normalizedMonthEnd: '2026-03', region: 'default' })
    });
    assert(carbonRecalc.data.calculatedCount === 3 && carbonRecalc.data.missingFactorCount === 1, '重复碳核算应保持当前结果计数。', carbonRecalc);
    const superseded = await requestJson('/carbon/emissions?includeSuperseded=true&pageSize=20');
    assert(superseded.data.filter((item) => item.status === 'superseded').length === 4, '重复碳核算后旧结果应标记 superseded。', superseded);

    const chineseFilenameImport = await uploadXlsxWithChineseFilename();
    assert(chineseFilenameImport.data.originalFilename.includes('中文文件名'), '中文文件名上传后批次详情应保留中文原始文件名。', chineseFilenameImport);
    assertNotMojibake(chineseFilenameImport.data.originalFilename, '中文文件名批次详情');
    const historicalMojibakeBatch = insertHistoricalMojibakeBatch('能耗数据导入模板.xlsx');
    assert(historicalMojibakeBatch.mojibakeFilename.includes('è'), '历史 mojibake 构造应覆盖截图中的 è... 特征。', historicalMojibakeBatch);
    const batchesAfterChineseFilename = await requestJson('/imports/batches?page=1&pageSize=50');
    const chineseFilenameBatch = batchesAfterChineseFilename.data.find((batch) => batch.id === chineseFilenameImport.data.id);
    assert(chineseFilenameBatch && chineseFilenameBatch.originalFilename.includes('中文文件名'), '批次列表应返回正常中文文件名。', batchesAfterChineseFilename);
    assert(chineseFilenameBatch.displayFilename && chineseFilenameBatch.displayFilename.includes('中文文件名'), '批次列表应返回 displayFilename 作为显示用中文文件名。', chineseFilenameBatch);
    assertNotMojibake(chineseFilenameBatch.originalFilename, '中文文件名批次列表');
    const historicalBatchFromList = batchesAfterChineseFilename.data.find((batch) => batch.id === historicalMojibakeBatch.id);
    assert(historicalBatchFromList && historicalBatchFromList.originalFilename.includes('能耗数据导入模板'), '历史 mojibake 批次列表应解码为中文文件名。', { historicalMojibakeBatch, historicalBatchFromList });
    assert(historicalBatchFromList.displayFilename && historicalBatchFromList.displayFilename.includes('能耗数据导入模板'), '历史 mojibake 批次应返回 displayFilename 中文兜底。', historicalBatchFromList);
    assertNotMojibake(historicalBatchFromList.originalFilename, '历史 mojibake 批次列表');
    const deleteHistoricalBatch = await requestJsonViaFrontendBuilder(`/imports/batches/${historicalMojibakeBatch.id}`, { method: 'DELETE' });
    assert(deleteHistoricalBatch.data.deletedImportBatches === 1, '历史 mojibake 测试批次应可通过前端同款 DELETE URL 删除。', deleteHistoricalBatch);
    const chineseBatchRecords = await requestJson(`/energy-records?sourceBatchId=${chineseFilenameImport.data.id}&pageSize=20`);
    assert(chineseBatchRecords.data.length === 1, '中文文件名测试批次应导入 1 条能耗记录。', chineseBatchRecords);
    const chineseBatchCarbonCalc = await requestJson('/carbon/emissions/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalizedMonthStart: '2026-04', normalizedMonthEnd: '2026-04', region: 'default' })
    });
    assert(chineseBatchCarbonCalc.data.calculatedCount === 1, '中文文件名测试批次应可生成 1 条碳排放结果。', chineseBatchCarbonCalc);
    const chineseBatchEmissionsBeforeDelete = await requestJson('/carbon/emissions?pageSize=50&sortBy=normalizedMonth&sortOrder=asc');
    assert(chineseBatchEmissionsBeforeDelete.data.some((item) => item.energyRecordId === chineseBatchRecords.data[0].id), '删除前应存在中文文件名批次关联碳排放结果。', chineseBatchEmissionsBeforeDelete);
    const deleteChineseBatch = await requestJsonViaFrontendBuilder(`/imports/batches/${chineseFilenameImport.data.id}`, { method: 'DELETE' });
    assert(deleteChineseBatch.data.deletedEnergyRecords === 1, '删除测试批次应删除 1 条能耗记录。', deleteChineseBatch);
    assert(deleteChineseBatch.data.deletedCarbonEmissions === 1, '删除测试批次应删除 1 条关联碳排放结果。', deleteChineseBatch);
    assert(deleteChineseBatch.data.deletedErrors === 0, '中文文件名成功批次不应有错误明细需要删除。', deleteChineseBatch);
    const batchesAfterDelete = await requestJson('/imports/batches?page=1&pageSize=50');
    assert(!batchesAfterDelete.data.some((batch) => batch.id === chineseFilenameImport.data.id), '删除后批次列表不应再包含测试批次。', batchesAfterDelete);
    const chineseBatchRecordsAfterDelete = await requestJson(`/energy-records?sourceBatchId=${chineseFilenameImport.data.id}&pageSize=20`);
    assert(chineseBatchRecordsAfterDelete.data.length === 0, '删除后不应再能按 sourceBatchId 查询到该批次能耗记录。', chineseBatchRecordsAfterDelete);
    const chineseBatchEmissionsAfterDelete = await requestJson('/carbon/emissions?pageSize=50&includeSuperseded=true');
    assert(!chineseBatchEmissionsAfterDelete.data.some((item) => item.energyRecordId === chineseBatchRecords.data[0].id), '删除后不应再有该批次能耗记录关联碳排放结果。', chineseBatchEmissionsAfterDelete);

    const largeBatchRows = Array.from({ length: 1200 }, (_, index) => ({
      月份: `2026-${String((index % 12) + 1).padStart(2, '0')}`,
      能源类型: '电力',
      用量: 10 + index,
      单位: 'kWh',
      组织: '大批次删除集团',
      地点: '参数上限验证园区',
      部门: '验证部',
      设备: `BULK-${String(index + 1).padStart(4, '0')}`,
      备注: '多记录删除子查询路径验证'
    }));
    const largeBatchCsv = createCsv('integration-smoke-large-delete.csv', largeBatchRows);
    const largeBatchImport = await uploadCsv(largeBatchCsv);
    assert(largeBatchImport.data.status === 'completed', '大批次删除样例应完整导入。', largeBatchImport);
    assert(largeBatchImport.data.successCount === largeBatchRows.length, '大批次删除样例应成功导入全部记录。', largeBatchImport);
    const largeBatchCarbonCalc = await requestJson('/carbon/emissions/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceBatchId: largeBatchImport.data.id, region: 'default', limit: 2000 })
    });
    assert(largeBatchCarbonCalc.data.totalRecords === largeBatchRows.length, '大批次碳核算应处理全部测试记录。', largeBatchCarbonCalc);
    assert(largeBatchCarbonCalc.data.calculatedCount === largeBatchRows.length, '大批次碳核算应生成全部关联碳排放结果。', largeBatchCarbonCalc);
    const deleteLargeBatch = await requestJson(`/imports/batches/${largeBatchImport.data.id}`, { method: 'DELETE' });
    assert(deleteLargeBatch.data.deletedEnergyRecords === largeBatchRows.length, '大批次删除应删除全部能耗记录。', deleteLargeBatch);
    assert(deleteLargeBatch.data.deletedCarbonEmissions === largeBatchRows.length, '大批次删除应通过子查询删除全部关联碳排放结果。', deleteLargeBatch);
    const largeBatchRecordsAfterDelete = await requestJson(`/energy-records?sourceBatchId=${largeBatchImport.data.id}&pageSize=20`);
    assert(largeBatchRecordsAfterDelete.data.length === 0, '大批次删除后不应再能按 sourceBatchId 查询到能耗记录。', largeBatchRecordsAfterDelete);

    const movingAverage = await requestJson('/predictions/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algorithm: 'moving_average',
        energyTypeCode: 'electricity',
        trainStartMonth: '2026-01',
        trainEndMonth: '2026-03',
        predictStartMonth: '2026-04',
        predictEndMonth: '2026-05',
        windowSize: 2
      })
    });
    assert(movingAverage.data.summary.status === 'completed', '3 个月历史 + windowSize=2 应预测成功。', movingAverage);
    assert(movingAverage.data.summary.resultCount === 2, '移动平均应生成 2 条预测结果。', movingAverage);

    const linearTrend = await requestJson('/predictions/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algorithm: 'linear_trend',
        energyTypeCode: 'electricity',
        trainStartMonth: '2026-01',
        trainEndMonth: '2026-03',
        predictStartMonth: '2026-04',
        predictEndMonth: '2026-04'
      })
    });
    assert(linearTrend.data.summary.status === 'completed', '线性趋势预测应成功。', linearTrend);
    assert(linearTrend.data.summary.resultCount === 1, '线性趋势应生成 1 条预测结果。', linearTrend);

    const insufficientCsv = createCsv('integration-smoke-insufficient.csv', [
      { 月份: '2026-01', 能源类型: '柴油', 用量: 100, 单位: 'L', 组织: '烟测集团', 地点: '二号园区', 部门: '物流部', 设备: 'D-001', 备注: '历史不足样例' },
      { 月份: '2026-02', 能源类型: '柴油', 用量: 110, 单位: 'L', 组织: '烟测集团', 地点: '二号园区', 部门: '物流部', 设备: 'D-001', 备注: '历史不足样例' }
    ]);
    const insufficientImport = await uploadCsv(insufficientCsv);
    assert(insufficientImport.data.successCount === 2, '历史不足样例应导入 2 条柴油记录。', insufficientImport);

    const insufficientRun = await requestJson('/predictions/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algorithm: 'moving_average',
        energyTypeCode: 'diesel',
        trainStartMonth: '2026-01',
        trainEndMonth: '2026-02',
        predictStartMonth: '2026-03',
        predictEndMonth: '2026-03',
        windowSize: 2
      })
    });
    assert(insufficientRun.data.summary.status === 'failed', '2 个月历史 + windowSize=2 应失败。', insufficientRun);
    assert(insufficientRun.data.summary.resultCount === 0, '历史不足失败不应写预测结果。', insufficientRun);

    const predictionResults = await requestJson('/predictions/results?pageSize=20');
    assert(predictionResults.data.length === 3, '预测结果总数应只包含成功运行的 3 条。', predictionResults);

    const templateImport = await uploadXlsxTemplate('energy-records');
    assert(['completed', 'completed_with_errors'].includes(templateImport.data.status), '能耗 xlsx 模板上传导入不应无响应或 500。', templateImport);
    assert(templateImport.data.fileType === 'xlsx', '能耗 xlsx 模板上传批次类型应为 xlsx。', templateImport);
    assert(templateImport.data.totalRows === 2, '能耗 xlsx 模板示例应解析出 2 行数据。', templateImport);
    assert(templateImport.data.failureCount === 0, '能耗 xlsx 模板示例不应产生校验失败。', templateImport);
    assert(templateImport.data.successCount >= 1, '能耗 xlsx 模板示例应至少成功导入 1 行非重复数据。', templateImport);
    assert(templateImport.data.successCount + templateImport.data.skippedCount === 2, '能耗 xlsx 模板示例应全部成功或按 skip 跳过重复。', templateImport);

    const realisticExcelSamples = await uploadRealisticExcelSamples();

    console.log(JSON.stringify({
      ok: true,
      apiBase,
      port,
      runId,
      sqlitePath,
      sampleDir,
      bootstrapPaths: {
        dataDir: bootstrap.data.database.dataDir,
        uploadsDir: bootstrap.data.database.uploadsDir,
        databasePath: bootstrap.data.database.databasePath
      },
      assertions: {
        health: 'passed',
        bootstrap: 'passed',
        importContract: 'passed',
        backupRestoreApi: {
          manualBackup: backupBeforeMutation.data.backupName,
          deletedBackup: deleteBackupResult.data.deletedBackupName,
          invalidBackupDeleteStatus: invalidBackupDelete.status,
          traversalBackupDeleteStatus: traversalBackupDelete.status,
          preRestoreBackup: restoreResult.data.preRestoreBackup.backupName,
          restoredRecordCount: recordsAfterRestore.data.length,
          invalidIncompleteSchemaBackup: incompleteSchemaBackup.backupName
        },
        templateMismatchImport: {
          batchId: carbonTemplateImport.data.id,
          status: carbonTemplateImport.data.status,
          errorCodes: Array.from(new Set(carbonTemplateErrors.data.map((item) => item.errorCode)))
        },
        templates: [energyTemplate, carbonTemplate, predictionTemplate],
        csvCompatibility,
        energyTypes: 'passed',
        importMixedCsv: firstImport.data.summary,
        duplicateImport: duplicateImport.data.summary,
        energyRecordCount: records.data.length,
        carbonCalculatedCount: carbonCalc.data.calculatedCount,
        carbonMissingFactorCount: carbonCalc.data.missingFactorCount,
        supersededCount: superseded.data.filter((item) => item.status === 'superseded').length,
        frontendApiUrlBuilder: 'passed',
        invalidBatchIdDeleteStatus: invalidDelete.status,
        chineseFilenameImport: chineseFilenameImport.data.originalFilename,
        historicalMojibakeFilename: historicalBatchFromList.originalFilename,
        deleteImportBatch: deleteChineseBatch.data,
        largeBatchDelete: deleteLargeBatch.data,
        predictionResultCount: predictionResults.data.length,
        insufficientPredictionStatus: insufficientRun.data.summary.status,
        templateXlsxImport: templateImport.data.summary,
        realisticExcelSamples
      }
    }, null, 2));
  } catch (error) {
    console.error('integration smoke failed');
    console.error(error.stack || error.message);
    if (error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    if (serverOutput.length > 0) {
      console.error('server output:');
      console.error(serverOutput.join(''));
    }
    process.exitCode = 1;
  } finally {
    if (serverProcess.exitCode === null) {
      serverProcess.kill('SIGTERM');
      await delay(500);
      if (serverProcess.exitCode === null) {
        serverProcess.kill('SIGKILL');
      }
    }
  }
}

main();
