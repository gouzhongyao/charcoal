'use strict';

const assert = require('assert');
const {
  CARBON_ACTIVITY_DUPLICATE_KEY_DOMAIN,
  CARBON_ACTIVITY_IMPORT_HEADERS,
  CARBON_ACTIVITY_MAX_VALUE,
  CARBON_ACTIVITY_WORKSHEET_NAME,
  assertCarbonActivityAllowedFields,
  buildCarbonActivityCodeKey,
  buildCarbonActivityDuplicateKey,
  buildCarbonActivityNormalizationKey,
  normalizeCarbonActivityFactorRegion,
  normalizeCarbonActivityScope,
  normalizeCarbonActivityValue
} = require('../services/carbonActivityContracts');

// 固定 Excel v1 合同必须保持单工作表和 15 列精确中文表头。
assert.strictEqual(CARBON_ACTIVITY_WORKSHEET_NAME, '独立碳活动');
assert.deepStrictEqual(CARBON_ACTIVITY_IMPORT_HEADERS, [
  '活动记录编码',
  '替代活动记录编码',
  '排放范围',
  '活动类别',
  '用能单元编码',
  '能源类型编码',
  '活动开始时间',
  '活动结束时间',
  '来源时区',
  '活动数据值',
  '活动数据单位',
  '因子地区',
  '来源标识',
  '证据引用',
  '备注'
]);

// 编码键执行 trim、NFKC 和 locale-independent 大写，但不折叠内部空白。
assert.strictEqual(buildCarbonActivityCodeKey('  ｃａ-００１  '), 'CA-001');
assert.strictEqual(buildCarbonActivityNormalizationKey('  kWh  '), 'KWH');
assert.strictEqual(buildCarbonActivityCodeKey('ca  001'), 'CA  001');

// 排放范围只允许冻结的中英文别名，并统一为 scope_1/2/3。
assert.strictEqual(normalizeCarbonActivityScope(' Scope 1 '), 'scope_1');
assert.strictEqual(normalizeCarbonActivityScope('范围二'), 'scope_2');
assert.strictEqual(normalizeCarbonActivityScope('其他间接排放'), 'scope_3');
assert.strictEqual(normalizeCarbonActivityScope('范围四'), null);

// 空地区稳定规范为 default；非空显示文本保留首尾去空格后的原文。
assert.strictEqual(normalizeCarbonActivityFactorRegion(''), 'default');
assert.strictEqual(normalizeCarbonActivityFactorRegion('  华东  '), '华东');

// 活动值必须有限、非负且不超过冻结上限。
assert.strictEqual(normalizeCarbonActivityValue(0), 0);
assert.strictEqual(normalizeCarbonActivityValue(String(CARBON_ACTIVITY_MAX_VALUE)), CARBON_ACTIVITY_MAX_VALUE);
[
  '',
  '-1',
  'NaN',
  'Infinity',
  String(CARBON_ACTIVITY_MAX_VALUE + 1)
].forEach((value) => assert.strictEqual(normalizeCarbonActivityValue(value), null, `${value} 必须被拒绝。`));

// duplicate key v1 对规范化单位、地区稳定，但对来源标识的大小写保持敏感。
assert.strictEqual(CARBON_ACTIVITY_DUPLICATE_KEY_DOMAIN, 'carbon-activity-duplicate:v1');
const duplicateInput = {
  emissionScope: 'scope_2',
  activityCategoryKey: '购入电力',
  organizationUnitId: 10,
  energyTypeId: 20,
  startUtc: '2026-08-24T01:00:00Z',
  endUtc: '2026-08-24T02:00:00Z',
  activityValue: 100,
  activityUnit: 'kWh',
  factorRegion: 'default',
  sourceReference: 'Meter-A'
};
const duplicateKey = buildCarbonActivityDuplicateKey(duplicateInput);
assert.match(duplicateKey, /^[0-9a-f]{64}$/);
assert.strictEqual(buildCarbonActivityDuplicateKey({
  ...duplicateInput,
  activityUnit: 'ＫＷＨ',
  factorRegion: 'DEFAULT'
}), duplicateKey);
assert.notStrictEqual(buildCarbonActivityDuplicateKey({
  ...duplicateInput,
  sourceReference: 'meter-a'
}), duplicateKey);

// 所有写接口必须 fail-closed 拒绝未知客户端见证字段。
assert.doesNotThrow(() => assertCarbonActivityAllowedFields(
  { batchId: 1, confirmText: '确认导入独立碳活动' },
  new Set(['batchId', 'confirmText']),
  'import-execute'
));
assert.throws(
  () => assertCarbonActivityAllowedFields(
    { batchId: 1, previewSignature: 'client-controlled' },
    new Set(['batchId']),
    'import-execute'
  ),
  (error) => error?.details?.code === 'CARBON_ACTIVITY_UNKNOWN_FIELDS_REJECTED'
    && error.details.unknownFields.includes('previewSignature')
);
assert.throws(
  () => assertCarbonActivityAllowedFields([], new Set(), 'void'),
  (error) => error?.details?.code === 'CARBON_ACTIVITY_PAYLOAD_INVALID'
);

console.log('carbonActivityContracts tests passed');
