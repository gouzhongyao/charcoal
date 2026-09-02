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
  DEVICE_STATES,
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

// 排班记录领域固定绑定冻结模板，不允许调用方切换到其他能源分析类型。
const SHIFT_SCHEDULE_TEMPLATE_TYPE = 'shift-schedules';
// 设备状态领域固定绑定冻结模板，不允许调用方切换到其他能源分析类型。
const DEVICE_STATE_TEMPLATE_TYPE = 'device-states';
// 排班和设备状态事实允许的来源类型与 schema 保持一致。
const ENERGY_OPERATIONS_DATA_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);
// 排班模板中唯一允许导入的记录状态；作废必须走后续受控维护流程。
const IMPORTABLE_SHIFT_STATUS = 'active';

// 两类单工作表模板的解析配置。
const OPERATIONS_TEMPLATE_CONFIGS = Object.freeze({
  [SHIFT_SCHEDULE_TEMPLATE_TYPE]: Object.freeze({ sheetName: '排班计划' }),
  [DEVICE_STATE_TEMPLATE_TYPE]: Object.freeze({ sheetName: '设备状态' })
});

// UTC 单元格解析错误用于抑制同一字段的必填和通用 UTC 格式级联错误。
const UTC_TEMPLATE_CELL_ERROR_CODES = new Set([
  'INVALID_TEMPLATE_CELL_TYPE',
  'STRICT_UTC_INPUT_INVALID',
  'STRICT_UTC_INPUT_PRECISION_INVALID'
]);

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
 * 将合法严格 UTC 时间统一规范化为 ISO Z 字符串。
 * @param {*} value 原始时间值。
 * @returns {string} 统一包含三位毫秒的 ISO Z 时间；非法值仅做文本清理。
 */
function normalizeUtcInstant(value) {
  const normalized = normalizeText(value);
  return isStrictUtcIso(normalized) ? new Date(Date.parse(normalized)).toISOString() : normalized;
}

/**
 * 创建运营记录导入行级问题。
 * @param {number} rowNumber 物理来源行号。
 * @param {string|null} fieldName 字段名称。
 * @param {*} rawValue 原始值。
 * @param {string} code 稳定错误码。
 * @param {string} message 中文说明。
 * @param {'error'|'warning'} severity 严重级别。
 * @returns {object} 标准问题对象。
 */
function createOperationsIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({ rowNumber, fieldName, rawValue, code, message, severity });
}

/**
 * 将模板结构问题转换为统一导入问题。
 * @param {object} issue 模板结构问题。
 * @param {number} fallbackRowNumber 缺省物理行号。
 * @returns {object} 标准问题对象。
 */
function mapTemplateIssue(issue, fallbackRowNumber) {
  const rowNumber = Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
    ? issue.sourceRowNumber
    : fallbackRowNumber;
  return createOperationsIssue(
    rowNumber,
    issue.expectedKey || issue.key || issue.header || null,
    issue.values || issue.header || null,
    issue.code || 'ENERGY_OPERATIONS_TEMPLATE_STRUCTURE_INVALID',
    issue.message || '模板结构不符合冻结契约。',
    issue.severity === 'warning' ? 'warning' : 'error'
  );
}

/**
 * 判断指定 UTC 字段是否已被模板单元格解析错误阻断。
 * @param {object[]} issues 已映射的模板问题。
 * @param {string} fieldName 内部 UTC 字段名。
 * @returns {boolean} 是否已有字段级解析错误。
 */
function hasUtcTemplateCellError(issues, fieldName) {
  return (issues || []).some((issue) => issue.fieldName === fieldName
    && issue.severity === 'error'
    && UTC_TEMPLATE_CELL_ERROR_CODES.has(issue.code));
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
 * 从安全原始 Buffer 生成带物理行号的模板映射结果。
 * @param {string} templateType 冻结模板类型。
 * @param {Buffer} buffer 已安全读取的文件 Buffer。
 * @param {string} originalFilename 原始文件名。
 * @returns {{fileType:string,rows:object[],globalIssues:object[],fieldMapping:object}} 模板解析结果。
 */
function parseEnergyOperationsRows(templateType, buffer, originalFilename) {
  const config = OPERATIONS_TEMPLATE_CONFIGS[templateType];
  if (!config) {
    throw badRequest('运营记录导入模板不受支持。', {
      code: 'ENERGY_OPERATIONS_TEMPLATE_UNSUPPORTED',
      templateType
    });
  }

  // 中央解析器仅承担文件签名、编码和资源上限检查；实际模板映射始终按原始列数组完成。
  const safetyResult = parseImportBuffer(buffer, originalFilename);
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  if (!definition.formats.includes(safetyResult.fileType)) {
    throw badRequest('运营记录冻结模板仅支持 .xlsx 或 .csv 文件。', {
      code: 'ENERGY_OPERATIONS_TEMPLATE_FILE_TYPE_UNSUPPORTED',
      fileType: safetyResult.fileType,
      supportedFileTypes: [...definition.formats]
    });
  }

  const templateResult = parseEnergyAnalysisTemplateBuffer(templateType, buffer, originalFilename);
  const sheet = templateResult.sheetsByName?.[config.sheetName] || null;
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
    ...(templateResult.sheetCollection?.issues || []),
    ...(sheet?.headerIssues || [])
  ].map((issue) => mapTemplateIssue(issue, 1));
  return { fileType: safetyResult.fileType, rows, globalIssues, fieldMapping };
}

/**
 * 根据冻结模板列定义补齐必填字段错误。
 * @param {string} templateType 冻结模板类型。
 * @param {object} mapped 模板映射记录。
 * @param {number} rowNumber 物理来源行号。
 * @param {object[]} existingIssues 当前行已有模板问题。
 * @returns {object[]} 缺失字段问题。
 */
function validateRequiredFields(templateType, mapped, rowNumber, existingIssues = []) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  return definition.sheets[0].columns
    .filter((column) => column.required
      && isBlank(mapped[column.key])
      && !(column.dataType === 'utc' && hasUtcTemplateCellError(existingIssues, column.key)))
    .map((column) => createOperationsIssue(
      rowNumber,
      column.key,
      mapped[column.key],
      'REQUIRED_FIELD_MISSING',
      `必填字段“${column.name}”不能为空。`
    ));
}

/**
 * 校验严格 UTC 左闭右开区间与来源时区。
 * @param {object} input 时间字段上下文。
 * @returns {object[]} 时间问题。
 */
function validateOperationsInterval(input) {
  const issues = [];
  const startUtc = normalizeText(input.startUtc);
  const endUtc = normalizeText(input.endUtc);
  const sourceTimeZone = normalizeText(input.sourceTimeZone);
  if (!isStrictUtcIso(startUtc) && !hasUtcTemplateCellError(input.existingIssues, input.startField)) {
    issues.push(createOperationsIssue(input.rowNumber, input.startField, input.startUtc, 'INVALID_START_UTC', '开始时间必须是严格 UTC Z 格式。'));
  }
  if (!isStrictUtcIso(endUtc) && !hasUtcTemplateCellError(input.existingIssues, input.endField)) {
    issues.push(createOperationsIssue(input.rowNumber, input.endField, input.endUtc, 'INVALID_END_UTC', '结束时间必须是严格 UTC Z 格式。'));
  }
  if (!isIanaTimeZone(sourceTimeZone)) {
    issues.push(createOperationsIssue(input.rowNumber, 'sourceTimeZone', input.sourceTimeZone, 'INVALID_SOURCE_TIME_ZONE', '来源时区必须是有效 IANA 时区。'));
  }
  if (isStrictUtcIso(startUtc) && isStrictUtcIso(endUtc) && Date.parse(startUtc) >= Date.parse(endUtc)) {
    issues.push(createOperationsIssue(input.rowNumber, input.startField, { startUtc, endUtc }, 'INVALID_HALF_OPEN_RANGE', '时间区间必须满足左闭右开且开始时间早于结束时间。'));
  }
  return issues;
}

/**
 * 镜像设备状态表的 Unix 整秒区间约束，避免 preview 与 execute 漂移。
 * @param {object} input 设备状态时间字段上下文。
 * @returns {object[]} 数据库秒级边界问题。
 */
function validateDeviceStateDatabaseSecondRange(input) {
  const startUtc = normalizeText(input.startUtc);
  const endUtc = normalizeText(input.endUtc);
  if (!isStrictUtcIso(startUtc) || !isStrictUtcIso(endUtc)) {
    return [];
  }
  const startMilliseconds = Date.parse(startUtc);
  const endMilliseconds = Date.parse(endUtc);
  if (startMilliseconds >= endMilliseconds) {
    return [];
  }
  const startUnixSecond = Math.floor(startMilliseconds / 1000);
  const endUnixSecond = Math.floor(endMilliseconds / 1000);
  if (startUnixSecond < endUnixSecond) {
    return [];
  }
  return [createOperationsIssue(
    input.rowNumber,
    'startUtc',
    { startUtc, endUtc, startUnixSecond, endUnixSecond },
    'DEVICE_STATE_INTERVAL_EMPTY_AT_DATABASE_SECOND_PRECISION',
    '设备状态区间在数据库秒级边界下无有效持续时间；开始与结束的 Unix 整秒必须递增。'
  )];
}

/**
 * 将 0/1 或常见布尔文本解析为 SQLite 布尔值。
 * @param {*} value 原始布尔值。
 * @returns {number|null} 0、1 或无法解析的 null。
 */
function parseBooleanFlag(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  const normalized = normalizeText(value).toLowerCase();
  if (['true', 'yes', '是'].includes(normalized)) return 1;
  if (['false', 'no', '否'].includes(normalized)) return 0;
  return null;
}

/**
 * 读取排班导入需要的组织与班次定义主数据。
 * @param {object} db SQLite 连接。
 * @returns {{organizations:Map<string,object>,shiftDefinitions:Map<string,object[]>}} 主数据索引。
 */
function loadShiftScheduleMasterData(db) {
  const organizations = new Map(db.prepare(
    `SELECT id, unit_code AS code, unit_name AS name, unit_type AS type, status
     FROM organization_units`
  ).all().map((row) => [String(row.code), row]));
  const shiftDefinitions = new Map();
  db.prepare(
    `SELECT id,
            shift_code AS shiftCode,
            shift_name AS shiftName,
            start_minute AS startMinute,
            end_minute AS endMinute,
            crosses_midnight AS crossesMidnight,
            source_timezone AS sourceTimeZone,
            source,
            version,
            effective_start_utc AS effectiveStartUtc,
            effective_end_utc AS effectiveEndUtc,
            status
     FROM shift_definitions
     WHERE status = 'active'
     ORDER BY id ASC`
  ).all().forEach((row) => {
    const key = String(row.shiftCode);
    shiftDefinitions.set(key, [...(shiftDefinitions.get(key) || []), row]);
  });
  return { organizations, shiftDefinitions };
}

/**
 * 按班次编码和模板定义版本解析唯一 active 班次定义。
 * @param {object} mapped 模板映射记录。
 * @param {object[]} definitions 同编码 active 定义。
 * @param {number} rowNumber 来源行号。
 * @param {object[]} issues 行问题列表。
 * @returns {object|null} 匹配的现有班次定义。
 */
function resolveExistingShiftDefinition(mapped, definitions, rowNumber, issues) {
  if (!definitions || definitions.length === 0) {
    issues.push(createOperationsIssue(rowNumber, 'shiftCode', mapped.shiftCode, 'SHIFT_DEFINITION_NOT_FOUND', '班次编码没有对应的 active 班次定义，模板不会隐式创建班次。'));
    return null;
  }
  const version = normalizeText(mapped.definitionVersion);
  const matched = definitions.filter((definition) => definition.version === version);
  if (matched.length !== 1) {
    issues.push(createOperationsIssue(rowNumber, 'definitionVersion', mapped.definitionVersion, 'SHIFT_DEFINITION_NOT_FOUND', '班次编码与定义版本没有唯一对应的 active 班次定义，模板不会隐式创建班次。'));
    return null;
  }
  return matched[0];
}

/**
 * 校验模板携带的班次定义快照与已存在 active 定义完全一致。
 * @param {object} mapped 模板映射记录。
 * @param {object} definition 已解析班次定义。
 * @param {number} rowNumber 来源行号。
 * @returns {object[]} 定义不一致问题。
 */
function validateShiftDefinitionSnapshot(mapped, definition, rowNumber) {
  if (!definition) return [];
  const crossesMidnight = parseBooleanFlag(mapped.crossesMidnight);
  const comparisons = [
    ['shiftName', normalizeText(mapped.shiftName), definition.shiftName, '班次名称'],
    ['shiftStartMinute', Number(mapped.shiftStartMinute), Number(definition.startMinute), '班次开始分钟'],
    ['shiftEndMinute', Number(mapped.shiftEndMinute), Number(definition.endMinute), '班次结束分钟'],
    ['crossesMidnight', crossesMidnight, Number(definition.crossesMidnight), '是否跨日'],
    ['sourceTimeZone', normalizeText(mapped.sourceTimeZone), definition.sourceTimeZone, '来源时区'],
    ['definitionSource', normalizeText(mapped.definitionSource), definition.source, '定义来源'],
    ['definitionVersion', normalizeText(mapped.definitionVersion), definition.version, '定义版本'],
    ['definitionEffectiveStartUtc', Date.parse(normalizeText(mapped.definitionEffectiveStartUtc)), Date.parse(definition.effectiveStartUtc), '定义生效开始时间'],
    ['definitionEffectiveEndUtc', Date.parse(normalizeText(mapped.definitionEffectiveEndUtc)), Date.parse(definition.effectiveEndUtc), '定义生效结束时间']
  ];
  return comparisons
    .filter(([, actual, expected]) => actual !== expected)
    .map(([fieldName, actual, expected, label]) => createOperationsIssue(
      rowNumber,
      fieldName,
      { actual, expected },
      'SHIFT_DEFINITION_SNAPSHOT_MISMATCH',
      `模板中的${label}与现有 active 班次定义不一致，不能忽略或改写班次定义。`
    ));
}

/**
 * 将 UTC 时间投影为指定 IANA 时区的本地日期与分钟。
 * @param {string} utcValue 严格 UTC 时间。
 * @param {string} timeZone IANA 时区。
 * @returns {{date:string,minute:number}} 本地日期与自然日分钟。
 */
function projectUtcToLocalMinute(utcValue, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(utcValue));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute)
  };
}

/**
 * 计算两个本地日历日期的自然日差。
 * @param {string} startDate 开始本地日期。
 * @param {string} endDate 结束本地日期。
 * @returns {number} 自然日差。
 */
function calculateCalendarDayDifference(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

/**
 * 判断严格 UTC 时间是否精确落在整分钟。
 * @param {string} utcValue 严格 UTC 时间。
 * @returns {boolean} 秒与毫秒是否均为零。
 */
function isWholeMinuteUtc(utcValue) {
  const date = new Date(utcValue);
  return date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

/**
 * 严格校验排班事实与班次定义的本地墙钟和自然日语义。
 * @param {object} record 排班候选记录。
 * @param {object} definition 班次定义。
 * @param {number} rowNumber 来源行号。
 * @returns {object[]} 阻断性对齐问题。
 */
function validateShiftScheduleAlignment(record, definition, rowNumber) {
  if (!record || !definition || !isStrictUtcIso(record.startUtc) || !isStrictUtcIso(record.endUtc)
    || !isIanaTimeZone(record.sourceTimeZone)) return [];
  const localStart = projectUtcToLocalMinute(record.startUtc, record.sourceTimeZone);
  const localEnd = projectUtcToLocalMinute(record.endUtc, record.sourceTimeZone);
  const expectedDayDifference = Number(definition.crossesMidnight) === 1 ? 1 : 0;
  const actualDayDifference = calculateCalendarDayDifference(localStart.date, localEnd.date);
  if (isWholeMinuteUtc(record.startUtc)
    && isWholeMinuteUtc(record.endUtc)
    && localStart.minute === Number(definition.startMinute)
    && localEnd.minute === Number(definition.endMinute)
    && actualDayDifference === expectedDayDifference) return [];
  return [createOperationsIssue(
    rowNumber,
    'scheduleStartUtc',
    {
      scheduleStartUtc: record.startUtc,
      scheduleEndUtc: record.endUtc,
      localStart,
      localEnd,
      actualDayDifference,
      startAtWholeMinute: isWholeMinuteUtc(record.startUtc),
      endAtWholeMinute: isWholeMinuteUtc(record.endUtc),
      expectedStartMinute: definition.startMinute,
      expectedEndMinute: definition.endMinute,
      expectedDayDifference
    },
    'SHIFT_SCHEDULE_DEFINITION_ALIGNMENT_MISMATCH',
    '排班开始和结束必须精确匹配班次定义的本地墙钟分钟与跨日自然日语义，秒和毫秒必须为零；系统不会自动改写。'
  )];
}

/**
 * 校验单行排班主数据、定义引用和时间字段。
 * @param {object} row 模板映射行。
 * @param {object} masterData 排班主数据索引。
 * @returns {object} 行校验结果。
 */
function validateShiftScheduleRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  // 模板问题单独保留，供后续字段校验识别已阻断的非空 UTC 单元格。
  const templateIssues = row.issues || [];
  const issues = [...templateIssues, ...validateRequiredFields(
    SHIFT_SCHEDULE_TEMPLATE_TYPE,
    mapped,
    rowNumber,
    templateIssues
  )];
  const organizationCode = normalizeText(mapped.organizationUnitCode);
  const shiftCode = normalizeText(mapped.shiftCode);
  const organization = organizationCode ? masterData.organizations.get(organizationCode) : null;
  const definitions = shiftCode ? masterData.shiftDefinitions.get(shiftCode) : null;

  if (!organizationCode) {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_REQUIRED', '排班记录必须填写已存在的组织编码。'));
  } else if (!organization) {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_NOT_FOUND', '组织编码不存在，不会自动创建主数据。'));
  } else if (organization.status !== 'active') {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_INACTIVE', '组织已停用。'));
  }

  const definition = shiftCode
    ? resolveExistingShiftDefinition(mapped, definitions, rowNumber, issues)
    : null;
  const shiftStartMinute = Number(mapped.shiftStartMinute);
  const shiftEndMinute = Number(mapped.shiftEndMinute);
  const crossesMidnight = parseBooleanFlag(mapped.crossesMidnight);
  if (!Number.isInteger(shiftStartMinute) || shiftStartMinute < 0 || shiftStartMinute > 1439) {
    issues.push(createOperationsIssue(rowNumber, 'shiftStartMinute', mapped.shiftStartMinute, 'INVALID_SHIFT_START_MINUTE', '班次开始分钟必须是 0 到 1439 的整数。'));
  }
  if (!Number.isInteger(shiftEndMinute) || shiftEndMinute < 0 || shiftEndMinute > 1439) {
    issues.push(createOperationsIssue(rowNumber, 'shiftEndMinute', mapped.shiftEndMinute, 'INVALID_SHIFT_END_MINUTE', '班次结束分钟必须是 0 到 1439 的整数。'));
  }
  if (crossesMidnight === null) {
    issues.push(createOperationsIssue(rowNumber, 'crossesMidnight', mapped.crossesMidnight, 'INVALID_SHIFT_CROSSES_MIDNIGHT', '是否跨日必须使用 0/1 或等价布尔值。'));
  } else if (Number.isInteger(shiftStartMinute) && Number.isInteger(shiftEndMinute)
    && !((crossesMidnight === 0 && shiftStartMinute < shiftEndMinute)
      || (crossesMidnight === 1 && shiftStartMinute > shiftEndMinute))) {
    issues.push(createOperationsIssue(rowNumber, 'crossesMidnight', mapped.crossesMidnight, 'INVALID_SHIFT_LOCAL_RANGE', '班次本地起止分钟与跨日标记不一致。'));
  }

  issues.push(...validateOperationsInterval({
    rowNumber,
    startField: 'scheduleStartUtc',
    endField: 'scheduleEndUtc',
    startUtc: mapped.scheduleStartUtc,
    endUtc: mapped.scheduleEndUtc,
    sourceTimeZone: mapped.sourceTimeZone,
    existingIssues: templateIssues
  }));
  issues.push(...validateOperationsInterval({
    rowNumber,
    startField: 'definitionEffectiveStartUtc',
    endField: 'definitionEffectiveEndUtc',
    startUtc: mapped.definitionEffectiveStartUtc,
    endUtc: mapped.definitionEffectiveEndUtc,
    sourceTimeZone: mapped.sourceTimeZone,
    existingIssues: templateIssues
  }));

  const sourceReference = normalizeText(mapped.sourceReference);
  const dataSource = normalizeText(mapped.dataSource) || 'upload';
  const status = normalizeText(mapped.status) || IMPORTABLE_SHIFT_STATUS;
  if (!sourceReference) {
    issues.push(createOperationsIssue(rowNumber, 'sourceReference', mapped.sourceReference, 'SOURCE_REFERENCE_REQUIRED', '来源标识不能为空。'));
  }
  if (!ENERGY_OPERATIONS_DATA_SOURCES.includes(dataSource)) {
    issues.push(createOperationsIssue(rowNumber, 'dataSource', mapped.dataSource, 'INVALID_DATA_SOURCE', '数据来源仅支持 manual、upload 或 calculation。'));
  }
  if (status !== IMPORTABLE_SHIFT_STATUS) {
    issues.push(createOperationsIssue(rowNumber, 'status', mapped.status, 'SHIFT_SCHEDULE_IMPORT_STATUS_UNSUPPORTED', '排班导入只允许写入 active 记录；作废必须走受控维护流程。'));
  }
  issues.push(...validateShiftDefinitionSnapshot(mapped, definition, rowNumber));

  const startUtc = normalizeUtcInstant(mapped.scheduleStartUtc);
  const endUtc = normalizeUtcInstant(mapped.scheduleEndUtc);
  if (definition && isStrictUtcIso(startUtc) && isStrictUtcIso(endUtc)
    && (Date.parse(startUtc) < Date.parse(definition.effectiveStartUtc)
      || Date.parse(endUtc) > Date.parse(definition.effectiveEndUtc))) {
    issues.push(createOperationsIssue(rowNumber, 'scheduleStartUtc', { startUtc, endUtc }, 'SHIFT_DEFINITION_NOT_EFFECTIVE', '排班区间必须完整落在班次定义有效期内。'));
  }

  const record = definition && organization
    ? {
      sourceRowNumber: rowNumber,
      shiftDefinitionId: definition.id,
      shiftCode: definition.shiftCode,
      organizationUnitId: organization.id,
      organizationUnitCode: organization.code,
      startUtc,
      endUtc,
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
      sourceReference,
      dataSource,
      recordStatus: 'active'
    }
    : null;
  issues.push(...validateShiftScheduleAlignment(record, definition, rowNumber));
  return { rowNumber, mapped, issues, record };
}

/**
 * 读取设备状态导入需要的组织和计量器具主数据。
 * @param {object} db SQLite 连接。
 * @returns {{organizations:Map<string,object>,meters:Map<string,object>}} 主数据索引。
 */
function loadDeviceStateMasterData(db) {
  const organizations = new Map(db.prepare(
    `SELECT id, unit_code AS code, unit_name AS name, unit_type AS type, status
     FROM organization_units`
  ).all().map((row) => [String(row.code), row]));
  const meters = new Map(db.prepare(
    `SELECT id, meter_code AS code, meter_name AS name, organization_unit_id AS organizationUnitId, status
     FROM meter_devices`
  ).all().map((row) => [String(row.code), row]));
  return { organizations, meters };
}

/**
 * 校验单行设备组织、表计、状态和时间字段。
 * @param {object} row 模板映射行。
 * @param {object} masterData 设备主数据索引。
 * @returns {object} 行校验结果。
 */
function validateDeviceStateRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  // 模板问题单独保留，供后续字段校验识别已阻断的非空 UTC 单元格。
  const templateIssues = row.issues || [];
  const issues = [...templateIssues, ...validateRequiredFields(
    DEVICE_STATE_TEMPLATE_TYPE,
    mapped,
    rowNumber,
    templateIssues
  )];
  const organizationCode = normalizeText(mapped.organizationUnitCode);
  const meterCode = normalizeText(mapped.meterCode);
  const organization = organizationCode ? masterData.organizations.get(organizationCode) : null;
  const meter = meterCode ? masterData.meters.get(meterCode) : null;

  if (!organizationCode) {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'DEVICE_ORGANIZATION_REQUIRED', '设备状态记录必须填写已存在的设备组织编码。'));
  } else if (!organization) {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_NOT_FOUND', '组织编码不存在，不会自动创建主数据。'));
  } else if (organization.type !== 'equipment') {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'DEVICE_ORGANIZATION_TYPE_INVALID', '设备状态所属组织类型必须为 equipment。'));
  } else if (organization.status !== 'active') {
    issues.push(createOperationsIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_INACTIVE', '设备组织已停用。'));
  }

  if (!meterCode) {
    issues.push(createOperationsIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_DEVICE_REQUIRED_BY_SCHEMA', '当前 schema 要求设备状态记录必须关联计量器具。'));
  } else if (!meter) {
    issues.push(createOperationsIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_DEVICE_NOT_FOUND', '计量器具编码不存在，不会自动创建主数据。'));
  } else if (meter.status !== 'active') {
    issues.push(createOperationsIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_DEVICE_INACTIVE', '计量器具已停用。'));
  }
  if (meter && organization && Number(meter.organizationUnitId) !== Number(organization.id)) {
    issues.push(createOperationsIssue(rowNumber, 'meterCode', mapped.meterCode, 'METER_ORGANIZATION_MISMATCH', '计量器具与设备组织不兼容。'));
  }

  const deviceState = normalizeText(mapped.deviceState).toLowerCase();
  if (!DEVICE_STATES.includes(deviceState)) {
    issues.push(createOperationsIssue(rowNumber, 'deviceState', mapped.deviceState, 'INVALID_DEVICE_STATE', '设备状态仅允许 running、idle、stopped、offline、unknown，不允许 fault。'));
  }
  issues.push(...validateOperationsInterval({
    rowNumber,
    startField: 'startUtc',
    endField: 'endUtc',
    startUtc: mapped.startUtc,
    endUtc: mapped.endUtc,
    sourceTimeZone: mapped.sourceTimeZone,
    existingIssues: templateIssues
  }));
  issues.push(...validateDeviceStateDatabaseSecondRange({
    rowNumber,
    startUtc: mapped.startUtc,
    endUtc: mapped.endUtc
  }));

  const sourceReference = normalizeText(mapped.sourceReference);
  const dataSource = normalizeText(mapped.dataSource) || 'upload';
  if (!sourceReference) {
    issues.push(createOperationsIssue(rowNumber, 'sourceReference', mapped.sourceReference, 'SOURCE_REFERENCE_REQUIRED', '来源标识不能为空。'));
  }
  if (!ENERGY_OPERATIONS_DATA_SOURCES.includes(dataSource)) {
    issues.push(createOperationsIssue(rowNumber, 'dataSource', mapped.dataSource, 'INVALID_DATA_SOURCE', '数据来源仅支持 manual、upload 或 calculation。'));
  }

  const record = organization && meter
    ? {
      sourceRowNumber: rowNumber,
      organizationUnitId: organization.id,
      organizationUnitCode: organization.code,
      meterDeviceId: meter.id,
      meterCode: meter.code,
      deviceState,
      startUtc: normalizeUtcInstant(mapped.startUtc),
      endUtc: normalizeUtcInstant(mapped.endUtc),
      sourceTimeZone: normalizeText(mapped.sourceTimeZone),
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
 * 为问题列表追加一次去重后的重叠错误。
 * @param {object} item 行校验结果。
 * @param {string} message 中文说明。
 */
function appendOverlapIssue(item, message) {
  if (item.issues.some((issue) => issue.code === 'SOURCE_OVERLAP_OR_DUPLICATE')) return;
  item.issues.push(createOperationsIssue(
    item.rowNumber,
    'startUtc',
    { startUtc: item.record?.startUtc, endUtc: item.record?.endUtc },
    'SOURCE_OVERLAP_OR_DUPLICATE',
    message
  ));
}

/**
 * 为完全重复行追加 skip warning。
 * @param {object} item 行校验结果。
 * @param {string} code 稳定 warning 码。
 * @param {string} message 中文说明。
 */
function markExactDuplicateSkipped(item, code, message) {
  item.skipDuplicate = true;
  item.issues.push(createOperationsIssue(
    item.rowNumber,
    'startUtc',
    { startUtc: item.record.startUtc, endUtc: item.record.endUtc },
    code,
    message,
    'warning'
  ));
}

/**
 * 对输入文件内部同流区间执行完全重复 skip 与其他重叠双向阻断。
 * @param {object[]} rows 行校验结果。
 * @param {Function} buildStreamKey 数据流键构造器。
 * @param {Function} isExactFact 事实等价判断器。
 * @param {string} duplicateCode 完全重复 warning 码。
 */
function markInputDuplicatesAndOverlaps(rows, buildStreamKey, isExactFact, duplicateCode) {
  const comparableRows = rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error'));
  for (let leftIndex = 0; leftIndex < comparableRows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparableRows.length; rightIndex += 1) {
      const left = comparableRows[leftIndex];
      const right = comparableRows[rightIndex];
      if (buildStreamKey(left.record) !== buildStreamKey(right.record)) continue;
      if (!intervalsOverlap(left.record, right.record)) continue;
      if (isExactFact(left.record, right.record)) {
        markExactDuplicateSkipped(right, duplicateCode, `输入文件第 ${right.rowNumber} 行与第 ${left.rowNumber} 行事实完全相同，本行按 skip 策略跳过。`);
        continue;
      }
      appendOverlapIssue(left, `输入文件第 ${left.rowNumber} 行与第 ${right.rowNumber} 行在同一业务流中区间重叠。`);
      appendOverlapIssue(right, `输入文件第 ${right.rowNumber} 行与第 ${left.rowNumber} 行在同一业务流中区间重叠。`);
    }
  }
}

/**
 * 构造同一组织排班业务流键，不允许不同班次在同一组织无依据重叠。
 * @param {object} record 排班事实。
 * @returns {string} 数据流键。
 */
function buildShiftScheduleStreamKey(record) {
  return stableSerialize({ organizationUnitId: record.organizationUnitId });
}

/**
 * 判断两条排班事实是否完全相同，来源批次与来源行号不参与等价。
 * @param {object} left 左事实。
 * @param {object} right 右事实。
 * @returns {boolean} 是否完全相同。
 */
function isExactShiftScheduleFact(left, right) {
  return Number(left.shiftDefinitionId) === Number(right.shiftDefinitionId)
    && Number(left.organizationUnitId) === Number(right.organizationUnitId)
    && Date.parse(left.startUtc) === Date.parse(right.startUtc)
    && Date.parse(left.endUtc) === Date.parse(right.endUtc)
    && left.sourceTimeZone === right.sourceTimeZone
    && left.sourceReference === right.sourceReference
    && left.dataSource === right.dataSource;
}

/**
 * 查询数据库 active 排班重叠，并按完全相同 skip、其他重叠 block 处理。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 行校验结果。
 */
function markShiftDatabaseDuplicatesAndOverlaps(db, rows) {
  const selectOverlaps = db.prepare(
    `SELECT id,
            shift_definition_id AS shiftDefinitionId,
            organization_unit_id AS organizationUnitId,
            start_utc AS startUtc,
            end_utc AS endUtc,
            source_timezone AS sourceTimeZone,
            source_reference AS sourceReference,
            data_source AS dataSource
     FROM shift_schedule_records
     WHERE record_status = 'active'
       AND organization_unit_id = ?
       AND julianday(start_utc) < julianday(?)
       AND julianday(end_utc) > julianday(?)
     ORDER BY id ASC`
  );
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const overlaps = selectOverlaps.all(row.record.organizationUnitId, row.record.endUtc, row.record.startUtc);
    if (overlaps.length === 0) return;
    const nonExactOverlap = overlaps.find((existing) => !isExactShiftScheduleFact(existing, row.record));
    if (nonExactOverlap) {
      appendOverlapIssue(row, `数据库 active 排班记录 ${nonExactOverlap.id} 与当前候选在同一组织中区间重叠。`);
      return;
    }
    markExactDuplicateSkipped(row, 'DUPLICATE_SHIFT_SCHEDULE_SKIPPED', '数据库已存在完全相同的 active 排班事实，本行按 skip 策略跳过。');
  });
}

/**
 * 构造同一设备与计量器具状态业务流键。
 * @param {object} record 设备状态事实。
 * @returns {string} 数据流键。
 */
function buildDeviceStateStreamKey(record) {
  return stableSerialize({
    organizationUnitId: record.organizationUnitId,
    meterDeviceId: record.meterDeviceId ?? null
  });
}

/**
 * 判断两条设备状态事实是否完全相同，来源批次与来源行号不参与等价。
 * @param {object} left 左事实。
 * @param {object} right 右事实。
 * @returns {boolean} 是否完全相同。
 */
function isExactDeviceStateFact(left, right) {
  return Number(left.organizationUnitId) === Number(right.organizationUnitId)
    && Number(left.meterDeviceId ?? 0) === Number(right.meterDeviceId ?? 0)
    && left.deviceState === right.deviceState
    && Date.parse(left.startUtc) === Date.parse(right.startUtc)
    && Date.parse(left.endUtc) === Date.parse(right.endUtc)
    && left.sourceTimeZone === right.sourceTimeZone
    && left.sourceReference === right.sourceReference
    && left.dataSource === right.dataSource;
}

/**
 * 查询数据库 active 设备状态重叠，并按完全相同 skip、其他重叠 block 处理。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 行校验结果。
 */
function markDeviceDatabaseDuplicatesAndOverlaps(db, rows) {
  const selectOverlaps = db.prepare(
    `SELECT id,
            meter_device_id AS meterDeviceId,
            organization_unit_id AS organizationUnitId,
            device_state AS deviceState,
            start_utc AS startUtc,
            end_utc AS endUtc,
            source_timezone AS sourceTimeZone,
            source_reference AS sourceReference,
            data_source AS dataSource
     FROM device_state_records
     WHERE record_status = 'active'
       AND organization_unit_id = ?
       AND meter_device_id IS ?
       AND julianday(start_utc) < julianday(?)
       AND julianday(end_utc) > julianday(?)
     ORDER BY id ASC`
  );
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const overlaps = selectOverlaps.all(
      row.record.organizationUnitId,
      row.record.meterDeviceId,
      row.record.endUtc,
      row.record.startUtc
    );
    if (overlaps.length === 0) return;
    const nonExactOverlap = overlaps.find((existing) => !isExactDeviceStateFact(existing, row.record));
    if (nonExactOverlap) {
      appendOverlapIssue(row, `数据库 active 设备状态记录 ${nonExactOverlap.id} 与当前候选在同一设备流中区间重叠。`);
      return;
    }
    markExactDuplicateSkipped(row, 'DUPLICATE_DEVICE_STATE_SKIPPED', '数据库已存在完全相同的 active 设备状态事实，本行按 skip 策略跳过。');
  });
}

/**
 * 为可导入运营事实生成稳定候选 ID。
 * @param {string} prefix 候选类型前缀。
 * @param {object} record 规范化事实。
 * @returns {string} 候选 ID。
 */
function buildOperationsCandidateRowId(prefix, record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `${prefix}:${record.sourceRowNumber}:${digest}`;
}

/**
 * 把结构问题附加到领域行，确保空文件也有可审计阻断项。
 * @param {object[]} rows 领域行列表。
 * @param {object[]} globalIssues 全局模板问题。
 */
function attachGlobalIssues(rows, globalIssues) {
  if (globalIssues.length === 0) return;
  if (rows.length > 0) {
    const blockingIssues = globalIssues.filter((issue) => issue.severity === 'error');
    const warningIssues = globalIssues.filter((issue) => issue.severity === 'warning');
    rows.forEach((row) => row.issues.push(...blockingIssues));
    rows[0].issues.push(...warningIssues);
    return;
  }
  rows.push({
    rowNumber: 1,
    mapped: {},
    issues: [...globalIssues],
    record: null,
    structuralOnly: true
  });
}

/**
 * 将领域校验行投影为统一 preview 结果。
 * @param {object} input 投影上下文。
 * @returns {object} 单批次底座可消费的 preview。
 */
function buildOperationsPreviewResult(input) {
  const items = input.rows.map((row) => {
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
  const candidateRows = input.rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({
      candidateRowId: buildOperationsCandidateRowId(input.candidatePrefix, row.record),
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

/**
 * 构建排班记录领域 preview；只引用现有 active 班次定义。
 * @param {object} input Buffer、数据库与原始文件上下文。
 * @returns {object} 统一 preview 领域结果。
 */
function buildShiftScheduleImportPreview(input) {
  const parsedRows = parseEnergyOperationsRows(SHIFT_SCHEDULE_TEMPLATE_TYPE, input.buffer, input.originalFilename);
  const masterData = loadShiftScheduleMasterData(input.db);
  const rows = parsedRows.rows.map((row) => validateShiftScheduleRow(row, masterData));
  attachGlobalIssues(rows, parsedRows.globalIssues);
  markInputDuplicatesAndOverlaps(rows, buildShiftScheduleStreamKey, isExactShiftScheduleFact, 'DUPLICATE_SHIFT_SCHEDULE_SKIPPED');
  markShiftDatabaseDuplicatesAndOverlaps(input.db, rows);
  return buildOperationsPreviewResult({
    rows,
    fileType: parsedRows.fileType,
    fieldMapping: parsedRows.fieldMapping,
    candidatePrefix: 'shift-schedule',
    notices: [
      'preview 不写 shift_definitions 或 shift_schedule_records；模板只引用已存在的 active 班次定义。',
      'execute 将从持久化批次找回原文件并重新解析、查重和查重叠；同一组织不同班次也不得无依据重叠。'
    ]
  });
}

/**
 * 构建设备状态领域 preview；缺口不会自动补 unknown 记录。
 * @param {object} input Buffer、数据库与原始文件上下文。
 * @returns {object} 统一 preview 领域结果。
 */
function buildDeviceStateImportPreview(input) {
  const parsedRows = parseEnergyOperationsRows(DEVICE_STATE_TEMPLATE_TYPE, input.buffer, input.originalFilename);
  const masterData = loadDeviceStateMasterData(input.db);
  const rows = parsedRows.rows.map((row) => validateDeviceStateRow(row, masterData));
  attachGlobalIssues(rows, parsedRows.globalIssues);
  markInputDuplicatesAndOverlaps(rows, buildDeviceStateStreamKey, isExactDeviceStateFact, 'DUPLICATE_DEVICE_STATE_SKIPPED');
  markDeviceDatabaseDuplicatesAndOverlaps(input.db, rows);
  return buildOperationsPreviewResult({
    rows,
    fileType: parsedRows.fileType,
    fieldMapping: parsedRows.fieldMapping,
    candidatePrefix: 'device-state',
    notices: [
      'preview 不写 device_state_records；execute 将从持久化批次找回原文件并重新解析、查重和查重叠。',
      'unknown 只表示模板显式导入的 unknown；系统不填补状态缺口，也不会自动生成 unknown、idle 或 stopped。'
    ]
  });
}

/**
 * 在调用方 SQLite 事务内插入已复核的排班候选事实。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {{imported:number,importedIds:number[],importedItems:object[]}} 插入结果。
 */
function insertShiftScheduleCandidates(input) {
  const insertRecord = input.db.prepare(
    `INSERT INTO shift_schedule_records (
       source_batch_id,
       source_row_number,
       shift_definition_id,
       organization_unit_id,
       start_utc,
       end_utc,
       source_timezone,
       source_reference,
       data_source,
       record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
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
      candidate.shiftDefinitionId,
      candidate.organizationUnitId,
      candidate.startUtc,
      candidate.endUtc,
      candidate.sourceTimeZone,
      candidate.sourceReference,
      candidate.dataSource
    );
    const importedId = Number(result.lastInsertRowid);
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') {
      input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
    }
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

/**
 * 在调用方 SQLite 事务内插入已复核的设备状态候选事实。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {{imported:number,importedIds:number[],importedItems:object[]}} 插入结果。
 */
function insertDeviceStateCandidates(input) {
  const insertRecord = input.db.prepare(
    `INSERT INTO device_state_records (
       source_batch_id,
       source_row_number,
       meter_device_id,
       organization_unit_id,
       device_state,
       start_utc,
       end_utc,
       source_timezone,
       source_reference,
       data_source,
       record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
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
      candidate.meterDeviceId,
      candidate.organizationUnitId,
      candidate.deviceState,
      candidate.startUtc,
      candidate.endUtc,
      candidate.sourceTimeZone,
      candidate.sourceReference,
      candidate.dataSource
    );
    const importedId = Number(result.lastInsertRowid);
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') {
      input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
    }
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

// 单批次底座使用的排班领域描述器。
const SHIFT_SCHEDULE_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: SHIFT_SCHEDULE_TEMPLATE_TYPE,
  buildPreview: buildShiftScheduleImportPreview,
  insertCandidates: insertShiftScheduleCandidates
});

// 单批次底座使用的设备状态领域描述器。
const DEVICE_STATE_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: DEVICE_STATE_TEMPLATE_TYPE,
  buildPreview: buildDeviceStateImportPreview,
  insertCandidates: insertDeviceStateCandidates
});

/**
 * 从 Multer 已落盘原文件创建排班记录 preview 审计批次。
 * @param {object} file Multer 文件对象。
 * @param {object} options 可注入数据库、上传目录和密钥读写器。
 * @returns {object} 安全 preview。
 */
function previewShiftScheduleImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, SHIFT_SCHEDULE_IMPORT_DESCRIPTOR, options);
}

/**
 * 依据持久化 batchId 执行排班记录导入。
 * @param {object} body 固定确认、文件和候选见证。
 * @param {object} options 可注入数据库、上传目录、备份和密钥读写器。
 * @returns {Promise<object>} execute 结果。
 */
async function executeShiftScheduleImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, SHIFT_SCHEDULE_IMPORT_DESCRIPTOR, options);
}

/**
 * 从 Multer 已落盘原文件创建设备状态 preview 审计批次。
 * @param {object} file Multer 文件对象。
 * @param {object} options 可注入数据库、上传目录和密钥读写器。
 * @returns {object} 安全 preview。
 */
function previewDeviceStateImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, DEVICE_STATE_IMPORT_DESCRIPTOR, options);
}

/**
 * 依据持久化 batchId 执行设备状态导入。
 * @param {object} body 固定确认、文件和候选见证。
 * @param {object} options 可注入数据库、上传目录、备份和密钥读写器。
 * @returns {Promise<object>} execute 结果。
 */
async function executeDeviceStateImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, DEVICE_STATE_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  DEVICE_STATE_IMPORT_DESCRIPTOR,
  DEVICE_STATE_TEMPLATE_TYPE,
  ENERGY_OPERATIONS_DATA_SOURCES,
  SHIFT_SCHEDULE_IMPORT_DESCRIPTOR,
  SHIFT_SCHEDULE_TEMPLATE_TYPE,
  buildDeviceStateImportPreview,
  buildDeviceStateStreamKey,
  buildShiftScheduleImportPreview,
  buildShiftScheduleStreamKey,
  executeDeviceStateImport,
  executeShiftScheduleImport,
  insertDeviceStateCandidates,
  insertShiftScheduleCandidates,
  isExactDeviceStateFact,
  isExactShiftScheduleFact,
  parseEnergyOperationsRows,
  previewDeviceStateImport,
  previewShiftScheduleImport,
  validateDeviceStateDatabaseSecondRange
};
