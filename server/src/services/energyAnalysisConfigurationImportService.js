'use strict';

const crypto = require('crypto');
const { badRequest } = require('../utils/errors');
const { parseImportBuffer } = require('./import/parser');
const {
  buildImportSummary,
  createImportIssue,
  stableSerialize
} = require('./energyAnalysisImportCore');
const {
  deactivateSiblingVersions,
  insertShiftDefinitionWithDb,
  insertStrategyRuleWithDb,
  insertTouSchemeWithDb,
  normalizeShiftDefinitionInput,
  normalizeStrategyRuleInput,
  normalizeTouSchemeInput
} = require('./energyConsumptionConfigurationService');
const { insertOperationLogWithDb } = require('./energyStrategyEvaluationService');
const {
  getEnergyAnalysisTemplateDefinition,
  parseEnergyAnalysisTemplateBuffer
} = require('./energyAnalysisTemplateService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');
const {
  createDemoOwnershipInsertWitness,
  deactivateShiftDefinitionSiblingsInOwnershipTransaction,
  deactivateStrategyRuleSiblingsInOwnershipTransaction,
  writeShiftDefinitionImportAuditInOwnershipTransaction,
  writeStrategyRuleImportAuditInOwnershipTransaction
} = require('./demoOwnershipService');

// 三类配置导入固定模板 ID。
const SHIFT_DEFINITION_TEMPLATE_TYPE = 'shift-definitions';
const TOU_SCHEME_TEMPLATE_TYPE = 'tou-schemes';
const STRATEGY_RULE_TEMPLATE_TYPE = 'strategy-rules';

// 模板对应主工作表和候选 ID 前缀。
const CONFIGURATION_IMPORT_CONTRACTS = Object.freeze({
  [SHIFT_DEFINITION_TEMPLATE_TYPE]: Object.freeze({ sheetName: '班次定义', candidatePrefix: 'shift-definition' }),
  [TOU_SCHEME_TEMPLATE_TYPE]: Object.freeze({ sheetName: 'TOU方案', ruleSheetName: '时段规则', candidatePrefix: 'tou-scheme' }),
  [STRATEGY_RULE_TEMPLATE_TYPE]: Object.freeze({ sheetName: '策略规则', candidatePrefix: 'strategy-rule' })
});

/** 判断原始单元格是否为空。 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** 将原始单元格规范化为去除首尾空白的文本。 */
function normalizeText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/** 将模板秒精度 UTC 显式规范化为配置服务要求的毫秒精度 UTC。 */
function normalizeConfigurationUtc(value) {
  const text = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text;
}

/** 将模板布尔单元格解析为领域布尔值。 */
function parseBooleanFlag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  const normalized = normalizeText(value).toLowerCase();
  if (['true', 'yes', '是'].includes(normalized)) return true;
  if (['false', 'no', '否'].includes(normalized)) return false;
  return value;
}

/** 将可选有限数值单元格转换为 number 或 null。 */
function parseOptionalNumber(value) {
  return isBlank(value) ? null : Number(value);
}

/** 创建配置导入行级问题。 */
function createConfigurationIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({ rowNumber, fieldName, rawValue, code, message, severity });
}

/** 将模板解析问题映射为统一导入问题。 */
function mapTemplateIssue(issue, fallbackRowNumber) {
  const rowNumber = Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
    ? issue.sourceRowNumber
    : fallbackRowNumber;
  return createConfigurationIssue(
    rowNumber,
    issue.expectedKey || issue.key || issue.header || null,
    issue.values || issue.header || null,
    issue.code || 'ENERGY_ANALYSIS_CONFIGURATION_TEMPLATE_INVALID',
    issue.message || '配置导入模板不符合冻结契约。',
    issue.severity === 'warning' ? 'warning' : 'error'
  );
}

/** 判断策略模板未知标题是否试图注入任意 JSON、表达式、脚本、函数或命令。 */
function isForbiddenStrategyInjectionHeader(issue) {
  if (!issue || issue.code !== 'UNKNOWN_HEADER') return false;
  const header = normalizeText(issue.header);
  return /(json|表达式|expression|脚本|script|函数|function|命令|command)/i.test(header);
}

/** 将策略模板注入型未知标题升级为阻断问题，普通扩展列仍沿用模板 warning 规则。 */
function mapStrategyTemplateIssue(issue, fallbackRowNumber) {
  if (!isForbiddenStrategyInjectionHeader(issue)) return mapTemplateIssue(issue, fallbackRowNumber);
  return createConfigurationIssue(
    Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
      ? issue.sourceRowNumber
      : fallbackRowNumber,
    null,
    issue.header,
    'ENERGY_ANALYSIS_STRATEGY_ARBITRARY_INPUT_FORBIDDEN',
    '策略规则导入禁止任意 JSON、动态表达式、脚本、函数或命令字段。'
  );
}

/** 合并内部字段到原始标题的映射。 */
function mergeFieldMapping(target, source) {
  Object.entries(source || {}).forEach(([key, headers]) => {
    target[key] = [...new Set([...(target[key] || []), ...(Array.isArray(headers) ? headers : [headers])].filter(Boolean).map(String))];
  });
}

/** 根据冻结模板列定义补齐必填值问题。 */
function validateRequiredFields(templateType, sheetName, mapped, rowNumber) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  const sheet = definition.sheets.find((item) => item.name === sheetName);
  return sheet.columns
    .filter((column) => column.required && isBlank(mapped[column.key]))
    .map((column) => createConfigurationIssue(
      rowNumber,
      column.key,
      mapped[column.key],
      'REQUIRED_FIELD_MISSING',
      `必填字段“${column.name}”不能为空。`
    ));
}

/** 从安全 Buffer 解析单表或 TOU 双表，并保留物理行号。 */
function parseConfigurationTemplate(templateType, buffer, originalFilename) {
  const contract = CONFIGURATION_IMPORT_CONTRACTS[templateType];
  if (!contract) {
    throw badRequest('能源分析配置导入模板不受支持。', {
      code: 'ENERGY_ANALYSIS_CONFIGURATION_TEMPLATE_UNSUPPORTED',
      templateType
    });
  }
  const safety = parseImportBuffer(buffer, originalFilename);
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  if (!definition.formats.includes(safety.fileType)) {
    throw badRequest('配置导入文件格式不受冻结模板支持。', {
      code: 'ENERGY_ANALYSIS_CONFIGURATION_FILE_TYPE_UNSUPPORTED',
      fileType: safety.fileType,
      supportedFileTypes: [...definition.formats]
    });
  }
  const parsed = parseEnergyAnalysisTemplateBuffer(templateType, buffer, originalFilename);
  const fieldMapping = {};
  parsed.sheets.forEach((sheet) => {
    (sheet.resolvedRows || []).forEach((row) => mergeFieldMapping(fieldMapping, row.fieldMapping));
  });
  return { fileType: safety.fileType, parsed, fieldMapping, contract };
}

/** 将领域 normalizer 错误转为脱敏行级阻断项。 */
function captureNormalizerIssues(rowNumber, fieldName, rawValue, action) {
  try {
    return { value: action(), issues: [] };
  } catch (error) {
    return {
      value: null,
      issues: [createConfigurationIssue(
        rowNumber,
        error?.details?.field || fieldName,
        rawValue,
        `ENERGY_ANALYSIS_${error?.details?.code || 'CONFIGURATION_ROW_INVALID'}`,
        error?.message || '配置行不符合领域规则。'
      )]
    };
  }
}

/** 将数据库班次行投影为可比较业务快照。 */
function mapExistingShift(row) {
  return row ? {
    shiftCode: row.shiftCode,
    shiftName: row.shiftName,
    startMinute: Number(row.startMinute),
    endMinute: Number(row.endMinute),
    crossesMidnight: Number(row.crossesMidnight) === 1,
    sourceTimeZone: row.sourceTimeZone,
    source: row.source,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    status: row.status
  } : null;
}

/** 查询班次定义身份快照。 */
function findExistingShift(db, record) {
  return mapExistingShift(db.prepare(
    `SELECT shift_code AS shiftCode, shift_name AS shiftName,
            start_minute AS startMinute, end_minute AS endMinute,
            crosses_midnight AS crossesMidnight, source_timezone AS sourceTimeZone,
            source, version, effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, status
       FROM shift_definitions
      WHERE shift_code = ? AND version = ?`
  ).get(record.shiftCode, record.version));
}

/** 查询并投影完整 TOU 方案身份快照。 */
function findExistingTou(db, record) {
  const row = db.prepare(
    `SELECT id, scheme_code AS schemeCode, scheme_name AS schemeName,
            source_timezone AS sourceTimeZone, source, document_no AS documentNo,
            version, effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, status
       FROM tou_schemes
      WHERE scheme_code = ? AND version = ?`
  ).get(record.schemeCode, record.version);
  if (!row) return null;
  const periodRules = db.prepare(
    `SELECT day_of_week AS dayOfWeek, period_type AS periodType,
            start_minute AS startMinute, end_minute AS endMinute
       FROM tou_period_rules
      WHERE tou_scheme_id = ?
      ORDER BY day_of_week ASC, start_minute ASC, end_minute ASC, period_type ASC`
  ).all(row.id).map((rule) => ({
    dayOfWeek: Number(rule.dayOfWeek),
    periodType: rule.periodType,
    startMinute: Number(rule.startMinute),
    endMinute: Number(rule.endMinute)
  }));
  return {
    schemeCode: row.schemeCode,
    schemeName: row.schemeName,
    sourceTimeZone: row.sourceTimeZone,
    source: row.source,
    documentNo: row.documentNo,
    version: row.version,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    status: row.status,
    periodRules
  };
}

/** 查询并投影策略规则身份快照。 */
function findExistingStrategy(db, record) {
  const row = db.prepare(
    `SELECT rule_code AS ruleCode, rule_name AS ruleName,
            rule_version AS ruleVersion, formula_version AS formulaVersion,
            metric_code AS metricCode, threshold_operator AS thresholdOperator,
            threshold_value AS thresholdValue, threshold_min AS thresholdMin,
            threshold_max AS thresholdMax, threshold_unit AS thresholdUnit,
            reduction_rate AS reductionRate, priority,
            evidence_requirements_json AS evidenceRequirementsJson,
            recommendation_text AS recommendationText, source,
            effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc, source_timezone AS sourceTimeZone,
            status
       FROM strategy_rules
      WHERE rule_code = ? AND rule_version = ?`
  ).get(record.ruleCode, record.ruleVersion);
  if (!row) return null;
  let evidenceRequirements = null;
  try { evidenceRequirements = JSON.parse(row.evidenceRequirementsJson); } catch (_error) { evidenceRequirements = null; }
  return {
    ruleCode: row.ruleCode,
    ruleName: row.ruleName,
    ruleVersion: row.ruleVersion,
    formulaVersion: row.formulaVersion,
    metricCode: row.metricCode,
    thresholdOperator: row.thresholdOperator,
    thresholdValue: row.thresholdValue === null ? null : Number(row.thresholdValue),
    thresholdMin: row.thresholdMin === null ? null : Number(row.thresholdMin),
    thresholdMax: row.thresholdMax === null ? null : Number(row.thresholdMax),
    thresholdUnit: row.thresholdUnit,
    reductionRate: row.reductionRate === null ? null : Number(row.reductionRate),
    priority: row.priority,
    evidenceRequirements,
    recommendationText: row.recommendationText,
    source: row.source,
    effectiveStartUtc: row.effectiveStartUtc,
    effectiveEndUtc: row.effectiveEndUtc,
    sourceTimeZone: row.sourceTimeZone,
    status: row.status
  };
}

/** 剥离仅用于导入追溯和候选见证的字段，保留可判定重复的配置业务内容。 */
function buildConfigurationBusinessSnapshot(record) {
  if (!record || typeof record !== 'object') return record;
  const {
    candidateRowId: _candidateRowId,
    sourceRowNumber: _sourceRowNumber,
    ...businessSnapshot
  } = record;
  return businessSnapshot;
}

/** 判断两个配置业务快照是否完全一致，不把物理行号和候选见证当作业务差异。 */
function isExactConfiguration(left, right) {
  return stableSerialize(buildConfigurationBusinessSnapshot(left))
    === stableSerialize(buildConfigurationBusinessSnapshot(right));
}

/** 为规范配置生成稳定候选 ID。 */
function buildConfigurationCandidateRowId(prefix, record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `${prefix}:${record.sourceRowNumber}:${digest}`;
}

/** 附加模板全局结构问题，空表也保留可审计阻断项。 */
function attachGlobalIssues(rows, globalIssues) {
  if (globalIssues.length === 0) return;
  if (rows.length === 0) {
    rows.push({ rowNumber: 1, record: null, issues: [...globalIssues], structuralOnly: true });
    return;
  }
  const blocking = globalIssues.filter((issue) => issue.severity === 'error');
  const warnings = globalIssues.filter((issue) => issue.severity === 'warning');
  rows.forEach((row) => row.issues.push(...blocking));
  rows[0].issues.push(...warnings);
}

/** 检测同一编码存在多个 active 版本，并阻断全部相关候选。 */
function markMultipleActiveVersions(rows, codeField) {
  const groups = new Map();
  rows.forEach((row) => {
    if (!row.record || row.issues.some((issue) => issue.severity === 'error') || row.record.status !== 'active') return;
    const code = row.record[codeField];
    groups.set(code, [...(groups.get(code) || []), row]);
  });
  groups.forEach((items, code) => {
    const versions = new Set(items.map((item) => item.identityVersion));
    if (versions.size <= 1) return;
    items.forEach((item) => item.issues.push(createConfigurationIssue(
      item.rowNumber,
      'status',
      { code, versions: [...versions] },
      'ENERGY_ANALYSIS_MULTIPLE_ACTIVE_VERSIONS_IN_FILE',
      `同一文件内编码 ${code} 不能包含多个 active 版本。`
    )));
  });
}

/** 检测同文件同身份重复和冲突。 */
function markInputIdentityDuplicates(rows, identityBuilder, duplicateCode, conflictCode) {
  const firstByIdentity = new Map();
  rows.forEach((row) => {
    if (!row.record || row.issues.some((issue) => issue.severity === 'error')) return;
    const identity = identityBuilder(row.record);
    const first = firstByIdentity.get(identity);
    if (!first) {
      firstByIdentity.set(identity, row);
      return;
    }
    if (isExactConfiguration(first.record, row.record)) {
      row.skipDuplicate = true;
      row.issues.push(createConfigurationIssue(
        row.rowNumber,
        null,
        identity,
        duplicateCode,
        `输入文件第 ${row.rowNumber} 行与第 ${first.rowNumber} 行身份和内容完全相同，本行按 skip 策略跳过。`,
        'warning'
      ));
      return;
    }
    first.issues.push(createConfigurationIssue(first.rowNumber, null, identity, conflictCode, '同一文件内相同配置身份存在不同内容，不能覆盖。'));
    row.issues.push(createConfigurationIssue(row.rowNumber, null, identity, conflictCode, '同一文件内相同配置身份存在不同内容，不能覆盖。'));
  });
}

/** 根据数据库同身份内容标记 skip 或冲突。 */
function markDatabaseIdentity(rows, findExisting, identityLabel) {
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existing = findExisting(row.record);
    if (!existing) return;
    if (isExactConfiguration(existing, row.record)) {
      row.skipDuplicate = true;
      row.issues.push(createConfigurationIssue(
        row.rowNumber,
        null,
        identityLabel(row.record),
        'ENERGY_ANALYSIS_CONFIGURATION_DUPLICATE_SKIPPED',
        '数据库已存在身份和内容完全相同的配置，本候选按 skip 策略跳过。',
        'warning'
      ));
      return;
    }
    row.issues.push(createConfigurationIssue(
      row.rowNumber,
      null,
      identityLabel(row.record),
      'ENERGY_ANALYSIS_CONFIGURATION_IDENTITY_CONFLICT',
      '数据库已存在相同身份但内容不同的配置，导入禁止覆盖。'
    ));
  });
}

/** 投影统一配置 preview 结构。 */
function buildConfigurationPreviewResult(input) {
  const items = input.rows.map((row) => ({
    rowNumber: row.rowNumber,
    sourceRowNumber: row.rowNumber,
    status: row.issues.some((issue) => issue.severity === 'error') ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport'),
    issues: row.issues,
    normalizedRecord: row.record,
    structuralOnly: row.structuralOnly === true
  }));
  const candidateRows = input.rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({
      candidateRowId: buildConfigurationCandidateRowId(input.candidatePrefix, row.record),
      ...row.record
    }));
  return {
    fileType: input.fileType,
    fieldMapping: input.fieldMapping,
    items,
    candidateRows,
    summary: buildImportSummary(items),
    auditIssues: items.flatMap((item) => item.issues || []),
    notices: [...input.notices]
  };
}

/** 构建班次定义导入 preview。 */
function buildShiftDefinitionImportPreview(input) {
  const parsedTemplate = parseConfigurationTemplate(SHIFT_DEFINITION_TEMPLATE_TYPE, input.buffer, input.originalFilename);
  const sheet = parsedTemplate.parsed.sheetsByName['班次定义'];
  const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
    const mapped = resolvedRow.record || {};
    const rowNumber = resolvedRow.sourceRowNumber;
    const issues = [
      ...(resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, rowNumber)),
      ...validateRequiredFields(SHIFT_DEFINITION_TEMPLATE_TYPE, '班次定义', mapped, rowNumber)
    ];
    const normalized = captureNormalizerIssues(rowNumber, null, mapped, () => normalizeShiftDefinitionInput({
      shiftCode: normalizeText(mapped.shiftCode),
      shiftName: normalizeText(mapped.shiftName),
      startMinute: Number(mapped.startMinute),
      endMinute: Number(mapped.endMinute),
      crossesMidnight: parseBooleanFlag(mapped.crossesMidnight),
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
      source: normalizeText(mapped.source),
      version: normalizeText(mapped.version),
      effectiveStartUtc: normalizeConfigurationUtc(mapped.effectiveStartUtc),
      effectiveEndUtc: normalizeConfigurationUtc(mapped.effectiveEndUtc),
      status: normalizeText(mapped.status) || 'active'
    }));
    issues.push(...normalized.issues);
    const record = normalized.value ? { sourceRowNumber: rowNumber, ...normalized.value } : null;
    return { rowNumber, identityVersion: record?.version, record, issues };
  });
  const globalIssues = [
    ...(parsedTemplate.parsed.sheetCollection?.issues || []),
    ...(sheet?.headerIssues || [])
  ].map((issue) => mapTemplateIssue(issue, 1));
  attachGlobalIssues(rows, globalIssues);
  markMultipleActiveVersions(rows, 'shiftCode');
  markInputIdentityDuplicates(rows, (record) => `${record.shiftCode}\0${record.version}`, 'ENERGY_ANALYSIS_SHIFT_DEFINITION_DUPLICATE_SKIPPED', 'ENERGY_ANALYSIS_SHIFT_DEFINITION_IDENTITY_CONFLICT');
  markDatabaseIdentity(rows, (record) => findExistingShift(input.db, record), (record) => `${record.shiftCode}+${record.version}`);
  return buildConfigurationPreviewResult({
    rows,
    fileType: parsedTemplate.fileType,
    fieldMapping: parsedTemplate.fieldMapping,
    candidatePrefix: 'shift-definition',
    notices: [
      'preview 不写 shift_definitions；完全重复按 skip，身份冲突阻断且不覆盖。',
      'active 新版本只在 execute 的统一事务内停用同编码其他 active 版本，并写入 source_batch_id 与 source_row_number。'
    ]
  });
}

/** 构建 TOU 双工作表导入 preview。 */
function buildTouSchemeImportPreview(input) {
  const parsedTemplate = parseConfigurationTemplate(TOU_SCHEME_TEMPLATE_TYPE, input.buffer, input.originalFilename);
  const schemeSheet = parsedTemplate.parsed.sheetsByName['TOU方案'];
  const ruleSheet = parsedTemplate.parsed.sheetsByName['时段规则'];
  const ruleGroups = new Map();
  const referencedRuleKeys = new Set();
  (ruleSheet?.resolvedRows || []).forEach((resolvedRow) => {
    const mapped = resolvedRow.record || {};
    const key = `${normalizeText(mapped.schemeCode)}\0${normalizeText(mapped.schemeVersion)}`;
    const issues = [
      ...(resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, resolvedRow.sourceRowNumber)),
      ...validateRequiredFields(TOU_SCHEME_TEMPLATE_TYPE, '时段规则', mapped, resolvedRow.sourceRowNumber)
    ];
    const rule = {
      dayOfWeek: Number(mapped.dayOfWeek),
      periodType: normalizeText(mapped.periodType),
      startMinute: Number(mapped.startMinute),
      endMinute: Number(mapped.endMinute)
    };
    ruleGroups.set(key, [...(ruleGroups.get(key) || []), { rowNumber: resolvedRow.sourceRowNumber, rule, issues }]);
  });
  const rows = (schemeSheet?.resolvedRows || []).map((resolvedRow) => {
    const mapped = resolvedRow.record || {};
    const rowNumber = resolvedRow.sourceRowNumber;
    const issues = [
      ...(resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, rowNumber)),
      ...validateRequiredFields(TOU_SCHEME_TEMPLATE_TYPE, 'TOU方案', mapped, rowNumber)
    ];
    const key = `${normalizeText(mapped.schemeCode)}\0${normalizeText(mapped.version)}`;
    referencedRuleKeys.add(key);
    const groupedRules = ruleGroups.get(key) || [];
    groupedRules.forEach((entry) => issues.push(...entry.issues));
    if (groupedRules.length === 0) {
      issues.push(createConfigurationIssue(rowNumber, 'periodRules', key, 'ENERGY_ANALYSIS_TOU_PERIOD_RULES_REQUIRED', 'TOU 方案必须在“时段规则”工作表中提供完整七天规则。'));
    }
    const normalized = captureNormalizerIssues(rowNumber, 'periodRules', mapped, () => normalizeTouSchemeInput({
      schemeCode: normalizeText(mapped.schemeCode),
      schemeName: normalizeText(mapped.schemeName),
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
      source: normalizeText(mapped.source),
      documentNo: normalizeText(mapped.documentNo) || null,
      version: normalizeText(mapped.version),
      effectiveStartUtc: normalizeConfigurationUtc(mapped.effectiveStartUtc),
      effectiveEndUtc: normalizeConfigurationUtc(mapped.effectiveEndUtc),
      status: normalizeText(mapped.status) || 'active',
      periodRules: groupedRules.map((entry) => entry.rule)
    }));
    issues.push(...normalized.issues);
    const record = normalized.value ? { sourceRowNumber: rowNumber, ...normalized.value } : null;
    return { rowNumber, identityVersion: record?.version, record, issues };
  });
  ruleGroups.forEach((entries, key) => {
    if (referencedRuleKeys.has(key)) return;
    const rowNumber = entries[0]?.rowNumber || 1;
    rows.push({
      rowNumber,
      identityVersion: null,
      record: null,
      issues: [
        ...entries.flatMap((entry) => entry.issues),
        createConfigurationIssue(rowNumber, 'schemeCode', key, 'ENERGY_ANALYSIS_TOU_SCHEME_REFERENCE_NOT_FOUND', '时段规则引用的方案编码和版本在“TOU方案”工作表中不存在。')
      ]
    });
  });
  const globalIssues = [
    ...(parsedTemplate.parsed.sheetCollection?.issues || []),
    ...(schemeSheet?.headerIssues || []),
    ...(ruleSheet?.headerIssues || [])
  ].map((issue) => mapTemplateIssue(issue, 1));
  attachGlobalIssues(rows, globalIssues);
  markMultipleActiveVersions(rows, 'schemeCode');
  markInputIdentityDuplicates(rows, (record) => `${record.schemeCode}\0${record.version}`, 'ENERGY_ANALYSIS_TOU_SCHEME_DUPLICATE_SKIPPED', 'ENERGY_ANALYSIS_TOU_SCHEME_IDENTITY_CONFLICT');
  markDatabaseIdentity(rows, (record) => findExistingTou(input.db, record), (record) => `${record.schemeCode}+${record.version}`);
  return buildConfigurationPreviewResult({
    rows,
    fileType: parsedTemplate.fileType,
    fieldMapping: parsedTemplate.fieldMapping,
    candidatePrefix: 'tou-scheme',
    notices: [
      'TOU 只接受精确双工作表 XLSX；每个方案的星期 1 至 7 必须分别无缺口、无重叠覆盖 0 至 1440 分钟。',
      '方案主行和全部规则在 execute 的同一 SQLite 事务内原子写入，完全重复按 skip，身份冲突阻断。'
    ]
  });
}

/** 构建策略规则导入 preview。 */
function buildStrategyRuleImportPreview(input) {
  const parsedTemplate = parseConfigurationTemplate(STRATEGY_RULE_TEMPLATE_TYPE, input.buffer, input.originalFilename);
  const sheet = parsedTemplate.parsed.sheetsByName['策略规则'];
  const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
    const mapped = resolvedRow.record || {};
    const rowNumber = resolvedRow.sourceRowNumber;
    const issues = [
      ...(resolvedRow.issues || []).map((issue) => mapStrategyTemplateIssue(issue, rowNumber)),
      ...validateRequiredFields(STRATEGY_RULE_TEMPLATE_TYPE, '策略规则', mapped, rowNumber)
    ];
    const evidenceRequirements = {};
    if (!isBlank(mapped.minimumCoverageRate)) evidenceRequirements.minimumCoverageRate = Number(mapped.minimumCoverageRate);
    if (!isBlank(mapped.maxEvidenceItems)) evidenceRequirements.maxEvidenceItems = Number(mapped.maxEvidenceItems);
    if (!isBlank(mapped.savingBasis)) evidenceRequirements.savingBasis = normalizeText(mapped.savingBasis);
    const normalized = captureNormalizerIssues(rowNumber, null, mapped, () => normalizeStrategyRuleInput({
      ruleCode: normalizeText(mapped.ruleCode),
      ruleName: normalizeText(mapped.ruleName),
      ruleVersion: normalizeText(mapped.ruleVersion),
      formulaVersion: normalizeText(mapped.formulaVersion),
      metricCode: normalizeText(mapped.metricCode),
      thresholdOperator: normalizeText(mapped.thresholdOperator),
      thresholdValue: parseOptionalNumber(mapped.thresholdValue),
      thresholdMin: parseOptionalNumber(mapped.thresholdMin),
      thresholdMax: parseOptionalNumber(mapped.thresholdMax),
      thresholdUnit: normalizeText(mapped.thresholdUnit),
      reductionRate: parseOptionalNumber(mapped.reductionRate),
      priority: normalizeText(mapped.priority),
      evidenceRequirements,
      recommendationText: normalizeText(mapped.recommendationText),
      source: normalizeText(mapped.source),
      effectiveStartUtc: normalizeConfigurationUtc(mapped.effectiveStartUtc),
      effectiveEndUtc: normalizeConfigurationUtc(mapped.effectiveEndUtc),
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
      status: normalizeText(mapped.status) || 'active'
    }));
    issues.push(...normalized.issues);
    const record = normalized.value ? {
      sourceRowNumber: rowNumber,
      ruleCode: normalized.value.ruleCode,
      ruleName: normalized.value.ruleName,
      ruleVersion: normalized.value.ruleVersion,
      formulaVersion: normalized.value.formulaVersion,
      metricCode: normalized.value.metricCode,
      thresholdOperator: normalized.value.thresholdOperator,
      thresholdValue: normalized.value.thresholdValue,
      thresholdMin: normalized.value.thresholdMin,
      thresholdMax: normalized.value.thresholdMax,
      thresholdUnit: normalized.value.thresholdUnit,
      reductionRate: normalized.value.reductionRate,
      priority: normalized.value.priority,
      evidenceRequirements: normalized.value.evidenceRequirements,
      recommendationText: normalized.value.recommendationText,
      source: normalized.value.source,
      effectiveStartUtc: normalized.value.effectiveStartUtc,
      effectiveEndUtc: normalized.value.effectiveEndUtc,
      sourceTimeZone: normalized.value.sourceTimeZone,
      status: normalized.value.status
    } : null;
    return { rowNumber, identityVersion: record?.ruleVersion, record, issues };
  });
  const globalIssues = [
    ...(parsedTemplate.parsed.sheetCollection?.issues || []),
    ...(sheet?.headerIssues || [])
  ].map((issue) => mapStrategyTemplateIssue(issue, 1));
  attachGlobalIssues(rows, globalIssues);
  markMultipleActiveVersions(rows, 'ruleCode');
  markInputIdentityDuplicates(rows, (record) => `${record.ruleCode}\0${record.ruleVersion}`, 'ENERGY_ANALYSIS_STRATEGY_RULE_DUPLICATE_SKIPPED', 'ENERGY_ANALYSIS_STRATEGY_RULE_IDENTITY_CONFLICT');
  markDatabaseIdentity(rows, (record) => findExistingStrategy(input.db, record), (record) => `${record.ruleCode}+${record.ruleVersion}`);
  return buildConfigurationPreviewResult({
    rows,
    fileType: parsedTemplate.fileType,
    fieldMapping: parsedTemplate.fieldMapping,
    candidatePrefix: 'strategy-rule',
    notices: [
      '策略模板只从普通列构造 minimumCoverageRate、maxEvidenceItems 和 savingBasis，不接受任意 JSON 或动态表达式。',
      '导入只保存受控规则，不运行策略、不生成命中，也不修改设备、预算、能耗或其他领域数据。'
    ]
  });
}

/** 校验 execute 配置写入必须携带服务端认证操作者。 */
function requireConfigurationImportAuditOptions(options) {
  const actorUserId = options?.actorUserId;
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw badRequest('配置导入执行必须携带服务端认证操作者。', {
      code: 'ENERGY_ANALYSIS_CONFIGURATION_IMPORT_ACTOR_REQUIRED'
    });
  }
  return {
    actorUserId,
    actorIp: options.actorIp || null,
    auditWriter: typeof options.auditWriter === 'function' ? options.auditWriter : insertOperationLogWithDb
  };
}

/** 在当前事务内写入单条配置操作审计。 */
function writeConfigurationImportAudit(db, auditOptions, audit) {
  return auditOptions.auditWriter(db, {
    userId: auditOptions.actorUserId,
    operation: audit.operation,
    targetType: audit.targetType,
    targetId: audit.targetId,
    detail: audit.detail,
    ip: auditOptions.actorIp,
    createdAt: audit.createdAt
  });
}

/** 在 ownership 私有事务内使用声明式 row witness 插入班次定义候选。 */
function insertManagedShiftDefinitionCandidates(input) {
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') {
      input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    }
    const nowUtc = new Date().toISOString();
    if (candidate.status === 'active') {
      deactivateShiftDefinitionSiblingsInOwnershipTransaction({
        transactionScope: input.transactionScope,
        shiftCode: candidate.shiftCode,
        updatedAt: nowUtc
      });
    }
    const normalized = normalizeShiftDefinitionInput(candidate);
    const insertSql = `INSERT INTO shift_definitions (
       source_batch_id, source_row_number, shift_code, shift_name,
       start_minute, end_minute, crosses_midnight, source_timezone, source,
       version, effective_start_utc, effective_end_utc, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertParams = [
      input.batchId,
      candidate.sourceRowNumber,
      normalized.shiftCode,
      normalized.shiftName,
      normalized.startMinute,
      normalized.endMinute,
      normalized.crossesMidnight ? 1 : 0,
      normalized.sourceTimeZone,
      normalized.source,
      normalized.version,
      normalized.effectiveStartUtc,
      normalized.effectiveEndUtc,
      normalized.status,
      nowUtc,
      nowUtc
    ];
    const rowWitness = createDemoOwnershipInsertWitness({
      transactionScope: input.transactionScope,
      entityType: 'shift_definition',
      insertParams,
      insertSql,
      sourceBatchId: input.batchId,
      sourceRowNumber: candidate.sourceRowNumber
    });
    const importedId = Number(rowWitness.lastInsertRowid);
    writeShiftDefinitionImportAuditInOwnershipTransaction({
      transactionScope: input.transactionScope,
      actorUserId: input.options.actorUserId ?? input.options.demoContext?.userId,
      actorIp: input.options.actorIp ?? null,
      targetId: importedId,
      batchId: input.batchId,
      sourceRowNumber: candidate.sourceRowNumber,
      shiftCode: normalized.shiftCode,
      version: normalized.version,
      status: normalized.status,
      createdAt: nowUtc
    });
    importedIds.push(importedId);
    importedItems.push({
      id: importedId,
      candidateRowId: candidate.candidateRowId,
      sourceRowNumber: candidate.sourceRowNumber,
      rowWitness
    });
    if (typeof input.options.afterInsertCandidate === 'function') {
      input.options.afterInsertCandidate({
        candidate,
        index,
        importedId,
        rowWitness,
        db: input.db
      });
    }
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

/** 在统一事务内插入班次定义候选；正式路径保持既有数据库写 helper。 */
function insertShiftDefinitionCandidates(input) {
  if (input.transactionScope) return insertManagedShiftDefinitionCandidates(input);
  const auditOptions = requireConfigurationImportAuditOptions(input.options);
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    const nowUtc = new Date().toISOString();
    if (candidate.status === 'active') deactivateSiblingVersions(input.db, 'shift_definitions', 'shift_code', candidate.shiftCode, null, nowUtc);
    const normalized = normalizeShiftDefinitionInput(candidate);
    const importedId = insertShiftDefinitionWithDb(input.db, normalized, nowUtc, {
      sourceBatchId: input.batchId,
      sourceRowNumber: candidate.sourceRowNumber
    });
    writeConfigurationImportAudit(input.db, auditOptions, {
      operation: 'energy.shift.configuration.import',
      targetType: 'shift_definition',
      targetId: importedId,
      detail: { batchId: input.batchId, sourceRowNumber: candidate.sourceRowNumber, shiftCode: candidate.shiftCode, version: candidate.version, status: candidate.status },
      createdAt: nowUtc
    });
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

/** 在统一事务内原子插入 TOU 方案与全部周期规则。 */
function insertTouSchemeCandidates(input) {
  const auditOptions = requireConfigurationImportAuditOptions(input.options);
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    const nowUtc = new Date().toISOString();
    if (candidate.status === 'active') deactivateSiblingVersions(input.db, 'tou_schemes', 'scheme_code', candidate.schemeCode, null, nowUtc);
    const normalized = normalizeTouSchemeInput(candidate);
    const importedId = insertTouSchemeWithDb(input.db, normalized, nowUtc);
    writeConfigurationImportAudit(input.db, auditOptions, {
      operation: 'energy.tou.configuration.import',
      targetType: 'tou_scheme',
      targetId: importedId,
      detail: { batchId: input.batchId, sourceRowNumber: candidate.sourceRowNumber, schemeCode: candidate.schemeCode, version: candidate.version, periodRuleCount: candidate.periodRules.length, status: candidate.status },
      createdAt: nowUtc
    });
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

/** 在 ownership 私有事务内插入受控策略规则，只保存配置且返回待登记 row witness。 */
function insertManagedStrategyRuleCandidates(input) {
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') {
      input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    }
    const nowUtc = new Date().toISOString();
    if (candidate.status === 'active') {
      deactivateStrategyRuleSiblingsInOwnershipTransaction({
        transactionScope: input.transactionScope,
        ruleCode: candidate.ruleCode,
        updatedAt: nowUtc
      });
    }
    const normalized = normalizeStrategyRuleInput(candidate);
    const insertSql = `INSERT INTO strategy_rules (
       source_batch_id, source_row_number,
       rule_code, rule_name, rule_version, formula_version, metric_code,
       threshold_operator, threshold_value, threshold_min, threshold_max,
       threshold_unit, reduction_rate, priority, evidence_requirements_json,
       recommendation_text, source, effective_start_utc, effective_end_utc,
       source_timezone, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertParams = [
      input.batchId,
      candidate.sourceRowNumber,
      normalized.ruleCode,
      normalized.ruleName,
      normalized.ruleVersion,
      normalized.formulaVersion,
      normalized.metricCode,
      normalized.thresholdOperator,
      normalized.thresholdValue,
      normalized.thresholdMin,
      normalized.thresholdMax,
      normalized.thresholdUnit,
      normalized.reductionRate,
      normalized.priority,
      normalized.evidenceRequirementsJson,
      normalized.recommendationText,
      normalized.source,
      normalized.effectiveStartUtc,
      normalized.effectiveEndUtc,
      normalized.sourceTimeZone,
      normalized.status,
      nowUtc,
      nowUtc
    ];
    const rowWitness = createDemoOwnershipInsertWitness({
      transactionScope: input.transactionScope,
      entityType: 'strategy_rule',
      insertParams,
      insertSql,
      sourceBatchId: input.batchId,
      sourceRowNumber: candidate.sourceRowNumber
    });
    const importedId = Number(rowWitness.lastInsertRowid);
    writeStrategyRuleImportAuditInOwnershipTransaction({
      transactionScope: input.transactionScope,
      actorUserId: input.options.actorUserId ?? input.options.demoContext?.userId,
      actorIp: input.options.actorIp ?? null,
      targetId: importedId,
      batchId: input.batchId,
      sourceRowNumber: candidate.sourceRowNumber,
      ruleCode: normalized.ruleCode,
      ruleVersion: normalized.ruleVersion,
      formulaVersion: normalized.formulaVersion,
      metricCode: normalized.metricCode,
      status: normalized.status,
      createdAt: nowUtc
    });
    importedIds.push(importedId);
    importedItems.push({
      id: importedId,
      candidateRowId: candidate.candidateRowId,
      sourceRowNumber: candidate.sourceRowNumber,
      rowWitness
    });
    if (typeof input.options.afterInsertCandidate === 'function') {
      input.options.afterInsertCandidate({ candidate, index, importedId, rowWitness, db: input.db });
    }
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

/** 在统一事务内插入受控策略规则；正式路径保持 NULL/NULL provenance 且不执行策略。 */
function insertStrategyRuleCandidates(input) {
  if (input.transactionScope) return insertManagedStrategyRuleCandidates(input);
  const auditOptions = requireConfigurationImportAuditOptions(input.options);
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    const nowUtc = new Date().toISOString();
    if (candidate.status === 'active') deactivateSiblingVersions(input.db, 'strategy_rules', 'rule_code', candidate.ruleCode, null, nowUtc);
    const normalized = normalizeStrategyRuleInput(candidate);
    const importedId = insertStrategyRuleWithDb(input.db, normalized, nowUtc);
    writeConfigurationImportAudit(input.db, auditOptions, {
      operation: 'energy.strategy.rule.configuration.import',
      targetType: 'strategy_rule',
      targetId: importedId,
      detail: { batchId: input.batchId, sourceRowNumber: candidate.sourceRowNumber, ruleCode: candidate.ruleCode, ruleVersion: candidate.ruleVersion, formulaVersion: candidate.formulaVersion, metricCode: candidate.metricCode, status: candidate.status },
      createdAt: nowUtc
    });
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

// 单批次底座使用的三类配置领域描述器。
const SHIFT_DEFINITION_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: SHIFT_DEFINITION_TEMPLATE_TYPE,
  buildPreview: buildShiftDefinitionImportPreview,
  insertCandidates: insertShiftDefinitionCandidates,
  demoOwnership: Object.freeze({
    artifactKey: '13-shift-definitions',
    batchRole: 'primary',
    entityType: 'shift_definition',
    expectedImportType: 'shift_definition'
  })
});
const TOU_SCHEME_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: TOU_SCHEME_TEMPLATE_TYPE,
  buildPreview: buildTouSchemeImportPreview,
  insertCandidates: insertTouSchemeCandidates
});
const STRATEGY_RULE_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: STRATEGY_RULE_TEMPLATE_TYPE,
  buildPreview: buildStrategyRuleImportPreview,
  insertCandidates: insertStrategyRuleCandidates,
  demoOwnership: Object.freeze({
    artifactKey: '18-strategy-rules',
    batchRole: 'primary',
    entityType: 'strategy_rule',
    expectedImportType: 'strategy_rule'
  })
});

/** 创建班次定义 preview 审计批次。 */
function previewShiftDefinitionImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, SHIFT_DEFINITION_IMPORT_DESCRIPTOR, options);
}

/** 执行班次定义受控导入。 */
async function executeShiftDefinitionImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, SHIFT_DEFINITION_IMPORT_DESCRIPTOR, options);
}

/** 创建 TOU 方案 preview 审计批次。 */
function previewTouSchemeImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, TOU_SCHEME_IMPORT_DESCRIPTOR, options);
}

/** 执行 TOU 方案受控导入。 */
async function executeTouSchemeImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, TOU_SCHEME_IMPORT_DESCRIPTOR, options);
}

/** 创建策略规则 preview 审计批次。 */
function previewStrategyRuleImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, STRATEGY_RULE_IMPORT_DESCRIPTOR, options);
}

/** 执行策略规则受控导入。 */
async function executeStrategyRuleImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, STRATEGY_RULE_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  SHIFT_DEFINITION_IMPORT_DESCRIPTOR,
  SHIFT_DEFINITION_TEMPLATE_TYPE,
  STRATEGY_RULE_IMPORT_DESCRIPTOR,
  STRATEGY_RULE_TEMPLATE_TYPE,
  TOU_SCHEME_IMPORT_DESCRIPTOR,
  TOU_SCHEME_TEMPLATE_TYPE,
  buildShiftDefinitionImportPreview,
  buildStrategyRuleImportPreview,
  buildTouSchemeImportPreview,
  executeShiftDefinitionImport,
  executeStrategyRuleImport,
  executeTouSchemeImport,
  insertShiftDefinitionCandidates,
  insertStrategyRuleCandidates,
  insertTouSchemeCandidates,
  previewShiftDefinitionImport,
  previewStrategyRuleImport,
  previewTouSchemeImport
};
