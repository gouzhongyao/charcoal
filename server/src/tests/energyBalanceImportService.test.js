'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 本测试只使用隔离临时目录和 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-balance-import-'));
const temporaryUploadsDir = path.join(temporaryRoot, 'uploads');
const temporaryBackupsDir = path.join(temporaryRoot, 'backups');
const temporaryDatabasePath = path.join(temporaryRoot, 'energy-balance-import.sqlite');
fs.mkdirSync(temporaryUploadsDir, { recursive: true });
fs.mkdirSync(temporaryBackupsDir, { recursive: true });
process.env.DATA_DIR = temporaryRoot;
process.env.UPLOADS_DIR = temporaryUploadsDir;
process.env.BACKUPS_DIR = temporaryBackupsDir;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyBalanceImport123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'energy-balance-import-test-secret-2026';

const { initDatabase, openDatabase } = require('../db/database');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY
} = require('../services/energyAnalysisImportCore');
const {
  ENERGY_BALANCE_CONFIRM_TEXT,
  buildEnergyBalanceBundleImportPreview,
  executeEnergyBalanceBundleImport,
  previewEnergyBalanceBundleImport
} = require('../services/energyBalanceImportService');
const { getEnergyAnalysisTemplateDefinition } = require('../services/energyAnalysisTemplateService');

/** 把内部字段记录投影为模板中文列。 */
function projectTemplateRecord(sheetName, record) {
  const definition = getEnergyAnalysisTemplateDefinition('energy-balance-configs');
  const sheet = definition.sheets.find((item) => item.name === sheetName);
  return sheet.columns.map((column) => record[column.key] ?? '');
}

/** 创建双工作表 XLSX Buffer。 */
function createWorkbookBuffer(boundaryRows, itemRows, sheetNames = ['平衡边界', '九角色项目']) {
  const definition = getEnergyAnalysisTemplateDefinition('energy-balance-configs');
  const workbook = XLSX.utils.book_new();
  const rowsBySheet = { 平衡边界: boundaryRows, 九角色项目: itemRows };
  sheetNames.forEach((sheetName) => {
    const sheet = definition.sheets.find((item) => item.name === sheetName);
    const rows = [sheet.columns.map((column) => column.name), ...(rowsBySheet[sheetName] || []).map((record) => projectTemplateRecord(sheetName, record))];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 将 Buffer 保存为 Multer 风格上传对象。 */
function saveUpload(filename, buffer) {
  const filePath = path.join(temporaryUploadsDir, filename);
  fs.writeFileSync(filePath, buffer);
  return { originalname: filename, filename, size: buffer.length, path: filePath };
}

/** 构造边界模板行。 */
function boundaryRow(overrides = {}) {
  return {
    boundaryCode: 'BAL-001', boundaryName: '测试平衡边界', organizationUnitCode: 'ORG-PARK', source: '隔离测试',
    documentNo: 'BAL-TEST-2026', version: 'energy-balance:v1', effectiveStartUtc: '2026-01-01T00:00:00Z',
    effectiveEndUtc: '2027-01-01T00:00:00Z', sourceTimeZone: 'Asia/Shanghai', generationBoundaryConfirmed: '是', status: 'active',
    ...overrides
  };
}

/** 构造九角色项目模板行。 */
function itemRow(overrides = {}) {
  return {
    boundaryCode: 'BAL-001', boundaryVersion: 'energy-balance:v1', itemCode: 'ITEM-001', itemName: '显式输入', role: 'input',
    energyTypeCode: 'electricity', originalUnit: 'kWh', sourceType: 'explicit_balance_value', sourceReference: '隔离显式值',
    sourceRecordLocator: '', timeseriesSourceReference: '', generationValueField: '', explicitBalanceValue: 100,
    generationAntiDoubleCountKey: '', status: 'active', ...overrides
  };
}

/** 构造服务端完整 execute 见证。 */
function executeBody(preview) {
  return {
    boundaryBatchId: preview.boundaryBatchId,
    itemBatchId: preview.itemBatchId,
    uploadGroupId: preview.uploadGroupId,
    confirmText: ENERGY_BALANCE_CONFIRM_TEXT,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: preview.fileSha256,
    previewSignature: preview.previewSignature,
    previewAuditDigest: preview.previewAuditDigest,
    expectedWouldImport: preview.expectedWouldImport,
    candidateRowIds: preview.candidateRowIds,
    candidateRows: preview.candidateRows
  };
}

/** 准备主数据及稳定来源事实。 */
function seedData(db) {
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_type, unit_path, status, sort_order) VALUES ('ORG-PARK', '园区', 'enterprise', '/ORG-PARK', 'active', 0)").run();
  db.prepare("INSERT INTO organization_units (parent_id, unit_code, unit_name, unit_type, unit_path, status, sort_order) VALUES ((SELECT id FROM organization_units WHERE unit_code='ORG-PARK'), 'ORG-SHOP', '车间', 'workshop', '/ORG-PARK/ORG-SHOP', 'active', 0)").run();
  db.prepare("INSERT INTO organization_units (unit_code, unit_name, unit_type, unit_path, status, sort_order) VALUES ('ORG-OUTSIDE', '边界外组织', 'enterprise', '/ORG-OUTSIDE', 'active', 0)").run();
  const organizationId = db.prepare("SELECT id FROM organization_units WHERE unit_code='ORG-SHOP'").get().id;
  db.prepare(`INSERT INTO energy_records (
    energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value,
    normalized_unit, normalized_value, duplicate_key, record_status
  ) VALUES (?, ?, '2026-07', '2026-07', 'kWh', 100, 'kWh', 100, 'balance-monthly-1', 'active')`).run(electricity.id, organizationId);
  db.prepare(`INSERT INTO generation_records (
    organization_unit_id, energy_type_id, normalized_month, generation_value_kwh, self_use_value_kwh,
    grid_export_value_kwh, data_source, record_status
  ) VALUES (?, ?, '2026-07', 50, 40, 10, 'manual', 'active')`).run(organizationId, electricity.id);
}

/** 批量插入同一 sourceReference 的非重叠时序来源。 */
function seedTimeseriesSources(db, sourceReference, count) {
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  const organization = db.prepare("SELECT id FROM organization_units WHERE unit_code = 'ORG-SHOP'").get();
  const insertRecord = db.prepare(`INSERT INTO energy_timeseries_records (
    organization_unit_id, energy_type_id, start_utc, end_utc, source_timezone,
    granularity_minutes, original_unit, original_value, normalized_unit,
    normalized_value, source_reference, data_source, record_status
  ) VALUES (?, ?, ?, ?, 'Asia/Shanghai', 15, 'kWh', 1, 'kWh', 1, ?, 'manual', 'active')`);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const startUtc = new Date(Date.UTC(2026, 0, 1, 0, index * 15, 0)).toISOString();
      const endUtc = new Date(Date.UTC(2026, 0, 1, 0, (index + 1) * 15, 0)).toISOString();
      insertRecord.run(organization.id, electricity.id, startUtc, endUtc, sourceReference);
    }
  })();
}

/** 插入带起止节点组织的显式能流边值来源。 */
function seedExplicitEdgeSource(db, fixtureCode, fromOrganizationCode, toOrganizationCode) {
  const electricity = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get();
  const fromOrganization = db.prepare('SELECT id FROM organization_units WHERE unit_code = ?').get(fromOrganizationCode);
  const toOrganization = db.prepare('SELECT id FROM organization_units WHERE unit_code = ?').get(toOrganizationCode);
  const modelId = Number(db.prepare(`INSERT INTO energy_flow_models (
    model_code, model_name, source, document_no, version,
    effective_start_utc, effective_end_utc, source_timezone, status
  ) VALUES (?, ?, '隔离测试', ?, 'v1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`)
    .run(`FLOW-${fixtureCode}`, `能流模型-${fixtureCode}`, `DOC-${fixtureCode}`).lastInsertRowid);
  const insertNode = db.prepare(`INSERT INTO energy_flow_nodes (
    energy_flow_model_id, node_code, node_name, node_type, organization_unit_id, x, y, status
  ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active')`);
  const fromNodeId = Number(insertNode.run(modelId, `FROM-${fixtureCode}`, `起点-${fixtureCode}`, 'source', fromOrganization.id, 0).lastInsertRowid);
  const toNodeId = Number(insertNode.run(modelId, `TO-${fixtureCode}`, `终点-${fixtureCode}`, 'sink', toOrganization.id, 100).lastInsertRowid);
  const edgeId = Number(db.prepare(`INSERT INTO energy_flow_edges (
    energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
    unit, source_type, source_mapping_json, status
  ) VALUES (?, ?, ?, ?, ?, 'kWh', 'explicit_edge_value', ?, 'active')`)
    .run(modelId, `EDGE-${fixtureCode}`, fromNodeId, toNodeId, electricity.id, JSON.stringify({ reference: `edge:${fixtureCode}` })).lastInsertRowid);
  db.prepare(`INSERT INTO energy_flow_records (
    energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
    original_unit, original_value, source_type, source_mapping_json, formula_version, record_status
  ) VALUES (?, ?, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'Asia/Shanghai',
            'kWh', 10, 'explicit_edge_value', ?, 'energy-flow:v1', 'active')`)
    .run(modelId, edgeId, JSON.stringify({ reference: `edge-record:${fixtureCode}` }));
  return {
    model: `FLOW-${fixtureCode}`,
    version: 'v1',
    edge: `EDGE-${fixtureCode}`,
    startUtc: '2026-07-01T00:00:00Z',
    endUtc: '2026-08-01T00:00:00Z'
  };
}

/** 将显式边来源定位对象格式化为模板文本。 */
function explicitEdgeLocator(locator) {
  return `model=${locator.model};version=${locator.version};edge=${locator.edge};startUtc=${locator.startUtc};endUtc=${locator.endUtc}`;
}

async function run() {
  initDatabase();
  const db = openDatabase();
  try {
    seedData(db);
    const structurePreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer([boundaryRow()], [itemRow()]),
      originalFilename: 'structure.xlsx'
    });
    assert.deepStrictEqual(structurePreview.summary, { totalRows: 2, wouldImport: 2, skipped: 0, blocked: 0, warnings: 0, errors: 0 });
    const missingSheetPreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer([boundaryRow()], [], ['平衡边界']),
      originalFilename: 'missing-sheet.xlsx'
    });
    assert.strictEqual(missingSheetPreview.summary.blocked, 1);
    assert(missingSheetPreview.auditIssues.some((issue) => issue.code === 'MISSING_TEMPLATE_SHEET'));

    const sourceItems = [
      itemRow({ itemCode: 'MONTH', itemName: '月度输入', sourceType: 'monthly_energy', sourceReference: '月度事实', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', explicitBalanceValue: '' }),
      itemRow({ itemCode: 'GEN', itemName: '发电输入', role: 'self_generation', sourceType: 'generation', sourceReference: '发电事实', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', generationValueField: 'self_use_value_kwh', generationAntiDoubleCountKey: 'GEN-202607', explicitBalanceValue: '' })
    ];
    const sourcePreview = buildEnergyBalanceBundleImportPreview({ db, buffer: createWorkbookBuffer([boundaryRow()], sourceItems), originalFilename: 'sources.xlsx' });
    assert.strictEqual(sourcePreview.summary.wouldImport, 3, '稳定组织、能源和月份来源应解析为候选。');

    seedTimeseriesSources(db, 'TIMESERIES-500', 500);
    seedTimeseriesSources(db, 'TIMESERIES-501', 501);
    const timeseriesAtLimitPreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer(
        [boundaryRow({ boundaryCode: 'BAL-TIMESERIES-500' })],
        [itemRow({
          boundaryCode: 'BAL-TIMESERIES-500',
          itemCode: 'TIMESERIES-500',
          sourceType: 'timeseries',
          sourceReference: '500 条时序来源',
          timeseriesSourceReference: 'TIMESERIES-500',
          explicitBalanceValue: ''
        })]
      ),
      originalFilename: 'timeseries-500.xlsx'
    });
    assert.strictEqual(timeseriesAtLimitPreview.summary.blocked, 0, '时序来源解析 500 条记录必须允许进入候选。');
    assert.strictEqual(timeseriesAtLimitPreview.itemPreview.candidateRows[0].input.sourceMapping.recordIds.length, 500);
    const timeseriesOverLimitPreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer(
        [boundaryRow({ boundaryCode: 'BAL-TIMESERIES-501' })],
        [itemRow({
          boundaryCode: 'BAL-TIMESERIES-501',
          itemCode: 'TIMESERIES-501',
          sourceType: 'timeseries',
          sourceReference: '501 条时序来源',
          timeseriesSourceReference: 'TIMESERIES-501',
          explicitBalanceValue: ''
        })]
      ),
      originalFilename: 'timeseries-501.xlsx'
    });
    assert.strictEqual(timeseriesOverLimitPreview.summary.blocked, 1, '时序来源解析超过 500 条必须在 preview 阻断。');
    assert(timeseriesOverLimitPreview.itemPreview.auditIssues.some(
      (issue) => issue.code === 'ENERGY_BALANCE_IMPORT_SOURCE_RECORD_IDS_EXCEEDED'
    ));

    const exactGenerationRow = itemRow({
      boundaryCode: 'BAL-GEN-DUPLICATE',
      itemCode: 'GEN-DUPLICATE',
      itemName: '完全相同发电项目',
      role: 'self_generation',
      sourceType: 'generation',
      sourceReference: '发电事实',
      sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07',
      generationValueField: 'self_use_value_kwh',
      generationAntiDoubleCountKey: 'GEN-DUPLICATE-KEY',
      explicitBalanceValue: ''
    });
    const exactGenerationDuplicatePreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer(
        [boundaryRow({ boundaryCode: 'BAL-GEN-DUPLICATE' })],
        [exactGenerationRow, { ...exactGenerationRow }]
      ),
      originalFilename: 'generation-exact-duplicate.xlsx'
    });
    assert.strictEqual(exactGenerationDuplicatePreview.summary.wouldImport, 2, '边界和首条完全相同 generation 行应成为候选。');
    assert.strictEqual(exactGenerationDuplicatePreview.summary.skipped, 1, '后续完全相同 generation 行应按 duplicate skip。');
    assert(exactGenerationDuplicatePreview.itemPreview.auditIssues.some(
      (issue) => issue.code === 'DUPLICATE_ENERGY_BALANCE_ITEM_SKIPPED'
    ));
    assert(!exactGenerationDuplicatePreview.itemPreview.auditIssues.some(
      (issue) => issue.code === 'ENERGY_BALANCE_GENERATION_KEY_CONFLICT'
    ));

    const sameOrganizationEdge = seedExplicitEdgeSource(db, 'SAME-ORG', 'ORG-PARK', 'ORG-PARK');
    const descendantEdge = seedExplicitEdgeSource(db, 'DESCENDANT', 'ORG-SHOP', 'ORG-SHOP');
    const outsideEdge = seedExplicitEdgeSource(db, 'OUTSIDE', 'ORG-PARK', 'ORG-OUTSIDE');
    const unscopedEdge = seedExplicitEdgeSource(db, 'UNSCOPED', 'ORG-PARK', 'ORG-PARK');
    const explicitEdgePreview = (boundaryCode, itemCode, locator, boundaryOverrides = {}) => buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer(
        [boundaryRow({ boundaryCode, ...boundaryOverrides })],
        [itemRow({
          boundaryCode,
          itemCode,
          sourceType: 'explicit_edge_value',
          sourceReference: `显式边值-${itemCode}`,
          sourceRecordLocator: explicitEdgeLocator(locator),
          explicitBalanceValue: ''
        })]
      ),
      originalFilename: `${itemCode}.xlsx`
    });
    assert.strictEqual(explicitEdgePreview('BAL-EDGE-SAME', 'EDGE-SAME', sameOrganizationEdge).summary.blocked, 0, '边界组织自身的边起止节点必须允许。');
    assert.strictEqual(explicitEdgePreview('BAL-EDGE-CHILD', 'EDGE-CHILD', descendantEdge).summary.blocked, 0, '边界组织后代的边起止节点必须允许。');
    const outsideEdgePreview = explicitEdgePreview('BAL-EDGE-OUTSIDE', 'EDGE-OUTSIDE', outsideEdge);
    assert.strictEqual(outsideEdgePreview.summary.blocked, 1, '任一边端点位于独立根组织时必须阻断。');
    assert(outsideEdgePreview.itemPreview.auditIssues.some(
      (issue) => issue.code === 'ENERGY_BALANCE_IMPORT_EDGE_OUTSIDE_BOUNDARY'
    ));
    const unscopedEdgePreview = explicitEdgePreview(
      'BAL-EDGE-UNSCOPED',
      'EDGE-UNSCOPED',
      unscopedEdge,
      { organizationUnitCode: '' }
    );
    assert.strictEqual(unscopedEdgePreview.summary.blocked, 1, '未设置组织范围的边界不得接纳显式边值。');
    assert(unscopedEdgePreview.itemPreview.auditIssues.some(
      (issue) => issue.code === 'ENERGY_BALANCE_IMPORT_EDGE_OUTSIDE_BOUNDARY'
    ));

    const roleItems = [
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-INPUT', itemName: '外购输入', role: 'input' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-SELF', itemName: '自发自用', role: 'self_generation', sourceType: 'generation', sourceReference: '发电自用事实', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', generationValueField: 'self_use_value_kwh', explicitBalanceValue: '', generationAntiDoubleCountKey: 'NINE-SELF' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-INVENTORY-DECREASE', itemName: '库存减少', role: 'inventory_decrease' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-ADJUST-IN', itemName: '调增', role: 'adjustment_increase' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-OUTPUT', itemName: '外送输出', role: 'output', sourceType: 'generation', sourceReference: '发电外送事实', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', generationValueField: 'grid_export_value_kwh', explicitBalanceValue: '', generationAntiDoubleCountKey: 'NINE-OUTPUT' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-USEFUL', itemName: '有效利用', role: 'useful_utilization' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-LOSS', itemName: '已知损失', role: 'known_loss' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-INVENTORY-INCREASE', itemName: '库存增加', role: 'inventory_increase' }),
      itemRow({ boundaryCode: 'BAL-NINE', itemCode: 'ROLE-ADJUST-OUT', itemName: '调减', role: 'adjustment_decrease' })
    ];
    const rolePreview = buildEnergyBalanceBundleImportPreview({
      db,
      buffer: createWorkbookBuffer([boundaryRow({ boundaryCode: 'BAL-NINE' })], roleItems),
      originalFilename: 'nine-roles.xlsx'
    });
    assert.strictEqual(rolePreview.summary.wouldImport, 10, '边界及全部九角色项目都应成为候选。');
    assert.deepStrictEqual(
      new Set(rolePreview.itemPreview.candidateRows.map((candidate) => candidate.input.role)),
      new Set(['input', 'self_generation', 'inventory_decrease', 'adjustment_increase', 'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease'])
    );

    db.prepare(`INSERT INTO energy_records (
      energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value,
      normalized_unit, normalized_value, duplicate_key, record_status
    ) SELECT energy_type_id, organization_unit_id, original_month, normalized_month, original_unit, original_value,
             normalized_unit, normalized_value, 'balance-monthly-2', record_status FROM energy_records WHERE duplicate_key='balance-monthly-1'`).run();
    const ambiguousPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: createWorkbookBuffer([boundaryRow()], [sourceItems[0]]), originalFilename: 'ambiguous.xlsx' });
    assert.strictEqual(ambiguousPreview.summary.blocked, 1);
    assert(ambiguousPreview.itemPreview.auditIssues.some((issue) => issue.code === 'ENERGY_BALANCE_IMPORT_SOURCE_AMBIGUOUS'));
    db.prepare("DELETE FROM energy_records WHERE duplicate_key='balance-monthly-2'").run();

    const missingPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: createWorkbookBuffer([boundaryRow()], [itemRow({ sourceType: 'monthly_energy', sourceReference: '缺失', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-08', explicitBalanceValue: '' })]), originalFilename: 'missing.xlsx' });
    assert(missingPreview.itemPreview.auditIssues.some((issue) => issue.code === 'ENERGY_BALANCE_IMPORT_SOURCE_NOT_FOUND'));
    const unitPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: createWorkbookBuffer([boundaryRow()], [itemRow({ originalUnit: 'm3' })]), originalFilename: 'unit.xlsx' });
    assert(unitPreview.itemPreview.auditIssues.some((issue) => issue.code === 'ENERGY_BALANCE_IMPORT_SOURCE_UNIT_MISMATCH'));
    const generationConflictPreview = buildEnergyBalanceBundleImportPreview({ db, buffer: createWorkbookBuffer([boundaryRow()], [
      sourceItems[1],
      itemRow({ itemCode: 'GEN2', itemName: '发电输出', role: 'output', sourceType: 'generation', sourceReference: '发电输出', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', generationValueField: 'grid_export_value_kwh', generationAntiDoubleCountKey: 'GEN-202607', explicitBalanceValue: '' })
    ]), originalFilename: 'generation-conflict.xlsx' });
    assert.strictEqual(generationConflictPreview.summary.blocked, 2, '同边界不同项目共用 generation 防重复键时两行都必须阻断。');
    assert(generationConflictPreview.itemPreview.auditIssues.some((issue) => issue.code === 'ENERGY_BALANCE_GENERATION_KEY_CONFLICT'));
  } finally {
    db.close();
  }

  const upload = saveUpload('execute.xlsx', createWorkbookBuffer([boundaryRow({ boundaryCode: 'BAL-EXEC' })], [itemRow({ boundaryCode: 'BAL-EXEC' })]));
  const preview = previewEnergyBalanceBundleImport(upload);
  assert.notStrictEqual(preview.boundaryBatchId, preview.itemBatchId);
  assert.strictEqual(preview.boundaryBatch.auditPhase, 'preview');
  assert.strictEqual(preview.itemBatch.auditPhase, 'preview');
  const backupCounter = { count: 0 };
  const result = await executeEnergyBalanceBundleImport(executeBody(preview), {
    actor: { userId: 1, username: 'admin', ip: '127.0.0.1' },
    createBackup: async ({ reason, skipCheckpoint }) => {
      backupCounter.count += 1;
      assert.strictEqual(reason, ENERGY_ANALYSIS_IMPORT_BACKUP_REASON);
      assert.strictEqual(skipCheckpoint, true);
      return { backupName: 'balance-test.sqlite', reason, method: 'test', sizeBytes: 1, sha256: 'a'.repeat(64) };
    }
  });
  assert.strictEqual(result.imported, 2);
  assert.strictEqual(backupCounter.count, 1, '一次 execute 只能创建一次备份。');

  const staleUpload = saveUpload('stale.xlsx', createWorkbookBuffer([boundaryRow({ boundaryCode: 'BAL-STALE' })], [itemRow({ boundaryCode: 'BAL-STALE', sourceType: 'monthly_energy', sourceReference: '月度', sourceRecordLocator: 'organization=ORG-SHOP;month=2026-07', explicitBalanceValue: '' })]));
  const stalePreview = previewEnergyBalanceBundleImport(staleUpload);
  const staleDb = openDatabase();
  staleDb.prepare("UPDATE energy_records SET normalized_value = 200 WHERE duplicate_key='balance-monthly-1'").run();
  staleDb.close();
  const staleBackupCounter = { count: 0 };
  await assert.rejects(() => executeEnergyBalanceBundleImport(executeBody(stalePreview), {
    actor: { userId: 1, username: 'admin', ip: '127.0.0.1' },
    createBackup: async () => {
      staleBackupCounter.count += 1;
      return { backupName: 'unexpected.sqlite', reason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON, method: 'test', sizeBytes: 1, sha256: 'c'.repeat(64) };
    }
  }), /候选|验签|不一致/);
  assert.strictEqual(staleBackupCounter.count, 0, '来源事实变化必须在备份前判定 preview stale。');

  const rollbackUpload = saveUpload('rollback.xlsx', createWorkbookBuffer([boundaryRow({ boundaryCode: 'BAL-ROLLBACK' })], [
    itemRow({ boundaryCode: 'BAL-ROLLBACK', itemCode: 'ROLLBACK-1' }),
    itemRow({ boundaryCode: 'BAL-ROLLBACK', itemCode: 'ROLLBACK-2' })
  ]));
  const rollbackPreview = previewEnergyBalanceBundleImport(rollbackUpload);
  await assert.rejects(() => executeEnergyBalanceBundleImport(executeBody(rollbackPreview), {
    actor: { userId: 1, username: 'admin', ip: '127.0.0.1' },
    createBackup: async ({ reason }) => ({ backupName: 'rollback.sqlite', reason, method: 'test', sizeBytes: 1, sha256: 'b'.repeat(64) }),
    beforeInsertItem: ({ index }) => { if (index === 1) throw new Error('测试事务回滚'); }
  }), /测试事务回滚/);
  const verificationDb = openDatabase();
  assert.strictEqual(verificationDb.prepare("SELECT COUNT(*) AS total FROM energy_balance_boundaries WHERE boundary_code='BAL-ROLLBACK'").get().total, 0);
  assert.strictEqual(verificationDb.prepare("SELECT COUNT(*) AS total FROM energy_balance_items WHERE item_code LIKE 'ROLLBACK-%'").get().total, 0);
  verificationDb.close();
}

run()
  .then(() => console.log('energyBalanceImportService.test.js passed'))
  .finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
