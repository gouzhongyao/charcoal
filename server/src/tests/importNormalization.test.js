const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildEnergyTypeIndex,
  canonicalFieldName,
  createDuplicateKey,
  detectEnergyImportTemplateMismatch,
  mapRowFields,
  normalizeMonth,
  normalizeNumber,
  normalizeUnitAndValue,
  validateAndNormalizeRow
} = require('../services/import/normalization');

const energyTypes = [
  { id: 1, code: 'electricity', name: '电力' },
  { id: 2, code: 'natural_gas', name: '天然气' },
  { id: 3, code: 'water', name: '水' },
  { id: 4, code: 'coal', name: '煤炭' },
  { id: 5, code: 'heat', name: '热力' },
  { id: 6, code: 'steam', name: '蒸汽' },
  { id: 7, code: 'photovoltaic', name: '光伏' },
  { id: 8, code: 'oil', name: '油' },
  { id: 9, code: 'gasoline', name: '汽油' },
  { id: 10, code: 'diesel', name: '柴油' }
];
const energyTypeIndex = buildEnergyTypeIndex(energyTypes);

assert.strictEqual(canonicalFieldName('月份'), 'month');
assert.strictEqual(canonicalFieldName('period'), 'month');
assert.strictEqual(canonicalFieldName('energy_type'), 'energyType');
assert.strictEqual(canonicalFieldName('energy_name'), 'energyType');
assert.strictEqual(canonicalFieldName('organization_unit'), 'organization');
assert.strictEqual(canonicalFieldName('meter_name'), 'meterCode');
assert.strictEqual(canonicalFieldName('data_time'), 'dataTime');
assert.strictEqual(canonicalFieldName('设备名称'), 'meterCode');

assert.deepStrictEqual(mapRowFields({ 月份: '2026/1', 能源类型: '电力', 用量: '1,234.5', 单位: '度' }).mapped, {
  month: '2026/1',
  energyType: '电力',
  value: '1,234.5',
  unit: '度'
});

assert.strictEqual(normalizeMonth('2026/1'), '2026-01');
assert.strictEqual(normalizeMonth('2026.02'), '2026-02');
assert.strictEqual(normalizeMonth('2026-02-01 08:00:00'), '2026-02');
assert.strictEqual(normalizeMonth(46054), '2026-02');
assert.strictEqual(normalizeMonth('2026年12月'), '2026-12');
assert.strictEqual(normalizeMonth('202613'), null);
assert.strictEqual(normalizeNumber('1,234.50'), 1234.5);
assert.strictEqual(normalizeNumber('-1'), null);

assert.deepStrictEqual(normalizeUnitAndValue('electricity', '度', 12), {
  normalizedUnit: 'kWh',
  normalizedValue: 12
});
assert.deepStrictEqual(normalizeUnitAndValue('coal', '吨', 2.5), {
  normalizedUnit: 't',
  normalizedValue: 2.5
});
assert.deepStrictEqual(normalizeUnitAndValue('coal', 'kg', 2500), {
  normalizedUnit: 't',
  normalizedValue: 2.5
});
assert.deepStrictEqual(normalizeUnitAndValue('photovoltaic', 'MWh', 1.5), {
  normalizedUnit: 'kWh',
  normalizedValue: 1500
});
assert.deepStrictEqual(normalizeUnitAndValue('photovoltaic', 'kWh', 120), {
  normalizedUnit: 'kWh',
  normalizedValue: 120
});
assert.deepStrictEqual(normalizeUnitAndValue('oil', 'kg', 800), {
  normalizedUnit: 't',
  normalizedValue: 0.8
});
assert.deepStrictEqual(normalizeUnitAndValue('oil', '吨', 2.5), {
  normalizedUnit: 't',
  normalizedValue: 2.5
});
assert.deepStrictEqual(normalizeUnitAndValue('gasoline', 'L', 20), {
  normalizedUnit: 'L',
  normalizedValue: 20
});
assert.deepStrictEqual(normalizeUnitAndValue('diesel', '升', 30), {
  normalizedUnit: 'L',
  normalizedValue: 30
});
assert.deepStrictEqual(normalizeUnitAndValue('water', '吨', 3), {
  normalizedUnit: 'm3',
  normalizedValue: 3
});
assert.deepStrictEqual(normalizeUnitAndValue('natural_gas', '标方', 8), {
  normalizedUnit: 'm3',
  normalizedValue: 8
});
assert.deepStrictEqual(normalizeUnitAndValue('natural_gas', '万m³', 1.2), {
  normalizedUnit: 'm3',
  normalizedValue: 12000
});
assert.deepStrictEqual(normalizeUnitAndValue('heat', 'MJ', 2500), {
  normalizedUnit: 'MJ',
  normalizedValue: 2500
});
assert.deepStrictEqual(normalizeUnitAndValue('heat', 'GJ', 2.5), {
  normalizedUnit: 'MJ',
  normalizedValue: 2500
});
assert.deepStrictEqual(normalizeUnitAndValue('steam', 'kg', 1500), {
  normalizedUnit: 't',
  normalizedValue: 1.5
});
assert.strictEqual(normalizeUnitAndValue('electricity', '吨', 1), null);
assert.strictEqual(normalizeUnitAndValue('oil', 'L', 1), null);
assert.strictEqual(normalizeUnitAndValue('gasoline', 'kg', 1), null);

const validRow = validateAndNormalizeRow({
  月份: '2026/01',
  能源类型: '电力',
  用量: '10',
  单位: '度',
  组织: '总部',
  地点: 'A园区',
  设备: '电表001',
  备注: '测试'
}, 2, energyTypeIndex);
assert.deepStrictEqual(validRow.errors, []);
assert.strictEqual(validRow.record.normalizedMonth, '2026-01');
assert.strictEqual(validRow.record.normalizedUnit, 'kWh');
assert.strictEqual(validRow.record.normalizedValue, 10);
assert.strictEqual(validRow.record.meterCode, '电表001');
assert.strictEqual(validRow.record.duplicateKey.length, 64);

const standardFieldRow = validateAndNormalizeRow({
  period: '',
  energy_name: '天然气',
  value: '1.2',
  unit: '万m³',
  organization_unit: '动力车间',
  meter_name: 'G-001',
  data_time: '2026-02-01 08:00:00',
  remark: '标准字段样例'
}, 6, energyTypeIndex);
assert.deepStrictEqual(standardFieldRow.errors, []);
assert.strictEqual(standardFieldRow.record.normalizedMonth, '2026-02');
assert.strictEqual(standardFieldRow.record.normalizedUnit, 'm3');
assert.strictEqual(standardFieldRow.record.normalizedValue, 12000);
assert.strictEqual(standardFieldRow.record.organization, '动力车间');
assert.strictEqual(standardFieldRow.record.meterCode, 'G-001');

const duplicateKey = createDuplicateKey({
  energyTypeCode: 'electricity',
  normalizedMonth: '2026-01',
  organization: '总部',
  site: 'A园区',
  department: '',
  productionLine: '',
  meterCode: '电表001',
  businessDimension: ''
});
assert.strictEqual(validRow.record.duplicateKey, duplicateKey);

const photovoltaicCnRow = validateAndNormalizeRow({
  period: '2026-03',
  energy_type: '光伏',
  value: '1.5',
  unit: 'MWh',
  organization_unit: '能源站',
  meter_name: 'PV-001'
}, 7, energyTypeIndex);
assert.deepStrictEqual(photovoltaicCnRow.errors, []);
assert.strictEqual(photovoltaicCnRow.record.energyTypeCode, 'photovoltaic');
assert.strictEqual(photovoltaicCnRow.record.normalizedUnit, 'kWh');
assert.strictEqual(photovoltaicCnRow.record.normalizedValue, 1500);

const photovoltaicCodeRow = validateAndNormalizeRow({
  period: '2026-04',
  energy_type: 'photovoltaic',
  value: '300',
  unit: 'kWh'
}, 8, energyTypeIndex);
assert.deepStrictEqual(photovoltaicCodeRow.errors, []);
assert.strictEqual(photovoltaicCodeRow.record.energyTypeCode, 'photovoltaic');
assert.strictEqual(photovoltaicCodeRow.record.normalizedValue, 300);

const oilCnRow = validateAndNormalizeRow({
  period: '2026-05',
  energy_type: '油',
  value: '800',
  unit: 'kg',
  organization_unit: '锅炉房'
}, 9, energyTypeIndex);
assert.deepStrictEqual(oilCnRow.errors, []);
assert.strictEqual(oilCnRow.record.energyTypeCode, 'oil');
assert.strictEqual(oilCnRow.record.normalizedUnit, 't');
assert.strictEqual(oilCnRow.record.normalizedValue, 0.8);

const oilCodeRow = validateAndNormalizeRow({
  period: '2026-06',
  energy_type: 'oil',
  value: '2.5',
  unit: 't'
}, 10, energyTypeIndex);
assert.deepStrictEqual(oilCodeRow.errors, []);
assert.strictEqual(oilCodeRow.record.energyTypeCode, 'oil');
assert.strictEqual(oilCodeRow.record.normalizedValue, 2.5);

const invalidOilUnitRow = validateAndNormalizeRow({
  period: '2026-07',
  energy_type: 'oil',
  value: '12',
  unit: 'L'
}, 11, energyTypeIndex);
assert.strictEqual(invalidOilUnitRow.record, null);
assert.strictEqual(invalidOilUnitRow.errors.length, 1);
assert.strictEqual(invalidOilUnitRow.errors[0].errorCode, 'UNSUPPORTED_UNIT');

const invalidRow = validateAndNormalizeRow({
  月份: '2026-99',
  能源类型: '未知能源',
  用量: 'abc',
  单位: '吨'
}, 3, energyTypeIndex);
assert.strictEqual(invalidRow.record, null);
assert.deepStrictEqual(invalidRow.errors.map((error) => error.errorCode).sort(), [
  'INVALID_MONTH',
  'INVALID_VALUE',
  'UNKNOWN_ENERGY_TYPE'
]);

const unsupportedUnitRow = validateAndNormalizeRow({
  月份: '2026-02',
  能源类型: '天然气',
  用量: '20',
  单位: 'kWh'
}, 4, energyTypeIndex);
assert.strictEqual(unsupportedUnitRow.record, null);
assert.strictEqual(unsupportedUnitRow.errors.length, 1);
assert.strictEqual(unsupportedUnitRow.errors[0].fieldName, 'unit');
assert.strictEqual(unsupportedUnitRow.errors[0].errorCode, 'UNSUPPORTED_UNIT');
assert.strictEqual(unsupportedUnitRow.errors[0].rawValue, 'kWh');

const missingRow = validateAndNormalizeRow({}, 5, energyTypeIndex);
assert.strictEqual(missingRow.errors.length, 4);
assert(missingRow.errors.every((error) => error.errorCode === 'REQUIRED_FIELD_MISSING'));

const carbonTemplateMismatch = detectEnergyImportTemplateMismatch([
  {
    能源类型: '电力',
    地区: 'default',
    年份: '2026',
    单位: 'kWh',
    因子值: '0.5703',
    因子单位: 'kgCO2e',
    来源: '业务维护',
    来源链接: 'https://example.com',
    有效开始日期: '2026-01-01',
    有效结束日期: '2026-12-31',
    是否启用: '是'
  }
]);
assert(carbonTemplateMismatch, '碳因子模板误传到能耗导入入口时应识别为模板类型不匹配。');
assert.strictEqual(carbonTemplateMismatch.errorCode, 'TEMPLATE_TYPE_MISMATCH');
assert(carbonTemplateMismatch.missingKeyFields.includes('month'));
assert(carbonTemplateMismatch.missingKeyFields.includes('value'));
assert(carbonTemplateMismatch.matchedCarbonFeatures.includes('factorValue'));
assert(carbonTemplateMismatch.matchedCarbonFeatures.includes('factorUnit'));

const normalMissingRequiredTemplate = detectEnergyImportTemplateMismatch([
  { 月份: '2026-01', 能源类型: '电力', 单位: 'kWh', 组织: '缺用量集团' }
]);
assert.strictEqual(normalMissingRequiredTemplate, null, '普通缺少用量字段的能耗表不应被误判为模板类型不匹配。');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
assert(schemaSql.includes("('photovoltaic', '光伏', 'energy', 'kWh', 'kWh'"), 'schema energy_types 种子应包含 photovoltaic，标准单位为 kWh。');
assert(schemaSql.includes("('oil', '油', 'energy', 't', 't'"), 'schema energy_types 种子应包含通用 oil，标准单位为 t。');
assert(schemaSql.includes("('coal', '煤炭', 'energy', 't', 't'"), 'schema energy_types 种子中 coal 标准单位应为 t。');
assert(schemaSql.includes("('heat', '热力', 'heat', 'MJ', 'MJ'"), 'schema energy_types 种子中 heat 标准单位应为 MJ。');
assert(schemaSql.includes("WHERE code = 'coal'") && schemaSql.includes("standard_unit = 't'"), 'schema 应包含 coal 旧库标准单位幂等更新。');
assert(schemaSql.includes("WHERE code = 'heat'") && schemaSql.includes("standard_unit = 'MJ'"), 'schema 应包含 heat 旧库标准单位幂等更新。');

console.log('import normalization tests passed');
