const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DETAIL_SORT_COLUMNS,
  DIMENSION_COLUMNS,
  MAX_PAGE_SIZE,
  buildEnergyRecordWhere,
  normalizeDetailSort,
  normalizeDimension,
  normalizeEnergyRecordFilters,
  normalizePagination,
  normalizePositiveInteger
} = require('../services/energyRecordQuery');

const pagination = normalizePagination({ page: '2', pageSize: '999' });
assert.strictEqual(pagination.page, 2);
assert.strictEqual(pagination.pageSize, MAX_PAGE_SIZE);
assert.strictEqual(pagination.offset, MAX_PAGE_SIZE);

assert.strictEqual(normalizePagination({}).page, 1);
assert.strictEqual(normalizePagination({}).pageSize, 20);
assert.throws(
  () => normalizePagination({ page: '0', pageSize: '20' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_INTEGER'
);
assert.throws(
  () => normalizePagination({ page: '1', pageSize: '0' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_INTEGER'
);
assert.throws(
  () => normalizePositiveInteger('1;DROP TABLE energy_records', 'sourceBatchId'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_INTEGER'
);

const filters = normalizeEnergyRecordFilters({
  monthStart: '2026-01',
  monthEnd: '2026-12',
  energyTypeCode: ' electricity ',
  organization: '总部',
  site: 'A园区',
  department: '生产部',
  sourceBatchId: '12'
});
assert.deepStrictEqual(filters, {
  normalizedMonthStart: '2026-01',
  normalizedMonthEnd: '2026-12',
  energyTypeCode: 'electricity',
  organization: '总部',
  site: 'A园区',
  department: '生产部',
  organizationUnitId: undefined,
  meterDeviceId: undefined,
  sourceBatchId: 12
});

assert.throws(
  () => normalizeEnergyRecordFilters({ normalizedMonthStart: '2026-00' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH_FILTER'
);
assert.throws(
  () => normalizeEnergyRecordFilters({ normalizedMonthStart: '2026-12', normalizedMonthEnd: '2026-01' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_MONTH_RANGE'
);

const where = buildEnergyRecordWhere(filters);
assert.strictEqual(where.whereSql.includes("er.record_status = 'active'"), true);
assert.strictEqual(where.whereSql.includes('er.normalized_month >= @normalizedMonthStart'), true);
assert.strictEqual(where.whereSql.includes('er.source_batch_id = @sourceBatchId'), true);
assert.strictEqual(where.whereSql.includes('electricity'), false);
assert.strictEqual(where.params.energyTypeCode, 'electricity');
assert.strictEqual(where.params.sourceBatchId, 12);

const ledgerFilters = normalizeEnergyRecordFilters({ organizationUnitId: '10', meterDeviceId: '20' });
assert.strictEqual(ledgerFilters.organizationUnitId, 10);
assert.strictEqual(ledgerFilters.meterDeviceId, 20);
const ledgerWhere = buildEnergyRecordWhere(ledgerFilters);
assert.strictEqual(ledgerWhere.whereSql.includes('er.organization_unit_id = @organizationUnitId'), true);
assert.strictEqual(ledgerWhere.whereSql.includes('er.meter_device_id = @meterDeviceId'), true);
assert.strictEqual(ledgerWhere.params.organizationUnitId, 10);
assert.strictEqual(ledgerWhere.params.meterDeviceId, 20);

Object.keys(DIMENSION_COLUMNS).forEach((dimension) => {
  assert.strictEqual(normalizeDimension(dimension).dimension, dimension);
});
assert.throws(
  () => normalizeDimension('sourceBatchId'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_DIMENSION'
);
assert.throws(
  () => normalizeDimension('organization;DROP TABLE energy_records'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_DIMENSION'
);

Object.keys(DETAIL_SORT_COLUMNS).forEach((sortBy) => {
  assert.strictEqual(normalizeDetailSort({ sortBy, sortOrder: 'asc' }).sortBy, sortBy);
  assert.strictEqual(normalizeDetailSort({ sortBy, sortOrder: 'desc' }).sortOrder, 'desc');
});
assert.strictEqual(normalizeDetailSort({}).orderSql.includes('er.normalized_month DESC'), true);
assert.throws(
  () => normalizeDetailSort({ sortBy: 'created_at;DROP TABLE energy_records' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_SORT_FIELD'
);
assert.throws(
  () => normalizeDetailSort({ sortBy: 'createdAt', sortOrder: 'delete' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_SORT_ORDER'
);

const statisticsServiceJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'energyRecordStatisticsService.js'), 'utf8');
const energyRecordsRouteJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'energyRecords.js'), 'utf8');
assert(statisticsServiceJs.includes('LEFT JOIN organization_units ou ON ou.id = er.organization_unit_id'), '能耗明细应左关联用能单元，未关联记录不能因此查询失败。');
assert(statisticsServiceJs.includes('LEFT JOIN meter_devices md ON md.id = er.meter_device_id'), '能耗明细应左关联计量器具，未关联记录不能因此查询失败。');
assert(statisticsServiceJs.includes('ou.unit_path AS organizationUnitPath'), '能耗明细应返回用能单元路径展示字段。');
assert(statisticsServiceJs.includes('md.meter_name AS meterDeviceName'), '能耗明细应返回计量器具名称展示字段。');
assert(statisticsServiceJs.includes('ledgerAssociationStatus'), '能耗明细应返回台账关联状态。');
assert(statisticsServiceJs.includes('getEnergyRecordLedgerBackfillPreview'), '应提供历史 energy_records 台账关联回填预演服务。');
assert.strictEqual(
  typeof require('../services/energyRecordStatisticsService').getEnergyRecordLedgerBackfillPreview,
  'function',
  '历史 energy_records 台账关联回填预演服务必须导出可调用函数。'
);
assert(statisticsServiceJs.includes('writesEnergyRecords: false'), '历史台账关联预演必须明确不写入 energy_records。');
assert(statisticsServiceJs.includes('previewOnly: true'), '历史台账关联预演必须明确仅为 preview。');
assert(!/UPDATE\s+energy_records/i.test(statisticsServiceJs), '能耗统计服务不得提供 UPDATE energy_records 的回填路径。');
assert(energyRecordsRouteJs.includes("router.get('/ledger-backfill/preview'"), '应提供明确命名的历史台账关联预演接口。');
assert(energyRecordsRouteJs.includes('writesEnergyRecords: false'), '预演路由响应 meta 必须明确不写入 energy_records。');
assert(!/router\.(post|put|patch|delete)\('\/ledger-backfill/i.test(energyRecordsRouteJs), '不得提供执行历史台账回填的写接口。');

console.log('energy record query tests passed');
