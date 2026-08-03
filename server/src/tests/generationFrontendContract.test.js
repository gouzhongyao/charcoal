const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '../../../client/src/main.js'), 'utf8');

function assertIncludes(fragment, message) {
  assert(mainJs.includes(fragment), message);
}

assertIncludes("tab: 'generation'", '基础台账页签应包含发电自用 generation 入口。');
assertIncludes("text: '发电自用'", '页面应展示“发电自用”入口文案。');
assertIncludes("id: 'ledger-generation-form'", '页面应包含发电记录新增/编辑表单。');
assertIncludes("renderFilterRow('ledger-generation'", '页面应包含发电记录筛选表单。');

assertIncludes("/generation/records", '前端应接入 /api/generation/records 列表/新增 API。');
assertIncludes("/generation/statistics/monthly", '前端应接入 /api/generation/statistics/monthly 汇总 API。');
assertIncludes("`/generation/records/${id}`", '前端应接入 /api/generation/records/:id 编辑/作废 API。');

assertIncludes("payload.energyTypeCode = 'photovoltaic'", '首期能源类型应固定为 photovoltaic。');
assertIncludes("外购电参考来自 active energy_records", '页面应说明外购电参考来源。');
assertIncludes('仅供参考，不自动抵扣、不入账', '页面应说明外购电参考仅供参考且不抵扣不入账。');
assertIncludes('不会自动写入或回填 energy_records', '页面应说明不写 energy_records。');
assertIncludes('不会自动写入 carbon_emissions', '页面应说明不写 carbon_emissions。');
assertIncludes('不影响单位产品能耗统计', '页面应说明不影响单位产品能耗。');
assertIncludes('页面不提供发电导入、导出或模板下载', '页面应说明首期不含发电导入/导出。');
assertIncludes('不引入实时采集、自动同步或外部网关', '页面应说明首期不含实时采集/外部网关。');

assert(!mainJs.includes("action: 'export-ledger-generation'"), '发电自用首期不得提供导出动作。');
assert(!mainJs.includes("id: 'ledger-generation-import"), '发电自用首期不得提供导入表单。');
assert(!mainJs.includes("templateType: 'generation"), '发电自用首期不得提供发电模板下载。');

console.log('generation frontend contract tests passed');
