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
for (const section of ['对标分析', '定义与目标', '受控导入', '排除对象与原因']) assert.ok(pageSource.includes(section), `页面缺少 ${section}`);
assert.ok(pageSource.includes('equivalent-table'), '排名图必须提供完整等价表格');
assert.ok(pageSource.includes('ranking-legend'), '多对象排名必须提供图例');
assert.ok(pageSource.includes('图形最多展示 ${ENERGY_BENCHMARK_CHART_MAX_ENTITIES} 个明确对象'), '页面必须说明图形容量');
assert.ok(pageSource.includes('选择同层级 active 组织'), 'organization 实际对象必须使用组织主数据选择器');
assert.ok(pageSource.includes('组织范围分析需要组织台账查看权限') || utilitySource.includes('组织范围分析需要组织台账查看权限'), '页面必须说明组织台账权限要求');
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
  'ledger:organization:view'
]) assert.ok(utilitySource.includes(`'${permission}'`), `缺少权限编码 ${permission}`);

// API 路由结构必须覆盖定义、目标、分析、导出、组织主数据和三类导入。
for (const route of ['/definitions', '/internal-history', '/targets', '/evaluate', '/rankings', '/qualification-rate', '/export-rows', '/organization/units']) assert.ok(apiSource.includes(route), `API 模块缺少 ${route}`);
for (const importType of ['conversion-factors', 'definitions', 'targets']) assert.ok(utilitySource.includes(`value: '${importType}'`), `缺少导入类型 ${importType}`);
assert.ok(apiSource.includes("data.append('file', file)"), '导入预演必须使用 FormData 上传文件');
assert.ok(apiSource.includes('${importType}/preview'), '缺少导入预演路由结构');
assert.ok(apiSource.includes('${importType}/execute'), '缺少导入执行路由结构');
assert.ok(apiSource.includes('getAllActiveEnergyBenchmarkDefinitions'), '缺少全部 active 定义入口');
assert.ok(apiSource.includes('getAllActiveEnergyBenchmarkTargets'), '缺少全部 active 目标入口');

console.log('能效对标页面静态契约测试通过。');
