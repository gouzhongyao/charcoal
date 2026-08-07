'use strict';

const crypto = require('crypto');
const { badRequest } = require('../utils/errors');
const { parseImportBuffer } = require('./import/parser');
const { normalizeUnitAndValue } = require('./import/normalization');
const {
  buildImportSummary,
  createImportIssue,
  stableSerialize
} = require('./energyAnalysisImportCore');
const { validateTimeIntervalContract } = require('./energyAnalysisContracts');
const {
  getEnergyAnalysisTemplateDefinition,
  parseEnergyAnalysisTemplateWorkbook,
  resolveTemplateRow
} = require('./energyAnalysisTemplateService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');

// 时序能耗领域固定绑定冻结模板，不允许调用方切换到其他能源分析类型。
const ENERGY_TIMESERIES_TEMPLATE_TYPE = 'energy-timeseries';
// 时序事实的数据来源仅允许使用 schema 已冻结的三种来源。
const ENERGY_TIMESERIES_DATA_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);
// 时间区间契约错误的稳定中文说明。
const TIME_INTERVAL_ERROR_MESSAGES = Object.freeze({
  INVALID_START_UTC: '开始时间必须是严格 UTC Z 格式。',
  INVALID_END_UTC: '结束时间必须是严格 UTC Z 格式。',
  INVALID_SOURCE_TIME_ZONE: '来源时区必须是有效 IANA 时区。',
  UNSUPPORTED_GRANULARITY_MINUTES: '粒度仅支持 15、30 或 60 分钟。',
  INVALID_HALF_OPEN_RANGE: '时间区间必须满足左闭右开且开始时间早于结束时间。',
  INTERVAL_BOUNDARY_NOT_WHOLE_MINUTE: '时间区间边界必须落在整分钟。',
  INTERVAL_DURATION_MISMATCH: '区间持续时间必须与粒度完全一致。'
});
// 时间区间错误对应的模板字段名称。
const TIME_INTERVAL_ERROR_FIELDS = Object.freeze({
  INVALID_START_UTC: 'startUtc',
  INVALID_END_UTC: 'endUtc',
  INVALID_SOURCE_TIME_ZONE: 'sourceTimeZone',
  UNSUPPORTED_GRANULARITY_MINUTES: 'granularityMinutes',
  INVALID_HALF_OPEN_RANGE: 'startUtc',
  INTERVAL_BOUNDARY_NOT_WHOLE_MINUTE: 'startUtc',
  INTERVAL_DURATION_MISMATCH: 'granularityMinutes'
});

/**
 * 判断导入单元格是否为空白。
 * @param {*} value 原始单元格值。
 * @returns {boolean} 是否为空白。
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 将单元格规范化为去除首尾空白的文本。
 * @param {*} value 原始值。
 * @returns {string} 规范化文本。
 */
function normalizeText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/**
 * 创建时序导入行级问题。
 * @param {number} rowNumber 物理来源行号。
 * @param {string|null} fieldName 字段名称。
 * @param {*} rawValue 原始值。
 * @param {string} code 稳定错误码。
 * @param {string} message 中文说明。
 * @param {'error'|'warning'} severity 严重级别。
 * @returns {object} 标准问题对象。
 */
function createTimeseriesIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({ rowNumber, fieldName, rawValue, code, message, severity });
}

/**
 * 将模板服务结构问题转换为统一导入问题。
 * @param {object} issue 模板结构问题。
 * @param {number} fallbackRowNumber 缺省物理行号。
 * @returns {object} 标准问题对象。
 */
function mapTemplateIssue(issue, fallbackRowNumber) {
  const rowNumber = Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
    ? issue.sourceRowNumber
    : fallbackRowNumber;
  const fieldName = issue.expectedKey || issue.key || issue.header || null;
  return createTimeseriesIssue(
    rowNumber,
    fieldName,
    issue.values || issue.header || null,
    issue.code || 'ENERGY_TIMESERIES_TEMPLATE_STRUCTURE_INVALID',
    issue.message || '模板结构不符合冻结契约。',
    issue.severity === 'warning' ? 'warning' : 'error'
  );
}

/**
 * 合并字段映射并保留每个内部字段命中的全部原始标题。
 * @param {object} target 汇总字段映射。
 * @param {object} source 当前行字段映射。
 */
function mergeFieldMapping(target, source) {
  Object.entries(source || {}).forEach(([key, headers]) => {
    const currentHeaders = target[key] || [];
    const incomingHeaders = Array.isArray(headers) ? headers : [headers];
    target[key] = [...new Set([...currentHeaders, ...incomingHeaders].filter(Boolean).map(String))];
  });
}

/**
 * 扫描已由中央解析器验证过的 CSV，仅补充每条非空记录的物理起始行号，不参与字段解析。
 * @param {Buffer} buffer 已验证 UTF-8 CSV Buffer。
 * @returns {number[]} 不含表头的物理数据行号。
 */
function getCsvPhysicalDataRowNumbers(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const recordStartLines = [];
  let recordStartIndex = 0;
  let recordStartLine = 1;
  let currentLine = 1;
  let inQuotes = false;

  const appendRecord = (endIndex) => {
    if (text.slice(recordStartIndex, endIndex).trim() !== '') {
      recordStartLines.push(recordStartLine);
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    const isLineFeed = character === '\n';
    const isBareCarriageReturn = character === '\r' && text[index + 1] !== '\n';
    if (!isLineFeed && !isBareCarriageReturn) continue;
    if (!inQuotes) {
      const endIndex = isLineFeed && index > 0 && text[index - 1] === '\r' ? index - 1 : index;
      appendRecord(endIndex);
      recordStartIndex = index + 1;
      recordStartLine = currentLine + 1;
    }
    currentLine += 1;
  }
  if (recordStartIndex < text.length) appendRecord(text.length);
  return recordStartLines.slice(1);
}

/**
 * 从同一中央解析 Buffer 生成带物理行号的模板映射结果。
 * @param {Buffer} buffer 已安全读取的文件 Buffer。
 * @param {string} originalFilename 原始文件名。
 * @returns {{fileType:string,rows:object[],globalIssues:object[],fieldMapping:object}} 模板解析结果。
 */
function parseEnergyTimeseriesRows(buffer, originalFilename) {
  const parsed = parseImportBuffer(buffer, originalFilename);
  const definition = getEnergyAnalysisTemplateDefinition(ENERGY_TIMESERIES_TEMPLATE_TYPE);
  if (!definition.formats.includes(parsed.fileType)) {
    throw badRequest('时序能耗冻结模板仅支持 .xlsx 或 .csv 文件。', {
      code: 'ENERGY_TIMESERIES_TEMPLATE_FILE_TYPE_UNSUPPORTED',
      fileType: parsed.fileType,
      supportedFileTypes: [...definition.formats]
    });
  }
  const fieldMapping = {};
  if (parsed.fileType === 'xlsx') {
    const workbookResult = parseEnergyAnalysisTemplateWorkbook(ENERGY_TIMESERIES_TEMPLATE_TYPE, buffer);
    const sheet = workbookResult.sheetsByName?.['能耗时序'] || null;
    const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
      mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
      return {
        sourceRowNumber: resolvedRow.sourceRowNumber,
        mapped: resolvedRow.record,
        issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, resolvedRow.sourceRowNumber || 2))
      };
    });
    const globalIssues = [
      ...(workbookResult.sheetCollection?.issues || []),
      ...(sheet?.headerIssues || [])
    ].map((issue) => mapTemplateIssue(issue, 1));
    return { fileType: parsed.fileType, rows, globalIssues, fieldMapping };
  }

  const physicalRowNumbers = getCsvPhysicalDataRowNumbers(buffer);
  const rows = parsed.rows.map((row, index) => {
    const sourceRowNumber = physicalRowNumbers.length === parsed.rows.length
      ? physicalRowNumbers[index]
      : index + 2;
    const resolvedRow = resolveTemplateRow(ENERGY_TIMESERIES_TEMPLATE_TYPE, row, { sourceRowNumber });
    mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
    return {
      sourceRowNumber,
      mapped: resolvedRow.record,
      issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, sourceRowNumber))
    };
  });
  return { fileType: parsed.fileType, rows, globalIssues: [], fieldMapping };
}

/**
 * 读取并缓存时序导入需要的组织、能源类型和表计主数据。
 * @param {object} db SQLite 连接。
 * @returns {object} 三类主数据编码索引。
 */
function loadTimeseriesMasterData(db) {
  const organizations = new Map(db.prepare(
    `SELECT id, unit_code AS code, unit_name AS name, status
     FROM organization_units`
  ).all().map((row) => [String(row.code), row]));
  const energyTypes = new Map(db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive
     FROM energy_types`
  ).all().map((row) => [String(row.code), row]));
  const meters = new Map(db.prepare(
    `SELECT id, meter_code AS code, meter_name AS name, energy_type_id AS energyTypeId,
            organization_unit_id AS organizationUnitId, status
     FROM meter_devices`
  ).all().map((row) => [String(row.code), row]));
  return { organizations, energyTypes, meters };
}

/**
 * 根据模板冻结列定义补齐必填字段错误。
 * @param {object} mapped 模板映射记录。
 * @param {number} rowNumber 物理来源行号。
 * @returns {object[]} 缺失字段问题。
 */
function validateRequiredFields(mapped, rowNumber) {
  const definition = getEnergyAnalysisTemplateDefinition(ENERGY_TIMESERIES_TEMPLATE_TYPE);
  const columns = definition.sheets[0].columns;
  return columns
    .filter((column) => column.required && isBlank(mapped[column.key]))
    .map((column) => createTimeseriesIssue(
      rowNumber,
      column.key,
      mapped[column.key],
      'REQUIRED_FIELD_MISSING',
      `必填字段“${column.name}”不能为空。`
    ));
}

/**
 * 将时间契约错误转换为逐字段问题。
 * @param {object} mapped 模板映射记录。
 * @param {number} rowNumber 物理来源行号。
 * @param {number|null} granularityMinutes 已解析粒度。
 * @returns {object[]} 时间区间问题。
 */
function validateTimeseriesInterval(mapped, rowNumber, granularityMinutes) {
  const validation = validateTimeIntervalContract({
    startUtc: normalizeText(mapped.startUtc),
    endUtc: normalizeText(mapped.endUtc),
    sourceTimeZone: normalizeText(mapped.sourceTimeZone),
    granularityMinutes
  });
  return validation.errors.map((code) => {
    const fieldName = TIME_INTERVAL_ERROR_FIELDS[code] || null;
    return createTimeseriesIssue(
      rowNumber,
      fieldName,
      fieldName ? mapped[fieldName] : null,
      code,
      TIME_INTERVAL_ERROR_MESSAGES[code] || '时间区间不符合冻结契约。'
    );
  });
}

/**
 * 校验单行主数据、时间、数值、单位和来源，并生成可比较事实记录。
 * @param {object} row 模板映射行。
 * @param {object} masterData 主数据索引。
 * @returns {object} 行校验结果。
 */
function validateTimeseriesRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(mapped, rowNumber)];
  const organizationCode = normalizeText(mapped.organizationUnitCode);
  const energyTypeCode = normalizeText(mapped.energyTypeCode);
  const meterCode = normalizeText(mapped.meterCode);
  const originalUnit = normalizeText(mapped.originalUnit);
  const sourceReference = normalizeText(mapped.sourceReference);
  const dataSource = normalizeText(mapped.dataSource) || 'upload';
  const organization = organizationCode ? masterData.organizations.get(organizationCode) : null;
  const energyType = energyTypeCode ? masterData.energyTypes.get(energyTypeCode) : null;
  const meter = meterCode ? masterData.meters.get(meterCode) : null;

  if (organizationCode && !organization) {
    issues.push(createTimeseriesIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_NOT_FOUND', '用能单元编码不存在，不会自动创建主数据。'));
  } else if (organization && organization.status !== 'active') {
    issues.push(createTimeseriesIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_INACTIVE', '用能单元已停用。'));
  }
  if (energyTypeCode && !energyType) {
    issues.push(createTimeseriesIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_NOT_FOUND', '能源类型编码不存在，不会自动创建主数据。'));
  } else if (energyType && Number(energyType.isActive) !== 1) {
    issues.push(createTimeseriesIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_INACTIVE', '能源类型已停用。'));
  }
  if (meterCode && !meter) {
    issues.push(createTimeseriesIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_DEVICE_NOT_FOUND', '计量器具编码不存在，不会自动创建主数据。'));
  } else if (meter && meter.status !== 'active') {
    issues.push(createTimeseriesIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_DEVICE_INACTIVE', '计量器具已停用。'));
  }
  if (meter && energyType && Number(meter.energyTypeId) !== Number(energyType.id)) {
    issues.push(createTimeseriesIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_ENERGY_TYPE_MISMATCH', '计量器具与能源类型口径不兼容。'));
  }
  if (meter && organization && Number(meter.organizationUnitId) !== Number(organization.id)) {
    issues.push(createTimeseriesIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_ORGANIZATION_MISMATCH', '计量器具与用能单元口径不兼容。'));
  }

  const granularityMinutes = isBlank(mapped.granularityMinutes) ? null : Number(mapped.granularityMinutes);
  issues.push(...validateTimeseriesInterval(mapped, rowNumber, granularityMinutes));

  const originalValue = isBlank(mapped.originalValue) ? null : Number(mapped.originalValue);
  if (!isBlank(mapped.originalValue) && (!Number.isFinite(originalValue) || originalValue < 0)) {
    issues.push(createTimeseriesIssue(rowNumber, 'originalValue', mapped.originalValue, 'INVALID_ORIGINAL_VALUE', '原始值必须是有限且大于等于 0 的数字。'));
  }

  let normalized = null;
  if (energyType && originalUnit && Number.isFinite(originalValue) && originalValue >= 0) {
    normalized = normalizeUnitAndValue(energyType.code, originalUnit, originalValue);
    if (!normalized) {
      issues.push(createTimeseriesIssue(rowNumber, 'originalUnit', mapped.originalUnit, 'UNSUPPORTED_UNIT', '原始单位无法按该能源类型标准化。'));
    } else if (normalized.normalizedUnit !== energyType.standardUnit) {
      issues.push(createTimeseriesIssue(rowNumber, 'originalUnit', mapped.originalUnit, 'ENERGY_STANDARD_UNIT_MISMATCH', '单位标准化结果与能源类型标准单位不一致。'));
    }
  }
  if (!ENERGY_TIMESERIES_DATA_SOURCES.includes(dataSource)) {
    issues.push(createTimeseriesIssue(rowNumber, 'dataSource', mapped.dataSource, 'INVALID_DATA_SOURCE', '数据来源仅支持 manual、upload 或 calculation。'));
  }
  if (!sourceReference && !isBlank(mapped.sourceReference)) {
    issues.push(createTimeseriesIssue(rowNumber, 'sourceReference', mapped.sourceReference, 'INVALID_SOURCE_REFERENCE', '来源标识不能为空白。'));
  }

  const record = energyType && (!organizationCode || organization) && (!meterCode || meter) && normalized
    ? {
      sourceRowNumber: rowNumber,
      organizationUnitId: organization ? organization.id : null,
      organizationUnitCode: organizationCode || null,
      meterDeviceId: meter ? meter.id : null,
      meterCode: meterCode || null,
      energyTypeId: energyType.id,
      energyTypeCode: energyType.code,
      startUtc: normalizeText(mapped.startUtc),
      endUtc: normalizeText(mapped.endUtc),
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
      granularityMinutes,
      originalUnit,
      originalValue,
      normalizedUnit: normalized.normalizedUnit,
      normalizedValue: normalized.normalizedValue,
      sourceReference,
      dataSource,
      recordStatus: 'active'
    }
    : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 判断两个左闭右开区间是否相交。
 * @param {object} left 左区间记录。
 * @param {object} right 右区间记录。
 * @returns {boolean} 是否相交。
 */
function intervalsOverlap(left, right) {
  return Date.parse(left.startUtc) < Date.parse(right.endUtc)
    && Date.parse(left.endUtc) > Date.parse(right.startUtc);
}

/**
 * 构造同一时序数据流的稳定键，原始单位不同的事实不会直接视为同流。
 * @param {object} record 时序事实记录。
 * @returns {string} 数据流键。
 */
function buildTimeseriesStreamKey(record) {
  return stableSerialize({
    organizationUnitId: record.organizationUnitId,
    meterDeviceId: record.meterDeviceId,
    energyTypeId: record.energyTypeId,
    originalUnit: record.originalUnit.toLocaleLowerCase('en-US')
  });
}

/**
 * 为问题列表追加一次去重后的来源重叠错误。
 * @param {object} item 行校验结果。
 * @param {string} message 中文说明。
 */
function appendOverlapIssue(item, message) {
  if (item.issues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE')) return;
  item.issues.push(createTimeseriesIssue(
    item.rowNumber,
    'startUtc',
    { startUtc: item.record?.startUtc, endUtc: item.record?.endUtc },
    'SOURCE_OVERLAP_OR_DUPLICATE',
    message
  ));
}

/**
 * 对输入文件内部所有同流区间执行成对检测，并阻断全部参与重复或重叠的行。
 * @param {object[]} rows 行校验结果。
 */
function markInputOverlaps(rows) {
  const comparableRows = rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error'));
  for (let leftIndex = 0; leftIndex < comparableRows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparableRows.length; rightIndex += 1) {
      const left = comparableRows[leftIndex];
      const right = comparableRows[rightIndex];
      if (buildTimeseriesStreamKey(left.record) !== buildTimeseriesStreamKey(right.record)) continue;
      if (!intervalsOverlap(left.record, right.record)) continue;
      appendOverlapIssue(left, `输入文件第 ${left.rowNumber} 行与第 ${right.rowNumber} 行在同一数据流中重复或区间重叠。`);
      appendOverlapIssue(right, `输入文件第 ${right.rowNumber} 行与第 ${left.rowNumber} 行在同一数据流中重复或区间重叠。`);
    }
  }
}

/**
 * 判断数据库事实与候选事实是否完全相同，来源批次与来源行号不参与事实等价。
 * @param {object} existing 数据库 active 事实。
 * @param {object} candidate 当前候选事实。
 * @returns {boolean} 是否完全相同。
 */
function isExactTimeseriesFact(existing, candidate) {
  return Number(existing.organizationUnitId ?? 0) === Number(candidate.organizationUnitId ?? 0)
    && Number(existing.meterDeviceId ?? 0) === Number(candidate.meterDeviceId ?? 0)
    && Number(existing.energyTypeId) === Number(candidate.energyTypeId)
    && Date.parse(existing.startUtc) === Date.parse(candidate.startUtc)
    && Date.parse(existing.endUtc) === Date.parse(candidate.endUtc)
    && existing.sourceTimeZone === candidate.sourceTimeZone
    && Number(existing.granularityMinutes) === Number(candidate.granularityMinutes)
    && normalizeText(existing.originalUnit).toLocaleLowerCase('en-US') === candidate.originalUnit.toLocaleLowerCase('en-US')
    && Number(existing.originalValue) === Number(candidate.originalValue)
    && existing.normalizedUnit === candidate.normalizedUnit
    && Number(existing.normalizedValue) === Number(candidate.normalizedValue)
    && existing.sourceReference === candidate.sourceReference
    && existing.dataSource === candidate.dataSource;
}

/**
 * 查询数据库 active 同流重叠，并按完全相同 skip、其他重叠 block 处理。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 行校验结果。
 */
function markDatabaseDuplicatesAndOverlaps(db, rows) {
  const selectOverlaps = db.prepare(
    `SELECT id,
            organization_unit_id AS organizationUnitId,
            meter_device_id AS meterDeviceId,
            energy_type_id AS energyTypeId,
            start_utc AS startUtc,
            end_utc AS endUtc,
            source_timezone AS sourceTimeZone,
            granularity_minutes AS granularityMinutes,
            original_unit AS originalUnit,
            original_value AS originalValue,
            normalized_unit AS normalizedUnit,
            normalized_value AS normalizedValue,
            source_reference AS sourceReference,
            data_source AS dataSource
     FROM energy_timeseries_records
     WHERE record_status = 'active'
       AND organization_unit_id IS ?
       AND meter_device_id IS ?
       AND energy_type_id = ?
       AND lower(trim(original_unit)) = ?
       AND start_utc < ?
       AND end_utc > ?
     ORDER BY id ASC`
  );
  rows.forEach((row) => {
    if (!row.record || row.issues.some((issue) => issue.severity === 'error')) return;
    const overlaps = selectOverlaps.all(
      row.record.organizationUnitId,
      row.record.meterDeviceId,
      row.record.energyTypeId,
      row.record.originalUnit.toLocaleLowerCase('en-US'),
      row.record.endUtc,
      row.record.startUtc
    );
    if (overlaps.length === 0) return;
    const nonExactOverlap = overlaps.find((existing) => !isExactTimeseriesFact(existing, row.record));
    if (nonExactOverlap) {
      appendOverlapIssue(row, `数据库 active 记录 ${nonExactOverlap.id} 与当前候选在同一数据流中区间重叠。`);
      return;
    }
    row.skipDuplicate = true;
    row.issues.push(createTimeseriesIssue(
      row.rowNumber,
      'startUtc',
      { startUtc: row.record.startUtc, endUtc: row.record.endUtc },
      'DUPLICATE_TIMESERIES_RECORD_SKIPPED',
      '数据库已存在完全相同的 active 时序事实，本行按 skip 策略跳过。',
      'warning'
    ));
  });
}

/**
 * 为可导入事实生成稳定候选 ID。
 * @param {object} record 规范化时序事实。
 * @returns {string} 候选 ID。
 */
function buildCandidateRowId(record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `energy-timeseries:${record.sourceRowNumber}:${digest}`;
}

/**
 * 构建时序能耗领域 preview；调用方必须提供已安全读取的同一 Buffer。
 * @param {object} input Buffer、数据库与原始文件上下文。
 * @returns {object} 统一 preview 领域结果。
 */
function buildEnergyTimeseriesImportPreview(input) {
  const parsedRows = parseEnergyTimeseriesRows(input.buffer, input.originalFilename);
  const masterData = loadTimeseriesMasterData(input.db);
  const rows = parsedRows.rows.map((row) => validateTimeseriesRow(row, masterData));

  if (parsedRows.globalIssues.length > 0) {
    if (rows.length > 0) {
      const blockingGlobalIssues = parsedRows.globalIssues.filter((issue) => issue.severity === 'error');
      const warningGlobalIssues = parsedRows.globalIssues.filter((issue) => issue.severity === 'warning');
      rows.forEach((row) => row.issues.push(...blockingGlobalIssues));
      rows[0].issues.push(...warningGlobalIssues);
    } else {
      rows.push({
        rowNumber: 1,
        mapped: {},
        issues: [...parsedRows.globalIssues],
        record: null,
        structuralOnly: true
      });
    }
  }
  markInputOverlaps(rows);
  markDatabaseDuplicatesAndOverlaps(input.db, rows);

  const items = rows.map((row) => {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    const status = hasError ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport');
    return {
      rowNumber: row.rowNumber,
      sourceRowNumber: row.rowNumber,
      status,
      issues: row.issues,
      normalizedRecord: row.record,
      structuralOnly: row.structuralOnly === true
    };
  });
  const candidateRows = rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({
      candidateRowId: buildCandidateRowId(row.record),
      ...row.record
    }));
  const summary = buildImportSummary(items);
  const auditIssues = items.flatMap((item) => item.issues || []);
  return {
    fileType: parsedRows.fileType,
    fieldMapping: parsedRows.fieldMapping,
    items,
    candidateRows,
    summary,
    auditIssues,
    notices: [
      'preview 不写 energy_timeseries_records；execute 将从持久化批次找回原文件并重新解析、查重和查重叠。',
      '时序事实采用左闭右开区间；完全重复按 skip 处理，其他同流 active 重叠阻断。'
    ]
  };
}

/**
 * 在调用方 SQLite 事务内插入已复核的时序候选事实。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {{imported:number,importedIds:number[],importedItems:object[]}} 插入结果。
 */
function insertEnergyTimeseriesCandidates(input) {
  const insertRecord = input.db.prepare(
    `INSERT INTO energy_timeseries_records (
       source_batch_id,
       source_row_number,
       organization_unit_id,
       meter_device_id,
       energy_type_id,
       start_utc,
       end_utc,
       source_timezone,
       granularity_minutes,
       original_unit,
       original_value,
       normalized_unit,
       normalized_value,
       source_reference,
       data_source,
       record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  );
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') {
      input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    }
    const result = insertRecord.run(
      input.batchId,
      candidate.sourceRowNumber,
      candidate.organizationUnitId,
      candidate.meterDeviceId,
      candidate.energyTypeId,
      candidate.startUtc,
      candidate.endUtc,
      candidate.sourceTimeZone,
      candidate.granularityMinutes,
      candidate.originalUnit,
      candidate.originalValue,
      candidate.normalizedUnit,
      candidate.normalizedValue,
      candidate.sourceReference,
      candidate.dataSource
    );
    const importedId = Number(result.lastInsertRowid);
    importedIds.push(importedId);
    importedItems.push({
      id: importedId,
      candidateRowId: candidate.candidateRowId,
      sourceRowNumber: candidate.sourceRowNumber
    });
    if (typeof input.options.afterInsertCandidate === 'function') {
      input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
    }
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

// 单批次底座使用的时序领域描述器。
const ENERGY_TIMESERIES_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: ENERGY_TIMESERIES_TEMPLATE_TYPE,
  buildPreview: buildEnergyTimeseriesImportPreview,
  insertCandidates: insertEnergyTimeseriesCandidates
});

/**
 * 从 Multer 已落盘原文件创建时序能耗 preview 审计批次。
 * @param {object} file Multer 文件对象。
 * @param {object} options 可注入数据库、上传目录和密钥读写器。
 * @returns {object} 安全 preview。
 */
function previewEnergyTimeseriesImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, ENERGY_TIMESERIES_IMPORT_DESCRIPTOR, options);
}

/**
 * 依据持久化 batchId 执行时序能耗导入。
 * @param {object} body 固定确认、文件和候选见证。
 * @param {object} options 可注入数据库、上传目录、备份和密钥读写器。
 * @returns {Promise<object>} execute 结果。
 */
async function executeEnergyTimeseriesImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, ENERGY_TIMESERIES_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  ENERGY_TIMESERIES_DATA_SOURCES,
  ENERGY_TIMESERIES_IMPORT_DESCRIPTOR,
  ENERGY_TIMESERIES_TEMPLATE_TYPE,
  buildEnergyTimeseriesImportPreview,
  executeEnergyTimeseriesImport,
  insertEnergyTimeseriesCandidates,
  previewEnergyTimeseriesImport
};
