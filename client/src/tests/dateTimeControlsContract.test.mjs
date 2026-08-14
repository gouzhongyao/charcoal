import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前测试目录：用于构造不依赖执行目录的源码绝对路径。
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
// 客户端源码目录：作为静态扫描相对路径的统一根目录。
const clientSourceDirectory = path.resolve(currentDirectory, '..');
// 组件目录：扫描底层 picker 的共享实现边界。
const componentsDirectory = path.join(clientSourceDirectory, 'components');
// 页面目录：阻止业务页面重新直接使用应由共享组件承载的时间控件。
const viewsDirectory = path.join(clientSourceDirectory, 'views');
// 日期时间工具路径：用于验证实现没有引入浏览器日期与本地时区换算。
const dateTimeUtilityPath = path.join(clientSourceDirectory, 'utils/dateTimeFields.js');
// 严格 UTC 组件路径：共享 datetime picker 的唯一通用实现位置。
const strictUtcComponentPath = path.join(componentsDirectory, 'StrictUtcDateTimeInput.vue');
// 日内时间组件路径：共享 time picker 的唯一通用实现位置。
const timeOfDayComponentPath = path.join(componentsDirectory, 'TimeOfDayInput.vue');
// IANA 时区组件路径：共享可搜索来源时区选择器的唯一通用实现位置。
const ianaTimeZoneComponentPath = path.join(componentsDirectory, 'IanaTimeZoneSelect.vue');
// IANA 时区工具路径：静态候选、运行时补充和历史值回显逻辑集中于此。
const ianaTimeZoneUtilityPath = path.join(clientSourceDirectory, 'utils/ianaTimeZones.js');
// 动态台账页面路径：其 h() 日期控件不能由模板标签扫描器识别，需要单独断言。
const ledgerManagementPath = path.join(viewsDirectory, 'ledger/LedgerManagement.vue');

// 方法模块：文件读取与控件属性提取。

/**
 * 递归读取指定目录下的 Vue 文件。
 * @param {string} directoryPath 待扫描目录。
 * @returns {string[]} Vue 文件绝对路径。
 */
function collectVueFiles(directoryPath) {
  // 目录项：显式携带类型信息，便于递归且不跟随未知文件。
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  // Vue 文件列表：目录结果按稳定名称排序后展开。
  const vueFiles = [];
  entries.sort((left, right) => left.name.localeCompare(right.name)).forEach((entry) => {
    // 当前路径：连接扫描目录与目录项名称。
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) vueFiles.push(...collectVueFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.vue')) vueFiles.push(entryPath);
  });
  return vueFiles;
}

/**
 * 将绝对路径转换为以 client/src 为根的稳定正斜杠路径。
 * @param {string} filePath 文件绝对路径。
 * @returns {string} 稳定相对路径。
 */
function sourceRelativePath(filePath) {
  return path.relative(clientSourceDirectory, filePath).split(path.sep).join('/');
}

/**
 * 读取静态 Vue 标签属性值，避免 format 与 value-format 发生子串误匹配。
 * @param {string} tagSource 标签源码。
 * @param {string} attributeName 属性名称。
 * @returns {string|null} 属性值或 null。
 */
function readStaticAttribute(tagSource, attributeName) {
  // 属性名称：转义正则特殊字符，便于复用到 value-format 等属性。
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 属性匹配：要求属性名前为标签空白，不匹配其他属性名后缀。
  const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tagSource);
  return match ? match[1] : null;
}

/**
 * 读取 picker 的受控模型绑定。
 * @param {string} tagSource 标签源码。
 * @returns {string|null} v-model 或 :model-value 表达式。
 */
function readModelBinding(tagSource) {
  // v-model 匹配：兼容参数形式，同时避免读取修饰符以外的属性。
  const vModelMatch = /(?:^|\s)v-model(?:\:[\w-]+)?\s*=\s*["']([^"']+)["']/i.exec(tagSource);
  if (vModelMatch) return vModelMatch[1];
  // model-value 匹配：共享组件底层 picker 使用受控属性与更新事件。
  const modelValueMatch = /(?:^|\s):model-value\s*=\s*["']([^"']+)["']/i.exec(tagSource);
  return modelValueMatch ? modelValueMatch[1] : null;
}

/**
 * 判断 picker 是否明确允许用户编辑文本。
 * @param {string} tagSource 标签源码。
 * @returns {boolean} 是否显式 editable=true。
 */
function hasEditableContract(tagSource) {
  return /(?:^|\s)editable(?=\s|\/?>)/i.test(tagSource)
    || /(?:^|\s):editable\s*=\s*["']true["']/i.test(tagSource);
}

/**
 * 从 Vue 文件中提取底层 Element Plus 日期和时间选择器。
 * @param {string} filePath Vue 文件路径。
 * @returns {{ filePath: string, relativePath: string, element: string, type: string, model: string|null, format: string|null, valueFormat: string|null, editable: boolean, source: string }[]} 控件描述列表。
 */
function extractPickerDescriptors(filePath) {
  // 文件源码：静态测试只读取文本，不挂载 Vue 或启动浏览器。
  const source = fs.readFileSync(filePath, 'utf8');
  // 相对路径：用于白名单和失败消息保持跨执行目录稳定。
  const relativePath = sourceRelativePath(filePath);
  // 控件描述列表：按源码出现顺序记录每个底层 picker。
  const descriptors = [];
  // 日期标签：覆盖 datetime、month、date、year 与 monthrange。
  const dateTags = source.match(/<el-date-picker\b[^>]*>/gis) || [];
  // 时间标签：底层 time picker 原则上只允许出现在共享组件中。
  const timeTags = source.match(/<el-time-picker\b[^>]*>/gis) || [];

  dateTags.forEach((tagSource) => {
    descriptors.push({
      filePath,
      relativePath,
      element: 'el-date-picker',
      type: readStaticAttribute(tagSource, 'type') || 'date',
      model: readModelBinding(tagSource),
      format: readStaticAttribute(tagSource, 'format'),
      valueFormat: readStaticAttribute(tagSource, 'value-format'),
      editable: hasEditableContract(tagSource),
      source: tagSource
    });
  });
  timeTags.forEach((tagSource) => {
    descriptors.push({
      filePath,
      relativePath,
      element: 'el-time-picker',
      type: 'time',
      model: readModelBinding(tagSource),
      format: readStaticAttribute(tagSource, 'format'),
      valueFormat: readStaticAttribute(tagSource, 'value-format'),
      editable: hasEditableContract(tagSource),
      source: tagSource
    });
  });
  return descriptors;
}

/**
 * 生成包含文件、控件类型和绑定字段的稳定清单键。
 * @param {{ relativePath: string, type: string, model: string|null }} descriptor 控件描述。
 * @returns {string} 清单键。
 */
function pickerContractKey(descriptor) {
  return `${descriptor.relativePath}|${descriptor.type}|${descriptor.model || '(none)'}`;
}

/**
 * 截取源码中两个稳定标记之间的动态组件定义。
 * @param {string} source 完整源码。
 * @param {string} startMarker 开始标记。
 * @param {string} endMarker 结束标记。
 * @returns {string} 截取源码。
 */
function sourceSection(source, startMarker, endMarker) {
  // 开始位置：必须存在，避免断言在组件重命名后误扫其他代码。
  const startIndex = source.indexOf(startMarker);
  assert.notEqual(startIndex, -1, `未找到动态控件开始标记：${startMarker}`);
  // 结束位置：必须位于开始标记之后。
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  assert(endIndex > startIndex, `未找到动态控件结束标记：${endMarker}`);
  return source.slice(startIndex, endIndex);
}

// 日期时间工具源码：用于验证 UTC 逻辑不依赖浏览器本地时区。
const dateTimeUtilitySource = fs.readFileSync(dateTimeUtilityPath, 'utf8');
// 共享组件源码：用于验证组件自身的静态契约。
const strictUtcSource = fs.readFileSync(strictUtcComponentPath, 'utf8');
const timeOfDaySource = fs.readFileSync(timeOfDayComponentPath, 'utf8');
const ianaTimeZoneSource = fs.readFileSync(ianaTimeZoneComponentPath, 'utf8');
const ianaTimeZoneUtilitySource = fs.readFileSync(ianaTimeZoneUtilityPath, 'utf8');
// 台账页面源码：用于验证 h() 动态日期控件。
const ledgerManagementSource = fs.readFileSync(ledgerManagementPath, 'utf8');

// 工具契约：禁止使用 Date、Date.parse、toISOString 或本地时区偏移换算。
assert.doesNotMatch(dateTimeUtilitySource, /\bnew\s+Date\s*\(|\bDate\.parse\s*\(|\.toISOString\s*\(|getTimezoneOffset\s*\(/);

// 严格 UTC 组件契约：可编辑、秒精度、字面量 Z、受控模型和事件透传。
assert.match(strictUtcSource, /<el-date-picker\b/);
assert.match(strictUtcSource, /type="datetime"/);
assert.match(strictUtcSource, /\beditable\b/);
assert.match(strictUtcSource, /format="YYYY-MM-DDTHH:mm:ss\[Z\]"/);
assert.match(strictUtcSource, /value-format="YYYY-MM-DDTHH:mm:ss\[Z\]"/);
assert.match(strictUtcSource, /modelValue:\s*\{\s*type:\s*String/);
assert.match(strictUtcSource, /disabled:\s*\{\s*type:\s*Boolean/);
assert.match(strictUtcSource, /clearable:\s*\{\s*type:\s*Boolean/);
assert.match(strictUtcSource, /placeholder:\s*\{\s*type:\s*String/);
assert.match(strictUtcSource, /defineEmits\(\['update:modelValue', 'change', 'blur'\]\)/);
assert.match(strictUtcSource, /parseStrictUtcDateTime/);
assert.match(strictUtcSource, /emit\('update:modelValue', null\)/);
assert.match(strictUtcSource, /emit\('change', result\.value\)/);
assert.match(strictUtcSource, /emit\('blur', event\)/);
assert.doesNotMatch(strictUtcSource, /\bnew\s+Date\s*\(|\bDate\.parse\s*\(|\.toISOString\s*\(/);

// 日内时间组件契约：可编辑 HH:mm，外部模型为 Number，清空明确发送 null。
assert.match(timeOfDaySource, /<el-time-picker\b/);
assert.match(timeOfDaySource, /\beditable\b/);
assert.match(timeOfDaySource, /format="HH:mm"/);
assert.match(timeOfDaySource, /value-format="HH:mm"/);
assert.match(timeOfDaySource, /modelValue:\s*\{\s*type:\s*Number/);
assert.match(timeOfDaySource, /disabled:\s*\{\s*type:\s*Boolean/);
assert.match(timeOfDaySource, /clearable:\s*\{\s*type:\s*Boolean/);
assert.match(timeOfDaySource, /placeholder:\s*\{\s*type:\s*String/);
assert.match(timeOfDaySource, /defineEmits\(\['update:modelValue', 'change', 'blur'\]\)/);
assert.match(timeOfDaySource, /formatMinutesAsTimeOfDay/);
assert.match(timeOfDaySource, /parseTimeOfDayToMinutes/);
assert.match(timeOfDaySource, /emit\('update:modelValue', result\.value\)/);
assert.match(timeOfDaySource, /清空统一发出 null，不使用 0 代替空值/);

// IANA 来源时区组件契约：只能搜索并选择完整候选，不允许创建任意值，历史值以禁用 option 回显。
assert.match(ianaTimeZoneSource, /<el-select\b/);
assert.match(ianaTimeZoneSource, /\bfilterable\b/);
assert.doesNotMatch(ianaTimeZoneSource, /\ballow-create\b/);
assert.match(ianaTimeZoneSource, /:model-value="modelValue"/);
assert.match(ianaTimeZoneSource, /buildIanaTimeZoneOptions/);
assert.match(ianaTimeZoneSource, /:disabled="option\.disabled"/);
assert.match(ianaTimeZoneSource, /defineEmits\(\['update:modelValue', 'change', 'blur'\]\)/);
assert.match(ianaTimeZoneUtilitySource, /Git for Windows tzdata 2025b/);
assert.match(ianaTimeZoneUtilitySource, /Intl\.supportedValuesOf|supportedValuesOf/);
assert.match(ianaTimeZoneUtilitySource, /'Etc\/UTC'/);
assert.match(ianaTimeZoneUtilitySource, /candidates\.delete\('UTC'\)/);
assert.match(ianaTimeZoneUtilitySource, /历史值，不在当前候选/);
assert.doesNotMatch(ianaTimeZoneUtilitySource, /fetch\s*\(|XMLHttpRequest|node:fs|from ['"]fs['"]/);

// 扫描范围：共享组件和全部业务页面，阻止 views 中未来回退到底层时间控件。
const scannedVueFiles = [...collectVueFiles(componentsDirectory), ...collectVueFiles(viewsDirectory)];
// 底层 picker 描述：作为严格白名单和专用日期控件清单的事实来源。
const pickerDescriptors = scannedVueFiles.flatMap(extractPickerDescriptors);
// 原生时间控件：datetime 与 time 必须逐文件、逐绑定命中明确白名单。
const rawTemporalDescriptors = pickerDescriptors.filter((descriptor) => descriptor.type === 'datetime' || descriptor.type === 'time');

// 原生时间白名单：仅共享组件底层实现与能源分析来源时区墙钟范围允许直接使用。
const allowedRawTemporalContracts = new Map([
  ['components/StrictUtcDateTimeInput.vue|datetime|pickerValue', { format: 'YYYY-MM-DDTHH:mm:ss[Z]', valueFormat: 'YYYY-MM-DDTHH:mm:ss[Z]' }],
  ['components/TimeOfDayInput.vue|time|pickerValue', { format: 'HH:mm', valueFormat: 'HH:mm' }],
  ['views/energy/analysis/index.vue|datetime|draftFilters.startUtc', { format: 'YYYY-MM-DD HH:mm', valueFormat: 'YYYY-MM-DDTHH:mm' }],
  ['views/energy/analysis/index.vue|datetime|draftFilters.endUtc', { format: 'YYYY-MM-DD HH:mm', valueFormat: 'YYYY-MM-DDTHH:mm' }]
]);
// 实际原生时间键：精确比较文件、类型和绑定，不依赖脆弱的总数断言。
const actualRawTemporalKeys = rawTemporalDescriptors.map(pickerContractKey).sort();
assert.deepEqual(actualRawTemporalKeys, [...allowedRawTemporalContracts.keys()].sort());
rawTemporalDescriptors.forEach((descriptor) => {
  // 预期契约：由明确白名单提供显示格式和模型格式。
  const expected = allowedRawTemporalContracts.get(pickerContractKey(descriptor));
  assert(expected, `发现未白名单化的底层时间控件：${pickerContractKey(descriptor)}`);
  assert.equal(descriptor.editable, true, `${pickerContractKey(descriptor)} 必须允许严格文本编辑。`);
  assert.equal(descriptor.format, expected.format, `${pickerContractKey(descriptor)} 的 format 不符合契约。`);
  assert.equal(descriptor.valueFormat, expected.valueFormat, `${pickerContractKey(descriptor)} 的 value-format 不符合契约。`);
});

// 专用日期控件清单：month/date/year/monthrange 必须逐文件、逐绑定固定类型与格式。
const specializedDateContracts = new Map([
  ['views/predictions/PredictionManagement.vue|month|runDraftFilters.targetMonth', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|resultDraftFilters.targetMonthStart', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|resultDraftFilters.targetMonthEnd', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|configForm.trainStartMonth', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|configForm.trainEndMonth', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|configForm.predictStartMonth', 'YYYY-MM'],
  ['views/predictions/PredictionManagement.vue|month|configForm.predictEndMonth', 'YYYY-MM'],
  ['views/carbon/CarbonManagement.vue|year|factorDraftFilters.factorYear', 'YYYY'],
  ['views/carbon/CarbonManagement.vue|month|emissionDraftFilters.normalizedMonthStart', 'YYYY-MM'],
  ['views/carbon/CarbonManagement.vue|month|emissionDraftFilters.normalizedMonthEnd', 'YYYY-MM'],
  ['views/carbon/CarbonManagement.vue|year|factorForm.factorYear', 'YYYY'],
  ['views/carbon/CarbonManagement.vue|date|factorForm.effectiveFrom', 'YYYY-MM-DD'],
  ['views/carbon/CarbonManagement.vue|date|factorForm.effectiveTo', 'YYYY-MM-DD'],
  ['views/carbon/CarbonManagement.vue|month|calculateForm.normalizedMonthStart', 'YYYY-MM'],
  ['views/carbon/CarbonManagement.vue|month|calculateForm.normalizedMonthEnd', 'YYYY-MM'],
  ['views/ledger/LedgerManagement.vue|month|draft.monthStart', 'YYYY-MM'],
  ['views/ledger/LedgerManagement.vue|month|draft.monthEnd', 'YYYY-MM'],
  ['views/energy/balances/index.vue|monthrange|calculationForm.monthRange', 'YYYY-MM'],
  ['views/energy/analysis/index.vue|month|draftFilters.startMonth', 'YYYY-MM'],
  ['views/energy/analysis/index.vue|month|draftFilters.endMonth', 'YYYY-MM'],
  ['views/energy/EnergyStatistics.vue|month|draftFilters.normalizedMonthStart', 'YYYY-MM'],
  ['views/energy/EnergyStatistics.vue|month|draftFilters.normalizedMonthEnd', 'YYYY-MM'],
  ['views/energy/BudgetManagement.vue|month|draftFilters.monthStart', 'YYYY-MM'],
  ['views/energy/BudgetManagement.vue|month|draftFilters.monthEnd', 'YYYY-MM'],
  ['views/energy/BudgetManagement.vue|month|budgetForm.periodMonth', 'YYYY-MM'],
  ['views/energy/flows/index.vue|month|analysisFilters.startMonth', 'YYYY-MM'],
  ['views/energy/flows/index.vue|month|analysisFilters.endMonth', 'YYYY-MM']
]);
// 专用日期描述：排除共享严格时间组件及允许的来源时区 datetime。
const specializedDateDescriptors = pickerDescriptors.filter((descriptor) => ['month', 'date', 'year', 'monthrange'].includes(descriptor.type));
// 实际专用日期键：必须与受审阅的文件/绑定清单完全一致。
const actualSpecializedDateKeys = specializedDateDescriptors.map(pickerContractKey).sort();
assert.deepEqual(actualSpecializedDateKeys, [...specializedDateContracts.keys()].sort());
specializedDateDescriptors.forEach((descriptor) => {
  // 预期格式：类型、文件和绑定共同决定，不按全局数量猜测。
  const expectedFormat = specializedDateContracts.get(pickerContractKey(descriptor));
  assert(expectedFormat, `发现未登记的专用日期控件：${pickerContractKey(descriptor)}`);
  assert.equal(descriptor.editable, true, `${pickerContractKey(descriptor)} 必须显式 editable=true。`);
  assert.equal(descriptor.format, expectedFormat, `${pickerContractKey(descriptor)} 的 format 不符合契约。`);
  assert.equal(descriptor.valueFormat, expectedFormat, `${pickerContractKey(descriptor)} 的 value-format 不符合契约。`);
});

// 动态 Ledger render 契约：模板扫描之外，FormMonth 与 FormDate 也必须可编辑且固定显示/模型格式。
const ledgerFormMonthSource = sourceSection(ledgerManagementSource, 'const FormMonth=defineComponent', 'const FormDate=defineComponent');
assert.match(ledgerFormMonthSource, /h\('el-date-picker'/);
assert.match(ledgerFormMonthSource, /type:'month'/);
assert.match(ledgerFormMonthSource, /valueFormat:'YYYY-MM'/);
assert.match(ledgerFormMonthSource, /format:'YYYY-MM'/);
assert.match(ledgerFormMonthSource, /editable:true/);
assert.match(ledgerFormMonthSource, /'onUpdate:modelValue'/);
const ledgerFormDateSource = sourceSection(ledgerManagementSource, 'const FormDate=defineComponent', 'const ActiveStatus=defineComponent');
assert.match(ledgerFormDateSource, /h\('el-date-picker'/);
assert.match(ledgerFormDateSource, /type:'date'/);
assert.match(ledgerFormDateSource, /valueFormat:'YYYY-MM-DD'/);
assert.match(ledgerFormDateSource, /format:'YYYY-MM-DD'/);
assert.match(ledgerFormDateSource, /editable:true/);
assert.match(ledgerFormDateSource, /'onUpdate:modelValue'/);

// 扫描框架自测：未登记的底层 datetime/time picker 必须能被描述并进入白名单比较。
const scannerFixtureDirectory = fs.mkdtempSync(path.join(currentDirectory, '.date-time-contract-'));
try {
  // 原生 datetime 夹具：模拟未来页面回退。
  const rawDateTimeFixturePath = path.join(scannerFixtureDirectory, 'RawDateTime.vue');
  // 原生 time 夹具：模拟未来页面直接使用底层日内时间控件。
  const rawTimeFixturePath = path.join(scannerFixtureDirectory, 'RawTime.vue');
  // 共享组件夹具：验证共享组件标签不会被底层控件扫描器误报。
  const sharedControlsFixturePath = path.join(scannerFixtureDirectory, 'SharedControls.vue');
  fs.writeFileSync(rawDateTimeFixturePath, '<template><el-date-picker v-model="form.startUtc" type="datetime" editable format="YYYY-MM-DDTHH:mm:ss[Z]" value-format="YYYY-MM-DDTHH:mm:ss[Z]" /></template>', 'utf8');
  fs.writeFileSync(rawTimeFixturePath, '<template><el-time-picker v-model="form.startMinute" editable format="HH:mm" value-format="HH:mm" /></template>', 'utf8');
  fs.writeFileSync(sharedControlsFixturePath, '<template><StrictUtcDateTimeInput v-model="form.startUtc" /><TimeOfDayInput v-model="form.startMinute" /></template>', 'utf8');

  // 夹具控件：应精确提取 datetime 与 time 的绑定，而不误报共享组件标签。
  const fixtureDescriptors = collectVueFiles(scannerFixtureDirectory).flatMap(extractPickerDescriptors);
  assert.deepEqual(
    fixtureDescriptors.map((descriptor) => `${descriptor.type}|${descriptor.model}`).sort(),
    ['datetime|form.startUtc', 'time|form.startMinute']
  );
} finally {
  fs.rmSync(scannerFixtureDirectory, { recursive: true, force: true });
}

console.log('dateTimeControlsContract.test.mjs passed');
