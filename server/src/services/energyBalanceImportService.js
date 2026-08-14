'use strict';

const crypto = require('crypto');
const { openDatabase: defaultOpenDatabase, uploadsDir: defaultUploadsDir } = require('../db/database');
const { badRequest } = require('../utils/errors');
const backupService = require('./backupService');
const {
  bindDemoContextPreviewInTransaction,
  markDemoContextExecutedInTransaction
} = require('./demoContextService');
const { normalizeUnitAndValue } = require('./import/normalization');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssuesWithDatabase,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  authorizeEnergyAnalysisImportExecute,
  buildImportSummary,
  createImportIssue,
  getEnergyAnalysisImportTemplate,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  stableSerialize
} = require('./energyAnalysisImportCore');
const { isIanaTimeZone, isStrictUtcIso } = require('./energyAnalysisContracts');
const {
  createBalanceBoundary,
  createBalanceItem,
  setBalanceBoundaryStatus,
  setBalanceItemStatus
} = require('./energyBalanceService');
const {
  parseEnergyAnalysisTemplateWorkbook
} = require('./energyAnalysisTemplateService');
const {
  normalizeBatchId,
  securePreviewResult
} = require('./energyAnalysisSingleBatchImportService');

// 平衡双工作表导入模板与服务协议模块。
const ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE = 'energy-balance-configs';
const ENERGY_BALANCE_BUNDLE_SERVICE_VERSION = 'energy-balance-bundle-import:v1';
const ENERGY_BALANCE_CONFIRM_TEXT = '确认导入平衡边界及九角色项目';
// 平衡边界批次角色契约模块。
const ENERGY_BALANCE_BOUNDARY_BATCH_CONTRACT = Object.freeze({
  importType: 'energy_balance_boundary',
  operation: 'energy-balance-boundary-import',
  recordKind: 'energy_balance_boundary',
  batchRole: 'boundary',
  sheetName: '平衡边界'
});
// 九角色项目批次角色契约模块。
const ENERGY_BALANCE_ITEM_BATCH_CONTRACT = Object.freeze({
  importType: 'energy_balance_item',
  operation: 'energy-balance-item-import',
  recordKind: 'energy_balance_item',
  batchRole: 'item',
  sheetName: '九角色项目'
});
// 平衡配置冻结枚举模块。
const CONFIG_STATUSES = Object.freeze(['active', 'inactive']);
const BALANCE_ROLES = Object.freeze([
  'input', 'self_generation', 'inventory_decrease', 'adjustment_increase',
  'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease'
]);
const BALANCE_SOURCE_TYPES = Object.freeze([
  'timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'explicit_balance_value'
]);
const GENERATION_VALUE_FIELDS = Object.freeze(['self_use_value_kwh', 'grid_export_value_kwh']);
// 导入预演允许单个来源映射解析的最大记录数模块。
const MAX_SOURCE_RECORD_IDS = 500;
const LOCATOR_KEYS = Object.freeze({
  monthly_energy: Object.freeze(['organization', 'month']),
  generation: Object.freeze(['organization', 'month']),
  explicit_edge_value: Object.freeze(['model', 'version', 'edge', 'startUtc', 'endUtc'])
});

/** 判断单元格值是否为空白。 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** 将值规范为去除首尾空白的文本。 */
function normalizeText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/** 将可空文本规范为 null。 */
function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

/** 打开可注入数据库并标记连接所有权。 */
function openServiceDatabase(options = {}) {
  if (options.db) return { db: options.db, shouldClose: false };
  const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
  return { db: openDatabase(), shouldClose: true };
}

/** 使用当前连接执行 IMMEDIATE 写事务；已有外层事务时复用且不嵌套。 */
function runImmediateWriteTransaction(db, operation) {
  if (db.inTransaction) return operation();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 读取或创建安装级导入 HMAC 密钥。 */
function resolveImportSecret(db, options = {}) {
  const readAppMeta = typeof options.readAppMeta === 'function'
    ? options.readAppMeta
    : (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  const persistAppMeta = typeof options.persistAppMeta === 'function'
    ? options.persistAppMeta
    : (key, value) => {
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO NOTHING`
      ).run(key, value);
      return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
    };
  return resolveEnergyAnalysisImportHmacSecret({
    env: options.env || process.env,
    readAppMeta,
    persistAppMeta,
    randomBytes: options.randomBytes
  });
}

/** 构造稳定平衡导入问题。 */
function createBalanceIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({
    rowNumber: Number.isSafeInteger(Number(rowNumber)) && Number(rowNumber) > 0 ? Number(rowNumber) : 1,
    fieldName,
    rawValue,
    code,
    message,
    severity
  });
}

/** 向行追加去重问题。 */
function appendUniqueIssue(row, issue) {
  const identity = stableSerialize(issue);
  if (!(row.issues || []).some((item) => stableSerialize(item) === identity)) row.issues.push(issue);
}

/** 解析模板布尔值。 */
function parseBoolean(value, rowNumber, fieldName) {
  const normalized = normalizeText(value).toLowerCase();
  if (['1', 'true', 'yes', '是', '已确认'].includes(normalized)) return { value: true, issues: [] };
  if (['0', 'false', 'no', '否', '未确认'].includes(normalized)) return { value: false, issues: [] };
  return {
    value: null,
    issues: [createBalanceIssue(rowNumber, fieldName, value, 'ENERGY_BALANCE_IMPORT_BOOLEAN_INVALID', '发电边界确认必须填写 0/1 或等价布尔值。')]
  };
}

/** 解析 active/inactive 配置状态。 */
function parseStatus(value, rowNumber) {
  const normalized = normalizeText(value) || 'active';
  if (CONFIG_STATUSES.includes(normalized)) return { value: normalized, issues: [] };
  return {
    value: null,
    issues: [createBalanceIssue(rowNumber, 'status', value, 'ENERGY_BALANCE_IMPORT_STATUS_INVALID', '状态只允许 active 或 inactive。')]
  };
}

/** 解析非负有限数值。 */
function parseNonNegativeNumber(value, rowNumber, fieldName, required = false) {
  if (isBlank(value)) {
    return required
      ? { value: null, issues: [createBalanceIssue(rowNumber, fieldName, value, 'ENERGY_BALANCE_IMPORT_NUMBER_REQUIRED', '该来源类型必须填写显式平衡值。')] }
      : { value: null, issues: [] };
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return { value: null, issues: [createBalanceIssue(rowNumber, fieldName, value, 'ENERGY_BALANCE_IMPORT_NUMBER_INVALID', '数值必须是非负有限数。')] };
  }
  return { value: number, issues: [] };
}

/** 解析并严格校验 key=value;key=value 业务定位文本。 */
function parseBusinessLocator(value, sourceType, rowNumber) {
  const allowedKeys = LOCATOR_KEYS[sourceType] || [];
  if (!allowedKeys.length) {
    if (!isBlank(value)) {
      return {
        locator: null,
        issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', value, 'ENERGY_BALANCE_IMPORT_LOCATOR_UNEXPECTED', '该来源类型不得填写来源记录定位。')]
      };
    }
    return { locator: null, issues: [] };
  }
  const text = normalizeText(value);
  if (!text) {
    return {
      locator: null,
      issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', value, 'ENERGY_BALANCE_IMPORT_LOCATOR_REQUIRED', '该来源类型必须填写稳定业务定位。')]
    };
  }
  const locator = {};
  const issues = [];
  text.split(';').forEach((segment) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
      issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', segment, 'ENERGY_BALANCE_IMPORT_LOCATOR_SEGMENT_INVALID', '来源记录定位必须使用 key=value;key=value 格式。'));
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const locatorValue = trimmed.slice(separatorIndex + 1).trim();
    if (!allowedKeys.includes(key)) {
      issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', key, 'ENERGY_BALANCE_IMPORT_LOCATOR_KEY_UNKNOWN', `来源记录定位不支持键 ${key}。`));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(locator, key)) {
      issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', key, 'ENERGY_BALANCE_IMPORT_LOCATOR_KEY_DUPLICATE', `来源记录定位键 ${key} 重复。`));
      return;
    }
    if (/^[1-9]\d*$/.test(locatorValue) && ['id', 'recordId', 'boundaryId'].includes(key)) {
      issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locatorValue, 'ENERGY_BALANCE_IMPORT_DATABASE_ID_FORBIDDEN', '模板不得使用数据库自增 ID 定位业务来源。'));
      return;
    }
    locator[key] = locatorValue;
  });
  allowedKeys.forEach((key) => {
    if (!locator[key]) issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', key, 'ENERGY_BALANCE_IMPORT_LOCATOR_KEY_REQUIRED', `来源记录定位缺少 ${key}。`));
  });
  if (locator.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(locator.month)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locator.month, 'ENERGY_BALANCE_IMPORT_MONTH_INVALID', '月份必须使用 YYYY-MM。'));
  }
  if (locator.startUtc && !isStrictUtcIso(locator.startUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locator.startUtc, 'ENERGY_BALANCE_IMPORT_START_UTC_INVALID', '统计期开始必须是严格 UTC 秒精度。'));
  }
  if (locator.endUtc && !isStrictUtcIso(locator.endUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locator.endUtc, 'ENERGY_BALANCE_IMPORT_END_UTC_INVALID', '统计期结束必须是严格 UTC 秒精度。'));
  }
  if (locator.startUtc && locator.endUtc && Date.parse(locator.startUtc) >= Date.parse(locator.endUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', value, 'ENERGY_BALANCE_IMPORT_RANGE_INVALID', '统计期开始必须早于结束。'));
  }
  return { locator, issues };
}

/** 判断来源组织路径是否位于边界组织内。 */
function isSourceInBoundary(boundaryOrganization, sourcePath) {
  if (!boundaryOrganization) return true;
  return typeof sourcePath === 'string'
    && (sourcePath === boundaryOrganization.unitPath || sourcePath.startsWith(`${boundaryOrganization.unitPath}/`));
}

/** 判断显式边起止节点组织是否完整落在边界组织自身或后代范围。 */
function isExplicitEdgeInBoundary(boundaryOrganization, fromOrganizationPath, toOrganizationPath) {
  return Boolean(boundaryOrganization)
    && isSourceInBoundary(boundaryOrganization, fromOrganizationPath)
    && isSourceInBoundary(boundaryOrganization, toOrganizationPath);
}

/** 判断单个单位是否与能源类型可比。 */
function isUnitSupported(energyType, unit) {
  if (!energyType || !unit) return false;
  return Boolean(
    normalizeUnitAndValue(energyType.code, unit, 1)
    || unit === energyType.defaultUnit
    || unit === energyType.standardUnit
  );
}

/** 判断来源单位与项目单位是否可比。 */
function isUnitComparable(energyType, sourceUnit, itemUnit) {
  return isUnitSupported(energyType, sourceUnit)
    && isUnitSupported(energyType, itemUnit);
}

/** 载入平衡导入使用的稳定业务主数据。 */
function loadMasterData(db) {
  const organizationsByCode = new Map(db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units`
  ).all().map((row) => [String(row.unitCode), row]));
  const energyTypesByCode = new Map(db.prepare(
    `SELECT id, code, name, default_unit AS defaultUnit, standard_unit AS standardUnit, is_active AS active
     FROM energy_types`
  ).all().map((row) => [String(row.code), row]));
  const boundariesByIdentity = new Map(db.prepare(
    `SELECT id, boundary_code AS boundaryCode, boundary_name AS boundaryName,
            organization_unit_id AS organizationUnitId, source, document_no AS documentNo,
            version, effective_start_utc AS effectiveStartUtc, effective_end_utc AS effectiveEndUtc,
            source_timezone AS sourceTimeZone, generation_boundary_confirmed AS generationBoundaryConfirmed,
            status
     FROM energy_balance_boundaries`
  ).all().map((row) => [`${row.boundaryCode}\0${row.version}`, row]));
  return { organizationsByCode, energyTypesByCode, boundariesByIdentity };
}

/** 将模板解析问题映射为统一审计问题。 */
function mapTemplateIssues(issues, fallbackRowNumber = 1) {
  return (issues || []).map((issue) => createBalanceIssue(
    issue.sourceRowNumber || fallbackRowNumber,
    issue.key || issue.header || null,
    issue.header || null,
    issue.code || 'ENERGY_BALANCE_IMPORT_TEMPLATE_INVALID',
    issue.message || '模板结构无效。',
    issue.severity === 'warning' ? 'warning' : 'error'
  ));
}

/** 校验必填字段并返回统一问题。 */
function validateRequiredFields(mapped, requiredFields, rowNumber) {
  return requiredFields
    .filter((fieldName) => isBlank(mapped[fieldName]))
    .map((fieldName) => createBalanceIssue(rowNumber, fieldName, mapped[fieldName], 'ENERGY_BALANCE_IMPORT_REQUIRED_FIELD_MISSING', `必填字段 ${fieldName} 不能为空。`));
}

/** 比较边界事实是否完全一致。 */
function isExactBoundary(existing, record) {
  return existing.boundaryCode === record.input.boundaryCode
    && existing.boundaryName === record.input.boundaryName
    && Number(existing.organizationUnitId || 0) === Number(record.input.organizationUnitId || 0)
    && existing.source === record.input.source
    && (existing.documentNo || null) === (record.input.documentNo || null)
    && existing.version === record.input.version
    && existing.effectiveStartUtc === record.input.effectiveStartUtc
    && existing.effectiveEndUtc === record.input.effectiveEndUtc
    && existing.sourceTimeZone === record.input.sourceTimeZone
    && Boolean(existing.generationBoundaryConfirmed) === Boolean(record.input.generationBoundaryConfirmed)
    && existing.status === record.status;
}

/** 校验一条平衡边界模板行。 */
function validateBoundaryRow(resolvedRow, masterData) {
  const mapped = resolvedRow.record || {};
  const rowNumber = Number(mapped.sourceRowNumber || resolvedRow.sourceRowNumber || 1);
  const issues = [
    ...mapTemplateIssues(resolvedRow.issues, rowNumber),
    ...validateRequiredFields(mapped, [
      'boundaryCode', 'boundaryName', 'source', 'version', 'effectiveStartUtc',
      'effectiveEndUtc', 'sourceTimeZone', 'generationBoundaryConfirmed'
    ], rowNumber)
  ];
  const organizationCode = normalizeText(mapped.organizationUnitCode);
  const organization = organizationCode ? masterData.organizationsByCode.get(organizationCode) : null;
  if (organizationCode && !organization) {
    issues.push(createBalanceIssue(rowNumber, 'organizationUnitCode', organizationCode, 'ENERGY_BALANCE_IMPORT_ORGANIZATION_NOT_FOUND', '组织业务编码不存在。'));
  } else if (organization && organization.status !== 'active') {
    issues.push(createBalanceIssue(rowNumber, 'organizationUnitCode', organizationCode, 'ENERGY_BALANCE_IMPORT_ORGANIZATION_INACTIVE', '组织业务编码对应组织未启用。'));
  }
  const effectiveStartUtc = normalizeText(mapped.effectiveStartUtc);
  const effectiveEndUtc = normalizeText(mapped.effectiveEndUtc);
  if (effectiveStartUtc && !isStrictUtcIso(effectiveStartUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'effectiveStartUtc', effectiveStartUtc, 'ENERGY_BALANCE_IMPORT_EFFECTIVE_START_INVALID', '生效开始必须是严格 UTC 秒精度。'));
  }
  if (effectiveEndUtc && !isStrictUtcIso(effectiveEndUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'effectiveEndUtc', effectiveEndUtc, 'ENERGY_BALANCE_IMPORT_EFFECTIVE_END_INVALID', '生效结束必须是严格 UTC 秒精度。'));
  }
  if (isStrictUtcIso(effectiveStartUtc) && isStrictUtcIso(effectiveEndUtc)
    && Date.parse(effectiveStartUtc) >= Date.parse(effectiveEndUtc)) {
    issues.push(createBalanceIssue(rowNumber, 'effectiveStartUtc', effectiveStartUtc, 'ENERGY_BALANCE_IMPORT_EFFECTIVE_RANGE_INVALID', '生效开始必须早于生效结束。'));
  }
  const sourceTimeZone = normalizeText(mapped.sourceTimeZone);
  if (sourceTimeZone && !isIanaTimeZone(sourceTimeZone)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceTimeZone', sourceTimeZone, 'ENERGY_BALANCE_IMPORT_TIME_ZONE_INVALID', '来源时区必须是有效 IANA 时区。'));
  }
  const booleanResult = parseBoolean(mapped.generationBoundaryConfirmed, rowNumber, 'generationBoundaryConfirmed');
  const statusResult = parseStatus(mapped.status, rowNumber);
  issues.push(...booleanResult.issues, ...statusResult.issues);
  const record = issues.some((issue) => issue.severity === 'error') ? null : {
    sourceRowNumber: rowNumber,
    boundaryIdentity: `${normalizeText(mapped.boundaryCode)}\0${normalizeText(mapped.version)}`,
    status: statusResult.value,
    organization,
    input: {
      boundaryCode: normalizeText(mapped.boundaryCode),
      boundaryName: normalizeText(mapped.boundaryName),
      organizationUnitId: organization ? Number(organization.id) : null,
      source: normalizeText(mapped.source),
      documentNo: normalizeNullableText(mapped.documentNo),
      version: normalizeText(mapped.version),
      effectiveStartUtc,
      effectiveEndUtc,
      sourceTimeZone,
      generationBoundaryConfirmed: booleanResult.value
    }
  };
  return { rowNumber, mapped, record, issues, skipDuplicate: false, existingId: null };
}

/** 标记文件内及数据库边界重复业务键。 */
function markBoundaryDuplicates(rows, masterData) {
  const groups = new Map();
  rows.filter((row) => row.record).forEach((row) => {
    groups.set(row.record.boundaryIdentity, [...(groups.get(row.record.boundaryIdentity) || []), row]);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    const firstFact = stableSerialize({ input: group[0].record.input, status: group[0].record.status });
    const exact = group.every((row) => stableSerialize({ input: row.record.input, status: row.record.status }) === firstFact);
    if (exact) {
      group.slice(1).forEach((row) => {
        row.skipDuplicate = true;
        appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'boundaryCode', row.record.input.boundaryCode, 'DUPLICATE_ENERGY_BALANCE_BOUNDARY_SKIPPED', '文件内完全相同边界按 skip 策略跳过。', 'warning'));
      });
    } else {
      group.forEach((row) => appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'boundaryCode', row.record.input.boundaryCode, 'CONFLICTING_ENERGY_BALANCE_BOUNDARY', '文件内相同边界编码和版本存在冲突定义。')));
    }
  });
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existing = masterData.boundariesByIdentity.get(row.record.boundaryIdentity);
    if (!existing) return;
    if (isExactBoundary(existing, row.record)) {
      row.skipDuplicate = true;
      row.existingId = Number(existing.id);
      appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'boundaryCode', row.record.input.boundaryCode, 'DUPLICATE_ENERGY_BALANCE_BOUNDARY_SKIPPED', '数据库已存在完全相同边界，本行按 skip 策略跳过。', 'warning'));
    } else {
      appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'boundaryCode', row.record.input.boundaryCode, 'CONFLICTING_ENERGY_BALANCE_BOUNDARY', '数据库相同边界编码和版本已存在冲突定义。'));
    }
  });
}

/** 建立已有边界和本文件候选边界的统一引用索引。 */
function buildBoundaryReferenceIndex(rows, masterData) {
  const index = new Map();
  masterData.boundariesByIdentity.forEach((boundary, identity) => {
    index.set(identity, { kind: 'existing', boundaryId: Number(boundary.id), boundary });
  });
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const candidateRowId = `balance-boundary:${row.record.input.boundaryCode}:${row.record.input.version}`;
    row.candidateRowId = candidateRowId;
    index.set(row.record.boundaryIdentity, {
      kind: 'candidate',
      candidateRowId,
      boundary: { ...row.record.input, status: row.record.status, organization: row.record.organization }
    });
  });
  return index;
}

/** 使用稳定业务条件解析月度能耗来源。 */
function resolveMonthlyEnergySource(db, locator, boundaryOrganization, energyType, originalUnit, rowNumber) {
  const rows = db.prepare(
    `SELECT record.id, record.normalized_month AS normalizedMonth,
            record.original_month AS originalMonth, record.original_unit AS originalUnit,
            record.original_value AS originalValue, record.normalized_unit AS unit,
            record.normalized_value AS normalizedValue, record.duplicate_key AS duplicateKey,
            record.organization_unit_id AS organizationUnitId,
            organization.unit_code AS organizationCode, organization.unit_path AS organizationPath
     FROM energy_records AS record
     LEFT JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE record.record_status = 'active'
       AND record.energy_type_id = ?
       AND organization.unit_code = ?
       AND record.normalized_month = ?
     ORDER BY record.id ASC`
  ).all(energyType.id, locator.organization, locator.month);
  if (rows.length === 0) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_NOT_FOUND', '月度能耗业务条件未找到来源记录。')] };
  if (rows.length > 1) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_AMBIGUOUS', '月度能耗业务条件匹配多条 active 记录。')] };
  const source = rows[0];
  const issues = [];
  if (!isSourceInBoundary(boundaryOrganization, source.organizationPath)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_OUTSIDE_BOUNDARY', '月度能耗来源位于平衡边界组织范围之外。'));
  }
  if (!isUnitComparable(energyType, source.unit, originalUnit)) {
    issues.push(createBalanceIssue(rowNumber, 'originalUnit', originalUnit, 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH', '月度能耗来源单位与项目原始单位不兼容。'));
  }
  return {
    recordIds: issues.length ? [] : [Number(source.id)],
    sourceWitness: issues.length ? null : {
      recordId: Number(source.id),
      organizationCode: source.organizationCode,
      organizationPath: source.organizationPath,
      normalizedMonth: source.normalizedMonth,
      originalMonth: source.originalMonth,
      originalUnit: source.originalUnit,
      originalValue: Number(source.originalValue),
      normalizedUnit: source.unit,
      normalizedValue: Number(source.normalizedValue),
      duplicateKey: source.duplicateKey
    },
    issues
  };
}

/** 使用稳定业务条件解析发电来源。 */
function resolveGenerationSource(db, locator, boundaryOrganization, energyType, originalUnit, valueField, rowNumber) {
  const rows = db.prepare(
    `SELECT record.id, record.normalized_month AS normalizedMonth,
            record.generation_value_kwh AS generationValueKwh,
            record.self_use_value_kwh AS selfUseValueKwh,
            record.grid_export_value_kwh AS gridExportValueKwh,
            organization.unit_code AS organizationCode, organization.unit_path AS organizationPath
     FROM generation_records AS record
     JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE record.record_status = 'active'
       AND record.energy_type_id = ?
       AND organization.unit_code = ?
       AND record.normalized_month = ?
     ORDER BY record.id ASC`
  ).all(energyType.id, locator.organization, locator.month);
  if (rows.length === 0) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_NOT_FOUND', '发电业务条件未找到来源记录。')] };
  if (rows.length > 1) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_AMBIGUOUS', '发电业务条件匹配多条 active 记录。')] };
  const source = rows[0];
  const issues = [];
  if (!isSourceInBoundary(boundaryOrganization, source.organizationPath)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_OUTSIDE_BOUNDARY', '发电来源位于平衡边界组织范围之外。'));
  }
  if (!isUnitComparable(energyType, 'kWh', originalUnit)) {
    issues.push(createBalanceIssue(rowNumber, 'originalUnit', originalUnit, 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH', '发电来源固定 kWh 与项目原始单位不兼容。'));
  }
  if (!GENERATION_VALUE_FIELDS.includes(valueField)) {
    issues.push(createBalanceIssue(rowNumber, 'generationValueField', valueField, 'ENERGY_BALANCE_IMPORT_GENERATION_FIELD_INVALID', '发电数值字段不在允许白名单。'));
  }
  return {
    recordIds: issues.length ? [] : [Number(source.id)],
    sourceWitness: issues.length ? null : {
      recordId: Number(source.id),
      organizationCode: source.organizationCode,
      organizationPath: source.organizationPath,
      normalizedMonth: source.normalizedMonth,
      generationValueKwh: Number(source.generationValueKwh),
      selfUseValueKwh: Number(source.selfUseValueKwh),
      gridExportValueKwh: Number(source.gridExportValueKwh),
      selectedValueField: valueField,
      selectedValue: Number(source[
        valueField === 'self_use_value_kwh'
          ? 'selfUseValueKwh'
          : 'gridExportValueKwh'
      ])
    },
    issues
  };
}

/** 使用 sourceReference 解析时序来源集合。 */
function resolveTimeseriesSource(db, sourceReference, boundaryOrganization, energyType, originalUnit, rowNumber) {
  if (!sourceReference) {
    return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'timeseriesSourceReference', sourceReference, 'ENERGY_BALANCE_IMPORT_TIMESERIES_REFERENCE_REQUIRED', '时序来源必须填写稳定 sourceReference。')] };
  }
  const rows = db.prepare(
    `SELECT record.id, record.energy_type_id AS energyTypeId,
            record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.source_timezone AS sourceTimeZone,
            record.granularity_minutes AS granularityMinutes,
            record.original_unit AS originalUnit, record.original_value AS originalValue,
            record.normalized_unit AS unit, record.normalized_value AS normalizedValue,
            organization.unit_code AS organizationCode,
            organization.unit_path AS organizationPath
     FROM energy_timeseries_records AS record
     LEFT JOIN organization_units AS organization ON organization.id = record.organization_unit_id
     WHERE record.record_status = 'active' AND record.source_reference = ?
     ORDER BY record.start_utc ASC, record.end_utc ASC, record.id ASC
     LIMIT ?`
  ).all(sourceReference, MAX_SOURCE_RECORD_IDS + 1);
  if (rows.length === 0) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'timeseriesSourceReference', sourceReference, 'ENERGY_BALANCE_IMPORT_SOURCE_NOT_FOUND', '时序 sourceReference 未找到 active 来源记录。')] };
  if (rows.length > MAX_SOURCE_RECORD_IDS) {
    return {
      recordIds: [],
      issues: [createBalanceIssue(
        rowNumber,
        'timeseriesSourceReference',
        sourceReference,
        'ENERGY_BALANCE_IMPORT_SOURCE_RECORD_IDS_EXCEEDED',
        `时序 sourceReference 最多允许解析 ${MAX_SOURCE_RECORD_IDS} 条 active 来源记录。`
      )]
    };
  }
  const issues = [];
  rows.forEach((source, index) => {
    if (Number(source.energyTypeId) !== Number(energyType.id)) {
      issues.push(createBalanceIssue(rowNumber, 'energyTypeCode', energyType.code, 'ENERGY_BALANCE_IMPORT_SOURCE_ENERGY_TYPE_MISMATCH', '时序来源能源类型与项目不一致。'));
    }
    if (!isSourceInBoundary(boundaryOrganization, source.organizationPath)) {
      issues.push(createBalanceIssue(rowNumber, 'timeseriesSourceReference', sourceReference, 'ENERGY_BALANCE_IMPORT_SOURCE_OUTSIDE_BOUNDARY', '时序来源位于平衡边界组织范围之外。'));
    }
    if (!isUnitComparable(energyType, source.unit, originalUnit)) {
      issues.push(createBalanceIssue(rowNumber, 'originalUnit', originalUnit, 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH', '时序来源单位与项目原始单位不兼容。'));
    }
    const previous = index > 0 ? rows[index - 1] : null;
    if (previous && Date.parse(previous.endUtc) > Date.parse(source.startUtc)) {
      issues.push(createBalanceIssue(rowNumber, 'timeseriesSourceReference', sourceReference, 'ENERGY_BALANCE_IMPORT_TIMESERIES_OVERLAP', '同一时序 sourceReference 存在重叠 active 时间分片，无法稳定解析。'));
    }
  });
  return {
    recordIds: issues.length ? [] : rows.map((row) => Number(row.id)),
    sourceWitness: issues.length ? null : rows.map((source) => ({
      recordId: Number(source.id),
      energyTypeId: Number(source.energyTypeId),
      organizationCode: source.organizationCode || null,
      organizationPath: source.organizationPath || null,
      startUtc: source.startUtc,
      endUtc: source.endUtc,
      sourceTimeZone: source.sourceTimeZone,
      granularityMinutes: Number(source.granularityMinutes),
      originalUnit: source.originalUnit,
      originalValue: Number(source.originalValue),
      normalizedUnit: source.unit,
      normalizedValue: Number(source.normalizedValue)
    })),
    issues
  };
}

/** 使用模型、边和统计期解析显式能流边值。 */
function resolveExplicitEdgeSource(db, locator, boundaryOrganization, energyType, originalUnit, rowNumber) {
  const rows = db.prepare(
    `SELECT record.id, record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.source_timezone AS sourceTimeZone,
            record.original_unit AS unit, record.original_value AS originalValue,
            record.formula_version AS formulaVersion,
            edge.energy_type_id AS energyTypeId,
            from_organization.unit_path AS fromOrganizationPath,
            to_organization.unit_path AS toOrganizationPath
     FROM energy_flow_records AS record
     JOIN energy_flow_models AS model ON model.id = record.energy_flow_model_id
     JOIN energy_flow_edges AS edge ON edge.id = record.energy_flow_edge_id
     JOIN energy_flow_nodes AS from_node ON from_node.id = edge.from_node_id
       AND from_node.energy_flow_model_id = edge.energy_flow_model_id
     JOIN energy_flow_nodes AS to_node ON to_node.id = edge.to_node_id
       AND to_node.energy_flow_model_id = edge.energy_flow_model_id
     LEFT JOIN organization_units AS from_organization ON from_organization.id = from_node.organization_unit_id
     LEFT JOIN organization_units AS to_organization ON to_organization.id = to_node.organization_unit_id
     WHERE model.model_code = ? AND model.version = ? AND model.status = 'active'
       AND edge.edge_code = ? AND edge.status = 'active'
       AND edge.source_type = 'explicit_edge_value'
       AND record.source_type = 'explicit_edge_value'
       AND record.record_status = 'active'
       AND record.start_utc = ? AND record.end_utc = ?
     ORDER BY record.id ASC`
  ).all(locator.model, locator.version, locator.edge, locator.startUtc, locator.endUtc);
  if (rows.length === 0) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_NOT_FOUND', '能流模型、边和统计期未找到显式边值。')] };
  if (rows.length > 1) return { recordIds: [], issues: [createBalanceIssue(rowNumber, 'sourceRecordLocator', locator, 'ENERGY_BALANCE_IMPORT_SOURCE_AMBIGUOUS', '能流模型、边和统计期匹配多条显式边值。')] };
  const source = rows[0];
  const issues = [];
  if (Number(source.energyTypeId) !== Number(energyType.id)) {
    issues.push(createBalanceIssue(rowNumber, 'energyTypeCode', energyType.code, 'ENERGY_BALANCE_IMPORT_SOURCE_ENERGY_TYPE_MISMATCH', '显式边值能源类型与项目不一致。'));
  }
  if (!isExplicitEdgeInBoundary(
    boundaryOrganization,
    source.fromOrganizationPath,
    source.toOrganizationPath
  )) {
    issues.push(createBalanceIssue(
      rowNumber,
      'sourceRecordLocator',
      locator,
      'ENERGY_BALANCE_IMPORT_EDGE_OUTSIDE_BOUNDARY',
      '显式能流边起点和终点组织必须属于平衡边界组织自身或其后代。'
    ));
  }
  if (!isUnitComparable(energyType, source.unit, originalUnit)) {
    issues.push(createBalanceIssue(rowNumber, 'originalUnit', originalUnit, 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH', '显式边值单位与项目原始单位不兼容。'));
  }
  return {
    recordIds: issues.length ? [] : [Number(source.id)],
    sourceWitness: issues.length ? null : {
      recordId: Number(source.id),
      energyTypeId: Number(source.energyTypeId),
      startUtc: source.startUtc,
      endUtc: source.endUtc,
      sourceTimeZone: source.sourceTimeZone,
      originalUnit: source.unit,
      originalValue: Number(source.originalValue),
      formulaVersion: source.formulaVersion,
      fromOrganizationPath: source.fromOrganizationPath || null,
      toOrganizationPath: source.toOrganizationPath || null
    },
    issues
  };
}

/** 校验一条九角色项目并解析业务来源。 */
function validateItemRow(resolvedRow, db, masterData, boundaryReferences) {
  const mapped = resolvedRow.record || {};
  const rowNumber = Number(mapped.sourceRowNumber || resolvedRow.sourceRowNumber || 1);
  const issues = [
    ...mapTemplateIssues(resolvedRow.issues, rowNumber),
    ...validateRequiredFields(mapped, [
      'boundaryCode', 'boundaryVersion', 'itemCode', 'itemName', 'role',
      'energyTypeCode', 'originalUnit', 'sourceType', 'sourceReference'
    ], rowNumber)
  ];
  const boundaryIdentity = `${normalizeText(mapped.boundaryCode)}\0${normalizeText(mapped.boundaryVersion)}`;
  const boundaryReference = boundaryReferences.get(boundaryIdentity) || null;
  if (!boundaryReference) {
    issues.push(createBalanceIssue(rowNumber, 'boundaryCode', mapped.boundaryCode, 'ENERGY_BALANCE_IMPORT_BOUNDARY_NOT_FOUND', '项目引用的边界业务编码和版本不存在。'));
  }
  const role = normalizeText(mapped.role);
  if (role && !BALANCE_ROLES.includes(role)) {
    issues.push(createBalanceIssue(rowNumber, 'role', role, 'ENERGY_BALANCE_IMPORT_ROLE_INVALID', '角色不在九角色白名单。'));
  }
  const sourceType = normalizeText(mapped.sourceType);
  if (sourceType && !BALANCE_SOURCE_TYPES.includes(sourceType)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceType', sourceType, 'ENERGY_BALANCE_IMPORT_SOURCE_TYPE_INVALID', '来源类型不在平衡来源白名单。'));
  }
  const energyTypeCode = normalizeText(mapped.energyTypeCode);
  const energyType = masterData.energyTypesByCode.get(energyTypeCode) || null;
  if (!energyType) {
    issues.push(createBalanceIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'ENERGY_BALANCE_IMPORT_ENERGY_TYPE_NOT_FOUND', '能源类型业务编码不存在。'));
  } else if (!energyType.active) {
    issues.push(createBalanceIssue(rowNumber, 'energyTypeCode', energyTypeCode, 'ENERGY_BALANCE_IMPORT_ENERGY_TYPE_INACTIVE', '能源类型未启用。'));
  }
  const originalUnit = normalizeText(mapped.originalUnit);
  if (energyType && originalUnit && !isUnitSupported(energyType, originalUnit)) {
    issues.push(createBalanceIssue(rowNumber, 'originalUnit', originalUnit, 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH', '项目原始单位与能源类型不兼容。'));
  }
  const locatorResult = parseBusinessLocator(mapped.sourceRecordLocator, sourceType, rowNumber);
  issues.push(...locatorResult.issues);
  const explicitValueResult = parseNonNegativeNumber(mapped.explicitBalanceValue, rowNumber, 'explicitBalanceValue', sourceType === 'explicit_balance_value');
  issues.push(...explicitValueResult.issues);
  const statusResult = parseStatus(mapped.status, rowNumber);
  issues.push(...statusResult.issues);
  const sourceReference = normalizeText(mapped.sourceReference);
  if (!sourceReference) {
    issues.push(createBalanceIssue(rowNumber, 'sourceReference', mapped.sourceReference, 'ENERGY_BALANCE_IMPORT_SOURCE_REFERENCE_REQUIRED', '来源引用必须是非空稳定业务说明。'));
  } else if (/^[1-9]\d*$/.test(sourceReference)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceReference', sourceReference, 'ENERGY_BALANCE_IMPORT_DATABASE_ID_FORBIDDEN', '来源引用不得仅填写数据库自增 ID。'));
  }
  const timeseriesSourceReference = normalizeText(mapped.timeseriesSourceReference);
  const generationValueField = normalizeText(mapped.generationValueField);
  const generationKey = normalizeText(mapped.generationAntiDoubleCountKey);
  if (sourceType === 'timeseries' && !isBlank(mapped.sourceRecordLocator)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', mapped.sourceRecordLocator, 'ENERGY_BALANCE_IMPORT_LOCATOR_UNEXPECTED', 'timeseries 使用时序来源标识定位，不得同时填写来源记录定位。'));
  }
  if (sourceType !== 'timeseries' && timeseriesSourceReference) {
    issues.push(createBalanceIssue(rowNumber, 'timeseriesSourceReference', timeseriesSourceReference, 'ENERGY_BALANCE_IMPORT_TIMESERIES_REFERENCE_UNEXPECTED', '非 timeseries 来源不得填写时序来源标识。'));
  }
  if (sourceType === 'explicit_balance_value' && !isBlank(mapped.sourceRecordLocator)) {
    issues.push(createBalanceIssue(rowNumber, 'sourceRecordLocator', mapped.sourceRecordLocator, 'ENERGY_BALANCE_IMPORT_LOCATOR_UNEXPECTED', '显式平衡值不得填写来源记录定位。'));
  }
  if (sourceType !== 'explicit_balance_value' && !isBlank(mapped.explicitBalanceValue)) {
    issues.push(createBalanceIssue(rowNumber, 'explicitBalanceValue', mapped.explicitBalanceValue, 'ENERGY_BALANCE_IMPORT_EXPLICIT_VALUE_UNEXPECTED', '非显式平衡值来源不得填写显式平衡值。'));
  }
  if (sourceType === 'generation') {
    const expectedField = role === 'self_generation' ? 'self_use_value_kwh' : role === 'output' ? 'grid_export_value_kwh' : null;
    if (!expectedField || generationValueField !== expectedField) {
      issues.push(createBalanceIssue(rowNumber, 'generationValueField', generationValueField, 'ENERGY_BALANCE_IMPORT_GENERATION_ROLE_FIELD_MISMATCH', 'generation 只允许 self_generation/self_use_value_kwh 或 output/grid_export_value_kwh。'));
    }
    if (!generationKey) {
      issues.push(createBalanceIssue(rowNumber, 'generationAntiDoubleCountKey', generationKey, 'GENERATION_ANTI_DOUBLE_COUNT_KEY_REQUIRED', 'generation 来源必须填写发电防重复键。'));
    }
  } else if (generationValueField || generationKey) {
    issues.push(createBalanceIssue(rowNumber, 'generationAntiDoubleCountKey', generationKey || generationValueField, 'ENERGY_BALANCE_IMPORT_GENERATION_FIELDS_UNEXPECTED', '非 generation 来源不得填写发电字段或防重复键。'));
  }
  let sourceResolution = { recordIds: [], sourceWitness: null, issues: [] };
  const boundary = boundaryReference?.boundary || null;
  const boundaryOrganization = boundary?.organization || (
    boundary?.organizationUnitId
      ? [...masterData.organizationsByCode.values()].find((item) => Number(item.id) === Number(boundary.organizationUnitId)) || null
      : null
  );
  if (!issues.some((issue) => issue.severity === 'error') && energyType) {
    if (sourceType === 'monthly_energy') sourceResolution = resolveMonthlyEnergySource(db, locatorResult.locator, boundaryOrganization, energyType, originalUnit, rowNumber);
    else if (sourceType === 'generation') sourceResolution = resolveGenerationSource(db, locatorResult.locator, boundaryOrganization, energyType, originalUnit, generationValueField, rowNumber);
    else if (sourceType === 'timeseries') sourceResolution = resolveTimeseriesSource(db, timeseriesSourceReference, boundaryOrganization, energyType, originalUnit, rowNumber);
    else if (sourceType === 'explicit_edge_value') sourceResolution = resolveExplicitEdgeSource(db, locatorResult.locator, boundaryOrganization, energyType, originalUnit, rowNumber);
  }
  issues.push(...sourceResolution.issues);
  let sourceMapping = null;
  if (sourceType === 'explicit_balance_value') sourceMapping = { reference: sourceReference, value: explicitValueResult.value };
  else if (sourceType === 'timeseries') sourceMapping = { reference: sourceReference, recordIds: sourceResolution.recordIds, sourceReference: timeseriesSourceReference };
  else sourceMapping = { reference: sourceReference, recordIds: sourceResolution.recordIds };
  if (sourceType === 'generation') sourceMapping.valueField = generationValueField;
  const sourceWitness = sourceResolution.sourceWitness;
  const record = issues.some((issue) => issue.severity === 'error') ? null : {
    sourceRowNumber: rowNumber,
    boundaryIdentity,
    boundaryReferenceKind: boundaryReference.kind,
    existingBoundaryId: boundaryReference.boundaryId || null,
    boundaryCandidateRowId: boundaryReference.candidateRowId || null,
    itemIdentity: `${boundaryIdentity}\0${normalizeText(mapped.itemCode)}`,
    sourceWitness,
    status: statusResult.value,
    input: {
      itemCode: normalizeText(mapped.itemCode),
      itemName: normalizeText(mapped.itemName),
      role,
      energyTypeId: Number(energyType.id),
      originalUnit,
      sourceType,
      sourceMapping,
      generationAntiDoubleCountKey: generationKey || null
    }
  };
  return { rowNumber, mapped, record, issues, skipDuplicate: false, existingId: null };
}

/** 比较已有项目与候选是否完全一致。 */
function isExactItem(existing, record) {
  return existing.itemCode === record.input.itemCode
    && existing.itemName === record.input.itemName
    && existing.role === record.input.role
    && Number(existing.energyTypeId) === Number(record.input.energyTypeId)
    && existing.originalUnit === record.input.originalUnit
    && existing.sourceType === record.input.sourceType
    && stableSerialize(JSON.parse(existing.sourceMappingJson)) === stableSerialize(record.input.sourceMapping)
    && (existing.generationAntiDoubleCountKey || null) === (record.input.generationAntiDoubleCountKey || null)
    && existing.status === record.status;
}

/** 标记项目文件内重复、数据库重复与发电防重复键冲突。 */
function markItemDuplicates(db, rows) {
  const groups = new Map();
  rows.filter((row) => row.record).forEach((row) => groups.set(row.record.itemIdentity, [...(groups.get(row.record.itemIdentity) || []), row]));
  groups.forEach((group) => {
    if (group.length < 2) return;
    const firstFact = stableSerialize({ input: group[0].record.input, status: group[0].record.status });
    const exact = group.every((row) => stableSerialize({ input: row.record.input, status: row.record.status }) === firstFact);
    if (exact) {
      group.slice(1).forEach((row) => {
        row.skipDuplicate = true;
        appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'itemCode', row.record.input.itemCode, 'DUPLICATE_ENERGY_BALANCE_ITEM_SKIPPED', '文件内完全相同项目按 skip 策略跳过。', 'warning'));
      });
    } else {
      group.forEach((row) => appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'itemCode', row.record.input.itemCode, 'CONFLICTING_ENERGY_BALANCE_ITEM', '文件内同边界项目编码存在冲突定义。')));
    }
  });
  const generationGroups = new Map();
  rows.filter((row) => row.record?.input.generationAntiDoubleCountKey && !row.skipDuplicate).forEach((row) => {
    const key = `${row.record.boundaryIdentity}\0${row.record.input.generationAntiDoubleCountKey}`;
    generationGroups.set(key, [...(generationGroups.get(key) || []), row]);
  });
  generationGroups.forEach((group) => {
    if (group.length > 1) group.forEach((row) => appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'generationAntiDoubleCountKey', row.record.input.generationAntiDoubleCountKey, 'ENERGY_BALANCE_GENERATION_KEY_CONFLICT', '文件内同边界发电防重复键冲突。')));
  });
  const selectItem = db.prepare(
    `SELECT id, item_code AS itemCode, item_name AS itemName, role,
            energy_type_id AS energyTypeId, original_unit AS originalUnit,
            source_type AS sourceType, source_mapping_json AS sourceMappingJson,
            generation_anti_double_count_key AS generationAntiDoubleCountKey, status
     FROM energy_balance_items
     WHERE energy_balance_boundary_id = ? AND item_code = ?`
  );
  const selectGenerationKey = db.prepare(
    `SELECT id FROM energy_balance_items
     WHERE energy_balance_boundary_id = ? AND generation_anti_double_count_key = ? LIMIT 1`
  );
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    if (row.record.boundaryReferenceKind !== 'existing') return;
    const existing = selectItem.get(row.record.existingBoundaryId, row.record.input.itemCode);
    if (existing) {
      if (isExactItem(existing, row.record)) {
        row.skipDuplicate = true;
        row.existingId = Number(existing.id);
        appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'itemCode', row.record.input.itemCode, 'DUPLICATE_ENERGY_BALANCE_ITEM_SKIPPED', '数据库已存在完全相同项目，本行按 skip 策略跳过。', 'warning'));
      } else {
        appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'itemCode', row.record.input.itemCode, 'CONFLICTING_ENERGY_BALANCE_ITEM', '数据库同边界项目编码已存在冲突定义。'));
      }
      return;
    }
    if (row.record.input.generationAntiDoubleCountKey) {
      const conflict = selectGenerationKey.get(row.record.existingBoundaryId, row.record.input.generationAntiDoubleCountKey);
      if (conflict) appendUniqueIssue(row, createBalanceIssue(row.rowNumber, 'generationAntiDoubleCountKey', row.record.input.generationAntiDoubleCountKey, 'ENERGY_BALANCE_GENERATION_KEY_CONFLICT', '数据库同边界已存在相同发电防重复键。'));
    }
  });
}

/** 将领域行构造为 preview 分片。 */
function buildPreviewSlice(rows, candidateBuilder) {
  const items = rows.map((row) => {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    return {
      rowNumber: row.rowNumber,
      sourceRowNumber: row.rowNumber,
      status: hasError ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport'),
      issues: row.issues,
      normalizedRecord: row.record
    };
  });
  const candidateRows = rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({ candidateRowId: row.candidateRowId || candidateBuilder(row.record), ...row.record }));
  return {
    items,
    candidateRows,
    summary: buildImportSummary(items),
    auditIssues: items.flatMap((item) => item.issues || [])
  };
}

/** 解析精确双工作表 XLSX。 */
function parseEnergyBalanceBundleRows(buffer, originalFilename = '') {
  if (String(originalFilename).split('.').pop().toLowerCase() !== 'xlsx') {
    throw badRequest('平衡边界与九角色项目导入必须使用 .xlsx 文件。', { code: 'ENERGY_BALANCE_BUNDLE_XLSX_REQUIRED' });
  }
  const workbookResult = parseEnergyAnalysisTemplateWorkbook(ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE, buffer);
  const boundarySheet = workbookResult.sheetsByName['平衡边界'] || null;
  const itemSheet = workbookResult.sheetsByName['九角色项目'] || null;
  return { workbookResult, boundarySheet, itemSheet };
}

/** 构建平衡双工作表领域 preview。 */
function buildEnergyBalanceBundleImportPreview(input) {
  const parsed = parseEnergyBalanceBundleRows(input.buffer, input.originalFilename);
  const masterData = loadMasterData(input.db);
  const collectionIssues = mapTemplateIssues(parsed.workbookResult.sheetCollection?.issues || [], 1);
  const boundaryResolvedRows = parsed.boundarySheet?.resolvedRows || [];
  const itemResolvedRows = parsed.itemSheet?.resolvedRows || [];
  const boundaryRows = boundaryResolvedRows.map((row) => validateBoundaryRow(row, masterData));
  if (collectionIssues.length) {
    if (boundaryRows.length) boundaryRows[0].issues.push(...collectionIssues);
    else boundaryRows.push({ rowNumber: 1, record: null, issues: collectionIssues, skipDuplicate: false });
  }
  markBoundaryDuplicates(boundaryRows, masterData);
  const boundaryReferences = buildBoundaryReferenceIndex(boundaryRows, masterData);
  const itemRows = itemResolvedRows.map((row) => validateItemRow(row, input.db, masterData, boundaryReferences));
  markItemDuplicates(input.db, itemRows);
  const boundaryPreview = buildPreviewSlice(boundaryRows, (record) => `balance-boundary:${record.input.boundaryCode}:${record.input.version}`);
  const itemPreview = buildPreviewSlice(itemRows, (record) => `balance-item:${record.boundaryIdentity.replace('\0', ':')}:${record.input.itemCode}`);
  return {
    fileType: 'xlsx',
    boundaryPreview: { ...boundaryPreview, fieldMapping: parsed.boundarySheet?.headerValidation?.fieldMapping || {} },
    itemPreview: { ...itemPreview, fieldMapping: parsed.itemSheet?.headerValidation?.fieldMapping || {} },
    candidateRows: [...boundaryPreview.candidateRows, ...itemPreview.candidateRows],
    items: [...boundaryPreview.items, ...itemPreview.items],
    summary: buildImportSummary([...boundaryPreview.items, ...itemPreview.items]),
    auditIssues: [...boundaryPreview.auditIssues, ...itemPreview.auditIssues],
    fieldMapping: {
      平衡边界: parsed.boundarySheet?.headerValidation?.fieldMapping || {},
      九角色项目: parsed.itemSheet?.headerValidation?.fieldMapping || {}
    },
    notices: [
      'preview 只解析并审计“平衡边界”和“九角色项目”，不会写入业务事实。',
      '模板通过组织、能源、月份、时序 sourceReference、能流模型/边/统计期等稳定业务条件解析来源，不接受数据库 ID。',
      '导入不会自动执行平衡计算、生成优化建议，也不会修改能耗、发电、预算或碳排记录。'
    ]
  };
}

/** 根据 preview 汇总计算审计批次状态。 */
function resolvePreviewStatus(summary = {}) {
  if (Number(summary.totalRows || 0) === 0 && Number(summary.errors || 0) > 0) return 'failed';
  return Number(summary.blocked || 0) > 0 || Number(summary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed';
}

/** 构造 preview 中文错误摘要。 */
function buildPreviewErrorSummary(summary = {}) {
  const parts = [];
  if (Number(summary.blocked || 0) > 0) parts.push(`${summary.blocked} 行阻断`);
  if (Number(summary.skipped || 0) > 0) parts.push(`${summary.skipped} 行跳过`);
  if (Number(summary.warnings || 0) > 0) parts.push(`${summary.warnings} 条警告`);
  if (Number(summary.errors || 0) > 0) parts.push(`${summary.errors} 条错误`);
  return parts.length ? `平衡配置导入存在 ${parts.join('、')}。` : null;
}

/** 生成共享上传组 ID。 */
function createUploadGroupId(options = {}) {
  if (typeof options.createUploadGroupId === 'function') return normalizeText(options.createUploadGroupId());
  return typeof crypto.randomUUID === 'function'
    ? `energy-balance:${crypto.randomUUID()}`
    : `energy-balance:${crypto.randomBytes(16).toString('hex')}`;
}

/** 投影不含绝对路径的备份摘要。 */
function projectSafeBackupSummary(backup) {
  if (!backup || typeof backup !== 'object') return null;
  return {
    backupName: backup.backupName || null,
    reason: backup.reason || null,
    sizeBytes: Number.isFinite(Number(backup.sizeBytes)) ? Number(backup.sizeBytes) : null,
    sha256: backup.sha256 || null,
    method: backup.method || null,
    createdAt: backup.createdAt || null,
    updatedAt: backup.updatedAt || null
  };
}

/** 构造单个角色批次的持久化审计上下文。 */
function buildBundleAuditContext(contract, context, preview) {
  return {
    version: ENERGY_BALANCE_BUNDLE_SERVICE_VERSION,
    templateType: context.template.templateType,
    templateId: context.template.id,
    operation: contract.operation,
    recordKind: contract.recordKind,
    bundleOperation: context.template.operation,
    bundleRecordKind: context.template.recordKind,
    importTypes: [...context.template.importTypes],
    importType: contract.importType,
    batchRole: contract.batchRole,
    sheetName: contract.sheetName,
    uploadGroupId: context.uploadGroupId,
    confirmText: context.template.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: true,
    summary: preview.summary,
    candidateRowIds: preview.candidateRows.map((row) => row.candidateRowId),
    candidateRows: preview.candidateRows,
    combinedCandidateRowIds: context.securedPreview.candidateRowIds,
    combinedCandidateRows: context.securedPreview.candidateRows,
    previewAudit: context.securedPreview.previewAudit,
    notices: context.domainPreview.notices
  };
}

/** 创建配对的边界和项目 preview 审计批次。 */
function previewEnergyBalanceBundleImport(file, options = {}) {
  if (!file || !file.originalname || !file.filename) {
    throw badRequest('请上传已落盘且包含 originalname/filename 的 XLSX 文件。', { code: 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED' });
  }
  if (String(file.originalname).split('.').pop().toLowerCase() !== 'xlsx') {
    throw badRequest('平衡配置导入必须使用 XLSX 文件。', { code: 'ENERGY_BALANCE_BUNDLE_XLSX_REQUIRED' });
  }
  const template = getEnergyAnalysisImportTemplate(ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE);
  const safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined,
    maxSizeBytes: options.maxFileSizeBytes
  });
  const databaseContext = openServiceDatabase(options);
  try {
    const secret = resolveImportSecret(databaseContext.db, options);
    const domainPreview = buildEnergyBalanceBundleImportPreview({
      db: databaseContext.db,
      buffer: safeFile.buffer,
      originalFilename: file.originalname
    });
    const securedPreview = securePreviewResult(domainPreview, { template, fileSha256: safeFile.fileSha256, secret });
    const uploadGroupId = createUploadGroupId(options);
    const context = { template, uploadGroupId, securedPreview, domainPreview };
    const persist = runImmediateWriteTransaction(databaseContext.db, () => {
      const createRoleBatch = (contract, rolePreview) => {
        const summary = rolePreview.summary;
        const batch = createPreviewAuditBatch({
          importType: contract.importType,
          originalFilename: file.originalname,
          storedFilename: file.filename,
          fileType: 'xlsx',
          fileSizeBytes: safeFile.sizeBytes,
          fileSha256: safeFile.fileSha256,
          status: resolvePreviewStatus(summary),
          auditPhase: 'preview',
          duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
          fieldMapping: rolePreview.fieldMapping || {},
          previewSignature: securedPreview.previewSignature,
          previewAuditDigest: securedPreview.previewAuditDigest,
          auditContext: buildBundleAuditContext(contract, context, rolePreview),
          statistics: {
            totalRows: Number(summary.totalRows || 0),
            successCount: Number(summary.wouldImport || 0),
            failureCount: Number(summary.blocked || 0),
            skippedCount: Number(summary.skipped || 0)
          },
          errorSummary: buildPreviewErrorSummary(summary)
        }, { db: databaseContext.db });
        replaceImportAuditIssuesWithDatabase(databaseContext.db, batch.id, rolePreview.auditIssues || []);
        return getImportAuditSummary(batch.id, { db: databaseContext.db });
      };
      const boundaryBatch = createRoleBatch(ENERGY_BALANCE_BOUNDARY_BATCH_CONTRACT, domainPreview.boundaryPreview);
      const itemBatch = createRoleBatch(ENERGY_BALANCE_ITEM_BATCH_CONTRACT, domainPreview.itemPreview);
      if (options.demoContext) {
        bindDemoContextPreviewInTransaction({
          db: databaseContext.db,
          ...options.demoContext,
          uploadFileSha256: safeFile.fileSha256,
          previewDigest: securedPreview.previewAuditDigest,
          batchBindings: [
            { batchId: boundaryBatch.id, batchRole: 'boundary' },
            { batchId: itemBatch.id, batchRole: 'item' }
          ]
        });
      }
      return { boundaryBatch, itemBatch };
    });
    return {
      ...securedPreview,
      boundaryPreview: domainPreview.boundaryPreview,
      itemPreview: domainPreview.itemPreview,
      uploadGroupId,
      boundaryBatchId: persist.boundaryBatch.id,
      itemBatchId: persist.itemBatch.id,
      boundaryBatch: persist.boundaryBatch,
      itemBatch: persist.itemBatch,
      persistsImportBatch: true,
      persistsImportBatches: true
    };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/** 将持久化批次投影为配对校验绑定。 */
function buildBatchBinding(batch) {
  const context = batch?.auditContext && typeof batch.auditContext === 'object' ? batch.auditContext : {};
  return {
    id: Number(batch?.id),
    status: batch?.status,
    auditPhase: batch?.auditPhase,
    importType: batch?.importType,
    templateType: context.templateType,
    templateId: context.templateId,
    operation: context.operation,
    recordKind: context.recordKind,
    bundleOperation: context.bundleOperation,
    bundleRecordKind: context.bundleRecordKind,
    importTypes: context.importTypes,
    batchRole: context.batchRole,
    uploadGroupId: context.uploadGroupId,
    storedFilename: batch?.storedFilename,
    originalFilename: batch?.originalFilename,
    fileSizeBytes: batch?.fileSizeBytes,
    fileSha256: batch?.fileSha256,
    previewSignature: batch?.previewSignature,
    previewAuditDigest: batch?.previewAuditDigest
  };
}

/** 完整验证两个持久化平衡批次为同一可信 preview 配对。 */
function createTrustedPairContext(boundaryBatch, itemBatch, template) {
  const boundary = buildBatchBinding(boundaryBatch);
  const item = buildBatchBinding(itemBatch);
  const failures = [];
  const append = (condition, code, message) => { if (!condition) failures.push({ code, message }); };
  append(boundary.id !== item.id, 'ENERGY_BALANCE_BUNDLE_BATCH_IDS_MUST_DIFFER', '两个批次 ID 必须不同。');
  append(['completed', 'completed_with_errors'].includes(boundary.status) && ['completed', 'completed_with_errors'].includes(item.status), 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID', '两个批次状态均必须允许 execute。');
  append(boundary.auditPhase === 'preview' && item.auditPhase === 'preview', 'ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH', '两个批次必须仍处于 preview。');
  append(boundary.importType === ENERGY_BALANCE_BOUNDARY_BATCH_CONTRACT.importType && item.importType === ENERGY_BALANCE_ITEM_BATCH_CONTRACT.importType, 'ENERGY_BALANCE_BUNDLE_IMPORT_TYPE_MISMATCH', '两个批次角色类型不匹配。');
  append(boundary.batchRole === 'boundary' && item.batchRole === 'item', 'ENERGY_BALANCE_BUNDLE_ROLE_MISMATCH', '两个批次角色不匹配。');
  append(boundary.templateType === template.templateType && item.templateType === template.templateType, 'ENERGY_BALANCE_BUNDLE_TEMPLATE_MISMATCH', '两个批次模板不匹配。');
  append(boundary.bundleOperation === template.operation && item.bundleOperation === template.operation, 'ENERGY_BALANCE_BUNDLE_OPERATION_MISMATCH', '两个批次 bundle operation 不匹配。');
  append(stableSerialize(boundary.importTypes || []) === stableSerialize(template.importTypes)
    && stableSerialize(item.importTypes || []) === stableSerialize(template.importTypes), 'ENERGY_BALANCE_BUNDLE_IMPORT_TYPES_MISMATCH', '两个批次 importTypes 不匹配。');
  append(boundary.uploadGroupId && boundary.uploadGroupId === item.uploadGroupId, 'ENERGY_BALANCE_BUNDLE_UPLOAD_GROUP_MISMATCH', '两个批次上传组不匹配。');
  append(boundary.storedFilename && boundary.storedFilename === item.storedFilename, 'ENERGY_BALANCE_BUNDLE_STORED_FILE_MISMATCH', '两个批次保存文件不匹配。');
  append(boundary.originalFilename && boundary.originalFilename === item.originalFilename, 'ENERGY_BALANCE_BUNDLE_ORIGINAL_FILE_MISMATCH', '两个批次原文件名不匹配。');
  append(Number(boundary.fileSizeBytes) > 0 && Number(boundary.fileSizeBytes) === Number(item.fileSizeBytes), 'ENERGY_BALANCE_BUNDLE_FILE_SIZE_MISMATCH', '两个批次文件大小不匹配。');
  append(/^[a-f0-9]{64}$/.test(String(boundary.fileSha256 || '')) && boundary.fileSha256 === item.fileSha256, 'ENERGY_BALANCE_BUNDLE_FILE_SHA256_MISMATCH', '两个批次文件摘要不匹配。');
  append(boundary.previewSignature === item.previewSignature, 'ENERGY_BALANCE_BUNDLE_PREVIEW_SIGNATURE_MISMATCH', '两个批次 preview 签名不匹配。');
  append(boundary.previewAuditDigest === item.previewAuditDigest, 'ENERGY_BALANCE_BUNDLE_PREVIEW_AUDIT_DIGEST_MISMATCH', '两个批次审计摘要不匹配。');
  if (failures.length) throw badRequest(failures[0].message, { code: failures[0].code, authorizationErrors: failures });
  const binding = { boundary, item };
  return {
    boundaryBatchId: boundary.id,
    itemBatchId: item.id,
    uploadGroupId: boundary.uploadGroupId,
    storedFilename: boundary.storedFilename,
    originalFilename: boundary.originalFilename,
    fileSizeBytes: Number(boundary.fileSizeBytes),
    fileSha256: boundary.fileSha256,
    previewSignature: boundary.previewSignature,
    previewAuditDigest: boundary.previewAuditDigest,
    binding,
    fingerprint: crypto.createHash('sha256').update(stableSerialize(binding)).digest('hex')
  };
}

/** 校验 core 多批次授权需要的平衡 bundle 元数据。 */
function validateBalanceBundleMetadata(bundle, expected = {}) {
  const errors = [];
  const boundary = bundle?.boundaryBatch;
  const item = bundle?.itemBatch;
  const append = (condition, code, message) => { if (!condition) errors.push({ code, message }); };
  append(bundle && typeof bundle === 'object', 'ENERGY_BALANCE_BUNDLE_REQUIRED', '平衡 bundle 为必填对象。');
  append(Number(bundle?.boundaryBatchId) > 0 && Number(bundle?.itemBatchId) > 0, 'ENERGY_BALANCE_BUNDLE_BATCH_ID_INVALID', '平衡双批次 ID 无效。');
  append(Number(bundle?.boundaryBatchId) !== Number(bundle?.itemBatchId), 'ENERGY_BALANCE_BUNDLE_BATCH_IDS_MUST_DIFFER', '平衡双批次 ID 必须不同。');
  append(boundary && item, 'ENERGY_BALANCE_BUNDLE_BATCH_METADATA_REQUIRED', '平衡双批次元数据缺失。');
  if (boundary && item) {
    append(Number(boundary.id) === Number(bundle.boundaryBatchId) && Number(item.id) === Number(bundle.itemBatchId), 'ENERGY_BALANCE_BUNDLE_BATCH_ID_MISMATCH', '平衡批次 ID 与元数据不一致。');
    append(boundary.fileSha256 === expected.fileSha256 && item.fileSha256 === expected.fileSha256, 'ENERGY_BALANCE_BUNDLE_FILE_SHA256_MISMATCH', '平衡批次文件摘要与当前文件不一致。');
    append(boundary.previewSignature === expected.previewSignature && item.previewSignature === expected.previewSignature, 'ENERGY_BALANCE_BUNDLE_PREVIEW_SIGNATURE_MISMATCH', '平衡批次签名与当前签名不一致。');
    append(boundary.previewAuditDigest === expected.previewAuditDigest && item.previewAuditDigest === expected.previewAuditDigest, 'ENERGY_BALANCE_BUNDLE_PREVIEW_AUDIT_DIGEST_MISMATCH', '平衡批次审计摘要与当前摘要不一致。');
  }
  return { metadataValid: errors.length === 0, errors };
}

/** 使用持久化配对与当前重算结果调用统一 execute 授权门槛。 */
function authorizePersistedExecute(body, boundaryBatch, itemBatch, securedPreview, fileBuffer, secret, trustedPair) {
  const template = getEnergyAnalysisImportTemplate(ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE);
  return authorizeEnergyAnalysisImportExecute({
    templateType: template.templateType,
    operation: template.operation,
    recordKind: template.recordKind,
    importTypes: [...template.importTypes],
    confirmText: body.confirmText,
    backupReason: body.backupReason,
    duplicateStrategy: body.duplicateStrategy,
    requireBackup: body.requireBackup,
    acknowledgeSkippedRisks: body.acknowledgeSkippedRisks,
    fileSha256: body.fileSha256,
    previewSignature: body.previewSignature,
    previewAuditDigest: body.previewAuditDigest,
    expectedWouldImport: body.expectedWouldImport,
    candidateRowIds: body.candidateRowIds,
    candidateRows: body.candidateRows,
    bundle: {
      boundaryBatchId: Number(boundaryBatch.id),
      itemBatchId: Number(itemBatch.id),
      uploadGroupId: body.uploadGroupId,
      boundaryBatch: trustedPair.binding.boundary,
      itemBatch: trustedPair.binding.item
    }
  }, {
    secret,
    fileBuffer,
    recomputedCandidateRows: securedPreview.candidateRows,
    previewAudit: securedPreview.previewAudit,
    validateBundleMetadata: validateBalanceBundleMetadata
  });
}

/** 将授权失败转换为稳定 BAD_REQUEST。 */
function throwAuthorizationFailure(authorization) {
  const firstError = authorization.errors?.[0] || { code: 'ENERGY_ANALYSIS_IMPORT_EXECUTE_NOT_AUTHORIZED', message: '平衡配置导入未获授权。' };
  throw badRequest(firstError.message, { code: firstError.code, authorizationErrors: authorization.errors || [] });
}

/** 使用领域服务在同一外层事务内原子写入边界和全部项目。 */
function insertEnergyBalanceCandidates(input) {
  const boundaryIdByCandidate = new Map();
  const boundaryImportedItems = [];
  input.boundaryCandidates.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertBoundary === 'function') input.options.beforeInsertBoundary({ candidate, index, db: input.db });
    const created = createBalanceBoundary(candidate.input, { db: input.db, actor: input.actor });
    if (candidate.status === 'inactive') setBalanceBoundaryStatus(created.id, { status: 'inactive' }, { db: input.db, actor: input.actor });
    boundaryIdByCandidate.set(candidate.candidateRowId, created.id);
    boundaryImportedItems.push({ id: created.id, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertBoundary === 'function') input.options.afterInsertBoundary({ candidate, index, importedId: created.id, db: input.db });
  });
  const itemImportedItems = [];
  input.itemCandidates.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertItem === 'function') input.options.beforeInsertItem({ candidate, index, db: input.db });
    const boundaryId = candidate.boundaryReferenceKind === 'candidate'
      ? boundaryIdByCandidate.get(candidate.boundaryCandidateRowId)
      : candidate.existingBoundaryId;
    if (!Number.isSafeInteger(Number(boundaryId)) || Number(boundaryId) <= 0) {
      throw badRequest('项目引用的平衡边界候选无法解析。', { code: 'ENERGY_BALANCE_IMPORT_BOUNDARY_REFERENCE_UNRESOLVED' });
    }
    const created = createBalanceItem(boundaryId, candidate.input, { db: input.db, actor: input.actor });
    if (candidate.status === 'inactive') setBalanceItemStatus(boundaryId, created.id, { status: 'inactive' }, { db: input.db, actor: input.actor });
    itemImportedItems.push({ id: created.id, boundaryId: Number(boundaryId), candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertItem === 'function') input.options.afterInsertItem({ candidate, index, importedId: created.id, boundaryId: Number(boundaryId), db: input.db });
  });
  return {
    boundary: { imported: boundaryImportedItems.length, importedIds: boundaryImportedItems.map((item) => item.id), importedItems: boundaryImportedItems },
    item: { imported: itemImportedItems.length, importedIds: itemImportedItems.map((item) => item.id), importedItems: itemImportedItems }
  };
}

/** 在可信配对仍未变化时将 execute 失败原子记录到两个批次。 */
function markBundleFailure(trustedPair, error, options = {}, backup = null) {
  if (!trustedPair) return;
  let databaseContext = null;
  try {
    databaseContext = openServiceDatabase(options);
    databaseContext.db.transaction(() => {
      const boundaryBatch = getImportAuditBatchDetail(trustedPair.boundaryBatchId, { db: databaseContext.db, includeIssues: false });
      const itemBatch = getImportAuditBatchDetail(trustedPair.itemBatchId, { db: databaseContext.db, includeIssues: false });
      const current = createTrustedPairContext(boundaryBatch, itemBatch, getEnergyAnalysisImportTemplate(ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE));
      if (current.fingerprint !== trustedPair.fingerprint) return;
      const errorCode = error?.details?.code || 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED';
      const message = '平衡配置导入失败，业务数据未写入或已整体回滚。';
      [boundaryBatch, itemBatch].forEach((batch) => updateExecuteAuditResult(batch.id, {
        status: 'failed',
        statistics: {
          totalRows: Number(batch.totalRows || 0),
          successCount: 0,
          failureCount: Number(batch.failureCount || 0),
          skippedCount: Number(batch.skippedCount || 0)
        },
        executeResult: { executed: false, writesBusinessRecords: false, errorCode, errorMessage: message, backup: projectSafeBackupSummary(backup) },
        backup,
        errorSummary: message
      }, { db: databaseContext.db }));
    })();
  } catch (_auditError) {
    // 失败审计必须保持双批次全有或全无，不覆盖原始异常。
  } finally {
    if (databaseContext?.shouldClose) databaseContext.db.close();
  }
}

/** 执行平衡边界和九角色项目双批次导入。 */
async function executeEnergyBalanceBundleImport(body = {}, options = {}) {
  let backup = null;
  let trustedPair = null;
  try {
    const boundaryBatchId = normalizeBatchId(body.boundaryBatchId);
    const itemBatchId = normalizeBatchId(body.itemBatchId);
    if (boundaryBatchId === itemBatchId) throw badRequest('两个批次 ID 必须不同。', { code: 'ENERGY_BALANCE_BUNDLE_BATCH_IDS_MUST_DIFFER' });
    if (!options.actor || !Number.isSafeInteger(Number(options.actor.userId)) || Number(options.actor.userId) <= 0) {
      throw badRequest('平衡导入执行必须提供已认证操作者。', { code: 'ENERGY_BALANCE_AUDIT_ACTOR_REQUIRED' });
    }
    const template = getEnergyAnalysisImportTemplate(ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE);
    const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
    const db = openDatabase();
    try {
      const boundaryBatch = getImportAuditBatchDetail(boundaryBatchId, { db, includeIssues: false });
      const itemBatch = getImportAuditBatchDetail(itemBatchId, { db, includeIssues: false });
      trustedPair = createTrustedPairContext(boundaryBatch, itemBatch, template);
      if (body.uploadGroupId !== trustedPair.uploadGroupId) throw badRequest('请求上传组与持久化批次不一致。', { code: 'ENERGY_BALANCE_BUNDLE_UPLOAD_GROUP_MISMATCH' });
      const safeFile = readSafeUploadFile(options.uploadsDir || defaultUploadsDir, trustedPair.storedFilename, {
        expectedSizeBytes: trustedPair.fileSizeBytes,
        maxSizeBytes: options.maxFileSizeBytes
      });
      const secret = resolveImportSecret(db, options);
      const domainPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: safeFile.buffer, originalFilename: trustedPair.originalFilename });
      const securedPreview = securePreviewResult(domainPreview, { template, fileSha256: safeFile.fileSha256, secret });
      const authorization = authorizePersistedExecute(body, boundaryBatch, itemBatch, securedPreview, safeFile.buffer, secret, trustedPair);
      if (!authorization.valid) throwAuthorizationFailure(authorization);
      let transactionActive = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        transactionActive = true;
        const latestBoundaryBatch = getImportAuditBatchDetail(boundaryBatchId, { db, includeIssues: false });
        const latestItemBatch = getImportAuditBatchDetail(itemBatchId, { db, includeIssues: false });
        const latestPair = createTrustedPairContext(latestBoundaryBatch, latestItemBatch, template);
        if (latestPair.fingerprint !== trustedPair.fingerprint) throw badRequest('锁内批次配对已变化。', { code: 'ENERGY_BALANCE_BUNDLE_PAIR_CHANGED' });
        const latestDomainPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: safeFile.buffer, originalFilename: latestPair.originalFilename });
        const latestSecuredPreview = securePreviewResult(latestDomainPreview, { template, fileSha256: safeFile.fileSha256, secret });
        const latestAuthorization = authorizePersistedExecute(body, latestBoundaryBatch, latestItemBatch, latestSecuredPreview, safeFile.buffer, secret, latestPair);
        if (!latestAuthorization.valid) throwAuthorizationFailure(latestAuthorization);
        trustedPair = latestPair;
        const createBackup = typeof options.createBackup === 'function' ? options.createBackup : backupService.createBackup;
        backup = await createBackup({ reason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON, skipCheckpoint: true });
        const insertion = insertEnergyBalanceCandidates({
          db,
          actor: options.actor,
          boundaryCandidates: latestDomainPreview.boundaryPreview.candidateRows,
          itemCandidates: latestDomainPreview.itemPreview.candidateRows,
          options
        });
        const safeBackup = projectSafeBackupSummary(backup);
        const buildRoleResult = (contract, preview, roleInsertion) => ({
          executed: true,
          writesBusinessRecords: roleInsertion.imported > 0,
          templateType: template.templateType,
          operation: contract.operation,
          recordKind: contract.recordKind,
          bundleOperation: template.operation,
          bundleRecordKind: template.recordKind,
          importTypes: [...template.importTypes],
          importType: contract.importType,
          uploadGroupId: latestPair.uploadGroupId,
          imported: roleInsertion.imported,
          skipped: Number(preview.summary.skipped || 0),
          blocked: Number(preview.summary.blocked || 0),
          warnings: Number(preview.summary.warnings || 0),
          errors: Number(preview.summary.errors || 0),
          candidateRowIds: preview.candidateRows.map((row) => row.candidateRowId),
          combinedCandidateRowIds: latestSecuredPreview.candidateRowIds,
          previewSignature: latestSecuredPreview.previewSignature,
          previewAuditDigest: latestSecuredPreview.previewAuditDigest,
          importedIds: roleInsertion.importedIds,
          importedItems: roleInsertion.importedItems,
          backup: safeBackup
        });
        const boundaryResult = buildRoleResult(ENERGY_BALANCE_BOUNDARY_BATCH_CONTRACT, latestDomainPreview.boundaryPreview, insertion.boundary);
        const itemResult = buildRoleResult(ENERGY_BALANCE_ITEM_BATCH_CONTRACT, latestDomainPreview.itemPreview, insertion.item);
        const updateRole = (batchId, preview, roleInsertion, executeResult) => updateExecuteAuditResult(batchId, {
          status: Number(preview.summary.blocked || 0) > 0 || Number(preview.summary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed',
          statistics: {
            totalRows: Number(preview.summary.totalRows || 0),
            successCount: roleInsertion.imported,
            failureCount: Number(preview.summary.blocked || 0),
            skippedCount: Number(preview.summary.skipped || 0)
          },
          executeResult,
          backup,
          errorSummary: buildPreviewErrorSummary(preview.summary)
        }, { db });
        updateRole(boundaryBatchId, latestDomainPreview.boundaryPreview, insertion.boundary, boundaryResult);
        updateRole(itemBatchId, latestDomainPreview.itemPreview, insertion.item, itemResult);
        const result = {
          executed: true,
          writesBusinessRecords: insertion.boundary.imported + insertion.item.imported > 0,
          uploadGroupId: latestPair.uploadGroupId,
          boundaryBatchId,
          itemBatchId,
          imported: insertion.boundary.imported + insertion.item.imported,
          boundary: boundaryResult,
          item: itemResult,
          backup: safeBackup,
          boundaryBatch: getImportAuditSummary(boundaryBatchId, { db }),
          itemBatch: getImportAuditSummary(itemBatchId, { db })
        };
        if (options.demoContext) {
          markDemoContextExecutedInTransaction({
            db,
            ...options.demoContext,
            uploadFileSha256: safeFile.fileSha256,
            previewDigest: latestSecuredPreview.previewAuditDigest,
            batchBindings: [
              { batchId: boundaryBatchId, batchRole: 'boundary' },
              { batchId: itemBatchId, batchRole: 'item' }
            ]
          });
        }
        db.exec('COMMIT');
        transactionActive = false;
        return result;
      } catch (error) {
        if (transactionActive) {
          try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 保留原始错误。 */ }
        }
        throw error;
      }
    } finally {
      db.close();
    }
  } catch (error) {
    markBundleFailure(trustedPair, error, options, backup);
    throw error;
  }
}

module.exports = {
  ENERGY_BALANCE_BOUNDARY_BATCH_CONTRACT,
  ENERGY_BALANCE_BUNDLE_SERVICE_VERSION,
  ENERGY_BALANCE_BUNDLE_TEMPLATE_TYPE,
  ENERGY_BALANCE_CONFIRM_TEXT,
  ENERGY_BALANCE_ITEM_BATCH_CONTRACT,
  buildEnergyBalanceBundleImportPreview,
  executeEnergyBalanceBundleImport,
  insertEnergyBalanceCandidates,
  parseBusinessLocator,
  parseEnergyBalanceBundleRows,
  previewEnergyBalanceBundleImport,
  validateBalanceBundleMetadata
};
