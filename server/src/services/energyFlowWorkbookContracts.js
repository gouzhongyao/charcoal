'use strict';

const { AppError } = require('../utils/errors');
const {
  normalizeUserVisibleWallClockMinuteInput
} = require('../utils/userVisibleDateTime');
const {
  convertSourceWallClockRangeToUtc,
  isValidIanaTimezone
} = require('./sourceWallClockService');

// 固定完整能流工作簿模板身份与安全边界。
const ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE = 'energy-flow-workbook';
const ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION = '1.0';
const ENERGY_FLOW_WORKBOOK_IMPORT_TYPE = 'energy_flow_workbook';
const ENERGY_FLOW_WORKBOOK_OPERATION = 'energy-flow-workbook-import';
const ENERGY_FLOW_WORKBOOK_RECORD_KIND = 'energy_flow_workbook';
const ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT = '确认导入完整能流工作簿';
const ENERGY_FLOW_WORKBOOK_BACKUP_REASON = 'energy-flow-workbook-import';
const ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY = 'skip';

// 固定六表资源预算；业务文本和问题预算均在服务端 fail-closed。
const ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS = Object.freeze({
  maxUploadBytes: 10 * 1024 * 1024,
  maxZipEntries: 256,
  maxZipEntryUncompressedBytes: 64 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNonEmptyCells: 1250000,
  maxWorkbookTextCharacters: 10000000,
  maxIssues: 10000,
  maxWorkbookRows: 80001,
  maxDataRows: Object.freeze({
    模型: 1,
    设备资产与节点: 5000,
    有向边: 10000,
    期间流量: 50000,
    余热事实: 5000,
    损耗证据: 10000
  })
});

// 固定可见工作表顺序和逐列标题，不接受别名、未知列或重排。
const ENERGY_FLOW_WORKBOOK_HEADERS = Object.freeze({
  模型: Object.freeze(['模板标识', '模板版本', '模型编码', '模型名称', '来源', '文号', '版本', '生效开始时间', '生效结束时间', '来源时区', '分类状态', '来源模式', '状态']),
  设备资产与节点: Object.freeze(['行类型', '模型编码', '设备资产编码', '设备资产名称', '设备资产类型', '节点编码', '节点名称', '节点类型', '关联设备资产编码', '阶段代码', '组织单元编码', '横坐标', '纵坐标', '状态']),
  有向边: Object.freeze(['模型编码', '路径编码', '路径名称', '路径顺序', '边编码', '起点节点编码', '终点节点编码', '能源类型编码', '单位', '来源类型', '来源引用', '状态']),
  期间流量: Object.freeze(['记录编码', '模型编码', '事实角色', '边编码', '节点编码', '路径编码', '设备资产编码', '阶段代码', '期间开始时间', '期间结束时间', '来源时区', '能源类型编码', '数值', '单位', '来源引用']),
  余热事实: Object.freeze(['余热事实编码', '模型编码', '关联期间记录编码', '余热角色', '来源引用', '状态']),
  损耗证据: Object.freeze(['行类型', '模型编码', '损耗事实编码', '关联期间记录编码', '损耗事实角色', '证据编码', '证据角色', '证据名称', '证据类型', '证据引用', '证据开始时间', '证据结束时间', '来源时区', '基准损耗值', '基准损耗单位', '状态', '备注'])
});

// 固定表格定义供模板生成和严格解析共用；key 仅为服务端内部字段名。
const ENERGY_FLOW_WORKBOOK_SHEETS = Object.freeze([
  Object.freeze({ name: '模型', key: 'models', headers: ENERGY_FLOW_WORKBOOK_HEADERS.模型, maxDataRows: 1 }),
  Object.freeze({ name: '设备资产与节点', key: 'assetsNodes', headers: ENERGY_FLOW_WORKBOOK_HEADERS.设备资产与节点, maxDataRows: 5000 }),
  Object.freeze({ name: '有向边', key: 'edges', headers: ENERGY_FLOW_WORKBOOK_HEADERS.有向边, maxDataRows: 10000 }),
  Object.freeze({ name: '期间流量', key: 'records', headers: ENERGY_FLOW_WORKBOOK_HEADERS.期间流量, maxDataRows: 50000 }),
  Object.freeze({ name: '余热事实', key: 'wasteHeat', headers: ENERGY_FLOW_WORKBOOK_HEADERS.余热事实, maxDataRows: 5000 }),
  Object.freeze({ name: '损耗证据', key: 'lossEvidence', headers: ENERGY_FLOW_WORKBOOK_HEADERS.损耗证据, maxDataRows: 10000 })
]);

// 数据库枚举合同必须在 preview 阶段完整验证，禁止由拓扑或名称推断。
const ENERGY_FLOW_WORKBOOK_ENUMS = Object.freeze({
  rowTypes: Object.freeze(['asset', 'node']),
  lossRowTypes: Object.freeze(['loss_fact', 'evidence']),
  assetTypes: Object.freeze(['production_device', 'distribution_device', 'storage_device', 'recovery_device', 'measurement_device', 'other']),
  nodeTypes: Object.freeze(['source', 'process', 'storage', 'sink', 'loss', 'boundary']),
  stageCodes: Object.freeze(['plant_entry', 'distribution', 'device_input', 'useful_output', 'waste_heat', 'loss', 'boundary']),
  recordRoles: Object.freeze(['edge_flow', 'storage_change']),
  wasteHeatRoles: Object.freeze(['generation', 'recovery', 'utilization', 'discharge']),
  lossFactRoles: Object.freeze(['distribution_loss', 'conversion_loss', 'storage_loss', 'device_loss', 'other_loss']),
  evidenceRoles: Object.freeze(['fact_evidence', 'benchmark']),
  evidenceTypes: Object.freeze(['meter_record', 'calculation_sheet', 'inspection_report', 'test_report', 'standard', 'other']),
  statuses: Object.freeze(['active', 'inactive'])
});

// 规范编码只接受可审计 ASCII 形式；比较键再经过 NFKC 和大写。
const ENERGY_FLOW_WORKBOOK_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENERGY_FLOW_WORKBOOK_VERSION_PATTERN = /^[\x21-\x7E]{1,64}$/;

/** 将表头或单元格值转为去除首尾空白的字符串。 */
function normalizeWorkbookText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** 生成稳定比较键，禁止依赖运行时 locale。 */
function normalizeWorkbookKey(value) {
  return normalizeWorkbookText(value).normalize('NFKC').toUpperCase();
}

/** 创建统一字段级问题，避免将底层异常文本写入审计。 */
function createWorkbookIssue(rowNumber, fieldName, code, message, rawValue = null, severity = 'error') {
  return { rowNumber, fieldName, code, message, rawValue: rawValue === undefined ? null : rawValue, severity };
}

/** 以固定问题预算追加问题，超过预算立即按资源错误终止。 */
function pushWorkbookIssue(issues, issue) {
  if (!Array.isArray(issues) || issues.length >= ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS.maxIssues) {
    throw new AppError('ENERGY_FLOW_WORKBOOK_ISSUE_LIMIT_EXCEEDED', '完整能流工作簿问题数量超过限制。', {
      statusCode: 413,
      details: { code: 'ENERGY_FLOW_WORKBOOK_ISSUE_LIMIT_EXCEEDED' }
    });
  }
  issues.push(issue);
}

/** 检查值是否为空，空字符串、null 和 undefined 统一为空。 */
function isWorkbookBlank(value) {
  return value === undefined || value === null || normalizeWorkbookText(value) === '';
}

/** 要求字段非空并返回字符串值。 */
function requireWorkbookText(issues, rowNumber, fieldName, value, maxLength = 1000) {
  const text = normalizeWorkbookText(value);
  const normalizedText = text.normalize('NFKC').trim();
  if (!normalizedText) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`, value));
  if (normalizedText.length > maxLength) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_FIELD_TOO_LONG', `${fieldName} 超过 ${maxLength} 个字符。`, value));
  return text;
}

/** 校验稳定编码并返回显示值和比较键。 */
function normalizeWorkbookCode(issues, rowNumber, fieldName, value, maxLength = 128, required = true) {
  const text = normalizeWorkbookText(value);
  const normalizedText = text.normalize('NFKC').trim();
  if (!normalizedText && required) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`, value));
  if (normalizedText && (!ENERGY_FLOW_WORKBOOK_CODE_PATTERN.test(text) || normalizedText.length > maxLength)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_CODE_INVALID', `${fieldName} 必须是合法稳定编码。`, value));
  }
  return { value: text, key: normalizedText ? normalizeWorkbookKey(normalizedText) : '' };
}

/** 校验独立模型版本合同。 */
function normalizeWorkbookVersion(issues, rowNumber, value) {
  const text = normalizeWorkbookText(value);
  const normalizedText = text.normalize('NFKC').trim();
  if (!normalizedText || normalizedText.length > 64 || !ENERGY_FLOW_WORKBOOK_VERSION_PATTERN.test(text)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, '版本', 'ENERGY_FLOW_WORKBOOK_VERSION_INVALID', '模型版本必须是 1 至 64 个 ASCII 可见字符。', value));
  }
  return text;
}

/** 校验有限数值、范围和小数精度。 */
function normalizeWorkbookNumber(issues, rowNumber, fieldName, value, options = {}) {
  if (isWorkbookBlank(value)) {
    if (options.required) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`, value));
    return null;
  }
  if (typeof value !== 'number') {
    pushWorkbookIssue(issues, createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMERIC_CELL_REQUIRED', `${fieldName} 必须使用非公式数值单元格。`, value));
    return null;
  }
  const numberValue = value;
  if (!Number.isFinite(numberValue)) {
    pushWorkbookIssue(issues, createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMBER_INVALID', `${fieldName} 必须是有限数值。`, value));
    return null;
  }
  if (Math.abs(numberValue) > (options.maxAbs ?? 1e15)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMBER_OUT_OF_RANGE', `${fieldName} 超出允许范围。`, value));
  }
  const decimalText = String(value).toLowerCase().includes('e') ? numberValue.toFixed(12) : String(value).trim();
  const decimals = decimalText.includes('.') ? decimalText.split('.')[1].replace(/0+$/, '').length : 0;
  if (decimals > (options.maxDecimals ?? 9)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMBER_PRECISION_EXCEEDED', `${fieldName} 最多允许 ${(options.maxDecimals ?? 9)} 位小数。`, value));
  }
  if (options.integer && (!Number.isSafeInteger(numberValue) || numberValue < 1)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_INTEGER_INVALID', `${fieldName} 必须是正安全整数。`, value));
  }
  if (options.min !== undefined && numberValue < options.min) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMBER_OUT_OF_RANGE', `${fieldName} 小于允许下限。`, value));
  if (options.max !== undefined && numberValue > options.max) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_NUMBER_OUT_OF_RANGE', `${fieldName} 大于允许上限。`, value));
  return numberValue;
}

/** 校验来源墙钟区间并转换为 UTC 秒精度。 */
function normalizeWorkbookWallClockRange(issues, rowNumber, startValue, endValue, timeZone, fieldPrefix) {
  const startInput = normalizeWorkbookText(startValue);
  const endInput = normalizeWorkbookText(endValue);
  const zone = normalizeWorkbookText(timeZone);
  if (zone.normalize('NFKC').trim().length > 100) {
    pushWorkbookIssue(issues, createWorkbookIssue(rowNumber, '来源时区', 'ENERGY_FLOW_WORKBOOK_FIELD_TOO_LONG', '来源时区超过 100 个字符。', timeZone));
  }
  if (!startInput || !endInput || !zone) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldPrefix, 'ENERGY_FLOW_WORKBOOK_REQUIRED_FIELD_MISSING', `${fieldPrefix} 起止时间和来源时区均为必填项。`, null));
    return { startWallClock: startInput, endWallClock: endInput, sourceTimezone: zone, startUtc: null, endUtc: null };
  }
  let start;
  let end;
  try {
    start = normalizeUserVisibleWallClockMinuteInput(startInput);
    end = normalizeUserVisibleWallClockMinuteInput(endInput);
  } catch (error) {
    const code = error?.code === 'WALL_CLOCK_INPUT_SECOND_MUST_BE_ZERO'
      ? 'ENERGY_FLOW_WORKBOOK_WALL_CLOCK_SECOND_MUST_BE_ZERO'
      : 'ENERGY_FLOW_WORKBOOK_WALL_CLOCK_INVALID';
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldPrefix, code, `${fieldPrefix} 必须使用 YYYY-MM-DD HH:mm:00 或历史 YYYY-MM-DDTHH:mm 来源墙钟格式，秒只能为 00。`, `${startInput}/${endInput}`));
    return { startWallClock: startInput, endWallClock: endInput, sourceTimezone: zone, startUtc: null, endUtc: null };
  }
  if (!isValidIanaTimezone(zone)) {
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, '来源时区', 'ENERGY_FLOW_WORKBOOK_TIMEZONE_INVALID', '来源时区必须是有效 IANA 时区。', zone));
    return { startWallClock: start, endWallClock: end, sourceTimezone: zone, startUtc: null, endUtc: null };
  }
  try {
    const converted = convertSourceWallClockRangeToUtc(start, end, zone);
    return { startWallClock: start, endWallClock: end, sourceTimezone: zone, startUtc: converted.startUtc, endUtc: converted.endUtc };
  } catch (error) {
    const code = error?.details?.code || error?.code || 'ENERGY_FLOW_WORKBOOK_WALL_CLOCK_INVALID';
    pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldPrefix, code, '来源墙钟区间无法无歧义转换为 UTC。', `${start}/${end}/${zone}`));
    return { startWallClock: start, endWallClock: end, sourceTimezone: zone, startUtc: null, endUtc: null };
  }
}

/** 将字段数组按固定标题映射为对象。 */
function mapWorkbookRow(sheetName, row) {
  const headers = ENERGY_FLOW_WORKBOOK_HEADERS[sheetName];
  const values = Array.isArray(row?.values) ? row.values : [];
  const result = { rowNumber: Number(row?.rowNumber), sheetName };
  headers.forEach((header, index) => { result[header] = values[index] === undefined || values[index] === null ? '' : values[index]; });
  return result;
}

/** 校验单个枚举字段。 */
function assertWorkbookEnum(issues, rowNumber, fieldName, value, values, required = true) {
  const text = normalizeWorkbookText(value);
  if (!text && !required) return text;
  if (!values.includes(text)) pushWorkbookIssue(issues,createWorkbookIssue(rowNumber, fieldName, 'ENERGY_FLOW_WORKBOOK_ENUM_INVALID', `${fieldName} 不是受支持的枚举值。`, value));
  return text;
}

/** 对外暴露稳定的递归安全 DTO 投影，阻断内部文件、安全链和候选见证。 */
function projectEnergyFlowWorkbookPublicDto(value, ancestors = new Set()) {
  const blocked = new Set([
    'fileSha256', 'previewSignature', 'previewAuditDigest', 'candidateRows', 'candidateRowIds',
    'candidateRowId', 'workbook', 'auditContext', 'previewAudit', 'witness', 'storedFilename',
    'filePath', 'sourceBatchId', 'sourceRowNumber', 'internalAudit', 'operationAudit',
    'importExecuteAudit', 'securityChain', 'signaturePayload', 'executeResult', 'hmac', 'hmacSecret',
    'installationHmac', 'installationHmacSecret'
  ]);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (ancestors.has(value)) return null;
  const next = new Set(ancestors); next.add(value);
  if (Array.isArray(value)) return value.map((item) => projectEnergyFlowWorkbookPublicDto(item, next));
  return Object.keys(value).reduce((result, key) => {
    if (blocked.has(key)) return result;
    result[key] = projectEnergyFlowWorkbookPublicDto(value[key], next);
    return result;
  }, {});
}

/** 生成模板用示例工作簿六张表数据。 */
function buildEnergyFlowWorkbookExamples() {
  return {
    模型: [['energy-flow-workbook', '1.0', 'DEMO-MODEL', '示例能流模型', '示例来源', 'DEMO-001', 'v1', '2026-01-01T00:00', '2027-01-01T00:00', 'Asia/Shanghai', 'workbook_facts', 'workbook_facts_only', 'active']],
    设备资产与节点: [
      ['asset', 'DEMO-MODEL', 'ASSET-001', '示例设备', 'production_device', '', '', '', '', '', '', '', '', 'active'],
      ['node', 'DEMO-MODEL', '', '', '', 'NODE-001', '示例入口', 'source', 'ASSET-001', 'plant_entry', '', 0, 0, 'active'],
      ['node', 'DEMO-MODEL', '', '', '', 'NODE-002', '示例出口', 'sink', '', 'useful_output', '', 100, 0, 'active']
    ],
    有向边: [['DEMO-MODEL', 'PATH-001', '示例路径', 1, 'EDGE-001', 'NODE-001', 'NODE-002', 'electricity', 'kWh', 'workbook_fact', 'demo:edge:001', 'active']],
    期间流量: [
      ['RECORD-001', 'DEMO-MODEL', 'edge_flow', 'EDGE-001', '', 'PATH-001', '', 'waste_heat', '2026-07-01T00:00', '2026-07-01T01:00', 'Asia/Shanghai', 'electricity', 1, 'kWh', 'demo:record:001'],
      ['RECORD-002', 'DEMO-MODEL', 'edge_flow', 'EDGE-001', '', 'PATH-001', '', 'loss', '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', 'electricity', 0.1, 'kWh', 'demo:record:002']
    ],
    余热事实: [['WASTE-001', 'DEMO-MODEL', 'RECORD-001', 'generation', 'demo:waste:001', 'active']],
    损耗证据: [['loss_fact', 'DEMO-MODEL', 'LOSS-001', 'RECORD-002', 'device_loss', '', '', '', '', '', '', '', '', '', '', 'active', ''], ['evidence', 'DEMO-MODEL', 'LOSS-001', '', '', 'EVIDENCE-001', 'fact_evidence', '示例证据', 'meter_record', 'demo:evidence:001', '2026-07-01T01:00', '2026-07-01T02:00', 'Asia/Shanghai', '', '', 'active', '']]
  };
}

module.exports = {
  ENERGY_FLOW_WORKBOOK_BACKUP_REASON,
  ENERGY_FLOW_WORKBOOK_CONFIRM_TEXT,
  ENERGY_FLOW_WORKBOOK_DUPLICATE_STRATEGY,
  ENERGY_FLOW_WORKBOOK_ENUMS,
  ENERGY_FLOW_WORKBOOK_HEADERS,
  ENERGY_FLOW_WORKBOOK_IMPORT_TYPE,
  ENERGY_FLOW_WORKBOOK_OPERATION,
  ENERGY_FLOW_WORKBOOK_RECORD_KIND,
  ENERGY_FLOW_WORKBOOK_RESOURCE_LIMITS,
  ENERGY_FLOW_WORKBOOK_SHEETS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_VERSION,
  ENERGY_FLOW_WORKBOOK_CODE_PATTERN,
  assertWorkbookEnum,
  buildEnergyFlowWorkbookExamples,
  createWorkbookIssue,
  isWorkbookBlank,
  mapWorkbookRow,
  requireWorkbookText,
  normalizeWorkbookCode,
  normalizeWorkbookKey,
  normalizeWorkbookNumber,
  normalizeWorkbookText,
  normalizeWorkbookVersion,
  normalizeWorkbookWallClockRange,
  projectEnergyFlowWorkbookPublicDto
};
