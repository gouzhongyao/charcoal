'use strict';

const assert = require('assert');
const XLSX = require('xlsx');
const {
  CSV_MIME_TYPE,
  ENERGY_ANALYSIS_TEMPLATE_LIMITS,
  ENERGY_BALANCE_CONFIG_SHEET_NAMES,
  ENERGY_FLOW_EDGE_SHEET_NAMES,
  TOU_SCHEME_SHEET_NAMES,
  XLSX_MIME_TYPE,
  generateEnergyAnalysisTemplate,
  getEnergyAnalysisTemplateCsv,
  getEnergyAnalysisTemplateDefinition,
  getEnergyAnalysisTemplateXlsx,
  getTemplateCsv,
  getTemplateDefinition,
  getTemplateXlsx,
  listEnergyAnalysisTemplates,
  listTemplates,
  normalizeTemplateHeader,
  parseEnergyAnalysisTemplateBuffer,
  parseEnergyAnalysisTemplateWorkbook,
  parseTemplateWorkbook,
  resolveTemplateRow,
  validateSheetCollection,
  validateTemplateHeaders,
  validateTemplateSheetCollection
} = require('../services/energyAnalysisTemplateService');
const {
  formatStrictUtcForUser,
  formatWallClockMinuteForUser,
  normalizeUserVisibleStrictUtcInput,
  normalizeUserVisibleWallClockMinuteInput
} = require('../utils/userVisibleDateTime');

// 十四类模板 ID 独立硬编码，避免测试从生产对象反向生成预期。
const EXPECTED_TEMPLATE_IDS = Object.freeze([
  'energy-timeseries',
  'shift-definitions',
  'tou-schemes',
  'strategy-rules',
  'shift-schedules',
  'device-states',
  'energy-conversion-factors',
  'energy-benchmark-definitions',
  'energy-benchmark-targets',
  'energy-flow-workbook',
  'energy-flow-models',
  'energy-balance-configs',
  'energy-flow-nodes',
  'energy-flow-edges'
]);

// 十类单工作表模板的中文文件名、ASCII fallback、工作表和表头均独立硬编码。
const EXPECTED_SINGLE_SHEET_TEMPLATES = Object.freeze({
  'energy-timeseries': Object.freeze({
    baseFileName: '能耗时序数据导入模板',
    asciiBaseFileName: 'nenghao-shixu-template',
    sheetName: '能耗时序',
    headers: Object.freeze([
      '能源类型编码', '用能单元编码', '计量器具编码', '开始时间（UTC）', '结束时间（UTC）', '来源时区',
      '粒度（分钟）', '原始单位', '原始值', '来源标识', '数据来源'
    ])
  }),
  'shift-definitions': Object.freeze({
    baseFileName: '班次定义导入模板',
    asciiBaseFileName: 'banci-dingyi-template',
    sheetName: '班次定义',
    headers: Object.freeze([
      '班次编码', '班次名称', '开始分钟', '结束分钟', '是否跨日', '来源时区', '来源', '版本',
      '生效开始时间（UTC）', '生效结束时间（UTC）', '状态'
    ])
  }),
  'strategy-rules': Object.freeze({
    baseFileName: '策略规则导入模板',
    asciiBaseFileName: 'celue-guize-template',
    sheetName: '策略规则',
    headers: Object.freeze([
      '规则编码', '规则名称', '规则版本', '公式版本', '指标编码', '阈值操作符', '阈值', '阈值下限', '阈值上限',
      '阈值单位', '预计降幅', '优先级', '最低覆盖率', '最大证据数', '节省依据', '建议内容', '来源',
      '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
    ])
  }),
  'shift-schedules': Object.freeze({
    baseFileName: '排班计划导入模板',
    asciiBaseFileName: 'paiban-jihua-template',
    sheetName: '排班计划',
    headers: Object.freeze([
      '班次编码', '班次名称', '班次开始分钟', '班次结束分钟', '是否跨日', '来源时区', '定义来源', '定义版本',
      '定义生效开始时间（UTC）', '定义生效结束时间（UTC）', '用能单元编码', '排班开始时间（UTC）',
      '排班结束时间（UTC）', '来源标识', '数据来源', '状态'
    ])
  }),
  'device-states': Object.freeze({
    baseFileName: '设备状态导入模板',
    asciiBaseFileName: 'shebei-zhuangtai-template',
    sheetName: '设备状态',
    headers: Object.freeze([
      '计量器具编码', '用能单元编码', '设备状态', '开始时间（UTC）', '结束时间（UTC）', '来源时区', '来源标识', '数据来源'
    ])
  }),
  'energy-conversion-factors': Object.freeze({
    baseFileName: '能源折标系数导入模板',
    asciiBaseFileName: 'nengyuan-zhebiao-xishu-template',
    sheetName: '能源折标系数',
    headers: Object.freeze([
      '系数编码', '能源类型编码', '源单位', '折标系数值', '目标单位', '展示单位', '展示除数', '来源', '文号',
      '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
    ])
  }),
  'energy-benchmark-definitions': Object.freeze({
    baseFileName: '能效对标定义导入模板',
    asciiBaseFileName: 'nengxiao-duibiao-dingyi-template',
    sheetName: '对标定义',
    headers: Object.freeze([
      '对标编码', '对标名称', '对标类型', '指标编码', '指标单位', '周期类型', '范围类型', '范围标识', '指标方向',
      '来源', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
    ])
  }),
  'energy-benchmark-targets': Object.freeze({
    baseFileName: '能效对标目标导入模板',
    asciiBaseFileName: 'nengxiao-duibiao-mubiao-template',
    sheetName: '对标目标',
    headers: Object.freeze([
      '对标编码', '目标值', '下限值', '上限值', '参考期开始时间（UTC）', '参考期结束时间（UTC）',
      '固化值', '固化时间（UTC）', '样本数量', '产量摘要 JSON', '来源数据摘要', '是否固化', '是否自动刷新', '状态'
    ])
  }),
  'energy-flow-models': Object.freeze({
    baseFileName: '能流模型导入模板',
    asciiBaseFileName: 'nengliu-moxing-template',
    sheetName: '能流模型',
    headers: Object.freeze([
      '模型编码', '模型名称', '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '来源时区', '状态'
    ])
  }),
  'energy-flow-nodes': Object.freeze({
    baseFileName: '能流节点导入模板',
    asciiBaseFileName: 'nengliu-jiedian-template',
    sheetName: '能流节点',
    headers: Object.freeze([
      '模型编码', '模型名称', '模型来源', '模型文号', '模型版本', '模型生效开始时间（UTC）', '模型生效结束时间（UTC）',
      '来源时区', '节点编码', '节点名称', '节点类型', '用能单元编码', '横坐标', '纵坐标', '状态'
    ])
  })
});

// 三类多工作表模板的中文文件名、ASCII fallback 和精确工作表表头独立硬编码。
const EXPECTED_MULTI_SHEET_TEMPLATES = Object.freeze({
  'tou-schemes': Object.freeze({
    baseFileName: 'TOU方案与时段导入模板',
    asciiBaseFileName: 'tou-fangan-shiduan-template',
    sheetNames: Object.freeze(['TOU方案', '时段规则']),
    headersBySheet: Object.freeze({
      TOU方案: Object.freeze([
        '方案编码', '方案名称', '来源时区', '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）', '状态'
      ]),
      时段规则: Object.freeze(['方案编码', '方案版本', '星期序号', '时段类型', '开始分钟', '结束分钟'])
    })
  }),
  'energy-balance-configs': Object.freeze({
    baseFileName: '能效平衡配置导入模板',
    asciiBaseFileName: 'nengxiao-pingheng-peizhi-template',
    sheetNames: Object.freeze(['平衡边界', '九角色项目']),
    headersBySheet: Object.freeze({
      平衡边界: Object.freeze([
        '边界编码', '边界名称', '组织编码', '来源', '文号', '版本', '生效开始时间（UTC）', '生效结束时间（UTC）',
        '来源时区', '发电边界确认', '状态'
      ]),
      九角色项目: Object.freeze([
        '边界编码', '边界版本', '项目编码', '项目名称', '角色', '能源类型编码', '原始单位', '来源类型', '来源引用',
        '来源记录定位', '时序来源标识', '发电数值字段', '显式平衡值', '发电防重复键', '状态'
      ])
    })
  }),
  'energy-flow-edges': Object.freeze({
    baseFileName: '能流边及显式边值导入模板',
    asciiBaseFileName: 'nengliu-bian-xianshi-bianzhi-template',
    sheetNames: Object.freeze(['能流边', '显式边值']),
    headersBySheet: Object.freeze({
      能流边: Object.freeze([
        '模型编码', '模型版本', '边编码', '起点节点编码', '终点节点编码', '能源类型编码', '单位', '来源类型', '来源标识', '状态'
      ]),
      显式边值: Object.freeze([
        '模型编码', '模型版本', '边编码', '开始时间（UTC）', '结束时间（UTC）', '来源时区', '原始单位', '原始值',
        '来源标识', '公式版本', '记录状态'
      ])
    })
  })
});

// 多工作表名称常量必须与独立契约一致。
assert.deepStrictEqual(TOU_SCHEME_SHEET_NAMES, EXPECTED_MULTI_SHEET_TEMPLATES['tou-schemes'].sheetNames);
assert.deepStrictEqual(ENERGY_BALANCE_CONFIG_SHEET_NAMES, EXPECTED_MULTI_SHEET_TEMPLATES['energy-balance-configs'].sheetNames);
assert.deepStrictEqual(ENERGY_FLOW_EDGE_SHEET_NAMES, EXPECTED_MULTI_SHEET_TEMPLATES['energy-flow-edges'].sheetNames);

/**
 * 读取 CSV 首行标题。
 * @param {Buffer} buffer CSV Buffer。
 * @returns {string[]} 标题数组。
 */
function readCsvHeaders(buffer) {
  // 去除 BOM 后只读取首行。
  const firstLine = buffer.toString('utf8').replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  return firstLine.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

/**
 * 读取 Excel 指定工作表首行标题。
 * @param {object} workbook Excel 工作簿。
 * @param {string} sheetName 工作表名称。
 * @returns {Array} 标题数组。
 */
function readXlsxHeaders(workbook, sheetName) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: null
  })[0] || [];
}

/**
 * 将 camelCase 转换为 snake_case，独立检查英文别名完整性。
 * @param {string} key camelCase 键。
 * @returns {string} snake_case 键。
 */
function toSnakeCase(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * 断言用户可见标题未直接暴露内部 camelCase 或 snake_case。
 * @param {object} definition 模板定义。
 */
function assertNoInternalEnglishHeaders(definition) {
  definition.sheets.forEach((sheet) => {
    // 内部 API key 集合来自列定义，但断言对象是实际生产标题。
    const internalHeaders = new Set(sheet.columns.flatMap((column) => [column.key, toSnakeCase(column.key)]));
    sheet.headers.forEach((header) => {
      assert.strictEqual(internalHeaders.has(header), false, `${definition.id}/${sheet.name} 不得把内部 key 暴露为生产标题。`);
    });
  });
}

/**
 * 使用二维数组创建单工作表工作簿。
 * @param {string} sheetName 工作表名称。
 * @param {Array[]} matrix 工作表二维数据。
 * @returns {object} Excel 工作簿。
 */
function createSingleSheetWorkbook(sheetName, matrix) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix, { cellDates: true }), sheetName);
  return workbook;
}

/**
 * 定位测试 XLSX 的 ZIP 中央目录结束记录。
 * @param {Buffer} buffer XLSX Buffer。
 * @returns {number} EOCD 偏移量。
 */
function findTestZipEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

// 模板列表必须精确覆盖十四个已批准 ID，且顺序稳定。
const listedTemplates = listEnergyAnalysisTemplates();
assert.deepStrictEqual(listedTemplates.map((template) => template.id), EXPECTED_TEMPLATE_IDS);
assert.strictEqual(new Set(listedTemplates.map((template) => template.id)).size, 14);
assert.deepStrictEqual(listTemplates().map((template) => template.id), EXPECTED_TEMPLATE_IDS, '通用列表别名必须保持兼容。');
assert.strictEqual(getTemplateDefinition('energy-timeseries').id, 'energy-timeseries');
assert.strictEqual(getTemplateCsv('energy-timeseries').format, 'csv');
assert.strictEqual(getTemplateXlsx('energy-timeseries').format, 'xlsx');
assert.strictEqual(parseTemplateWorkbook, parseEnergyAnalysisTemplateWorkbook);
assert.strictEqual(validateSheetCollection, validateTemplateSheetCollection);

// 表头规范化必须按冻结规则去除指定字符并小写，不额外猜测语义。
assert.strictEqual(normalizeTemplateHeader(' 开始_时间-（UTC）/ '), '开始时间utc');
assert.strictEqual(normalizeTemplateHeader('Energy_Type-Code'), 'energytypecode');
assert.strictEqual(normalizeTemplateHeader('来源\\标识'), '来源标识');

// 用户可见 UTC 与来源墙钟必须使用分离纯函数，保持原分量且不经过服务器本地时区换算。
assert.strictEqual(formatStrictUtcForUser('2026-08-24T01:05:06Z'), '2026-08-24 01:05:06');
assert.strictEqual(formatStrictUtcForUser('2026-08-24T01:05:06.789Z'), '2026-08-24 01:05:06');
assert.strictEqual(normalizeUserVisibleStrictUtcInput('2026-08-24 01:05:06'), '2026-08-24T01:05:06Z');
assert.strictEqual(normalizeUserVisibleStrictUtcInput('2026-08-24T01:05:06Z'), '2026-08-24T01:05:06Z');
assert.strictEqual(normalizeUserVisibleStrictUtcInput('2026-08-24T01:05:06.000Z'), '2026-08-24T01:05:06Z');
assert.strictEqual(normalizeUserVisibleStrictUtcInput(''), null);
assert.strictEqual(normalizeUserVisibleStrictUtcInput(null), null);
assert.strictEqual(formatStrictUtcForUser(undefined), '');
assert.throws(
  () => normalizeUserVisibleStrictUtcInput('2026-08-24T01:05:06.001Z'),
  (error) => error?.code === 'STRICT_UTC_INPUT_PRECISION_INVALID'
);
[
  '2026-02-29 01:05:06',
  '2026-08-24T01:05:06+08:00',
  '2026-08-24',
  '2026-08'
].forEach((value) => assert.throws(
  () => normalizeUserVisibleStrictUtcInput(value),
  (error) => error?.code === 'STRICT_UTC_INPUT_INVALID',
  `${value} 不得被猜测为严格 UTC。`
));
assert.strictEqual(formatWallClockMinuteForUser('2026-08-24T09:05'), '2026-08-24 09:05:00');
assert.strictEqual(normalizeUserVisibleWallClockMinuteInput('2026-08-24 09:05:00'), '2026-08-24T09:05');
assert.strictEqual(normalizeUserVisibleWallClockMinuteInput('2026-08-24T09:05'), '2026-08-24T09:05');
assert.strictEqual(normalizeUserVisibleWallClockMinuteInput('  '), null);
assert.strictEqual(formatWallClockMinuteForUser(null), '');
assert.throws(
  () => normalizeUserVisibleWallClockMinuteInput('2026-08-24 09:05:01'),
  (error) => error?.code === 'WALL_CLOCK_INPUT_SECOND_MUST_BE_ZERO'
);
[
  '2026-02-29 09:05:00',
  '2026-08-24 09:05',
  '2026-08-24T09:05Z'
].forEach((value) => assert.throws(
  () => normalizeUserVisibleWallClockMinuteInput(value),
  (error) => error?.code === 'WALL_CLOCK_INPUT_INVALID',
  `${value} 不得被猜测为来源墙钟。`
));

// 运营模板的组织列与排班状态说明必须精确匹配受控导入契约。
const shiftScheduleDefinition = getEnergyAnalysisTemplateDefinition('shift-schedules');
const shiftOrganizationColumn = shiftScheduleDefinition.sheets[0].columns.find((column) => column.key === 'organizationUnitCode');
const shiftStatusColumn = shiftScheduleDefinition.sheets[0].columns.find((column) => column.key === 'status');
assert.strictEqual(shiftOrganizationColumn.required, true);
assert.strictEqual(shiftOrganizationColumn.description, '填写已维护且启用的排班所属用能单元编码。');
assert.strictEqual(shiftStatusColumn.description, '导入仅允许填写 active；作废必须走受控流程。');
assert.strictEqual(shiftStatusColumn.description.includes('inactive'), false, '排班模板不得宣称可导入 inactive。');
const deviceStateDefinition = getEnergyAnalysisTemplateDefinition('device-states');
const deviceOrganizationColumn = deviceStateDefinition.sheets[0].columns.find((column) => column.key === 'organizationUnitCode');
const deviceStartUtcColumn = deviceStateDefinition.sheets[0].columns.find((column) => column.key === 'startUtc');
const deviceEndUtcColumn = deviceStateDefinition.sheets[0].columns.find((column) => column.key === 'endUtc');
assert.strictEqual(deviceOrganizationColumn.required, true);
assert.strictEqual(deviceOrganizationColumn.description, '填写已维护且启用的 equipment 类型设备组织编码。');
assert(deviceStartUtcColumn.description.startsWith('填写状态区间开始时间；区间在数据库 Unix 整秒边界下必须具有有效持续时间。'));
assert(deviceEndUtcColumn.description.startsWith('填写状态区间结束时间；区间在数据库 Unix 整秒边界下必须具有有效持续时间。'));
assert(deviceStartUtcColumn.description.includes('YYYY-MM-DD HH:mm:ss'));
assert(deviceEndUtcColumn.description.includes('YYYY-MM-DDTHH:mm:ssZ'));

// 规范 Buffer 解析入口必须在零数据行时仍保留原始标题数组并执行必需标题校验。
const headerOnlyCsv = Buffer.from(`﻿${shiftScheduleDefinition.headers.map((header) => `"${header}"`).join(',')}\n`, 'utf8');
const headerOnlyCsvResult = parseEnergyAnalysisTemplateBuffer('shift-schedules', headerOnlyCsv, 'shift-header-only.csv');
assert.strictEqual(headerOnlyCsvResult.valid, true);
assert.deepStrictEqual(headerOnlyCsvResult.sheetsByName['排班计划'].headers, shiftScheduleDefinition.headers);
assert.strictEqual(headerOnlyCsvResult.sheetsByName['排班计划'].resolvedRows.length, 0);
const missingOrganizationHeaders = shiftScheduleDefinition.headers.filter((header) => header !== '用能单元编码');
const missingHeaderOnlyCsv = Buffer.from(`﻿${missingOrganizationHeaders.map((header) => `"${header}"`).join(',')}\n`, 'utf8');
const missingHeaderOnlyResult = parseEnergyAnalysisTemplateBuffer('shift-schedules', missingHeaderOnlyCsv, 'shift-missing-header.csv');
assert.strictEqual(missingHeaderOnlyResult.valid, false);
assert(missingHeaderOnlyResult.blockingIssues.some((issue) => issue.code === 'MISSING_REQUIRED_HEADER' && issue.key === 'organizationUnitCode'));

// 每张工作表的完整 camelCase 与 snake_case 行都必须可无冲突映射，顺便检测别名索引碰撞。
EXPECTED_TEMPLATE_IDS.forEach((templateId) => {
  const definition = getEnergyAnalysisTemplateDefinition(templateId);
  definition.sheets.forEach((sheet) => {
    const camelCaseRow = Object.fromEntries(sheet.columns.map((column) => [column.key, column.example]));
    const snakeCaseRow = Object.fromEntries(sheet.columns.map((column) => [toSnakeCase(column.key), column.example]));
    const options = { sourceRowNumber: 2, ...(definition.sheets.length > 1 ? { sheetName: sheet.name } : {}) };
    const camelCaseResult = resolveTemplateRow(templateId, camelCaseRow, options);
    const snakeCaseResult = resolveTemplateRow(templateId, snakeCaseRow, options);
    assert.strictEqual(camelCaseResult.valid, true, `${templateId}/${sheet.name} camelCase 别名必须可映射。`);
    assert.strictEqual(snakeCaseResult.valid, true, `${templateId}/${sheet.name} snake_case 别名必须可映射。`);
    assert.strictEqual(camelCaseResult.issues.length, 0);
    assert.strictEqual(snakeCaseResult.issues.length, 0);
    assert.deepStrictEqual(Object.keys(camelCaseResult.record), ['sourceRowNumber', ...sheet.columns.map((column) => column.key)]);
    assert.deepStrictEqual(Object.keys(snakeCaseResult.record), ['sourceRowNumber', ...sheet.columns.map((column) => column.key)]);
  });
});

// 十类单工作表模板同时验证中文文件名、ASCII fallback、CSV 与 Excel 实体内容。
const observedAsciiNames = new Set();
Object.entries(EXPECTED_SINGLE_SHEET_TEMPLATES).forEach(([templateId, expected]) => {
  // 定义层必须保持单工作表中文标题顺序。
  const definition = getEnergyAnalysisTemplateDefinition(templateId);
  assert(definition, `${templateId} 模板定义必须存在。`);
  assert.deepStrictEqual(definition.formats, ['xlsx', 'csv']);
  assert.strictEqual(definition.sheets.length, 1);
  assert.strictEqual(definition.sheets[0].name, expected.sheetName);
  assert.deepStrictEqual(definition.sheets[0].headers, expected.headers);
  assert.strictEqual(definition.sheetName, expected.sheetName, '单工作表定义必须兼容直接 sheetName 调用。');
  assert.deepStrictEqual(definition.headers, expected.headers, '单工作表定义必须兼容直接 headers 调用。');
  assert.strictEqual(definition.rows.length, 1, '单工作表定义必须兼容示例 rows 调用。');
  assert.strictEqual(new Set(definition.sheets[0].headers).size, expected.headers.length, `${templateId} 中文表头不得重复。`);
  assertNoInternalEnglishHeaders(definition);

  // 每列必须提供中文名、API key、中文与英文别名、required、说明和样例。
  definition.sheets[0].columns.forEach((column) => {
    assert.strictEqual(typeof column.name, 'string');
    assert.strictEqual(column.header, column.name);
    assert.strictEqual(column.label, column.name);
    assert.strictEqual(typeof column.key, 'string');
    assert(['text', 'number', 'utc'].includes(column.dataType), `${templateId}/${column.key} 必须声明最小 dataType。`);
    assert.strictEqual(typeof column.required, 'boolean');
    assert.strictEqual(typeof column.description, 'string');
    assert(Object.prototype.hasOwnProperty.call(column, 'example'));
    assert.strictEqual(column.sample, column.example);
    assert(column.aliases.includes(column.name), `${templateId}/${column.key} 必须兼容中文标题。`);
    assert(column.aliases.includes(column.key), `${templateId}/${column.key} 必须兼容 camelCase。`);
    assert(column.aliases.includes(toSnakeCase(column.key)), `${templateId}/${column.key} 必须兼容 snake_case。`);
  });

  // CSV 必须返回 Buffer、中文文件名、唯一 ASCII fallback、BOM、中文首行、结尾换行且无尾随空格。
  const csvResult = getEnergyAnalysisTemplateCsv(templateId);
  assert(Buffer.isBuffer(csvResult.buffer));
  assert.strictEqual(csvResult.csv, csvResult.buffer.toString('utf8'));
  assert.strictEqual(csvResult.mimeType, CSV_MIME_TYPE);
  assert.strictEqual(csvResult.fileName, `${expected.baseFileName}.csv`);
  assert.strictEqual(csvResult.asciiFileName, `${expected.asciiBaseFileName}.csv`);
  assert.strictEqual(csvResult.fallbackFileName, csvResult.asciiFileName);
  assert.strictEqual(observedAsciiNames.has(csvResult.asciiFileName), false, 'CSV ASCII fallback 必须唯一。');
  observedAsciiNames.add(csvResult.asciiFileName);
  assert.deepStrictEqual([...csvResult.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${templateId}.csv 必须带 UTF-8 BOM。`);
  assert.deepStrictEqual(readCsvHeaders(csvResult.buffer), expected.headers);
  assert.strictEqual(csvResult.buffer.toString('utf8').endsWith('\n'), true, `${templateId}.csv 必须以换行结束。`);
  assert.strictEqual(csvResult.buffer.toString('utf8').split(/\r?\n/).some((line) => /[ \t]+$/.test(line)), false, `${templateId}.csv 不得有尾随空格。`);
  assert.strictEqual(csvResult.sheetName, expected.sheetName);
  assert.deepStrictEqual(csvResult.headers, expected.headers);
  assert.deepStrictEqual(csvResult.sheets.map((sheet) => sheet.name), [expected.sheetName]);

  // Excel 必须可被 xlsx 反读，且工作表名称、首行和文件元数据精确匹配。
  const xlsxResult = getEnergyAnalysisTemplateXlsx(`${templateId}.XLSX`);
  assert(Buffer.isBuffer(xlsxResult.buffer));
  assert.strictEqual(xlsxResult.mimeType, XLSX_MIME_TYPE);
  assert.strictEqual(xlsxResult.fileName, `${expected.baseFileName}.xlsx`);
  assert.strictEqual(xlsxResult.asciiFileName, `${expected.asciiBaseFileName}.xlsx`);
  assert.strictEqual(observedAsciiNames.has(xlsxResult.asciiFileName), false, 'XLSX ASCII fallback 必须唯一。');
  observedAsciiNames.add(xlsxResult.asciiFileName);
  assert.strictEqual(xlsxResult.buffer.subarray(0, 2).toString('ascii'), 'PK');
  const workbook = XLSX.read(xlsxResult.buffer, { type: 'buffer' });
  assert.deepStrictEqual(workbook.SheetNames, [expected.sheetName]);
  assert.deepStrictEqual(readXlsxHeaders(workbook, expected.sheetName), expected.headers);
  assert.strictEqual(xlsxResult.sheetName, expected.sheetName);
  assert.deepStrictEqual(xlsxResult.headers, expected.headers);
});
assert.strictEqual(observedAsciiNames.size, 20, '十类模板的 CSV/XLSX ASCII fallback 必须全部唯一。');

// 新生成的用户文件只改明确 UTC 单元格，日期/月形态普通文本保持原值，回导恢复内部 Z 秒精度合同。
const userVisibleTimeseriesRows = [[
  'electricity', 'OU-001', 'M-001', '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z',
  'Asia/Shanghai', 15, 'kWh', 25.5, '2026-07', '2026-07-14'
]];
const userVisibleTimeseriesXlsx = generateEnergyAnalysisTemplate('energy-timeseries', 'xlsx', {
  rows: userVisibleTimeseriesRows
});
const userVisibleTimeseriesWorkbook = XLSX.read(userVisibleTimeseriesXlsx.buffer, { type: 'buffer' });
const userVisibleTimeseriesMatrix = XLSX.utils.sheet_to_json(
  userVisibleTimeseriesWorkbook.Sheets['能耗时序'],
  { header: 1, defval: '' }
);
assert.deepStrictEqual(userVisibleTimeseriesMatrix[1].slice(3, 6), [
  '2026-07-14 16:00:00', '2026-07-14 16:15:00', 'Asia/Shanghai'
]);
assert.deepStrictEqual(userVisibleTimeseriesMatrix[1].slice(9, 11), ['2026-07', '2026-07-14']);
assert.deepStrictEqual(userVisibleTimeseriesRows[0].slice(3, 5), [
  '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z'
], '用户文件投影不得反向修改内部演示数据数组。');
const parsedUserVisibleTimeseriesXlsx = parseEnergyAnalysisTemplateBuffer(
  'energy-timeseries',
  userVisibleTimeseriesXlsx.buffer,
  'energy-timeseries.xlsx'
);
assert.strictEqual(parsedUserVisibleTimeseriesXlsx.valid, true);
assert.deepStrictEqual(parsedUserVisibleTimeseriesXlsx.sheets[0].rows[0], {
  sourceRowNumber: 2,
  energyTypeCode: 'electricity',
  organizationUnitCode: 'OU-001',
  meterCode: 'M-001',
  startUtc: '2026-07-14T16:00:00Z',
  endUtc: '2026-07-14T16:15:00Z',
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 15,
  originalUnit: 'kWh',
  originalValue: 25.5,
  sourceReference: '2026-07',
  dataSource: '2026-07-14'
});
const userVisibleTimeseriesCsv = generateEnergyAnalysisTemplate('energy-timeseries', 'csv', {
  rows: userVisibleTimeseriesRows
});
const userVisibleTimeseriesCsvText = userVisibleTimeseriesCsv.buffer.toString('utf8');
assert(userVisibleTimeseriesCsvText.includes('"2026-07-14 16:00:00"'));
assert(userVisibleTimeseriesCsvText.includes('"2026-07-14 16:15:00"'));
assert(userVisibleTimeseriesCsvText.includes('"2026-07"'));
assert(userVisibleTimeseriesCsvText.includes('"2026-07-14"'));
const parsedUserVisibleTimeseriesCsv = parseEnergyAnalysisTemplateBuffer(
  'energy-timeseries',
  userVisibleTimeseriesCsv.buffer,
  'energy-timeseries.csv'
);
assert.strictEqual(parsedUserVisibleTimeseriesCsv.valid, true);
assert.strictEqual(parsedUserVisibleTimeseriesCsv.sheets[0].rows[0].startUtc, '2026-07-14T16:00:00Z');
assert.strictEqual(parsedUserVisibleTimeseriesCsv.sheets[0].rows[0].endUtc, '2026-07-14T16:15:00Z');

// 历史 ISO 继续兼容；非法日历和非零毫秒不得被模板解析器静默修复或截断。
const historicalIsoWorkbook = createSingleSheetWorkbook('能耗时序', [
  EXPECTED_SINGLE_SHEET_TEMPLATES['energy-timeseries'].headers,
  userVisibleTimeseriesRows[0]
]);
const historicalIsoResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', historicalIsoWorkbook);
assert.strictEqual(historicalIsoResult.valid, true);
assert.strictEqual(historicalIsoResult.sheets[0].rows[0].startUtc, '2026-07-14T16:00:00Z');
const invalidUtcWorkbook = createSingleSheetWorkbook('能耗时序', [
  EXPECTED_SINGLE_SHEET_TEMPLATES['energy-timeseries'].headers,
  ['electricity', 'OU-001', 'M-001', '2026-02-29 16:00:00', '2026-07-14T16:15:00.001Z',
    'Asia/Shanghai', 15, 'kWh', 25.5, 'invalid-time', 'upload']
]);
const invalidUtcResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', invalidUtcWorkbook);
assert.strictEqual(invalidUtcResult.valid, false);
assert.strictEqual(invalidUtcResult.blockingIssues.filter(
  (issue) => issue.code === 'INVALID_TEMPLATE_CELL_TYPE' && ['startUtc', 'endUtc'].includes(issue.key)
).length, 2);

// 三类多工作表模板只支持 XLSX，必须精确包含各自冻结的两张中文工作表。
Object.entries(EXPECTED_MULTI_SHEET_TEMPLATES).forEach(([templateId, expected]) => {
  const definition = getEnergyAnalysisTemplateDefinition(templateId);
  assert(definition);
  assert.deepStrictEqual(definition.formats, ['xlsx']);
  assert.deepStrictEqual(definition.sheets.map((sheet) => sheet.name), expected.sheetNames);
  definition.sheets.forEach((sheet) => {
    assert.deepStrictEqual(sheet.headers, expected.headersBySheet[sheet.name]);
    assert.strictEqual(new Set(sheet.headers).size, sheet.headers.length);
    sheet.columns.forEach((column) => {
      assert(column.aliases.includes(column.name));
      assert(column.aliases.includes(column.key));
      assert(column.aliases.includes(toSnakeCase(column.key)));
    });
  });
  assertNoInternalEnglishHeaders(definition);

  // CSV 请求必须明确拒绝，不能静默退化为第一张表。
  assert.throws(
    () => getEnergyAnalysisTemplateCsv(templateId),
    (error) => error.code === 'TEMPLATE_FORMAT_UNSUPPORTED'
      && error.details.templateId === templateId
      && error.details.format === 'csv'
  );

  // Excel 输出必须保持中文文件名、ASCII fallback、双工作表顺序与首行。
  const xlsxResult = getEnergyAnalysisTemplateXlsx(templateId);
  assert.strictEqual(xlsxResult.fileName, `${expected.baseFileName}.xlsx`);
  assert.strictEqual(xlsxResult.asciiFileName, `${expected.asciiBaseFileName}.xlsx`);
  assert.strictEqual(xlsxResult.sheetName, null, '多工作表模板不得伪装为单工作表。');
  assert.strictEqual(xlsxResult.headers, null, '多工作表模板不得只暴露第一张表标题。');
  assert.deepStrictEqual(xlsxResult.sheets.map((sheet) => sheet.name), expected.sheetNames);
  const workbook = XLSX.read(xlsxResult.buffer, { type: 'buffer' });
  assert.deepStrictEqual(workbook.SheetNames, expected.sheetNames);
  expected.sheetNames.forEach((sheetName) => {
    assert.deepStrictEqual(readXlsxHeaders(workbook, sheetName), expected.headersBySheet[sheetName]);
  });
});
assert.throws(
  () => generateEnergyAnalysisTemplate('energy-flow-edges', '.CSV'),
  (error) => error.code === 'TEMPLATE_FORMAT_UNSUPPORTED'
);

// 后续能流多表解析测试复用规范能流边工作簿。
const edgeXlsxResult = getEnergyAnalysisTemplateXlsx('energy-flow-edges');
const edgeWorkbook = XLSX.read(edgeXlsxResult.buffer, { type: 'buffer' });

// 双工作表集合必须精确匹配；缺失、额外、重复均产生 blocking issue。
assert.deepStrictEqual(
  validateTemplateSheetCollection('energy-flow-edges', ['能流边', '显式边值']),
  {
    templateId: 'energy-flow-edges',
    valid: true,
    expectedSheetNames: ['能流边', '显式边值'],
    actualSheetNames: ['能流边', '显式边值'],
    missingSheetNames: [],
    extraSheetNames: [],
    duplicateSheetNames: [],
    issues: []
  }
);
const invalidSheetCollection = validateTemplateSheetCollection('energy-flow-edges', ['能流边', '能流边', '多余工作表']);
assert.strictEqual(invalidSheetCollection.valid, false);
assert.deepStrictEqual(invalidSheetCollection.missingSheetNames, ['显式边值']);
assert.deepStrictEqual(invalidSheetCollection.extraSheetNames, ['多余工作表']);
assert.deepStrictEqual(invalidSheetCollection.duplicateSheetNames, ['能流边']);
assert.deepStrictEqual(invalidSheetCollection.issues.map((issue) => issue.code), [
  'MISSING_TEMPLATE_SHEET', 'EXTRA_TEMPLATE_SHEET', 'DUPLICATE_TEMPLATE_SHEET'
]);
assert(invalidSheetCollection.issues.every((issue) => issue.blocking));

// 多工作表解析 helper 必须读取两张表，而不是复用只读第一张表的旧解析行为。
const parsedEdgeWorkbook = parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', edgeXlsxResult.buffer);
assert.strictEqual(parsedEdgeWorkbook.valid, true);
assert.deepStrictEqual(parsedEdgeWorkbook.sheetNames, ['能流边', '显式边值']);
assert.deepStrictEqual(parsedEdgeWorkbook.sheets.map((sheet) => sheet.name), ['能流边', '显式边值']);
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['能流边'].rows.length, 1);
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['显式边值'].rows.length, 1);
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['能流边'].rows[0].sourceRowNumber, 2);
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['能流边'].rows[0].edgeCode, 'GRID-TO-WORKSHOP');
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['显式边值'].rows[0].sourceRowNumber, 2);
assert.strictEqual(parsedEdgeWorkbook.sheetsByName['显式边值'].rows[0].originalValue, 1000);
assert.strictEqual(parsedEdgeWorkbook.blockingIssues.length, 0);

// 解析包含额外工作表的工作簿时必须保留集合 blocking issue。
const workbookWithExtraSheet = XLSX.read(edgeXlsxResult.buffer, { type: 'buffer' });
XLSX.utils.book_append_sheet(workbookWithExtraSheet, XLSX.utils.aoa_to_sheet([['多余列']]), '多余工作表');
const parsedInvalidWorkbook = parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', workbookWithExtraSheet);
assert.strictEqual(parsedInvalidWorkbook.valid, false);
assert(parsedInvalidWorkbook.blockingIssues.some((issue) => issue.code === 'EXTRA_TEMPLATE_SHEET'));

// 英文 camelCase、snake_case 和明确历史名必须映射为内部 camelCase，并保留来源行号。
const mappedCamelCaseRow = resolveTemplateRow('energy-timeseries', {
  energyTypeCode: 'electricity',
  organizationUnitCode: 'OU-001',
  meterDeviceCode: 'M-001',
  startUtc: '2026-07-14T16:00:00Z',
  end_utc: '2026-07-14T16:15:00Z',
  source_timezone: 'Asia/Shanghai',
  intervalMinutes: 15,
  unit: 'kWh',
  sourceValue: 10,
  source_ref: 'history:001',
  data_source: 'upload'
}, { sourceRowNumber: 27 });
assert.strictEqual(mappedCamelCaseRow.valid, true);
assert.deepStrictEqual(mappedCamelCaseRow.record, {
  sourceRowNumber: 27,
  energyTypeCode: 'electricity',
  organizationUnitCode: 'OU-001',
  meterCode: 'M-001',
  startUtc: '2026-07-14T16:00:00Z',
  endUtc: '2026-07-14T16:15:00Z',
  sourceTimeZone: 'Asia/Shanghai',
  granularityMinutes: 15,
  originalUnit: 'kWh',
  originalValue: 10,
  sourceReference: 'history:001',
  dataSource: 'upload'
});
assert.strictEqual(mappedCamelCaseRow.issues.length, 0);
assert.deepStrictEqual(mappedCamelCaseRow.fieldMapping.meterCode, ['meterDeviceCode']);
assert.deepStrictEqual(mappedCamelCaseRow.fieldMapping.originalValue, ['sourceValue']);

// 输入行自带的来源行号元数据必须被保留，且不得产生未知列告警。
const mappedRowWithSourceMetadata = resolveTemplateRow('energy-timeseries', {
  source_row_number: 31,
  energy_type_code: 'electricity'
});
assert.strictEqual(mappedRowWithSourceMetadata.sourceRowNumber, 31);
assert.strictEqual(mappedRowWithSourceMetadata.record.sourceRowNumber, 31);
assert.strictEqual(mappedRowWithSourceMetadata.warnings.length, 0);

// 同一行的中文与英文同义表头值相同不冲突，值不同必须返回 AMBIGUOUS_HEADER_VALUE。
const equivalentAliases = resolveTemplateRow('energy-timeseries', {
  能源类型编码: 'electricity',
  energy_type_code: ' electricity '
}, { sourceRowNumber: 2 });
assert.strictEqual(equivalentAliases.valid, true);
assert.strictEqual(equivalentAliases.blockingIssues.length, 0);
const conflictingAliases = resolveTemplateRow('energy-timeseries', {
  能源类型编码: 'electricity',
  energyTypeCode: 'natural_gas'
}, { sourceRowNumber: 3 });
assert.strictEqual(conflictingAliases.valid, false);
assert.strictEqual(conflictingAliases.record.energyTypeCode, 'electricity');
assert.deepStrictEqual(conflictingAliases.blockingIssues.map((issue) => issue.code), ['AMBIGUOUS_HEADER_VALUE']);
assert.deepStrictEqual(conflictingAliases.blockingIssues[0].headers, ['能源类型编码', 'energyTypeCode']);
assert.deepStrictEqual(conflictingAliases.blockingIssues[0].values, ['electricity', 'natural_gas']);

// 空值同义表头可由后续非空值补齐，不应误报冲突。
const blankThenValue = resolveTemplateRow('energy-timeseries', {
  能源类型编码: '',
  energyTypeCode: 'electricity'
}, { sourceRowNumber: 4 });
assert.strictEqual(blankThenValue.valid, true);
assert.strictEqual(blankThenValue.record.energyTypeCode, 'electricity');

// 未知普通列只产生 warning，明确列举的关键拼写错误产生 blocking issue，不做模糊猜测。
const unknownHeaderResult = resolveTemplateRow('device-states', {
  计量器具编码: 'M-001',
  自定义备注列: '仅供用户记录'
}, { sourceRowNumber: 5 });
assert.strictEqual(unknownHeaderResult.valid, true);
assert.deepStrictEqual(unknownHeaderResult.warnings.map((issue) => issue.code), ['UNKNOWN_HEADER']);
assert.strictEqual(unknownHeaderResult.warnings[0].blocking, false);
const suspectedTypoResult = resolveTemplateRow('device-states', {
  计量器具编玛: 'M-001'
}, { sourceRowNumber: 6 });
assert.strictEqual(suspectedTypoResult.valid, false);
assert.deepStrictEqual(suspectedTypoResult.blockingIssues.map((issue) => issue.code), ['SUSPECTED_CRITICAL_HEADER_TYPO']);
assert.strictEqual(suspectedTypoResult.blockingIssues[0].expectedKey, 'meterCode');

// 模板 8 行映射必须明确指定工作表，并支持两个工作表各自的英文别名。
assert.throws(
  () => resolveTemplateRow('energy-flow-edges', { edgeCode: 'EDGE-1' }, { sourceRowNumber: 2 }),
  (error) => error.code === 'TEMPLATE_SHEET_REQUIRED'
);
const mappedEdgeRow = resolveTemplateRow('energy-flow-edges', {
  model_code: 'FLOW-001',
  modelVersion: 'energy-flow:v1',
  edge_code: 'EDGE-1',
  sourceNodeCode: 'NODE-A',
  target_node_code: 'NODE-B',
  energy_type: 'electricity',
  original_unit: 'kWh',
  source_type: 'explicit_edge_value',
  source_ref: 'explicit:EDGE-1',
  record_status: 'active'
}, { sheetName: '能流边', sourceRowNumber: 8 });
assert.strictEqual(mappedEdgeRow.valid, true);
assert.deepStrictEqual(mappedEdgeRow.record, {
  sourceRowNumber: 8,
  modelCode: 'FLOW-001',
  modelVersion: 'energy-flow:v1',
  edgeCode: 'EDGE-1',
  fromNodeCode: 'NODE-A',
  toNodeCode: 'NODE-B',
  energyTypeCode: 'electricity',
  unit: 'kWh',
  sourceType: 'explicit_edge_value',
  sourceReference: 'explicit:EDGE-1',
  status: 'active'
});
const mappedExplicitValueRow = resolveTemplateRow('energy-flow-edges', {
  flow_model_code: 'FLOW-001',
  flow_model_version: 'energy-flow:v1',
  edge_code: 'EDGE-1',
  start_time_utc: '2026-07-01T00:00:00Z',
  end_time_utc: '2026-08-01T00:00:00Z',
  time_zone: 'Asia/Shanghai',
  source_unit: 'kWh',
  source_value: 200,
  reference: 'explicit-value:EDGE-1',
  formula_version: 'energy-flow:v1',
  status: 'active'
}, { sheetName: '显式边值', sourceRowNumber: 9 });
assert.strictEqual(mappedExplicitValueRow.valid, true);
assert.strictEqual(mappedExplicitValueRow.record.originalValue, 200);
assert.strictEqual(mappedExplicitValueRow.record.recordStatus, 'active');

// 所有列都必须声明最小 dataType，模板样例不得以常见公式触发字符开头。
EXPECTED_TEMPLATE_IDS.forEach((templateId) => {
  const definition = getEnergyAnalysisTemplateDefinition(templateId);
  definition.sheets.forEach((sheet) => {
    sheet.columns.forEach((column) => {
      assert(['text', 'number', 'utc'].includes(column.dataType), `${templateId}/${sheet.name}/${column.key} dataType 非法。`);
      assert.strictEqual(/^[=+\-@]/.test(String(column.example ?? '').trim()), false, `${templateId}/${sheet.name}/${column.key} 样例不得触发公式。`);
    });
  });
});

// 标题先验校验必须在行对象化之前发现缺失必需列、原始重复、规范化重复和同键多标题。
const timeseriesHeaders = [...EXPECTED_SINGLE_SHEET_TEMPLATES['energy-timeseries'].headers];
const completeTimeseriesRow = [
  'electricity', 'OU-001', 'M-001', '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z',
  'Asia/Shanghai', 15, 'kWh', 25.5, 'physical-row:001', 'upload'
];

// 空白物理行不得被压缩后重新编号，第 2 行空白、第 3 行数据必须保留来源行号 3。
const oneBlankPhysicalRowWorkbook = createSingleSheetWorkbook('能耗时序', [
  timeseriesHeaders,
  [],
  completeTimeseriesRow
]);
const oneBlankPhysicalRowResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', oneBlankPhysicalRowWorkbook);
assert.strictEqual(oneBlankPhysicalRowResult.valid, true);
assert.strictEqual(oneBlankPhysicalRowResult.sheets[0].rows.length, 1);
assert.strictEqual(oneBlankPhysicalRowResult.sheets[0].rows[0].sourceRowNumber, 3);

// 多个中间空白行同样保留真实行号，工作表尾部空白行不应生成空记录。
const multipleBlankPhysicalRowsWorkbook = createSingleSheetWorkbook('能耗时序', [
  timeseriesHeaders,
  [],
  [],
  [],
  completeTimeseriesRow
]);
multipleBlankPhysicalRowsWorkbook.Sheets['能耗时序']['!ref'] = 'A1:K7';
const multipleBlankPhysicalRowsResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', multipleBlankPhysicalRowsWorkbook);
assert.strictEqual(multipleBlankPhysicalRowsResult.valid, true);
assert.strictEqual(multipleBlankPhysicalRowsResult.sheets[0].rows.length, 1);
assert.strictEqual(multipleBlankPhysicalRowsResult.sheets[0].rows[0].sourceRowNumber, 5);
assert.strictEqual(multipleBlankPhysicalRowsResult.sheets[0].rawRows.length, 1);

const missingRequiredHeaders = timeseriesHeaders.filter((header) => header !== '原始值');
const missingRequiredWorkbook = createSingleSheetWorkbook('能耗时序', [missingRequiredHeaders]);
const missingRequiredResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', missingRequiredWorkbook);
assert.strictEqual(missingRequiredResult.valid, false);
assert(missingRequiredResult.blockingIssues.some((issue) => issue.code === 'MISSING_REQUIRED_HEADER' && issue.key === 'originalValue'));

const duplicateRawHeaders = ['能源类型编码', '能源类型编码', ...timeseriesHeaders.slice(1)];
const duplicateRawRow = [
  'electricity', 'natural_gas', 'OU-001', 'M-001', '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z',
  'Asia/Shanghai', 15, 'kWh', 25.5, 'duplicate:001', 'upload'
];
const duplicateRawWorkbook = createSingleSheetWorkbook('能耗时序', [duplicateRawHeaders, duplicateRawRow]);
const duplicateRawResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', duplicateRawWorkbook);
assert.strictEqual(duplicateRawResult.valid, false);
assert(duplicateRawResult.blockingIssues.some((issue) => issue.code === 'DUPLICATE_RAW_HEADER'));
assert(duplicateRawResult.blockingIssues.some((issue) => issue.code === 'DUPLICATE_NORMALIZED_HEADER'));
assert(duplicateRawResult.blockingIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_MAPPING'));
assert(duplicateRawResult.blockingIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_VALUE'));
assert.deepStrictEqual(
  duplicateRawResult.sheets[0].resolvedRows[0].blockingIssues.find((issue) => issue.code === 'AMBIGUOUS_HEADER_VALUE').values,
  ['electricity', 'natural_gas']
);

const normalizedDuplicateValidation = validateTemplateHeaders(
  'energy-timeseries',
  ['能源类型编码', '能源 类型编码', ...timeseriesHeaders.slice(1)]
);
assert.strictEqual(normalizedDuplicateValidation.valid, false);
assert(normalizedDuplicateValidation.blockingIssues.some((issue) => issue.code === 'DUPLICATE_NORMALIZED_HEADER'));
assert(normalizedDuplicateValidation.blockingIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_MAPPING'));

const aliasDuplicateValidation = validateTemplateHeaders(
  'energy-timeseries',
  ['能源类型编码', 'energyTypeCode', ...timeseriesHeaders.slice(1)]
);
assert.strictEqual(aliasDuplicateValidation.valid, false);
assert(aliasDuplicateValidation.blockingIssues.some((issue) => issue.code === 'AMBIGUOUS_HEADER_MAPPING'));
assert.strictEqual(aliasDuplicateValidation.blockingIssues.some((issue) => issue.code === 'DUPLICATE_NORMALIZED_HEADER'), false);

// 即使工作表没有数据行，未知列和静态关键拼写错误也必须由标题先验校验报告。
const emptyUnknownWorkbook = createSingleSheetWorkbook('能耗时序', [[...timeseriesHeaders, '自定义备注列']]);
const emptyUnknownResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', emptyUnknownWorkbook);
assert.strictEqual(emptyUnknownResult.valid, true);
assert(emptyUnknownResult.warnings.some((issue) => issue.code === 'UNKNOWN_HEADER' && issue.header === '自定义备注列'));
const emptyTypoHeaders = timeseriesHeaders.map((header) => header === '能源类型编码' ? '能源类型编玛' : header);
const emptyTypoWorkbook = createSingleSheetWorkbook('能耗时序', [emptyTypoHeaders]);
const emptyTypoResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', emptyTypoWorkbook);
assert.strictEqual(emptyTypoResult.valid, false);
assert(emptyTypoResult.blockingIssues.some((issue) => issue.code === 'SUSPECTED_CRITICAL_HEADER_TYPO'));
assert(emptyTypoResult.blockingIssues.some((issue) => issue.code === 'MISSING_REQUIRED_HEADER' && issue.key === 'energyTypeCode'));

// 单工作表模板也必须拒绝额外工作表，不能只校验模板 8。
const singleSheetWithExtra = XLSX.read(getEnergyAnalysisTemplateXlsx('energy-timeseries').buffer, { type: 'buffer' });
XLSX.utils.book_append_sheet(singleSheetWithExtra, XLSX.utils.aoa_to_sheet([['额外列']]), '额外工作表');
const singleSheetWithExtraResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', singleSheetWithExtra);
assert.strictEqual(singleSheetWithExtraResult.valid, false);
assert(singleSheetWithExtraResult.blockingIssues.some((issue) => issue.code === 'EXTRA_TEMPLATE_SHEET'));

// XLSX 行解析按 dataType 统一文本、有限数值和 UTC 日期，工作簿对象与 Buffer 结果必须一致。
const typedWorkbook = createSingleSheetWorkbook('能耗时序', [
  timeseriesHeaders,
  [123, 'OU-001', 'M-001', new Date('2026-07-14T16:00:00.000Z'), new Date('2026-07-14T16:15:00.000Z'), 'Asia/Shanghai', '15', 'kWh', '25.5', 'typed:001', 'upload'],
  ['electricity', 'OU-002', 'M-002', 46200, 46200.25, 'Asia/Shanghai', 30, 'kWh', 18, 'typed:002', 'upload']
]);
const typedObjectResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', typedWorkbook);
const typedBuffer = XLSX.write(typedWorkbook, { type: 'buffer', bookType: 'xlsx', cellDates: true });
const typedBufferResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', typedBuffer);
assert.strictEqual(typedObjectResult.valid, true);
assert.strictEqual(typedBufferResult.valid, true);
assert.strictEqual(typedObjectResult.sheets[0].rows[0].energyTypeCode, '123');
assert.strictEqual(typedObjectResult.sheets[0].rows[0].granularityMinutes, 15);
assert.strictEqual(typedObjectResult.sheets[0].rows[0].originalValue, 25.5);
assert.strictEqual(typedObjectResult.sheets[0].rows[0].startUtc, '2026-07-14T16:00:00Z');
assert.strictEqual(typedObjectResult.sheets[0].rows[0].endUtc, '2026-07-14T16:15:00Z');
assert.strictEqual(typedObjectResult.sheets[0].rows[1].startUtc.endsWith('Z'), true);
assert.strictEqual(typedObjectResult.sheets[0].rows[1].endUtc.endsWith('Z'), true);
assert.deepStrictEqual(typedBufferResult.sheets[0].rows, typedObjectResult.sheets[0].rows);

const invalidNumberWorkbook = createSingleSheetWorkbook('能耗时序', [
  timeseriesHeaders,
  ['electricity', 'OU-001', 'M-001', '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z', 'Asia/Shanghai', 'not-number', 'kWh', 25.5, 'typed:invalid', 'upload']
]);
const invalidNumberResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', invalidNumberWorkbook);
assert.strictEqual(invalidNumberResult.valid, false);
assert(invalidNumberResult.blockingIssues.some((issue) => issue.code === 'INVALID_TEMPLATE_CELL_TYPE' && issue.key === 'granularityMinutes'));

// 模板 ID 查询必须抵御原型属性键，所有入口都稳定按模板不存在处理。
['__proto__', 'constructor', 'prototype'].forEach((prototypeKey) => {
  assert.strictEqual(getEnergyAnalysisTemplateDefinition(prototypeKey), null);
  assert.throws(
    () => generateEnergyAnalysisTemplate(prototypeKey, 'xlsx'),
    (error) => error.code === 'TEMPLATE_NOT_FOUND'
  );
  assert.throws(
    () => parseEnergyAnalysisTemplateWorkbook(prototypeKey, edgeXlsxResult.buffer),
    (error) => error.code === 'TEMPLATE_NOT_FOUND'
  );
});

// 损坏、截断和伪装 XLSX 必须统一返回稳定格式错误，不能泄露 SheetJS 异常文本。
[
  Buffer.alloc(0),
  Buffer.from('plain text pretending to be xlsx', 'utf8'),
  edgeXlsxResult.buffer.subarray(0, edgeXlsxResult.buffer.length - 32)
].forEach((invalidBuffer) => {
  assert.throws(
    () => parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', invalidBuffer),
    (error) => error.code === 'INVALID_TEMPLATE_WORKBOOK_FORMAT'
      && error.message === '模板文件不是有效的 XLSX 工作簿。'
  );
});

// Buffer、ZIP 中央目录、工作表、行列和总单元格资源上限必须在解析前后分别生效。
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook(
    'energy-timeseries',
    Buffer.alloc(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxFileBytes + 1)
  ),
  (error) => error.code === 'TEMPLATE_FILE_TOO_LARGE'
);
const tooManyZipEntries = Buffer.from(edgeXlsxResult.buffer);
const tooManyZipEntriesEocd = findTestZipEocd(tooManyZipEntries);
assert(tooManyZipEntriesEocd >= 0);
tooManyZipEntries.writeUInt16LE(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipEntries + 1, tooManyZipEntriesEocd + 8);
tooManyZipEntries.writeUInt16LE(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipEntries + 1, tooManyZipEntriesEocd + 10);
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', tooManyZipEntries),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'zipEntries'
);
const oversizedZipEntry = Buffer.from(edgeXlsxResult.buffer);
const oversizedZipEntryEocd = findTestZipEocd(oversizedZipEntry);
const centralDirectoryOffset = oversizedZipEntry.readUInt32LE(oversizedZipEntryEocd + 16);
oversizedZipEntry.writeUInt32LE(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxZipUncompressedBytes + 1, centralDirectoryOffset + 24);
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', oversizedZipEntry),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'zipUncompressedBytes'
);

const tooManySheetsWorkbook = { SheetNames: [], Sheets: Object.create(null) };
for (let index = 0; index <= ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxSheets; index += 1) {
  const sheetName = `工作表${index}`;
  tooManySheetsWorkbook.SheetNames.push(sheetName);
  tooManySheetsWorkbook.Sheets[sheetName] = {};
}
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-timeseries', tooManySheetsWorkbook),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'sheets'
);
const tooManyRowsWorkbook = createSingleSheetWorkbook('能耗时序', [timeseriesHeaders]);
tooManyRowsWorkbook.Sheets['能耗时序']['!ref'] = `A1:A${ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxRowsPerSheet + 1}`;
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-timeseries', tooManyRowsWorkbook),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'rowsPerSheet'
);
const tooManyColumnsWorkbook = createSingleSheetWorkbook('能耗时序', [timeseriesHeaders]);
tooManyColumnsWorkbook.Sheets['能耗时序']['!ref'] = `A1:${XLSX.utils.encode_col(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet)}1`;
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-timeseries', tooManyColumnsWorkbook),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'columnsPerSheet'
);
const totalCellRows = Math.floor(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxTotalCells / ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet) + 1;
const tooManyCellsWorkbook = createSingleSheetWorkbook('能耗时序', [timeseriesHeaders]);
tooManyCellsWorkbook.Sheets['能耗时序']['!ref'] = `A1:${XLSX.utils.encode_col(ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxColumnsPerSheet - 1)}${totalCellRows}`;
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-timeseries', tooManyCellsWorkbook),
  (error) => error.code === 'TEMPLATE_WORKBOOK_LIMIT_EXCEEDED' && error.details.limitType === 'totalCells'
);

// 问题数量必须有确定上限，超出后用稳定问题码标记截断。
const issueLimitRows = Array.from({ length: ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxIssues + 20 }, (_, index) => [
  `electricity-${index}`, `natural-gas-${index}`, 'OU-001', 'M-001', '2026-07-14T16:00:00Z', '2026-07-14T16:15:00Z',
  'Asia/Shanghai', 15, 'kWh', 25.5, `issue-limit:${index}`, 'upload'
]);
const issueLimitWorkbook = createSingleSheetWorkbook('能耗时序', [duplicateRawHeaders, ...issueLimitRows]);
const issueLimitResult = parseEnergyAnalysisTemplateWorkbook('energy-timeseries', issueLimitWorkbook);
assert.strictEqual(issueLimitResult.issues.length, ENERGY_ANALYSIS_TEMPLATE_LIMITS.maxIssues);
assert.strictEqual(issueLimitResult.issues.at(-1).code, 'TEMPLATE_ISSUE_LIMIT_EXCEEDED');
assert.strictEqual(issueLimitResult.valid, false);

// 未知模板、未知工作表与非法解析输入必须返回稳定错误码。
assert.strictEqual(getEnergyAnalysisTemplateDefinition('missing-template'), null);
assert.throws(
  () => generateEnergyAnalysisTemplate('missing-template', 'xlsx'),
  (error) => error.code === 'TEMPLATE_NOT_FOUND'
);
assert.throws(
  () => resolveTemplateRow('energy-flow-edges', {}, { sheetName: '错误工作表' }),
  (error) => error.code === 'TEMPLATE_SHEET_NOT_FOUND'
);
assert.throws(
  () => parseEnergyAnalysisTemplateWorkbook('energy-flow-edges', 'not-a-workbook'),
  (error) => error.code === 'INVALID_TEMPLATE_WORKBOOK_INPUT'
);

console.log('energy analysis template service tests passed');
