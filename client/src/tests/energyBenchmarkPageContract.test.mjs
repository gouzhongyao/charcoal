import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 静态契约仅验证模板、权限编码和 API 路由结构；状态行为由纯逻辑测试覆盖。
const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const pageSource = await readFile(new URL('../views/energy/benchmarks/index.vue', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../api/energyBenchmarks.js', import.meta.url), 'utf8');
const utilitySource = await readFile(new URL('../utils/energyBenchmarkManagement.js', import.meta.url), 'utf8');

assert.ok(currentDirectory.endsWith('tests\\') || currentDirectory.endsWith('tests/'));
assert.ok(pageSource.includes("defineOptions({ name: 'EnergyBenchmarksIndex' })"), '页面应提供稳定组件名');
assert.ok(pageSource.includes("import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';"), '页面必须引入共享严格 UTC 日期时间组件');
assert.ok(pageSource.includes("import IanaTimeZoneSelect from '@/components/IanaTimeZoneSelect.vue';"), '页面必须引入共享 IANA 时区选择组件');
assert.equal((pageSource.match(/<StrictUtcDateTimeInput\b/g) || []).length, 8, '八个严格 UTC 字段必须全部使用共享组件');
assert.equal((pageSource.match(/<IanaTimeZoneSelect\b/g) || []).length, 2, '定义与内部历史来源时区必须使用共享选择组件');
for (const field of ['definitionForm.sourceTimeZone', 'internalForm.definition.sourceTimeZone']) {
  assert.ok(pageSource.includes(`<IanaTimeZoneSelect v-model="${field}"`), `来源时区必须保持原字段绑定：${field}`);
  assert.equal(new RegExp(`<el-input[^>]+v-model(?:\\.trim)?="${field.replaceAll('.', '\\.')}"`).test(pageSource), false, `来源时区仍在使用 el-input：${field}`);
}
for (const binding of [
  'v-model="definitionForm.effectiveStartUtc" placeholder="2026-01-01T00:00:00Z"',
  'v-model="definitionForm.effectiveEndUtc" placeholder="2027-01-01T00:00:00Z"',
  'v-model="internalForm.definition.effectiveStartUtc" placeholder="2026-01-01T00:00:00Z"',
  'v-model="internalForm.definition.effectiveEndUtc" placeholder="2027-01-01T00:00:00Z"',
  'v-model="internalForm.referencePeriod.startUtc" placeholder="2025-01-01T00:00:00Z"',
  'v-model="internalForm.referencePeriod.endUtc" placeholder="2026-01-01T00:00:00Z"',
  'v-model="actualContextForm.periodStartUtc"',
  'v-model="actualContextForm.periodEndUtc"'
]) assert.ok(pageSource.includes(`<StrictUtcDateTimeInput ${binding}`), `共享 UTC 组件缺少原字段绑定 ${binding}`);
for (const prop of ['effectiveStartUtc', 'effectiveEndUtc', 'definition.effectiveStartUtc', 'definition.effectiveEndUtc', 'referencePeriod.startUtc', 'referencePeriod.endUtc']) assert.ok(pageSource.includes(`prop="${prop}"`), `UTC 表单字段 prop 不得改变：${prop}`);
for (const field of ['definitionForm.effectiveStartUtc', 'definitionForm.effectiveEndUtc', 'internalForm.definition.effectiveStartUtc', 'internalForm.definition.effectiveEndUtc', 'internalForm.referencePeriod.startUtc', 'internalForm.referencePeriod.endUtc', 'actualContextForm.periodStartUtc', 'actualContextForm.periodEndUtc']) assert.equal(new RegExp(`<el-input[^>]+v-model(?:\\.trim)?="${field.replaceAll('.', '\\.')}"`).test(pageSource), false, `UTC 字段仍在使用 el-input：${field}`);
assert.ok(pageSource.includes("trigger: ['blur', 'change']"), 'UTC 所在表单必须兼容日期选择器 change 与 blur 校验触发');
assert.equal((pageSource.match(/@change="validateUtcFormField\(/g) || []).length, 6, '六个带 prop 的 UTC 字段必须在 change 时触发表单校验');
assert.equal((pageSource.match(/@blur="validateUtcFormField\(/g) || []).length, 6, '六个带 prop 的 UTC 字段必须在 blur 时触发表单校验');
assert.ok(pageSource.includes('严格 UTC Z 左闭右开区间'), '页面必须保留严格 UTC Z 左闭右开提示');
assert.ok((pageSource.match(/UTC（不含）/g) || []).length >= 4, '四个结束字段必须保留结束不含标签');
for (const section of ['对标分析', '定义与目标', '受控导入', '排除对象与原因']) assert.ok(pageSource.includes(section), `页面缺少 ${section}`);
assert.equal(pageSource.includes('HelpIcon'), false, '能效对标页面不得继续引入或使用标题问号帮助组件');
assert.equal(pageSource.includes('文号'), false, '页面用户文案、列表、详情和表单不得出现文号概念');
assert.equal(pageSource.includes('版本'), false, '页面用户文案、列表、详情和表单不得出现版本概念');
for (const forbiddenField of ['documentNo', 'benchmarkVersion', 'targetVersion']) assert.equal(pageSource.includes(forbiddenField), false, `页面不得访问技术字段 ${forbiddenField}`);
assert.equal(pageSource.includes('.version'), false, '页面不得展示或回填只读兼容版本');
assert.equal(pageSource.includes('openDefinitionVersion'), false, '页面不得保留定义版本入口');
assert.equal(pageSource.includes('openVersionTarget'), false, '页面不得保留目标版本入口');
assert.match(pageSource, /function projectDefinitionRecordToForm\(row = \{\}\) \{[\s\S]*?benchmarkCode: row\.benchmarkCode[\s\S]*?status: row\.status \|\| 'active'[\s\S]*?\n\}/, '定义详情必须通过显式业务字段投影后再回填表单');
assert.ok(pageSource.includes('targetForm.value = {') && pageSource.includes('benchmarkDefinitionId: row.benchmarkDefinitionId'), '目标调整必须通过显式业务字段投影回填表单');
assert.ok(pageSource.includes('对标目标'), '目标选择、管理和详情必须使用不含版本概念的名称');
assert.ok(pageSource.includes('服务端会保留原定义并创建后继记录'), '定义调整必须说明保留历史记录');
assert.ok(pageSource.includes('服务端会保留原目标并创建后继记录'), '目标调整必须说明保留历史记录');
assert.ok(pageSource.includes('equivalent-table'), '排名图必须提供完整等价表格');
assert.ok(pageSource.includes('ranking-legend'), '多对象排名必须提供图例');
assert.ok(pageSource.includes('图形最多展示 ${ENERGY_BENCHMARK_CHART_MAX_ENTITIES} 个明确对象'), '页面必须说明图形容量');
assert.ok(pageSource.includes('选择同层级 active 组织'), 'organization 实际对象必须使用组织主数据选择器');
assert.ok(/组织范围(?:分析)?需要组织台账查看权限/.test(pageSource) || /组织范围(?:分析)?需要组织台账查看权限/.test(utilitySource), '页面必须说明组织台账权限要求');
assert.ok(pageSource.includes('filterable clearable') && !pageSource.includes('allow-create'), '范围主数据选择器必须可筛选、可清空且禁止自由创建');
for (const binding of ['definitionForm.scopeReference', 'internalForm.definition.scopeReference', 'internalForm.calculationScope.productionUnitId', 'internalForm.calculationScope.energyTypeCode']) assert.ok(pageSource.includes(`v-model="${binding}"`), `缺少关联选择器绑定 ${binding}`);
assert.ok(pageSource.includes('@change="changeDefinitionScopeType"') && pageSource.includes('@change="changeInternalScopeType"'), '普通定义和内部历史切换范围类型必须清空旧范围值');
assert.ok(pageSource.includes("clearValidate(['scopeType', 'scopeReference'])") && pageSource.includes("clearValidate(['definition.scopeType', 'definition.scopeReference'])"), '切换范围类型必须清除对应字段校验');
assert.ok(pageSource.includes("import { getEnergyTypes } from '@/api/energy';"), '能源类型必须复用现有 API');
assert.ok(pageSource.includes('getAllActiveEnergyBenchmarkProductionUnits'), '页面必须完整读取 active 产能单元');
assert.ok(pageSource.includes('历史值保持原样显示，页面不会静默替换'), '不可见历史值不得静默替换');
for (const opener of ['openCreateDefinition', 'openEditDefinition']) {
  assert.match(pageSource, new RegExp(`function ${opener}\\([^)]*\\) \\{[\\s\\S]*?definitionDrawerOpen\\.value = true; refreshScopeMasterData\\(definitionForm\\.value\\.scopeType\\); \\}`), `${opener} 每次打开都必须刷新当前范围主数据。`);
}
assert.match(pageSource, /function openInternalHistory\(\) \{[\s\S]*?Promise\.all\(\[refreshScopeMasterData\(internalForm\.value\.definition\.scopeType\), refreshScopeMasterData\('product'\), refreshScopeMasterData\('energy'\)\]\); \}/, '内部历史抽屉每次打开必须刷新范围、产能和能源三类主数据。');
for (const contract of [
  ['organization-master-data', 'clearOrganizationMasterDataSelections'],
  ['production-master-data', 'clearProductionMasterDataSelections'],
  ['energy-type-master-data', 'clearEnergyTypeMasterDataSelections']
]) {
  const [requestKey, clearMethod] = contract;
  assert.ok(pageSource.includes(`latestRequestGuard.next('${requestKey}'`), `${requestKey} 必须使用递增 latest-response 守卫。`);
  assert.ok(pageSource.includes(clearMethod), `${requestKey} 失败后必须清除旧候选绑定。`);
}
for (const statusState of ['organizationMasterDataStatus', 'productionMasterDataStatus', 'energyTypesStatus']) {
  assert.ok(pageSource.includes(`${statusState}.value = 'loading'`), `${statusState} 必须显式表达 loading。`);
  assert.ok(pageSource.includes(`${statusState}.value = 'permission'`) || pageSource.includes(`${statusState}.value = Number(`), `${statusState} 必须区分 permission/error。`);
  assert.ok(pageSource.includes(`${statusState}.value = `) && pageSource.includes("? 'ready' : 'empty'"), `${statusState} 必须区分 ready/empty。`);
}
assert.match(pageSource, /let payload;\s*try \{ payload = buildEnergyBenchmarkDefinitionPayload\(definitionForm\.value\); \}\s*catch \(error\) \{ definitionFormError\.value = error\.message; return; \}[\s\S]*?createEnergyBenchmarkDefinition\(payload\)/, '普通定义必须在创建 API 前捕获来源时区载荷校验错误。');
assert.match(pageSource, /let payload;\s*try \{ payload = buildEnergyBenchmarkInternalHistoryPayload\(internalForm\.value\); \}\s*catch \(error\) \{ internalFormError\.value = error\.message; return; \}[\s\S]*?createEnergyBenchmarkInternalHistory\(payload\)/, '内部历史必须在创建 API 前捕获来源时区载荷校验错误。');
assert.ok(pageSource.includes('导出需要同时具备 energy:benchmarks:analyze 和 energy:benchmarks:export'), '页面必须说明导出组合权限');
assert.ok(pageSource.includes('执行需要同时具备 preview 与 execute 权限'), '页面必须说明导入执行组合权限');
assert.equal(pageSource.includes("objectId: '对象-1'"), false, '不得预填演示对象标识');
assert.equal(pageSource.includes("objectName: '对象一'"), false, '不得预填演示对象名称');
assert.equal(pageSource.includes('prefers-color-scheme:dark'), false, '单一亮色项目不得增加局部暗色数据色分支');
assert.ok(pageSource.includes('--benchmark-series-8:#e34948'), '页面必须使用统一亮色八色调色板');

// 权限编码必须包含能效对标六项权限及现有组织台账读取权限。
for (const permission of [
  'energy:benchmarks:view',
  'energy:benchmarks:manage',
  'energy:benchmarks:analyze',
  'energy:benchmarks:export',
  'energy:benchmarks:import:preview',
  'energy:benchmarks:import:execute',
  'ledger:units:view',
  'ledger:organization:view',
  'ledger:production-unit:view',
  'ledger:production:view'
]) assert.ok(utilitySource.includes(`'${permission}'`), `缺少权限编码 ${permission}`);

// API 路由结构必须覆盖定义、目标、分析、导出、组织/产能主数据和三类导入。
for (const route of ['/definitions', '/internal-history', '/targets', '/evaluate', '/rankings', '/qualification-rate', '/export-rows', '/organization/units', '/production/units']) assert.ok(apiSource.includes(route), `API 模块缺少 ${route}`);
assert.ok(apiSource.includes('updateEnergyBenchmarkTarget'), 'API 模块必须提供目标调整入口');
assert.equal(apiSource.includes('versionEnergyBenchmarkTarget'), false, 'API 模块不得继续暴露用户版本入口');
for (const importType of ['conversion-factors', 'definitions', 'targets']) assert.ok(utilitySource.includes(`value: '${importType}'`), `缺少导入类型 ${importType}`);
assert.ok(apiSource.includes("data.append('file', file)"), '导入预演必须使用 FormData 上传文件');
assert.ok(apiSource.includes('${importType}/preview'), '缺少导入预演路由结构');
assert.ok(apiSource.includes('${importType}/execute'), '缺少导入执行路由结构');
for (const contract of [
  ['energy-conversion-factors', '19-conversion-factors'],
  ['energy-benchmark-definitions', '20-benchmark-definitions'],
  ['energy-benchmark-targets', '21-benchmark-targets']
]) {
  assert.ok(apiSource.includes(`templateType: '${contract[0]}'`), `缺少空白模板 ${contract[0]}`);
  assert.ok(apiSource.includes(`artifactKey: '${contract[1]}'`), `缺少青岚示例 ${contract[1]}`);
}
assert.ok(apiSource.includes("import { download, query, request } from '@/api/http';"), '对标模板和示例必须复用共享 download');
assert.ok(pageSource.includes('下载{{ currentImportTypeLabel }}空白模板'), '当前导入类型必须提供空白模板入口');
assert.ok(pageSource.includes('下载{{ currentImportTypeLabel }}青岚园区示例'), '当前导入类型必须提供青岚园区示例入口');
assert.ok(pageSource.includes('推荐顺序：先导入能源折标系数，再导入对标定义，最后导入对标目标'), '页面必须说明三类文件导入顺序');
assert.ok(pageSource.includes('外部标准定义必须填写真实来源'), '页面必须保留外部标准真实来源边界');
assert.ok(pageSource.includes('内部历史必须由服务端按明确参考期固化'), '页面必须保留内部历史固化边界');
assert.ok(pageSource.includes('不会自动导入、计算或执行对标'), '模板和示例下载不得伪装自动导入或自动对标');
assert.ok(pageSource.includes('青岚园区示例下载失败'), '示例下载失败必须复用现有消息反馈');
assert.ok(apiSource.includes('getAllActiveEnergyBenchmarkDefinitions'), '缺少全部 active 定义入口');
assert.ok(apiSource.includes('getAllActiveEnergyBenchmarkTargets'), '缺少全部 active 目标入口');
assert.ok(apiSource.includes('getAllActiveEnergyBenchmarkProductionUnits'), '缺少全部 active 产能单元入口');
assert.ok(apiSource.includes("{ status: 'active' },\n  500"), '产能单元必须按 active 状态完整分页读取');

console.log('能效对标页面静态契约测试通过。');
