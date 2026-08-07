'use strict';

const crypto = require('crypto');
const {
  buildImportSummary,
  createImportIssue,
  stableSerialize
} = require('./energyAnalysisImportCore');
const {
  BENCHMARK_DIRECTIONS,
  CONVERSION_FACTOR_STATUSES,
  isIanaTimeZone,
  isStrictUtcIso
} = require('./energyAnalysisContracts');
const {
  getEnergyAnalysisTemplateDefinition,
  parseEnergyAnalysisTemplateBuffer
} = require('./energyAnalysisTemplateService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');

// 三类导入固定绑定已冻结模板，调用方不能替换 operation、recordKind 或 importType。
const ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE = 'energy-conversion-factors';
const ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE = 'energy-benchmark-definitions';
const ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE = 'energy-benchmark-targets';
// 当前 schema 与阶段 1 契约共同允许的记录状态。
const RECORD_STATUSES = Object.freeze([...CONVERSION_FACTOR_STATUSES]);
// 普通定义模板只允许外部标准和人工标杆，内部历史基准必须走固化领域流程。
const IMPORTABLE_BENCHMARK_TYPES = Object.freeze(['external_standard', 'manual_benchmark']);
// 当前 SQLite 主数据能够明确解析的三类对标适用范围。
const RESOLVABLE_BENCHMARK_SCOPE_TYPES = Object.freeze(['organization', 'energy', 'product']);
// 稳定版本标识沿用阶段 1 的 name:v1 冻结格式。
const VERSION_PATTERN = /^[a-z][a-z0-9-]*:v1$/;
// 三类单工作表模板与其固定中文工作表名称。
const TEMPLATE_SHEET_NAMES = Object.freeze({
  [ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE]: '能源折标系数',
  [ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE]: '对标定义',
  [ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE]: '对标目标'
});

/**
 * 判断导入值是否为空白。
 * @param {*} value 原始单元格值。
 * @returns {boolean} 是否为空白。
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 将导入值规范化为去除首尾空白的文本。
 * @param {*} value 原始值。
 * @returns {string} 规范化文本。
 */
function normalizeText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/**
 * 将可选有限数字规范化，空白返回 null。
 * @param {*} value 原始值。
 * @returns {number|null} 有限数字或 null。
 */
function normalizeOptionalNumber(value) {
  if (isBlank(value)) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * 解析模板布尔字段，空白按缺省 false 处理。
 * @param {*} value 原始值。
 * @returns {boolean|null} 合法布尔值或 null。
 */
function normalizeBoolean(value) {
  if (isBlank(value)) return false;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = normalizeText(value).toLocaleLowerCase('en-US');
  if (['1', 'true', 'yes', 'y', '是'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', '否'].includes(text)) return false;
  return null;
}

/**
 * 判断两个严格 UTC 左闭右开区间是否重叠。
 * @param {object} left 左区间。
 * @param {object} right 右区间。
 * @returns {boolean} 是否重叠。
 */
function intervalsOverlap(left, right) {
  return Date.parse(left.effectiveStartUtc) < Date.parse(right.effectiveEndUtc)
    && Date.parse(left.effectiveEndUtc) > Date.parse(right.effectiveStartUtc);
}

/**
 * 将缺失列产生的 undefined 原始值递归投影为可稳定序列化的 null。
 * @param {*} value 原始问题值。
 * @returns {*} 可进入统一导入问题的安全值。
 */
function normalizeIssueRawValue(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => normalizeIssueRawValue(item));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeIssueRawValue(item)]));
  }
  return value;
}

/**
 * 创建折标或对标导入问题。
 * @param {number} rowNumber 物理来源行号。
 * @param {string|null} fieldName 字段名称。
 * @param {*} rawValue 原始值。
 * @param {string} code 稳定问题码。
 * @param {string} message 中文说明。
 * @param {'error'|'warning'} severity 严重级别。
 * @returns {object} 标准导入问题。
 */
function createBenchmarkIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({ rowNumber, fieldName, rawValue: normalizeIssueRawValue(rawValue), code, message, severity });
}

/**
 * 将模板服务问题转换为统一导入问题。
 * @param {object} issue 模板问题。
 * @param {number} fallbackRowNumber 缺省行号。
 * @returns {object} 标准导入问题。
 */
function mapTemplateIssue(issue, fallbackRowNumber) {
  const rowNumber = Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
    ? issue.sourceRowNumber
    : fallbackRowNumber;
  return createBenchmarkIssue(
    rowNumber,
    issue.expectedKey || issue.key || issue.header || null,
    issue.values || issue.header || null,
    issue.code || 'ENERGY_BENCHMARK_TEMPLATE_STRUCTURE_INVALID',
    issue.message || '模板结构不符合冻结契约。',
    issue.severity === 'warning' ? 'warning' : 'error'
  );
}

/**
 * 合并字段映射并保留所有命中的原始标题。
 * @param {object} target 汇总字段映射。
 * @param {object} source 当前字段映射。
 */
function mergeFieldMapping(target, source) {
  Object.entries(source || {}).forEach(([key, headers]) => {
    const incomingHeaders = Array.isArray(headers) ? headers : [headers];
    target[key] = [...new Set([...(target[key] || []), ...incomingHeaders].filter(Boolean).map(String))];
  });
}

/**
 * 从同一安全 Buffer 通过统一模板服务解析冻结模板，保留原始标题数组、结构问题和物理行号。
 * @param {Buffer} buffer 安全读取的文件内容。
 * @param {string} originalFilename 原始文件名。
 * @param {string} templateType 冻结模板 ID。
 * @returns {{fileType:string,rows:object[],globalIssues:object[],fieldMapping:object}} 解析结果。
 */
function parseSingleSheetTemplateRows(buffer, originalFilename, templateType) {
  const parsed = parseEnergyAnalysisTemplateBuffer(templateType, buffer, originalFilename);
  const sheetName = TEMPLATE_SHEET_NAMES[templateType];
  const sheet = parsed.sheetsByName?.[sheetName] || null;
  const fieldMapping = {};
  const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
    mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
    return {
      sourceRowNumber: resolvedRow.sourceRowNumber,
      mapped: resolvedRow.record,
      issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, resolvedRow.sourceRowNumber || 2))
    };
  });
  const globalIssues = [
    ...(parsed.sheetCollection?.issues || []),
    ...(sheet?.headerIssues || [])
  ].map((issue) => mapTemplateIssue(issue, 1));
  return { fileType: parsed.fileType, rows, globalIssues, fieldMapping };
}

/**
 * 根据模板列定义生成缺失必填字段问题。
 * @param {string} templateType 模板 ID。
 * @param {object} mapped 模板映射记录。
 * @param {number} rowNumber 物理来源行号。
 * @returns {object[]} 必填字段问题。
 */
function validateRequiredFields(templateType, mapped, rowNumber) {
  return getEnergyAnalysisTemplateDefinition(templateType).sheets[0].columns
    .filter((column) => column.required && isBlank(mapped[column.key]))
    .map((column) => createBenchmarkIssue(
      rowNumber,
      column.key,
      mapped[column.key],
      'REQUIRED_FIELD_MISSING',
      `必填字段“${column.name}”不能为空。`
    ));
}

/**
 * 将全局模板问题附加到行，空文件时创建结构占位行。
 * @param {object[]} rows 行校验结果。
 * @param {object[]} globalIssues 全局模板问题。
 */
function appendGlobalIssues(rows, globalIssues) {
  if (globalIssues.length === 0) return;
  if (rows.length === 0) {
    rows.push({ rowNumber: 1, mapped: {}, issues: [...globalIssues], record: null, structuralOnly: true });
    return;
  }
  const errors = globalIssues.filter((issue) => issue.severity === 'error');
  const warnings = globalIssues.filter((issue) => issue.severity === 'warning');
  rows.forEach((row) => row.issues.push(...errors));
  rows[0].issues.push(...warnings);
}

/**
 * 将领域行结果投影为统一 preview。
 * @param {object} parsedRows 模板解析结果。
 * @param {object[]} rows 已完成查重和冲突判定的行。
 * @param {string[]} notices 领域提示。
 * @returns {object} 单批次底座可签名的 preview。
 */
function buildDomainPreview(parsedRows, rows, notices) {
  appendGlobalIssues(rows, parsedRows.globalIssues);
  const items = rows.map((row) => {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    return {
      rowNumber: row.rowNumber,
      sourceRowNumber: row.rowNumber,
      status: hasError ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport'),
      issues: row.issues,
      normalizedRecord: row.record,
      structuralOnly: row.structuralOnly === true
    };
  });
  const candidateRows = rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({ candidateRowId: buildCandidateRowId(row.record), ...row.record }));
  return {
    fileType: parsedRows.fileType,
    fieldMapping: parsedRows.fieldMapping,
    items,
    candidateRows,
    summary: buildImportSummary(items),
    auditIssues: items.flatMap((item) => item.issues || []),
    notices
  };
}

/**
 * 为规范化记录生成稳定候选 ID。
 * @param {object} record 规范化记录。
 * @returns {string} 稳定候选 ID。
 */
function buildCandidateRowId(record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `${record.recordKind}:${record.sourceRowNumber}:${digest}`;
}

/**
 * 为同文件后续完全重复行标记 skip。
 * @param {object} duplicateRow 重复行。
 * @param {object} originalRow 首条事实行。
 * @param {string} code 稳定 warning 码。
 * @param {string} label 业务名称。
 */
function markInputExactDuplicate(duplicateRow, originalRow, code, label) {
  duplicateRow.skipDuplicate = true;
  duplicateRow.issues.push(createBenchmarkIssue(
    duplicateRow.rowNumber,
    null,
    null,
    code,
    `输入文件第 ${duplicateRow.rowNumber} 行与第 ${originalRow.rowNumber} 行是完全相同的${label}，本行按 skip 策略跳过。`,
    'warning'
  ));
}

/**
 * 为冲突双方追加一次错误，并明确对应物理行。
 * @param {object} left 左行。
 * @param {object} right 右行。
 * @param {string} code 稳定错误码。
 * @param {string} messagePrefix 冲突说明。
 */
function markInputPairConflict(left, right, code, messagePrefix) {
  if (!left.issues.some((issue) => issue.code === code && issue.rawValue?.otherRow === right.rowNumber)) {
    left.issues.push(createBenchmarkIssue(left.rowNumber, null, { otherRow: right.rowNumber }, code, `${messagePrefix}：第 ${left.rowNumber} 行与第 ${right.rowNumber} 行冲突。`));
  }
  if (!right.issues.some((issue) => issue.code === code && issue.rawValue?.otherRow === left.rowNumber)) {
    right.issues.push(createBenchmarkIssue(right.rowNumber, null, { otherRow: left.rowNumber }, code, `${messagePrefix}：第 ${right.rowNumber} 行与第 ${left.rowNumber} 行冲突。`));
  }
}

/**
 * 判断两条折标系数事实是否完全相同。
 * @param {object} left 左事实。
 * @param {object} right 右事实。
 * @returns {boolean} 是否完全相同。
 */
function isExactConversionFactor(left, right) {
  return stableSerialize({
    factorCode: left.factorCode,
    energyTypeId: Number(left.energyTypeId),
    sourceUnit: normalizeText(left.sourceUnit).toLocaleLowerCase('en-US'),
    factorValue: Number(left.factorValue),
    targetUnit: left.targetUnit,
    displayUnit: left.displayUnit,
    displayDivisor: Number(left.displayDivisor),
    source: left.source,
    documentNo: left.documentNo,
    version: left.version,
    effectiveStartUtc: left.effectiveStartUtc,
    effectiveEndUtc: left.effectiveEndUtc,
    sourceTimeZone: left.sourceTimeZone,
    status: left.status
  }) === stableSerialize({
    factorCode: right.factorCode,
    energyTypeId: Number(right.energyTypeId),
    sourceUnit: normalizeText(right.sourceUnit).toLocaleLowerCase('en-US'),
    factorValue: Number(right.factorValue),
    targetUnit: right.targetUnit,
    displayUnit: right.displayUnit,
    displayDivisor: Number(right.displayDivisor),
    source: right.source,
    documentNo: right.documentNo,
    version: right.version,
    effectiveStartUtc: right.effectiveStartUtc,
    effectiveEndUtc: right.effectiveEndUtc,
    sourceTimeZone: right.sourceTimeZone,
    status: right.status
  });
}

/**
 * 校验单行折标系数并构造规范事实。
 * @param {object} row 模板映射行。
 * @param {Map} energyTypes 能源类型索引。
 * @returns {object} 行校验结果。
 */
function validateConversionFactorRow(row, energyTypes) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE, mapped, rowNumber)];
  const energyTypeCode = normalizeText(mapped.energyTypeCode);
  const energyType = energyTypes.get(energyTypeCode);
  const factorValue = normalizeOptionalNumber(mapped.factorValue);
  const displayDivisor = isBlank(mapped.displayDivisor) ? 1000 : normalizeOptionalNumber(mapped.displayDivisor);
  const status = normalizeText(mapped.status) || 'active';
  const targetUnit = normalizeText(mapped.targetUnit);
  const displayUnit = normalizeText(mapped.displayUnit) || 'tce';

  if (energyTypeCode && !energyType) issues.push(createBenchmarkIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_NOT_FOUND', '能源类型编码不存在，不会自动创建主数据。'));
  else if (energyType && Number(energyType.isActive) !== 1) issues.push(createBenchmarkIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_INACTIVE', '能源类型已停用。'));
  if (factorValue === null || factorValue <= 0) issues.push(createBenchmarkIssue(rowNumber, 'factorValue', mapped.factorValue, 'INVALID_FACTOR_VALUE', '折标系数值必须是有限正数。'));
  if (targetUnit !== 'kgce') issues.push(createBenchmarkIssue(rowNumber, 'targetUnit', mapped.targetUnit, 'INVALID_FACTOR_TARGET_UNIT', '折标目标单位必须是 kgce。'));
  if (displayUnit !== 'tce') issues.push(createBenchmarkIssue(rowNumber, 'displayUnit', mapped.displayUnit, 'INVALID_FACTOR_DISPLAY_UNIT', '展示单位必须是 tce。'));
  if (displayDivisor !== 1000) issues.push(createBenchmarkIssue(rowNumber, 'displayDivisor', mapped.displayDivisor, 'INVALID_FACTOR_DISPLAY_DIVISOR', '展示除数必须是 1000。'));
  if (!VERSION_PATTERN.test(normalizeText(mapped.version))) issues.push(createBenchmarkIssue(rowNumber, 'version', mapped.version, 'INVALID_FACTOR_VERSION', '版本必须使用 name:v1 格式。'));
  if (!RECORD_STATUSES.includes(status)) issues.push(createBenchmarkIssue(rowNumber, 'status', mapped.status, 'INVALID_FACTOR_STATUS', '状态仅支持 active 或 inactive。'));
  if (!isStrictUtcIso(normalizeText(mapped.effectiveStartUtc))) issues.push(createBenchmarkIssue(rowNumber, 'effectiveStartUtc', mapped.effectiveStartUtc, 'INVALID_EFFECTIVE_START_UTC', '生效开始时间必须是严格 UTC Z 格式。'));
  if (!isStrictUtcIso(normalizeText(mapped.effectiveEndUtc))) issues.push(createBenchmarkIssue(rowNumber, 'effectiveEndUtc', mapped.effectiveEndUtc, 'INVALID_EFFECTIVE_END_UTC', '生效结束时间必须是严格 UTC Z 格式。'));
  if (isStrictUtcIso(normalizeText(mapped.effectiveStartUtc)) && isStrictUtcIso(normalizeText(mapped.effectiveEndUtc))
    && Date.parse(mapped.effectiveStartUtc) >= Date.parse(mapped.effectiveEndUtc)) {
    issues.push(createBenchmarkIssue(rowNumber, 'effectiveStartUtc', { start: mapped.effectiveStartUtc, end: mapped.effectiveEndUtc }, 'INVALID_EFFECTIVE_RANGE', '有效期必须满足左闭右开且开始时间早于结束时间。'));
  }
  if (!isIanaTimeZone(normalizeText(mapped.sourceTimeZone))) issues.push(createBenchmarkIssue(rowNumber, 'sourceTimeZone', mapped.sourceTimeZone, 'INVALID_SOURCE_TIME_ZONE', '来源时区必须是有效 IANA 时区。'));

  const record = energyType ? {
    recordKind: 'energy-conversion-factor',
    sourceRowNumber: rowNumber,
    factorCode: normalizeText(mapped.factorCode),
    energyTypeId: energyType.id,
    energyTypeCode: energyType.code,
    sourceUnit: normalizeText(mapped.sourceUnit),
    factorValue,
    targetUnit,
    displayUnit,
    displayDivisor,
    source: normalizeText(mapped.source),
    documentNo: normalizeText(mapped.documentNo),
    version: normalizeText(mapped.version),
    effectiveStartUtc: normalizeText(mapped.effectiveStartUtc),
    effectiveEndUtc: normalizeText(mapped.effectiveEndUtc),
    sourceTimeZone: normalizeText(mapped.sourceTimeZone),
    status
  } : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 标记文件内折标系数完全重复、唯一键冲突和 active 有效期重叠。
 * @param {object[]} rows 折标行结果。
 */
function markInputConversionFactorConflicts(rows) {
  const comparable = rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error'));
  for (let leftIndex = 0; leftIndex < comparable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparable.length; rightIndex += 1) {
      const left = comparable[leftIndex];
      const right = comparable[rightIndex];
      if (isExactConversionFactor(left.record, right.record)) {
        markInputExactDuplicate(right, left, 'DUPLICATE_CONVERSION_FACTOR_SKIPPED', '折标系数事实');
        continue;
      }
      if (left.record.factorCode === right.record.factorCode && left.record.version === right.record.version) {
        markInputPairConflict(left, right, 'CONVERSION_FACTOR_UNIQUE_KEY_CONFLICT', '同一系数编码和版本存在非完全相同记录');
      }
      const sameScope = Number(left.record.energyTypeId) === Number(right.record.energyTypeId)
        && left.record.sourceUnit.toLocaleLowerCase('en-US') === right.record.sourceUnit.toLocaleLowerCase('en-US');
      if (sameScope && left.record.status === 'active' && right.record.status === 'active' && intervalsOverlap(left.record, right.record)) {
        markInputPairConflict(left, right, 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP', '同能源类型、同源单位的 active 有效期重叠');
      }
    }
  }
}

/**
 * 标记数据库折标系数完全重复或冲突。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 折标行结果。
 */
function markDatabaseConversionFactorConflicts(db, rows) {
  const selectByScope = db.prepare(`SELECT id, factor_code AS factorCode, energy_type_id AS energyTypeId,
    source_unit AS sourceUnit, factor_value AS factorValue, target_unit AS targetUnit, display_unit AS displayUnit,
    display_divisor AS displayDivisor, source, document_no AS documentNo, version,
    effective_start_utc AS effectiveStartUtc, effective_end_utc AS effectiveEndUtc,
    source_timezone AS sourceTimeZone, status
    FROM energy_conversion_factors
    WHERE (factor_code = ? AND version = ?)
       OR (energy_type_id = ? AND lower(trim(source_unit)) = ? AND status = 'active')
    ORDER BY id`);
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existingRows = selectByScope.all(
      row.record.factorCode,
      row.record.version,
      row.record.energyTypeId,
      row.record.sourceUnit.toLocaleLowerCase('en-US')
    );
    const exact = existingRows.find((existing) => isExactConversionFactor(existing, row.record));
    if (exact) {
      row.skipDuplicate = true;
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'factorCode', row.record.factorCode, 'DUPLICATE_CONVERSION_FACTOR_SKIPPED', `数据库记录 ${exact.id} 与当前折标系数完全相同，本行按 skip 策略跳过。`, 'warning'));
      return;
    }
    const uniqueConflict = existingRows.find((existing) => existing.factorCode === row.record.factorCode && existing.version === row.record.version);
    if (uniqueConflict) {
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'version', row.record.version, 'CONVERSION_FACTOR_UNIQUE_KEY_CONFLICT', `数据库记录 ${uniqueConflict.id} 已占用同一系数编码和版本。`));
      return;
    }
    const overlap = existingRows.find((existing) => existing.status === 'active' && row.record.status === 'active'
      && Number(existing.energyTypeId) === Number(row.record.energyTypeId)
      && normalizeText(existing.sourceUnit).toLocaleLowerCase('en-US') === row.record.sourceUnit.toLocaleLowerCase('en-US')
      && intervalsOverlap(existing, row.record));
    if (overlap) row.issues.push(createBenchmarkIssue(row.rowNumber, 'effectiveStartUtc', null, 'CONVERSION_FACTOR_ACTIVE_PERIOD_OVERLAP', `数据库 active 折标系数 ${overlap.id} 与当前候选有效期重叠。`));
  });
}

/**
 * 构建折标系数受控导入 preview。
 * @param {object} input 单批次底座输入。
 * @returns {object} 领域 preview。
 */
function buildEnergyConversionFactorImportPreview(input) {
  const parsedRows = parseSingleSheetTemplateRows(input.buffer, input.originalFilename, ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE);
  const energyTypes = new Map(input.db.prepare('SELECT id, code, is_active AS isActive FROM energy_types').all().map((row) => [String(row.code), row]));
  const rows = parsedRows.rows.map((row) => validateConversionFactorRow(row, energyTypes));
  markInputConversionFactorConflicts(rows);
  markDatabaseConversionFactorConflicts(input.db, rows);
  return buildDomainPreview(parsedRows, rows, [
    'preview 不写 energy_conversion_factors；execute 会从持久化批次重新读取原文件、重算并在事务内再次授权。',
    '完全相同系数按 skip 处理；同能源类型、同源单位的 active 有效期非完全重叠冲突会阻断。'
  ]);
}

/**
 * 在调用方事务内插入折标系数候选。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {object} 插入结果。
 */
function insertEnergyConversionFactorCandidates(input) {
  const statement = input.db.prepare(`INSERT INTO energy_conversion_factors (
    source_batch_id, source_row_number, factor_code, energy_type_id, source_unit, factor_value,
    target_unit, display_unit, display_divisor, source, document_no, version,
    effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return insertCandidates(input, statement, (candidate) => [
    input.batchId, candidate.sourceRowNumber, candidate.factorCode, candidate.energyTypeId,
    candidate.sourceUnit, candidate.factorValue, candidate.targetUnit, candidate.displayUnit,
    candidate.displayDivisor, candidate.source, candidate.documentNo, candidate.version,
    candidate.effectiveStartUtc, candidate.effectiveEndUtc, candidate.sourceTimeZone, candidate.status
  ]);
}

/**
 * 读取对标范围解析所需主数据索引。
 * @param {object} db SQLite 连接。
 * @returns {object} 组织、能源和产品索引。
 */
function loadBenchmarkScopeMasterData(db) {
  const organizations = new Map(db.prepare('SELECT unit_code AS reference, status FROM organization_units').all().map((row) => [String(row.reference), row]));
  const energyTypes = new Map(db.prepare('SELECT code AS reference, is_active AS isActive FROM energy_types').all().map((row) => [String(row.reference), row]));
  const products = new Map();
  db.prepare('SELECT unit_code AS unitCode, product_name AS productName, status FROM production_units').all().forEach((row) => {
    products.set(String(row.unitCode), row);
    products.set(String(row.productName), row);
  });
  return { organizations, energyTypes, products };
}

/**
 * 校验对标适用范围引用是否能由当前 schema 主数据解析。
 * @param {object} record 对标定义记录。
 * @param {object} masterData 范围主数据。
 * @param {object[]} issues 问题数组。
 */
function validateBenchmarkScope(record, masterData, issues) {
  if (!RESOLVABLE_BENCHMARK_SCOPE_TYPES.includes(record.scopeType)) {
    issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeType', record.scopeType, 'UNSUPPORTED_BENCHMARK_SCOPE_TYPE', '范围类型仅支持 organization、energy 或 product。'));
    return;
  }
  if (record.scopeType === 'organization') {
    const organization = masterData.organizations.get(record.scopeReference);
    if (!organization) issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_ORGANIZATION_SCOPE_NOT_FOUND', '组织范围标识不存在。'));
    else if (organization.status !== 'active') issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_ORGANIZATION_SCOPE_INACTIVE', '组织范围已停用。'));
  } else if (record.scopeType === 'energy') {
    const energyType = masterData.energyTypes.get(record.scopeReference);
    if (!energyType) issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_ENERGY_SCOPE_NOT_FOUND', '能源范围编码不存在。'));
    else if (Number(energyType.isActive) !== 1) issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_ENERGY_SCOPE_INACTIVE', '能源范围已停用。'));
  } else {
    const product = masterData.products.get(record.scopeReference);
    if (!product) issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_PRODUCT_SCOPE_NOT_FOUND', '产品范围标识无法由当前产能单元主数据解析。'));
    else if (product.status !== 'active') issues.push(createBenchmarkIssue(record.sourceRowNumber, 'scopeReference', record.scopeReference, 'BENCHMARK_PRODUCT_SCOPE_INACTIVE', '产品范围已停用。'));
  }
}

/**
 * 判断两条对标定义是否完全相同。
 * @param {object} left 左定义。
 * @param {object} right 右定义。
 * @returns {boolean} 是否完全相同。
 */
function isExactBenchmarkDefinition(left, right) {
  const project = (value) => ({
    benchmarkCode: value.benchmarkCode,
    benchmarkName: value.benchmarkName,
    benchmarkType: value.benchmarkType,
    metricCode: value.metricCode,
    unit: value.unit,
    periodType: value.periodType,
    scopeType: value.scopeType,
    scopeReference: value.scopeReference,
    direction: value.direction,
    source: value.source,
    documentNo: value.documentNo || null,
    version: value.version,
    effectiveStartUtc: value.effectiveStartUtc,
    effectiveEndUtc: value.effectiveEndUtc,
    sourceTimeZone: value.sourceTimeZone,
    status: value.status
  });
  return stableSerialize(project(left)) === stableSerialize(project(right));
}

/**
 * 校验单行对标定义并拒绝内部历史基准伪造。
 * @param {object} row 模板映射行。
 * @param {object} masterData 范围主数据。
 * @returns {object} 行校验结果。
 */
function validateBenchmarkDefinitionRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE, mapped, rowNumber)];
  const record = {
    recordKind: 'energy-benchmark-definition',
    sourceRowNumber: rowNumber,
    benchmarkCode: normalizeText(mapped.benchmarkCode),
    benchmarkName: normalizeText(mapped.benchmarkName),
    benchmarkType: normalizeText(mapped.benchmarkType),
    metricCode: normalizeText(mapped.metricCode),
    unit: normalizeText(mapped.unit),
    periodType: normalizeText(mapped.periodType),
    scopeType: normalizeText(mapped.scopeType),
    scopeReference: normalizeText(mapped.scopeReference),
    direction: normalizeText(mapped.direction),
    source: normalizeText(mapped.source),
    documentNo: normalizeText(mapped.documentNo) || null,
    version: normalizeText(mapped.version),
    effectiveStartUtc: normalizeText(mapped.effectiveStartUtc),
    effectiveEndUtc: normalizeText(mapped.effectiveEndUtc),
    sourceTimeZone: normalizeText(mapped.sourceTimeZone),
    status: normalizeText(mapped.status) || 'active'
  };

  if (!IMPORTABLE_BENCHMARK_TYPES.includes(record.benchmarkType)) {
    const code = record.benchmarkType === 'internal_history_baseline' ? 'INTERNAL_HISTORY_BENCHMARK_IMPORT_FORBIDDEN' : 'INVALID_BENCHMARK_TYPE';
    issues.push(createBenchmarkIssue(rowNumber, 'benchmarkType', mapped.benchmarkType, code, record.benchmarkType === 'internal_history_baseline'
      ? '普通模板禁止创建内部历史基准，必须由领域服务按参考期计算并固化。'
      : '对标类型仅支持 external_standard 或 manual_benchmark。'));
  }
  if (!BENCHMARK_DIRECTIONS.includes(record.direction)) issues.push(createBenchmarkIssue(rowNumber, 'direction', mapped.direction, 'INVALID_BENCHMARK_DIRECTION', '指标方向仅支持 lower_better、higher_better 或 range。'));
  if (!VERSION_PATTERN.test(record.version)) issues.push(createBenchmarkIssue(rowNumber, 'version', mapped.version, 'INVALID_BENCHMARK_VERSION', '版本必须使用 name:v1 格式。'));
  if (record.benchmarkType === 'external_standard' && !record.documentNo) issues.push(createBenchmarkIssue(rowNumber, 'documentNo', mapped.documentNo, 'MISSING_BENCHMARK_DOCUMENT_NO', '外部标准必须填写文号。'));
  if (!RECORD_STATUSES.includes(record.status)) issues.push(createBenchmarkIssue(rowNumber, 'status', mapped.status, 'INVALID_BENCHMARK_STATUS', '状态仅支持 active 或 inactive。'));
  if (!isStrictUtcIso(record.effectiveStartUtc)) issues.push(createBenchmarkIssue(rowNumber, 'effectiveStartUtc', mapped.effectiveStartUtc, 'INVALID_EFFECTIVE_START_UTC', '生效开始时间必须是严格 UTC Z 格式。'));
  if (!isStrictUtcIso(record.effectiveEndUtc)) issues.push(createBenchmarkIssue(rowNumber, 'effectiveEndUtc', mapped.effectiveEndUtc, 'INVALID_EFFECTIVE_END_UTC', '生效结束时间必须是严格 UTC Z 格式。'));
  if (isStrictUtcIso(record.effectiveStartUtc) && isStrictUtcIso(record.effectiveEndUtc)
    && Date.parse(record.effectiveStartUtc) >= Date.parse(record.effectiveEndUtc)) {
    issues.push(createBenchmarkIssue(rowNumber, 'effectiveStartUtc', null, 'INVALID_EFFECTIVE_RANGE', '有效期必须满足左闭右开且开始时间早于结束时间。'));
  }
  if (!isIanaTimeZone(record.sourceTimeZone)) issues.push(createBenchmarkIssue(rowNumber, 'sourceTimeZone', mapped.sourceTimeZone, 'INVALID_SOURCE_TIME_ZONE', '来源时区必须是有效 IANA 时区。'));
  validateBenchmarkScope(record, masterData, issues);
  return { rowNumber, mapped, issues, record };
}

/**
 * 标记文件内对标定义完全重复、唯一键冲突和 active 有效期重叠。
 * @param {object[]} rows 对标定义行结果。
 */
function markInputBenchmarkDefinitionConflicts(rows) {
  const comparable = rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error'));
  for (let leftIndex = 0; leftIndex < comparable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparable.length; rightIndex += 1) {
      const left = comparable[leftIndex];
      const right = comparable[rightIndex];
      if (isExactBenchmarkDefinition(left.record, right.record)) {
        markInputExactDuplicate(right, left, 'DUPLICATE_BENCHMARK_DEFINITION_SKIPPED', '对标定义');
        continue;
      }
      if (left.record.benchmarkCode === right.record.benchmarkCode && left.record.version === right.record.version) {
        markInputPairConflict(left, right, 'BENCHMARK_DEFINITION_UNIQUE_KEY_CONFLICT', '同一对标编码和版本存在非完全相同定义');
      }
      if (left.record.benchmarkCode === right.record.benchmarkCode
        && left.record.status === 'active' && right.record.status === 'active'
        && intervalsOverlap(left.record, right.record)) {
        markInputPairConflict(left, right, 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP', '同一对标编码的 active 定义有效期重叠');
      }
    }
  }
}

/**
 * 标记数据库对标定义完全重复或冲突。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 对标定义行结果。
 */
function markDatabaseBenchmarkDefinitionConflicts(db, rows) {
  const selectDefinitions = db.prepare(`SELECT id, benchmark_code AS benchmarkCode, benchmark_name AS benchmarkName,
    benchmark_type AS benchmarkType, metric_code AS metricCode, unit, period_type AS periodType,
    scope_type AS scopeType, scope_reference AS scopeReference, direction, source, document_no AS documentNo,
    version, effective_start_utc AS effectiveStartUtc, effective_end_utc AS effectiveEndUtc,
    source_timezone AS sourceTimeZone, status
    FROM benchmark_definitions
    WHERE benchmark_code = ?
    ORDER BY id`);
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existingRows = selectDefinitions.all(row.record.benchmarkCode);
    const exact = existingRows.find((existing) => isExactBenchmarkDefinition(existing, row.record));
    if (exact) {
      row.skipDuplicate = true;
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'benchmarkCode', row.record.benchmarkCode, 'DUPLICATE_BENCHMARK_DEFINITION_SKIPPED', `数据库定义 ${exact.id} 完全相同，本行按 skip 策略跳过。`, 'warning'));
      return;
    }
    const uniqueConflict = existingRows.find((existing) => existing.version === row.record.version);
    if (uniqueConflict) {
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'version', row.record.version, 'BENCHMARK_DEFINITION_UNIQUE_KEY_CONFLICT', `数据库定义 ${uniqueConflict.id} 已占用同一对标编码和版本。`));
      return;
    }
    const overlap = existingRows.find((existing) => existing.status === 'active' && row.record.status === 'active' && intervalsOverlap(existing, row.record));
    if (overlap) row.issues.push(createBenchmarkIssue(row.rowNumber, 'effectiveStartUtc', null, 'BENCHMARK_DEFINITION_ACTIVE_PERIOD_OVERLAP', `数据库 active 定义 ${overlap.id} 与当前候选有效期重叠。`));
  });
}

/**
 * 构建对标定义受控导入 preview。
 * @param {object} input 单批次底座输入。
 * @returns {object} 领域 preview。
 */
function buildEnergyBenchmarkDefinitionImportPreview(input) {
  const parsedRows = parseSingleSheetTemplateRows(input.buffer, input.originalFilename, ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE);
  const masterData = loadBenchmarkScopeMasterData(input.db);
  const rows = parsedRows.rows.map((row) => validateBenchmarkDefinitionRow(row, masterData));
  markInputBenchmarkDefinitionConflicts(rows);
  markDatabaseBenchmarkDefinitionConflicts(input.db, rows);
  return buildDomainPreview(parsedRows, rows, [
    'preview 不写 benchmark_definitions；普通模板只允许外部标准和人工标杆。',
    '完全相同定义按 skip 处理；业务唯一键或同编码 active 有效期冲突会阻断。'
  ]);
}

/**
 * 在调用方事务内插入对标定义候选。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {object} 插入结果。
 */
function insertEnergyBenchmarkDefinitionCandidates(input) {
  const statement = input.db.prepare(`INSERT INTO benchmark_definitions (
    source_batch_id, source_row_number, benchmark_code, benchmark_name, benchmark_type,
    metric_code, unit, period_type, scope_type, scope_reference, direction, source,
    document_no, version, effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return insertCandidates(input, statement, (candidate) => [
    input.batchId, candidate.sourceRowNumber, candidate.benchmarkCode, candidate.benchmarkName,
    candidate.benchmarkType, candidate.metricCode, candidate.unit, candidate.periodType,
    candidate.scopeType, candidate.scopeReference, candidate.direction, candidate.source,
    candidate.documentNo, candidate.version, candidate.effectiveStartUtc, candidate.effectiveEndUtc,
    candidate.sourceTimeZone, candidate.status
  ]);
}

/**
 * 判断两条对标目标是否完全相同。
 * @param {object} left 左目标。
 * @param {object} right 右目标。
 * @returns {boolean} 是否完全相同。
 */
function isExactBenchmarkTarget(left, right) {
  const project = (value) => ({
    benchmarkDefinitionId: Number(value.benchmarkDefinitionId),
    targetValue: value.targetValue === null ? null : Number(value.targetValue),
    lowerBound: value.lowerBound === null ? null : Number(value.lowerBound),
    upperBound: value.upperBound === null ? null : Number(value.upperBound),
    isFrozen: Number(value.isFrozen),
    autoRefresh: Number(value.autoRefresh),
    version: value.version,
    status: value.status
  });
  return stableSerialize(project(left)) === stableSerialize(project(right));
}

/**
 * 加载对标目标引用的定义索引。
 * @param {object} db SQLite 连接。
 * @returns {Map} 对标编码与版本复合索引。
 */
function loadBenchmarkDefinitions(db) {
  return new Map(db.prepare(`SELECT id, benchmark_code AS benchmarkCode, version, benchmark_type AS benchmarkType,
    direction, status FROM benchmark_definitions`).all().map((row) => [`${row.benchmarkCode} ${row.version}`, row]));
}

/**
 * 校验单行对标目标、方向值结构和内部历史伪造字段。
 * @param {object} row 模板映射行。
 * @param {Map} definitions 对标定义索引。
 * @returns {object} 行校验结果。
 */
function validateBenchmarkTargetRow(row, definitions) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE, mapped, rowNumber)];
  const benchmarkCode = normalizeText(mapped.benchmarkCode);
  const benchmarkVersion = normalizeText(mapped.benchmarkVersion);
  const definition = definitions.get(`${benchmarkCode} ${benchmarkVersion}`);
  const targetValue = normalizeOptionalNumber(mapped.targetValue);
  const lowerBound = normalizeOptionalNumber(mapped.lowerBound);
  const upperBound = normalizeOptionalNumber(mapped.upperBound);
  const isFrozen = normalizeBoolean(mapped.isFrozen);
  const autoRefresh = normalizeBoolean(mapped.autoRefresh);
  const status = normalizeText(mapped.status) || 'active';

  if (!definition) issues.push(createBenchmarkIssue(rowNumber, 'benchmarkCode', { benchmarkCode, benchmarkVersion }, 'BENCHMARK_DEFINITION_NOT_FOUND', '指定编码和版本的对标定义不存在。'));
  else if (definition.status !== 'active') issues.push(createBenchmarkIssue(rowNumber, 'benchmarkCode', { benchmarkCode, benchmarkVersion }, 'BENCHMARK_DEFINITION_INACTIVE', '指定对标定义已停用。'));
  if (definition?.benchmarkType === 'internal_history_baseline') issues.push(createBenchmarkIssue(rowNumber, 'benchmarkCode', benchmarkCode, 'INTERNAL_HISTORY_BENCHMARK_TARGET_IMPORT_FORBIDDEN', '内部历史基准目标必须由领域服务计算并固化，普通模板不得导入。'));

  if (definition && ['lower_better', 'higher_better'].includes(definition.direction)) {
    if (targetValue === null || lowerBound !== null || upperBound !== null) issues.push(createBenchmarkIssue(rowNumber, 'targetValue', { targetValue: mapped.targetValue, lowerBound: mapped.lowerBound, upperBound: mapped.upperBound }, 'INVALID_BENCHMARK_TARGET_VALUE_STRUCTURE', `${definition.direction} 方向必须且只能填写单一目标值。`));
  } else if (definition?.direction === 'range') {
    if (targetValue !== null || lowerBound === null || upperBound === null || lowerBound > upperBound) issues.push(createBenchmarkIssue(rowNumber, 'lowerBound', { targetValue: mapped.targetValue, lowerBound: mapped.lowerBound, upperBound: mapped.upperBound }, 'INVALID_BENCHMARK_TARGET_RANGE', 'range 方向必须只填写合法下限和上限，且下限不得大于上限。'));
  }
  const invalidTemplateNumber = (row.issues || []).some((issue) => issue.code === 'INVALID_TEMPLATE_CELL_TYPE'
    && ['targetValue', 'lowerBound', 'upperBound'].includes(issue.fieldName));
  if (invalidTemplateNumber
    || (!isBlank(mapped.targetValue) && targetValue === null)
    || (!isBlank(mapped.lowerBound) && lowerBound === null)
    || (!isBlank(mapped.upperBound) && upperBound === null)) {
    issues.push(createBenchmarkIssue(rowNumber, 'targetValue', null, 'INVALID_BENCHMARK_TARGET_NUMBER', '目标值和区间值必须是有限数字。'));
  }

  const internalFields = ['referenceStartUtc', 'referenceEndUtc', 'frozenValue', 'frozenAt', 'sampleCount', 'productionSummaryJson', 'sourceDataDigest'];
  const forgedFields = internalFields.filter((fieldName) => !isBlank(mapped[fieldName]));
  if (forgedFields.length > 0 || isFrozen === true || autoRefresh === true) {
    issues.push(createBenchmarkIssue(rowNumber, 'isFrozen', { fields: forgedFields, isFrozen: mapped.isFrozen, autoRefresh: mapped.autoRefresh }, 'BENCHMARK_INTERNAL_SNAPSHOT_FIELDS_FORBIDDEN', '普通目标模板不得填写内部参考期、固化值、数据摘要、样本或自动刷新字段。'));
  }
  if (isFrozen === null || autoRefresh === null) issues.push(createBenchmarkIssue(rowNumber, 'isFrozen', { isFrozen: mapped.isFrozen, autoRefresh: mapped.autoRefresh }, 'INVALID_BENCHMARK_TARGET_BOOLEAN', '是否固化和是否自动刷新仅支持 0/1 或等价布尔值。'));
  if (!VERSION_PATTERN.test(normalizeText(mapped.version))) issues.push(createBenchmarkIssue(rowNumber, 'version', mapped.version, 'INVALID_BENCHMARK_TARGET_VERSION', '目标版本必须使用 name:v1 格式。'));
  if (!RECORD_STATUSES.includes(status)) issues.push(createBenchmarkIssue(rowNumber, 'status', mapped.status, 'INVALID_BENCHMARK_STATUS', '状态仅支持 active 或 inactive。'));

  const record = definition ? {
    recordKind: 'energy-benchmark-target',
    sourceRowNumber: rowNumber,
    benchmarkDefinitionId: definition.id,
    benchmarkCode,
    benchmarkVersion,
    direction: definition.direction,
    targetValue,
    lowerBound,
    upperBound,
    referenceStartUtc: null,
    referenceEndUtc: null,
    frozenValue: null,
    frozenAt: null,
    sampleCount: null,
    productionSummaryJson: null,
    sourceDataDigest: null,
    isFrozen: 0,
    autoRefresh: 0,
    version: normalizeText(mapped.version),
    status
  } : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 标记文件内对标目标完全重复和定义版本唯一键冲突。
 * @param {object[]} rows 对标目标行结果。
 */
function markInputBenchmarkTargetConflicts(rows) {
  const comparable = rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error'));
  for (let leftIndex = 0; leftIndex < comparable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparable.length; rightIndex += 1) {
      const left = comparable[leftIndex];
      const right = comparable[rightIndex];
      if (isExactBenchmarkTarget(left.record, right.record)) {
        markInputExactDuplicate(right, left, 'DUPLICATE_BENCHMARK_TARGET_SKIPPED', '对标目标');
      } else if (Number(left.record.benchmarkDefinitionId) === Number(right.record.benchmarkDefinitionId)
        && left.record.version === right.record.version) {
        markInputPairConflict(left, right, 'BENCHMARK_TARGET_UNIQUE_KEY_CONFLICT', '同一对标定义和目标版本存在非完全相同目标');
      }
    }
  }
}

/**
 * 标记数据库对标目标完全重复或唯一键冲突。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 对标目标行结果。
 */
function markDatabaseBenchmarkTargetConflicts(db, rows) {
  const selectTargets = db.prepare(`SELECT id, benchmark_definition_id AS benchmarkDefinitionId,
    target_value AS targetValue, lower_bound AS lowerBound, upper_bound AS upperBound,
    is_frozen AS isFrozen, auto_refresh AS autoRefresh, version, status
    FROM benchmark_targets WHERE benchmark_definition_id = ? AND version = ? ORDER BY id`);
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existingRows = selectTargets.all(row.record.benchmarkDefinitionId, row.record.version);
    const exact = existingRows.find((existing) => isExactBenchmarkTarget(existing, row.record));
    if (exact) {
      row.skipDuplicate = true;
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'version', row.record.version, 'DUPLICATE_BENCHMARK_TARGET_SKIPPED', `数据库目标 ${exact.id} 完全相同，本行按 skip 策略跳过。`, 'warning'));
    } else if (existingRows.length > 0) {
      row.issues.push(createBenchmarkIssue(row.rowNumber, 'version', row.record.version, 'BENCHMARK_TARGET_UNIQUE_KEY_CONFLICT', `数据库目标 ${existingRows[0].id} 已占用同一对标定义和目标版本。`));
    }
  });
}

/**
 * 构建对标目标受控导入 preview。
 * @param {object} input 单批次底座输入。
 * @returns {object} 领域 preview。
 */
function buildEnergyBenchmarkTargetImportPreview(input) {
  const parsedRows = parseSingleSheetTemplateRows(input.buffer, input.originalFilename, ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE);
  const definitions = loadBenchmarkDefinitions(input.db);
  const rows = parsedRows.rows.map((row) => validateBenchmarkTargetRow(row, definitions));
  markInputBenchmarkTargetConflicts(rows);
  markDatabaseBenchmarkTargetConflicts(input.db, rows);
  return buildDomainPreview(parsedRows, rows, [
    'preview 不写 benchmark_targets；execute 插入时同时保存来源批次与物理行号。',
    '普通模板不得导入内部历史基准目标或伪造内部参考期、固化值和数据摘要。'
  ]);
}

/**
 * 在调用方事务内插入对标目标候选。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {object} 插入结果。
 */
function insertEnergyBenchmarkTargetCandidates(input) {
  const statement = input.db.prepare(`INSERT INTO benchmark_targets (
    source_batch_id, source_row_number, benchmark_definition_id, target_value, lower_bound,
    upper_bound, reference_start_utc, reference_end_utc, frozen_value, frozen_at, sample_count,
    production_summary_json, source_data_digest, is_frozen, auto_refresh, version, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return insertCandidates(input, statement, (candidate) => [
    input.batchId, candidate.sourceRowNumber, candidate.benchmarkDefinitionId, candidate.targetValue,
    candidate.lowerBound, candidate.upperBound, candidate.referenceStartUtc, candidate.referenceEndUtc,
    candidate.frozenValue, candidate.frozenAt, candidate.sampleCount, candidate.productionSummaryJson,
    candidate.sourceDataDigest, candidate.isFrozen, candidate.autoRefresh, candidate.version, candidate.status
  ]);
}

/**
 * 使用统一测试钩子插入一组候选并返回来源映射。
 * @param {object} input 单批次插入上下文。
 * @param {object} statement 已预编译 INSERT。
 * @param {Function} buildParameters 参数构建器。
 * @returns {object} 插入结果。
 */
function insertCandidates(input, statement, buildParameters) {
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    const result = statement.run(...buildParameters(candidate));
    const importedId = Number(result.lastInsertRowid);
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

// 折标系数单批次描述器。
const ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE,
  buildPreview: buildEnergyConversionFactorImportPreview,
  insertCandidates: insertEnergyConversionFactorCandidates
});
// 对标定义描述器使用 core 已冻结的 definitions 模板 operation/recordKind 绑定。
const ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE,
  buildPreview: buildEnergyBenchmarkDefinitionImportPreview,
  insertCandidates: insertEnergyBenchmarkDefinitionCandidates
});
// 对标目标描述器与定义描述器共享 importType，但 templateType/operation/recordKind 均不同。
const ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE,
  buildPreview: buildEnergyBenchmarkTargetImportPreview,
  insertCandidates: insertEnergyBenchmarkTargetCandidates
});

/** 创建折标系数 preview。 */
function previewEnergyConversionFactorImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, options);
}

/** 执行折标系数导入。 */
async function executeEnergyConversionFactorImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR, options);
}

/** 创建对标定义 preview。 */
function previewEnergyBenchmarkDefinitionImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR, options);
}

/** 执行对标定义导入。 */
async function executeEnergyBenchmarkDefinitionImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR, options);
}

/** 创建对标目标 preview。 */
function previewEnergyBenchmarkTargetImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR, options);
}

/** 执行对标目标导入。 */
async function executeEnergyBenchmarkTargetImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  ENERGY_BENCHMARK_DEFINITION_IMPORT_DESCRIPTOR,
  ENERGY_BENCHMARK_DEFINITION_TEMPLATE_TYPE,
  ENERGY_BENCHMARK_TARGET_IMPORT_DESCRIPTOR,
  ENERGY_BENCHMARK_TARGET_TEMPLATE_TYPE,
  ENERGY_CONVERSION_FACTOR_IMPORT_DESCRIPTOR,
  ENERGY_CONVERSION_FACTOR_TEMPLATE_TYPE,
  IMPORTABLE_BENCHMARK_TYPES,
  RESOLVABLE_BENCHMARK_SCOPE_TYPES,
  buildEnergyBenchmarkDefinitionImportPreview,
  buildEnergyBenchmarkTargetImportPreview,
  buildEnergyConversionFactorImportPreview,
  executeEnergyBenchmarkDefinitionImport,
  executeEnergyBenchmarkTargetImport,
  executeEnergyConversionFactorImport,
  insertEnergyBenchmarkDefinitionCandidates,
  insertEnergyBenchmarkTargetCandidates,
  insertEnergyConversionFactorCandidates,
  previewEnergyBenchmarkDefinitionImport,
  previewEnergyBenchmarkTargetImport,
  previewEnergyConversionFactorImport
};
