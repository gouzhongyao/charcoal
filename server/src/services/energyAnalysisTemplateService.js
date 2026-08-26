'use strict';

const path = require('path');
const { TextDecoder } = require('util');
const { parse: parseCsv } = require('csv-parse/sync');
const XLSX = require('xlsx');
const {
  ENERGY_FLOW_WORKBOOK_HEADERS,
  ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
  buildEnergyFlowWorkbookExamples
} = require('./energyFlowWorkbookContracts');

// CSV 模板必须按严格 UTF-8 解码，拒绝非法字节和本地编码误读。
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
// 单条 CSV 记录限制与中央导入解析器保持一致。
const MAX_CSV_RECORD_SIZE_BYTES = 64 * 1024;

// CSV 文件统一使用 UTF-8 BOM，保证中文标题在常见表格软件中正确显示。
const UTF8_BOM = '﻿';

// Excel 模板使用的标准 MIME 类型。
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// CSV 模板使用的标准 MIME 类型。
const CSV_MIME_TYPE = 'text/csv; charset=utf-8';

// 能流边模板固定要求的两个工作表名称。
const ENERGY_FLOW_EDGE_SHEET_NAMES = Object.freeze(['能流边', '显式边值']);
// TOU 方案模板固定要求的两个工作表名称。
const TOU_SCHEME_SHEET_NAMES = Object.freeze(['TOU方案', '时段规则']);
// 能效平衡配置模板固定要求的两个工作表名称。
const ENERGY_BALANCE_CONFIG_SHEET_NAMES = Object.freeze(['平衡边界', '九角色项目']);

// XLSX 解析资源上限统一冻结，避免超大文件、压缩炸弹和异常稀疏工作表耗尽本机资源。
const ENERGY_ANALYSIS_TEMPLATE_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxZipEntries: 256,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
  maxSheets: 8,
  maxRowsPerSheet: 10000,
  maxColumnsPerSheet: 128,
  maxTotalCells: 200000,
  maxIssues: 500
});

// 需要按有限数值解析的内部字段。
const NUMBER_COLUMN_KEYS = new Set([
  'granularityMinutes',
  'originalValue',
  'shiftStartMinute',
  'shiftEndMinute',
  'factorValue',
  'displayDivisor',
  'targetValue',
  'lowerBound',
  'upperBound',
  'frozenValue',
  'sampleCount',
  'startMinute',
  'endMinute',
  'dayOfWeek',
  'thresholdValue',
  'thresholdMin',
  'thresholdMax',
  'reductionRate',
  'minimumCoverageRate',
  'maxEvidenceItems',
  'explicitBalanceValue',
  'x',
  'y'
]);

/**
 * 根据内部字段键推导最小数据类型。
 * @param {string} key 内部 camelCase 键。
 * @returns {'text'|'number'|'utc'} 列数据类型。
 */
function inferColumnDataType(key) {
  if (key.endsWith('Utc') || key === 'frozenAt') {
    return 'utc';
  }
  if (NUMBER_COLUMN_KEYS.has(key)) {
    return 'number';
  }
  return 'text';
}

/**
 * 创建单列中文模板定义。
 * @param {string} name 中文列名。
 * @param {string} key 内部 camelCase 键。
 * @param {string[]} aliases 兼容别名。
 * @param {boolean} required 是否为结构必填列。
 * @param {string} description 中文填写说明。
 * @param {*} example 示例值。
 * @param {string[]} suspectedAliases 明确列出的疑似关键字段拼写错误。
 * @param {'text'|'number'|'utc'} dataType 最小列数据类型。
 * @returns {object} 冻结后的列定义。
 */
function createColumn(
  name,
  key,
  aliases,
  required,
  description,
  example,
  suspectedAliases = [],
  dataType = inferColumnDataType(key)
) {
  // 完整别名集合始终包含中文标题、camelCase 和 snake_case。
  const completeAliases = [name, key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), ...aliases];
  return Object.freeze({
    name,
    header: name,
    label: name,
    key,
    dataType,
    aliases: Object.freeze([...new Set(completeAliases)]),
    required,
    description,
    example,
    sample: example,
    suspectedAliases: Object.freeze([...new Set(suspectedAliases)])
  });
}

/**
 * 创建一个仅用于旧模板识别的弃用标题，命中后明确告警且不映射业务值。
 * @param {string} name 旧中文列名。
 * @param {string[]} aliases 旧列别名。
 * @param {string} message 中文弃用说明。
 * @returns {object} 冻结后的弃用标题定义。
 */
function createDeprecatedHeader(name, aliases, message) {
  return Object.freeze({
    name,
    aliases: Object.freeze([...new Set([name, ...aliases])]),
    message
  });
}

/**
 * 创建工作表定义并冻结标题顺序。
 * @param {string} name 中文工作表名称。
 * @param {object[]} columns 有序列定义。
 * @param {object[]} deprecatedHeaders 一个发布周期内兼容识别的旧标题。
 * @returns {object} 工作表定义。
 */
function createSheet(name, columns, deprecatedHeaders = []) {
  // 工作表标题严格由列定义顺序生成；弃用标题不进入新模板。
  const headers = columns.map((column) => column.name);
  return Object.freeze({
    name,
    columns: Object.freeze(columns),
    headers: Object.freeze(headers),
    deprecatedHeaders: Object.freeze(deprecatedHeaders)
  });
}

/** 创建固定六表工作簿工作表，保留多行示例但不开放表头别名。 */
function createStrictWorkbookSheet(name, headers, exampleRows) {
  const columns = headers.map((header, index) => createColumn(header, `fixedColumn${index + 1}`, [], true, '固定工作簿列，标题与顺序不得更改。', exampleRows[0]?.[index] ?? ''));
  return Object.freeze({
    name,
    columns: Object.freeze(columns),
    headers: Object.freeze([...headers]),
    deprecatedHeaders: Object.freeze([]),
    exampleRows: Object.freeze(exampleRows.map((row) => Object.freeze([...row])))
  });
}

// 十三类能源分析与配置模板定义使用无原型对象，避免特殊原型键被误识别为模板。
const ENERGY_ANALYSIS_TEMPLATE_DEFINITIONS = Object.freeze(Object.assign(Object.create(null), {
  'energy-timeseries': Object.freeze({
    id: 'energy-timeseries',
    name: '能耗时序数据导入模板',
    baseFileName: '能耗时序数据导入模板',
    asciiBaseFileName: 'nenghao-shixu-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('能耗时序', [
        createColumn('能源类型编码', 'energyTypeCode', ['能源编码', '能源类型', 'energy_type', 'energy_code'], true, '填写平台能源类型编码。', 'electricity', ['能源类型编玛', 'energytypecod']),
        createColumn('用能单元编码', 'organizationUnitCode', ['组织编码', '组织单元编码', 'unitCode', 'unit_code', 'organizationCode', 'organization_code'], false, '可填写已维护的用能单元编码。', 'OU-001'),
        createColumn('计量器具编码', 'meterCode', ['仪表编码', '表计编码', 'meterDeviceCode', 'meter_device_code', 'deviceCode', 'device_code'], false, '可填写已维护的计量器具编码。', 'M-001'),
        createColumn('开始时间（UTC）', 'startUtc', ['开始时间UTC', '开始时间', 'startTimeUtc', 'start_time_utc', 'start_time'], true, '填写带 Z 的 UTC 区间开始时间。', '2026-07-14T16:00:00Z', ['开始时问UTC', 'startut']),
        createColumn('结束时间（UTC）', 'endUtc', ['结束时间UTC', '结束时间', 'endTimeUtc', 'end_time_utc', 'end_time'], true, '填写带 Z 的 UTC 区间结束时间。', '2026-07-14T16:15:00Z', ['结束时问UTC', 'endut']),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('粒度（分钟）', 'granularityMinutes', ['粒度分钟', '时间粒度', 'intervalMinutes', 'interval_minutes', 'granularity'], true, '填写时序记录的分钟粒度。', 15, ['粒度分仲', 'granularityminute']),
        createColumn('原始单位', 'originalUnit', ['单位', '能源单位', 'sourceUnit', 'source_unit', 'unit'], true, '填写原始业务单位。', 'kWh'),
        createColumn('原始值', 'originalValue', ['数值', '用量', '能耗值', 'value', 'sourceValue', 'source_value'], true, '填写该区间的原始能耗值。', 25.5),
        createColumn('来源标识', 'sourceReference', ['来源引用', '数据来源标识', 'reference', 'sourceRef', 'source_ref'], true, '填写可追溯且稳定的来源标识。', 'upload:timeseries:001', ['来源标只', 'sourcereferenc']),
        createColumn('数据来源', 'dataSource', ['来源类型', '录入来源', 'data_source', 'sourceType', 'source_type'], false, '填写 manual、upload 或 calculation 等来源标记。', 'upload')
      ])
    ])
  }),
  'shift-definitions': Object.freeze({
    id: 'shift-definitions',
    name: '班次定义导入模板',
    baseFileName: '班次定义导入模板',
    asciiBaseFileName: 'banci-dingyi-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('班次定义', [
        createColumn('班次编码', 'shiftCode', ['班别编码', 'shift_code'], true, '填写稳定且唯一的班次业务编码。', 'QL-SHIFT-DAY'),
        createColumn('班次名称', 'shiftName', ['班别名称', 'shift_name'], true, '填写班次中文名称。', '青岚白班'),
        createColumn('开始分钟', 'startMinute', ['班次开始分钟', 'start_minute'], true, '填写来源时区本地自然日内开始分钟，范围 0 至 1439。', 480),
        createColumn('结束分钟', 'endMinute', ['班次结束分钟', 'end_minute'], true, '填写来源时区本地自然日内结束分钟，范围 0 至 1439。', 1200),
        createColumn('是否跨日', 'crossesMidnight', ['跨日', 'crosses_midnight'], true, '填写 0/1 或等价布尔值，并与起止分钟保持一致。', 0),
        createColumn('来源时区', 'sourceTimeZone', ['IANA时区', 'source_timezone'], true, '填写有效 IANA 来源时区；班次分钟按该时区的墙钟语义解释。', 'Asia/Shanghai'),
        createColumn('来源', 'source', ['定义来源'], true, '填写班次制度来源。', '青岚园区排班制度'),
        createColumn('版本', 'version', ['定义版本'], true, '填写不可混淆的班次版本。', 'QL-SHIFT:v1'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['有效开始时间', 'effective_start_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2025-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['有效结束时间', 'effective_end_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2027-01-01T00:00:00Z'),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'tou-schemes': Object.freeze({
    id: 'tou-schemes',
    name: 'TOU 方案与时段导入模板',
    baseFileName: 'TOU方案与时段导入模板',
    asciiBaseFileName: 'tou-fangan-shiduan-template',
    formats: Object.freeze(['xlsx']),
    sheets: Object.freeze([
      createSheet('TOU方案', [
        createColumn('方案编码', 'schemeCode', ['TOU方案编码', 'scheme_code'], true, '填写稳定且唯一的 TOU 方案编码。', 'QL-TOU-2026'),
        createColumn('方案名称', 'schemeName', ['TOU方案名称', 'scheme_name'], true, '填写 TOU 方案中文名称。', '青岚园区峰平谷方案'),
        createColumn('来源时区', 'sourceTimeZone', ['IANA时区', 'source_timezone'], true, '填写有效 IANA 来源时区；时段分钟按该时区墙钟语义解释。', 'Asia/Shanghai'),
        createColumn('来源', 'source', ['方案来源'], true, '填写方案业务来源。', '青岚园区用电制度'),
        createColumn('文号', 'documentNo', ['来源文号', 'document_no'], false, '可填写方案来源文号。', 'QL-TOU-2026-01'),
        createColumn('版本', 'version', ['方案版本'], true, '填写不可混淆的方案版本。', 'QL-TOU:v1'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['有效开始时间', 'effective_start_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2025-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['有效结束时间', 'effective_end_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2027-01-01T00:00:00Z'),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ]),
      createSheet('时段规则', [
        createColumn('方案编码', 'schemeCode', ['TOU方案编码', 'scheme_code'], true, '填写“TOU方案”工作表中对应的方案编码。', 'QL-TOU-2026'),
        createColumn('方案版本', 'schemeVersion', ['版本', 'scheme_version'], true, '填写“TOU方案”工作表中对应的版本。', 'QL-TOU:v1'),
        createColumn('星期序号', 'dayOfWeek', ['星期', 'day_of_week'], true, '填写 1 至 7 的整数。', 1),
        createColumn('时段类型', 'periodType', ['峰平谷类型', 'period_type'], true, '填写 peak、flat 或 valley。', 'valley'),
        createColumn('开始分钟', 'startMinute', ['start_minute'], true, '填写本地自然日内开始分钟，范围 0 至 1439。', 0),
        createColumn('结束分钟', 'endMinute', ['end_minute'], true, '填写结束分钟，范围 1 至 1440；每天规则必须完整覆盖 0 至 1440。', 480)
      ])
    ])
  }),
  'strategy-rules': Object.freeze({
    id: 'strategy-rules',
    name: '策略规则导入模板',
    baseFileName: '策略规则导入模板',
    asciiBaseFileName: 'celue-guize-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('策略规则', [
        createColumn('规则编码', 'ruleCode', ['strategyRuleCode', 'rule_code'], true, '填写稳定且唯一的规则编码。', 'QL-STRATEGY-PEAK'),
        createColumn('规则名称', 'ruleName', ['rule_name'], true, '填写规则中文名称。', '峰段能耗偏高提醒'),
        createColumn('规则版本', 'ruleVersion', ['rule_version'], true, '填写规则版本。', 'QL-STRATEGY:v1'),
        createColumn('公式版本', 'formulaVersion', ['formula_version'], true, '填写当前服务支持的固定公式版本。', 'load-analysis:v1'),
        createColumn('指标编码', 'metricCode', ['metric_code'], true, '填写 load_rate 或 peak_interval_energy。', 'peak_interval_energy'),
        createColumn('阈值操作符', 'thresholdOperator', ['operator', 'threshold_operator'], true, '填写 gt、gte、lt、lte 或 between。', 'gt'),
        createColumn('阈值', 'thresholdValue', ['threshold_value'], false, '非 between 操作符填写单一阈值。', 1000),
        createColumn('阈值下限', 'thresholdMin', ['threshold_min'], false, 'between 操作符填写下限。', ''),
        createColumn('阈值上限', 'thresholdMax', ['threshold_max'], false, 'between 操作符填写上限。', ''),
        createColumn('阈值单位', 'thresholdUnit', ['threshold_unit'], true, '填写指标阈值单位。', 'kWh'),
        createColumn('预计降幅', 'reductionRate', ['reduction_rate'], false, '可填写大于 0 且不超过 1 的比例。', 0.08),
        createColumn('优先级', 'priority', ['rule_priority'], true, '填写 low、medium 或 high。', 'high'),
        createColumn('最低覆盖率', 'minimumCoverageRate', ['minimum_coverage_rate'], false, '受控证据字段，填写 0 至 1 的覆盖率。', 0.95),
        createColumn('最大证据数', 'maxEvidenceItems', ['max_evidence_items'], false, '受控证据字段，填写有限正整数。', 10),
        createColumn('节省依据', 'savingBasis', ['saving_basis'], false, '受控证据字段，只允许填写 window_total_energy 或留空。', 'window_total_energy'),
        createColumn('建议内容', 'recommendationText', ['recommendation', 'recommendation_text'], true, '填写需人工复核的建议内容，不得宣称自动控制设备。', '建议复核峰段设备错峰安排。'),
        createColumn('来源', 'source', ['规则来源'], true, '填写规则来源。', '青岚园区能源制度'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['effective_start_utc'], true, '填写严格 UTC 秒精度时间。', '2025-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['effective_end_utc'], true, '填写严格 UTC 秒精度时间。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['IANA时区', 'source_timezone'], true, '填写有效 IANA 来源时区。', 'Asia/Shanghai'),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'shift-schedules': Object.freeze({
    id: 'shift-schedules',
    name: '排班计划导入模板',
    baseFileName: '排班计划导入模板',
    asciiBaseFileName: 'paiban-jihua-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('排班计划', [
        createColumn('班次编码', 'shiftCode', ['排班编码', '班别编码', 'shift', 'shift_code'], true, '填写稳定且唯一的班次编码。', 'DAY', ['班次编玛', 'shiftcod']),
        createColumn('班次名称', 'shiftName', ['排班名称', '班别名称', 'shift_name'], true, '填写中文班次名称。', '白班'),
        createColumn('班次开始分钟', 'shiftStartMinute', ['开始分钟', 'startMinute', 'start_minute', 'shift_start_minute'], true, '填写本地自然日内开始分钟。', 360),
        createColumn('班次结束分钟', 'shiftEndMinute', ['结束分钟', 'endMinute', 'end_minute', 'shift_end_minute'], true, '填写本地自然日内结束分钟。', 840),
        createColumn('是否跨日', 'crossesMidnight', ['跨日', '跨午夜', 'cross_midnight', 'isCrossMidnight', 'is_cross_midnight'], true, '填写 0/1 或等价布尔值，业务校验由后续导入服务处理。', 0),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('定义来源', 'definitionSource', ['来源', '班次来源', 'source', 'definition_source'], true, '填写班次定义来源。', '企业排班制度'),
        createColumn('定义版本', 'definitionVersion', ['版本', '班次版本', 'version', 'shiftVersion', 'shift_version'], true, '填写班次定义版本。', 'shift:v1'),
        createColumn('定义生效开始时间（UTC）', 'definitionEffectiveStartUtc', ['生效开始时间', 'effectiveStartUtc', 'effective_start_utc', 'definition_start_utc'], true, '填写班次定义生效区间开始时间。', '2026-01-01T00:00:00Z'),
        createColumn('定义生效结束时间（UTC）', 'definitionEffectiveEndUtc', ['生效结束时间', 'effectiveEndUtc', 'effective_end_utc', 'definition_end_utc'], true, '填写班次定义生效区间结束时间。', '2027-01-01T00:00:00Z'),
        createColumn('用能单元编码', 'organizationUnitCode', ['组织编码', '组织单元编码', 'unitCode', 'unit_code', 'organizationCode', 'organization_code'], true, '填写已维护且启用的排班所属用能单元编码。', 'OU-001'),
        createColumn('排班开始时间（UTC）', 'scheduleStartUtc', ['排班开始时间', 'startUtc', 'start_utc', 'schedule_start_utc'], true, '填写本次排班记录开始时间。', '2026-07-14T22:00:00Z', ['排班开始时问UTC', 'schedulestartut']),
        createColumn('排班结束时间（UTC）', 'scheduleEndUtc', ['排班结束时间', 'endUtc', 'end_utc', 'schedule_end_utc'], true, '填写本次排班记录结束时间。', '2026-07-15T06:00:00Z', ['排班结束时问UTC', 'scheduleendut']),
        createColumn('来源标识', 'sourceReference', ['来源引用', '数据来源标识', 'reference', 'sourceRef', 'source_ref'], true, '填写排班记录的可追溯来源标识。', 'upload:shift:001', ['来源标只', 'sourcereferenc']),
        createColumn('数据来源', 'dataSource', ['来源类型', '录入来源', 'data_source', 'sourceType', 'source_type'], false, '填写排班记录的数据来源。', 'upload'),
        createColumn('状态', 'status', ['启用状态', '记录状态', 'recordStatus', 'record_status'], false, '导入仅允许填写 active；作废必须走受控流程。', 'active')
      ])
    ])
  }),
  'device-states': Object.freeze({
    id: 'device-states',
    name: '设备状态导入模板',
    baseFileName: '设备状态导入模板',
    asciiBaseFileName: 'shebei-zhuangtai-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('设备状态', [
        createColumn('计量器具编码', 'meterCode', ['仪表编码', '表计编码', 'meterDeviceCode', 'meter_device_code', 'deviceCode', 'device_code'], true, '填写已维护的计量器具编码。', 'M-001', ['计量器具编玛', 'metercod']),
        createColumn('用能单元编码', 'organizationUnitCode', ['组织编码', '组织单元编码', 'unitCode', 'unit_code', 'organizationCode', 'organization_code'], true, '填写已维护且启用的 equipment 类型设备组织编码。', 'OU-001'),
        createColumn('设备状态', 'deviceState', ['运行状态', '状态', 'state', 'device_status', 'status'], true, '填写冻结契约中的设备状态编码。', 'running', ['设备壮态', 'devicestat']),
        createColumn('开始时间（UTC）', 'startUtc', ['开始时间UTC', '开始时间', 'startTimeUtc', 'start_time_utc', 'start_time'], true, '填写状态区间开始时间；区间在数据库 Unix 整秒边界下必须具有有效持续时间。', '2026-07-14T16:00:00Z', ['开始时问UTC', 'startut']),
        createColumn('结束时间（UTC）', 'endUtc', ['结束时间UTC', '结束时间', 'endTimeUtc', 'end_time_utc', 'end_time'], true, '填写状态区间结束时间；区间在数据库 Unix 整秒边界下必须具有有效持续时间。', '2026-07-14T17:00:00Z', ['结束时问UTC', 'endut']),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('来源标识', 'sourceReference', ['来源引用', '数据来源标识', 'reference', 'sourceRef', 'source_ref'], true, '填写状态记录的可追溯来源标识。', 'upload:device-state:001', ['来源标只', 'sourcereferenc']),
        createColumn('数据来源', 'dataSource', ['来源类型', '录入来源', 'data_source', 'sourceType', 'source_type'], false, '填写状态记录的数据来源。', 'upload')
      ])
    ])
  }),
  'energy-conversion-factors': Object.freeze({
    id: 'energy-conversion-factors',
    name: '能源折标系数导入模板',
    baseFileName: '能源折标系数导入模板',
    asciiBaseFileName: 'nengyuan-zhebiao-xishu-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('能源折标系数', [
        createColumn('系数编码', 'factorCode', ['折标系数编码', 'code', 'factor_code'], true, '填写稳定且唯一的折标系数编码。', 'ELEC-KGCE-2026', ['系数编玛', 'factorcod']),
        createColumn('能源类型编码', 'energyTypeCode', ['能源编码', '能源类型', 'energy_type', 'energy_code'], true, '填写平台能源类型编码。', 'electricity', ['能源类型编玛', 'energytypecod']),
        createColumn('源单位', 'sourceUnit', ['原始单位', '能源单位', 'unit', 'source_unit'], true, '填写折算前单位。', 'kWh'),
        createColumn('折标系数值', 'factorValue', ['系数值', '折算系数', 'value', 'factor_value'], true, '填写折算到 kgce 的系数值。', 0.1229),
        createColumn('目标单位', 'targetUnit', ['折标单位', 'target_unit'], true, '填写折标目标单位。', 'kgce'),
        createColumn('展示单位', 'displayUnit', ['显示单位', 'display_unit'], false, '填写页面展示单位。', 'tce'),
        createColumn('展示除数', 'displayDivisor', ['显示除数', '换算除数', 'display_divisor'], false, '填写 kgce 到展示单位的除数。', 1000),
        createColumn('来源', 'source', ['系数来源', '数据来源'], true, '填写标准或业务来源名称。', '企业能源折标制度'),
        createColumn('文号', 'documentNo', ['来源文号', '标准文号', 'documentNumber', 'document_number', 'document_no'], true, '填写来源文号或标准编号。', 'Q/EA-2026', ['文昊', 'documentn']),
        createColumn('版本', 'version', ['系数版本', 'factorVersion', 'factor_version'], true, '填写稳定版本标识。', 'electricity-factor:v1'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['有效开始时间', '生效开始', 'effectiveFrom', 'effective_from', 'effective_start_utc'], true, '填写有效期开始时间。', '2026-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['有效结束时间', '生效结束', 'effectiveTo', 'effective_to', 'effective_end_utc'], true, '填写有效期结束时间。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('状态', 'status', ['启用状态', '记录状态', 'recordStatus', 'record_status'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'energy-benchmark-definitions': Object.freeze({
    id: 'energy-benchmark-definitions',
    name: '能效对标定义导入模板',
    baseFileName: '能效对标定义导入模板',
    asciiBaseFileName: 'nengxiao-duibiao-dingyi-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('对标定义', [
        createColumn('对标编码', 'benchmarkCode', ['标准编码', '标杆编码', 'code', 'benchmark_code'], true, '填写稳定且唯一的对标编码。', 'BENCH-ENERGY-001', ['对标编玛', 'benchmarkcod']),
        createColumn('对标名称', 'benchmarkName', ['标准名称', '标杆名称', 'name', 'benchmark_name'], true, '填写中文对标名称。', '单位产品综合能耗基准'),
        createColumn('对标类型', 'benchmarkType', ['标准类型', '标杆类型', 'type', 'benchmark_type'], true, '填写外部标准、人工标杆或内部历史基准编码。', 'external_standard', ['对标类形', 'benchmarktyp']),
        createColumn('指标编码', 'metricCode', ['指标', 'metric', 'metric_code'], true, '填写被比较指标编码。', 'energy_intensity', ['指标编玛', 'metriccod']),
        createColumn('指标单位', 'unit', ['单位', 'metricUnit', 'metric_unit'], true, '填写指标单位。', 'kgce/t'),
        createColumn('周期类型', 'periodType', ['统计周期', '周期', 'period', 'period_type'], true, '填写指标统计周期类型。', 'month'),
        createColumn('范围类型', 'scopeType', ['适用范围类型', 'scope_type'], true, '填写组织、行业或产品等范围类型。', 'organization'),
        createColumn('范围标识', 'scopeReference', ['适用范围', '范围引用', 'scope', 'scopeRef', 'scope_ref', 'scope_reference'], true, '填写可追溯范围标识。', 'OU-001', ['范围标只', 'scopereferenc']),
        createColumn('指标方向', 'direction', ['比较方向', 'benchmarkDirection', 'benchmark_direction'], true, '填写 lower_better、higher_better 或 range。', 'lower_better', ['指标方问', 'directio']),
        createColumn('来源', 'source', ['标准来源', '标杆来源'], true, '填写标准或标杆来源。', '行业标准'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['有效开始时间', '生效开始', 'effectiveFrom', 'effective_from', 'effective_start_utc'], true, '填写定义有效期开始时间。', '2026-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['有效结束时间', '生效结束', 'effectiveTo', 'effective_to', 'effective_end_utc'], true, '填写定义有效期结束时间。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('状态', 'status', ['启用状态', '记录状态', 'recordStatus', 'record_status'], false, '填写 active 或 inactive。', 'active')
      ], [
        createDeprecatedHeader('文号', ['documentNo', '来源文号', '标准文号', 'documentNumber', 'document_number', 'document_no'], '旧模板文号列已弃用，列值将被忽略；用户不再维护对标文号。'),
        createDeprecatedHeader('版本', ['version', '对标版本', 'benchmarkVersion', 'benchmark_version'], '旧模板定义版本列已弃用，列值将被忽略；内部修订和兼容版本由服务端生成。')
      ])
    ])
  }),
  'energy-benchmark-targets': Object.freeze({
    id: 'energy-benchmark-targets',
    name: '能效对标目标导入模板',
    baseFileName: '能效对标目标导入模板',
    asciiBaseFileName: 'nengxiao-duibiao-mubiao-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('对标目标', [
        createColumn('对标编码', 'benchmarkCode', ['标准编码', '标杆编码', 'code', 'benchmark_code'], true, '填写唯一 active 定义的对标编码。', 'BENCH-ENERGY-001', ['对标编玛', 'benchmarkcod']),
        createColumn('目标值', 'targetValue', ['标准值', '标杆值', 'value', 'target_value'], false, '非区间方向填写单一目标值。', 120),
        createColumn('下限值', 'lowerBound', ['范围下限', '最小值', 'lower', 'minValue', 'min_value', 'lower_bound'], false, 'range 方向填写下限值。', ''),
        createColumn('上限值', 'upperBound', ['范围上限', '最大值', 'upper', 'maxValue', 'max_value', 'upper_bound'], false, 'range 方向填写上限值。', ''),
        createColumn('参考期开始时间（UTC）', 'referenceStartUtc', ['参考开始时间', 'referenceFrom', 'reference_from', 'reference_start_utc'], false, '内部历史基准可填写参考期开始时间。', ''),
        createColumn('参考期结束时间（UTC）', 'referenceEndUtc', ['参考结束时间', 'referenceTo', 'reference_to', 'reference_end_utc'], false, '内部历史基准可填写参考期结束时间。', ''),
        createColumn('固化值', 'frozenValue', ['冻结值', 'snapshotValue', 'snapshot_value', 'frozen_value'], false, '内部历史基准固化后填写的值。', ''),
        createColumn('固化时间（UTC）', 'frozenAt', ['冻结时间', 'snapshotAt', 'snapshot_at', 'frozen_at'], false, '内部历史基准固化时间。', ''),
        createColumn('样本数量', 'sampleCount', ['样本数', 'sampleMonthCount', 'sample_month_count', 'sample_count'], false, '填写内部基准样本数量。', ''),
        createColumn('产量摘要 JSON', 'productionSummaryJson', ['产量摘要', 'productionSummary', 'production_summary', 'production_summary_json'], false, '填写内部基准产量摘要 JSON。', ''),
        createColumn('来源数据摘要', 'sourceDataDigest', ['数据摘要', '来源摘要', 'digest', 'sourceDigest', 'source_digest', 'source_data_digest'], false, '填写内部基准来源数据摘要。', ''),
        createColumn('是否固化', 'isFrozen', ['固化', '冻结标识', 'frozen', 'is_frozen'], false, '填写 0/1 或等价布尔值。', 0),
        createColumn('是否自动刷新', 'autoRefresh', ['自动刷新', 'auto_refresh'], false, '填写 0/1 或等价布尔值。', 0),
        createColumn('状态', 'status', ['启用状态', '记录状态', 'recordStatus', 'record_status'], false, '填写 active 或 inactive。', 'active')
      ], [
        createDeprecatedHeader('对标定义版本', ['benchmarkVersion', '定义版本', 'benchmark_definition_version', 'definitionVersion', 'definition_version'], '旧模板对标定义版本列已弃用，列值将被忽略；目标仅按对标编码匹配唯一 active 定义。'),
        createDeprecatedHeader('目标版本', ['version', '版本', 'targetVersion', 'target_version'], '旧模板目标版本列已弃用，列值将被忽略；内部修订和兼容版本由服务端生成。')
      ])
    ])
  }),
  [ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE]: Object.freeze({
    id: ENERGY_FLOW_WORKBOOK_TEMPLATE_TYPE,
    name: '完整能流工作簿模板',
    baseFileName: '完整能流工作簿模板',
    asciiBaseFileName: 'energy-flow-workbook-template',
    templateVersion: '1.0',
    formats: Object.freeze(['xlsx']),
    sheets: Object.freeze([
      createStrictWorkbookSheet('模型', ENERGY_FLOW_WORKBOOK_HEADERS.模型, buildEnergyFlowWorkbookExamples().模型),
      createStrictWorkbookSheet('设备资产与节点', ENERGY_FLOW_WORKBOOK_HEADERS.设备资产与节点, buildEnergyFlowWorkbookExamples().设备资产与节点),
      createStrictWorkbookSheet('有向边', ENERGY_FLOW_WORKBOOK_HEADERS.有向边, buildEnergyFlowWorkbookExamples().有向边),
      createStrictWorkbookSheet('期间流量', ENERGY_FLOW_WORKBOOK_HEADERS.期间流量, buildEnergyFlowWorkbookExamples().期间流量),
      createStrictWorkbookSheet('余热事实', ENERGY_FLOW_WORKBOOK_HEADERS.余热事实, buildEnergyFlowWorkbookExamples().余热事实),
      createStrictWorkbookSheet('损耗证据', ENERGY_FLOW_WORKBOOK_HEADERS.损耗证据, buildEnergyFlowWorkbookExamples().损耗证据)
    ])
  }),
  'energy-flow-models': Object.freeze({
    id: 'energy-flow-models',
    name: '能流模型导入模板',
    baseFileName: '能流模型导入模板',
    asciiBaseFileName: 'nengliu-moxing-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('能流模型', [
        createColumn('模型编码', 'modelCode', ['能流模型编码', 'model_code'], true, '填写稳定且唯一的能流模型编码。', 'QL-FLOW-PARK'),
        createColumn('模型名称', 'modelName', ['能流模型名称', 'model_name'], true, '填写模型中文名称。', '青岚园区综合能流模型'),
        createColumn('来源', 'source', ['模型来源'], true, '填写模型业务来源。', '青岚园区能源审计'),
        createColumn('文号', 'documentNo', ['模型文号', 'document_no'], false, '可填写模型来源文号。', 'QL-FLOW-2026-01'),
        createColumn('版本', 'version', ['模型版本'], true, '填写不可混淆的模型版本。', 'QL-FLOW:v1'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['effective_start_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2025-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['effective_end_utc'], true, '填写严格 UTC 秒精度时间，尾部必须为 Z。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['IANA时区', 'source_timezone'], true, '填写有效 IANA 来源时区。', 'Asia/Shanghai'),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'energy-balance-configs': Object.freeze({
    id: 'energy-balance-configs',
    name: '能效平衡配置导入模板',
    baseFileName: '能效平衡配置导入模板',
    asciiBaseFileName: 'nengxiao-pingheng-peizhi-template',
    formats: Object.freeze(['xlsx']),
    sheets: Object.freeze([
      createSheet('平衡边界', [
        createColumn('边界编码', 'boundaryCode', ['balanceBoundaryCode', 'boundary_code'], true, '填写稳定且唯一的平衡边界编码。', 'QL-BAL-PARK'),
        createColumn('边界名称', 'boundaryName', ['boundary_name'], true, '填写边界中文名称。', '青岚园区综合能效平衡边界'),
        createColumn('组织编码', 'organizationUnitCode', ['用能单元编码', 'organization_unit_code'], false, '可填写已维护的组织业务编码，不填写数据库 ID。', 'QL-PARK'),
        createColumn('来源', 'source', ['边界来源'], true, '填写边界业务来源。', '青岚园区能源审计'),
        createColumn('文号', 'documentNo', ['来源文号', 'document_no'], false, '可填写来源文号。', 'QL-BAL-2026-01'),
        createColumn('版本', 'version', ['边界版本'], true, '填写不可混淆的边界版本。', 'QL-BAL:v1'),
        createColumn('生效开始时间（UTC）', 'effectiveStartUtc', ['effective_start_utc'], true, '填写严格 UTC 秒精度时间。', '2025-01-01T00:00:00Z'),
        createColumn('生效结束时间（UTC）', 'effectiveEndUtc', ['effective_end_utc'], true, '填写严格 UTC 秒精度时间。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['IANA时区', 'source_timezone'], true, '填写有效 IANA 来源时区。', 'Asia/Shanghai'),
        createColumn('发电边界确认', 'generationBoundaryConfirmed', ['generation_boundary_confirmed'], true, '填写 0/1 或等价布尔值，明确发电防重复计入口。', 1),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ]),
      createSheet('九角色项目', [
        createColumn('边界编码', 'boundaryCode', ['boundary_code'], true, '填写“平衡边界”工作表中的边界编码。', 'QL-BAL-PARK'),
        createColumn('边界版本', 'boundaryVersion', ['boundary_version'], true, '填写“平衡边界”工作表中的版本。', 'QL-BAL:v1'),
        createColumn('项目编码', 'itemCode', ['balanceItemCode', 'item_code'], true, '填写边界内唯一项目编码。', 'QL-BAL-INPUT-E'),
        createColumn('项目名称', 'itemName', ['item_name'], true, '填写项目中文名称。', '园区外购电输入'),
        createColumn('角色', 'role', ['balanceRole'], true, '填写九角色之一。', 'input'),
        createColumn('能源类型编码', 'energyTypeCode', ['energy_type_code'], true, '填写平台能源类型业务编码。', 'electricity'),
        createColumn('原始单位', 'originalUnit', ['单位', 'original_unit'], true, '填写与能源类型匹配的原始单位。', 'kWh'),
        createColumn('来源类型', 'sourceType', ['source_type'], true, '填写 timeseries、monthly_energy、generation、explicit_edge_value 或 explicit_balance_value。', 'monthly_energy'),
        createColumn('来源引用', 'sourceReference', ['sourceMappingReference', 'source_reference'], true, '填写后续导入服务可解析的业务定位 reference。', 'monthly-energy:QL-PARK:electricity'),
        createColumn('来源记录定位', 'sourceRecordLocator', ['recordLocator', 'source_record_locator'], false, '可填写逗号分隔业务定位值；不得填写 SQLite 自增 ID。', 'organization=QL-PARK;month=2026-07'),
        createColumn('时序来源标识', 'timeseriesSourceReference', ['timeseries_source_reference'], false, 'timeseries 来源可填写稳定来源标识。', ''),
        createColumn('发电数值字段', 'generationValueField', ['valueField', 'generation_value_field'], false, 'generation 来源按角色填写 self_use_value_kwh 或 grid_export_value_kwh。', ''),
        createColumn('显式平衡值', 'explicitBalanceValue', ['explicit_balance_value'], false, 'explicit_balance_value 来源可填写非负数值。', ''),
        createColumn('发电防重复键', 'generationAntiDoubleCountKey', ['generation_anti_double_count_key'], false, 'generation 来源必须填写同边界唯一防重复键。', ''),
        createColumn('状态', 'status', ['启用状态'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'energy-flow-nodes': Object.freeze({
    id: 'energy-flow-nodes',
    name: '能流节点导入模板',
    baseFileName: '能流节点导入模板',
    asciiBaseFileName: 'nengliu-jiedian-template',
    formats: Object.freeze(['xlsx', 'csv']),
    sheets: Object.freeze([
      createSheet('能流节点', [
        createColumn('模型编码', 'modelCode', ['能流模型编码', 'flowModelCode', 'flow_model_code', 'model_code'], true, '填写稳定且唯一的能流模型编码。', 'FLOW-001', ['模型编玛', 'modelcod']),
        createColumn('模型名称', 'modelName', ['能流模型名称', 'flowModelName', 'flow_model_name', 'model_name'], true, '填写中文能流模型名称。', '一厂电力能流模型'),
        createColumn('模型来源', 'modelSource', ['来源', '能流模型来源', 'source', 'model_source'], true, '填写能流模型来源。', '企业能源审计'),
        createColumn('模型文号', 'modelDocumentNo', ['文号', '来源文号', 'documentNo', 'document_no', 'model_document_no'], false, '可填写模型来源文号。', 'EA-FLOW-2026'),
        createColumn('模型版本', 'modelVersion', ['版本', 'flowModelVersion', 'flow_model_version', 'model_version'], true, '填写模型版本。', 'energy-flow:v1'),
        createColumn('模型生效开始时间（UTC）', 'modelEffectiveStartUtc', ['生效开始时间', 'effectiveStartUtc', 'effective_start_utc', 'model_start_utc'], true, '填写模型有效期开始时间。', '2026-01-01T00:00:00Z'),
        createColumn('模型生效结束时间（UTC）', 'modelEffectiveEndUtc', ['生效结束时间', 'effectiveEndUtc', 'effective_end_utc', 'model_end_utc'], true, '填写模型有效期结束时间。', '2027-01-01T00:00:00Z'),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('节点编码', 'nodeCode', ['能流节点编码', 'code', 'node_code'], true, '填写模型内唯一节点编码。', 'GRID-IN', ['节点编玛', 'nodecod']),
        createColumn('节点名称', 'nodeName', ['能流节点名称', 'name', 'node_name'], true, '填写中文节点名称。', '电网输入'),
        createColumn('节点类型', 'nodeType', ['能流节点类型', 'type', 'node_type'], true, '填写冻结契约中的节点类型编码。', 'source', ['节点类形', 'nodetyp']),
        createColumn('用能单元编码', 'organizationUnitCode', ['组织编码', '组织单元编码', 'unitCode', 'unit_code', 'organizationCode', 'organization_code'], false, '可填写节点关联的用能单元编码。', 'OU-001'),
        createColumn('横坐标', 'x', ['X坐标', '坐标X', 'positionX', 'position_x'], true, '填写 SVG 横坐标。', 80),
        createColumn('纵坐标', 'y', ['Y坐标', '坐标Y', 'positionY', 'position_y'], true, '填写 SVG 纵坐标。', 120),
        createColumn('状态', 'status', ['启用状态', '节点状态', 'recordStatus', 'record_status'], false, '填写 active 或 inactive。', 'active')
      ])
    ])
  }),
  'energy-flow-edges': Object.freeze({
    id: 'energy-flow-edges',
    name: '能流边及显式边值导入模板',
    baseFileName: '能流边及显式边值导入模板',
    asciiBaseFileName: 'nengliu-bian-xianshi-bianzhi-template',
    formats: Object.freeze(['xlsx']),
    sheets: Object.freeze([
      createSheet('能流边', [
        createColumn('模型编码', 'modelCode', ['能流模型编码', 'flowModelCode', 'flow_model_code', 'model_code'], true, '填写已维护的能流模型编码。', 'FLOW-001', ['模型编玛', 'modelcod']),
        createColumn('模型版本', 'modelVersion', ['版本', 'flowModelVersion', 'flow_model_version', 'model_version'], true, '填写被引用能流模型版本。', 'energy-flow:v1'),
        createColumn('边编码', 'edgeCode', ['能流边编码', 'code', 'edge_code'], true, '填写模型内唯一边编码。', 'GRID-TO-WORKSHOP', ['边编玛', 'edgecod']),
        createColumn('起点节点编码', 'fromNodeCode', ['来源节点编码', '起始节点编码', 'sourceNodeCode', 'source_node_code', 'from_node_code'], true, '填写显式起点节点编码。', 'GRID-IN', ['起点节点编玛', 'fromnodecod']),
        createColumn('终点节点编码', 'toNodeCode', ['目标节点编码', '结束节点编码', 'targetNodeCode', 'target_node_code', 'to_node_code'], true, '填写显式终点节点编码。', 'WORKSHOP-A', ['终点节点编玛', 'tonodecod']),
        createColumn('能源类型编码', 'energyTypeCode', ['能源编码', '能源类型', 'energy_type', 'energy_code'], true, '填写平台能源类型编码。', 'electricity', ['能源类型编玛', 'energytypecod']),
        createColumn('单位', 'unit', ['能源单位', 'originalUnit', 'original_unit'], true, '填写该边的原始单位。', 'kWh'),
        createColumn('来源类型', 'sourceType', ['数据来源类型', 'source', 'source_type'], true, '填写 timeseries、monthly_energy、generation 或 explicit_edge_value。', 'explicit_edge_value', ['来源类形', 'sourcetyp']),
        createColumn('来源标识', 'sourceReference', ['来源引用', '映射标识', 'reference', 'sourceRef', 'source_ref'], true, '填写显式来源映射 reference。', 'explicit-edge:GRID-TO-WORKSHOP', ['来源标只', 'sourcereferenc']),
        createColumn('状态', 'status', ['启用状态', '边状态', 'recordStatus', 'record_status'], false, '填写 active 或 inactive。', 'active')
      ]),
      createSheet('显式边值', [
        createColumn('模型编码', 'modelCode', ['能流模型编码', 'flowModelCode', 'flow_model_code', 'model_code'], true, '填写已维护的能流模型编码。', 'FLOW-001', ['模型编玛', 'modelcod']),
        createColumn('模型版本', 'modelVersion', ['版本', 'flowModelVersion', 'flow_model_version', 'model_version'], true, '填写被引用能流模型版本。', 'energy-flow:v1'),
        createColumn('边编码', 'edgeCode', ['能流边编码', 'code', 'edge_code'], true, '填写已维护的能流边编码。', 'GRID-TO-WORKSHOP', ['边编玛', 'edgecod']),
        createColumn('开始时间（UTC）', 'startUtc', ['开始时间UTC', '开始时间', 'startTimeUtc', 'start_time_utc', 'start_time'], true, '填写显式边值区间开始时间。', '2026-07-01T00:00:00Z', ['开始时问UTC', 'startut']),
        createColumn('结束时间（UTC）', 'endUtc', ['结束时间UTC', '结束时间', 'endTimeUtc', 'end_time_utc', 'end_time'], true, '填写显式边值区间结束时间。', '2026-08-01T00:00:00Z', ['结束时问UTC', 'endut']),
        createColumn('来源时区', 'sourceTimeZone', ['时区', 'IANA时区', 'timezone', 'time_zone', 'sourceTimezone', 'source_timezone'], true, '填写 IANA 来源时区。', 'Asia/Shanghai', ['来源时曲', 'sourcetimezon']),
        createColumn('原始单位', 'originalUnit', ['单位', '能源单位', 'sourceUnit', 'source_unit', 'unit'], true, '填写显式边值原始单位。', 'kWh'),
        createColumn('原始值', 'originalValue', ['数值', '边值', 'value', 'sourceValue', 'source_value'], true, '填写显式边值。', 1000),
        createColumn('来源标识', 'sourceReference', ['来源引用', '映射标识', 'reference', 'sourceRef', 'source_ref'], true, '填写显式边值来源 reference。', 'upload:explicit-edge:001', ['来源标只', 'sourcereferenc']),
        createColumn('公式版本', 'formulaVersion', ['计算版本', 'formula', 'formula_version'], true, '填写能流公式版本。', 'energy-flow:v1', ['公式版木', 'formulaversio']),
        createColumn('记录状态', 'recordStatus', ['状态', '数据状态', 'status', 'record_status'], false, '填写 active 或 void；作废业务校验由后续服务处理。', 'active')
      ])
    ])
  })
}));

/**
 * 规范化模板 ID 或带扩展名的模板名称。
 * @param {*} templateId 模板标识。
 * @returns {string} 规范化模板标识。
 */
function normalizeTemplateId(templateId) {
  return String(templateId || '').trim().replace(/\.(csv|xlsx)$/i, '').toLowerCase();
}

/**
 * 按冻结规则规范化表头：去空格、下划线、连字符、斜杠和中英文括号后转小写。
 * @param {*} value 原始表头。
 * @returns {string} 规范化表头。
 */
function normalizeTemplateHeader(value) {
  return String(value || '')
    .trim()
    .replace(/[\s_\-\/\\()（）]/g, '')
    .toLowerCase();
}

/**
 * 读取指定模板定义。
 * @param {*} templateId 模板标识。
 * @returns {object|null} 模板定义或空值。
 */
function getEnergyAnalysisTemplateDefinition(templateId) {
  // 查询前先验证自有属性，特殊原型键一律按不存在处理。
  const normalizedTemplateId = normalizeTemplateId(templateId);
  if (!Object.prototype.hasOwnProperty.call(ENERGY_ANALYSIS_TEMPLATE_DEFINITIONS, normalizedTemplateId)) {
    return null;
  }
  // 内部定义保留 sheets，单工作表定义同时提供旧调用模型使用的直接字段。
  const template = ENERGY_ANALYSIS_TEMPLATE_DEFINITIONS[normalizedTemplateId];
  const singleSheet = template.sheets.length === 1 ? template.sheets[0] : null;
  return Object.freeze({
    ...template,
    sheetName: singleSheet ? singleSheet.name : null,
    headers: singleSheet ? singleSheet.headers : null,
    rows: singleSheet ? Object.freeze([Object.freeze(singleSheet.columns.map((column) => column.example))]) : null
  });
}

/**
 * 列出十三类能源分析与配置模板元数据。
 * @returns {object[]} 模板元数据列表。
 */
function listEnergyAnalysisTemplates() {
  return Object.values(ENERGY_ANALYSIS_TEMPLATE_DEFINITIONS).map((template) => ({
    id: template.id,
    type: template.id,
    name: template.name,
    formats: [...template.formats],
    fileName: `${template.baseFileName}.xlsx`,
    asciiFileName: `${template.asciiBaseFileName}.xlsx`,
    sheetNames: template.sheets.map((sheet) => sheet.name),
    sheets: template.sheets.map((sheet) => ({
      name: sheet.name,
      headers: [...sheet.headers],
      columns: sheet.columns
    }))
  }));
}

/**
 * 创建携带稳定 code 的模板错误。
 * @param {string} code 错误码。
 * @param {string} message 中文错误说明。
 * @param {object} details 错误详情。
 * @returns {Error} 模板错误。
 */
function createTemplateError(code, message, details = {}) {
  // 原生 Error 保持独立服务不依赖中央错误模块。
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/**
 * 读取模板中的指定工作表定义。
 * @param {object} template 模板定义。
 * @param {string|null} sheetName 工作表名称。
 * @returns {object} 工作表定义。
 */
function resolveSheetDefinition(template, sheetName) {
  if (sheetName) {
    // 多工作表按中文名称精确匹配，不做自动猜测。
    const matchedSheet = template.sheets.find((sheet) => sheet.name === sheetName);
    if (!matchedSheet) {
      throw createTemplateError('TEMPLATE_SHEET_NOT_FOUND', '模板工作表不存在。', {
        templateId: template.id,
        sheetName,
        expectedSheetNames: template.sheets.map((sheet) => sheet.name)
      });
    }
    return matchedSheet;
  }
  if (template.sheets.length !== 1) {
    throw createTemplateError('TEMPLATE_SHEET_REQUIRED', '多工作表模板必须明确指定工作表名称。', {
      templateId: template.id,
      expectedSheetNames: template.sheets.map((sheet) => sheet.name)
    });
  }
  return template.sheets[0];
}

/**
 * 判断单元格是否为空白。
 * @param {*} value 单元格值。
 * @returns {boolean} 是否为空白。
 */
function isBlankCell(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 判断两个同义表头值是否等价。
 * @param {*} left 左值。
 * @param {*} right 右值。
 * @returns {boolean} 是否等价。
 */
function areEquivalentCellValues(left, right) {
  if (isBlankCell(left) && isBlankCell(right)) {
    return true;
  }
  return String(left).trim() === String(right).trim();
}

/**
 * 为工作表构造别名索引与明确拼写错误索引。
 * @param {object} sheet 工作表定义。
 * @returns {{ aliasIndex: Map<string, object>, typoIndex: Map<string, object> }} 两类表头索引。
 */
function buildSheetHeaderIndexes(sheet) {
  // 合法别名索引用于精确映射。
  const aliasIndex = new Map();
  // 明确拼写错误索引只覆盖静态列举项，不做模糊猜测。
  const typoIndex = new Map();
  // 弃用标题只生成 warning，绝不进入业务字段映射。
  const deprecatedIndex = new Map();
  sheet.columns.forEach((column) => {
    column.aliases.forEach((alias) => {
      const normalizedAlias = normalizeTemplateHeader(alias);
      const existingColumn = aliasIndex.get(normalizedAlias);
      if (normalizedAlias && existingColumn && existingColumn.key !== column.key) {
        throw createTemplateError('DUPLICATE_TEMPLATE_ALIAS', '模板列别名存在冲突。', {
          sheetName: sheet.name,
          alias,
          keys: [existingColumn.key, column.key]
        });
      }
      if (normalizedAlias) {
        aliasIndex.set(normalizedAlias, column);
      }
    });
    column.suspectedAliases.forEach((alias) => {
      const normalizedAlias = normalizeTemplateHeader(alias);
      if (normalizedAlias && !aliasIndex.has(normalizedAlias)) {
        typoIndex.set(normalizedAlias, column);
      }
    });
  });
  (sheet.deprecatedHeaders || []).forEach((deprecatedHeader) => {
    deprecatedHeader.aliases.forEach((alias) => {
      const normalizedAlias = normalizeTemplateHeader(alias);
      if (normalizedAlias && !aliasIndex.has(normalizedAlias)) {
        deprecatedIndex.set(normalizedAlias, deprecatedHeader);
      }
    });
  });
  return { aliasIndex, typoIndex, deprecatedIndex };
}

/**
 * 限制问题数量并用稳定问题码标记截断。
 * @param {object[]} issues 原始问题列表。
 * @returns {object[]} 受限问题列表。
 */
function limitTemplateIssues(issues) {
  if (issues.length <= ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxIssues) {
    return issues;
  }
  const limitedIssues = issues.slice(0, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxIssues - 1);
  limitedIssues.push({
    code: 'TEMPLATE_ISSUE_LIMIT_EXCEEDED',
    severity: 'error',
    blocking: true,
    message: `模板问题数量超过上限 ${ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxIssues}，其余问题已截断。`
  });
  return limitedIssues;
}

/**
 * 按列索引先验验证工作表标题，避免同名标题被对象键静默覆盖。
 * @param {*} templateId 模板标识。
 * @param {*} headers 原始标题数组。
 * @param {{ sheetName?: string }} options 验证选项。
 * @returns {object} 标题验证结果与列描述。
 */
function validateTemplateHeaders(templateId, headers, options = {}) {
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  const sheet = resolveSheetDefinition(template, options.sheetName || null);
  const rawHeaders = Array.isArray(headers) ? headers.map((header) => String(header ?? '')) : [];
  const { aliasIndex, typoIndex, deprecatedIndex } = buildSheetHeaderIndexes(sheet);
  const rawHeaderIndexes = new Map();
  const normalizedHeaderIndexes = new Map();
  const keyIndexes = new Map();
  const issues = [];

  const columns = rawHeaders.map((rawHeader, columnIndex) => {
    const normalizedHeader = normalizeTemplateHeader(rawHeader);
    const column = aliasIndex.get(normalizedHeader) || null;
    const descriptor = {
      columnIndex,
      rawHeader,
      normalizedHeader,
      key: column ? column.key : null,
      column
    };

    rawHeaderIndexes.set(rawHeader, [...(rawHeaderIndexes.get(rawHeader) || []), columnIndex]);
    normalizedHeaderIndexes.set(
      normalizedHeader,
      [...(normalizedHeaderIndexes.get(normalizedHeader) || []), columnIndex]
    );

    if (column) {
      keyIndexes.set(column.key, [...(keyIndexes.get(column.key) || []), columnIndex]);
      return descriptor;
    }

    const deprecatedHeader = deprecatedIndex.get(normalizedHeader);
    if (deprecatedHeader) {
      issues.push({
        code: 'DEPRECATED_BENCHMARK_HEADER_IGNORED',
        severity: 'warning',
        blocking: false,
        sheetName: sheet.name,
        columnIndex,
        header: rawHeader,
        message: deprecatedHeader.message
      });
      return descriptor;
    }

    const suspectedColumn = typoIndex.get(normalizedHeader);
    if (suspectedColumn) {
      issues.push({
        code: 'SUSPECTED_CRITICAL_HEADER_TYPO',
        severity: 'error',
        blocking: true,
        sheetName: sheet.name,
        columnIndex,
        header: rawHeader,
        expectedKey: suspectedColumn.key,
        expectedHeader: suspectedColumn.name,
        message: `疑似关键字段“${suspectedColumn.name}”拼写错误，请使用模板中的精确中文标题或已支持别名。`
      });
    } else {
      issues.push({
        code: 'UNKNOWN_HEADER',
        severity: 'warning',
        blocking: false,
        sheetName: sheet.name,
        columnIndex,
        header: rawHeader,
        message: `未知列“${rawHeader}”将被忽略。`
      });
    }
    return descriptor;
  });

  rawHeaderIndexes.forEach((columnIndexes, rawHeader) => {
    if (columnIndexes.length > 1) {
      issues.push({
        code: 'DUPLICATE_RAW_HEADER',
        severity: 'error',
        blocking: true,
        sheetName: sheet.name,
        header: rawHeader,
        columnIndexes,
        message: `工作表中存在重复原始标题“${rawHeader}”。`
      });
    }
  });
  normalizedHeaderIndexes.forEach((columnIndexes, normalizedHeader) => {
    if (columnIndexes.length > 1) {
      issues.push({
        code: 'DUPLICATE_NORMALIZED_HEADER',
        severity: 'error',
        blocking: true,
        sheetName: sheet.name,
        normalizedHeader,
        headers: columnIndexes.map((columnIndex) => rawHeaders[columnIndex]),
        columnIndexes,
        message: '工作表中存在规范化后重复的标题。'
      });
    }
  });
  keyIndexes.forEach((columnIndexes, key) => {
    if (columnIndexes.length > 1) {
      issues.push({
        code: 'AMBIGUOUS_HEADER_MAPPING',
        severity: 'error',
        blocking: true,
        sheetName: sheet.name,
        key,
        headers: columnIndexes.map((columnIndex) => rawHeaders[columnIndex]),
        columnIndexes,
        message: `多个标题同时映射到内部字段“${key}”。`
      });
    }
  });

  const mappedKeys = new Set(columns.filter((descriptor) => descriptor.key).map((descriptor) => descriptor.key));
  sheet.columns.filter((column) => column.required && !mappedKeys.has(column.key)).forEach((column) => {
    issues.push({
      code: 'MISSING_REQUIRED_HEADER',
      severity: 'error',
      blocking: true,
      sheetName: sheet.name,
      key: column.key,
      expectedHeader: column.name,
      message: `缺少必需结构列“${column.name}”。`
    });
  });

  const limitedIssues = limitTemplateIssues(issues);
  return {
    templateId: template.id,
    sheetName: sheet.name,
    headers: rawHeaders,
    columns,
    issues: limitedIssues,
    blockingIssues: limitedIssues.filter((issue) => issue.blocking),
    warnings: limitedIssues.filter((issue) => issue.severity === 'warning'),
    valid: limitedIssues.every((issue) => !issue.blocking)
  };
}

/**
 * 将 Excel 日期序列转换为严格 UTC ISO 字符串。
 * @param {number} serial Excel 日期序列。
 * @returns {string|null} ISO 时间或空值。
 */
function excelSerialToIso(serial) {
  if (!Number.isFinite(serial)) {
    return null;
  }
  const milliseconds = Math.round(serial * 86400000);
  const date = new Date(Date.UTC(1899, 11, 30) + milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 按列 dataType 规范化 XLSX 单元格。
 * @param {*} value 原始单元格值。
 * @param {object} column 列定义。
 * @returns {{ value: *, valid: boolean }} 规范化结果。
 */
function normalizeWorkbookCellValue(value, column) {
  if (isBlankCell(value)) {
    return { value: null, valid: true };
  }
  if (column.dataType === 'text') {
    return { value: String(value), valid: true };
  }
  if (column.dataType === 'number') {
    const numberValue = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(numberValue)
      ? { value: numberValue, valid: true }
      : { value: null, valid: false };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { value: null, valid: false }
      : { value: value.toISOString(), valid: true };
  }
  if (typeof value === 'number') {
    const isoValue = excelSerialToIso(value);
    return isoValue
      ? { value: isoValue, valid: true }
      : { value: null, valid: false };
  }
  return { value: String(value).trim(), valid: true };
}

/**
 * 按标题列描述和单元格索引解析一行 XLSX 数据。
 * @param {*} templateId 模板标识。
 * @param {*} cells 原始单元格数组。
 * @param {object} headerValidation 标题先验验证结果。
 * @param {{ sourceRowNumber?: number }} options 行解析选项。
 * @returns {object} 行映射结果。
 */
function resolveTemplateCells(templateId, cells, headerValidation, options = {}) {
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  const sourceRowNumber = Number.isInteger(options.sourceRowNumber) && options.sourceRowNumber >= 1
    ? options.sourceRowNumber
    : null;
  const rowCells = Array.isArray(cells) ? cells : [];
  const mapped = { sourceRowNumber };
  const fieldMapping = {};
  const fieldValues = {};
  const issues = [];

  headerValidation.columns.forEach((descriptor) => {
    if (!descriptor.column) {
      return;
    }
    const { column, rawHeader, columnIndex } = descriptor;
    const normalizedCell = normalizeWorkbookCellValue(rowCells[columnIndex], column);
    fieldMapping[column.key] = fieldMapping[column.key] || [];
    fieldMapping[column.key].push(rawHeader);
    fieldValues[column.key] = fieldValues[column.key] || [];
    fieldValues[column.key].push(normalizedCell.value);

    if (!normalizedCell.valid) {
      issues.push({
        code: 'INVALID_TEMPLATE_CELL_TYPE',
        severity: 'error',
        blocking: true,
        sheetName: headerValidation.sheetName,
        sourceRowNumber,
        columnIndex,
        header: rawHeader,
        key: column.key,
        dataType: column.dataType,
        message: `字段“${column.name}”不能按 ${column.dataType} 类型解析。`
      });
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(mapped, column.key) || isBlankCell(mapped[column.key])) {
      mapped[column.key] = normalizedCell.value;
      return;
    }
    if (isBlankCell(normalizedCell.value) || areEquivalentCellValues(mapped[column.key], normalizedCell.value)) {
      return;
    }
    issues.push({
      code: 'AMBIGUOUS_HEADER_VALUE',
      severity: 'error',
      blocking: true,
      sheetName: headerValidation.sheetName,
      sourceRowNumber,
      key: column.key,
      headers: [...fieldMapping[column.key]],
      values: [...fieldValues[column.key]],
      message: `同一字段“${column.name}”由多个同义表头提供了冲突值。`
    });
  });

  const limitedIssues = limitTemplateIssues(issues);
  return {
    templateId: template.id,
    sheetName: headerValidation.sheetName,
    sourceRowNumber,
    mapped,
    record: mapped,
    fieldMapping,
    issues: limitedIssues,
    blockingIssues: limitedIssues.filter((issue) => issue.blocking),
    warnings: limitedIssues.filter((issue) => issue.severity === 'warning'),
    valid: limitedIssues.every((issue) => !issue.blocking)
  };
}

/**
 * 将输入行精确映射为内部 camelCase，并返回结构问题。
 * @param {*} templateId 模板标识。
 * @param {object} inputRow 原始行对象。
 * @param {{ sourceRowNumber?: number, sheetName?: string }} options 映射选项。
 * @returns {object} 映射结果。
 */
function resolveTemplateRow(templateId, inputRow, options = {}) {
  // 模板定义必须存在。
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  // 多工作表模板必须通过 sheetName 选择字段集合。
  const sheet = resolveSheetDefinition(template, options.sheetName || null);
  // 输入对象异常时按空行处理，保持纯函数稳定。
  const row = inputRow && typeof inputRow === 'object' && !Array.isArray(inputRow) ? inputRow : {};
  // 来源行号优先采用调用方选项，也兼容输入行携带的 camelCase 或 snake_case 元数据。
  const rowSourceNumber = row.sourceRowNumber ?? row.source_row_number;
  const sourceRowNumber = Number.isInteger(options.sourceRowNumber) && options.sourceRowNumber >= 1
    ? options.sourceRowNumber
    : (Number.isInteger(rowSourceNumber) && rowSourceNumber >= 1 ? rowSourceNumber : null);
  // 别名和拼写错误索引用于精确分类表头。
  const { aliasIndex, typoIndex, deprecatedIndex } = buildSheetHeaderIndexes(sheet);
  // 内部映射对象只使用 camelCase key。
  const mapped = { sourceRowNumber };
  // 字段映射保留每个内部键对应的全部来源标题。
  const fieldMapping = {};
  // 结构问题同时承载 warning 与 blocking error。
  const issues = [];

  Object.entries(row).forEach(([rawHeader, value]) => {
    // 来源行号是解析元数据，不参与业务列映射，也不产生未知列告警。
    if (rawHeader === 'sourceRowNumber' || rawHeader === 'source_row_number') {
      return;
    }
    // 原始空标题按未知普通列处理。
    const normalizedHeader = normalizeTemplateHeader(rawHeader);
    const column = aliasIndex.get(normalizedHeader);
    if (!column) {
      const deprecatedHeader = deprecatedIndex.get(normalizedHeader);
      if (deprecatedHeader) {
        issues.push({
          code: 'DEPRECATED_BENCHMARK_HEADER_IGNORED',
          severity: 'warning',
          blocking: false,
          sourceRowNumber,
          header: rawHeader,
          message: deprecatedHeader.message
        });
        return;
      }
      // 仅静态列出的关键拼写错误升级为 blocking issue。
      const suspectedColumn = typoIndex.get(normalizedHeader);
      if (suspectedColumn) {
        issues.push({
          code: 'SUSPECTED_CRITICAL_HEADER_TYPO',
          severity: 'error',
          blocking: true,
          sourceRowNumber,
          header: rawHeader,
          expectedKey: suspectedColumn.key,
          expectedHeader: suspectedColumn.name,
          message: `疑似关键字段“${suspectedColumn.name}”拼写错误，请使用模板中的精确中文标题或已支持别名。`
        });
      } else {
        issues.push({
          code: 'UNKNOWN_HEADER',
          severity: 'warning',
          blocking: false,
          sourceRowNumber,
          header: rawHeader,
          message: `未知列“${rawHeader}”将被忽略。`
        });
      }
      return;
    }

    // 每个内部键保留命中的来源标题列表。
    fieldMapping[column.key] = fieldMapping[column.key] || [];
    fieldMapping[column.key].push(rawHeader);
    if (!Object.prototype.hasOwnProperty.call(mapped, column.key) || isBlankCell(mapped[column.key])) {
      mapped[column.key] = value;
      return;
    }
    if (isBlankCell(value) || areEquivalentCellValues(mapped[column.key], value)) {
      return;
    }

    // 同一行同义表头出现不同非空值时必须阻断，不能静默选择。
    issues.push({
      code: 'AMBIGUOUS_HEADER_VALUE',
      severity: 'error',
      blocking: true,
      sourceRowNumber,
      key: column.key,
      headers: [...fieldMapping[column.key]],
      values: fieldMapping[column.key].map((header) => row[header]),
      message: `同一字段“${column.name}”由多个同义表头提供了冲突值。`
    });
  });

  // blocking 与 warning 视图便于 preview 服务直接消费。
  const blockingIssues = issues.filter((issue) => issue.blocking);
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return {
    templateId: template.id,
    sheetName: sheet.name,
    sourceRowNumber,
    mapped,
    record: mapped,
    fieldMapping,
    issues,
    blockingIssues,
    warnings,
    valid: blockingIssues.length === 0
  };
}

/**
 * 转义单个 CSV 单元格。
 * @param {*} value 单元格值。
 * @returns {string} 双引号包裹后的 CSV 单元格。
 */
function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * 将单工作表定义渲染为带 BOM 的 CSV Buffer。
 * @param {object} sheet 工作表定义。
 * @returns {Buffer} CSV Buffer。
 */
function renderCsvBuffer(sheet, rows = null) {
  // 未传入业务数据时继续使用冻结示例行；演示目录可注入多行数据但不得改变标题契约。
  const dataRows = Array.isArray(rows)
    ? rows
    : (Array.isArray(sheet.exampleRows) ? sheet.exampleRows : [sheet.columns.map((column) => column.example)]);
  // CSV 尾部固定保留单个换行，避免尾随空格。
  const csv = [sheet.headers, ...dataRows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\n');
  return Buffer.from(`${UTF8_BOM}${csv}\n`, 'utf8');
}

/**
 * 根据标题和示例值计算 Excel 列宽。
 * @param {object} sheet 工作表定义。
 * @returns {object[]} Excel 列宽配置。
 */
function buildColumnWidths(sheet, rows = null) {
  // 演示目录注入多行数据时也按真实单元格宽度计算，但仍限制最大列宽。
  const dataRows = Array.isArray(rows)
    ? rows
    : (Array.isArray(sheet.exampleRows) ? sheet.exampleRows : [sheet.columns.map((column) => column.example)]);
  return sheet.columns.map((column, columnIndex) => ({
    wch: Math.min(Math.max(
      String(column.name).length + 4,
      ...dataRows.map((row) => String(row[columnIndex] ?? '').length + 4),
      12
    ), 40)
  }));
}

/**
 * 将模板的全部工作表渲染为 Excel Buffer。
 * @param {object} template 模板定义。
 * @returns {Buffer} Excel Buffer。
 */
function renderXlsxBuffer(template, workbookRows = null) {
  // 新建工作簿并逐张追加，多工作表模板不得退化为只写第一张表或增加说明表。
  const workbook = XLSX.utils.book_new();
  template.sheets.forEach((sheet) => {
    // 用户可见首行只使用中文标题；演示目录可按工作表名称注入多行数据。
    const rows = workbookRows && Array.isArray(workbookRows[sheet.name])
      ? workbookRows[sheet.name]
      : (Array.isArray(sheet.exampleRows) ? sheet.exampleRows : [sheet.columns.map((column) => column.example)]);
    const worksheet = XLSX.utils.aoa_to_sheet([sheet.headers, ...rows]);
    worksheet['!cols'] = buildColumnWidths(sheet, rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 生成能源分析模板文件及下载元数据。
 * @param {*} templateId 模板标识。
 * @param {*} format 文件格式。
 * @returns {object} 模板文件结果。
 */
function generateEnergyAnalysisTemplate(templateId, format = 'xlsx', options = {}) {
  // 模板必须已登记。
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  // 格式允许携带点号或大小写。
  const normalizedFormat = String(format || 'xlsx').trim().replace(/^\./, '').toLowerCase();
  if (!template.formats.includes(normalizedFormat)) {
    throw createTemplateError('TEMPLATE_FORMAT_UNSUPPORTED', '该模板不支持请求的文件格式。', {
      templateId: template.id,
      format: normalizedFormat,
      supportedFormats: [...template.formats]
    });
  }
  // CSV 仅适用于单工作表模板，模板 8 明确禁止降级。
  if (normalizedFormat === 'csv' && template.sheets.length !== 1) {
    throw createTemplateError('TEMPLATE_FORMAT_UNSUPPORTED', '多工作表模板仅支持 XLSX，不能降级为 CSV。', {
      templateId: template.id,
      format: normalizedFormat,
      supportedFormats: [...template.formats]
    });
  }

  // 文件体按目标格式生成 Buffer；自定义行只用于内存生成演示文件，不改变冻结模板定义。
  const customRows = Array.isArray(options.rows) ? options.rows : null;
  const customWorkbookRows = options.workbooks && typeof options.workbooks === 'object'
    ? options.workbooks
    : null;
  const buffer = normalizedFormat === 'csv'
    ? renderCsvBuffer(template.sheets[0], customRows)
    : renderXlsxBuffer(
      template,
      customWorkbookRows || (customRows ? { [template.sheets[0].name]: customRows } : null)
    );
  // 中文文件名用于 filename*，ASCII 文件名用于旧客户端 fallback。
  const fileName = `${template.baseFileName}.${normalizedFormat}`;
  const asciiFileName = `${template.asciiBaseFileName}.${normalizedFormat}`;
  // 工作表元数据不包含英文用户可见标题。
  const sheets = template.sheets.map((sheet) => ({
    name: sheet.name,
    headers: [...sheet.headers],
    columnCount: sheet.columns.length,
    exampleRowCount: customWorkbookRows && Array.isArray(customWorkbookRows[sheet.name])
      ? customWorkbookRows[sheet.name].length
      : (customRows && template.sheets.length === 1 ? customRows.length : (Array.isArray(sheet.exampleRows) ? sheet.exampleRows.length : 1))
  }));
  // 单工作表兼容字段保留现有调用模型所需的 sheetName 与 headers。
  const singleSheet = template.sheets.length === 1 ? template.sheets[0] : null;
  return {
    templateId: template.id,
    type: template.id,
    template,
    format: normalizedFormat,
    buffer,
    body: buffer,
    csv: normalizedFormat === 'csv' ? buffer.toString('utf8') : null,
    mimeType: normalizedFormat === 'csv' ? CSV_MIME_TYPE : XLSX_MIME_TYPE,
    fileName,
    filename: fileName,
    asciiFileName,
    asciiFilename: asciiFileName,
    fallbackFileName: asciiFileName,
    sheetName: singleSheet ? singleSheet.name : null,
    headers: singleSheet ? [...singleSheet.headers] : null,
    sheets,
    sheetMetadata: sheets
  };
}

/**
 * 生成 CSV 模板，保持与现有模板服务的单格式调用方式兼容。
 * @param {*} templateId 模板标识。
 * @returns {object} CSV 模板结果。
 */
function getEnergyAnalysisTemplateCsv(templateId) {
  return generateEnergyAnalysisTemplate(templateId, 'csv');
}

/**
 * 生成 XLSX 模板，保持与现有模板服务的单格式调用方式兼容。
 * @param {*} templateId 模板标识。
 * @returns {object} XLSX 模板结果。
 */
function getEnergyAnalysisTemplateXlsx(templateId) {
  return generateEnergyAnalysisTemplate(templateId, 'xlsx');
}

/**
 * 精确验证模板工作表集合，不允许缺失、额外或重复名称。
 * @param {*} templateId 模板标识。
 * @param {*} sheetNames 实际工作表名称数组。
 * @returns {object} 集合验证结果。
 */
function validateTemplateSheetCollection(templateId, sheetNames) {
  // 模板定义必须存在。
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  // 非数组输入按空集合处理并产生缺失问题。
  const actualSheetNames = Array.isArray(sheetNames) ? sheetNames.map((name) => String(name)) : [];
  // 预期名称保持冻结顺序。
  const expectedSheetNames = template.sheets.map((sheet) => sheet.name);
  // 名称计数用于识别重复工作表。
  const counts = new Map();
  actualSheetNames.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  // 集合差异采用精确字符串比较。
  const missingSheetNames = expectedSheetNames.filter((name) => !counts.has(name));
  const extraSheetNames = [...new Set(actualSheetNames.filter((name) => !expectedSheetNames.includes(name)))];
  const duplicateSheetNames = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  // 每类结构错误生成独立 blocking issue。
  const issues = [];
  missingSheetNames.forEach((name) => issues.push({
    code: 'MISSING_TEMPLATE_SHEET',
    severity: 'error',
    blocking: true,
    sheetName: name,
    message: `缺少必需工作表“${name}”。`
  }));
  extraSheetNames.forEach((name) => issues.push({
    code: 'EXTRA_TEMPLATE_SHEET',
    severity: 'error',
    blocking: true,
    sheetName: name,
    message: `存在不允许的额外工作表“${name}”。`
  }));
  duplicateSheetNames.forEach((name) => issues.push({
    code: 'DUPLICATE_TEMPLATE_SHEET',
    severity: 'error',
    blocking: true,
    sheetName: name,
    message: `工作表“${name}”重复。`
  }));
  return {
    templateId: template.id,
    valid: issues.length === 0,
    expectedSheetNames,
    actualSheetNames,
    missingSheetNames,
    extraSheetNames,
    duplicateSheetNames,
    issues
  };
}

/**
 * 抛出稳定的工作簿资源上限错误。
 * @param {string} limitType 上限类型。
 * @param {number} actual 实际值。
 * @param {number} limit 上限值。
 * @returns {never} 始终抛出错误。
 */
function throwWorkbookLimitError(limitType, actual, limit) {
  throw createTemplateError('TEMPLATE_WORKBOOK_LIMIT_EXCEEDED', '模板工作簿超过允许的资源上限。', {
    limitType,
    actual,
    limit
  });
}

/**
 * 从 ZIP 文件尾部定位中央目录结束记录。
 * @param {Buffer} buffer XLSX ZIP Buffer。
 * @returns {number} EOCD 偏移量。
 */
function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

/**
 * 在 SheetJS 解压前检查 XLSX ZIP 中央目录和解压规模。
 * @param {Buffer} buffer XLSX ZIP Buffer。
 * @returns {object} ZIP 统计信息。
 */
function inspectXlsxZipContainer(buffer) {
  if (buffer.length > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxFileBytes) {
    throw createTemplateError('TEMPLATE_FILE_TOO_LARGE', '模板文件超过允许的字节上限。', {
      actual: buffer.length,
      limit: ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxFileBytes
    });
  }
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0x4b50) {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }

  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    eocdOffset + 22 + commentLength > buffer.length ||
    centralDirectoryOffset + centralDirectorySize > eocdOffset
  ) {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throwWorkbookLimitError('zip64', entryCount, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipEntries);
  }
  if (entryCount > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipEntries) {
    throwWorkbookLimitError('zipEntries', entryCount, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipEntries);
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
    }
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    if (uncompressedSize === 0xffffffff) {
      throwWorkbookLimitError('zip64Entry', uncompressedSize, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipUncompressedBytes);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipUncompressedBytes) {
      throwWorkbookLimitError(
        'zipUncompressedBytes',
        totalUncompressedBytes,
        ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipUncompressedBytes
      );
    }
    cursor += 46 + fileNameLength + extraLength + fileCommentLength;
    if (cursor > eocdOffset) {
      throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
    }
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }
  return { entryCount, totalUncompressedBytes };
}

/**
 * 检查解析后工作簿的工作表、行列和总单元格上限。
 * @param {object} workbook Excel 工作簿。
 * @returns {object} 工作簿统计信息。
 */
function inspectWorkbookResources(workbook) {
  if (!workbook || !Array.isArray(workbook.SheetNames) || !workbook.Sheets || typeof workbook.Sheets !== 'object') {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }
  if (workbook.SheetNames.length > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxSheets) {
    throwWorkbookLimitError('sheets', workbook.SheetNames.length, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxSheets);
  }

  let totalCells = 0;
  const sheets = [];
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet || typeof worksheet !== 'object') {
      throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
    }
    let rowCount = 0;
    let columnCount = 0;
    if (worksheet['!ref']) {
      let range;
      try {
        range = XLSX.utils.decode_range(worksheet['!ref']);
      } catch (_error) {
        throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
      }
      rowCount = range.e.r - range.s.r + 1;
      columnCount = range.e.c - range.s.c + 1;
    }
    if (rowCount > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxRowsPerSheet) {
      throwWorkbookLimitError('rowsPerSheet', rowCount, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxRowsPerSheet);
    }
    if (columnCount > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet) {
      throwWorkbookLimitError('columnsPerSheet', columnCount, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet);
    }
    totalCells += rowCount * columnCount;
    if (totalCells > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxTotalCells) {
      throwWorkbookLimitError('totalCells', totalCells, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxTotalCells);
    }
    sheets.push({ name: sheetName, rowCount, columnCount });
  });
  return { sheetCount: workbook.SheetNames.length, totalCells, sheets };
}

/**
 * 将 Buffer 或工作簿对象读取为 Excel 工作簿。
 * @param {*} input Excel Buffer、Uint8Array、ArrayBuffer 或工作簿对象。
 * @returns {{ workbook: object, resources: object }} Excel 工作簿及资源统计。
 */
function readWorkbookInput(input) {
  if (input && Array.isArray(input.SheetNames) && input.Sheets) {
    return { workbook: input, resources: inspectWorkbookResources(input) };
  }
  let buffer;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    buffer = Buffer.from(input);
  } else if (input instanceof ArrayBuffer) {
    buffer = Buffer.from(input);
  } else {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_INPUT', '多工作表解析只接受 XLSX Buffer 或工作簿对象。');
  }

  const zipResources = inspectXlsxZipContainer(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (_error) {
    throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
  }
  return {
    workbook,
    resources: {
      ...inspectWorkbookResources(workbook),
      fileBytes: buffer.length,
      zipEntries: zipResources.entryCount,
      zipUncompressedBytes: zipResources.totalUncompressedBytes
    }
  };
}

/**
 * 扫描 CSV 中每条非空逻辑记录的物理起始行号。
 * @param {string} text 已严格解码的 CSV 文本。
 * @returns {number[]} 包含表头在内的逻辑记录起始行号。
 */
function collectCsvRecordStartLines(text) {
  // 行号扫描只识别 CSV 引号和换行，不把带引号的内嵌换行误判为新记录。
  const recordStartLines = [];
  let recordStartIndex = 0;
  let recordStartLine = 1;
  let currentLine = 1;
  let inQuotes = false;

  // 空白物理行与 csv-parse 的 skip_empty_lines 行为保持一致。
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
    if (!isLineFeed && !isBareCarriageReturn) {
      continue;
    }
    if (!inQuotes) {
      const endIndex = isLineFeed && index > 0 && text[index - 1] === '\r' ? index - 1 : index;
      appendRecord(endIndex);
      recordStartIndex = index + 1;
      recordStartLine = currentLine + 1;
    }
    currentLine += 1;
  }
  if (recordStartIndex < text.length) {
    appendRecord(text.length);
  }
  return recordStartLines;
}

/**
 * 从原始 Buffer 按列索引解析单工作表 CSV 模板。
 * @param {*} templateId 模板标识。
 * @param {Buffer|Uint8Array} input CSV 原始内容。
 * @returns {object} 与 XLSX 模板解析一致的结构化结果。
 */
function parseEnergyAnalysisTemplateCsv(templateId, input) {
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  if (!template.formats.includes('csv') || template.sheets.length !== 1) {
    throw createTemplateError('TEMPLATE_FORMAT_UNSUPPORTED', '该模板不支持 CSV 格式。', {
      templateId: template.id,
      format: 'csv',
      supportedFormats: [...template.formats]
    });
  }
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw createTemplateError('INVALID_TEMPLATE_CSV_INPUT', 'CSV 模板解析只接受 Buffer 或 Uint8Array。');
  }

  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxFileBytes) {
    throw createTemplateError('TEMPLATE_FILE_TOO_LARGE', '模板文件超过允许的字节上限。', {
      actual: buffer.length,
      limit: ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxFileBytes
    });
  }

  let text;
  try {
    text = UTF8_DECODER.decode(buffer);
  } catch (error) {
    throw createTemplateError('INVALID_TEMPLATE_CSV_ENCODING', 'CSV 模板必须使用 UTF-8 编码。', {
      message: error.message
    });
  }

  let records;
  try {
    records = parseCsv(buffer, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: MAX_CSV_RECORD_SIZE_BYTES
    });
  } catch (error) {
    throw createTemplateError('INVALID_TEMPLATE_CSV_FORMAT', 'CSV 模板解析失败。', {
      parserCode: error.code,
      message: error.message
    });
  }

  const parsedRecords = Array.isArray(records) ? records : [];
  if (parsedRecords.length > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxRowsPerSheet) {
    throwWorkbookLimitError(
      'rowsPerSheet',
      parsedRecords.length,
      ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxRowsPerSheet
    );
  }
  const headers = (parsedRecords[0] || []).map((header) => String(header ?? ''));
  if (headers.length > ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet) {
    throwWorkbookLimitError(
      'columnsPerSheet',
      headers.length,
      ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet
    );
  }

  const sheet = template.sheets[0];
  const collection = validateTemplateSheetCollection(template.id, [sheet.name]);
  const headerValidation = validateTemplateHeaders(template.id, headers, { sheetName: sheet.name });
  const recordStartLines = collectCsvRecordStartLines(text.replace(/^﻿/, ''));
  const indexedRows = parsedRecords.slice(1).map((cells, index) => {
    const rowCells = Array.isArray(cells) ? [...cells] : [];
    if (rowCells.length > headers.length) {
      throw createTemplateError('TEMPLATE_CSV_COLUMN_COUNT_MISMATCH', 'CSV 数据行列数不能超过表头列数。', {
        sourceRowNumber: recordStartLines[index + 1] || index + 2,
        headerColumnCount: headers.length,
        rowColumnCount: rowCells.length
      });
    }
    return {
      cells: rowCells.length < headers.length
        ? [...rowCells, ...Array(headers.length - rowCells.length).fill('')]
        : rowCells,
      sourceRowNumber: recordStartLines[index + 1] || index + 2
    };
  });
  const resolvedRows = indexedRows.map(({ cells, sourceRowNumber }) => resolveTemplateCells(
    template.id,
    cells,
    headerValidation,
    { sourceRowNumber }
  ));
  const issues = limitTemplateIssues([
    ...collection.issues,
    ...headerValidation.issues,
    ...resolvedRows.flatMap((result) => result.issues)
  ]);
  const sheetResult = {
    name: sheet.name,
    headers,
    headerValidation,
    headerIssues: headerValidation.issues,
    rawRows: indexedRows.map(({ cells }) => cells),
    rows: resolvedRows.map((result) => result.record),
    resolvedRows,
    issues: limitTemplateIssues([
      ...headerValidation.issues,
      ...resolvedRows.flatMap((result) => result.issues)
    ]),
    blockingIssues: issues.filter((issue) => issue.blocking),
    warnings: issues.filter((issue) => issue.severity === 'warning')
  };
  return {
    templateId: template.id,
    fileType: 'csv',
    valid: issues.every((issue) => !issue.blocking),
    sheetNames: [sheet.name],
    expectedSheetNames: collection.expectedSheetNames,
    sheetCollection: collection,
    resources: {
      fileBytes: buffer.length,
      sheetCount: 1,
      totalCells: parsedRecords.length * headers.length,
      sheets: [{ name: sheet.name, rowCount: parsedRecords.length, columnCount: headers.length }]
    },
    sheets: [sheetResult],
    sheetsByName: { [sheet.name]: sheetResult },
    issues,
    blockingIssues: issues.filter((issue) => issue.blocking),
    warnings: issues.filter((issue) => issue.severity === 'warning')
  };
}

/**
 * 按原始文件扩展名选择规范 CSV 或 XLSX 模板解析入口。
 * @param {*} templateId 模板标识。
 * @param {*} input 原始文件 Buffer。
 * @param {*} originalFilename 原始文件名。
 * @returns {object} 统一模板解析结果。
 */
function parseEnergyAnalysisTemplateBuffer(templateId, input, originalFilename) {
  const extension = path.extname(String(originalFilename || '')).toLowerCase();
  if (extension === '.csv') {
    return parseEnergyAnalysisTemplateCsv(templateId, input);
  }
  if (extension === '.xlsx') {
    return { ...parseEnergyAnalysisTemplateWorkbook(templateId, input), fileType: 'xlsx' };
  }
  throw createTemplateError('TEMPLATE_FORMAT_UNSUPPORTED', '能源分析模板仅支持已声明的 CSV 或 XLSX 格式。', {
    templateId,
    extension
  });
}

/**
 * 解析能源分析 XLSX 的全部工作表并逐行执行字段映射。
 * @param {*} templateId 模板标识。
 * @param {*} input Excel Buffer 或工作簿对象。
 * @returns {object} 多工作表解析结果。
 */
function parseEnergyAnalysisTemplateWorkbook(templateId, input) {
  // 模板与工作簿都必须可读取。
  const template = getEnergyAnalysisTemplateDefinition(templateId);
  if (!template) {
    throw createTemplateError('TEMPLATE_NOT_FOUND', '能源分析模板不存在。', { templateId });
  }
  const { workbook, resources } = readWorkbookInput(input);
  // 先做完整集合验证，单工作表和双工作表模板都不允许额外工作表。
  const collection = validateTemplateSheetCollection(template.id, workbook.SheetNames);
  // 每张实际存在且被定义的工作表都独立解析。
  const sheets = template.sheets
    .filter((sheet) => workbook.Sheets[sheet.name])
    .map((sheet) => {
      let matrix;
      try {
        // AOA 必须保留重复标题和原始列索引，不能先压缩为对象。
        matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheet.name], {
          header: 1,
          blankrows: true,
          defval: null,
          raw: true
        });
      } catch (_error) {
        throw createTemplateError('INVALID_TEMPLATE_WORKBOOK_FORMAT', '模板文件不是有效的 XLSX 工作簿。');
      }
      // 首行作为原始标题数组并在任何行对象化之前完成结构校验。
      const headers = Array.isArray(matrix[0]) ? matrix[0].map((header) => String(header ?? '')) : [];
      const headerValidation = validateTemplateHeaders(template.id, headers, { sheetName: sheet.name });
      // 保留每个物理 Excel 行的原始索引，仅跳过整行空白数据，不能压缩后重新编号。
      const indexedRows = matrix.slice(1)
        .map((cells, index) => ({
          cells: Array.isArray(cells) ? [...cells] : [],
          sourceRowNumber: index + 2
        }))
        .filter(({ cells }) => cells.some((value) => !isBlankCell(value)));
      const rawRows = indexedRows.map(({ cells }) => cells);
      // 按列描述逐格映射，并使用空白行过滤前记录的真实 Excel 行号。
      const resolvedRows = indexedRows.map(({ cells, sourceRowNumber }) => resolveTemplateCells(
        template.id,
        cells,
        headerValidation,
        { sourceRowNumber }
      ));
      const issues = limitTemplateIssues([
        ...headerValidation.issues,
        ...resolvedRows.flatMap((result) => result.issues)
      ]);
      return {
        name: sheet.name,
        headers,
        headerValidation,
        headerIssues: headerValidation.issues,
        rawRows,
        rows: resolvedRows.map((result) => result.record),
        resolvedRows,
        issues,
        blockingIssues: issues.filter((issue) => issue.blocking),
        warnings: issues.filter((issue) => issue.severity === 'warning')
      };
    });
  // 集合问题、标题问题与逐行问题统一受限汇总，调用方可直接判断 valid。
  const issues = limitTemplateIssues([
    ...collection.issues,
    ...sheets.flatMap((sheet) => sheet.issues)
  ]);
  return {
    templateId: template.id,
    valid: issues.every((issue) => !issue.blocking),
    sheetNames: [...workbook.SheetNames],
    expectedSheetNames: collection.expectedSheetNames,
    sheetCollection: collection,
    resources,
    sheets,
    sheetsByName: Object.fromEntries(sheets.map((sheet) => [sheet.name, sheet])),
    issues,
    blockingIssues: issues.filter((issue) => issue.blocking),
    warnings: issues.filter((issue) => issue.severity === 'warning')
  };
}

module.exports = {
  CSV_MIME_TYPE,
  ENERGY_ANALYSIS_TEMPLATE_DEFINITIONS,
  ENERGY_ANALYSIS_TEMPLATE_LIMITS,
  ENERGY_BALANCE_CONFIG_SHEET_NAMES,
  ENERGY_FLOW_EDGE_SHEET_NAMES,
  TOU_SCHEME_SHEET_NAMES,
  UTF8_BOM,
  XLSX_MIME_TYPE,
  generateEnergyAnalysisTemplate,
  getEnergyAnalysisTemplateCsv,
  getEnergyAnalysisTemplateDefinition,
  getEnergyAnalysisTemplateXlsx,
  getTemplateCsv: getEnergyAnalysisTemplateCsv,
  getTemplateDefinition: getEnergyAnalysisTemplateDefinition,
  getTemplateXlsx: getEnergyAnalysisTemplateXlsx,
  inspectWorkbookResources,
  inspectXlsxZipContainer,
  listEnergyAnalysisTemplates,
  listTemplates: listEnergyAnalysisTemplates,
  normalizeTemplateHeader,
  parseEnergyAnalysisTemplateBuffer,
  parseEnergyAnalysisTemplateCsv,
  parseEnergyAnalysisTemplateWorkbook,
  parseTemplateWorkbook: parseEnergyAnalysisTemplateWorkbook,
  renderCsvBuffer,
  renderXlsxBuffer,
  resolveTemplateCells,
  resolveTemplateRow,
  validateSheetCollection: validateTemplateSheetCollection,
  validateTemplateHeaders,
  validateTemplateSheetCollection
};
