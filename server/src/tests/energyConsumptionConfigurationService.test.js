'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 配置服务测试仅使用系统临时目录和隔离 SQLite。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-consumption-config-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'energy-consumption-config.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.NODE_ENV = 'test';

const database = require('../db/database');
const {
  createShiftDefinition,
  createShiftDefinitionVersion,
  createStrategyRule,
  createStrategyRuleVersion,
  createTouScheme,
  createTouSchemeVersion,
  listShiftDefinitions,
  listStrategyRules,
  listTouSchemes,
  setShiftDefinitionStatus,
  setStrategyRuleStatus,
  setTouSchemeStatus
} = require('../services/energyConsumptionConfigurationService');

// 配置测试统一使用上海来源时区。
const SOURCE_TIME_ZONE = 'Asia/Shanghai';
// 配置测试统一使用的有效期起点。
const EFFECTIVE_START_UTC = '2026-01-01T00:00:00.000Z';
// 配置测试统一使用的有效期终点。
const EFFECTIVE_END_UTC = '2027-01-01T00:00:00.000Z';

/**
 * 构造每天完整覆盖 0 至 1440 分钟的 TOU 周期规则。
 * @returns {object[]} 七天完整周期规则。
 */
function createCompleteTouRules() {
  const periodRules = [];
  for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
    periodRules.push(
      { dayOfWeek, periodType: 'valley', startMinute: 0, endMinute: 480 },
      { dayOfWeek, periodType: 'flat', startMinute: 480, endMinute: 1080 },
      { dayOfWeek, periodType: 'peak', startMinute: 1080, endMinute: 1440 }
    );
  }
  return periodRules;
}

/**
 * 构造服务审计上下文。
 * @param {number} actorUserId 操作者用户 ID。
 * @param {object} overrides 覆盖选项。
 * @returns {object} 服务选项。
 */
function createOptions(actorUserId, overrides = {}) {
  return {
    actorUserId,
    actorIp: '127.0.0.1',
    ...overrides
  };
}

/**
 * 验证配置业务写入口拒绝缺失或非法操作者。
 */
function testAuditActorRequired() {
  const input = {
    shiftCode: 'SHIFT-AUDIT-ACTOR',
    shiftName: '审计操作者测试班次',
    startMinute: 0,
    endMinute: 480,
    crossesMidnight: false,
    sourceTimeZone: SOURCE_TIME_ZONE,
    source: 'manual-config-test',
    version: 'shift-audit-actor:v1',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    status: 'active'
  };
  [undefined, null, 0, -1, 1.5, '1'].forEach((actorUserId) => {
    const options = actorUserId === undefined ? {} : createOptions(actorUserId);
    assert.throws(
      () => createShiftDefinition(input, options),
      (error) => error.code === 'BAD_REQUEST'
        && error.details
        && error.details.code === 'ENERGY_CONFIGURATION_AUDIT_ACTOR_REQUIRED'
    );
  });
  assert.strictEqual(listShiftDefinitions({ code: 'SHIFT-AUDIT-ACTOR' }).items.length, 0);
}

/**
 * 验证排班定义创建、版本化、启停和审计。
 * @param {number} actorUserId 操作者用户 ID。
 */
function testShiftConfigurationLifecycle(actorUserId) {
  const created = createShiftDefinition({
    shiftCode: 'SHIFT-DAY',
    shiftName: '白班',
    startMinute: 480,
    endMinute: 1020,
    crossesMidnight: false,
    sourceTimeZone: SOURCE_TIME_ZONE,
    source: 'manual-config-test',
    version: 'shift-day:v1',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    status: 'active'
  }, createOptions(actorUserId));
  assert.strictEqual(created.shiftCode, 'SHIFT-DAY');
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.effectiveStartUtc, EFFECTIVE_START_UTC, '首版本必须接受前端 API 边界的 .000Z 时间。');
  assert.strictEqual(created.effectiveEndUtc, EFFECTIVE_END_UTC);
  assert.strictEqual(created.audit.atomic, true);

  // 新版本载荷与前端 buildEnergyAnalysisConfigPayload(hasSource=true) 保持一致，不重复提交冻结编码。
  const versioned = createShiftDefinitionVersion(created.id, {
    shiftName: '白班调整版',
    startMinute: 480,
    endMinute: 1080,
    crossesMidnight: false,
    sourceTimeZone: SOURCE_TIME_ZONE,
    source: 'manual-config-test',
    version: 'shift-day:v2',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    status: 'active'
  }, createOptions(actorUserId));
  assert.strictEqual(versioned.id > created.id, true);
  assert.strictEqual(versioned.version, 'shift-day:v2');
  assert.strictEqual(versioned.endMinute, 1080);
  assert.strictEqual(versioned.effectiveStartUtc, EFFECTIVE_START_UTC, '新版本必须接受前端 API 边界的 .000Z 时间。');
  assert.strictEqual(versioned.effectiveEndUtc, EFFECTIVE_END_UTC);

  const versions = listShiftDefinitions({ code: 'SHIFT-DAY' });
  assert.strictEqual(versions.items.length, 2);
  assert.strictEqual(versions.items.find((item) => item.id === created.id).status, 'inactive');
  assert.strictEqual(versions.items.find((item) => item.id === versioned.id).status, 'active');

  const disabled = setShiftDefinitionStatus(versioned.id, { status: 'inactive' }, createOptions(actorUserId));
  assert.strictEqual(disabled.status, 'inactive');
  const enabled = setShiftDefinitionStatus(created.id, { status: 'active' }, createOptions(actorUserId));
  assert.strictEqual(enabled.status, 'active');
  assert.strictEqual(listShiftDefinitions({ status: 'active', code: 'SHIFT-DAY' }).items.length, 1);
}

/**
 * 验证 TOU 方案和周期规则作为独立版本快照维护。
 * @param {number} actorUserId 操作者用户 ID。
 */
function testTouConfigurationLifecycle(actorUserId) {
  const created = createTouScheme({
    schemeCode: 'TOU-WEEKLY',
    schemeName: '周峰平谷方案',
    sourceTimeZone: SOURCE_TIME_ZONE,
    source: 'manual-config-test',
    documentNo: 'DOC-TOU-001',
    version: 'tou-weekly:v1',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    status: 'active',
    periodRules: createCompleteTouRules()
  }, createOptions(actorUserId));
  assert.strictEqual(created.periodRules.length, 21);
  assert.strictEqual(created.periodRules[0].startMinute, 0);
  assert.strictEqual(created.periodRules[20].endMinute, 1440);

  const versioned = createTouSchemeVersion(created.id, {
    schemeName: '周峰平谷方案调整版',
    version: 'tou-weekly:v2',
    status: 'active'
  }, createOptions(actorUserId));
  assert.strictEqual(versioned.periodRules.length, 21);
  assert.strictEqual(versioned.periodRules.every((rule) => rule.id > 0), true);

  const versions = listTouSchemes({ code: 'TOU-WEEKLY' });
  assert.strictEqual(versions.items.length, 2);
  assert.strictEqual(versions.items.find((item) => item.id === created.id).status, 'inactive');
  assert.strictEqual(versions.items.find((item) => item.id === versioned.id).status, 'active');

  const disabled = setTouSchemeStatus(versioned.id, { status: 'inactive' }, createOptions(actorUserId));
  assert.strictEqual(disabled.status, 'inactive');
  const enabled = setTouSchemeStatus(created.id, { status: 'active' }, createOptions(actorUserId));
  assert.strictEqual(enabled.status, 'active');
}

/**
 * 验证策略规则仅允许固定指标和固定证据对象，并保留版本历史。
 * @param {number} actorUserId 操作者用户 ID。
 */
function testStrategyRuleConfigurationLifecycle(actorUserId) {
  const created = createStrategyRule({
    ruleCode: 'LOAD-RATE-HIGH',
    ruleName: '负荷率较高提示',
    ruleVersion: 'load-rate-high:v1',
    formulaVersion: 'load-analysis:v1',
    metricCode: 'load_rate',
    thresholdOperator: 'gte',
    thresholdValue: 80,
    thresholdUnit: '%',
    reductionRate: 0.1,
    priority: 'high',
    evidenceRequirements: {
      minimumCoverageRate: 1,
      maxEvidenceItems: 10,
      savingBasis: 'window_total_energy'
    },
    recommendationText: '请人工复核后优化高负荷时段用能计划。',
    source: 'manual-config-test',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    status: 'active'
  }, createOptions(actorUserId));
  assert.strictEqual(created.metricCode, 'load_rate');
  assert.strictEqual(created.thresholdValue, 80);
  assert.strictEqual(created.evidenceRequirements.minimumCoverageRate, 1);

  const versioned = createStrategyRuleVersion(created.id, {
    ruleName: '负荷率较高提示调整版',
    ruleVersion: 'load-rate-high:v2',
    thresholdValue: 85,
    status: 'active'
  }, createOptions(actorUserId));
  assert.strictEqual(versioned.thresholdValue, 85);
  assert.strictEqual(versioned.ruleCode, created.ruleCode);

  const versions = listStrategyRules({ code: 'LOAD-RATE-HIGH' });
  assert.strictEqual(versions.items.length, 2);
  assert.strictEqual(versions.items.find((item) => item.id === created.id).status, 'inactive');
  assert.strictEqual(versions.items.find((item) => item.id === versioned.id).status, 'active');

  const disabled = setStrategyRuleStatus(versioned.id, { status: 'inactive' }, createOptions(actorUserId));
  assert.strictEqual(disabled.status, 'inactive');
  const enabled = setStrategyRuleStatus(created.id, { status: 'active' }, createOptions(actorUserId));
  assert.strictEqual(enabled.status, 'active');

  assert.throws(() => createStrategyRule({
    ruleCode: 'DYNAMIC-RULE',
    ruleName: '非法动态规则',
    ruleVersion: 'dynamic-rule:v1',
    formulaVersion: 'load-analysis:v1',
    metricCode: 'javascript_function',
    thresholdOperator: 'gte',
    thresholdValue: 1,
    thresholdUnit: '%',
    priority: 'low',
    evidenceRequirements: { minimumCoverageRate: 1, maxEvidenceItems: 10, savingBasis: null },
    recommendationText: '不应写入。',
    source: 'manual-config-test',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    sourceTimeZone: SOURCE_TIME_ZONE,
    status: 'active'
  }, createOptions(actorUserId)), (error) => (
    error.code === 'BAD_REQUEST'
    && error.details
    && error.details.code === 'UNSUPPORTED_STRATEGY_METRIC_CODE'
  ));
}

/**
 * 验证审计写入失败时配置业务数据整体回滚。
 * @param {number} actorUserId 操作者用户 ID。
 */
function testAtomicAuditFailureRollback(actorUserId) {
  const db = database.openDatabase();
  let beforeCount;
  let beforeAuditCount;
  try {
    beforeCount = db.prepare("SELECT COUNT(*) AS total FROM shift_definitions WHERE shift_code = 'SHIFT-ROLLBACK'").get().total;
    beforeAuditCount = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
  } finally {
    db.close();
  }

  assert.throws(() => createShiftDefinition({
    shiftCode: 'SHIFT-ROLLBACK',
    shiftName: '回滚测试班次',
    startMinute: 0,
    endMinute: 480,
    crossesMidnight: false,
    sourceTimeZone: SOURCE_TIME_ZONE,
    source: 'manual-config-test',
    version: 'shift-rollback:v1',
    effectiveStartUtc: EFFECTIVE_START_UTC,
    effectiveEndUtc: EFFECTIVE_END_UTC,
    status: 'active'
  }, createOptions(actorUserId, {
    auditWriter() {
      throw new Error('injected configuration audit failure');
    }
  })), /injected configuration audit failure/);

  const verifyDb = database.openDatabase();
  try {
    assert.strictEqual(
      verifyDb.prepare("SELECT COUNT(*) AS total FROM shift_definitions WHERE shift_code = 'SHIFT-ROLLBACK'").get().total,
      beforeCount,
      '审计失败时排班定义不得提交。'
    );
    assert.strictEqual(
      verifyDb.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total,
      beforeAuditCount,
      '故障审计不得产生操作日志。'
    );
  } finally {
    verifyDb.close();
  }
}

/**
 * 验证全部配置写操作均生成统一操作审计且没有物理删除。
 * @param {number} actorUserId 操作者用户 ID。
 */
function testOperationAuditCoverage(actorUserId) {
  const db = database.openDatabase();
  try {
    const auditRows = db.prepare(
      `SELECT operation, user_id AS userId, target_type AS targetType, ip
         FROM sys_operation_logs
        WHERE operation LIKE 'energy.%configuration%'
        ORDER BY id ASC`
    ).all();
    assert.strictEqual(auditRows.length, 12, '三类配置的创建、版本化和两次启停应生成十二条原子审计。');
    assert.strictEqual(auditRows.every((row) => Number(row.userId) === actorUserId), true);
    assert.strictEqual(auditRows.every((row) => row.ip === '127.0.0.1'), true);
    assert.strictEqual(auditRows.some((row) => row.targetType === 'shift_definition'), true);
    assert.strictEqual(auditRows.some((row) => row.targetType === 'tou_scheme'), true);
    assert.strictEqual(auditRows.some((row) => row.targetType === 'strategy_rule'), true);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM shift_definitions').get().total, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM tou_schemes').get().total, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules').get().total, 2);
  } finally {
    db.close();
  }
}

/**
 * 执行配置服务全部隔离测试。
 */
function run() {
  try {
    database.initDatabase();
    const db = database.openDatabase();
    let actorUserId;
    try {
      actorUserId = Number(db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM shift_definitions').get().total, 0);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM tou_schemes').get().total, 0);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM strategy_rules').get().total, 0);
    } finally {
      db.close();
    }
    testAuditActorRequired();
    testShiftConfigurationLifecycle(actorUserId);
    testTouConfigurationLifecycle(actorUserId);
    testStrategyRuleConfigurationLifecycle(actorUserId);
    testAtomicAuditFailureRollback(actorUserId);
    testOperationAuditCoverage(actorUserId);
    console.log('energy consumption configuration service tests passed');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_error) {
      // Windows 下异常句柄由系统临时目录后续清理。
    }
  }
}

run();
