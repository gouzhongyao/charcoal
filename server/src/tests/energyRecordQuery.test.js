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
const meterReadingServiceJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'meterReadingService.js'), 'utf8');
const meterReadingsRouteJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'meterReadings.js'), 'utf8');
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
assert.strictEqual(
  typeof require('../services/energyRecordStatisticsService').exportEnergyRecordLedgerBackfillPreview,
  'function',
  '历史 energy_records 台账关联回填预演审计预案导出服务必须导出可调用函数。'
);
assert(statisticsServiceJs.includes('writesEnergyRecords: false'), '历史台账关联预演必须明确不写入 energy_records。');
assert(statisticsServiceJs.includes('previewOnly: true'), '历史台账关联预演必须明确仅为 preview。');
assert(statisticsServiceJs.includes('preview-only / dry-run / no-write'), '导出文件必须包含醒目的 preview-only / dry-run / no-write 元信息。');
assert(statisticsServiceJs.includes('候选 organization_unit_id'), '导出字段应包含候选 organization_unit_id。');
assert(statisticsServiceJs.includes('候选 meter_device_id'), '导出字段应包含候选 meter_device_id。');
assert(statisticsServiceJs.includes('executeEnergyRecordLedgerBackfill'), '应提供受控执行历史台账回填服务。');
assert(statisticsServiceJs.includes('previewSignature'), 'preview 与执行审计必须包含 previewSignature。');
assert(statisticsServiceJs.includes("confirmText !== LEDGER_BACKFILL_CONFIRM_TEXT"), '执行服务必须校验固定确认文本。');
assert(statisticsServiceJs.includes("createBackup({ reason: 'ledger-backfill' })"), '执行服务必须在事务前自动创建 ledger-backfill 备份。');
assert(statisticsServiceJs.includes('body.acknowledgeSkippedRisks !== true'), '执行服务必须校验 acknowledgeSkippedRisks=true。');
assert(statisticsServiceJs.includes('body.requireBackup !== true'), '执行服务必须要求 requireBackup 显式为 true。');
assert(statisticsServiceJs.includes("record_status = 'active'"), '执行更新必须限制 active energy_records。');
assert(statisticsServiceJs.includes('organization_unit_id IS NULL'), '执行更新必须包含 organization_unit_id NULL 防覆盖条件。');
assert(statisticsServiceJs.includes('meter_device_id IS NULL'), '执行更新必须包含 meter_device_id NULL 防覆盖条件。');
assert(!/INSERT\s+INTO\s+energy_records/i.test(statisticsServiceJs), '能耗统计服务不得提供 INSERT energy_records 的回填路径。');
assert(!/DELETE\s+FROM\s+energy_records/i.test(statisticsServiceJs), '能耗统计服务不得提供 DELETE energy_records 的回填路径。');
assert(energyRecordsRouteJs.includes("router.get('/ledger-backfill/preview/export'"), '应提供明确命名的历史台账关联预演审计预案 GET 导出接口。');
assert(energyRecordsRouteJs.includes("router.get('/ledger-backfill/preview'"), '应提供明确命名的历史台账关联预演接口。');
assert(energyRecordsRouteJs.includes("router.post('/ledger-backfill/execute'"), '应提供受控执行历史台账回填 POST 接口。');
assert(energyRecordsRouteJs.includes("requireWritable('energy-records:ledger-backfill:execute')"), '执行路由必须使用维护态写保护。');
assert(energyRecordsRouteJs.includes('X-Writes-Energy-Records'), '预演导出路由响应头必须明确不写入 energy_records。');
assert(energyRecordsRouteJs.includes('writesEnergyRecords: false'), '预演路由响应 meta 必须明确不写入 energy_records。');
assert(!/router\.(put|patch|delete)\('\/ledger-backfill/i.test(energyRecordsRouteJs), '不得提供 PUT/PATCH/DELETE 历史台账回填写接口。');
assert.strictEqual(
  typeof require('../services/meterReadingService').getMeterReadingEnergyRecordGenerationPreview,
  'function',
  '应导出抄表生成 energy_records 预演服务。'
);
assert.strictEqual(
  typeof require('../services/meterReadingService').executeMeterReadingEnergyRecordGeneration,
  'function',
  '应导出抄表生成 energy_records 受控执行服务。'
);
assert(meterReadingServiceJs.includes("METER_READING_GENERATION_CONFIRM_TEXT = '确认由抄表生成能耗记录'"), '抄表生成必须使用固定确认文本。');
assert(meterReadingServiceJs.includes("createBackup({ reason: METER_READING_GENERATION_BACKUP_REASON })"), '抄表生成执行前必须自动创建专用 reason 备份。');
assert(meterReadingServiceJs.includes("METER_READING_GENERATION_BACKUP_REASON = 'meter-reading-energy-record-generation'"), '抄表生成必须使用专用备份 reason。');
assert(meterReadingServiceJs.includes('body.acknowledgeSkippedRisks !== true'), '抄表生成执行必须校验 acknowledgeSkippedRisks=true。');
assert(meterReadingServiceJs.includes('body.requireBackup !== true'), '抄表生成执行必须要求 requireBackup 显式为 true。');
assert(meterReadingServiceJs.includes('previewSignature'), '抄表生成 preview/execute 必须包含 previewSignature。');
assert(meterReadingServiceJs.includes('expectedWouldGenerate'), '抄表生成执行必须校验 expectedWouldGenerate。');
assert(meterReadingServiceJs.includes('candidateReadingIds'), '抄表生成执行必须校验 candidateReadingIds。');
assert(meterReadingServiceJs.includes("record_status = 'active'"), '抄表生成只应写入/回写 active 口径。');
assert(meterReadingServiceJs.includes('generated_energy_record_id IS NULL'), '抄表生成回写必须防止已 generated 重复生成。');
assert(meterReadingServiceJs.includes('meter-reading-month:'), '抄表生成 duplicate_key 必须支持月度唯一口径。');
assert(meterReadingServiceJs.includes("businessDimension: 'meter-reading-generation'"), '抄表生成能耗记录必须标记业务来源。');
assert(meterReadingServiceJs.includes('carbonAccountingDeferred: true'), '抄表生成必须声明碳核算联动后置。');
assert(meterReadingServiceJs.includes('MONTHLY_ACTIVE_ENERGY_RECORD_EXISTS'), '同仪表同月份同能源类型已有 active 能耗记录时必须冲突跳过。');
assert(meterReadingsRouteJs.includes("router.get('/energy-record-generation/preview'"), '应提供抄表生成只读 preview 接口。');
assert(meterReadingsRouteJs.includes("router.get('/energy-record-generation/preview/export'"), '应提供抄表生成审计预案导出接口。');
assert(meterReadingsRouteJs.includes("router.post('/energy-record-generation/execute'"), '应提供抄表生成受控 execute 接口。');
assert(meterReadingsRouteJs.includes("requireWritable('meter-readings:energy-record-generation:execute')"), '抄表生成执行路由必须使用写保护。');
assert(meterReadingsRouteJs.includes("X-Writes-Energy-Records', 'false'"), '抄表生成预演导出响应头必须明确不写入 energy_records。');
assert(!/router\.(put|patch|delete)\('\/energy-record-generation/i.test(meterReadingsRouteJs), '不得提供 PUT/PATCH/DELETE 抄表生成写接口。');

console.log('energy record query tests passed');
