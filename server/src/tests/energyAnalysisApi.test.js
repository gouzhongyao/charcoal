'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

// API 测试只使用系统临时目录、隔离 SQLite 和随机端口，禁止访问真实业务数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-analysis-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-analysis-api.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';
process.env.NODE_ENV = 'test';

const { initDatabase, openDatabase } = require('../db/database');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const energyAnalysisRoutes = require('../routes/energyAnalysis');
const {
  ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION,
  ENERGY_ANALYSIS_PERMISSIONS,
  ENERGY_STRATEGY_EVALUATE_PERMISSION,
  LOAD_CURVE_INPUT_FIELDS,
  LOAD_SUMMARY_INPUT_FIELDS,
  MONTHLY_ANALYSIS_INPUT_FIELDS,
  STRATEGY_EVALUATION_INPUT_FIELDS
} = energyAnalysisRoutes;
const { getUserPermissions, login, register } = require('../services/authService');
const { MAX_RULE_CODES } = require('../services/energyStrategyEvaluationService');
const { runWithMaintenance } = require('../services/maintenanceState');

// 独立路由测试挂载路径；正式 server/src/index.js 按阶段要求保持未接入。
const ROUTE_BASE = '/api/energy-analysis';
// 全部成功用例使用的来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 完整覆盖测试窗口开始时间。
const WINDOW_START_UTC = '2026-07-15T00:00:00.000Z';
// 完整覆盖测试窗口结束时间。
const WINDOW_END_UTC = '2026-07-15T01:00:00.000Z';
// 收集全部 HTTP 响应，最终统一检查脱敏边界。
const observedResponses = [];

/**
 * 断言统一响应元数据包含合法 UTC 时间戳。
 * @param {object} response HTTP 响应。
 * @param {boolean} expectedSuccess 是否为成功响应。
 */
function assertUnifiedEnvelope(response, expectedSuccess) {
  assert(response.body && typeof response.body === 'object', '响应正文必须是 JSON 对象。');
  assert.strictEqual(response.body.success, expectedSuccess);
  assert(response.body.meta && typeof response.body.meta === 'object', '响应必须包含 meta。');
  assert.strictEqual(
    new Date(response.body.meta.timestamp).toISOString(),
    response.body.meta.timestamp,
    'meta.timestamp 必须是规范 UTC ISO 时间。'
  );
  if (expectedSuccess) {
    assert(Object.prototype.hasOwnProperty.call(response.body, 'data'), '成功响应必须包含 data。');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body, 'error'), false);
  } else {
    assert(response.body.error && typeof response.body.error.code === 'string', '失败响应必须包含稳定错误码。');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body, 'data'), false);
  }
}

/**
 * 断言响应不泄露 SQLite、临时路径、堆栈或测试密钥。
 * @param {*} value 待检查值。
 * @param {string} label 检查标签。
 */
function assertNoSensitiveData(value, label) {
  // 统一将 Windows 分隔符转换为正斜杠后检查绝对路径。
  const serialized = JSON.stringify(value).replace(/\\\\/g, '\\').replace(/\\/g, '/');
  assert(!serialized.includes(tmpDir.replace(/\\/g, '/')), `${label} 不得包含临时目录。`);
  assert(!serialized.includes(process.env.SQLITE_PATH.replace(/\\/g, '/')), `${label} 不得包含 SQLite 路径。`);
  assert(!serialized.includes(process.env.CHARCOAL_ADMIN_PASSWORD), `${label} 不得包含管理员密钥。`);
  assert(!serialized.includes('SqliteError'), `${label} 不得包含 SQLite 异常类型。`);
  assert(!serialized.includes('SQLITE_'), `${label} 不得包含 SQLite 原始错误码。`);
  assert(!serialized.includes('node:internal'), `${label} 不得包含 Node.js 堆栈。`);
  assert(!serialized.includes(' at '), `${label} 不得包含堆栈片段。`);
}

/**
 * 发起 HTTP 请求并解析统一 JSON 响应。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} method HTTP 方法。
 * @param {string} pathname 请求路径。
 * @param {*} body 可选 JSON 正文。
 * @param {string|null} token 可选 Bearer Token。
 * @returns {Promise<object>} 状态、头、正文和原始文本。
 */
function requestJson(server, method, pathname, body, token = null) {
  return new Promise((resolve, reject) => {
    // undefined 表示不发送请求正文，用于验证空 body 契约。
    const rawBody = body === undefined ? null : JSON.stringify(body);
    // 请求头只在存在令牌或 JSON 正文时设置。
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    // 真实 HTTP 请求使用随机监听端口。
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: pathname,
      headers
    }, (response) => {
      // 响应分块按顺序收集后统一解析。
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        // 空响应保留 null，其他响应必须是 JSON。
        const responseBuffer = Buffer.concat(chunks);
        const text = responseBuffer.toString('utf8');
        const result = {
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
          text
        };
        observedResponses.push(result);
        resolve(result);
      });
    });
    request.on('error', reject);
    if (rawBody !== null) request.write(rawBody);
    request.end();
  });
}

/**
 * 发起原始 JSON 请求，验证应用级解析器的当前错误契约。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} pathname 请求路径。
 * @param {string|Buffer} rawBody 原始请求正文。
 * @param {string} token Bearer Token。
 * @returns {Promise<object>} 状态、头、正文和原始文本。
 */
function requestRawJson(server, pathname, rawBody, token) {
  return new Promise((resolve, reject) => {
    // 原始正文不经过 JSON.stringify，允许构造畸形或超限输入。
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    // 授权请求交由应用级 express.json 先解析。
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length
    };
    // 真实 HTTP 请求使用随机监听端口。
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: pathname,
      headers
    }, (response) => {
      // 响应分块按顺序收集后统一解析。
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        // 当前错误中间件仍返回统一 JSON，不暴露解析器原始错误。
        const responseBuffer = Buffer.concat(chunks);
        const text = responseBuffer.toString('utf8');
        const result = {
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
          text
        };
        observedResponses.push(result);
        resolve(result);
      });
    });
    request.on('error', reject);
    request.end(bodyBuffer);
  });
}

/**
 * 创建标准负荷摘要查询路径。
 * @param {number} meterDeviceId 表计 ID。
 * @param {object} overrides 查询字段覆盖。
 * @returns {string} 完整 API 路径。
 */
function createLoadSummaryPath(meterDeviceId, overrides = {}) {
  // 查询对象保持与服务冻结字段一致。
  const query = {
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: WINDOW_START_UTC,
    endUtc: WINDOW_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    ...overrides
  };
  // URLSearchParams 对合法标量进行百分号编码，避免测试辅助自身拼接注入文本。
  const search = new URLSearchParams();
  Object.entries(query).forEach(([fieldName, value]) => {
    if (value !== undefined) search.append(fieldName, String(value));
  });
  return `${ROUTE_BASE}/consumption/load-summary?${search.toString()}`;
}

/**
 * 创建标准固定 UTC 负荷曲线查询路径。
 * @param {number} meterDeviceId 表计 ID。
 * @param {object} overrides 查询字段覆盖。
 * @returns {string} 完整 API 路径。
 */
function createLoadCurvePath(meterDeviceId, overrides = {}) {
  // 默认输出十五分钟固定 UTC 桶，调用方可覆盖窗口、时区和粒度。
  const query = {
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: WINDOW_START_UTC,
    endUtc: WINDOW_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    outputIntervalMinutes: 15,
    ...overrides
  };
  // 查询参数保持标量形态，重复参数由边界测试显式追加。
  const search = new URLSearchParams();
  Object.entries(query).forEach(([fieldName, value]) => {
    if (value !== undefined) search.append(fieldName, String(value));
  });
  return `${ROUTE_BASE}/consumption/load-curve?${search.toString()}`;
}

/**
 * 创建标准月度消费分析查询路径。
 * @param {object} overrides 查询字段覆盖。
 * @returns {string} 完整 API 路径。
 */
function createMonthlyAnalysisPath(overrides = {}) {
  // 默认覆盖两个月并允许调用方配置精确筛选。
  const query = {
    startMonth: '2026-01',
    endMonth: '2026-02',
    ...overrides
  };
  // 查询参数保持标量形态，重复参数由具体边界测试显式追加。
  const search = new URLSearchParams();
  Object.entries(query).forEach(([fieldName, value]) => {
    if (value !== undefined) search.append(fieldName, String(value));
  });
  return `${ROUTE_BASE}/consumption/monthly-analysis?${search.toString()}`;
}

/**
 * 按能源编码和单位查找月度分析分面。
 * @param {object} responseData 月度分析响应数据。
 * @param {string} energyTypeCode 能源类型编码。
 * @param {string} unit 标准化单位。
 * @returns {object} 唯一分面。
 */
function getMonthlyFacet(responseData, energyTypeCode, unit) {
  const facet = responseData.facets.find((item) => (
    item.energyType.code === energyTypeCode && item.unit === unit
  ));
  assert(facet, `未找到 ${energyTypeCode}/${unit} 月度分面。`);
  return facet;
}

/**
 * 创建标准策略预演正文。
 * @param {number} meterDeviceId 表计 ID。
 * @param {object} overrides 正文字段覆盖。
 * @returns {object} 合法策略预演正文。
 */
function createStrategyBody(meterDeviceId, overrides = {}) {
  return {
    meterDeviceId,
    energyTypeCode: 'electricity',
    unit: 'kWh',
    startUtc: WINDOW_START_UTC,
    endUtc: WINDOW_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    ...overrides
  };
}

/**
 * 向隔离库插入权限菜单并授予指定普通账号。
 * @param {string} username 用户名。
 * @param {string[]} permissionCodes 权限编码。
 */
function grantPermissions(username, permissionCodes) {
  // 短连接只负责当前测试授权，不修改正式 RBAC 种子。
  const db = openDatabase();
  try {
    // 测试授权使用固定格式时间和唯一角色编码。
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    assert(user, `测试账号 ${username} 必须存在。`);
    const roleId = Number(db.prepare(
      `INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`
    ).run(`energy-analysis-api-${username}`, `${username} 能源分析角色`, now, now).lastInsertRowid);
    // 权限菜单仅写入隔离 SQLite，ON CONFLICT 保持辅助函数幂等。
    const insertMenu = db.prepare(
      `INSERT INTO sys_menus (
         menu_type, menu_name, permission_code, sort_order, visible, status, is_builtin, created_at, updated_at
       ) VALUES ('button', ?, ?, 0, 0, 'active', 0, ?, ?)
       ON CONFLICT(permission_code) DO NOTHING`
    );
    permissionCodes.forEach((permissionCode) => {
      insertMenu.run(permissionCode, permissionCode, now, now);
      const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
      db.prepare(
        'INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)'
      ).run(roleId, menu.id, now);
    });
    db.prepare(
      'INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)'
    ).run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

/**
 * 初始化负荷摘要和策略预演使用的完整时序及规则数据。
 * @returns {object} 关键主数据 ID。
 */
function seedAnalysisData() {
  // 所有业务事实只写入隔离 SQLite。
  const db = openDatabase();
  try {
    // 电力与天然气类型来自新库内置基础数据。
    const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
    const naturalGas = db.prepare("SELECT id FROM energy_types WHERE code = 'natural_gas'").get();
    // 测试组织与表计覆盖正常查询及停用历史主数据范围。
    const organizationUnitId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('ANALYSIS-API-OU', '能源分析 API 测试单元', '/ANALYSIS-API-OU', 'workshop', 'active')`
    ).run().lastInsertRowid);
    const inactiveOrganizationUnitId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('ANALYSIS-API-OU-INACTIVE', '能源分析 API 停用单元',
               '/ANALYSIS-API-OU-INACTIVE', 'workshop', 'inactive')`
    ).run().lastInsertRowid);
    const meterDeviceId = Number(db.prepare(
      `INSERT INTO meter_devices (
         meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status
       ) VALUES ('ANALYSIS-API-METER', '能源分析 API 测试表计', 'electricity', ?, ?, 'active')`
    ).run(electricity.id, organizationUnitId).lastInsertRowid);
    const inactiveMeterDeviceId = Number(db.prepare(
      `INSERT INTO meter_devices (
         meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status
       ) VALUES ('ANALYSIS-API-METER-INACTIVE', '能源分析 API 停用表计',
                 'electricity', ?, ?, 'inactive')`
    ).run(electricity.id, inactiveOrganizationUnitId).lastInsertRowid);
    // 连续四条十五分钟事实完整覆盖一小时窗口。
    const insertTimeseries = db.prepare(
      `INSERT INTO energy_timeseries_records (
         organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc,
         source_timezone, granularity_minutes, original_unit, original_value,
         normalized_unit, normalized_value, source_reference, data_source, record_status
       ) VALUES (?, ?, ?, ?, ?, ?, 15, 'kWh', ?, 'kWh', ?, ?, 'manual', 'active')`
    );
    [10, 20, 30, 40].forEach((value, index) => {
      const startMs = Date.parse(WINDOW_START_UTC) + index * 15 * 60 * 1000;
      insertTimeseries.run(
        organizationUnitId,
        meterDeviceId,
        electricity.id,
        new Date(startMs).toISOString(),
        new Date(startMs + 15 * 60 * 1000).toISOString(),
        SOURCE_TIME_ZONE,
        value,
        value,
        `energy-analysis-api:timeseries:${index + 1}`
      );
    });
    // 规则写入函数冻结服务需要的完整有效期和公式版本。
    const insertRule = db.prepare(
      `INSERT INTO strategy_rules (
         rule_code, rule_name, rule_version, formula_version, metric_code,
         threshold_operator, threshold_value, threshold_min, threshold_max, threshold_unit,
         reduction_rate, priority, evidence_requirements_json, recommendation_text, source,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES (?, ?, ?, 'load-analysis:v1', ?, 'gte', ?, NULL, NULL, ?, ?, ?, ?, ?,
         'energy-analysis-api-test', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
         'Asia/Shanghai', 'active')`
    );
    // 合法负荷率规则用于成功和筛选链路。
    insertRule.run(
      'API_LOAD_RATE',
      'API 负荷率规则',
      'api-load-rate:v1',
      'load_rate',
      60,
      '%',
      0.1,
      'high',
      JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: 'window_total_energy' }),
      '请人工复核后调整用能计划。'
    );
    // 合法峰值能源量规则用于多规则确定性预演。
    insertRule.run(
      'API_PEAK_ENERGY',
      'API 峰值能源量规则',
      'api-peak-energy:v1',
      'peak_interval_energy',
      30,
      'kWh/15min',
      null,
      'medium',
      JSON.stringify({ minimumCoverageRate: 1, maxEvidenceItems: 5, savingBasis: null }),
      '请人工复核峰值区间。'
    );
    // 非法证据 JSON 必须逐规则降级，而不是中断整个 API 请求。
    insertRule.run(
      'API_BAD_CONFIG',
      'API 配置降级规则',
      'api-bad-config:v1',
      'load_rate',
      60,
      '%',
      null,
      'low',
      '{bad-json',
      '请人工修正规则配置。'
    );

    // 月度事实覆盖电力、天然气多分面、同环比基期与停用组织历史查询。
    const insertMonthlyRecord = db.prepare(
      `INSERT INTO energy_records (
         energy_type_id, organization_unit_id, meter_device_id,
         original_month, normalized_month, original_unit, original_value,
         normalized_unit, normalized_value, duplicate_key, record_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    );
    const monthlyFacts = [
      [electricity.id, organizationUnitId, meterDeviceId, '2025-01', 'kWh', 50],
      [electricity.id, organizationUnitId, meterDeviceId, '2025-12', 'kWh', 25],
      [electricity.id, organizationUnitId, meterDeviceId, '2026-01', 'kWh', 100],
      [electricity.id, inactiveOrganizationUnitId, inactiveMeterDeviceId, '2026-01', 'kWh', 50],
      [electricity.id, organizationUnitId, meterDeviceId, '2026-02', 'kWh', 200],
      [naturalGas.id, inactiveOrganizationUnitId, null, '2026-01', 'm3', 30],
      [naturalGas.id, organizationUnitId, null, '2026-02', 'm3', 40]
    ];
    monthlyFacts.forEach((fact, index) => {
      const [energyTypeId, monthlyOrganizationId, monthlyMeterId, month, unit, value] = fact;
      insertMonthlyRecord.run(
        energyTypeId,
        monthlyOrganizationId,
        monthlyMeterId,
        month,
        month,
        unit,
        value,
        unit,
        value,
        `energy-analysis-api:monthly:${index + 1}`
      );
    });
    return {
      electricityId: Number(electricity.id),
      naturalGasId: Number(naturalGas.id),
      organizationUnitId,
      inactiveOrganizationUnitId,
      meterDeviceId,
      inactiveMeterDeviceId
    };
  } finally {
    db.close();
  }
}

/**
 * 创建应用级 JSON parser 在前、独立路由在后的隔离 Express 服务。
 * @returns {Promise<object>} 已监听随机端口的 HTTP 服务。
 */
async function startIsolatedServer() {
  // 阶段 8 将按常规全局 JSON parser 后挂载本只读 Router。
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(ROUTE_BASE, energyAnalysisRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 读取策略运行和规则命中表计数。
 * @returns {object} 两张持久化表的记录数。
 */
function getStrategyWriteCounts() {
  // 短连接只读检查预演未产生写入。
  const db = openDatabase();
  try {
    return {
      runs: db.prepare('SELECT COUNT(*) AS total FROM strategy_evaluation_runs').get().total,
      hits: db.prepare('SELECT COUNT(*) AS total FROM strategy_rule_hits').get().total
    };
  } finally {
    db.close();
  }
}

/**
 * 用指定记录替换隔离库时序事实，便于验证曲线聚合、分配和时区投影。
 * @param {object} ids 测试主数据 ID。
 * @param {object[]} records 待写入时序记录。
 */
function replaceAnalysisTimeseries(ids, records) {
  // 每次场景完全替换隔离事实，避免不同曲线用例互相污染。
  const db = openDatabase();
  try {
    db.prepare('DELETE FROM energy_timeseries_records').run();
    const insertRecord = db.prepare(
      `INSERT INTO energy_timeseries_records (
         organization_unit_id, meter_device_id, energy_type_id, start_utc, end_utc,
         source_timezone, granularity_minutes, original_unit, original_value,
         normalized_unit, normalized_value, source_reference, data_source, record_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'kWh', ?, 'kWh', ?, ?, 'manual', 'active')`
    );
    records.forEach((record, index) => {
      insertRecord.run(
        ids.organizationUnitId,
        ids.meterDeviceId,
        ids.electricityId,
        record.startUtc,
        record.endUtc,
        record.sourceTimeZone || SOURCE_TIME_ZONE,
        record.granularityMinutes,
        record.value,
        record.value,
        `energy-analysis-api:curve-scenario:${index + 1}`
      );
    });
  } finally {
    db.close();
  }
}

/**
 * 恢复摘要、策略和曲线成功用例使用的四条十五分钟事实。
 * @param {object} ids 测试主数据 ID。
 */
function restoreDefaultTimeseries(ids) {
  // 恢复一小时完整覆盖，确保原三个 API 的回归断言保持稳定。
  replaceAnalysisTimeseries(ids, [10, 20, 30, 40].map((value, index) => ({
    startUtc: new Date(Date.parse(WINDOW_START_UTC) + index * 15 * 60 * 1000).toISOString(),
    endUtc: new Date(Date.parse(WINDOW_START_UTC) + (index + 1) * 15 * 60 * 1000).toISOString(),
    granularityMinutes: 15,
    value
  })));
}

/**
 * 校验公开权限、字段白名单和 Router 精确包含四条指定只读语义路由。
 */
function testStaticRouterContract() {
  assert.strictEqual(ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION, 'energy:analysis:view');
  assert.strictEqual(ENERGY_STRATEGY_EVALUATE_PERMISSION, 'energy:strategy:evaluate');
  assert.deepStrictEqual(ENERGY_ANALYSIS_PERMISSIONS, {
    loadSummary: 'energy:analysis:view',
    monthlyAnalysis: 'energy:analysis:view',
    loadCurve: 'energy:analysis:view',
    strategyEvaluate: 'energy:strategy:evaluate'
  });
  assert.deepStrictEqual(LOAD_CURVE_INPUT_FIELDS, [
    'meterDeviceId', 'energyTypeCode', 'unit', 'startUtc', 'endUtc',
    'sourceTimeZone', 'outputIntervalMinutes'
  ]);
  assert.deepStrictEqual(LOAD_SUMMARY_INPUT_FIELDS, [
    'meterDeviceId', 'energyTypeCode', 'unit', 'startUtc', 'endUtc',
    'sourceTimeZone', 'minimumCoverageRate'
  ]);
  assert.deepStrictEqual(MONTHLY_ANALYSIS_INPUT_FIELDS, [
    'startMonth', 'endMonth', 'organizationUnitId', 'includeDescendants',
    'energyTypeCode', 'unit', 'topN'
  ]);
  assert.deepStrictEqual(STRATEGY_EVALUATION_INPUT_FIELDS, [
    ...LOAD_SUMMARY_INPUT_FIELDS,
    'ruleCodes'
  ]);
  // Express 路由栈必须只有指定 GET 和只读语义 POST，不得出现 PUT/PATCH/DELETE 或隐藏写接口。
  const routeDefinitions = energyAnalysisRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort()
    }));
  assert.deepStrictEqual(routeDefinitions, [
    { path: '/consumption/load-summary', methods: ['get'] },
    { path: '/consumption/monthly-analysis', methods: ['get'] },
    { path: '/consumption/load-curve', methods: ['get'] },
    { path: '/strategies/evaluate', methods: ['post'] }
  ]);
  assert.strictEqual(JSON.stringify(routeDefinitions).includes('put'), false);
  assert.strictEqual(JSON.stringify(routeDefinitions).includes('patch'), false);
  assert.strictEqual(JSON.stringify(routeDefinitions).includes('delete'), false);
}

/**
 * 校验未认证、无权限和两个最小权限账号的独立互拒矩阵。
 * @param {object} server 隔离 HTTP 服务。
 * @param {object} tokens 测试令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testAuthenticationAndPermissionMatrix(server, tokens, meterDeviceId) {
  // 两个标准请求分别命中查看权限和策略预演权限。
  const getPath = createLoadSummaryPath(meterDeviceId);
  const monthlyPath = createMonthlyAnalysisPath();
  const curvePath = createLoadCurvePath(meterDeviceId);
  const postPath = `${ROUTE_BASE}/strategies/evaluate`;
  const postBody = createStrategyBody(meterDeviceId, { ruleCodes: ['API_LOAD_RATE'] });

  const anonymousGet = await requestJson(server, 'GET', getPath, undefined);
  assert.strictEqual(anonymousGet.status, 401);
  assert.strictEqual(anonymousGet.body.error.code, 'UNAUTHENTICATED');
  assertUnifiedEnvelope(anonymousGet, false);
  const anonymousMonthly = await requestJson(server, 'GET', monthlyPath, undefined);
  assert.strictEqual(anonymousMonthly.status, 401);
  assert.strictEqual(anonymousMonthly.body.error.code, 'UNAUTHENTICATED');
  const anonymousCurve = await requestJson(server, 'GET', curvePath, undefined);
  assert.strictEqual(anonymousCurve.status, 401);
  assert.strictEqual(anonymousCurve.body.error.code, 'UNAUTHENTICATED');
  const anonymousPost = await requestJson(server, 'POST', postPath, postBody);
  assert.strictEqual(anonymousPost.status, 401);
  assert.strictEqual(anonymousPost.body.error.code, 'UNAUTHENTICATED');

  const deniedGet = await requestJson(server, 'GET', getPath, undefined, tokens.denied);
  assert.strictEqual(deniedGet.status, 403);
  assert.strictEqual(deniedGet.body.error.code, 'FORBIDDEN');
  const deniedMonthly = await requestJson(server, 'GET', monthlyPath, undefined, tokens.denied);
  assert.strictEqual(deniedMonthly.status, 403);
  assert.strictEqual(deniedMonthly.body.error.code, 'FORBIDDEN');
  const deniedCurve = await requestJson(server, 'GET', curvePath, undefined, tokens.denied);
  assert.strictEqual(deniedCurve.status, 403);
  assert.strictEqual(deniedCurve.body.error.code, 'FORBIDDEN');
  const deniedPost = await requestJson(server, 'POST', postPath, postBody, tokens.denied);
  assert.strictEqual(deniedPost.status, 403);
  assert.strictEqual(deniedPost.body.error.code, 'FORBIDDEN');

  const viewAllowed = await requestJson(server, 'GET', getPath, undefined, tokens.viewOnly);
  assert.strictEqual(viewAllowed.status, 200, 'view-only 必须可查询负荷摘要。');
  const viewMonthlyAllowed = await requestJson(server, 'GET', monthlyPath, undefined, tokens.viewOnly);
  assert.strictEqual(viewMonthlyAllowed.status, 200, 'view-only 必须可查询月度消费分析。');
  const viewCurveAllowed = await requestJson(server, 'GET', curvePath, undefined, tokens.viewOnly);
  assert.strictEqual(viewCurveAllowed.status, 200, 'view-only 必须可查询固定 UTC 负荷曲线。');
  const viewDeniedEvaluate = await requestJson(server, 'POST', postPath, postBody, tokens.viewOnly);
  assert.strictEqual(viewDeniedEvaluate.status, 403, 'view-only 不得预演策略。');

  const evaluateDeniedView = await requestJson(server, 'GET', getPath, undefined, tokens.evaluateOnly);
  assert.strictEqual(evaluateDeniedView.status, 403, 'evaluate-only 不得查询负荷摘要。');
  const evaluateDeniedMonthly = await requestJson(server, 'GET', monthlyPath, undefined, tokens.evaluateOnly);
  assert.strictEqual(evaluateDeniedMonthly.status, 403, 'evaluate-only 不得查询月度消费分析。');
  const evaluateDeniedCurve = await requestJson(server, 'GET', curvePath, undefined, tokens.evaluateOnly);
  assert.strictEqual(evaluateDeniedCurve.status, 403, 'evaluate-only 不得查询固定 UTC 负荷曲线。');
  const evaluateAllowed = await requestJson(server, 'POST', postPath, postBody, tokens.evaluateOnly);
  assert.strictEqual(evaluateAllowed.status, 200, 'evaluate-only 必须可执行只读策略预演。');
}

/**
 * 校验四个原有与新增成功接口的服务数据、统一 envelope 和只读公式元数据。
 * @param {object} server 隔离 HTTP 服务。
 * @param {object} tokens 测试令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testSuccessfulEndpoints(server, tokens, meterDeviceId) {
  const loadResponse = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, { ignoredQueryField: 'must-not-reach-service' }),
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(loadResponse.status, 200);
  assertUnifiedEnvelope(loadResponse, true);
  assert.strictEqual(loadResponse.body.data.recordCount, 4);
  assert.strictEqual(loadResponse.body.data.metrics.totalEnergy, 100);
  assert.strictEqual(loadResponse.body.data.metrics.loadRatePercent, 62.5);
  assert.strictEqual(loadResponse.body.data.formulaVersion, 'load-analysis:v1');
  assert.strictEqual(loadResponse.body.meta.operation, 'energy-load-summary');
  assert.strictEqual(loadResponse.body.meta.readOnly, true);
  assert.strictEqual(loadResponse.body.meta.maintenanceAllowed, true);
  assert.strictEqual(loadResponse.body.meta.formulaVersion, loadResponse.body.data.formulaVersion);

  const monthlyResponse = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ ignoredQueryField: 'must-not-reach-service' }),
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(monthlyResponse.status, 200);
  assertUnifiedEnvelope(monthlyResponse, true);
  assert.strictEqual(monthlyResponse.body.data.dataStatus, 'available');
  assert.strictEqual(monthlyResponse.body.data.facets.length, 2);
  const electricityFacet = getMonthlyFacet(monthlyResponse.body.data, 'electricity', 'kWh');
  assert.deepStrictEqual(electricityFacet.totals, {
    value: 350,
    recordCount: 3,
    observedMonthCount: 2,
    rangeMonthCount: 2
  });
  assert.deepStrictEqual(
    electricityFacet.trend.map((point) => [point.month, point.value]),
    [['2026-01', 150], ['2026-02', 200]]
  );
  assert.strictEqual(getMonthlyFacet(monthlyResponse.body.data, 'natural_gas', 'm3').totals.value, 70);
  assert.strictEqual(monthlyResponse.body.data.formulaVersion, 'monthly-consumption-analysis:v1');
  assert.strictEqual(monthlyResponse.body.meta.operation, 'monthly-consumption-analysis');
  assert.strictEqual(monthlyResponse.body.meta.readOnly, true);
  assert.strictEqual(monthlyResponse.body.meta.maintenanceAllowed, true);
  assert.strictEqual(monthlyResponse.body.meta.formulaVersion, monthlyResponse.body.data.formulaVersion);

  const curveResponse = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, { ignoredQueryField: 'must-not-reach-service' }),
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(curveResponse.status, 200);
  assertUnifiedEnvelope(curveResponse, true);
  assert.strictEqual(curveResponse.body.data.formulaVersion, 'load-curve-analysis:v1');
  assert.strictEqual(curveResponse.body.data.dataRange.outputIntervalMinutes, 15);
  assert.deepStrictEqual(curveResponse.body.data.buckets.map((bucket) => bucket.energy), [10, 20, 30, 40]);
  assert.strictEqual(curveResponse.body.data.metrics.totalEnergy, 100);
  assert.strictEqual(curveResponse.body.meta.operation, 'energy-load-curve');
  assert.strictEqual(curveResponse.body.meta.readOnly, true);
  assert.strictEqual(curveResponse.body.meta.maintenanceAllowed, true);
  assert.strictEqual(curveResponse.body.meta.formulaVersion, curveResponse.body.data.formulaVersion);

  const strategyResponse = await requestJson(
    server,
    'POST',
    `${ROUTE_BASE}/strategies/evaluate`,
    createStrategyBody(meterDeviceId, {
      ruleCodes: ['API_LOAD_RATE'],
      ignoredField: 'must-not-reach-service',
      testOnlyAfterLoadSummary: 'must-not-run',
      db: { filename: 'C:\\private\\forbidden.sqlite' }
    }),
    tokens.evaluateOnly
  );
  assert.strictEqual(strategyResponse.status, 200);
  assertUnifiedEnvelope(strategyResponse, true);
  assert.strictEqual(strategyResponse.body.data.dryRun, true);
  assert.strictEqual(strategyResponse.body.data.persistsEvaluationRun, false);
  assert.deepStrictEqual(strategyResponse.body.data.ruleSelection.requestedRuleCodes, ['API_LOAD_RATE']);
  assert.strictEqual(strategyResponse.body.data.ruleSelection.selectedRuleCount, 1);
  assert.strictEqual(strategyResponse.body.data.evaluations[0].ruleCode, 'API_LOAD_RATE');
  assert.strictEqual(strategyResponse.body.data.evaluations[0].matchStatus, 'matched');
  assert.strictEqual(strategyResponse.body.meta.operation, 'energy-strategy-evaluation');
  assert.strictEqual(strategyResponse.body.meta.readOnly, true);
  assert.strictEqual(strategyResponse.body.meta.maintenanceAllowed, true);
  assert.strictEqual(strategyResponse.body.meta.formulaVersion, strategyResponse.body.data.formulaVersion);
  assert.deepStrictEqual(getStrategyWriteCounts(), { runs: 0, hits: 0 });
}

/**
 * 校验维护态不阻断两个只读接口，且策略运行与命中表保持零写。
 * @param {object} server 隔离 HTTP 服务。
 * @param {object} tokens 测试令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testMaintenanceReadAvailability(server, tokens, meterDeviceId) {
  const beforeCounts = getStrategyWriteCounts();
  await runWithMaintenance('energy-analysis-api-read-only-test', async () => {
    const loadResponse = await requestJson(
      server,
      'GET',
      createLoadSummaryPath(meterDeviceId),
      undefined,
      tokens.viewOnly
    );
    assert.strictEqual(loadResponse.status, 200, '维护态必须允许负荷摘要只读查询。');
    const monthlyResponse = await requestJson(
      server,
      'GET',
      createMonthlyAnalysisPath(),
      undefined,
      tokens.viewOnly
    );
    assert.strictEqual(monthlyResponse.status, 200, '维护态必须允许月度消费分析只读查询。');
    assert.strictEqual(monthlyResponse.body.meta.readOnly, true);
    const curveResponse = await requestJson(
      server,
      'GET',
      createLoadCurvePath(meterDeviceId),
      undefined,
      tokens.viewOnly
    );
    assert.strictEqual(curveResponse.status, 200, '维护态必须允许负荷曲线只读查询。');
    assert.strictEqual(curveResponse.body.meta.maintenanceAllowed, true);
    const strategyResponse = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/strategies/evaluate`,
      createStrategyBody(meterDeviceId, { ruleCodes: ['API_LOAD_RATE'] }),
      tokens.evaluateOnly
    );
    assert.strictEqual(strategyResponse.status, 200, '维护态必须允许确定性只读策略预演。');
    assert.strictEqual(strategyResponse.body.data.persistsEvaluationRun, false);
  });
  assert.deepStrictEqual(getStrategyWriteCounts(), beforeCounts);
  assert.deepStrictEqual(beforeCounts, { runs: 0, hits: 0 });
}

/**
 * 校验 GET 重复参数、注入文本、严格 UTC、IANA 时区和三十一天上限。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testLoadSummaryValidation(server, token, meterDeviceId) {
  // 重复 meterDeviceId 会被 Express 表示为数组，服务必须安全拒绝。
  const duplicateMeterPath = `${createLoadSummaryPath(meterDeviceId)}&meterDeviceId=${meterDeviceId}`;
  const duplicateMeter = await requestJson(server, 'GET', duplicateMeterPath, undefined, token);
  assert.strictEqual(duplicateMeter.status, 400);
  assert.strictEqual(duplicateMeter.body.error.details.code, 'INVALID_METER_DEVICE_ID');

  // 重复 startUtc 同样不得被隐式转换为字符串。
  const repeatedStartPath = `${createLoadSummaryPath(meterDeviceId)}&startUtc=${encodeURIComponent(WINDOW_START_UTC)}`;
  const repeatedStart = await requestJson(server, 'GET', repeatedStartPath, undefined, token);
  assert.strictEqual(repeatedStart.status, 400);
  assert.strictEqual(repeatedStart.body.error.details.code, 'INVALID_START_UTC');

  const injectionMeter = await requestJson(
    server,
    'GET',
    createLoadSummaryPath("1 OR 1=1 --"),
    undefined,
    token
  );
  assert.strictEqual(injectionMeter.status, 400);
  assert.strictEqual(injectionMeter.body.error.details.code, 'INVALID_METER_DEVICE_ID');

  const injectionEnergyType = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, { energyTypeCode: "electricity' OR 1=1 --" }),
    undefined,
    token
  );
  assert.strictEqual(injectionEnergyType.status, 400);
  assert.strictEqual(injectionEnergyType.body.error.details.code, 'ENERGY_LOAD_ENERGY_TYPE_NOT_FOUND');

  const offsetUtc = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, { startUtc: '2026-07-15T08:00:00+08:00' }),
    undefined,
    token
  );
  assert.strictEqual(offsetUtc.status, 400);
  assert.strictEqual(offsetUtc.body.error.details.code, 'INVALID_START_UTC');

  const invalidTimeZone = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, { sourceTimeZone: 'Asia/Not_A_Real_Zone' }),
    undefined,
    token
  );
  assert.strictEqual(invalidTimeZone.status, 400);
  assert.strictEqual(invalidTimeZone.body.error.details.code, 'INVALID_SOURCE_TIME_ZONE');

  const exactThirtyOneDays = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, {
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.000Z'
    }),
    undefined,
    token
  );
  assert.strictEqual(exactThirtyOneDays.status, 200, '恰好三十一天必须允许。');
  assert.strictEqual(exactThirtyOneDays.body.data.dataRange.durationMinutes, 31 * 24 * 60);

  const overThirtyOneDays = await requestJson(
    server,
    'GET',
    createLoadSummaryPath(meterDeviceId, {
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.001Z'
    }),
    undefined,
    token
  );
  assert.strictEqual(overThirtyOneDays.status, 400);
  assert.strictEqual(overThirtyOneDays.body.error.details.code, 'ENERGY_LOAD_TIME_RANGE_EXCEEDED');
}

/**
 * 校验负荷曲线白名单、重复参数、固定粒度、UTC 网格、时区和三十一天边界。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testLoadCurveValidation(server, token, meterDeviceId) {
  const unknownFields = await requestJson(
    server,
    'GET',
    `${createLoadCurvePath(meterDeviceId)}&minimumCoverageRate=not-a-number&db=forbidden`,
    undefined,
    token
  );
  assert.strictEqual(unknownFields.status, 200, '曲线查询必须忽略白名单之外的字段。');

  const repeatedMeter = await requestJson(
    server,
    'GET',
    `${createLoadCurvePath(meterDeviceId)}&meterDeviceId=${meterDeviceId}`,
    undefined,
    token
  );
  assert.strictEqual(repeatedMeter.status, 400);
  assert.strictEqual(repeatedMeter.body.error.details.code, 'INVALID_METER_DEVICE_ID');

  const repeatedInterval = await requestJson(
    server,
    'GET',
    `${createLoadCurvePath(meterDeviceId)}&outputIntervalMinutes=15`,
    undefined,
    token
  );
  assert.strictEqual(repeatedInterval.status, 400);
  assert.strictEqual(repeatedInterval.body.error.details.code, 'INVALID_OUTPUT_INTERVAL_MINUTES');

  const invalidInterval = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, { outputIntervalMinutes: 10 }),
    undefined,
    token
  );
  assert.strictEqual(invalidInterval.status, 400);
  assert.strictEqual(invalidInterval.body.error.details.code, 'INVALID_OUTPUT_INTERVAL_MINUTES');

  const unalignedWindow = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, { startUtc: '2026-07-15T00:01:00.000Z' }),
    undefined,
    token
  );
  assert.strictEqual(unalignedWindow.status, 400);
  assert.strictEqual(unalignedWindow.body.error.details.code, 'ENERGY_LOAD_CURVE_TIME_NOT_ALIGNED');

  const rejectedGmtAlias = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, { sourceTimeZone: 'GMT' }),
    undefined,
    token
  );
  assert.strictEqual(rejectedGmtAlias.status, 400);
  assert.strictEqual(rejectedGmtAlias.body.error.details.code, 'INVALID_SOURCE_TIME_ZONE');

  const unsupportedYearZero = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, {
      startUtc: '0000-01-01T00:00:00.000Z',
      endUtc: '0000-01-01T00:15:00.000Z',
      sourceTimeZone: 'Etc/GMT'
    }),
    undefined,
    token
  );
  assert.strictEqual(unsupportedYearZero.status, 400);
  assert.strictEqual(unsupportedYearZero.body.error.details.code, 'INVALID_START_UTC');
  assertUnifiedEnvelope(unsupportedYearZero, false);
  assertNoSensitiveData(unsupportedYearZero.body, '公元 0000 负荷曲线错误响应');

  const exactThirtyOneDays = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, {
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.000Z',
      outputIntervalMinutes: 60
    }),
    undefined,
    token
  );
  assert.strictEqual(exactThirtyOneDays.status, 200, '曲线查询恰好三十一天必须允许。');
  assert.strictEqual(exactThirtyOneDays.body.data.dataRange.durationMinutes, 31 * 24 * 60);
  assert.strictEqual(exactThirtyOneDays.body.data.dataRange.bucketCount, 31 * 24);

  const overThirtyOneDays = await requestJson(
    server,
    'GET',
    createLoadCurvePath(meterDeviceId, {
      startUtc: '2026-01-01T00:00:00.000Z',
      endUtc: '2026-02-01T01:00:00.000Z',
      outputIntervalMinutes: 60
    }),
    undefined,
    token
  );
  assert.strictEqual(overThirtyOneDays.status, 400);
  assert.strictEqual(overThirtyOneDays.body.error.details.code, 'ENERGY_LOAD_TIME_RANGE_EXCEEDED');
}

/**
 * 校验负荷曲线十五/三十/六十分钟聚合、缺失骨架、分配、Etc/GMT 与 DST fold/key。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {object} ids 测试主数据 ID。
 */
async function testLoadCurveResponseContract(server, token, ids) {
  const fifteenMinutes = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId),
    undefined,
    token
  );
  assert.strictEqual(fifteenMinutes.status, 200);
  assert.deepStrictEqual(fifteenMinutes.body.data.buckets.map((bucket) => bucket.energy), [10, 20, 30, 40]);

  const thirtyMinutes = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId, { outputIntervalMinutes: 30 }),
    undefined,
    token
  );
  assert.strictEqual(thirtyMinutes.status, 200);
  assert.deepStrictEqual(thirtyMinutes.body.data.buckets.map((bucket) => bucket.energy), [30, 70]);

  const sixtyMinutes = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId, { outputIntervalMinutes: 60 }),
    undefined,
    token
  );
  assert.strictEqual(sixtyMinutes.status, 200);
  assert.deepStrictEqual(sixtyMinutes.body.data.buckets.map((bucket) => bucket.energy), [100]);

  const missingSkeleton = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId, {
      startUtc: '2026-07-16T00:00:00.000Z',
      endUtc: '2026-07-16T00:30:00.000Z'
    }),
    undefined,
    token
  );
  assert.strictEqual(missingSkeleton.status, 200);
  assert.strictEqual(missingSkeleton.body.data.quality.status, 'no_data');
  assert.deepStrictEqual(missingSkeleton.body.data.quality.reasonCodes, ['NO_TIMESERIES_DATA']);
  assert.deepStrictEqual(missingSkeleton.body.data.buckets.map((bucket) => bucket.energy), [null, null]);
  assert.strictEqual(missingSkeleton.body.data.localHeatmap.length, 2);
  assert.strictEqual(missingSkeleton.body.data.metrics.observedEnergy, null);
  assert.strictEqual(missingSkeleton.body.data.metrics.totalEnergy, null);

  const earlyYearCurve = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId, {
      startUtc: '0001-01-01T00:00:00.000Z',
      endUtc: '0001-01-01T00:15:00.000Z',
      sourceTimeZone: 'Etc/GMT'
    }),
    undefined,
    token
  );
  assert.strictEqual(earlyYearCurve.status, 200);
  assert.strictEqual(earlyYearCurve.body.data.recordCount, 0);
  assert.strictEqual(earlyYearCurve.body.data.localHeatmap.length, 1);
  assert.strictEqual(earlyYearCurve.body.data.localHeatmap[0].localDate, '0001-01-01');
  assert.match(earlyYearCurve.body.data.localHeatmap[0].localDate, /^\d{4}-\d{2}-\d{2}$/);

  for (const sourceTimeZone of ['America/New_York', 'America/St_Johns']) {
    const unsupportedLocalEra = await requestJson(
      server,
      'GET',
      createLoadCurvePath(ids.meterDeviceId, {
        startUtc: '0001-01-01T00:00:00.000Z',
        endUtc: '0001-01-01T00:15:00.000Z',
        sourceTimeZone
      }),
      undefined,
      token
    );
    assert.strictEqual(unsupportedLocalEra.status, 400);
    assert.strictEqual(
      unsupportedLocalEra.body.error.details.code,
      'ANALYSIS_LOCAL_TIME_RANGE_UNSUPPORTED'
    );
    assert.strictEqual(unsupportedLocalEra.body.error.details.sourceTimeZone, sourceTimeZone);
    assertUnifiedEnvelope(unsupportedLocalEra, false);
    assertNoSensitiveData(unsupportedLocalEra.body, `公元 0001 ${sourceTimeZone} 本地投影范围响应`);
  }

  const fallDst = await requestJson(
    server,
    'GET',
    createLoadCurvePath(ids.meterDeviceId, {
      startUtc: '2026-11-01T05:00:00.000Z',
      endUtc: '2026-11-01T07:00:00.000Z',
      sourceTimeZone: 'America/New_York',
      outputIntervalMinutes: 30
    }),
    undefined,
    token
  );
  assert.strictEqual(fallDst.status, 200);
  assert.deepStrictEqual(fallDst.body.data.localHeatmap.map((bucket) => bucket.localTime), [
    '01:00', '01:30', '01:00', '01:30'
  ]);
  assert.deepStrictEqual(fallDst.body.data.localHeatmap.map((bucket) => bucket.fold), [0, 0, 1, 1]);
  assert.strictEqual(new Set(fallDst.body.data.localHeatmap.map((bucket) => bucket.key)).size, 4);

  try {
    replaceAnalysisTimeseries(ids, [{
      startUtc: WINDOW_START_UTC,
      endUtc: WINDOW_END_UTC,
      granularityMinutes: 60,
      value: 60
    }]);
    const allocated = await requestJson(
      server,
      'GET',
      createLoadCurvePath(ids.meterDeviceId),
      undefined,
      token
    );
    assert.strictEqual(allocated.status, 200);
    assert.deepStrictEqual(allocated.body.data.buckets.map((bucket) => bucket.energy), [15, 15, 15, 15]);
    assert.deepStrictEqual(
      allocated.body.data.buckets.map((bucket) => bucket.observationMode),
      ['allocated', 'allocated', 'allocated', 'allocated']
    );
    assert.strictEqual(allocated.body.data.quality.allocationUsed, true);

    // 31 天内连续 60 分钟来源相对十五分钟网格错开一分钟，末条事实为真实零值。
    const longCurveStartMs = Date.parse('2026-01-01T00:00:00.000Z');
    const shiftedHourlyRecords = Array.from({ length: 745 }, (_item, index) => {
      const recordStartMs = longCurveStartMs - 59 * 60 * 1000 + index * 60 * 60 * 1000;
      return {
        startUtc: new Date(recordStartMs).toISOString(),
        endUtc: new Date(recordStartMs + 60 * 60 * 1000).toISOString(),
        granularityMinutes: 60,
        value: index === 744 ? 0 : 37
      };
    });
    replaceAnalysisTimeseries(ids, shiftedHourlyRecords);
    const longRoundingCurve = await requestJson(
      server,
      'GET',
      createLoadCurvePath(ids.meterDeviceId, {
        startUtc: '2026-01-01T00:00:00.000Z',
        endUtc: '2026-02-01T00:00:00.000Z',
        outputIntervalMinutes: 15
      }),
      undefined,
      token
    );
    assert.strictEqual(longRoundingCurve.status, 200);
    assert.strictEqual(longRoundingCurve.body.data.buckets.length, 31 * 24 * 4);
    assert.strictEqual(longRoundingCurve.body.data.localHeatmap.length, 31 * 24 * 4);
    const finalBucket = longRoundingCurve.body.data.buckets[longRoundingCurve.body.data.buckets.length - 1];
    const finalHeatmapBucket = longRoundingCurve.body.data.localHeatmap[
      longRoundingCurve.body.data.localHeatmap.length - 1
    ];
    assert.strictEqual(finalBucket.energy, 0, '末条真实零值桶必须保持 0。');
    assert.strictEqual(finalBucket.averageLoad, 0, '末条真实零值桶平均负荷必须保持 0。');
    assert.strictEqual(finalHeatmapBucket.energy, 0, '本地热力中的末条真实零值必须保持 0。');
    assert.strictEqual(finalHeatmapBucket.averageLoad, 0);
    longRoundingCurve.body.data.buckets.forEach((bucket) => {
      assert.strictEqual(bucket.energy === null || bucket.energy >= 0, true);
      assert.strictEqual(bucket.averageLoad === null || bucket.averageLoad >= 0, true);
    });
    longRoundingCurve.body.data.localHeatmap.forEach((bucket) => {
      assert.strictEqual(bucket.energy === null || bucket.energy >= 0, true);
      assert.strictEqual(bucket.averageLoad === null || bucket.averageLoad >= 0, true);
    });
    assert.strictEqual(
      longRoundingCurve.body.data.buckets.some((bucket) => bucket.energy === null),
      false,
      '连续来源完整覆盖时不得伪造 missing。'
    );
    assert.strictEqual(missingSkeleton.body.data.buckets.every((bucket) => bucket.energy === null), true);

    replaceAnalysisTimeseries(ids, [{
      startUtc: WINDOW_START_UTC,
      endUtc: '2026-07-15T00:15:00.000Z',
      sourceTimeZone: 'Etc/GMT',
      granularityMinutes: 15,
      value: 12
    }]);
    const etcGmt = await requestJson(
      server,
      'GET',
      createLoadCurvePath(ids.meterDeviceId, {
        endUtc: '2026-07-15T00:15:00.000Z',
        sourceTimeZone: 'Etc/GMT'
      }),
      undefined,
      token
    );
    assert.strictEqual(etcGmt.status, 200);
    assert.strictEqual(etcGmt.body.data.recordCount, 1);
    assert.strictEqual(etcGmt.body.data.buckets[0].energy, 12);
    assert.strictEqual(etcGmt.body.data.localHeatmap[0].utcOffset, '+00:00');
  } finally {
    restoreDefaultTimeseries(ids);
  }
}

/**
 * 校验本地热力投影异常通过统一错误处理中间件返回稳定脱敏五百错误。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testLoadCurveProjectionSanitization(server, token, meterDeviceId) {
  const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  try {
    Intl.DateTimeFormat.prototype.formatToParts = () => [{
      type: 'timeZoneName',
      value: 'UNEXPECTED_OFFSET'
    }];
    const response = await requestJson(
      server,
      'GET',
      createLoadCurvePath(meterDeviceId),
      undefined,
      token
    );
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.body.error.code, 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED');
    assert.deepStrictEqual(response.body.error.details, {
      code: 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED'
    });
    assertNoSensitiveData(response.body, '负荷曲线本地时间投影失败响应');
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
  }

  // 使用此前未请求的时区验证冷缓存 formatter 故障映射，并在恢复 Intl 后重试成功。
  const chathamPath = createLoadCurvePath(meterDeviceId, { sourceTimeZone: 'Pacific/Chatham' });
  try {
    Intl.DateTimeFormat.prototype.formatToParts = function interceptChathamFormatter(...args) {
      if (this.resolvedOptions().timeZone === 'Pacific/Chatham') {
        throw new Error('test-only Pacific/Chatham formatter failure');
      }
      return originalFormatToParts.apply(this, args);
    };
    const coldFormatterFailure = await requestJson(
      server,
      'GET',
      chathamPath,
      undefined,
      token
    );
    assert.strictEqual(coldFormatterFailure.status, 500);
    assert.strictEqual(
      coldFormatterFailure.body.error.code,
      'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED'
    );
    assert.deepStrictEqual(coldFormatterFailure.body.error.details, {
      code: 'ANALYSIS_LOCAL_TIME_PROJECTION_FAILED'
    });
    assertUnifiedEnvelope(coldFormatterFailure, false);
    assertNoSensitiveData(coldFormatterFailure.body, 'Pacific/Chatham 冷缓存 formatter 失败响应');
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
  }

  const recoveredChatham = await requestJson(server, 'GET', chathamPath, undefined, token);
  assert.strictEqual(recoveredChatham.status, 200);
  assertUnifiedEnvelope(recoveredChatham, true);
  assert.strictEqual(recoveredChatham.body.data.scope.sourceTimeZone, 'Pacific/Chatham');
  assert.strictEqual(recoveredChatham.body.data.localHeatmap.length, 4);
  assert.strictEqual(recoveredChatham.body.data.localHeatmap[0].localTime, '12:45');
}

/**
 * 校验月度分析的范围边界、重复参数、组织范围、无数据和筛选配置。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {object} ids 测试主数据 ID。
 */
async function testMonthlyAnalysisValidation(server, token, ids) {
  const oneMonth = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ startMonth: '2026-01', endMonth: '2026-01' }),
    undefined,
    token
  );
  assert.strictEqual(oneMonth.status, 200, '一个月范围必须允许。');
  assert.strictEqual(oneMonth.body.data.scope.monthCount, 1);
  assert.strictEqual(oneMonth.body.data.facets[0].trend.length, 1);

  const thirtySixMonths = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ startMonth: '2024-01', endMonth: '2026-12' }),
    undefined,
    token
  );
  assert.strictEqual(thirtySixMonths.status, 200, '三十六个月范围必须允许。');
  assert.strictEqual(thirtySixMonths.body.data.scope.monthCount, 36);
  assert.strictEqual(thirtySixMonths.body.data.facets[0].trend.length, 36);

  const thirtySevenMonths = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ startMonth: '2023-12', endMonth: '2026-12' }),
    undefined,
    token
  );
  assert.strictEqual(thirtySevenMonths.status, 400);
  assert.strictEqual(thirtySevenMonths.body.error.details.code, 'MONTHLY_ANALYSIS_RANGE_EXCEEDED');

  const repeatedStart = await requestJson(
    server,
    'GET',
    `${createMonthlyAnalysisPath()}&startMonth=2026-01`,
    undefined,
    token
  );
  assert.strictEqual(repeatedStart.status, 400);
  assert.strictEqual(repeatedStart.body.error.details.code, 'INVALID_MONTHLY_ANALYSIS_START_MONTH');

  const descendants = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({
      organizationUnitId: ids.organizationUnitId,
      includeDescendants: true
    }),
    undefined,
    token
  );
  assert.strictEqual(descendants.status, 400);
  assert.strictEqual(descendants.body.error.details.code, 'MONTHLY_ANALYSIS_DESCENDANTS_UNSUPPORTED');

  const inactiveOrganization = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ organizationUnitId: ids.inactiveOrganizationUnitId }),
    undefined,
    token
  );
  assert.strictEqual(inactiveOrganization.status, 200);
  assert.strictEqual(inactiveOrganization.body.data.scope.organizationUnit.status, 'inactive');
  assert.strictEqual(
    getMonthlyFacet(inactiveOrganization.body.data, 'electricity', 'kWh').totals.value,
    50
  );
  assert.strictEqual(
    getMonthlyFacet(inactiveOrganization.body.data, 'natural_gas', 'm3').totals.value,
    30
  );

  const noData = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ startMonth: '2030-01', endMonth: '2030-02' }),
    undefined,
    token
  );
  assert.strictEqual(noData.status, 200, '无数据必须返回正常分析结果。');
  assert.strictEqual(noData.body.data.dataStatus, 'no_data');
  assert.deepStrictEqual(noData.body.data.facets, []);

  const filtered = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ energyTypeCode: 'electricity', unit: 'kWh', topN: 1 }),
    undefined,
    token
  );
  assert.strictEqual(filtered.status, 200);
  assert.strictEqual(filtered.body.data.scope.energyTypeCode, 'electricity');
  assert.strictEqual(filtered.body.data.scope.unit, 'kWh');
  assert.strictEqual(filtered.body.data.scope.topN, 1);
  assert.strictEqual(filtered.body.data.facets.length, 1);
  assert.strictEqual(filtered.body.data.facets[0].organizationTopN.length, 1);
  assert.strictEqual(filtered.body.data.facets[0].meterTopN.length, 1);
}

/**
 * 校验月度聚合非有限值映射为稳定脱敏五百错误。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 查看权限令牌。
 * @param {object} ids 测试主数据 ID。
 */
async function testMonthlyNumericOverflow(server, token, ids) {
  // 两条有限极大事实使 SQLite SUM 变为非有限值，领域服务必须中止整次输出。
  const db = openDatabase();
  try {
    const insertOverflow = db.prepare(
      `INSERT INTO energy_records (
         energy_type_id, organization_unit_id, meter_device_id,
         original_month, normalized_month, original_unit, original_value,
         normalized_unit, normalized_value, duplicate_key, record_status
       ) VALUES (?, ?, ?, '2026-03', '2026-03', 'kWh', ?, 'kWh', ?, ?, 'active')`
    );
    insertOverflow.run(
      ids.electricityId,
      ids.organizationUnitId,
      ids.meterDeviceId,
      1e308,
      1e308,
      'energy-analysis-api:overflow:1'
    );
    insertOverflow.run(
      ids.electricityId,
      ids.inactiveOrganizationUnitId,
      ids.inactiveMeterDeviceId,
      1e308,
      1e308,
      'energy-analysis-api:overflow:2'
    );
  } finally {
    db.close();
  }

  const response = await requestJson(
    server,
    'GET',
    createMonthlyAnalysisPath({ startMonth: '2026-03', endMonth: '2026-03' }),
    undefined,
    token
  );
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.body.error.code, 'ANALYSIS_NUMERIC_OVERFLOW');
  assert.deepStrictEqual(response.body.error.details, { code: 'ANALYSIS_NUMERIC_OVERFLOW' });
  assert.strictEqual(response.text.includes('Infinity'), false);
  assertNoSensitiveData(response.body, '月度数值溢出响应');
}

/**
 * 校验 POST 空正文、非法类型、规则筛选上限、配置降级和质量不足正常返回。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 策略预演权限令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testStrategyValidationAndDegradation(server, token, meterDeviceId) {
  const evaluatePath = `${ROUTE_BASE}/strategies/evaluate`;

  const emptyBody = await requestJson(server, 'POST', evaluatePath, undefined, token);
  assert.strictEqual(emptyBody.status, 400);
  assert.strictEqual(emptyBody.body.error.details.code, 'INVALID_METER_DEVICE_ID');

  const arrayBody = await requestJson(server, 'POST', evaluatePath, [], token);
  assert.strictEqual(arrayBody.status, 400);
  assert.strictEqual(arrayBody.body.error.details.code, 'INVALID_ENERGY_STRATEGY_PREVIEW_INPUT');

  const invalidRuleCodesType = await requestJson(
    server,
    'POST',
    evaluatePath,
    createStrategyBody(meterDeviceId, { ruleCodes: 'API_LOAD_RATE' }),
    token
  );
  assert.strictEqual(invalidRuleCodesType.status, 400);
  assert.strictEqual(invalidRuleCodesType.body.error.details.code, 'INVALID_STRATEGY_RULE_CODES');

  const tooManyRuleCodes = await requestJson(
    server,
    'POST',
    evaluatePath,
    createStrategyBody(meterDeviceId, {
      ruleCodes: Array.from({ length: MAX_RULE_CODES + 1 }, (_item, index) => `API_RULE_${index}`)
    }),
    token
  );
  assert.strictEqual(tooManyRuleCodes.status, 400);
  assert.strictEqual(tooManyRuleCodes.body.error.details.code, 'STRATEGY_RULE_CODE_LIMIT_EXCEEDED');
  assert.strictEqual(tooManyRuleCodes.body.error.details.maximumRuleCodes, MAX_RULE_CODES);

  const filteredRules = await requestJson(
    server,
    'POST',
    evaluatePath,
    createStrategyBody(meterDeviceId, { ruleCodes: ['API_PEAK_ENERGY', 'API_PEAK_ENERGY'] }),
    token
  );
  assert.strictEqual(filteredRules.status, 200);
  assert.deepStrictEqual(filteredRules.body.data.ruleSelection.requestedRuleCodes, ['API_PEAK_ENERGY']);
  assert.deepStrictEqual(filteredRules.body.data.evaluations.map((item) => item.ruleCode), ['API_PEAK_ENERGY']);

  const degradedConfiguration = await requestJson(
    server,
    'POST',
    evaluatePath,
    createStrategyBody(meterDeviceId, { ruleCodes: ['API_BAD_CONFIG'] }),
    token
  );
  assert.strictEqual(degradedConfiguration.status, 200, '单条规则配置错误必须安全降级为 200。');
  assert.strictEqual(degradedConfiguration.body.data.evaluations[0].matchStatus, 'not_evaluable');
  assert.strictEqual(
    degradedConfiguration.body.data.evaluations[0].configurationErrors.includes(
      'INVALID_EVIDENCE_REQUIREMENTS_JSON'
    ),
    true
  );

  const insufficientQuality = await requestJson(
    server,
    'POST',
    evaluatePath,
    createStrategyBody(meterDeviceId, {
      startUtc: '2026-07-16T00:00:00.000Z',
      endUtc: '2026-07-16T01:00:00.000Z',
      ruleCodes: ['API_LOAD_RATE']
    }),
    token
  );
  assert.strictEqual(insufficientQuality.status, 200, '无时序数据属于质量结果而不是 API 异常。');
  assert.strictEqual(insufficientQuality.body.data.dataSummary.quality.status, 'no_data');
  assert.strictEqual(insufficientQuality.body.data.evaluations[0].matchStatus, 'not_evaluable');
  assert.strictEqual(
    insufficientQuality.body.data.evaluations[0].reasonCodes.includes('NO_TIMESERIES_DATA'),
    true
  );
  assert.deepStrictEqual(getStrategyWriteCounts(), { runs: 0, hits: 0 });
}

/**
 * 校验全局 JSON parser 当前将畸形和超限错误交给现有通用 errorHandler 脱敏。
 * 阶段 8 负责在中央错误映射中进一步细分稳定 400/413。
 * @param {object} server 隔离 HTTP 服务。
 * @param {string} token 策略预演权限令牌。
 */
async function testCurrentGlobalJsonErrorContract(server, token) {
  const evaluatePath = `${ROUTE_BASE}/strategies/evaluate`;
  const malformed = await requestRawJson(server, evaluatePath, '{"meterDeviceId":', token);
  assert.strictEqual(malformed.status, 500);
  assert.strictEqual(malformed.body.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(malformed.body.error.details, null);
  assertUnifiedEnvelope(malformed, false);

  const oversized = await requestRawJson(
    server,
    evaluatePath,
    JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024 + 1024) }),
    token
  );
  assert.strictEqual(oversized.status, 500);
  assert.strictEqual(oversized.body.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(oversized.body.error.details, null);
  assertUnifiedEnvelope(oversized, false);
}

/**
 * 校验领域服务底层异常由统一错误处理中间件脱敏为 500。
 * @param {object} server 隔离 HTTP 服务。
 * @param {object} tokens 测试令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testServiceErrorSanitization(server, tokens, meterDeviceId) {
  // 临时改名只影响隔离库，并在 finally 中恢复原表名。
  const db = openDatabase();
  try {
    db.exec('ALTER TABLE energy_timeseries_records RENAME TO energy_timeseries_records_unavailable');
  } finally {
    db.close();
  }
  try {
    const loadFailure = await requestJson(
      server,
      'GET',
      createLoadSummaryPath(meterDeviceId),
      undefined,
      tokens.viewOnly
    );
    assert.strictEqual(loadFailure.status, 500);
    assert.strictEqual(loadFailure.body.error.code, 'INTERNAL_ERROR');
    assert.strictEqual(loadFailure.body.error.details, null);

    const strategyFailure = await requestJson(
      server,
      'POST',
      `${ROUTE_BASE}/strategies/evaluate`,
      createStrategyBody(meterDeviceId, { ruleCodes: ['API_LOAD_RATE'] }),
      tokens.evaluateOnly
    );
    assert.strictEqual(strategyFailure.status, 500);
    assert.strictEqual(strategyFailure.body.error.code, 'INTERNAL_ERROR');
    assert.strictEqual(strategyFailure.body.error.details, null);
  } finally {
    // 无论请求断言是否失败，都恢复隔离表并保持后续外键检查有效。
    const restoreDb = openDatabase();
    try {
      restoreDb.exec('ALTER TABLE energy_timeseries_records_unavailable RENAME TO energy_timeseries_records');
    } finally {
      restoreDb.close();
    }
  }
}

/**
 * 校验未知路径和错误 HTTP 方法统一返回 404。
 * @param {object} server 隔离 HTTP 服务。
 * @param {object} tokens 测试令牌。
 * @param {number} meterDeviceId 表计 ID。
 */
async function testUnknownRoutes(server, tokens, meterDeviceId) {
  const unknown = await requestJson(
    server,
    'GET',
    `${ROUTE_BASE}/unknown`,
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(unknown.body.error.code, 'NOT_FOUND');

  const wrongLoadMethod = await requestJson(
    server,
    'POST',
    `${ROUTE_BASE}/consumption/load-summary`,
    createStrategyBody(meterDeviceId),
    tokens.evaluateOnly
  );
  assert.strictEqual(wrongLoadMethod.status, 404);

  const wrongMonthlyMethod = await requestJson(
    server,
    'POST',
    `${ROUTE_BASE}/consumption/monthly-analysis`,
    { startMonth: '2026-01', endMonth: '2026-02' },
    tokens.viewOnly
  );
  assert.strictEqual(wrongMonthlyMethod.status, 404);

  const wrongCurveMethod = await requestJson(
    server,
    'POST',
    `${ROUTE_BASE}/consumption/load-curve`,
    createStrategyBody(meterDeviceId),
    tokens.viewOnly
  );
  assert.strictEqual(wrongCurveMethod.status, 404);

  const wrongStrategyMethod = await requestJson(
    server,
    'GET',
    `${ROUTE_BASE}/strategies/evaluate`,
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(wrongStrategyMethod.status, 404);

  const forbiddenDelete = await requestJson(
    server,
    'DELETE',
    createLoadSummaryPath(meterDeviceId),
    undefined,
    tokens.viewOnly
  );
  assert.strictEqual(forbiddenDelete.status, 404);
}

(async () => {
  // 服务句柄在 finally 中关闭，避免随机端口残留。
  let server = null;
  try {
    testStaticRouterContract();
    initDatabase();
    // 普通用户分别代表无权限、仅查看、仅预演和双权限账号。
    register({ username: 'analysis-api-denied', password: 'Password123!' });
    register({ username: 'analysis-api-view', password: 'Password123!' });
    register({ username: 'analysis-api-evaluate', password: 'Password123!' });
    register({ username: 'analysis-api-full', password: 'Password123!' });
    grantPermissions('analysis-api-view', [ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION]);
    grantPermissions('analysis-api-evaluate', [ENERGY_STRATEGY_EVALUATE_PERMISSION]);
    grantPermissions('analysis-api-full', [...new Set(Object.values(ENERGY_ANALYSIS_PERMISSIONS))]);
    // 普通注册账号不会因新增 Router 自动获得未写入 RBAC 种子的权限。
    const deniedUser = openDatabase();
    let deniedUserId;
    try {
      deniedUserId = deniedUser.prepare(
        "SELECT id FROM sys_users WHERE username = 'analysis-api-denied'"
      ).get().id;
    } finally {
      deniedUser.close();
    }
    const deniedPermissions = getUserPermissions(deniedUserId);
    assert.strictEqual(deniedPermissions.includes(ENERGY_ANALYSIS_LOAD_SUMMARY_PERMISSION), false);
    assert.strictEqual(deniedPermissions.includes(ENERGY_STRATEGY_EVALUATE_PERMISSION), false);

    const ids = seedAnalysisData();
    // 登录令牌均来自真实会话服务，不使用伪造超级管理员授权成功链路。
    const tokens = {
      denied: login({ username: 'analysis-api-denied', password: 'Password123!' }).token,
      viewOnly: login({ username: 'analysis-api-view', password: 'Password123!' }).token,
      evaluateOnly: login({ username: 'analysis-api-evaluate', password: 'Password123!' }).token,
      full: login({ username: 'analysis-api-full', password: 'Password123!' }).token
    };
    server = await startIsolatedServer();

    await testAuthenticationAndPermissionMatrix(server, tokens, ids.meterDeviceId);
    await testSuccessfulEndpoints(server, tokens, ids.meterDeviceId);
    await testMaintenanceReadAvailability(server, tokens, ids.meterDeviceId);
    await testLoadSummaryValidation(server, tokens.viewOnly, ids.meterDeviceId);
    await testLoadCurveValidation(server, tokens.viewOnly, ids.meterDeviceId);
    await testLoadCurveResponseContract(server, tokens.viewOnly, ids);
    await testLoadCurveProjectionSanitization(server, tokens.viewOnly, ids.meterDeviceId);
    await testMonthlyAnalysisValidation(server, tokens.viewOnly, ids);
    await testStrategyValidationAndDegradation(server, tokens.evaluateOnly, ids.meterDeviceId);
    await testCurrentGlobalJsonErrorContract(server, tokens.evaluateOnly);
    await testUnknownRoutes(server, tokens, ids.meterDeviceId);
    await testServiceErrorSanitization(server, tokens, ids.meterDeviceId);
    await testMonthlyNumericOverflow(server, tokens.viewOnly, ids);

    const db = openDatabase();
    try {
      assert.deepStrictEqual(getStrategyWriteCounts(), { runs: 0, hits: 0 });
      assert.deepStrictEqual(db.pragma('foreign_key_check'), [], 'PRAGMA foreign_key_check 必须为空。');
    } finally {
      db.close();
    }
    observedResponses.forEach((response, index) => {
      assertUnifiedEnvelope(response, response.status >= 200 && response.status < 300);
      assertNoSensitiveData(response.body, `HTTP 响应 ${index + 1}`);
    });
    console.log('energy analysis api tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
