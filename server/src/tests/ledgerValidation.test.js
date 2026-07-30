const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  buildEnergyRecordLedgerBackfillPreview,
  buildLedgerBackfillPreviewIndexes,
  buildLedgerImportIndexes,
  buildLedgerIndexes,
  buildMeterExportRows,
  buildOrganizationUnitExportRows,
  buildUnitPath,
  createDeactivationResult,
  findLedgerAssociationsForImportRecord,
  mapLedgerImportFields,
  normalizeMeterPayload,
  normalizeUnitPayload,
  validateAndNormalizeMeterImportRow,
  validateAndNormalizeOrganizationUnitImportRow
} = require('../services/ledgerService');
const {
  buildImportBatchesImportTypeMigrationSql,
  importBatchesImportTypeCheckAllowsLedgerTypes
} = require('../db/database');
const {
  assertImportBatchCanUseGenericDelete
} = require('../services/importService');
const {
  exportEnergyRecordLedgerBackfillPreview
} = require('../services/energyRecordStatisticsService');
const {
  getTemplateDefinition,
  getTemplateCsv,
  getTemplateXlsx
} = require('../services/templateService');
const {
  buildMeterReadingEnergyTrace,
  buildMeterReadingExportRows,
  buildMeterReadingImportIndexes,
  buildMeterReadingPayload,
  calculateUsageValue,
  executeMeterReadingEnergyRecordGeneration,
  exportMeterReadingEnergyRecordGenerationPreview,
  getMeterReadingEnergyRecordGenerationPreview,
  mapMeterReadingImportFields,
  normalizeReadingDate,
  normalizeReadingUnit,
  validateAndNormalizeMeterReadingImportRow,
  voidMeterReading
} = require('../services/meterReadingService');

assert.strictEqual(buildUnitPath(null, '企业A'), '企业A');
assert.strictEqual(buildUnitPath('企业A/一车间', '热处理'), '企业A/一车间/热处理');
assert.throws(
  () => buildUnitPath('企业A', ''),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'REQUIRED_FIELD_MISSING'
);

const unitPayload = normalizeUnitPayload({
  parentId: '1',
  unitCode: ' OU-001 ',
  unitName: ' 一车间 ',
  unitType: 'workshop',
  area: '123.45',
  sortOrder: '2',
  status: 'active',
  remark: '测试'
});
assert.deepStrictEqual(unitPayload, {
  parentId: 1,
  unitCode: 'OU-001',
  unitName: '一车间',
  unitType: 'workshop',
  area: 123.45,
  sortOrder: 2,
  status: 'active',
  remark: '测试'
});
assert.throws(
  () => normalizeUnitPayload({ unitCode: 'OU-002', unitName: '错误类型', unitType: 'building' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_LEDGER_VALUE'
);
assert.throws(
  () => normalizeUnitPayload({ unitCode: 'OU-003', unitName: '负面积', unitType: 'department', area: '-1' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_NON_NEGATIVE_NUMBER'
);

const meterPayload = normalizeMeterPayload({
  meterCode: ' M-001 ',
  meterName: ' 一车间电表 ',
  meterType: 'electricity',
  energyTypeId: '2',
  organizationUnitId: '3',
  onlineStatus: 'unknown',
  gatewayId: ' GW-1 ',
  multiplier: '1.5',
  allowManualReading: 'false',
  flowDirection: 'input',
  installLocation: '配电室',
  status: 'active'
});
assert.strictEqual(meterPayload.meterCode, 'M-001');
assert.strictEqual(meterPayload.energyTypeId, 2);
assert.strictEqual(meterPayload.organizationUnitId, 3);
assert.strictEqual(meterPayload.multiplier, 1.5);
assert.strictEqual(meterPayload.allowManualReading, 0);
assert.throws(
  () => normalizeMeterPayload({ meterCode: 'M-2', meterName: '负倍率', energyTypeId: '1', organizationUnitId: '1', multiplier: '0' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_NUMBER'
);
assert.throws(
  () => normalizeMeterPayload({ meterCode: 'M-3', meterName: '坏状态', energyTypeId: '1', organizationUnitId: '1', onlineStatus: 'realtime' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_LEDGER_VALUE'
);

const indexes = buildLedgerIndexes({
  organizationUnits: [
    { id: 10, unitCode: 'OU-10', unitName: '一车间', unitPath: '企业A/一车间', status: 'active' },
    { id: 11, unitCode: 'OU-11', unitName: '停用车间', unitPath: '企业A/停用车间', status: 'inactive' },
    { id: 12, unitCode: 'OU-12', unitName: '二车间', unitPath: '企业A/二车间', status: 'active' }
  ],
  meterDevices: [
    { id: 20, meterCode: 'M-20', meterName: '一车间电表', energyTypeId: 1, organizationUnitId: 10, status: 'active' },
    { id: 21, meterCode: 'M-21', meterName: '燃气表', energyTypeId: 2, organizationUnitId: 10, status: 'active' },
    { id: 22, meterCode: 'M-22', meterName: '停用表', energyTypeId: 1, organizationUnitId: 10, status: 'inactive' },
    { id: 23, meterCode: 'M-23', meterName: '二车间电表', energyTypeId: 1, organizationUnitId: 12, status: 'active' },
    { id: 24, meterCode: 'M-24', meterName: '共用标识', energyTypeId: 1, organizationUnitId: 10, status: 'active' },
    { id: 25, meterCode: '共用标识', meterName: '二车间冲突表', energyTypeId: 1, organizationUnitId: 12, status: 'active' }
  ]
});

assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: '企业A/一车间', meterCode: 'M-20', energyTypeId: 1 }, indexes), {
  organizationUnitId: 10,
  meterDeviceId: 20
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: 'OU-10', meterCode: '一车间电表', energyTypeId: 1 }, indexes), {
  organizationUnitId: 10,
  meterDeviceId: 20
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: '一车间', meterCode: 'M-21', energyTypeId: 1 }, indexes), {
  organizationUnitId: 10,
  meterDeviceId: null
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: '一车间', meterCode: 'M-23', energyTypeId: 1 }, indexes), {
  organizationUnitId: 10,
  meterDeviceId: null
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ meterCode: 'M-23', energyTypeId: 1 }, indexes), {
  organizationUnitId: null,
  meterDeviceId: 23
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: '一车间', meterCode: '共用标识', energyTypeId: 1 }, indexes), {
  organizationUnitId: 10,
  meterDeviceId: 24
});
assert.deepStrictEqual(findLedgerAssociationsForImportRecord({ organization: '不存在', meterCode: '不存在', energyTypeId: 1 }, indexes), {
  organizationUnitId: null,
  meterDeviceId: null
});

const backfillPreviewIndexes = buildLedgerBackfillPreviewIndexes({
  organizationUnits: [
    { id: 10, unitCode: 'OU-10', unitName: '一车间', unitPath: '企业A/一车间', status: 'active' },
    { id: 11, unitCode: 'OU-11', unitName: '一车间', unitPath: '企业B/一车间', status: 'active' },
    { id: 12, unitCode: 'OU-12', unitName: '二车间', unitPath: '企业A/二车间', status: 'active' },
    { id: 13, unitCode: 'OU-13', unitName: '停用车间', unitPath: '企业A/停用车间', status: 'inactive' }
  ],
  meterDevices: [
    { id: 20, meterCode: 'M-20', meterName: '一车间电表', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 10, organizationUnitCode: 'OU-10', organizationUnitName: '一车间', organizationUnitPath: '企业A/一车间', status: 'active' },
    { id: 21, meterCode: 'M-21', meterName: '二车间电表', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 12, organizationUnitCode: 'OU-12', organizationUnitName: '二车间', organizationUnitPath: '企业A/二车间', status: 'active' },
    { id: 22, meterCode: 'M-22', meterName: '燃气表', energyTypeId: 2, energyTypeCode: 'natural_gas', organizationUnitId: 10, organizationUnitCode: 'OU-10', organizationUnitName: '一车间', organizationUnitPath: '企业A/一车间', status: 'active' },
    { id: 23, meterCode: 'AMB-M', meterName: '重名表A', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 10, organizationUnitCode: 'OU-10', organizationUnitName: '一车间', organizationUnitPath: '企业A/一车间', status: 'active' },
    { id: 24, meterCode: 'AMB-M', meterName: '重名表B', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 12, organizationUnitCode: 'OU-12', organizationUnitName: '二车间', organizationUnitPath: '企业A/二车间', status: 'active' }
  ]
});
const candidateByMeterPreview = buildEnergyRecordLedgerBackfillPreview({ id: 100, energyTypeId: 1, energyTypeCode: 'electricity', organization: '企业A/一车间', meterCode: 'M-20' }, backfillPreviewIndexes);
assert.strictEqual(candidateByMeterPreview.status, 'candidate-by-meter');
assert.strictEqual(candidateByMeterPreview.wouldUpdate, true);
assert.deepStrictEqual(candidateByMeterPreview.candidate, { organizationUnitId: 10, meterDeviceId: 20 });
const candidateByOrganizationPreview = buildEnergyRecordLedgerBackfillPreview({ id: 101, energyTypeId: 1, energyTypeCode: 'electricity', organization: 'OU-12', meterCode: '' }, backfillPreviewIndexes);
assert.strictEqual(candidateByOrganizationPreview.status, 'candidate-by-organization');
assert.deepStrictEqual(candidateByOrganizationPreview.candidate, { organizationUnitId: 12, meterDeviceId: null });
const conflictPreview = buildEnergyRecordLedgerBackfillPreview({ id: 102, energyTypeId: 1, energyTypeCode: 'electricity', organization: '企业A/一车间', meterCode: 'M-21' }, backfillPreviewIndexes);
assert.strictEqual(conflictPreview.status, 'blocked');
assert(conflictPreview.reasons.some((reason) => reason.code === 'METER_ORGANIZATION_CONFLICT'), '组织与仪表归属冲突时必须阻断确定回填。');
const ambiguousMeterPreview = buildEnergyRecordLedgerBackfillPreview({ id: 103, energyTypeId: 1, energyTypeCode: 'electricity', meterCode: 'AMB-M' }, backfillPreviewIndexes);
assert.strictEqual(ambiguousMeterPreview.status, 'ambiguous');
assert(ambiguousMeterPreview.reasons.some((reason) => reason.code === 'AMBIGUOUS_METER_CODE'), '计量器具编码多匹配时必须返回 ambiguous。');
const ambiguousOrganizationPreview = buildEnergyRecordLedgerBackfillPreview({ id: 104, energyTypeId: 1, energyTypeCode: 'electricity', organization: '一车间' }, backfillPreviewIndexes);
assert.strictEqual(ambiguousOrganizationPreview.status, 'ambiguous');
assert(ambiguousOrganizationPreview.reasons.some((reason) => reason.code === 'AMBIGUOUS_ORGANIZATION_UNIT'), '用能单元名称多匹配时必须返回 ambiguous。');
const missingPreview = buildEnergyRecordLedgerBackfillPreview({ id: 105, energyTypeId: 1, energyTypeCode: 'electricity' }, backfillPreviewIndexes);
assert.strictEqual(missingPreview.status, 'missing');
assert.strictEqual(missingPreview.wouldUpdate, false);
assert(missingPreview.reasons.some((reason) => reason.code === 'NO_ORGANIZATION_SOURCE'), '缺少组织原始字段时应返回明确原因。');
assert(missingPreview.reasons.some((reason) => reason.code === 'NO_METER_SOURCE'), '缺少仪表原始字段时应返回明确原因。');
const existingMeterInfersOrganizationPreview = buildEnergyRecordLedgerBackfillPreview({ id: 106, energyTypeId: 1, energyTypeCode: 'electricity', meterDeviceId: 20 }, backfillPreviewIndexes);
assert.strictEqual(existingMeterInfersOrganizationPreview.status, 'candidate-by-organization');
assert.deepStrictEqual(existingMeterInfersOrganizationPreview.candidate, { organizationUnitId: 10, meterDeviceId: null });

assert.deepStrictEqual(createDeactivationResult({ id: 1 }, { energyRecords: 2, meterDevices: 3 }), {
  id: 1,
  status: 'inactive',
  deactivated: true,
  referenceCounts: { energyRecords: 2, meterDevices: 3 }
});

const organizationTemplate = getTemplateDefinition('organization-units');
const meterTemplate = getTemplateDefinition('meters');
assert(organizationTemplate, '应提供 organization-units 台账导入模板。');
assert(meterTemplate, '应提供 meters 台账导入模板。');
assert.strictEqual(organizationTemplate.contractRoute, 'POST /api/organization/units/import');
assert.strictEqual(meterTemplate.contractRoute, 'POST /api/meters/import');
assert(getTemplateCsv('organization-units').csv.includes('unit_code'), '用能单元模板应支持 CSV 下载。');
assert(getTemplateXlsx('meters').buffer.length > 0, '计量器具模板应支持 xlsx 下载。');

assert(importBatchesImportTypeCheckAllowsLedgerTypes("CREATE TABLE import_batches (import_type TEXT CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device')))"), 'import_batches 新 CHECK 应允许台账导入类型。');
assert(!importBatchesImportTypeCheckAllowsLedgerTypes("CREATE TABLE import_batches (import_type TEXT CHECK (import_type IN ('energy_record', 'meter_reading')))"), '旧 import_batches CHECK 应被识别为需迁移。');
assert(buildImportBatchesImportTypeMigrationSql().some((sql) => sql.includes("'organization_unit'")), '旧库迁移 SQL 应扩展 organization_unit。');
assert(buildImportBatchesImportTypeMigrationSql().some((sql) => sql.includes("'meter_device'")), '旧库迁移 SQL 应扩展 meter_device。');

const ledgerImportIndexes = buildLedgerImportIndexes({
  organizationUnits: [
    { id: 10, unitCode: 'OU-10', unitName: '一车间', unitPath: '企业A/一车间', status: 'active' },
    { id: 11, unitCode: 'OU-11', unitName: '一车间', unitPath: '企业B/一车间', status: 'active' },
    { id: 12, unitCode: 'OU-12', unitName: '停用车间', unitPath: '企业A/停用车间', status: 'inactive' }
  ],
  meterDevices: [
    { id: 20, meterCode: 'M-20' }
  ],
  energyTypes: [
    { id: 1, code: 'electricity', name: '电力' },
    { id: 2, code: 'heat', name: '热力' }
  ]
});
assert.deepStrictEqual(mapLedgerImportFields({ 用能单元编码: 'OU-20', 用能单元名称: '二车间' }, {
  unitCode: ['unit_code', '用能单元编码'],
  unitName: ['unit_name', '用能单元名称']
}).mapped, { unitCode: 'OU-20', unitName: '二车间' });
const validUnitImport = validateAndNormalizeOrganizationUnitImportRow({
  unit_code: 'OU-20',
  unit_name: '二车间',
  parent_code: 'OU-10',
  unit_type: 'workshop',
  area: '100',
  sort_order: '3',
  status: 'active'
}, 2, ledgerImportIndexes);
assert.strictEqual(validUnitImport.errors.length, 0);
assert.strictEqual(validUnitImport.record.parentId, 10);
assert.strictEqual(validUnitImport.record.unitCode, 'OU-20');
const ambiguousParentImport = validateAndNormalizeOrganizationUnitImportRow({
  unit_code: 'OU-21',
  unit_name: '三车间',
  parent_name: '一车间',
  unit_type: 'workshop'
}, 3, ledgerImportIndexes);
assert(ambiguousParentImport.errors.some((error) => error.errorCode === 'AMBIGUOUS_PARENT_UNIT'), '父级名称多结果时不应随机选择。');
const validMeterImport = validateAndNormalizeMeterImportRow({
  meter_code: 'M-21',
  meter_name: '二车间电表',
  meter_type: 'electricity',
  energy_type_code: 'electricity',
  organization_unit_code: 'OU-10',
  multiplier: '1.5',
  allow_manual_reading: '1'
}, 4, ledgerImportIndexes);
assert.strictEqual(validMeterImport.errors.length, 0);
assert.strictEqual(validMeterImport.record.energyTypeId, 1);
assert.strictEqual(validMeterImport.record.organizationUnitId, 10);
const ambiguousMeterUnitImport = validateAndNormalizeMeterImportRow({
  meter_code: 'M-22',
  meter_name: '冲突车间电表',
  energy_type_code: 'electricity',
  organization_unit: '一车间'
}, 5, ledgerImportIndexes);
assert(ambiguousMeterUnitImport.errors.some((error) => error.errorCode === 'AMBIGUOUS_ORGANIZATION_UNIT'), '计量器具导入用能单元名称多结果时不应随机选择。');
const missingEnergyImport = validateAndNormalizeMeterImportRow({
  meter_code: 'M-23',
  meter_name: '未知能源表',
  energy_type_code: 'unknown_energy',
  organization_unit_code: 'OU-10'
}, 6, ledgerImportIndexes);
assert(missingEnergyImport.errors.some((error) => error.errorCode === 'UNKNOWN_ENERGY_TYPE'), '计量器具导入应拒绝不存在的能源类型。');
assert.deepStrictEqual(buildOrganizationUnitExportRows([{ unitCode: 'OU-10', unitName: '一车间', unitPath: '企业A/一车间', parentCode: 'OU-1', parentName: '企业A', unitType: 'workshop', area: 100, sortOrder: 1, status: 'active', remark: '导出' }])[0], {
  '用能单元编码': 'OU-10',
  '用能单元名称': '一车间',
  '用能单元路径': '企业A/一车间',
  '父级编码': 'OU-1',
  '父级名称': '企业A',
  '类型': 'workshop',
  '面积': 100,
  '排序': 1,
  '状态': 'active',
  '备注': '导出'
});
assert.deepStrictEqual(buildMeterExportRows([{ meterCode: 'M-20', meterName: '一车间电表', meterType: 'electricity', energyTypeCode: 'electricity', energyTypeName: '电力', organizationUnitCode: 'OU-10', organizationUnitPath: '企业A/一车间', onlineStatus: 'unknown', gatewayId: 'GW-1', multiplier: 1, allowManualReading: 1, flowDirection: 'input', installLocation: '配电室', status: 'active', remark: '导出' }])[0], {
  '计量器具编码': 'M-20',
  '计量器具名称': '一车间电表',
  '类型': 'electricity',
  '能源类型编码': 'electricity',
  '能源类型': '电力',
  '用能单元编码': 'OU-10',
  '用能单元': '企业A/一车间',
  '在线状态': 'unknown',
  '网关ID': 'GW-1',
  '倍率': 1,
  '允许手工抄表': 1,
  '流向': 'input',
  '安装位置': '配电室',
  '状态': 'active',
  '备注': '导出'
});

const ledgerImportExportSmokeScript = String.raw`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

(async () => {
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-ledger-import-export-'));
try {
  process.env.DATA_DIR = path.join(tmpDir, 'data');
  process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'ledger-smoke.sqlite');
  process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
  process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');

  const { getDatabaseInfo, initDatabase, openDatabase } = require(path.join(process.cwd(), 'server', 'src', 'db', 'database'));
  const {
    executeEnergyRecordLedgerBackfill,
    exportEnergyRecordLedgerBackfillPreview,
    getEnergyRecordLedgerBackfillPreview
  } = require(path.join(process.cwd(), 'server', 'src', 'services', 'energyRecordStatisticsService'));
  const {
    createMeter,
    createMeterImportBatchFromUpload,
    createOrganizationUnit,
    createOrganizationUnitImportBatchFromUpload,
    exportMeters,
    exportOrganizationUnits
  } = require(path.join(process.cwd(), 'server', 'src', 'services', 'ledgerService'));

  initDatabase();
  assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '临时 smoke 必须使用隔离 SQLite 文件。');

  function writeCsv(fileName, rows) {
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, '﻿' + rows.join('\n') + '\n', 'utf8');
    return {
      path: filePath,
      originalname: fileName,
      filename: fileName,
      size: fs.statSync(filePath).size
    };
  }

  function getErrorCodes(batch) {
    return batch.errors.map((error) => error.errorCode).sort();
  }

  const root = createOrganizationUnit({ unitCode: 'ROOT', unitName: '验收总厂', unitType: 'enterprise' });
  const dbForEnergy = openDatabase();
  const electricity = dbForEnergy.prepare("SELECT id FROM energy_types WHERE code = 'electricity' AND is_active = 1").get();
  dbForEnergy.close();
  assert(electricity && electricity.id, '临时 schema 应初始化 electricity 能源类型。');
  createMeter({
    meterCode: 'EXIST-M',
    meterName: '已存在电表',
    meterType: 'electricity',
    energyTypeId: electricity.id,
    organizationUnitId: root.id,
    onlineStatus: 'unknown',
    multiplier: 1,
    allowManualReading: 1,
    status: 'active'
  });

  const unitFile = writeCsv('organization-units.csv', [
    'unit_code,unit_name,parent_code,unit_type,area,sort_order,status,remark',
    'UT-1,一车间,ROOT,workshop,100,1,active,成功行',
    'ROOT,重复总厂,,enterprise,0,2,active,数据库重复应 skip',
    'UT-1,文件重复车间,ROOT,workshop,50,3,active,同文件重复应 skip',
    'UT-BAD,坏父级车间,MISSING,workshop,50,4,active,父级不存在应失败'
  ]);
  const unitBatch = createOrganizationUnitImportBatchFromUpload(unitFile);
  assert.strictEqual(unitBatch.importType, 'organization_unit');
  assert.strictEqual(unitBatch.status, 'completed_with_errors');
  assert.deepStrictEqual(unitBatch.summary, {
    batchId: unitBatch.id,
    status: 'completed_with_errors',
    totalRows: 4,
    successCount: 1,
    failureCount: 1,
    skippedCount: 2,
    validationErrorCount: 1
  });
  assert(getErrorCodes(unitBatch).includes('DUPLICATE_UNIT_CODE_SKIPPED'), '用能单元导入应记录数据库重复 skip warning。');
  assert(getErrorCodes(unitBatch).includes('DUPLICATE_UNIT_CODE_IN_FILE_SKIPPED'), '用能单元导入应记录同文件重复 skip warning。');
  assert(getErrorCodes(unitBatch).includes('UNKNOWN_PARENT_UNIT'), '用能单元导入应记录父级不存在错误。');

  const unitExport = exportOrganizationUnits({ format: 'csv', keyword: '一车间' });
  assert.strictEqual(unitExport.format, 'csv');
  assert.strictEqual(unitExport.rowCount, 1);
  const unitCsv = unitExport.body.toString('utf8');
  assert(unitCsv.includes('用能单元编码'));
  assert(unitCsv.includes('UT-1'));
  const dbForImportedUnit = openDatabase();
  const importedUnit = dbForImportedUnit.prepare("SELECT id FROM organization_units WHERE unit_code = 'UT-1'").get();
  dbForImportedUnit.close();
  assert(importedUnit && importedUnit.id, '用能单元导入应在临时库写入成功行。');

  const meterFile = writeCsv('meters.csv', [
    'meter_code,meter_name,meter_type,energy_type_code,organization_unit_code,online_status,gateway_id,multiplier,allow_manual_reading,flow_direction,install_location,status,remark',
    'MT-1,一车间电表,electricity,electricity,UT-1,unknown,GW-1,1.5,1,input,配电室,active,成功行',
    'EXIST-M,已存在电表,electricity,electricity,ROOT,unknown,,1,1,input,配电室,active,数据库重复应 skip',
    'MT-1,文件重复电表,electricity,electricity,UT-1,unknown,,1,1,input,配电室,active,同文件重复应 skip',
    'MT-BAD-ENERGY,未知能源表,electricity,missing_energy,UT-1,unknown,,1,1,input,配电室,active,能源类型不存在应失败',
    'MT-BAD-UNIT,未知单元表,electricity,electricity,MISSING_UNIT,unknown,,1,1,input,配电室,active,用能单元不存在应失败'
  ]);
  const meterBatch = createMeterImportBatchFromUpload(meterFile);
  assert.strictEqual(meterBatch.importType, 'meter_device');
  assert.strictEqual(meterBatch.status, 'completed_with_errors');
  assert.deepStrictEqual(meterBatch.summary, {
    batchId: meterBatch.id,
    status: 'completed_with_errors',
    totalRows: 5,
    successCount: 1,
    failureCount: 2,
    skippedCount: 2,
    validationErrorCount: 2
  });
  assert(getErrorCodes(meterBatch).includes('DUPLICATE_METER_CODE_SKIPPED'), '计量器具导入应记录数据库重复 skip warning。');
  assert(getErrorCodes(meterBatch).includes('DUPLICATE_METER_CODE_IN_FILE_SKIPPED'), '计量器具导入应记录同文件重复 skip warning。');
  assert(getErrorCodes(meterBatch).includes('UNKNOWN_ENERGY_TYPE'), '计量器具导入应记录能源类型不存在错误。');
  assert(getErrorCodes(meterBatch).includes('UNKNOWN_ORGANIZATION_UNIT'), '计量器具导入应记录用能单元不存在错误。');

  const meterExport = exportMeters({ format: 'csv', organizationUnitId: String(importedUnit.id) });
  assert.strictEqual(meterExport.format, 'csv');
  assert.strictEqual(meterExport.rowCount, 1);
  const meterCsv = meterExport.body.toString('utf8');
  assert(meterCsv.includes('计量器具编码'));
  assert(meterCsv.includes('MT-1'));
  assert(!meterCsv.includes('EXIST-M'));

  const dbForBackfillPreview = openDatabase();
  const activeMeter = dbForBackfillPreview.prepare("SELECT id FROM meter_devices WHERE meter_code = 'MT-1'").get();
  dbForBackfillPreview.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('UT-AMB-A', '重名车间', '验收总厂/重名车间A', 'workshop', 'active', datetime('now'), datetime('now'))").run();
  dbForBackfillPreview.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES ('UT-AMB-B', '重名车间', '验收总厂/重名车间B', 'workshop', 'active', datetime('now'), datetime('now'))").run();
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, 'UT-1', 'MT-1', 'ledger-backfill-preview-export-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id);
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, 'UT-1', 'MT-1', 'ledger-backfill-already-partial-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id, importedUnit.id);
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, ?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, 'UT-1', 'MT-1', 'ledger-backfill-already-linked-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id, importedUnit.id, activeMeter.id);
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, 'UT-1', 'EXIST-M', 'ledger-backfill-blocked-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id);
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, '重名车间', '', 'ledger-backfill-ambiguous-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id);
  dbForBackfillPreview.prepare("INSERT INTO energy_records (energy_type_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, duplicate_key, record_status, created_at, updated_at) VALUES (?, '2026-04', '2026-04', 'kWh', 100, 'kWh', 100, '不存在单元', '不存在仪表', 'ledger-backfill-missing-smoke', 'active', datetime('now'), datetime('now'))").run(electricity.id);
  const beforeEnergyRecordCount = dbForBackfillPreview.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total;
  dbForBackfillPreview.close();
  assert(activeMeter && activeMeter.id, '临时库应已有用于预演的计量器具。');

  const previewExportCsv = exportEnergyRecordLedgerBackfillPreview({ format: 'csv', organization: 'UT-1', detailLimit: '50' });
  assert.strictEqual(previewExportCsv.format, 'csv');
  assert.strictEqual(previewExportCsv.contentType, 'text/csv; charset=utf-8');
  assert.strictEqual(previewExportCsv.rowCount, 4);
  const previewCsv = previewExportCsv.body.toString('utf8');
  assert(previewCsv.includes('历史 energy_records 台账回填预演/审计预案'), 'CSV 导出应包含审计预案标题。');
  assert(previewCsv.includes('preview-only / dry-run / no-write'), 'CSV 导出应包含只读 dry-run 元信息。');
  assert(previewCsv.includes('writesEnergyRecords'), 'CSV 导出应包含 writesEnergyRecords 元信息。');
  assert(previewCsv.includes('false'), 'CSV 导出应明确 writesEnergyRecords=false。');
  assert(previewCsv.includes('能耗记录ID'), 'CSV 导出应包含能耗记录 ID 字段。');
  assert(previewCsv.includes('候选 organization_unit_id'), 'CSV 导出应包含候选 organization_unit_id 字段。');
  assert(previewCsv.includes('候选 meter_device_id'), 'CSV 导出应包含候选 meter_device_id 字段。');
  assert(previewCsv.includes('wouldUpdate'), 'CSV 导出应包含 wouldUpdate 状态。');
  assert(previewCsv.includes('MT-1'), 'CSV 导出应包含候选计量器具编码。');

  const previewExportXlsx = exportEnergyRecordLedgerBackfillPreview({ format: 'xlsx', organization: 'UT-1', detailLimit: '50' });
  assert.strictEqual(previewExportXlsx.format, 'xlsx');
  assert.strictEqual(previewExportXlsx.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(previewExportXlsx.rowCount, 4);
  assert(previewExportXlsx.body.length > 0, 'xlsx 导出应返回非空文件。');
  const workbook = XLSX.read(previewExportXlsx.body, { type: 'buffer' });
  assert(workbook.SheetNames.includes('预案元信息'), 'xlsx 导出应包含预案元信息工作表。');
  assert(workbook.SheetNames.includes('预演明细'), 'xlsx 导出应包含预演明细工作表。');
  const detailSheet = XLSX.utils.sheet_to_json(workbook.Sheets['预演明细']);
  assert.strictEqual(detailSheet.length, 4);
  assert(detailSheet.some((row) => row['候选计量器具编码'] === 'MT-1'), 'xlsx 导出明细应包含安全候选计量器具。');

  const executePreview = getEnergyRecordLedgerBackfillPreview({ detailLimit: '50' });
  assert.strictEqual(executePreview.summary.wouldUpdate, 1, '隔离执行前应只有安全 wouldUpdate 候选。');
  assert.strictEqual(executePreview.summary.alreadyLinked, 1, '已有完整台账 ID 的记录应识别为 alreadyLinked 并跳过。');
  assert.strictEqual(executePreview.summary.alreadyPartial, 1, '已有非空台账 ID 的记录应识别为 alreadyPartial 并跳过。');
  assert.strictEqual(executePreview.summary.ambiguous, 1, 'ambiguous 记录应被识别但不执行。');
  assert.strictEqual(executePreview.summary.missing, 1, 'missing 记录应被识别但不执行。');
  assert.strictEqual(executePreview.summary.blocked, 1, 'blocked 记录应被识别但不执行。');
  assert.strictEqual(executePreview.candidateRecordIds.length, 1, '候选 recordIds 只包含 wouldUpdate 安全记录。');
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '错误确认文本',
      previewSignature: executePreview.previewSignature,
      expectedWouldUpdate: executePreview.summary.wouldUpdate,
      candidateRecordIds: executePreview.candidateRecordIds,
      filters: executePreview.filters,
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_CONFIRM_TEXT_MISMATCH'
  );
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '确认执行历史能耗台账回填',
      previewSignature: executePreview.previewSignature,
      expectedWouldUpdate: executePreview.summary.wouldUpdate + 1,
      candidateRecordIds: executePreview.candidateRecordIds,
      filters: executePreview.filters,
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_WOULD_UPDATE_MISMATCH'
  );
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '确认执行历史能耗台账回填',
      previewSignature: executePreview.previewSignature,
      expectedWouldUpdate: executePreview.summary.wouldUpdate,
      candidateRecordIds: [999999],
      filters: executePreview.filters,
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_CANDIDATE_RECORD_IDS_MISMATCH'
  );
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '确认执行历史能耗台账回填',
      previewSignature: executePreview.previewSignature,
      expectedWouldUpdate: executePreview.summary.wouldUpdate,
      candidateRecordIds: executePreview.candidateRecordIds,
      filters: executePreview.filters,
      acknowledgeSkippedRisks: false,
      requireBackup: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_SKIPPED_RISKS_ACK_REQUIRED'
  );
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '确认执行历史能耗台账回填',
      previewSignature: executePreview.previewSignature,
      expectedWouldUpdate: executePreview.summary.wouldUpdate,
      candidateRecordIds: executePreview.candidateRecordIds,
      filters: executePreview.filters,
      acknowledgeSkippedRisks: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_BACKUP_REQUIRED'
  );
  await assert.rejects(
    () => executeEnergyRecordLedgerBackfill({
      confirmText: '确认执行历史能耗台账回填',
      previewSignature: 'signature-mismatch',
      expectedWouldUpdate: executePreview.summary.wouldUpdate,
      candidateRecordIds: executePreview.candidateRecordIds,
      filters: executePreview.filters,
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'LEDGER_BACKFILL_PREVIEW_SIGNATURE_MISMATCH'
  );
  const executeAudit = await executeEnergyRecordLedgerBackfill({
    confirmText: '确认执行历史能耗台账回填',
    previewSignature: executePreview.previewSignature,
    expectedWouldUpdate: executePreview.summary.wouldUpdate,
    candidateRecordIds: executePreview.candidateRecordIds,
    filters: executePreview.filters,
    acknowledgeSkippedRisks: true,
    requireBackup: true
  });
  assert.strictEqual(executeAudit.executed, true);
  assert.strictEqual(executeAudit.writesEnergyRecords, true);
  assert.strictEqual(executeAudit.updatedRecords, 1, '只应更新 wouldUpdate 安全候选。');
  assert.strictEqual(executeAudit.updatedOrganizationUnitId, 1);
  assert.strictEqual(executeAudit.updatedMeterDeviceId, 1);
  assert.strictEqual(executeAudit.skippedAlreadyLinked, 1, 'alreadyLinked 不更新，应统计跳过。');
  assert.strictEqual(executeAudit.skippedAlreadyPartial, 1, '已有非空台账 ID 不覆盖，应统计跳过。');
  assert.strictEqual(executeAudit.skippedAmbiguous, 1, 'ambiguous 不更新，应统计跳过。');
  assert.strictEqual(executeAudit.skippedMissing, 1, 'missing 不更新，应统计跳过。');
  assert.strictEqual(executeAudit.skippedBlocked, 1, 'blocked 不更新，应统计跳过。');
  assert(executeAudit.backup && executeAudit.backup.reason === 'ledger-backfill', '执行前应自动生成 ledger-backfill 备份。');
  assert(fs.existsSync(executeAudit.backup.path), '执行备份文件应存在于隔离 BACKUPS_DIR。');
  assert.strictEqual(path.dirname(executeAudit.backup.path), process.env.BACKUPS_DIR, '执行备份必须写入隔离备份目录。');
  assert(Array.isArray(executeAudit.items) && executeAudit.items.length === 6, '审计响应应包含 updated 与 skipped 逐条 before/after 明细。');
  const updatedAuditItem = executeAudit.items.find((item) => item.status === 'updated');
  assert(updatedAuditItem, '审计响应应包含 updated 明细。');
  assert.strictEqual(updatedAuditItem.before.organizationUnitId, null);
  assert.strictEqual(updatedAuditItem.before.meterDeviceId, null);
  assert.strictEqual(updatedAuditItem.after.organizationUnitId, importedUnit.id);
  assert.strictEqual(updatedAuditItem.after.meterDeviceId, activeMeter.id);
  assert(executeAudit.items.some((item) => item.status === 'skipped' && item.previewStatus === 'already-linked'), '审计响应应包含 alreadyLinked 跳过明细。');
  assert(executeAudit.items.some((item) => item.status === 'skipped' && item.previewStatus === 'already-partial'), '审计响应应包含 alreadyPartial 跳过明细。');
  assert(executeAudit.items.some((item) => item.status === 'skipped' && item.previewStatus === 'blocked'), '审计响应应包含 blocked 跳过明细。');
  assert(executeAudit.items.some((item) => item.status === 'skipped' && item.previewStatus === 'ambiguous'), '审计响应应包含 ambiguous 跳过明细。');
  assert(executeAudit.items.some((item) => item.status === 'skipped' && item.previewStatus === 'missing'), '审计响应应包含 missing 跳过明细。');
  const dbAfterExecute = openDatabase();
  const afterEnergyRecordCount = dbAfterExecute.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total;
  const linkedCandidate = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-preview-export-smoke'").get();
  const alreadyPartial = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-already-partial-smoke'").get();
  const alreadyLinked = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-already-linked-smoke'").get();
  const blockedRecord = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-blocked-smoke'").get();
  const ambiguousRecord = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-ambiguous-smoke'").get();
  const missingRecord = dbAfterExecute.prepare("SELECT organization_unit_id AS organizationUnitId, meter_device_id AS meterDeviceId FROM energy_records WHERE duplicate_key = 'ledger-backfill-missing-smoke'").get();
  dbAfterExecute.close();
  assert.strictEqual(afterEnergyRecordCount, beforeEnergyRecordCount, '受控执行不得 INSERT/DELETE energy_records。');
  assert.strictEqual(linkedCandidate.organizationUnitId, importedUnit.id, '安全候选应写入 organization_unit_id。');
  assert.strictEqual(linkedCandidate.meterDeviceId, activeMeter.id, '安全候选应写入 meter_device_id。');
  assert.strictEqual(alreadyPartial.organizationUnitId, importedUnit.id, '已有非空 organization_unit_id 不得覆盖。');
  assert.strictEqual(alreadyPartial.meterDeviceId, null, 'alreadyPartial 不参与执行，不应补写 meter_device_id。');
  assert.strictEqual(alreadyLinked.organizationUnitId, importedUnit.id, 'alreadyLinked 不应更新 organization_unit_id。');
  assert.strictEqual(alreadyLinked.meterDeviceId, activeMeter.id, 'alreadyLinked 不应更新 meter_device_id。');
  assert.strictEqual(blockedRecord.organizationUnitId, null, 'blocked 不应更新 organization_unit_id。');
  assert.strictEqual(blockedRecord.meterDeviceId, null, 'blocked 不应更新 meter_device_id。');
  assert.strictEqual(ambiguousRecord.organizationUnitId, null, 'ambiguous 不应更新 organization_unit_id。');
  assert.strictEqual(ambiguousRecord.meterDeviceId, null, 'ambiguous 不应更新 meter_device_id。');
  assert.strictEqual(missingRecord.organizationUnitId, null, 'missing 不应更新 organization_unit_id。');
  assert.strictEqual(missingRecord.meterDeviceId, null, 'missing 不应更新 meter_device_id。');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
execFileSync(process.execPath, ['-e', ledgerImportExportSmokeScript], { cwd: path.join(__dirname, '..', '..', '..'), stdio: 'pipe' });

const meterReadingGenerationSmokeScript = String.raw`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

(async () => {
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-meter-reading-generation-'));
try {
  process.env.DATA_DIR = path.join(tmpDir, 'data');
  process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'meter-reading-generation.sqlite');
  process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
  process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');

  const { getDatabaseInfo, initDatabase, openDatabase } = require(path.join(process.cwd(), 'server', 'src', 'db', 'database'));
  const { createMeter, createOrganizationUnit } = require(path.join(process.cwd(), 'server', 'src', 'services', 'ledgerService'));
  const {
    createMeterReading,
    executeMeterReadingEnergyRecordGeneration,
    exportMeterReadingEnergyRecordGenerationPreview,
    getMeterReadingEnergyRecordGenerationPreview,
    updateMeterReading
  } = require(path.join(process.cwd(), 'server', 'src', 'services', 'meterReadingService'));

  initDatabase();
  assert.strictEqual(getDatabaseInfo().databasePath, process.env.SQLITE_PATH, '抄表生成 smoke 必须使用隔离 SQLite 文件。');
  const root = createOrganizationUnit({ unitCode: 'GEN-ROOT', unitName: '生成验收总厂', unitType: 'enterprise' });
  const movedUnit = createOrganizationUnit({ unitCode: 'GEN-MOVED', unitName: '迁移后车间', unitType: 'workshop', parentId: root.id });
  const dbForType = openDatabase();
  const electricity = dbForType.prepare("SELECT id FROM energy_types WHERE code = 'electricity' AND is_active = 1").get();
  dbForType.close();
  assert(electricity && electricity.id, '临时库应初始化 electricity 能源类型。');
  function createTestMeter(code, name) {
    return createMeter({
      meterCode: code,
      meterName: name,
      meterType: 'electricity',
      energyTypeId: electricity.id,
      organizationUnitId: root.id,
      multiplier: 1,
      allowManualReading: 1,
      status: 'active'
    });
  }
  const meterGenerate = createTestMeter('GEN-M-1', '可生成电表');
  const meterConflict = createTestMeter('GEN-M-2', '冲突电表');
  const meterVoid = createTestMeter('GEN-M-3', '作废电表');
  const meterAlready = createTestMeter('GEN-M-4', '已生成电表');
  const meterInvalid = createTestMeter('GEN-M-5', '单位异常电表');
  const meterMissing = createTestMeter('GEN-M-6', '缺失台账电表');
  const meterOrgMoved = createTestMeter('GEN-M-7', '归属变更电表');

  const wouldGenerateReading = createMeterReading({ meterDeviceId: meterGenerate.id, readingDate: '2026-05-31', previousValue: 100, currentValue: 150, multiplier: 1, unit: 'kWh' });
  createMeterReading({ meterDeviceId: meterGenerate.id, readingDate: '2026-05-15', previousValue: 150, currentValue: 170, multiplier: 1, unit: 'kWh' });
  createMeterReading({ meterDeviceId: meterConflict.id, readingDate: '2026-05-31', previousValue: 10, currentValue: 20, multiplier: 1, unit: 'kWh' });
  createMeterReading({ meterDeviceId: meterVoid.id, readingDate: '2026-05-31', previousValue: 20, currentValue: 30, multiplier: 1, unit: 'kWh', recordStatus: 'void' });
  const orgMismatchReading = createMeterReading({ meterDeviceId: meterOrgMoved.id, readingDate: '2026-09-30', previousValue: 0, currentValue: 30, multiplier: 1, unit: 'kWh' });

  const dbSeed = openDatabase();
  const existingEnergyId = dbSeed.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, business_dimension, remark, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, ?, '2026-05-31', '2026-05', 'kWh', 10, 'kWh', 10, '生成验收总厂', 'GEN-M-2', 'manual-seed', '冲突样例', 'conflict-seed', 'active', datetime('now'), datetime('now'))").run(electricity.id, root.id, meterConflict.id).lastInsertRowid;
  const alreadyEnergyId = dbSeed.prepare("INSERT INTO energy_records (energy_type_id, organization_unit_id, meter_device_id, original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value, organization, meter_code, business_dimension, remark, duplicate_key, record_status, created_at, updated_at) VALUES (?, ?, ?, '2026-06-30', '2026-06', 'kWh', 20, 'kWh', 20, '生成验收总厂', 'GEN-M-4', 'manual-seed', '已生成样例', 'already-generated-seed', 'active', datetime('now'), datetime('now'))").run(electricity.id, root.id, meterAlready.id).lastInsertRowid;
  dbSeed.prepare('UPDATE meter_devices SET organization_unit_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(movedUnit.id, meterOrgMoved.id);
  dbSeed.close();
  createMeterReading({ meterDeviceId: meterAlready.id, readingDate: '2026-06-30', previousValue: 0, currentValue: 20, multiplier: 1, unit: 'kWh', generatedEnergyRecordId: alreadyEnergyId });
  const dbInvalid = openDatabase();
  dbInvalid.prepare("INSERT INTO meter_reading_records (meter_device_id, organization_unit_id, energy_type_id, reading_date, normalized_month, previous_value, current_value, multiplier, usage_value, original_unit, normalized_unit, normalized_usage_value, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, ?, '2026-07-31', '2026-07', 0, 1, 1, 1, 'kWh', '', 1, 'manual', 'active', 'invalid unit smoke', datetime('now'), datetime('now'))").run(meterInvalid.id, root.id, electricity.id);
  dbInvalid.pragma('foreign_keys = OFF');
  dbInvalid.prepare("INSERT INTO meter_reading_records (meter_device_id, organization_unit_id, energy_type_id, reading_date, normalized_month, previous_value, current_value, multiplier, usage_value, original_unit, normalized_unit, normalized_usage_value, data_source, record_status, remark, created_at, updated_at) VALUES (?, ?, ?, '2026-08-31', '2026-08', 0, 1, 1, 1, 'kWh', 'kWh', 1, 'manual', 'active', 'missing ledger smoke', datetime('now'), datetime('now'))").run(999999, root.id, electricity.id);
  dbInvalid.pragma('foreign_keys = ON');
  const beforeCount = dbInvalid.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total;
  dbInvalid.close();

  const preview = getMeterReadingEnergyRecordGenerationPreview({ detailLimit: '50' });
  assert.strictEqual(preview.dryRun, true);
  assert.strictEqual(preview.previewOnly, true);
  assert.strictEqual(preview.writesEnergyRecords, false);
  assert.strictEqual(preview.carbonAccountingDeferred, true);
  assert.strictEqual(preview.confirmText, '确认由抄表生成能耗记录');
  assert.strictEqual(preview.summary.wouldGenerate, 1, '应只有一条 active 抄表可生成。');
  assert.strictEqual(preview.summary.conflict, 2, '同仪表同月同能源类型已有 active 能耗记录或预演内重复候选应冲突跳过。');
  assert.strictEqual(preview.summary.void, 1, 'void 抄表应跳过。');
  assert.strictEqual(preview.summary.alreadyGenerated, 1, '已有 generated_energy_record_id 应跳过。');
  assert.strictEqual(preview.summary.invalidUnit, 1, '单位/标准化字段异常应跳过。');
  assert.strictEqual(preview.summary.missingLedger, 1, '台账字段缺失应跳过。');
  assert.strictEqual(preview.summary.blocked, 1, '抄表记录用能单元与仪表当前归属不一致应阻断生成。');
  const orgMismatchPreviewItem = preview.items.find((item) => item.readingId === orgMismatchReading.id);
  assert(orgMismatchPreviewItem && orgMismatchPreviewItem.status === 'blocked', '仪表归属变更后的旧抄表记录应归为 blocked。');
  assert(orgMismatchPreviewItem.reasons.some((reason) => reason.code === 'METER_READING_ORG_MISMATCH'), 'blocked 原因应包含 METER_READING_ORG_MISMATCH。');
  assert.deepStrictEqual(preview.candidateReadingIds, [wouldGenerateReading.id]);

  const exportCsv = exportMeterReadingEnergyRecordGenerationPreview({ format: 'csv', detailLimit: '50' });
  assert.strictEqual(exportCsv.format, 'csv');
  const csvText = exportCsv.body.toString('utf8');
  assert(csvText.includes('抄表生成 energy_records 预演/审计预案'));
  assert(csvText.includes('preview-only / dry-run / controlled-generate'));
  assert(csvText.includes('fixedConfirmText'));
  assert(csvText.includes('确认由抄表生成能耗记录'));
  assert(csvText.includes('拟生成 duplicate_key'));
  const exportXlsx = exportMeterReadingEnergyRecordGenerationPreview({ format: 'xlsx', detailLimit: '50' });
  const workbook = XLSX.read(exportXlsx.body, { type: 'buffer' });
  assert(workbook.SheetNames.includes('预案元信息'));
  assert(workbook.SheetNames.includes('预演明细'));

  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '错误确认文本', previewSignature: preview.previewSignature, expectedWouldGenerate: preview.summary.wouldGenerate, candidateReadingIds: preview.candidateReadingIds, filters: preview.filters, acknowledgeSkippedRisks: true, requireBackup: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_CONFIRM_TEXT_MISMATCH'
  );
  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '确认由抄表生成能耗记录', previewSignature: 'signature-mismatch', expectedWouldGenerate: preview.summary.wouldGenerate, candidateReadingIds: preview.candidateReadingIds, filters: preview.filters, acknowledgeSkippedRisks: true, requireBackup: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_PREVIEW_SIGNATURE_MISMATCH'
  );
  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '确认由抄表生成能耗记录', previewSignature: preview.previewSignature, expectedWouldGenerate: preview.summary.wouldGenerate + 1, candidateReadingIds: preview.candidateReadingIds, filters: preview.filters, acknowledgeSkippedRisks: true, requireBackup: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_WOULD_GENERATE_MISMATCH'
  );
  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '确认由抄表生成能耗记录', previewSignature: preview.previewSignature, expectedWouldGenerate: preview.summary.wouldGenerate, candidateReadingIds: [999999], filters: preview.filters, acknowledgeSkippedRisks: true, requireBackup: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_CANDIDATE_READING_IDS_MISMATCH'
  );
  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '确认由抄表生成能耗记录', previewSignature: preview.previewSignature, expectedWouldGenerate: preview.summary.wouldGenerate, candidateReadingIds: preview.candidateReadingIds, filters: preview.filters, acknowledgeSkippedRisks: false, requireBackup: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_SKIPPED_RISKS_ACK_REQUIRED'
  );
  await assert.rejects(
    () => executeMeterReadingEnergyRecordGeneration({ confirmText: '确认由抄表生成能耗记录', previewSignature: preview.previewSignature, expectedWouldGenerate: preview.summary.wouldGenerate, candidateReadingIds: preview.candidateReadingIds, filters: preview.filters, acknowledgeSkippedRisks: true }),
    (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_GENERATION_BACKUP_REQUIRED'
  );

  const audit = await executeMeterReadingEnergyRecordGeneration({
    confirmText: '确认由抄表生成能耗记录',
    previewSignature: preview.previewSignature,
    expectedWouldGenerate: preview.summary.wouldGenerate,
    candidateReadingIds: preview.candidateReadingIds,
    filters: preview.filters,
    acknowledgeSkippedRisks: true,
    requireBackup: true
  });
  assert.strictEqual(audit.generated, 1);
  assert.strictEqual(audit.updatedReadings, 1);
  assert.strictEqual(audit.skippedConflict, 2);
  assert.strictEqual(audit.skippedVoid, 1);
  assert.strictEqual(audit.skippedAlreadyGenerated, 1);
  assert.strictEqual(audit.skippedMissingLedger, 1);
  assert.strictEqual(audit.skippedInvalidUnit, 1);
  assert.strictEqual(audit.skippedBlocked, 1);
  assert(audit.items.some((item) => item.readingId === orgMismatchReading.id && item.status === 'skipped' && item.previewStatus === 'blocked'), '归属不一致的抄表记录执行时应自然跳过。');
  assert(audit.backup && audit.backup.reason === 'meter-reading-energy-record-generation', '执行前应自动生成抄表生成专用 reason 备份。');
  assert(fs.existsSync(audit.backup.path), '抄表生成备份应存在于隔离 BACKUPS_DIR。');
  assert.strictEqual(path.dirname(audit.backup.path), process.env.BACKUPS_DIR, '抄表生成备份必须写入隔离目录。');
  const generatedItem = audit.items.find((item) => item.status === 'generated');
  assert(generatedItem && generatedItem.energyRecordId, '审计明细应包含 generated energyRecordId。');
  const dbAfter = openDatabase();
  const afterCount = dbAfter.prepare('SELECT COUNT(*) AS total FROM energy_records').get().total;
  const generatedEnergy = dbAfter.prepare('SELECT id, record_status AS recordStatus, business_dimension AS businessDimension, remark, duplicate_key AS duplicateKey FROM energy_records WHERE id = ?').get(generatedItem.energyRecordId);
  const updatedReading = dbAfter.prepare('SELECT generated_energy_record_id AS generatedEnergyRecordId FROM meter_reading_records WHERE id = ?').get(wouldGenerateReading.id);
  const orgMismatchDbRow = dbAfter.prepare('SELECT generated_energy_record_id AS generatedEnergyRecordId FROM meter_reading_records WHERE id = ?').get(orgMismatchReading.id);
  dbAfter.close();
  assert.strictEqual(afterCount, beforeCount + 1, '成功执行只应新增预期条数的 energy_records。');
  assert.strictEqual(generatedEnergy.recordStatus, 'active');
  assert.strictEqual(generatedEnergy.businessDimension, 'meter-reading-generation');
  assert(generatedEnergy.remark.includes('meter_reading_record_id='));
  assert.strictEqual(generatedEnergy.duplicateKey, 'meter-reading-month:' + meterGenerate.id + ':2026-05:' + electricity.id);
  assert.strictEqual(updatedReading.generatedEnergyRecordId, generatedItem.energyRecordId, '应回写 generated_energy_record_id。');
  assert.strictEqual(orgMismatchDbRow.generatedEnergyRecordId, null, '归属不一致 blocked 抄表不得生成或回写 energy_records。');
  const editedGeneratedReading = updateMeterReading(wouldGenerateReading.id, { meterDeviceId: meterGenerate.id, readingDate: '2026-05-31', previousValue: 100, currentValue: 151, multiplier: 1, unit: 'kWh', dataSource: 'manual', recordStatus: 'active', remark: '生成后编辑不应清空关联' });
  assert.strictEqual(editedGeneratedReading.generatedEnergyRecordId, generatedItem.energyRecordId, '生成后编辑抄表记录且请求体未传 generatedEnergyRecordId 时应保留关联。');
  const dbAfterEdit = openDatabase();
  const persistedEditedReading = dbAfterEdit.prepare('SELECT generated_energy_record_id AS generatedEnergyRecordId FROM meter_reading_records WHERE id = ?').get(wouldGenerateReading.id);
  dbAfterEdit.close();
  assert.strictEqual(persistedEditedReading.generatedEnergyRecordId, generatedItem.energyRecordId, '数据库中 generated_energy_record_id 不应被编辑清空。');
  const previewAfter = getMeterReadingEnergyRecordGenerationPreview({ detailLimit: '50' });
  assert.strictEqual(previewAfter.summary.wouldGenerate, 0, '再次预演不应出现重复生成候选。');
  assert(previewAfter.items.some((item) => item.readingId === wouldGenerateReading.id && item.status === 'alreadyGenerated'), '已生成抄表应归入 alreadyGenerated。');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
execFileSync(process.execPath, ['-e', meterReadingGenerationSmokeScript], { cwd: path.join(__dirname, '..', '..', '..'), stdio: 'pipe' });

assert.strictEqual(normalizeReadingDate('2026-02-28'), '2026-02-28');
assert.strictEqual(normalizeReadingDate('2026/2/8 12:30:00'), '2026-02-08');
assert.throws(
  () => normalizeReadingDate('2026-02-31'),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_READING_DATE'
);
assert.strictEqual(calculateUsageValue(12000, 12500, 1.5, null), 750);
assert.strictEqual(calculateUsageValue(12000, 12500, 1.5, 600), 600);
assert.throws(
  () => calculateUsageValue(12500, 12000, 1, null),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_READING_RANGE'
);
assert.throws(
  () => calculateUsageValue(12000, 12500, 0, null),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'INVALID_POSITIVE_NUMBER'
);
assert.deepStrictEqual(normalizeReadingUnit('electricity', 'MWh', 1.25), {
  originalUnit: 'MWh',
  normalizedUnit: 'kWh',
  normalizedUsageValue: 1250
});
assert.deepStrictEqual(normalizeReadingUnit('coal', 'kg', 1500), {
  originalUnit: 'kg',
  normalizedUnit: 't',
  normalizedUsageValue: 1.5
});
assert.throws(
  () => normalizeReadingUnit('electricity', 't', 1),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_METER_READING_UNIT'
);

const readingMeter = {
  id: 20,
  energyTypeId: 1,
  energyTypeCode: 'electricity',
  organizationUnitId: 10,
  multiplier: 2
};
const readingPayload = buildMeterReadingPayload({
  meterDeviceId: '20',
  readingDate: '2026-03-31',
  previousValue: '100',
  currentValue: '160',
  originalUnit: 'kWh',
  dataSource: 'manual'
}, readingMeter);
assert.deepStrictEqual({
  meterDeviceId: readingPayload.meterDeviceId,
  organizationUnitId: readingPayload.organizationUnitId,
  energyTypeId: readingPayload.energyTypeId,
  readingDate: readingPayload.readingDate,
  normalizedMonth: readingPayload.normalizedMonth,
  multiplier: readingPayload.multiplier,
  usageValue: readingPayload.usageValue,
  normalizedUnit: readingPayload.normalizedUnit,
  normalizedUsageValue: readingPayload.normalizedUsageValue,
  recordStatus: readingPayload.recordStatus
}, {
  meterDeviceId: 20,
  organizationUnitId: 10,
  energyTypeId: 1,
  readingDate: '2026-03-31',
  normalizedMonth: '2026-03',
  multiplier: 2,
  usageValue: 120,
  normalizedUnit: 'kWh',
  normalizedUsageValue: 120,
  recordStatus: 'active'
});
assert.throws(
  () => buildMeterReadingPayload({ meterDeviceId: '20', readingDate: '2026-03-31', previousValue: '100', currentValue: '160', originalUnit: 't', dataSource: 'manual' }, readingMeter),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'UNSUPPORTED_METER_READING_UNIT'
);
assert.strictEqual(typeof voidMeterReading, 'function', '作废策略应通过服务函数暴露，DELETE 不执行物理删除。');
assert.deepStrictEqual(buildMeterReadingEnergyTrace(), {
  strategy: 'none',
  label: '未关联',
  relatedEnergyRecordCount: 0,
  latestEnergyRecord: null,
  note: '未找到同仪表、同月份、同能源类型的 active 能耗记录；抄表记录不会自动生成 energy_records。'
});
assert.deepStrictEqual(buildMeterReadingEnergyTrace(2, 0, { id: 31, normalizedMonth: '2026-04' }), {
  strategy: 'suspected-same-meter-month',
  label: '疑似关联（同仪表同月）',
  relatedEnergyRecordCount: 2,
  latestEnergyRecord: { id: 31, normalizedMonth: '2026-04' },
  note: '按同一计量器具、同一归属月份、同一能源类型匹配到已存在 active 能耗记录；这是只读疑似追溯，不代表由抄表生成。'
});
assert.deepStrictEqual(buildMeterReadingEnergyTrace(1, 1, { id: 30, normalizedMonth: '2026-04' }), {
  strategy: 'direct-generated-record',
  label: '已直接关联',
  relatedEnergyRecordCount: 1,
  latestEnergyRecord: { id: 30, normalizedMonth: '2026-04' },
  note: '通过 generated_energy_record_id 找到已存在能耗记录；本接口仅展示追溯关系，不生成或回填 energy_records。'
});

assert.deepStrictEqual(mapMeterReadingImportFields({
  reading_date: '2026-04-30',
  meter_code: 'M-20',
  previous_value: '100',
  current_value: '130',
  multiplier: '2',
  unit: 'kWh',
  organization_unit: '企业A/一车间'
}).mapped, {
  readingDate: '2026-04-30',
  meterCode: 'M-20',
  previousValue: '100',
  currentValue: '130',
  multiplier: '2',
  unit: 'kWh',
  organizationUnit: '企业A/一车间'
});

const readingImportIndexes = buildMeterReadingImportIndexes({
  organizationUnits: [
    { id: 10, unitCode: 'OU-10', unitName: '一车间', unitPath: '企业A/一车间', status: 'active' }
  ],
  meterDevices: [
    { id: 20, meterCode: 'M-20', meterName: '一车间电表', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 10, multiplier: 2, allowManualReading: 1, status: 'active' },
    { id: 21, meterCode: 'M-21', meterName: '禁用手抄表', energyTypeId: 1, energyTypeCode: 'electricity', organizationUnitId: 10, multiplier: 1, allowManualReading: 0, status: 'active' }
  ]
});
const importRow = validateAndNormalizeMeterReadingImportRow({
  reading_date: '2026/04/30',
  meter_code: 'M-20',
  previous_value: '100',
  current_value: '130',
  multiplier: '2',
  unit: 'kWh',
  organization_unit: '企业A/一车间',
  remark: '导入测试'
}, 2, readingImportIndexes);
assert.strictEqual(importRow.errors.length, 0);
assert.strictEqual(importRow.record.meterDeviceId, 20);
assert.strictEqual(importRow.record.readingDate, '2026-04-30');
assert.strictEqual(importRow.record.usageValue, 60);
assert.strictEqual(importRow.record.dataSource, 'upload');
assert.strictEqual(importRow.record.generatedEnergyRecordId, null);
const importByName = validateAndNormalizeMeterReadingImportRow({
  reading_date: '2026-05-01',
  meter_name: '一车间电表',
  previous_value: '130',
  current_value: '150',
  unit: 'kWh',
  organization_unit: '企业A/一车间'
}, 3, readingImportIndexes);
assert.strictEqual(importByName.errors.length, 0);
assert.strictEqual(importByName.record.meterDeviceId, 20);
const invalidImportRow = validateAndNormalizeMeterReadingImportRow({
  reading_date: '2026-04-30',
  meter_code: 'M-21',
  previous_value: '100',
  current_value: '90',
  unit: 'kWh',
  organization_unit: '企业A/一车间'
}, 4, readingImportIndexes);
assert(invalidImportRow.errors.some((error) => error.errorCode === 'METER_MANUAL_READING_DISABLED'), '抄表导入应拒绝未开启手工抄表的仪表。');
const invertedReadingImportRow = validateAndNormalizeMeterReadingImportRow({
  reading_date: '2026-04-30',
  meter_code: 'M-20',
  previous_value: '100',
  current_value: '90',
  unit: 'kWh',
  organization_unit: '企业A/一车间'
}, 5, readingImportIndexes);
const invertedReadingError = invertedReadingImportRow.errors.find((error) => error.errorCode === 'INVALID_READING_RANGE');
assert(invertedReadingError, '抄表导入表码倒挂应返回 INVALID_READING_RANGE。');
assert(invertedReadingError.rawValue, '表码倒挂导入错误应保留可读 rawValue。');
assert(invertedReadingError.rawValue.includes('previous_value=100'), '表码倒挂 rawValue 应包含原始 previous_value。');
assert(invertedReadingError.rawValue.includes('current_value=90'), '表码倒挂 rawValue 应包含原始 current_value。');
assert.doesNotThrow(() => assertImportBatchCanUseGenericDelete({ id: 1, importType: 'energy_record' }), '能耗导入批次应保留通用删除原有行为。');
assert.throws(
  () => assertImportBatchCanUseGenericDelete({ id: 2, importType: 'meter_reading' }),
  (error) => error.code === 'BAD_REQUEST' && error.details.code === 'METER_READING_IMPORT_BATCH_DELETE_FORBIDDEN' && error.details.importType === 'meter_reading'
);
assert.deepStrictEqual(buildMeterReadingExportRows([{ meterCode: 'M-20', meterName: '一车间电表', organizationUnitPath: '企业A/一车间', energyTypeCode: 'electricity', energyTypeName: '电力', readingDate: '2026-04-30', previousValue: 100, currentValue: 130, multiplier: 2, usageValue: 60, originalUnit: 'kWh', normalizedUsageValue: 60, normalizedUnit: 'kWh', recordStatus: 'active', remark: '导出测试', sourceBatchId: 7 }])[0], {
  '仪表编码': 'M-20',
  '仪表名称': '一车间电表',
  '用能单元': '企业A/一车间',
  '能源类型编码': 'electricity',
  '能源类型': '电力',
  '抄表日期': '2026-04-30',
  '上期表码': 100,
  '本期表码': 130,
  '倍率': 2,
  '用量': 60,
  '单位': 'kWh',
  '标准化用量': 60,
  '标准单位': 'kWh',
  '状态': 'active',
  '备注': '导出测试',
  '导入批次': 7
});

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const importServiceJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'importService.js'), 'utf8');
const clientMainJs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'src', 'main.js'), 'utf8');
assert(importServiceJs.includes('import_type AS importType'), '通用导入批次列表/详情查询应返回 importType。');
assert(importServiceJs.includes('METER_READING_IMPORT_BATCH_DELETE_FORBIDDEN'), '通用批次删除应拒绝 meter_reading 批次。');
assert(clientMainJs.includes("{ key: 'importType', label: '批次类型'"), '前端通用导入批次列表应展示批次类型。');
assert(clientMainJs.includes('禁止通用删除'), '前端应标识抄表批次禁止通用删除。');
assert(clientMainJs.includes("dataset: { action: 'export-energy-ledger-backfill-preview' }"), '前端应提供台账回填预演审计预案下载按钮。');
assert(clientMainJs.includes('/energy-records/ledger-backfill/preview/export'), '前端应通过 preview/export 下载审计预案。');
assert(clientMainJs.includes("dataset: { action: 'execute-energy-ledger-backfill' }"), '前端应提供受控执行回填入口。');
assert(clientMainJs.includes("window.prompt") && clientMainJs.includes('确认执行历史能耗台账回填'), '前端受控执行必须要求输入固定确认文本。');
assert(clientMainJs.includes('acknowledgeSkippedRisks: true'), '前端执行请求必须显式确认跳过风险。');
assert(clientMainJs.includes('requireBackup: true'), '前端执行请求必须要求服务端备份。');
assert(clientMainJs.includes('/energy-records/ledger-backfill/execute'), '前端应仅通过 execute 端点发起受控执行。');
assert(!/safeApi\(`?\/energy-records\/ledger-backfill\/(?!execute)[^`)]*\{\s*method:\s*['"]POST['"]/i.test(clientMainJs), '前端不得对 preview/export 等 ledger-backfill 路径发起 POST。');
assert(!/safeApi\(`?\/energy-records\/ledger-backfill[^`)]*\{\s*method:\s*['"](?:PUT|PATCH|DELETE)['"]/i.test(clientMainJs), '前端不得对 ledger-backfill 发起 PUT/PATCH/DELETE 写调用。');
assert(schemaSql.includes('CREATE TABLE IF NOT EXISTS organization_units'), 'schema 应包含 organization_units 表。');
assert(schemaSql.includes('CREATE TABLE IF NOT EXISTS meter_devices'), 'schema 应包含 meter_devices 表。');
assert(schemaSql.includes("import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device'))"), 'import_batches 应支持 energy_record、meter_reading、organization_unit 和 meter_device 导入类型。');
assert(schemaSql.includes('CREATE TABLE IF NOT EXISTS meter_reading_records'), 'schema 应包含 meter_reading_records 表。');
assert(schemaSql.includes('normalized_usage_value REAL NOT NULL'), 'meter_reading_records 应包含标准化用量。');
assert(schemaSql.includes("record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void'))"), '抄表记录应支持 active/void 状态。');
assert(schemaSql.includes('generated_energy_record_id INTEGER'), '抄表记录应预留生成能耗记录追溯字段。');
assert(schemaSql.includes('idx_meter_reading_records_meter_date'), 'schema 应包含抄表记录仪表日期索引。');
assert(schemaSql.includes('organization_unit_id INTEGER'), 'energy_records 应包含 organization_unit_id。');
assert(schemaSql.includes('meter_device_id INTEGER'), 'energy_records 应包含 meter_device_id。');
assert(schemaSql.includes("unit_type IN ('enterprise', 'department', 'workshop', 'process', 'equipment')"), 'unit_type 应有白名单约束。');
assert(schemaSql.includes("online_status IN ('online', 'offline', 'unknown')"), 'online_status 应有白名单约束。');

console.log('ledger validation tests passed');
