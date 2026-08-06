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
  keyword: undefined,
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

const keywordFilters = normalizeEnergyRecordFilters({ search: '仪表_100%\\测试' });
assert.strictEqual(keywordFilters.keyword, '仪表_100%\\测试');
const keywordWhere = buildEnergyRecordWhere(keywordFilters);
assert.strictEqual(keywordWhere.whereSql.includes('et.name LIKE @keyword'), true);
assert.strictEqual(keywordWhere.whereSql.includes('md.meter_name LIKE @keyword'), true);
assert.strictEqual(keywordWhere.whereSql.includes('er.remark LIKE @keyword'), true);
assert.strictEqual(keywordWhere.whereSql.includes('仪表_100'), false);
assert.strictEqual(keywordWhere.params.keyword, '%仪表\\_100\\%\\\\测试%');

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
const productionServiceJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'productionService.js'), 'utf8');
const productionRouteJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'production.js'), 'utf8');
const serverIndexJs = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clientMainJs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'src', 'legacy-main.js'), 'utf8');
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
assert.strictEqual(
  typeof require('../services/energyRecordStatisticsService').exportEnergyRecords,
  'function',
  '能耗明细导出服务必须导出可调用函数。'
);
assert(statisticsServiceJs.includes('ENERGY_RECORD_EXPORT_FIELDS'), '能耗明细导出应使用固定字段白名单。');
assert(statisticsServiceJs.includes("fileName: `能耗明细-${date}.${format}`"), '能耗明细导出应使用中文文件名。');
assert(statisticsServiceJs.includes('normalizeEnergyRecordExportFormat'), '能耗明细导出格式必须限制为 xlsx/csv。');
assert(statisticsServiceJs.includes('writesEnergyRecords: false'), '历史台账关联预演必须明确不写入 energy_records。');
assert(statisticsServiceJs.includes('previewOnly: true'), '历史台账关联预演必须明确仅为 preview。');
assert(statisticsServiceJs.includes('历史能耗记录台账回填预演审计预案（仅预演、不写入）'), '导出文件必须包含醒目的中文只读预演说明。');
assert(statisticsServiceJs.includes('候选用能单元ID'), '导出字段应使用中文候选用能单元 ID 标题。');
assert(statisticsServiceJs.includes('候选计量器具ID'), '导出字段应使用中文候选计量器具 ID 标题。');
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
assert(energyRecordsRouteJs.includes('router.use(authenticate)'), '能耗记录路由必须统一要求登录。');
assert(energyRecordsRouteJs.includes("requireAnyPermission('energy:records:view', 'energy-records:view', 'energy:statistics:view')"), '只读能耗记录接口必须兼容新旧查看权限键。');
assert(energyRecordsRouteJs.includes("router.get('/export', requireEnergyRecordView"), '应提供受保护的能耗明细导出接口。');
assert(energyRecordsRouteJs.includes("requirePermission('energy:records:ledger-backfill:execute')"), '台账回填执行必须校验专用执行权限。');
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
assert.strictEqual(
  typeof require('../services/productionService').createProductionUnit,
  'function',
  '应导出产能单元新增服务。'
);
assert.strictEqual(
  typeof require('../services/productionService').getUnitEnergyIntensity,
  'function',
  '应导出单位产品能耗统计服务。'
);
assert(serverIndexJs.includes("const productionRoutes = require('./routes/production')"), '路由入口应加载 production 路由。');
assert(serverIndexJs.includes("app.use('/api/production', productionRoutes)"), '路由入口应挂载 /api/production。');
assert(productionRouteJs.includes("router.get('/statistics/unit-energy-intensity'"), '应提供单位产品能耗统计 GET 接口。');
assert(productionRouteJs.includes("router.get('/units'"), '应提供产能单元查询接口。');
assert(productionRouteJs.includes("router.post('/units'"), '应提供产能单元新增接口。');
assert(productionRouteJs.includes("router.put('/units/:id'"), '应提供产能单元编辑接口。');
assert(productionRouteJs.includes("router.delete('/units/:id'"), '应提供产能单元停用接口。');
assert(productionRouteJs.includes("router.get('/outputs/export'"), '应提供月度产量当前筛选导出接口。');
assert(productionRouteJs.includes("router.post('/outputs/import/preview'"), '应提供月度产量导入 preview 接口。');
assert(productionRouteJs.includes("router.post('/outputs/import/execute'"), '应提供月度产量导入受控 execute 接口。');
assert(productionRouteJs.includes("requireWritable('production:outputs-import-execute')"), '月度产量导入 execute 路由必须使用写保护。');
assert(productionRouteJs.includes('uploadImportFile'), '月度产量导入 preview 应沿用上传文件解析模式。');
assert(productionRouteJs.includes("router.get('/outputs'"), '应提供月度产量查询接口。');
assert(productionRouteJs.includes("router.post('/outputs'"), '应提供月度产量新增接口。');
assert(productionRouteJs.includes("router.put('/outputs/:id'"), '应提供月度产量编辑接口。');
assert(productionRouteJs.includes("router.delete('/outputs/:id'"), '应提供月度产量作废接口。');
assert(productionRouteJs.includes("requireWritable('production:create-unit')"), '产能单元新增路由必须使用写保护。');
assert(productionRouteJs.includes("requireWritable('production:void-output')"), '月度产量作废路由必须使用写保护。');
assert(productionServiceJs.includes("FROM energy_records er"), '单位产品能耗统计应读取 energy_records。');
assert(productionServiceJs.includes("er.record_status = 'active'"), '单位产品能耗统计只应纳入 active energy_records。');
assert(productionServiceJs.includes('er.organization_unit_id = @organizationUnitId'), '单位产品能耗统计应按产能单元所属用能单元汇总。');
assert(productionServiceJs.includes('production_output_records') && productionServiceJs.includes("record_status = 'active'"), '单位产品能耗统计应按 active 月度产量计算。');
assert(productionServiceJs.includes('energyByType'), '单位产品能耗响应应包含能源类型明细，避免混合能源误解。');
assert(productionServiceJs.includes('不做跨能源等价换算'), '跨能源类型汇总必须提示谨慎解释。');
assert(productionServiceJs.includes('generationIncluded: false'), 'P2 首期不得纳入发电/自发自用。');
assert(productionServiceJs.includes("PRODUCTION_OUTPUT_IMPORT_CONFIRM_TEXT = '确认导入月度产量记录'"), '月度产量导入必须使用固定确认文本。');
assert(productionServiceJs.includes("PRODUCTION_OUTPUT_IMPORT_BACKUP_REASON = 'production-output-import'"), '月度产量导入必须使用专用备份 reason。');
assert(productionServiceJs.includes('createProductionOutputImportPreviewFromUpload'), '应提供月度产量导入 preview 服务。');
assert(productionServiceJs.includes('executeProductionOutputImport'), '应提供月度产量受控 execute 服务。');
assert(productionServiceJs.includes('previewSignature'), '月度产量导入 preview/execute 必须包含 previewSignature。');
assert(productionServiceJs.includes('createHmac'), '月度产量导入 previewSignature 必须使用服务端 HMAC 签名。');
assert(productionServiceJs.includes('PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET'), '月度产量导入 HMAC secret 应优先来自服务端环境变量。');
assert(productionServiceJs.includes('DEFAULT_PRODUCTION_OUTPUT_IMPORT_HMAC_SECRET'), '本地轻量化环境应提供进程内开发 fallback secret。');
assert(productionServiceJs.includes('timingSafeEqual'), '月度产量导入 execute 应使用 timing-safe 比对签名。');
assert(productionServiceJs.includes('buildProductionOutputImportSignaturePayload'), '月度产量导入签名 payload 应集中绑定 preview 元信息。');
assert(productionServiceJs.includes('summary: preview.summary'), '月度产量导入 HMAC 签名必须绑定 summary。');
assert(productionServiceJs.includes('candidateRowIds: preview.candidateRowIds'), '月度产量导入 HMAC 签名必须绑定 candidateRowIds。');
assert(productionServiceJs.includes('candidateRows: preview.candidateRows'), '月度产量导入 HMAC 签名必须绑定 candidateRows。');
assert(!productionServiceJs.includes('expected: preview.previewSignature, actual: previewSignature'), '签名不匹配错误不得回显服务端 HMAC 期望值。');
assert(productionServiceJs.includes('verifyProductionOutputImportPreviewSignature'), 'execute 应通过统一校验函数验证 HMAC 签名。');
assert(productionServiceJs.includes('expectedWouldImport'), '月度产量导入 execute 必须校验 expectedWouldImport。');
assert(productionServiceJs.includes('candidateRowIds'), '月度产量导入 execute 必须校验 candidateRowIds。');
assert(productionServiceJs.includes('candidateRows'), '月度产量导入 execute 必须基于 candidateRows 重新预演。');
assert(productionServiceJs.includes('body.acknowledgeSkippedRisks !== true'), '月度产量导入 execute 必须校验 acknowledgeSkippedRisks=true。');
assert(productionServiceJs.includes('body.requireBackup !== true'), '月度产量导入 execute 必须要求 requireBackup=true。');
assert(productionServiceJs.includes('DUPLICATE_ACTIVE_PRODUCTION_OUTPUT_SKIPPED'), '同产能单元同月份已有 active 产量时必须 skip warning。');
assert(productionServiceJs.includes('UNKNOWN_PRODUCTION_UNIT'), '月度产量导入不得自动创建产能单元，应明确未知编码。');
assert(productionServiceJs.includes('PRODUCTION_UNIT_NAME_MISMATCH'), 'unitName 应辅助校验编码匹配结果。');
assert(productionServiceJs.includes('AMBIGUOUS_PRODUCTION_UNIT_NAME'), 'unitName 名称歧义应报错。');
assert(productionServiceJs.includes('OUTPUT_UNIT_MISMATCH'), '单位不一致不得静默改单位，应有明确 warning/block。');
assert(productionServiceJs.includes('persistsImportBatch: true'), '月度产量 preview 应声明已持久化 import_batches/import_errors 审计批次。');
assert(productionServiceJs.includes('carbonAccountingIncluded: false'), 'P2 首期不得纳入碳核算联动。');
assert(!/photovoltaic-generation|self-use|carbon_emissions/i.test(productionRouteJs), 'P2 首期 production 路由不得实现发电、自发自用或碳核算联动。');
assert(!/INSERT\s+INTO\s+carbon_emissions|UPDATE\s+carbon_emissions/i.test(productionServiceJs), 'P2 首期产能服务不得写入碳核算结果。');
assert(clientMainJs.includes("tab: 'production'") && clientMainJs.includes('产能单元'), '前端基础台账应存在产能单元页签/入口。');
assert(clientMainJs.includes("safeApi('/production/units") || clientMainJs.includes('safeApi(`/production/units'), '前端应调用 /production/units。');
assert(clientMainJs.includes("safeApi('/production/outputs") || clientMainJs.includes('safeApi(`/production/outputs'), '前端应调用 /production/outputs。');
assert(clientMainJs.includes('/production/statistics/unit-energy-intensity'), '前端应调用 /production/statistics/unit-energy-intensity。');
assert(clientMainJs.includes('所属用能单元当月 active energy_records'), '前端应展示所属用能单元当月 active energy_records 口径提示。');
assert(clientMainJs.includes('发电自用已独立维护但不纳入单位产品能耗'), '产能单元页应提示发电自用独立维护且不纳入单位产品能耗。');
assert(clientMainJs.includes('碳核算联动后置'), '前端应保留碳核算联动后置提示。');
assert(clientMainJs.includes('energyByType 明细'), '前端应展示 energyByType 明细，避免跨能源类型汇总误解。');
assert(clientMainJs.includes('function renderLockedProductionUnitOrganizationField'), '编辑产能单元时应提供锁定所属用能单元的渲染函数。');
assert(clientMainJs.includes("type: 'hidden', name: 'organizationUnitId'"), '编辑产能单元时应通过隐藏字段保留原 organizationUnitId。');
assert(clientMainJs.includes("disabled: 'disabled', 'aria-label': '产能单元所属用能单元已锁定'"), '编辑产能单元时所属用能单元下拉应锁定，避免用户误以为可普通改挂。');
assert(clientMainJs.includes('原用能单元已停用；编辑产能单元时锁定所属用能单元，不会静默改挂到其它 active 用能单元。'), '编辑所属 inactive 用能单元的产能单元时应明确提示已停用且不会静默改挂。');
assert(clientMainJs.includes('? renderLockedProductionUnitOrganizationField(editingProductionUnit, selectedOrganizationUnit)'), '产能单元编辑模式必须使用锁定归属字段，而不是仅渲染 active 用能单元下拉。');
assert(!/ledgerSelectField\('organizationUnitId', '所属用能单元', getLedgerUnitOptions\(activeUnits, false\), editingProductionUnit\?\.organizationUnitId \|\| activeUnits\[0\]\?\.id \|\| ''\)/.test(clientMainJs), '产能单元编辑模式不得继续复用 active-only 可变用能单元下拉，避免浏览器提交首个 active 选项。');
assert(clientMainJs.includes('function renderLockedProductionOutputUnitField'), '编辑月度产量时应提供锁定所属产能单元的渲染函数。');
assert(clientMainJs.includes("type: 'hidden', name: 'productionUnitId'"), '编辑月度产量时应通过隐藏字段保留原 productionUnitId。');
assert(clientMainJs.includes("disabled: 'disabled', 'aria-label': '月度产量所属产能单元已锁定'"), '编辑月度产量时所属产能单元下拉应锁定，避免用户误以为可普通改挂。');
assert(clientMainJs.includes('原产能单元已停用；编辑月度产量时锁定所属产能单元，不会静默改挂到其它 active 产能单元。'), '编辑 inactive 原产能单元下的月度产量时应明确提示已停用且不会静默改挂。');
assert(clientMainJs.includes('? renderLockedProductionOutputUnitField(editingOutput, selectedUnit)'), '月度产量编辑模式必须使用锁定归属字段，而不是仅渲染 active 产能单元下拉。');
assert(!/editingOutput\?\.productionUnitId \|\| selectedUnit\?\.id \|\| '', \{ dataset: \{ role: 'ledger-production-output-unit' \} \}/.test(clientMainJs), '月度产量编辑模式不得继续复用可变 active 产能单元下拉，避免浏览器提交首个 active 选项。');
assert(clientMainJs.includes('请先新增或启用用能单元'), '新增产能单元在没有 active 用能单元时应显示明确占位。');
assert(clientMainJs.includes('请先到“用能单元”页签新增或启用 active 用能单元，再新增产能单元。'), '新增产能单元在没有 active 用能单元时应提示去用能单元页签处理。');
assert(clientMainJs.includes('新增产能单元前，请先在“用能单元”页签新增或启用 active 用能单元，并选择所属用能单元。'), '产能单元提交前应补充缺少 organizationUnitId 的明确错误提示。');
assert(clientMainJs.includes('请先新增或启用产能单元'), '新增月度产量在没有 active 产能单元时应显示明确占位。');
assert(clientMainJs.includes('请先新增或启用 active 产能单元，再新增月度产量。'), '新增月度产量在没有 active 产能单元时应提示先新增 active 产能单元。');
assert(clientMainJs.includes('新增月度产量只能选择 active 产能单元'), '新增月度产量应明确只允许 active 产能单元。');
assert(clientMainJs.includes('新增月度产量前，请先新增或启用 active 产能单元，并选择产能单元。'), '月度产量提交前应补充缺少 productionUnitId 的明确错误提示。');
assert(clientMainJs.includes("disabled: disableCreate ? 'disabled' : undefined"), '没有 active 前置数据时新增产能单元/月度产量提交按钮应具备禁用标记。');
assert(clientMainJs.includes('disabled: option.disabled'), '下拉空态占位选项应支持禁用标记。');
assert(!clientMainJs.includes('activeProductionUnits.length > 0 ? activeProductionUnits : productionUnits'), '新增月度产量不得在没有 active 产能单元时回退展示 inactive 产能单元。');
assert(clientMainJs.includes('production-outputs'), '前端应提供月度产量导入模板下载入口。');
assert(clientMainJs.includes('/production/outputs/export'), '前端应提供月度产量当前筛选导出入口。');
assert(clientMainJs.includes('/production/outputs/import/preview'), '前端应提供月度产量导入 preview 请求。');
assert(clientMainJs.includes('/production/outputs/import/execute'), '前端应提供月度产量受控 execute 请求。');
assert(clientMainJs.includes('确认导入月度产量记录'), '前端受控执行必须要求固定确认文本。');
assert(clientMainJs.includes('expectedWouldImport'), '前端受控执行请求体必须包含 expectedWouldImport。');
assert(clientMainJs.includes('candidateRowIds'), '前端受控执行请求体必须包含 candidateRowIds。');
assert(clientMainJs.includes('candidateRows'), '前端受控执行请求体必须包含 candidateRows。');
assert(clientMainJs.includes('acknowledgeSkippedRisks: true'), '前端受控执行请求体必须显式确认跳过风险。');
assert(clientMainJs.includes('requireBackup: true'), '前端受控执行请求体必须要求服务端备份。');
assert(clientMainJs.includes('不覆盖、不作废旧记录，不自动创建产能单元'), '前端必须展示月度产量导入非目标边界。');
assert(!/data-action=['"][^'"]*(?:self-use|carbon-accounting)|\/production\/[^`'"\s]*(?:self-use|photovoltaic|carbon)|carbonAccountingIncluded:\s*true/i.test(clientMainJs), 'P2 首期前端不得在产能单元中实现自发自用计算、发电或碳核算联动入口。');

console.log('energy record query tests passed');
