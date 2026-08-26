'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本专项测试只使用系统临时目录和隔离 SQLite。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-v2-'));
const primaryDatabasePath = path.join(temporaryRoot, 'primary.sqlite');
process.env.DATA_DIR = path.join(temporaryRoot, 'data');
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.SQLITE_PATH = primaryDatabasePath;
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowMigration123!';

// 隔离环境加载数据库模块，避免触碰正式数据库路径。
const databaseModulePath = require.resolve('../db/database');
delete require.cache[databaseModulePath];
const {
  IMPORT_BATCH_TYPES,
  energyFlowTableIsCanonical,
  ensureEnergyAnalysisTables,
  initDatabase,
  normalizeSqlContractText,
  openDatabase
} = require('../db/database');

// N8 canonical v2 固定为九张领域表且不安装触发器。
const ENERGY_FLOW_TABLES = Object.freeze([
  'energy_flow_models',
  'energy_flow_assets',
  'energy_flow_paths',
  'energy_flow_nodes',
  'energy_flow_edges',
  'energy_flow_records',
  'energy_flow_waste_heat_facts',
  'energy_flow_loss_facts',
  'energy_flow_loss_evidence'
]);

// N8 canonical v2 的全部显式索引名称用于验证缺失、未知和部分唯一合同。
const ENERGY_FLOW_INDEXES = Object.freeze([
  'ux_energy_flow_models_business_key',
  'idx_energy_flow_models_effective',
  'idx_energy_flow_models_batch',
  'ux_energy_flow_assets_code',
  'idx_energy_flow_assets_model_type',
  'idx_energy_flow_assets_batch',
  'ux_energy_flow_paths_code',
  'idx_energy_flow_paths_model_status',
  'idx_energy_flow_paths_batch',
  'ux_energy_flow_nodes_code',
  'idx_energy_flow_nodes_model_type',
  'idx_energy_flow_nodes_asset',
  'idx_energy_flow_nodes_batch',
  'ux_energy_flow_edges_code',
  'ux_energy_flow_edges_path_sequence',
  'idx_energy_flow_edges_model_type',
  'idx_energy_flow_edges_path',
  'idx_energy_flow_edges_batch',
  'ux_energy_flow_records_code',
  'idx_energy_flow_records_edge_range',
  'idx_energy_flow_records_node_range',
  'idx_energy_flow_records_model_stage',
  'idx_energy_flow_records_path',
  'idx_energy_flow_records_asset',
  'idx_energy_flow_records_batch',
  'ux_energy_flow_waste_heat_code',
  'ux_energy_flow_waste_heat_active_record',
  'idx_energy_flow_waste_heat_model_role',
  'idx_energy_flow_waste_heat_batch',
  'ux_energy_flow_loss_facts_code',
  'ux_energy_flow_loss_facts_active_record',
  'idx_energy_flow_loss_facts_model_role',
  'idx_energy_flow_loss_facts_batch',
  'ux_energy_flow_loss_evidence_code',
  'ux_energy_flow_loss_evidence_active_benchmark',
  'idx_energy_flow_loss_evidence_fact_role',
  'idx_energy_flow_loss_evidence_range',
  'idx_energy_flow_loss_evidence_batch'
]);

// 已知 v1 四表和七个显式索引必须与历史项目结构完全一致。
const LEGACY_V1_SCHEMA_SQL = `CREATE TABLE energy_flow_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_code TEXT NOT NULL,
  model_name TEXT NOT NULL,
  source TEXT NOT NULL,
  document_no TEXT,
  version TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (model_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
);
CREATE TABLE energy_flow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  node_code TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('source', 'process', 'storage', 'sink', 'loss', 'boundary')),
  organization_unit_id INTEGER,
  x REAL NOT NULL,
  y REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  UNIQUE (energy_flow_model_id, node_code),
  UNIQUE (energy_flow_model_id, id)
);
CREATE TABLE energy_flow_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  edge_code TEXT NOT NULL,
  from_node_id INTEGER NOT NULL,
  to_node_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  unit TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value')),
  source_mapping_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, from_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, to_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (energy_flow_model_id, edge_code),
  UNIQUE (energy_flow_model_id, id),
  CHECK (from_node_id <> to_node_id),
  CHECK (
    CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  )
);
CREATE TABLE energy_flow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  energy_flow_edge_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  original_unit TEXT NOT NULL,
  original_value REAL NOT NULL CHECK (original_value >= 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value')),
  source_mapping_json TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_edge_id) REFERENCES energy_flow_edges(energy_flow_model_id, id) ON DELETE RESTRICT,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (
    CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  ),
  CHECK (
    (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
    OR (
      record_status = 'void'
      AND trim(COALESCE(void_reason, '')) <> ''
      AND is_strict_utc_iso(voided_at) = 1
    )
  )
);
CREATE INDEX idx_energy_flow_models_effective ON energy_flow_models(status, effective_start_utc, effective_end_utc);
CREATE INDEX idx_energy_flow_nodes_model_type ON energy_flow_nodes(energy_flow_model_id, node_type, status);
CREATE INDEX idx_energy_flow_nodes_batch ON energy_flow_nodes(source_batch_id);
CREATE INDEX idx_energy_flow_edges_model_type ON energy_flow_edges(energy_flow_model_id, source_type, status);
CREATE INDEX idx_energy_flow_edges_batch ON energy_flow_edges(source_batch_id);
CREATE INDEX idx_energy_flow_records_edge_range ON energy_flow_records(energy_flow_edge_id, record_status, start_utc, end_utc);
CREATE INDEX idx_energy_flow_records_batch ON energy_flow_records(source_batch_id);`;

/** 从完整 schema 中提取 N8 能源分析可执行片段。 */
function extractEnergyAnalysisSchemaSql(schemaText) {
  const startMarker = '-- ENERGY_ANALYSIS_SCHEMA_START';
  const endMarker = '-- ENERGY_ANALYSIS_SCHEMA_END';
  const startIndex = schemaText.indexOf(startMarker);
  const endIndex = schemaText.indexOf(endMarker);
  assert(startIndex >= 0 && endIndex > startIndex, '测试 schema 必须包含唯一 N8 片段标记。');
  return schemaText.slice(startIndex + startMarker.length, endIndex).trim();
}

/** 判断指定 SQLite 对象是否存在。 */
function sqliteObjectExists(db, type, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name));
}

/** 读取指定表 CREATE SQL。 */
function getCreateSql(db, tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)?.sql || '';
}

/** 按依赖逆序删除 canonical 或 legacy 能流表。 */
function dropEnergyFlowTables(db) {
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS energy_flow_loss_evidence;
    DROP TABLE IF EXISTS energy_flow_loss_facts;
    DROP TABLE IF EXISTS energy_flow_waste_heat_facts;
    DROP TABLE IF EXISTS energy_flow_records;
    DROP TABLE IF EXISTS energy_flow_edges;
    DROP TABLE IF EXISTS energy_flow_nodes;
    DROP TABLE IF EXISTS energy_flow_paths;
    DROP TABLE IF EXISTS energy_flow_assets;
    DROP TABLE IF EXISTS energy_flow_models;`);
  db.pragma('foreign_keys = ON');
}

/** 将完整隔离库的 N8 九表替换为项目已知 v1 四表。 */
function installLegacyV1Schema(db) {
  dropEnergyFlowTables(db);
  db.exec(LEGACY_V1_SCHEMA_SQL);
}

/** 在已知 v1 四表写入一组可核对主键、历史值和来源追溯的数据。 */
function seedLegacyV1Data(db, options = {}) {
  const modelCode = options.modelCode || 'LEGACY-FLOW';
  const modelVersion = options.modelVersion || 'legacy:v1';
  const batchId = db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count)
    VALUES ('energy_flow_record', 'legacy-flow.csv', 'legacy-flow-stored.csv', 'csv', 'completed', 4, 4)`).run().lastInsertRowid;
  const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
  db.prepare(`INSERT INTO energy_flow_models
    (id, model_code, model_name, source, document_no, version, effective_start_utc,
     effective_end_utc, source_timezone, status, created_at, updated_at)
    VALUES (101, ?, '旧库能流模型', '旧库人工来源', 'LEGACY-DOC-001', ?,
      ?, ?, 'Asia/Shanghai', 'active',
      '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`).run(
    modelCode,
    modelVersion,
    options.effectiveStartUtc || '2026-01-01T00:00:00.000Z',
    options.effectiveEndUtc || '2027-01-01T00:00:00.000Z'
  );
  db.prepare(`INSERT INTO energy_flow_nodes
    (id, source_batch_id, source_row_number, energy_flow_model_id, node_code, node_name,
     node_type, organization_unit_id, x, y, status, created_at, updated_at)
    VALUES
      (201, ?, 2, 101, 'NODE-A', '旧节点 A', 'source', NULL, 10.5, 20.5, 'active',
       '2026-01-04T00:00:00.000Z', '2026-01-05T00:00:00.000Z'),
      (202, ?, 3, 101, 'NODE-B', '旧节点 B', 'sink', NULL, 30.5, 40.5, 'active',
       '2026-01-06T00:00:00.000Z', '2026-01-07T00:00:00.000Z')`).run(batchId, batchId);
  db.prepare(`INSERT INTO energy_flow_edges
    (id, source_batch_id, source_row_number, energy_flow_model_id, edge_code, from_node_id,
     to_node_id, energy_type_id, unit, source_type, source_mapping_json, status, created_at, updated_at)
    VALUES (301, ?, 4, 101, 'EDGE-A-B', 201, 202, ?, 'kWh', 'explicit_edge_value',
      '{"reference":"legacy-edge-reference"}', 'active',
      '2026-01-08T00:00:00.000Z', '2026-01-09T00:00:00.000Z')`).run(batchId, energyTypeId);
  db.prepare(`INSERT INTO energy_flow_records
    (id, source_batch_id, source_row_number, energy_flow_model_id, energy_flow_edge_id,
     start_utc, end_utc, source_timezone, original_unit, original_value, source_type,
     source_mapping_json, formula_version, record_status, void_reason, voided_at, created_at, updated_at)
    VALUES (401, ?, 5, 101, 301, ?, ?,
      'Asia/Shanghai', 'kWh', 12.5, 'explicit_edge_value',
      '{"reference":"legacy-record-reference"}', 'energy-flow:v1', ?, ?, ?,
      '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`).run(
    batchId,
    options.recordStartUtc || '2026-06-01T00:00:00.000Z',
    options.recordEndUtc || '2026-07-01T00:00:00.000Z',
    options.recordStatus || 'active',
    options.recordStatus === 'void' ? '旧库作废测试' : null,
    options.recordStatus === 'void'
      ? (options.voidedAt || '2026-07-01T00:00:00.000Z')
      : null
  );
  return { batchId, energyTypeId };
}

/** 断言 N8 公开迁移错误稳定且不泄漏路径、SQL 或原生驱动文本。 */
function assertStableMigrationError(action, expectedCode) {
  assert.throws(action, (error) => {
    assert.strictEqual(error?.code, expectedCode);
    assert(!String(error.message).includes(temporaryRoot), '公开错误不得泄漏隔离库本机路径。');
    assert(!/CREATE\s+TABLE|SELECT\s+|INSERT\s+|SQLITE_/i.test(String(error.message)), '公开错误不得泄漏 SQL。');
    return true;
  });
}

/** 创建一个完整 workbook_facts 模型及其显式资产、路径、节点和三条边。 */
function seedWorkbookStructure(db) {
  const batchId = db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, stored_filename, file_type, status, total_rows, success_count)
    VALUES ('energy_flow_workbook', 'flow.xlsx', 'flow-stored.xlsx', 'xlsx', 'completed', 20, 20)`).run().lastInsertRowid;
  const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
  const modelId = db.prepare(`INSERT INTO energy_flow_models
    (source_batch_id, source_row_number, model_code, model_name, source, document_no, version,
     effective_start_wall_clock, effective_end_wall_clock, effective_start_utc, effective_end_utc,
     source_timezone, classification_status, source_mode)
    VALUES (?, 2, 'FLOW-WORKBOOK', '工作簿能流模型', 'N8专项测试', 'N8-DOC-001', '1.0',
      '2026-01-01T08:00', '2027-01-01T08:00', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
      'Asia/Shanghai', 'workbook_facts', 'workbook_facts_only')`).run(batchId).lastInsertRowid;
  const assetId = db.prepare(`INSERT INTO energy_flow_assets
    (source_batch_id, source_row_number, energy_flow_model_id, asset_code, asset_name, asset_type)
    VALUES (?, 2, ?, 'DEVICE-01', '一号设备', 'production_device')`).run(batchId, modelId).lastInsertRowid;
  const pathId = db.prepare(`INSERT INTO energy_flow_paths
    (source_batch_id, source_row_number, energy_flow_model_id, path_code, path_name)
    VALUES (?, 2, ?, 'PATH-01', '主能流路径')`).run(batchId, modelId).lastInsertRowid;
  const insertNode = db.prepare(`INSERT INTO energy_flow_nodes
    (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_asset_id,
     node_code, node_name, node_type, stage_code, x, y)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sourceNodeId = insertNode.run(batchId, 3, modelId, null, 'NODE-IN', '进厂节点', 'source', 'plant_entry', 0, 0).lastInsertRowid;
  const wasteNodeId = insertNode.run(batchId, 4, modelId, assetId, 'NODE-WASTE', '余热节点', 'process', 'waste_heat', 10, 0).lastInsertRowid;
  const lossNodeId = insertNode.run(batchId, 5, modelId, assetId, 'NODE-LOSS', '损耗节点', 'loss', 'loss', 20, 0).lastInsertRowid;
  const sinkNodeId = insertNode.run(batchId, 6, modelId, assetId, 'NODE-OUT', '利用节点', 'sink', 'useful_output', 30, 0).lastInsertRowid;
  const insertEdge = db.prepare(`INSERT INTO energy_flow_edges
    (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_path_id, path_sequence,
     edge_code, from_node_id, to_node_id, energy_type_id, unit, source_type, source_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'kWh', 'workbook_fact', ?)`);
  const wasteEdgeId = insertEdge.run(batchId, 7, modelId, pathId, 1, 'EDGE-WASTE', sourceNodeId, wasteNodeId, energyTypeId, 'edge:waste').lastInsertRowid;
  const lossEdgeId = insertEdge.run(batchId, 8, modelId, pathId, 2, 'EDGE-LOSS', wasteNodeId, lossNodeId, energyTypeId, 'edge:loss').lastInsertRowid;
  const usefulEdgeId = insertEdge.run(batchId, 9, modelId, pathId, 3, 'EDGE-USEFUL', lossNodeId, sinkNodeId, energyTypeId, 'edge:useful').lastInsertRowid;
  return {
    batchId,
    energyTypeId,
    modelId,
    assetId,
    pathId,
    wasteNodeId,
    lossNodeId,
    wasteEdgeId,
    lossEdgeId,
    usefulEdgeId
  };
}

/** 验证 SQL canonical tokenizer 保留字符串字面量并忽略纯语法引号、注释和空白差异。 */
function testSqlCanonicalTokenizer() {
  const canonicalSql = `CREATE TABLE "FlowContract" (
    "Status" TEXT CHECK ("Status" IN ('active', 'act"ive', 'it''s'))
  );`;
  const equivalentSql = `CREATE /* schema comment with 'ACTIVE' */ TABLE [flowcontract] (
    \`status\` TEXT CHECK (\`STATUS\` IN ('active','act"ive','it''s')) -- trailing 'ignored'
  );`;
  assert.strictEqual(
    normalizeSqlContractText(canonicalSql),
    normalizeSqlContractText(equivalentSql),
    '标识符引号、注释和语法空白差异应得到同一指纹。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText(canonicalSql),
    normalizeSqlContractText(canonicalSql.replace("'active'", "'ACTIVE'")),
    '字符串字面量大小写必须参与指纹。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText(canonicalSql),
    normalizeSqlContractText(canonicalSql.replace("'act\"ive'", "'active'")),
    '字符串内部双引号不得被删除。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText('CREATE INDEX i ON t(status) WHERE status = \'benchmark\''),
    normalizeSqlContractText('CREATE INDEX i ON t(status) WHERE status = \'BENCHMARK\''),
    '部分索引字符串谓词必须区分大小写。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText('SELECT "a,b" FROM t'),
    normalizeSqlContractText('SELECT a,b FROM t'),
    '复杂标识符不得与多个 SQL 词元碰撞。'
  );
  assert.strictEqual(
    normalizeSqlContractText("CREATE TABLE t (status TEXT DEFAULT'active')"),
    normalizeSqlContractText("CREATE TABLE t (status TEXT DEFAULT 'active')"),
    '关键字与字符串字面量之间的可选空白不得改变指纹。'
  );
  assert.strictEqual(
    normalizeSqlContractText("SELECT a+b-c*d/e%f||g, h<<i, j>>k, l& m, n|o, p->'$.x', q->>'$.y' FROM t WHERE a<=b AND c>=d AND e==f AND g!=h AND i<>j"),
    normalizeSqlContractText("SELECT a + b - c * d / e % f || g, h << i, j >> k, l & m, n | o, p -> '$.x', q ->> '$.y' FROM t WHERE a <= b AND c >= d AND e == f AND g != h AND i <> j"),
    'SQLite 合法运算符两侧可选空白必须按真实词元边界等价。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText('SELECT 12, 1e-2, a->b'),
    normalizeSqlContractText('SELECT 1 2, 1e - 2, a - > b'),
    '数值、标识符和多字符运算符的真实词元边界不得被合并。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText('SELECT a--comment\n+b'),
    normalizeSqlContractText('SELECT a - - b'),
    '相邻双减号注释不得与二元减号加一元负号合并。'
  );
  assert.strictEqual(
    normalizeSqlContractText('SELECT :Name, @Value, $row FROM t'),
    normalizeSqlContractText('SELECT :Name,@Value,$row FROM t'),
    '同名命名参数周围空白不得改变指纹。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText('SELECT :Name FROM t'),
    normalizeSqlContractText('SELECT :name FROM t'),
    '命名参数名称原始大小写必须参与指纹。'
  );
  assert.strictEqual(
    normalizeSqlContractText("SELECT X'ABCD' FROM t"),
    normalizeSqlContractText("SELECT x'abcd' FROM t"),
    '合法 BLOB 内容大小写不应改变 canonical 指纹。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT X'ABC' FROM t"),
    normalizeSqlContractText("SELECT X'ABCD' FROM t"),
    '奇数长度非法 BLOB 不得与合法 BLOB 假等价。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT X'ABCG' FROM t"),
    normalizeSqlContractText("SELECT X'ABCD' FROM t"),
    '非十六进制非法 BLOB 不得与合法 BLOB 假等价。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT X'ABCD' FROM t"),
    normalizeSqlContractText("SELECT 'ABCD' FROM t"),
    '合法 BLOB 不得与普通单引号字符串假等价。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT X'"),
    normalizeSqlContractText("SELECT X''"),
    '未闭合 BLOB 不得被规范成合法空 BLOB。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT x'"),
    normalizeSqlContractText("SELECT X'ABCD'"),
    '未闭合 BLOB 不得与合法 BLOB 假等价。'
  );
  assert.notStrictEqual(
    normalizeSqlContractText("SELECT X'"),
    normalizeSqlContractText("SELECT '"),
    '未闭合 BLOB 不得与普通未闭合字符串假等价。'
  );
}

try {
  testSqlCanonicalTokenizer();
  initDatabase({ databasePath: primaryDatabasePath });
  let db = openDatabase({ databasePath: primaryDatabasePath });
  try {
    // 真实 SQLite 必须接受合法 BLOB DDL/SELECT，且 X/x 大小写执行结果一致。
    db.exec("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT X'ABCD')");
    const upperBlobProbe = db.prepare("SELECT typeof(X'ABCD') AS valueType, length(X'ABCD') AS byteLength, hex(X'ABCD') AS hexValue").get();
    assert.deepStrictEqual(upperBlobProbe, { valueType: 'blob', byteLength: 2, hexValue: 'ABCD' });
    db.exec('DROP TABLE blob_literal_probe');
    db.exec("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT x'abcd')");
    const lowerBlobProbe = db.prepare("SELECT typeof(x'abcd') AS valueType, length(x'abcd') AS byteLength, hex(x'abcd') AS hexValue").get();
    assert.deepStrictEqual(lowerBlobProbe, { valueType: 'blob', byteLength: 2, hexValue: 'ABCD' });
    assert.throws(() => db.prepare("SELECT X'ABC'").get(), /SQLITE|blob|hex/i);
    assert.throws(() => db.prepare("SELECT X'ABCG'").get(), /SQLITE|blob|hex|token/i);
    assert.throws(() => db.prepare("SELECT X'").get(), /SQLITE|token|input/i);
    assert.throws(() => db.prepare("SELECT x'").get(), /SQLITE|token|input/i);
    const namedParameterProbe = db.prepare('SELECT :Name AS upperValue, :name AS lowerValue')
      .get({ Name: 'UPPER', name: 'lower' });
    assert.deepStrictEqual(namedParameterProbe, { upperValue: 'UPPER', lowerValue: 'lower' });
    db.exec('DROP TABLE blob_literal_probe');
    assert.notStrictEqual(
      normalizeSqlContractText("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT X'ABC')"),
      normalizeSqlContractText("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT X'ABCD')")
    );
    assert.notStrictEqual(
      normalizeSqlContractText("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT X'ABCG')"),
      normalizeSqlContractText("CREATE TABLE blob_literal_probe (payload BLOB DEFAULT 'ABCD')")
    );

    // 新库必须完整匹配九表、全部显式索引和空触发器 canonical 指纹。
    ENERGY_FLOW_TABLES.forEach((tableName) => {
      assert(sqliteObjectExists(db, 'table', tableName), `新库缺少 ${tableName}。`);
      assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true, `${tableName} 必须匹配 canonical v2。`);
    });
    ENERGY_FLOW_INDEXES.forEach((indexName) => assert(sqliteObjectExists(db, 'index', indexName), `新库缺少 ${indexName}。`));
    assert.deepStrictEqual(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (${ENERGY_FLOW_TABLES.map(() => '?').join(', ')})`).all(...ENERGY_FLOW_TABLES), []);
    assert(IMPORT_BATCH_TYPES.includes('energy_flow_workbook'));
    assert(getCreateSql(db, 'import_batches').includes("'energy_flow_workbook'"));

    // 列顺序、复合外键、删除动作、CHECK 和部分唯一索引必须可由 SQLite 元数据识别。
    assert.deepStrictEqual(db.prepare('PRAGMA table_info(energy_flow_models)').all().map((column) => column.name), [
      'id', 'source_batch_id', 'source_row_number', 'model_code', 'model_name', 'source', 'document_no',
      'version', 'effective_start_wall_clock', 'effective_end_wall_clock', 'effective_start_utc',
      'effective_end_utc', 'source_timezone', 'classification_status', 'source_mode', 'status',
      'created_at', 'updated_at'
    ]);
    const modelBatchForeignKey = db.prepare('PRAGMA foreign_key_list(energy_flow_models)').all()
      .find((foreignKey) => foreignKey.from === 'source_batch_id');
    assert(modelBatchForeignKey);
    assert.strictEqual(modelBatchForeignKey.table, 'import_batches');
    assert.strictEqual(modelBatchForeignKey.on_delete, 'RESTRICT');
    const recordForeignKeys = db.prepare('PRAGMA foreign_key_list(energy_flow_records)').all();
    assert(recordForeignKeys.some((foreignKey) => foreignKey.table === 'energy_flow_edges' && foreignKey.from === 'energy_type_id'));
    assert(recordForeignKeys.some((foreignKey) => foreignKey.table === 'energy_flow_assets' && foreignKey.from === 'energy_flow_asset_id'));
    assert(recordForeignKeys.some((foreignKey) => foreignKey.table === 'energy_flow_paths' && foreignKey.from === 'energy_flow_path_id'));
    assert(getCreateSql(db, 'energy_flow_records').includes("record_role IN ('edge_flow', 'storage_change')"));
    assert(getCreateSql(db, 'energy_flow_loss_evidence').includes("evidence_role IN ('fact_evidence', 'benchmark')"));
    const benchmarkIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_energy_flow_loss_evidence_active_benchmark'").get().sql;
    assert(benchmarkIndexSql.includes("evidence_role = 'benchmark' AND status = 'active'"));
    const canonicalSchemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
    assert.strictEqual(energyFlowTableIsCanonical(
      db,
      'energy_flow_edges',
      canonicalSchemaSql.replace(
        "source_type = 'workbook_fact'\n    OR source_mapping_json IS NOT NULL",
        "source_type = 'WORKBOOK_FACT'\n    OR source_mapping_json IS NOT NULL"
      )
    ), false, 'v2 CHECK 字符串字面量大小写漂移必须被指纹识别。');
    assert.strictEqual(energyFlowTableIsCanonical(
      db,
      'energy_flow_loss_evidence',
      canonicalSchemaSql.replace(
        "evidence_role = 'benchmark' AND status = 'active'",
        "evidence_role = 'BENCHMARK' AND status = 'active'"
      )
    ), false, 'v2 部分索引字符串谓词漂移必须被指纹识别。');

    // N8 专用 UTC 合同只接受 canonical 秒精度；共享历史校验仍兼容三位毫秒。
    assert.strictEqual(
      db.prepare("SELECT is_strict_utc_iso('2026-01-01T00:00:00.001Z')").pluck().get(),
      1
    );
    assert.strictEqual(
      db.prepare("SELECT normalize_energy_flow_utc_second('2026-01-01T00:00:00.000Z')").pluck().get(),
      '2026-01-01T00:00:00Z'
    );
    assert.strictEqual(
      db.prepare("SELECT is_energy_flow_utc_second('2026-01-01T00:00:00.000Z')").pluck().get(),
      0
    );
    assert.strictEqual(
      db.prepare("SELECT is_energy_flow_utc_second('2026-01-01T00:00:00Z')").pluck().get(),
      1
    );
    assert.strictEqual(
      db.prepare("SELECT normalize_energy_flow_utc_second('2026-01-01T00:00:00.001Z')").pluck().get(),
      null
    );
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_models
      (model_code, model_name, source, version, effective_start_utc, effective_end_utc,
       source_timezone, classification_status, source_mode)
      VALUES ('FLOW-INVALID-MILLISECOND', '非法毫秒模型', 'N8专项测试', '1.0',
       '2026-01-01T00:00:00.001Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai',
       'legacy_unclassified', 'legacy_explicit_sources')`).run(), /CHECK constraint failed/);

    const workbook = seedWorkbookStructure(db);

    // legacy 边和记录必须恢复 v1 映射、公式版本及非负值不变量。
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_edges
      (energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
       unit, source_type, source_mapping_json)
      VALUES (?, 'EDGE-LEGACY-MISSING-MAPPING', ?, ?, ?, 'kWh',
       'explicit_edge_value', NULL)`).run(
      workbook.modelId,
      workbook.wasteNodeId,
      workbook.lossNodeId,
      workbook.energyTypeId
    ), /CHECK constraint failed/);
    const insertLegacyRecordProbe = db.prepare(`INSERT INTO energy_flow_records
      (energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
       original_unit, original_value, source_type, source_mapping_json, formula_version)
      VALUES (?, ?, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
       'Asia/Shanghai', 'kWh', ?, 'explicit_edge_value', ?, ?)`);
    assert.throws(() => insertLegacyRecordProbe.run(
      workbook.modelId,
      workbook.wasteEdgeId,
      -1,
      '{"reference":"legacy:negative"}',
      'energy-flow:v1'
    ), /CHECK constraint failed/);
    assert.throws(() => insertLegacyRecordProbe.run(
      workbook.modelId,
      workbook.wasteEdgeId,
      1,
      null,
      'energy-flow:v1'
    ), /CHECK constraint failed/);
    assert.throws(() => insertLegacyRecordProbe.run(
      workbook.modelId,
      workbook.wasteEdgeId,
      1,
      '{"reference":"legacy:missing-formula"}',
      null
    ), /CHECK constraint failed/);

    // 工作簿模型来源批次/行号必须成对，来源墙钟区间必须严格递增。
    const insertInvalidWorkbookModel = db.prepare(`INSERT INTO energy_flow_models
      (source_batch_id, source_row_number, model_code, model_name, source, version,
       effective_start_wall_clock, effective_end_wall_clock, effective_start_utc, effective_end_utc,
       source_timezone, classification_status, source_mode)
      VALUES (?, ?, ?, '无效工作簿模型', 'N8专项测试', '1.0', ?, ?,
        '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai',
        'workbook_facts', 'workbook_facts_only')`);
    assert.throws(() => insertInvalidWorkbookModel.run(
      workbook.batchId,
      null,
      'FLOW-MISSING-ROW',
      '2026-01-01T08:00',
      '2027-01-01T08:00'
    ), /CHECK constraint failed/);
    assert.throws(() => insertInvalidWorkbookModel.run(
      workbook.batchId,
      99,
      'FLOW-REVERSED-WALL',
      '2027-01-01T08:00',
      '2026-01-01T08:00'
    ), /CHECK constraint failed/);
    const insertRecord = db.prepare(`INSERT INTO energy_flow_records
      (source_batch_id, source_row_number, energy_flow_model_id, record_code, record_role,
       energy_flow_edge_id, energy_flow_node_id, energy_flow_path_id, energy_flow_asset_id,
       stage_code, energy_type_id, start_wall_clock, end_wall_clock, start_utc, end_utc,
       source_timezone, original_unit, original_value, source_type, source_reference, record_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-01T08:00', '2026-07-01T08:00',
        '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', 'Asia/Shanghai', 'kWh', ?,
        'workbook_fact', ?, 'active')`);
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_records
      (source_batch_id, source_row_number, energy_flow_model_id, record_code, record_role,
       energy_flow_edge_id, energy_flow_path_id, energy_flow_asset_id, stage_code, energy_type_id,
       start_wall_clock, end_wall_clock, start_utc, end_utc, source_timezone, original_unit,
       original_value, source_type, source_reference, record_status)
      VALUES (?, 99, ?, 'REC-INVALID-MILLISECOND', 'edge_flow', ?, ?, ?, 'waste_heat', ?,
       '2026-06-01T08:00', '2026-07-01T08:00', '2026-06-01T00:00:00.001Z',
       '2026-07-01T00:00:00Z', 'Asia/Shanghai', 'kWh', 1, 'workbook_fact',
       'record:invalid-millisecond', 'active')`).run(
      workbook.batchId,
      workbook.modelId,
      workbook.wasteEdgeId,
      workbook.pathId,
      workbook.assetId,
      workbook.energyTypeId
    ), /CHECK constraint failed/);
    const wasteRecordId = insertRecord.run(workbook.batchId, 10, workbook.modelId, 'REC-WASTE', 'edge_flow',
      workbook.wasteEdgeId, null, workbook.pathId, workbook.assetId, 'waste_heat', workbook.energyTypeId, 30, 'record:waste').lastInsertRowid;
    const lossRecordId = insertRecord.run(workbook.batchId, 11, workbook.modelId, 'REC-LOSS', 'edge_flow',
      workbook.lossEdgeId, null, workbook.pathId, workbook.assetId, 'loss', workbook.energyTypeId, 5, 'record:loss').lastInsertRowid;
    insertRecord.run(workbook.batchId, 12, workbook.modelId, 'REC-STORAGE', 'storage_change',
      null, workbook.wasteNodeId, null, null, 'distribution', workbook.energyTypeId, -2, 'record:storage');
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_records
      (source_batch_id, source_row_number, energy_flow_model_id, record_code, record_role,
       energy_flow_edge_id, energy_flow_path_id, energy_flow_asset_id, stage_code, energy_type_id,
       start_wall_clock, end_wall_clock, start_utc, end_utc, source_timezone, original_unit,
       original_value, source_type, source_reference, record_status, void_reason, voided_at)
      VALUES (?, 98, ?, 'REC-INVALID-VOIDED-MILLISECOND', 'edge_flow', ?, ?, ?, 'waste_heat', ?,
       '2026-06-01T08:00', '2026-07-01T08:00', '2026-06-01T00:00:00Z',
       '2026-07-01T00:00:00Z', 'Asia/Shanghai', 'kWh', 1, 'workbook_fact',
       'record:invalid-voided-millisecond', 'void', '测试作废', '2026-07-01T00:00:00.001Z')`).run(
      workbook.batchId,
      workbook.modelId,
      workbook.wasteEdgeId,
      workbook.pathId,
      workbook.assetId,
      workbook.energyTypeId
    ), /CHECK constraint failed/);

    const insertWasteHeatFact = db.prepare(`INSERT INTO energy_flow_waste_heat_facts
      (source_batch_id, source_row_number, energy_flow_model_id, waste_heat_code,
       energy_flow_record_id, waste_heat_role, source_reference)
      VALUES (?, ?, ?, ?, ?, 'generation', 'evidence:waste')`);
    insertWasteHeatFact.run(workbook.batchId, 13, workbook.modelId, 'WASTE-01', wasteRecordId);
    assert.throws(() => insertWasteHeatFact.run(
      workbook.batchId,
      14,
      workbook.modelId,
      'WASTE-02',
      wasteRecordId
    ), /UNIQUE constraint failed/);
    const insertLossFact = db.prepare(`INSERT INTO energy_flow_loss_facts
      (source_batch_id, source_row_number, energy_flow_model_id, loss_fact_code,
       energy_flow_record_id, loss_fact_role)
      VALUES (?, ?, ?, ?, ?, 'device_loss')`);
    const lossFactId = insertLossFact.run(
      workbook.batchId,
      15,
      workbook.modelId,
      'LOSS-01',
      lossRecordId
    ).lastInsertRowid;
    assert.throws(() => insertLossFact.run(
      workbook.batchId,
      16,
      workbook.modelId,
      'LOSS-02',
      lossRecordId
    ), /UNIQUE constraint failed/);
    const insertEvidence = db.prepare(`INSERT INTO energy_flow_loss_evidence
      (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_loss_fact_id,
       evidence_code, evidence_role, evidence_name, evidence_type, evidence_reference,
       evidence_start_wall_clock, evidence_end_wall_clock, evidence_start_utc, evidence_end_utc,
       source_timezone, benchmark_loss_value, benchmark_loss_unit, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-01T08:00', '2026-07-01T08:00',
        '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', 'Asia/Shanghai', ?, ?, 'active')`);
    insertEvidence.run(workbook.batchId, 17, workbook.modelId, lossFactId, 'EVIDENCE-01',
      'fact_evidence', '损耗事实证据', 'meter_record', 'meter:loss', null, null);
    insertEvidence.run(workbook.batchId, 18, workbook.modelId, lossFactId, 'BENCHMARK-01',
      'benchmark', '损耗基准', 'standard', 'standard:loss', 3, 'kWh');
    assert.throws(() => insertEvidence.run(workbook.batchId, 19, workbook.modelId, lossFactId, 'BENCHMARK-02',
      'benchmark', '重复损耗基准', 'standard', 'standard:loss:2', 2, 'kWh'), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_loss_evidence
      (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_loss_fact_id,
       evidence_code, evidence_role, evidence_name, evidence_type, evidence_reference,
       evidence_start_wall_clock, evidence_end_wall_clock, evidence_start_utc, evidence_end_utc,
       source_timezone, status)
      VALUES (?, 97, ?, ?, 'EVIDENCE-INVALID-MILLISECOND', 'fact_evidence', '非法毫秒证据',
       'other', 'evidence:invalid-millisecond', '2026-06-01T08:00', '2026-07-01T08:00',
       '2026-06-01T00:00:00.001Z', '2026-07-01T00:00:00Z', 'Asia/Shanghai', 'inactive')`).run(
      workbook.batchId,
      workbook.modelId,
      lossFactId
    ), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO energy_flow_assets
      (source_batch_id, source_row_number, energy_flow_model_id, asset_code, asset_name, asset_type)
      VALUES (?, 20, ?, 'device-01', '规范键冲突资产', 'other')`).run(workbook.batchId, workbook.modelId), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare('DELETE FROM import_batches WHERE id = ?').run(workbook.batchId), /FOREIGN KEY constraint failed/);
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 重复初始化不得复制任何 N8 行、索引或权限。
  initDatabase({ databasePath: primaryDatabasePath });
  db = openDatabase({ databasePath: primaryDatabasePath });
  try {
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM energy_flow_models WHERE model_code = 'FLOW-WORKBOOK'").get().total, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_loss_evidence').get().total, 2);
    ENERGY_FLOW_TABLES.forEach((tableName) => assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true));
  } finally {
    db.close();
  }

  // 实际可执行 v2 的 DEFAULT/比较运算符等价空白必须在有数据时仍判为 canonical，禁止误入重建。
  const canonicalSchemaText = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const canonicalEnergyAnalysisSql = extractEnergyAnalysisSchemaSql(canonicalSchemaText);
  const equivalentV2Sql = canonicalEnergyAnalysisSql
    .replace(/DEFAULT 'active'/g, "DEFAULT'active'")
    .replace(/source_type = 'workbook_fact'/g, "source_type='workbook_fact'")
    .replace(/source_row_number >= 1/g, 'source_row_number>=1')
    .replace(/path_sequence >= 1/g, 'path_sequence>=1');
  assert.notStrictEqual(equivalentV2Sql, canonicalEnergyAnalysisSql);
  const equivalentV2Path = path.join(temporaryRoot, 'equivalent-v2-whitespace.sqlite');
  fs.copyFileSync(primaryDatabasePath, equivalentV2Path);
  db = openDatabase({ databasePath: equivalentV2Path });
  let equivalentV2Workbook;
  try {
    dropEnergyFlowTables(db);
    db.exec(equivalentV2Sql);
    equivalentV2Workbook = seedWorkbookStructure(db);
    ENERGY_FLOW_TABLES.forEach((tableName) => {
      assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true, `${tableName} 等价空白应保持 canonical。`);
    });
    ensureEnergyAnalysisTables(db, canonicalSchemaText);
    assert.strictEqual(
      db.prepare('SELECT model_code FROM energy_flow_models WHERE id = ?').pluck().get(equivalentV2Workbook.modelId),
      'FLOW-WORKBOOK',
      '有数据 v2 等价空白不得触发表重建。'
    );
  } finally {
    db.close();
  }

  // 实际可执行已知 v1 的 DEFAULT/运算符等价空白必须允许有数据机械迁移。
  const equivalentLegacySql = LEGACY_V1_SCHEMA_SQL
    .replace(/DEFAULT 'active'/g, "DEFAULT'active'")
    .replace(/source_row_number >= 1/g, 'source_row_number>=1')
    .replace(/from_node_id <> to_node_id/g, 'from_node_id<>to_node_id');
  assert.notStrictEqual(equivalentLegacySql, LEGACY_V1_SCHEMA_SQL);
  const equivalentLegacyPath = path.join(temporaryRoot, 'equivalent-v1-whitespace.sqlite');
  fs.copyFileSync(primaryDatabasePath, equivalentLegacyPath);
  db = openDatabase({ databasePath: equivalentLegacyPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    dropEnergyFlowTables(db);
    db.exec(equivalentLegacySql);
    seedLegacyV1Data(db);
  } finally {
    db.close();
  }
  initDatabase({ databasePath: equivalentLegacyPath });
  db = openDatabase({ databasePath: equivalentLegacyPath });
  try {
    assert.strictEqual(db.prepare('SELECT model_code FROM energy_flow_models WHERE id = 101').pluck().get(), 'LEGACY-FLOW');
    ENERGY_FLOW_TABLES.forEach((tableName) => assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 已知 v1 有数据迁移必须保留主键、原值、来源追溯和历史时间，且不伪造任何 N8 业务字段。
  const legacyPath = path.join(temporaryRoot, 'legacy-v1.sqlite');
  fs.copyFileSync(primaryDatabasePath, legacyPath);
  db = openDatabase({ databasePath: legacyPath });
  let legacySeed;
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    installLegacyV1Schema(db);
    legacySeed = seedLegacyV1Data(db, { recordStatus: 'void' });
  } finally {
    db.close();
  }
  initDatabase({ databasePath: legacyPath });
  initDatabase({ databasePath: legacyPath });
  db = openDatabase({ databasePath: legacyPath });
  try {
    const migratedModel = db.prepare('SELECT * FROM energy_flow_models WHERE id = 101').get();
    assert.strictEqual(migratedModel.model_code, 'LEGACY-FLOW');
    assert.strictEqual(migratedModel.document_no, 'LEGACY-DOC-001');
    assert.strictEqual(migratedModel.classification_status, 'legacy_unclassified');
    assert.strictEqual(migratedModel.source_mode, 'legacy_explicit_sources');
    assert.strictEqual(migratedModel.source_batch_id, null);
    assert.strictEqual(migratedModel.source_row_number, null);
    assert.strictEqual(migratedModel.effective_start_wall_clock, null);
    assert.strictEqual(migratedModel.effective_start_utc, '2026-01-01T00:00:00Z');
    assert.strictEqual(migratedModel.effective_end_utc, '2027-01-01T00:00:00Z');
    assert.strictEqual(migratedModel.created_at, '2026-01-02T00:00:00.000Z');
    const migratedNode = db.prepare('SELECT * FROM energy_flow_nodes WHERE id = 201').get();
    assert.strictEqual(migratedNode.source_batch_id, legacySeed.batchId);
    assert.strictEqual(migratedNode.source_row_number, 2);
    assert.strictEqual(migratedNode.x, 10.5);
    assert.strictEqual(migratedNode.energy_flow_asset_id, null);
    assert.strictEqual(migratedNode.stage_code, null);
    const migratedEdge = db.prepare('SELECT * FROM energy_flow_edges WHERE id = 301').get();
    assert.strictEqual(migratedEdge.source_mapping_json, '{"reference":"legacy-edge-reference"}');
    assert.strictEqual(migratedEdge.energy_flow_path_id, null);
    assert.strictEqual(migratedEdge.path_sequence, null);
    assert.strictEqual(migratedEdge.source_reference, null);
    const migratedRecord = db.prepare('SELECT * FROM energy_flow_records WHERE id = 401').get();
    assert.strictEqual(migratedRecord.original_value, 12.5);
    assert.strictEqual(migratedRecord.original_unit, 'kWh');
    assert.strictEqual(migratedRecord.start_utc, '2026-06-01T00:00:00Z');
    assert.strictEqual(migratedRecord.end_utc, '2026-07-01T00:00:00Z');
    assert.strictEqual(migratedRecord.record_status, 'void');
    assert.strictEqual(migratedRecord.voided_at, '2026-07-01T00:00:00Z');
    assert.strictEqual(migratedRecord.formula_version, 'energy-flow:v1');
    ['record_code', 'record_role', 'energy_flow_node_id', 'energy_flow_path_id',
      'energy_flow_asset_id', 'stage_code', 'energy_type_id', 'start_wall_clock',
      'end_wall_clock', 'source_reference'].forEach((columnName) => assert.strictEqual(migratedRecord[columnName], null));
    assert.throws(() => db.prepare('DELETE FROM import_batches WHERE id = ?').run(legacySeed.batchId), /FOREIGN KEY constraint failed/);
    ENERGY_FLOW_TABLES.forEach((tableName) => assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true));
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  // 已知 v1 的非零毫秒业务时间不得被截断或猜测，迁移必须稳定 fail-closed。
  const legacyMillisecondPath = path.join(temporaryRoot, 'legacy-nonzero-millisecond.sqlite');
  fs.copyFileSync(primaryDatabasePath, legacyMillisecondPath);
  db = openDatabase({ databasePath: legacyMillisecondPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    installLegacyV1Schema(db);
    seedLegacyV1Data(db, {
      recordStatus: 'void',
      voidedAt: '2026-07-01T00:00:00.001Z'
    });
  } finally {
    db.close();
  }
  assertStableMigrationError(
    () => initDatabase({ databasePath: legacyMillisecondPath }),
    'N8_ENERGY_FLOW_LEGACY_CONFLICT'
  );
  db = openDatabase({ databasePath: legacyMillisecondPath });
  try {
    assert.strictEqual(
      db.prepare('SELECT voided_at FROM energy_flow_records WHERE id = 401').pluck().get(),
      '2026-07-01T00:00:00.001Z',
      '失败迁移必须回滚并保留 v1 非零毫秒原值。'
    );
    assert(getCreateSql(db, 'energy_flow_models').includes('UNIQUE (model_code, version)'));
  } finally {
    db.close();
  }

  // 空非 canonical 骨架允许重建，并必须清除未知触发器与未知索引。
  const emptySkeletonPath = path.join(temporaryRoot, 'empty-skeleton.sqlite');
  fs.copyFileSync(primaryDatabasePath, emptySkeletonPath);
  db = openDatabase({ databasePath: emptySkeletonPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    dropEnergyFlowTables(db);
    db.exec(`CREATE TABLE energy_flow_models (id INTEGER PRIMARY KEY, legacy_payload TEXT);
      CREATE INDEX idx_unknown_empty_flow ON energy_flow_models(legacy_payload);
      CREATE TRIGGER trg_unknown_empty_flow AFTER INSERT ON energy_flow_models BEGIN SELECT 1; END;`);
  } finally {
    db.close();
  }
  initDatabase({ databasePath: emptySkeletonPath });
  db = openDatabase({ databasePath: emptySkeletonPath });
  try {
    ENERGY_FLOW_TABLES.forEach((tableName) => assert.strictEqual(energyFlowTableIsCanonical(db, tableName), true));
    assert.strictEqual(sqliteObjectExists(db, 'index', 'idx_unknown_empty_flow'), false);
    assert.strictEqual(sqliteObjectExists(db, 'trigger', 'trg_unknown_empty_flow'), false);
  } finally {
    db.close();
  }

  // 含业务数据的未知列、未知约束、未知触发器或未知索引均必须稳定 fail-closed。
  const nonCanonicalCases = [
    {
      name: 'unknown-column',
      mutate(caseDb) {
        dropEnergyFlowTables(caseDb);
        caseDb.exec(`CREATE TABLE energy_flow_models (id INTEGER PRIMARY KEY, legacy_payload TEXT NOT NULL);
          INSERT INTO energy_flow_models (id, legacy_payload) VALUES (1, 'legacy');`);
      }
    },
    {
      name: 'unknown-constraint',
      mutate(caseDb) {
        dropEnergyFlowTables(caseDb);
        const unknownConstraintSchema = LEGACY_V1_SCHEMA_SQL.replace(
          'UNIQUE (model_code, version),\n  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))',
          `UNIQUE (model_code, version),
  CHECK (model_code <> 'FORBIDDEN'),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))`
        );
        caseDb.exec(unknownConstraintSchema);
        seedLegacyV1Data(caseDb);
      }
    },
    {
      name: 'literal-case-drift',
      mutate(caseDb) {
        dropEnergyFlowTables(caseDb);
        caseDb.exec(LEGACY_V1_SCHEMA_SQL.replace(
          "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))",
          "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'INACTIVE'))"
        ));
        seedLegacyV1Data(caseDb);
      }
    },
    {
      name: 'literal-double-quote-drift',
      mutate(caseDb) {
        dropEnergyFlowTables(caseDb);
        caseDb.exec(LEGACY_V1_SCHEMA_SQL.replace(
          "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))",
          "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in\"active'))"
        ));
        seedLegacyV1Data(caseDb);
      }
    },
    {
      name: 'unknown-trigger',
      mutate(caseDb) {
        installLegacyV1Schema(caseDb);
        seedLegacyV1Data(caseDb);
        caseDb.exec('CREATE TRIGGER trg_unknown_populated_flow AFTER UPDATE ON energy_flow_models BEGIN SELECT 1; END;');
      }
    },
    {
      name: 'unknown-index',
      mutate(caseDb) {
        installLegacyV1Schema(caseDb);
        seedLegacyV1Data(caseDb);
        caseDb.exec('CREATE INDEX idx_unknown_populated_flow ON energy_flow_models(model_name)');
      }
    }
  ];
  nonCanonicalCases.forEach((testCase) => {
    const casePath = path.join(temporaryRoot, `${testCase.name}.sqlite`);
    fs.copyFileSync(primaryDatabasePath, casePath);
    const caseDb = openDatabase({ databasePath: casePath });
    try {
      caseDb.pragma('foreign_keys = OFF');
      caseDb.exec(`DELETE FROM energy_flow_loss_evidence;
        DELETE FROM energy_flow_loss_facts;
        DELETE FROM energy_flow_waste_heat_facts;
        DELETE FROM energy_flow_records;
        DELETE FROM energy_flow_edges;
        DELETE FROM energy_flow_nodes;
        DELETE FROM energy_flow_paths;
        DELETE FROM energy_flow_assets;
        DELETE FROM energy_flow_models;`);
      testCase.mutate(caseDb);
    } finally {
      caseDb.close();
    }
    assertStableMigrationError(
      () => initDatabase({ databasePath: casePath }),
      'N8_ENERGY_FLOW_NON_CANONICAL_DATA'
    );
  });

  // 已知 v1 的规范键冲突必须使用稳定冲突码回滚，不得合并或覆盖历史模型。
  const collisionPath = path.join(temporaryRoot, 'normalized-collision.sqlite');
  fs.copyFileSync(primaryDatabasePath, collisionPath);
  db = openDatabase({ databasePath: collisionPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    installLegacyV1Schema(db);
    seedLegacyV1Data(db, { modelCode: 'FLOW-COLLISION', modelVersion: 'V1' });
    const insertCollisionModel = db.prepare(`INSERT INTO energy_flow_models
      (id, model_code, model_name, source, version, effective_start_utc, effective_end_utc,
       source_timezone, status, created_at, updated_at)
      VALUES (?, ?, ?, '旧库来源', ?,
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active',
       '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`);
    insertCollisionModel.run(102, 'flow-collision', '大小写规范键冲突模型', 'v1');
    insertCollisionModel.run(103, 'FLOW-COLLISION', 'NFKC 规范键冲突模型', 'V１');
  } finally {
    db.close();
  }
  assertStableMigrationError(
    () => initDatabase({ databasePath: collisionPath }),
    'N8_ENERGY_FLOW_LEGACY_CONFLICT'
  );
  db = openDatabase({ databasePath: collisionPath });
  try {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_models').get().total, 3,
      '冲突迁移失败后必须整体回滚并保留三条 v1 原始模型。');
    assert(getCreateSql(db, 'energy_flow_models').includes('UNIQUE (model_code, version)'));
  } finally {
    db.close();
  }

  // 旧四表作为子表的出向违规必须在迁移前阻断。
  const outgoingViolationPath = path.join(temporaryRoot, 'outgoing-violation.sqlite');
  fs.copyFileSync(primaryDatabasePath, outgoingViolationPath);
  db = openDatabase({ databasePath: outgoingViolationPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO energy_flow_records
      (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_edge_id,
       start_utc, end_utc, source_timezone, original_unit, original_value, source_type,
       source_mapping_json, formula_version)
      VALUES (NULL, NULL, 999999, 999999, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
       'Asia/Shanghai', 'kWh', 1, 'explicit_edge_value', '{"reference":"orphan"}', 'v1')`).run();
  } finally {
    db.close();
  }
  assertStableMigrationError(
    () => initDatabase({ databasePath: outgoingViolationPath }),
    'N8_ENERGY_FLOW_FOREIGN_KEY_CHECK_FAILED'
  );

  // N8 表作为父表时，未知外部子表的入向违规同样必须阻断。
  const incomingViolationPath = path.join(temporaryRoot, 'incoming-violation.sqlite');
  fs.copyFileSync(primaryDatabasePath, incomingViolationPath);
  db = openDatabase({ databasePath: incomingViolationPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE external_energy_flow_links (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL,
      FOREIGN KEY (model_id) REFERENCES energy_flow_models(id) ON DELETE RESTRICT
    );
    INSERT INTO external_energy_flow_links (id, model_id) VALUES (1, 999999);`);
  } finally {
    db.close();
  }
  assertStableMigrationError(
    () => initDatabase({ databasePath: incomingViolationPath }),
    'N8_ENERGY_FLOW_FOREIGN_KEY_CHECK_FAILED'
  );

  // 新增损耗证据表作为子表的出向违规必须被全库 foreign_key_check 纳入 N8 判定。
  const newTableViolationPath = path.join(temporaryRoot, 'new-table-violation.sqlite');
  fs.copyFileSync(primaryDatabasePath, newTableViolationPath);
  db = openDatabase({ databasePath: newTableViolationPath });
  try {
    const workbook = db.prepare("SELECT id, source_batch_id AS batchId FROM energy_flow_models WHERE model_code = 'FLOW-WORKBOOK'").get();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO energy_flow_loss_evidence
      (source_batch_id, source_row_number, energy_flow_model_id, energy_flow_loss_fact_id,
       evidence_code, evidence_role, evidence_name, evidence_type, evidence_reference,
       evidence_start_wall_clock, evidence_end_wall_clock, evidence_start_utc, evidence_end_utc,
       source_timezone, benchmark_loss_value, benchmark_loss_unit, status)
      VALUES (?, 999, ?, 999999, 'ORPHAN-EVIDENCE', 'fact_evidence', '孤儿证据', 'other', 'orphan',
       '2026-01-01T08:00', '2026-02-01T08:00', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
       'Asia/Shanghai', NULL, NULL, 'active')`).run(workbook.batchId, workbook.id);
  } finally {
    db.close();
  }
  assertStableMigrationError(
    () => initDatabase({ databasePath: newTableViolationPath }),
    'N8_ENERGY_FLOW_FOREIGN_KEY_CHECK_FAILED'
  );

  // 迁移片段中途语法故障必须整体回滚，不留下半迁移 canonical 表。
  const rollbackPath = path.join(temporaryRoot, 'rollback.sqlite');
  fs.copyFileSync(primaryDatabasePath, rollbackPath);
  db = openDatabase({ databasePath: rollbackPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM energy_flow_loss_evidence;
      DELETE FROM energy_flow_loss_facts;
      DELETE FROM energy_flow_waste_heat_facts;
      DELETE FROM energy_flow_records;
      DELETE FROM energy_flow_edges;
      DELETE FROM energy_flow_nodes;
      DELETE FROM energy_flow_paths;
      DELETE FROM energy_flow_assets;
      DELETE FROM energy_flow_models;`);
    installLegacyV1Schema(db);
    seedLegacyV1Data(db);
    const invalidSchema = `-- ENERGY_ANALYSIS_SCHEMA_START
      CREATE TABLE energy_flow_models (id INTEGER PRIMARY KEY);
      CREATE TABLE broken_energy_flow_table (
      -- ENERGY_ANALYSIS_SCHEMA_END`;
    assertStableMigrationError(
      () => ensureEnergyAnalysisTables(db, invalidSchema),
      'N8_ENERGY_FLOW_LEGACY_CONFLICT'
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_models').get().total, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM energy_flow_records').get().total, 1);
    assert(getCreateSql(db, 'energy_flow_models').includes('UNIQUE (model_code, version)'),
      '中途故障后必须恢复 v1 建表合同。');
  } finally {
    db.close();
  }

  console.log('energyFlowWorkbookMigration tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
