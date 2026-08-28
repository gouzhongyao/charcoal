const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  databaseAdmissionBlocked: createDatabaseAdmissionBlockedError,
  databasePoisoned: createDatabasePoisonedError
} = require('../utils/errors');
const {
  buildSupplierCodeKey,
  normalizeSupplierCodeDisplay
} = require('../services/supplierContracts');
const {
  isEnergyFlowUtcSecond,
  normalizeEnergyFlowKey,
  normalizeEnergyFlowUtcSecond,
  validateAndNormalizeEnergyFlowIdentityCode
} = require('../services/energyAnalysisContracts');
const { isStrictWallClockMinute } = require('../services/sourceWallClockService');

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../../data');
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
const backupsDir = process.env.BACKUPS_DIR || path.join(dataDir, 'backups');
const databasePath = process.env.SQLITE_PATH || path.join(dataDir, 'energy-carbon.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

// 最终正式库只接受当前 canonical 身份及唯一已审查 predecessor；任何其他旧版本继续 fail-closed。
const CANONICAL_SCHEMA_STAGE = 'formal-canonical';
const CANONICAL_SCHEMA_VERSION = '2026-08-28-formal-canonical-v3';
const CANONICAL_SCHEMA_PREDECESSOR_VERSION = '2026-08-27-formal-canonical-v2';
const CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM = 'sqlite-master-sha256-v1';
// v2 后置动作切片固定由两表、三索引和九个跨行/跨表触发器组成。
const DEMO_POST_ACTION_CANONICAL_SCHEMA_OBJECT_COUNT = 14;

// 正式数据库切换期间阻止新连接进入，避免 Windows 文件替换窗口出现并发句柄。
let databaseAdmissionBlocked = false;
// 原子替换回滚失败后保持数据库 poison，所有后续数据库 API 均 fail-closed。
let databasePoisoned = false;
// admission permit 仅由建立屏障的调用方持有，普通请求无法通过布尔参数绕过屏障。
let databaseAdmissionPermit = null;
// 仅跟踪正式数据库连接，候选库连接不参与切换窗口归零判断。
let activeOfficialDatabaseConnections = 0;
// durable restore marker 使用固定协议和 UUID 操作身份，禁止文件名被伪造成正式数据库。
const DATABASE_RESTORE_MARKER_SCHEMA = 'charcoal-database-restore-marker';
const DATABASE_RESTORE_MARKER_VERSION = 1;
const DATABASE_RESTORE_MARKER_PHASE = 'prepared';
const DATABASE_RESTORE_MARKER_NAME = '.restore-in-progress.json';
const DATABASE_RESTORE_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 导入批次保留全部历史类型，并为阶段 3 预留八类能源分析导入。
const IMPORT_BATCH_TYPES = Object.freeze([
  'energy_record',
  'meter_reading',
  'organization_unit',
  'meter_device',
  'production_unit',
  'production_output',
  'generation_record',
  'energy_budget',
  'carbon_factor',
  'prediction_config',
  'energy_timeseries',
  'shift_schedule',
  'device_state',
  'energy_conversion_factor',
  'energy_benchmark',
  'energy_flow_node',
  'energy_flow_edge',
  'energy_flow_record',
  'shift_definition',
  'tou_scheme',
  'strategy_rule',
  'energy_flow_model',
  'energy_balance_boundary',
  'energy_balance_item',
  'energy_flow_workbook',
  'supplier',
  'carbon_activity',
  'carbon_emission_report',
  'ghg_report'
]);

// import_batches 重建 SQL 使用统一白名单，避免 schema 与旧库迁移枚举漂移。
const IMPORT_BATCH_TYPES_SQL = IMPORT_BATCH_TYPES.map((importType) => `'${importType}'`).join(', ');

// 能源分析 schema 片段标记用于独立幂等迁移和失败回滚测试。
const ENERGY_ANALYSIS_SCHEMA_START_MARKER = '-- ENERGY_ANALYSIS_SCHEMA_START';
const ENERGY_ANALYSIS_SCHEMA_END_MARKER = '-- ENERGY_ANALYSIS_SCHEMA_END';

// N8 canonical v2 九表、显式索引和空触发器集合共同构成完整结构指纹。
const ENERGY_FLOW_TABLE_INDEXES = Object.freeze({
  energy_flow_models: Object.freeze([
    'ux_energy_flow_models_business_key',
    'idx_energy_flow_models_effective',
    'idx_energy_flow_models_batch'
  ]),
  energy_flow_assets: Object.freeze([
    'ux_energy_flow_assets_code',
    'idx_energy_flow_assets_model_type',
    'idx_energy_flow_assets_batch'
  ]),
  energy_flow_paths: Object.freeze([
    'ux_energy_flow_paths_code',
    'idx_energy_flow_paths_model_status',
    'idx_energy_flow_paths_batch'
  ]),
  energy_flow_nodes: Object.freeze([
    'ux_energy_flow_nodes_code',
    'idx_energy_flow_nodes_model_type',
    'idx_energy_flow_nodes_asset',
    'idx_energy_flow_nodes_batch'
  ]),
  energy_flow_edges: Object.freeze([
    'ux_energy_flow_edges_code',
    'ux_energy_flow_edges_path_sequence',
    'idx_energy_flow_edges_model_type',
    'idx_energy_flow_edges_path',
    'idx_energy_flow_edges_batch'
  ]),
  energy_flow_records: Object.freeze([
    'ux_energy_flow_records_code',
    'idx_energy_flow_records_edge_range',
    'idx_energy_flow_records_node_range',
    'idx_energy_flow_records_model_stage',
    'idx_energy_flow_records_path',
    'idx_energy_flow_records_asset',
    'idx_energy_flow_records_batch'
  ]),
  energy_flow_waste_heat_facts: Object.freeze([
    'ux_energy_flow_waste_heat_code',
    'ux_energy_flow_waste_heat_active_record',
    'idx_energy_flow_waste_heat_model_role',
    'idx_energy_flow_waste_heat_batch'
  ]),
  energy_flow_loss_facts: Object.freeze([
    'ux_energy_flow_loss_facts_code',
    'ux_energy_flow_loss_facts_active_record',
    'idx_energy_flow_loss_facts_model_role',
    'idx_energy_flow_loss_facts_batch'
  ]),
  energy_flow_loss_evidence: Object.freeze([
    'ux_energy_flow_loss_evidence_code',
    'ux_energy_flow_loss_evidence_active_benchmark',
    'idx_energy_flow_loss_evidence_fact_role',
    'idx_energy_flow_loss_evidence_range',
    'idx_energy_flow_loss_evidence_batch'
  ])
});
const ENERGY_FLOW_TABLES = Object.freeze(Object.keys(ENERGY_FLOW_TABLE_INDEXES));
const ENERGY_FLOW_LEGACY_V1_TABLES = Object.freeze([
  'energy_flow_models',
  'energy_flow_nodes',
  'energy_flow_edges',
  'energy_flow_records'
]);
const ENERGY_FLOW_EXPECTED_TRIGGERS = Object.freeze({
  energy_flow_edges: Object.freeze([
    'trg_energy_flow_edges_source_insert',
    'trg_energy_flow_edges_source_update'
  ]),
  energy_flow_records: Object.freeze([
    'trg_energy_flow_records_source_insert',
    'trg_energy_flow_records_source_update'
  ])
});

// 能流边与显式边值来源 provenance 的规范触发器，兼容旧 canonical v2 表的幂等升级。
const ENERGY_FLOW_IMPORT_SOURCE_TRIGGERS_SQL = `CREATE TRIGGER IF NOT EXISTS trg_energy_flow_edges_source_insert
BEFORE INSERT ON energy_flow_edges
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy flow edge import source must contain batch and positive row together');
END;

CREATE TRIGGER IF NOT EXISTS trg_energy_flow_edges_source_update
BEFORE UPDATE OF source_batch_id, source_row_number ON energy_flow_edges
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy flow edge import source must contain batch and positive row together');
END;

CREATE TRIGGER IF NOT EXISTS trg_energy_flow_records_source_insert
BEFORE INSERT ON energy_flow_records
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy flow record import source must contain batch and positive row together');
END;

CREATE TRIGGER IF NOT EXISTS trg_energy_flow_records_source_update
BEFORE UPDATE OF source_batch_id, source_row_number ON energy_flow_records
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy flow record import source must contain batch and positive row together');
END;`;

// 已知 v1 指纹仅用于机械迁移；任何列、约束、索引或触发器漂移都不得按已知旧库猜测处理。
const ENERGY_FLOW_LEGACY_V1_SCHEMA_SQL = `CREATE TABLE energy_flow_models (
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
const ENERGY_FLOW_LEGACY_V1_TABLE_INDEXES = Object.freeze({
  energy_flow_models: Object.freeze(['idx_energy_flow_models_effective']),
  energy_flow_nodes: Object.freeze(['idx_energy_flow_nodes_model_type', 'idx_energy_flow_nodes_batch']),
  energy_flow_edges: Object.freeze(['idx_energy_flow_edges_model_type', 'idx_energy_flow_edges_batch']),
  energy_flow_records: Object.freeze(['idx_energy_flow_records_edge_range', 'idx_energy_flow_records_batch'])
});
const ENERGY_FLOW_LEGACY_V1_COLUMNS = Object.freeze({
  energy_flow_models: Object.freeze([
    'id', 'model_code', 'model_name', 'source', 'document_no', 'version',
    'effective_start_utc', 'effective_end_utc', 'source_timezone', 'status', 'created_at', 'updated_at'
  ]),
  energy_flow_nodes: Object.freeze([
    'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'node_code',
    'node_name', 'node_type', 'organization_unit_id', 'x', 'y', 'status', 'created_at', 'updated_at'
  ]),
  energy_flow_edges: Object.freeze([
    'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'edge_code',
    'from_node_id', 'to_node_id', 'energy_type_id', 'unit', 'source_type',
    'source_mapping_json', 'status', 'created_at', 'updated_at'
  ]),
  energy_flow_records: Object.freeze([
    'id', 'source_batch_id', 'source_row_number', 'energy_flow_model_id', 'energy_flow_edge_id',
    'start_utc', 'end_utc', 'source_timezone', 'original_unit', 'original_value', 'source_type',
    'source_mapping_json', 'formula_version', 'record_status', 'void_reason', 'voided_at',
    'created_at', 'updated_at'
  ])
});

// 更早的精确已知 v1 仅在 edge/record 缺少成对 provenance 列、对应外键与 batch 索引；其余指纹必须完全一致。
const ENERGY_FLOW_LEGACY_V1_NO_EDGE_RECORD_PROVENANCE_COLUMNS = Object.freeze({
  energy_flow_models: ENERGY_FLOW_LEGACY_V1_COLUMNS.energy_flow_models,
  energy_flow_nodes: ENERGY_FLOW_LEGACY_V1_COLUMNS.energy_flow_nodes,
  energy_flow_edges: Object.freeze(ENERGY_FLOW_LEGACY_V1_COLUMNS.energy_flow_edges
    .filter((columnName) => !['source_batch_id', 'source_row_number'].includes(columnName))),
  energy_flow_records: Object.freeze(ENERGY_FLOW_LEGACY_V1_COLUMNS.energy_flow_records
    .filter((columnName) => !['source_batch_id', 'source_row_number'].includes(columnName)))
});
const ENERGY_FLOW_LEGACY_V1_NO_EDGE_RECORD_PROVENANCE_INDEXES = Object.freeze({
  energy_flow_models: ENERGY_FLOW_LEGACY_V1_TABLE_INDEXES.energy_flow_models,
  energy_flow_nodes: ENERGY_FLOW_LEGACY_V1_TABLE_INDEXES.energy_flow_nodes,
  energy_flow_edges: Object.freeze(['idx_energy_flow_edges_model_type']),
  energy_flow_records: Object.freeze(['idx_energy_flow_records_edge_range'])
});
const ENERGY_FLOW_LEGACY_V1_PROFILES = Object.freeze([
  Object.freeze({
    profileKey: 'with-edge-record-provenance',
    columns: ENERGY_FLOW_LEGACY_V1_COLUMNS,
    indexes: ENERGY_FLOW_LEGACY_V1_TABLE_INDEXES,
    edgeRecordProvenance: true
  }),
  Object.freeze({
    profileKey: 'without-edge-record-provenance',
    columns: ENERGY_FLOW_LEGACY_V1_NO_EDGE_RECORD_PROVENANCE_COLUMNS,
    indexes: ENERGY_FLOW_LEGACY_V1_NO_EDGE_RECORD_PROVENANCE_INDEXES,
    edgeRecordProvenance: false
  })
]);

// 独立碳活动 schema 片段标记用于新旧库一致的幂等迁移和失败回滚测试。
const CARBON_ACTIVITY_SCHEMA_START_MARKER = '-- CARBON_ACTIVITY_SCHEMA_START';
const CARBON_ACTIVITY_SCHEMA_END_MARKER = '-- CARBON_ACTIVITY_SCHEMA_END';

// 碳排放报告 schema 片段及五表 canonical contract 用于旧库安全幂等迁移。
const CARBON_EMISSION_REPORT_SCHEMA_START_MARKER = '-- CARBON_EMISSION_REPORT_SCHEMA_START';
const CARBON_EMISSION_REPORT_SCHEMA_END_MARKER = '-- CARBON_EMISSION_REPORT_SCHEMA_END';
const CARBON_EMISSION_REPORT_TABLE_INDEXES = Object.freeze({
  carbon_emission_reports: Object.freeze([
    'idx_carbon_emission_reports_period',
    'idx_carbon_emission_reports_organization',
    'idx_carbon_emission_reports_batch'
  ]),
  carbon_emission_report_boundaries: Object.freeze(['idx_carbon_emission_report_boundaries_report']),
  carbon_emission_report_evidence: Object.freeze(['idx_carbon_emission_report_evidence_report']),
  carbon_emission_report_items: Object.freeze([
    'idx_carbon_emission_report_items_filters',
    'idx_carbon_emission_report_items_evidence'
  ]),
  carbon_emission_report_summaries: Object.freeze(['idx_carbon_emission_report_summaries_report'])
});
const CARBON_EMISSION_REPORT_TABLES = Object.freeze(Object.keys(CARBON_EMISSION_REPORT_TABLE_INDEXES));

// 温室气体报告 schema 片段及六表 canonical contract 用于旧库安全幂等迁移。
const GHG_REPORT_SCHEMA_START_MARKER = '-- GHG_REPORT_SCHEMA_START';
const GHG_REPORT_SCHEMA_END_MARKER = '-- GHG_REPORT_SCHEMA_END';
const GHG_REPORT_TABLE_INDEXES = Object.freeze({
  ghg_reports: Object.freeze([
    'idx_ghg_reports_period',
    'idx_ghg_reports_organization',
    'idx_ghg_reports_batch'
  ]),
  ghg_report_organization_boundaries: Object.freeze(['idx_ghg_report_organization_boundaries_report']),
  ghg_report_operational_boundaries: Object.freeze(['idx_ghg_report_operational_boundaries_report']),
  ghg_report_evidence: Object.freeze(['idx_ghg_report_evidence_report']),
  ghg_report_items: Object.freeze([
    'idx_ghg_report_items_filters',
    'idx_ghg_report_items_evidence'
  ]),
  ghg_report_summaries: Object.freeze(['idx_ghg_report_summaries_report'])
});
const GHG_REPORT_TABLES = Object.freeze(Object.keys(GHG_REPORT_TABLE_INDEXES));
// N7 六表 canonical contract 不包含任何触发器，防止旧库同名表通过隐式副作用写入其他领域。
const GHG_REPORT_EXPECTED_TRIGGERS = Object.freeze([]);

// 独立核算运行与结果表的 canonical contract 用于安全识别 N5-A 空骨架，禁止伪造已有历史。
const CARBON_ACCOUNTING_TABLE_CONTRACTS = Object.freeze({
  carbon_calculation_runs: {
    columns: [
      'id', 'run_code', 'snapshot_schema_version', 'source_type', 'status', 'calculation_method',
      'start_utc', 'end_utc', 'activity_filter_json', 'actor_snapshot_json',
      'activity_snapshot_digest', 'activity_count', 'result_count', 'calculated_count',
      'factor_missing_count', 'emission_totals_json', 'created_by', 'started_at',
      'completed_at', 'created_at'
    ],
    sqlTokens: [
      'snapshot_schema_version = 1', "source_type = 'independent_activity'", "status = 'completed'",
      "calculation_method = 'standard-factor'", "json_extract(activity_filter_json, '$.version') = 1",
      "json_extract(actor_snapshot_json, '$.version') = 1", 'result_count = activity_count',
      'calculated_count + factor_missing_count = result_count', 'REFERENCES sys_users(id)'
    ],
    foreignKeys: [
      { from: 'created_by', table: 'sys_users', to: 'id', onDelete: 'SET NULL' }
    ],
    indexes: {
      idx_carbon_calculation_runs_status_created: {
        unique: false,
        columns: ['source_type', 'status', 'completed_at', 'id'],
        descending: [false, false, true, true]
      },
      idx_carbon_calculation_runs_period: {
        unique: false,
        columns: ['start_utc', 'end_utc', 'completed_at'],
        descending: [false, false, true]
      }
    }
  },
  carbon_accounting_results: {
    columns: [
      'id', 'calculation_run_id', 'snapshot_schema_version', 'source_type', 'activity_record_id',
      'carbon_factor_id', 'emission_scope', 'activity_category', 'organization_unit_id',
      'energy_type_id', 'activity_start_wall_clock', 'activity_end_wall_clock',
      'activity_start_utc', 'activity_end_utc', 'activity_value', 'activity_unit',
      'requested_region', 'factor_year', 'factor_value', 'factor_unit', 'emission_value',
      'emission_unit', 'status', 'missing_reason', 'calculation_basis', 'match_priority',
      'activity_snapshot_json', 'organization_snapshot_json', 'energy_type_snapshot_json',
      'factor_snapshot_json', 'matching_snapshot_json', 'formula_snapshot_json', 'created_at'
    ],
    sqlTokens: [
      'snapshot_schema_version = 1', "source_type = 'independent_activity'",
      "status IN ('calculated', 'factor_missing')", 'UNIQUE (calculation_run_id, activity_record_id)',
      'REFERENCES carbon_calculation_runs(id)', "status = 'factor_missing'",
      'emission_unit IS NULL', 'factor_snapshot_json IS NULL',
      "json_extract(activity_snapshot_json, '$.version') = 1",
      "json_extract(matching_snapshot_json, '$.version') = 1",
      "json_extract(formula_snapshot_json, '$.version') = 1"
    ],
    foreignKeys: [
      { from: 'calculation_run_id', table: 'carbon_calculation_runs', to: 'id', onDelete: 'CASCADE' }
    ],
    indexes: {
      idx_carbon_accounting_results_activity: {
        unique: false,
        columns: ['activity_record_id', 'calculation_run_id']
      },
      idx_carbon_accounting_results_run_status: {
        unique: false,
        columns: ['calculation_run_id', 'status', 'id']
      },
      idx_carbon_accounting_results_filters: {
        unique: false,
        columns: ['calculation_run_id', 'emission_scope', 'organization_unit_id', 'energy_type_id', 'status']
      }
    }
  }
});

// 演示治理 schema 片段标记用于旧库在完整 schema 执行前安全补齐治理表和外键依赖。
const DEMO_GOVERNANCE_SCHEMA_START_MARKER = '-- DEMO_GOVERNANCE_SCHEMA_START';
const DEMO_GOVERNANCE_SCHEMA_END_MARKER = '-- DEMO_GOVERNANCE_SCHEMA_END';

// 演示运行与导入批次关系支持同 artifact 多批次及受控 batch role，且不依赖 import_type 唯一性。
const DEMO_GOVERNANCE_TABLES = Object.freeze([
  'demo_runtime_settings',
  'demo_dataset_runs',
  'demo_import_contexts',
  'demo_legacy_claim_runs',
  'demo_cleanup_runs',
  'demo_data_registry',
  'demo_data_relations',
  'demo_run_import_batches',
  'demo_post_action_runs',
  'demo_post_action_outputs'
]);

// 每张治理表的 canonical contract 同时检查字段、关键 CHECK/FK/UNIQUE 文本和必要索引。
const DEMO_GOVERNANCE_CONTRACTS = Object.freeze({
  demo_runtime_settings: {
    columns: ['id', 'enabled', 'runtime_epoch', 'revision', 'updated_by', 'updated_at', 'change_reason'],
    sqlTokens: ['CHECK (id = 1)', "enabled IN (0, 1)", 'runtime_epoch >= 1', 'revision >= 1', 'length(trim(change_reason)) BETWEEN 1 AND 500', 'REFERENCES sys_users(id)']
  },
  demo_dataset_runs: {
    columns: ['run_id', 'dataset_id', 'manifest_version', 'manifest_digest', 'status', 'created_by', 'created_at', 'completed_at', 'cleanup_started_at', 'cleaned_at', 'failure_reason'],
    sqlTokens: ['length(manifest_digest) = 64', "manifest_digest NOT GLOB '*[^a-f0-9]*'", "status = 'cleaned' AND cleaned_at IS NOT NULL", "status <> 'cleaned' AND cleaned_at IS NULL", 'REFERENCES sys_users(id)'],
    triggers: ['trg_demo_dataset_runs_post_action_dataset_update'],
    indexes: {
      ux_demo_dataset_runs_active_dataset: {
        unique: true,
        columns: ['dataset_id'],
        where: "status IN ('active', 'completed', 'cleanup_pending', 'cleaning')"
      },
      idx_demo_dataset_runs_status_created: { unique: false, columns: ['status', 'created_at'] }
    }
  },
  demo_import_contexts: {
    columns: ['context_id', 'token_hash', 'run_id', 'dataset_id', 'manifest_version', 'manifest_digest', 'artifact_key', 'handler_key', 'artifact_file_sha256', 'issued_to_user_id', 'runtime_epoch', 'status', 'issued_at', 'expires_at', 'upload_file_sha256', 'preview_digest', 'previewed_at', 'executed_at', 'revoked_at', 'revoke_reason', 'reassociated_from_context_id', 'replacement_context_id', 'reassociated_at'],
    sqlTokens: ['length(token_hash) = 64', "token_hash NOT GLOB '*[^a-f0-9]*'", 'length(manifest_digest) = 64', "manifest_digest NOT GLOB '*[^a-f0-9]*'", 'length(artifact_file_sha256) = 64', "artifact_file_sha256 NOT GLOB '*[^a-f0-9]*'", 'upload_file_sha256 IS NULL', 'length(upload_file_sha256) = 64', "upload_file_sha256 NOT GLOB '*[^a-f0-9]*'", 'UNIQUE (context_id, run_id, artifact_key)', 'REFERENCES demo_dataset_runs(run_id)', 'REFERENCES sys_users(id)', 'REFERENCES demo_import_contexts(context_id)', 'is_strict_utc_iso(expires_at) = 1', 'unixepoch(issued_at) < unixepoch(expires_at)', "length(preview_digest) = 85", "preview_digest GLOB 'hmac-sha256:v1:audit:[a-f0-9]*'", "status = 'previewed' AND previewed_at IS NOT NULL", "status IN ('revoked', 'expired') AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL", "revoke_reason = 'reassociated' AND replacement_context_id IS NOT NULL"],
    indexes: {
      ux_demo_import_contexts_reassociated_from: { unique: true, columns: ['reassociated_from_context_id'], where: 'reassociated_from_context_id IS NOT NULL' },
      ux_demo_import_contexts_replacement: { unique: true, columns: ['replacement_context_id'], where: 'replacement_context_id IS NOT NULL' },
      idx_demo_import_contexts_run_artifact: { unique: false, columns: ['run_id', 'artifact_key', 'status'] },
      idx_demo_import_contexts_user_expiry: { unique: false, columns: ['issued_to_user_id', 'expires_at', 'status'] },
      idx_demo_import_contexts_handler_status: { unique: false, columns: ['handler_key', 'status', 'expires_at'] }
    }
  },
  demo_legacy_claim_runs: {
    columns: ['claim_run_id', 'dataset_id', 'evidence_digest', 'plan_digest', 'preview_expires_at', 'candidate_count', 'blocker_count', 'blocker_summary_json', 'confirmation_text', 'requested_by', 'status', 'claimed_count', 'created_at', 'executed_at', 'failure_reason'],
    sqlTokens: ['candidate_count >= 0', 'blocker_count >= 0', 'claimed_count >= 0', 'REFERENCES sys_users(id)'],
    indexes: {
      idx_demo_legacy_claim_runs_status_created: { unique: false, columns: ['status', 'created_at'] }
    }
  },
  demo_cleanup_runs: {
    columns: ['cleanup_run_id', 'run_id', 'client_request_id', 'preview_digest', 'preview_expires_at', 'runtime_revision', 'registry_watermark', 'candidate_count', 'blocker_count', 'summary_json', 'confirmation_text', 'requested_by', 'status', 'backup_metadata_json', 'deleted_count', 'already_missing_count', 'created_at', 'started_at', 'completed_at', 'failure_reason'],
    sqlTokens: ['client_request_id TEXT NOT NULL UNIQUE', 'runtime_revision >= 1', 'REFERENCES demo_dataset_runs(run_id)', 'REFERENCES sys_users(id)'],
    indexes: {
      idx_demo_cleanup_runs_status_created: { unique: false, columns: ['status', 'created_at'] }
    }
  },
  demo_data_registry: {
    columns: ['registry_id', 'run_id', 'artifact_key', 'entity_type', 'entity_pk', 'ownership_kind', 'identity_digest', 'snapshot_digest', 'source_batch_id', 'source_row_number', 'legacy_claim_run_id', 'registered_by', 'registered_at', 'cleaned_at', 'cleanup_run_id', 'cleanup_result'],
    sqlTokens: ['UNIQUE (registry_id, run_id)', 'REFERENCES demo_dataset_runs(run_id)', 'REFERENCES import_batches(id)', 'REFERENCES demo_cleanup_runs(cleanup_run_id)'],
    indexes: {
      ux_demo_data_registry_active_entity: {
        unique: true,
        columns: ['entity_type', 'entity_pk'],
        where: 'cleaned_at IS NULL'
      },
      idx_demo_data_registry_run_artifact: { unique: false, columns: ['run_id', 'artifact_key', 'cleaned_at'] },
      idx_demo_data_registry_batch: { unique: false, columns: ['source_batch_id'] },
      idx_demo_data_registry_cleanup: { unique: false, columns: ['cleanup_run_id', 'cleanup_result'] }
    }
  },
  demo_data_relations: {
    columns: ['relation_id', 'run_id', 'from_registry_id', 'to_registry_id', 'relation_type', 'created_at'],
    sqlTokens: ['FOREIGN KEY (from_registry_id, run_id) REFERENCES demo_data_registry(registry_id, run_id)', 'FOREIGN KEY (to_registry_id, run_id) REFERENCES demo_data_registry(registry_id, run_id)', 'from_registry_id <> to_registry_id'],
    indexes: {
      idx_demo_data_relations_run_type: { unique: false, columns: ['run_id', 'relation_type'] },
      idx_demo_data_relations_target: { unique: false, columns: ['to_registry_id', 'relation_type'] }
    }
  },
  demo_run_import_batches: {
    columns: ['id', 'run_id', 'artifact_key', 'context_id', 'import_batch_id', 'batch_role', 'linked_at'],
    sqlTokens: ['FOREIGN KEY (context_id, run_id, artifact_key) REFERENCES demo_import_contexts(context_id, run_id, artifact_key)', 'UNIQUE (run_id, artifact_key, context_id, batch_role, import_batch_id)'],
    indexes: {
      idx_demo_run_import_batches_batch: { unique: false, columns: ['import_batch_id'] },
      idx_demo_run_import_batches_run_artifact: { unique: false, columns: ['run_id', 'artifact_key', 'batch_role'] },
      ux_demo_run_import_batches_primary_context: {
        unique: true,
        columns: ['context_id'],
        where: "batch_role = 'primary'"
      }
    }
  },
  demo_post_action_runs: {
    columns: ['action_run_id', 'run_id', 'dataset_id', 'action_key', 'registry_version', 'resolver_version', 'executor_version', 'client_request_id', 'manifest_version', 'manifest_digest', 'registry_digest', 'runtime_epoch', 'runtime_revision', 'input_digest', 'preview_digest', 'output_count', 'result_digest', 'preview_expires_at', 'input_json', 'blocker_json', 'result_json', 'requested_by', 'status', 'retry_count', 'failure_reason', 'created_at', 'started_at', 'completed_at', 'updated_at'],
    sqlTokens: [
      'UNIQUE (run_id, action_key, client_request_id, requested_by)',
      'typeof(manifest_digest) = \'text\'',
      'typeof(output_count) = \'integer\' AND output_count >= 0',
      "status IN ('previewed', 'blocked', 'executing', 'succeeded', 'failed', 'expired')",
      'json_valid(input_json) = 1 AND json_type(input_json) = \'object\'',
      '(result_digest IS NULL) = (result_json IS NULL)',
      'julianday(updated_at) >= julianday(created_at)',
      'started_at IS NULL OR julianday(started_at) >= julianday(created_at)',
      'completed_at IS NULL OR julianday(completed_at) >= julianday(created_at)',
      'status = \'previewed\' AND blocker_json IS NULL AND result_digest IS NULL AND result_json IS NULL',
      'status = \'blocked\' AND blocker_json IS NOT NULL AND result_digest IS NULL AND result_json IS NULL',
      'status = \'executing\' AND blocker_json IS NULL AND result_digest IS NULL AND result_json IS NULL',
      "status = 'succeeded' AND blocker_json IS NULL AND result_digest IS NOT NULL AND result_json IS NOT NULL",
      'status = \'failed\' AND blocker_json IS NULL AND result_digest IS NULL AND result_json IS NULL',
      'status = \'expired\' AND blocker_json IS NULL AND result_digest IS NULL AND result_json IS NULL',
      'REFERENCES demo_dataset_runs(run_id)',
      'REFERENCES sys_users(id)'
    ],
    triggers: [
      'trg_demo_post_action_runs_dataset_insert',
      'trg_demo_post_action_runs_dataset_update',
      'trg_demo_post_action_runs_preview_expiry_insert',
      'trg_demo_post_action_runs_output_count_insert',
      'trg_demo_post_action_runs_output_count_update'
    ],
    indexes: {
      idx_demo_post_action_runs_run_status: { unique: false, columns: ['run_id', 'action_key', 'status', 'created_at'], descending: [false, false, false, true] },
      idx_demo_post_action_runs_actor_created: { unique: false, columns: ['requested_by', 'created_at'], descending: [false, true] }
    }
  },
  demo_post_action_outputs: {
    columns: ['output_id', 'action_run_id', 'output_entity_type', 'output_entity_id', 'output_ref_json', 'created_at'],
    sqlTokens: ['REFERENCES demo_post_action_runs(action_run_id)', 'UNIQUE (action_run_id, output_entity_type, output_entity_id)', 'json_valid(output_ref_json) = 1 AND json_type(output_ref_json) = \'object\'', 'is_strict_utc_iso(created_at) = 1'],
    triggers: [
      'trg_demo_post_action_outputs_count_insert',
      'trg_demo_post_action_outputs_count_delete',
      'trg_demo_post_action_outputs_count_update'
    ],
    indexes: {
      idx_demo_post_action_outputs_run: { unique: false, columns: ['action_run_id', 'output_entity_type', 'output_id'] }
    }
  }
});

// 演示数据集运行表的 canonical SHA-256 摘要约束仅接受 64 位小写十六进制。
const DEMO_DATASET_RUNS_TABLE_SQL = `CREATE TABLE demo_dataset_runs (
  run_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest NOT GLOB '*[^a-f0-9]*'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cleanup_pending', 'cleaning', 'cleaned', 'failed')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  cleanup_started_at TEXT,
  cleaned_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (length(trim(run_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(dataset_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(manifest_version)) BETWEEN 1 AND 64),
  CHECK ((status = 'cleaned' AND cleaned_at IS NOT NULL)
    OR (status <> 'cleaned' AND cleaned_at IS NULL))
);`;

// 演示导入 context v4 冻结独立摘要、完整预演摘要和重新关联谱系。
const DEMO_IMPORT_CONTEXTS_V4_TABLE_SQL = `CREATE TABLE demo_import_contexts (
  context_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^a-f0-9]*'
  ),
  run_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest NOT GLOB '*[^a-f0-9]*'
  ),
  artifact_key TEXT NOT NULL,
  handler_key TEXT NOT NULL,
  artifact_file_sha256 TEXT NOT NULL CHECK (
    length(artifact_file_sha256) = 64
    AND artifact_file_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  issued_to_user_id INTEGER NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 1),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'previewed', 'executed', 'revoked', 'expired')),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) CHECK (is_strict_utc_iso(issued_at) = 1),
  expires_at TEXT NOT NULL CHECK (is_strict_utc_iso(expires_at) = 1),
  upload_file_sha256 TEXT CHECK (
    upload_file_sha256 IS NULL OR (
      length(upload_file_sha256) = 64
      AND upload_file_sha256 NOT GLOB '*[^a-f0-9]*'
    )
  ),
  preview_digest TEXT CHECK (
    preview_digest IS NULL OR (
      length(preview_digest) = 85
      AND preview_digest GLOB 'hmac-sha256:v1:audit:[a-f0-9]*'
      AND length(replace(preview_digest, 'hmac-sha256:v1:audit:', '')) = 64
      AND replace(preview_digest, 'hmac-sha256:v1:audit:', '') NOT GLOB '*[^a-f0-9]*'
    )
  ),
  previewed_at TEXT CHECK (previewed_at IS NULL OR is_strict_utc_iso(previewed_at) = 1),
  executed_at TEXT CHECK (executed_at IS NULL OR is_strict_utc_iso(executed_at) = 1),
  revoked_at TEXT CHECK (revoked_at IS NULL OR is_strict_utc_iso(revoked_at) = 1),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(trim(revoke_reason)) BETWEEN 1 AND 128),
  reassociated_from_context_id TEXT,
  replacement_context_id TEXT,
  reassociated_at TEXT CHECK (reassociated_at IS NULL OR is_strict_utc_iso(reassociated_at) = 1),
  FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (issued_to_user_id) REFERENCES sys_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (reassociated_from_context_id) REFERENCES demo_import_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_context_id) REFERENCES demo_import_contexts(context_id) ON DELETE RESTRICT,
  UNIQUE (context_id, run_id, artifact_key),
  CHECK (length(trim(context_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(dataset_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(manifest_version)) BETWEEN 1 AND 64),
  CHECK (length(trim(artifact_key)) BETWEEN 1 AND 128),
  CHECK (length(trim(handler_key)) BETWEEN 1 AND 128),
  CHECK (unixepoch(issued_at) < unixepoch(expires_at)),
  CHECK ((status = 'previewed' AND previewed_at IS NOT NULL AND upload_file_sha256 IS NOT NULL AND preview_digest IS NOT NULL)
    OR status <> 'previewed'),
  CHECK ((status = 'executed' AND executed_at IS NOT NULL) OR status <> 'executed'),
  CHECK ((status IN ('revoked', 'expired') AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    OR (status NOT IN ('revoked', 'expired') AND revoked_at IS NULL AND revoke_reason IS NULL)),
  CHECK ((revoke_reason = 'reassociated' AND replacement_context_id IS NOT NULL AND reassociated_at IS NOT NULL)
    OR revoke_reason <> 'reassociated' OR revoke_reason IS NULL),
  CHECK ((reassociated_from_context_id IS NOT NULL AND reassociated_at IS NOT NULL)
    OR reassociated_from_context_id IS NULL)
);`;

// 演示运行与导入批次关系支持同 artifact 多批次及受控 batch role，且不依赖 import_type 唯一性。
const DEMO_RUN_IMPORT_BATCHES_TABLE_SQL = `CREATE TABLE demo_run_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  context_id TEXT NOT NULL,
  import_batch_id INTEGER NOT NULL,
  batch_role TEXT NOT NULL DEFAULT 'primary',
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, run_id, artifact_key) REFERENCES demo_import_contexts(context_id, run_id, artifact_key) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  UNIQUE (run_id, artifact_key, context_id, batch_role, import_batch_id),
  CHECK (length(trim(artifact_key)) BETWEEN 1 AND 128),
  CHECK (length(trim(batch_role)) BETWEEN 1 AND 64)
);`;

// 平衡计算运行表为每次执行提供不可混淆的一等身份，内容摘要仅保留指纹语义。
const ENERGY_BALANCE_CALCULATION_RUNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS energy_balance_calculation_runs (
  calculation_run_id TEXT PRIMARY KEY,
  energy_balance_boundary_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  source_data_digest TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  conversion_formula_version TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (energy_balance_boundary_id) REFERENCES energy_balance_boundaries(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (length(trim(calculation_run_id)) BETWEEN 1 AND 64),
  CHECK (unixepoch(start_utc) < unixepoch(end_utc))
);`;

// 旧库补列后使用触发器恢复新库的非空与同运行一致性约束。
const ENERGY_BALANCE_RUN_BINDING_TRIGGERS_SQL = `CREATE TRIGGER IF NOT EXISTS trg_energy_balance_calculation_runs_immutable_update
BEFORE UPDATE ON energy_balance_calculation_runs
FOR EACH ROW WHEN NEW.calculation_run_id IS NOT OLD.calculation_run_id
  OR NEW.energy_balance_boundary_id IS NOT OLD.energy_balance_boundary_id
  OR NEW.start_utc IS NOT OLD.start_utc
  OR NEW.end_utc IS NOT OLD.end_utc
  OR NEW.source_timezone IS NOT OLD.source_timezone
  OR NEW.source_data_digest IS NOT OLD.source_data_digest
  OR NEW.formula_version IS NOT OLD.formula_version
  OR NEW.conversion_formula_version IS NOT OLD.conversion_formula_version
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'energy balance calculation run immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshots_run_insert
BEFORE INSERT ON energy_balance_snapshots
FOR EACH ROW WHEN NEW.calculation_run_id IS NULL OR trim(NEW.calculation_run_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot run required');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshots_run_update
BEFORE UPDATE OF calculation_run_id ON energy_balance_snapshots
FOR EACH ROW WHEN NEW.calculation_run_id IS NULL
  OR trim(NEW.calculation_run_id) = ''
  OR NEW.calculation_run_id <> OLD.calculation_run_id
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot run immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshots_metadata_insert
BEFORE INSERT ON energy_balance_snapshots
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM energy_balance_calculation_runs AS calculation_run
  WHERE calculation_run.calculation_run_id = NEW.calculation_run_id
    AND calculation_run.energy_balance_boundary_id = NEW.energy_balance_boundary_id
    AND calculation_run.start_utc = NEW.start_utc
    AND calculation_run.end_utc = NEW.end_utc
    AND calculation_run.source_timezone = NEW.source_timezone
    AND calculation_run.source_data_digest = NEW.source_data_digest
    AND calculation_run.formula_version = NEW.formula_version
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot run metadata mismatch');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshots_metadata_update
BEFORE UPDATE OF calculation_run_id, energy_balance_boundary_id, start_utc, end_utc, source_timezone, source_data_digest, formula_version ON energy_balance_snapshots
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM energy_balance_calculation_runs AS calculation_run
  WHERE calculation_run.calculation_run_id = NEW.calculation_run_id
    AND calculation_run.energy_balance_boundary_id = NEW.energy_balance_boundary_id
    AND calculation_run.start_utc = NEW.start_utc
    AND calculation_run.end_utc = NEW.end_utc
    AND calculation_run.source_timezone = NEW.source_timezone
    AND calculation_run.source_data_digest = NEW.source_data_digest
    AND calculation_run.formula_version = NEW.formula_version
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot run metadata mismatch');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshot_items_run_insert
BEFORE INSERT ON energy_balance_snapshot_items
FOR EACH ROW
WHEN NEW.calculation_run_id IS NULL OR NEW.calculation_run_id <> (
  SELECT calculation_run_id FROM energy_balance_snapshots WHERE id = NEW.energy_balance_snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot item run mismatch');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshot_items_run_update
BEFORE UPDATE OF calculation_run_id, energy_balance_snapshot_id ON energy_balance_snapshot_items
FOR EACH ROW
WHEN NEW.calculation_run_id IS NULL OR NEW.calculation_run_id <> (
  SELECT calculation_run_id FROM energy_balance_snapshots WHERE id = NEW.energy_balance_snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot item run mismatch');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshot_items_identity_insert
BEFORE INSERT ON energy_balance_snapshot_items
FOR EACH ROW WHEN NEW.item_code IS NULL OR trim(NEW.item_code) = ''
  OR NEW.item_name IS NULL OR trim(NEW.item_name) = ''
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot item identity required');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_snapshot_items_identity_update
BEFORE UPDATE OF item_code, item_name ON energy_balance_snapshot_items
FOR EACH ROW WHEN NEW.item_code IS NOT OLD.item_code OR NEW.item_name IS NOT OLD.item_name
BEGIN
  SELECT RAISE(ABORT, 'energy balance snapshot item identity immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_suggestions_run_insert
BEFORE INSERT ON energy_balance_suggestions
FOR EACH ROW
WHEN NEW.calculation_run_id IS NULL OR NEW.calculation_run_id <> (
  SELECT calculation_run_id FROM energy_balance_snapshots WHERE id = NEW.energy_balance_snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance suggestion run mismatch');
END;
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_suggestions_run_update
BEFORE UPDATE OF calculation_run_id, energy_balance_snapshot_id ON energy_balance_suggestions
FOR EACH ROW
WHEN NEW.calculation_run_id IS NULL OR NEW.calculation_run_id <> (
  SELECT calculation_run_id FROM energy_balance_snapshots WHERE id = NEW.energy_balance_snapshot_id
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance suggestion run mismatch');
END;`;

// 对标目标来源 INSERT 触发器作为旧库迁移后的规范定义。
const BENCHMARK_TARGET_SOURCE_INSERT_TRIGGER_SQL = `CREATE TRIGGER trg_benchmark_targets_source_insert
BEFORE INSERT ON benchmark_targets
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'benchmark target import source must contain batch and positive row together');
END;`;

// 对标目标来源 UPDATE 触发器作为旧库迁移后的规范定义。
const BENCHMARK_TARGET_SOURCE_UPDATE_TRIGGER_SQL = `CREATE TRIGGER trg_benchmark_targets_source_update
BEFORE UPDATE OF source_batch_id, source_row_number ON benchmark_targets
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'benchmark target import source must contain batch and positive row together');
END;`;

// 两个规范来源触发器在迁移事务中统一创建。
const BENCHMARK_TARGET_SOURCE_TRIGGERS_SQL = `${BENCHMARK_TARGET_SOURCE_INSERT_TRIGGER_SQL}\n\n${BENCHMARK_TARGET_SOURCE_UPDATE_TRIGGER_SQL}`;

// 平衡边界与项目来源触发器作为旧库 provenance 成对约束的规范定义。
const ENERGY_BALANCE_IMPORT_SOURCE_TRIGGERS_SQL = `CREATE TRIGGER trg_energy_balance_boundaries_source_insert
BEFORE INSERT ON energy_balance_boundaries
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance boundary import source must contain batch and positive row together');
END;

CREATE TRIGGER trg_energy_balance_boundaries_source_update
BEFORE UPDATE OF source_batch_id, source_row_number ON energy_balance_boundaries
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance boundary import source must contain batch and positive row together');
END;

CREATE TRIGGER trg_energy_balance_items_source_insert
BEFORE INSERT ON energy_balance_items
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance item import source must contain batch and positive row together');
END;

CREATE TRIGGER trg_energy_balance_items_source_update
BEFORE UPDATE OF source_batch_id, source_row_number ON energy_balance_items
FOR EACH ROW
WHEN NOT (
  (NEW.source_batch_id IS NULL AND NEW.source_row_number IS NULL)
  OR (
    NEW.source_batch_id IS NOT NULL
    AND NEW.source_row_number IS NOT NULL
    AND typeof(NEW.source_row_number) = 'integer'
    AND NEW.source_row_number >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'energy balance item import source must contain batch and positive row together');
END;

CREATE TRIGGER trg_energy_balance_import_batch_provenance_clear
BEFORE DELETE ON import_batches
BEGIN
  UPDATE energy_balance_boundaries
  SET source_batch_id = NULL, source_row_number = NULL
  WHERE source_batch_id = OLD.id;
  UPDATE energy_balance_items
  SET source_batch_id = NULL, source_row_number = NULL
  WHERE source_batch_id = OLD.id;
END;`;

// 平衡来源迁移只允许新增以下固定索引和触发器，其他 sqlite_master 对象必须保持 canonical。
const ENERGY_BALANCE_IMPORT_SOURCE_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: 'index', name: 'idx_energy_balance_boundaries_source', tableName: 'energy_balance_boundaries' }),
  Object.freeze({ type: 'index', name: 'idx_energy_balance_items_source', tableName: 'energy_balance_items' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_balance_boundaries_source_insert', tableName: 'energy_balance_boundaries' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_balance_boundaries_source_update', tableName: 'energy_balance_boundaries' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_balance_items_source_insert', tableName: 'energy_balance_items' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_balance_items_source_update', tableName: 'energy_balance_items' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_balance_import_batch_provenance_clear', tableName: 'import_batches' })
]);

// 已部署旧 canonical 可能同时缺少四个能流来源触发器，仅允许“全部缺少”或“全部 canonical”两种精确 profile。
const ENERGY_FLOW_IMPORT_SOURCE_TRIGGER_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: 'trigger', name: 'trg_energy_flow_edges_source_insert', tableName: 'energy_flow_edges' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_flow_edges_source_update', tableName: 'energy_flow_edges' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_flow_records_source_insert', tableName: 'energy_flow_records' }),
  Object.freeze({ type: 'trigger', name: 'trg_energy_flow_records_source_update', tableName: 'energy_flow_records' })
]);

// 对标定义迁移使用 canonical 临时表，保留历史文号和兼容版本但解除外部标准文号必填约束。
const BENCHMARK_DEFINITIONS_INTERNAL_REVISION_TABLE_SQL = `CREATE TABLE benchmark_definitions__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  benchmark_code TEXT NOT NULL,
  benchmark_name TEXT NOT NULL,
  benchmark_type TEXT NOT NULL CHECK (benchmark_type IN ('external_standard', 'manual_benchmark', 'internal_history_baseline')),
  metric_code TEXT NOT NULL,
  unit TEXT NOT NULL,
  period_type TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_reference TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lower_better', 'higher_better', 'range')),
  source TEXT NOT NULL,
  document_no TEXT,
  version TEXT NOT NULL,
  internal_revision INTEGER NOT NULL CHECK (
    typeof(internal_revision) = 'integer' AND internal_revision >= 1
  ),
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  UNIQUE (benchmark_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
);`;

// 内部修订唯一索引在新库和历史库使用同一稳定名称。
const BENCHMARK_INTERNAL_REVISION_INDEXES_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ux_benchmark_definitions_internal_revision
  ON benchmark_definitions(benchmark_code, internal_revision);
CREATE UNIQUE INDEX IF NOT EXISTS ux_benchmark_targets_internal_revision
  ON benchmark_targets(benchmark_definition_id, internal_revision);`;

// 严格 UTC ISO 时间戳格式与阶段 1 契约保持一致。
const STRICT_UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// IANA 来源时区必须包含区域与地点分段。
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)+$/;

// SHA-256 持久化摘要必须是 64 位小写十六进制。
const LOWERCASE_SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

// 严格日历日期采用 YYYY-MM-DD 格式。
const STRICT_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CARBON_EMISSIONS_TABLE_WITH_SUPERSEDED_SQL = `CREATE TABLE carbon_emissions__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  energy_record_id INTEGER NOT NULL,
  carbon_factor_id INTEGER,
  calculation_method TEXT NOT NULL DEFAULT 'standard-factor',
  calculation_basis TEXT NOT NULL DEFAULT 'normalized_value * factor_value',
  factor_value REAL CHECK (factor_value IS NULL OR factor_value > 0),
  activity_value REAL NOT NULL CHECK (activity_value >= 0),
  activity_unit TEXT NOT NULL,
  emission_value REAL CHECK (emission_value IS NULL OR emission_value >= 0),
  emission_unit TEXT NOT NULL DEFAULT 'kgCO2e',
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'factor_missing', 'invalid_record', 'superseded')),
  calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note TEXT,
  FOREIGN KEY (energy_record_id) REFERENCES energy_records(id) ON DELETE CASCADE,
  FOREIGN KEY (carbon_factor_id) REFERENCES carbon_factors(id) ON DELETE SET NULL,
  CHECK (status <> 'calculated' OR (carbon_factor_id IS NOT NULL AND factor_value IS NOT NULL AND emission_value IS NOT NULL))
)`;

const LEDGER_TABLES_SQL = `CREATE TABLE IF NOT EXISTS organization_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  unit_code TEXT NOT NULL UNIQUE,
  unit_name TEXT NOT NULL,
  unit_path TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('enterprise', 'department', 'workshop', 'process', 'equipment')),
  area REAL CHECK (area IS NULL OR area >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (parent_id) REFERENCES organization_units(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS meter_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_code TEXT NOT NULL UNIQUE,
  meter_name TEXT NOT NULL,
  meter_type TEXT NOT NULL DEFAULT 'other' CHECK (meter_type IN ('electricity', 'gas', 'heat', 'water', 'other')),
  energy_type_id INTEGER NOT NULL,
  organization_unit_id INTEGER NOT NULL,
  online_status TEXT NOT NULL DEFAULT 'unknown' CHECK (online_status IN ('online', 'offline', 'unknown')),
  gateway_id TEXT,
  multiplier REAL NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  allow_manual_reading INTEGER NOT NULL DEFAULT 1 CHECK (allow_manual_reading IN (0, 1)),
  flow_direction TEXT NOT NULL DEFAULT 'unknown' CHECK (flow_direction IN ('input', 'output', 'bidirectional', 'unknown')),
  install_location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS meter_reading_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  meter_device_id INTEGER NOT NULL,
  organization_unit_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  reading_date TEXT NOT NULL,
  normalized_month TEXT NOT NULL CHECK (
    normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  previous_value REAL NOT NULL CHECK (previous_value >= 0),
  current_value REAL NOT NULL CHECK (current_value >= 0),
  multiplier REAL NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  usage_value REAL NOT NULL CHECK (usage_value >= 0),
  original_unit TEXT NOT NULL,
  normalized_unit TEXT NOT NULL,
  normalized_usage_value REAL NOT NULL CHECK (normalized_usage_value >= 0),
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  remark TEXT,
  generated_energy_record_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (meter_device_id) REFERENCES meter_devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (generated_energy_record_id) REFERENCES energy_records(id) ON DELETE SET NULL,
  CHECK (current_value >= previous_value)
);`;

const ENERGY_BUDGETS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS energy_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  period_month TEXT NOT NULL CHECK (
    period_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(period_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  energy_type_id INTEGER NOT NULL,
  organization_scope TEXT NOT NULL DEFAULT '整体',
  budget_value REAL NOT NULL CHECK (budget_value >= 0),
  unit TEXT NOT NULL,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (period_month, energy_type_id, organization_scope)
);

CREATE INDEX IF NOT EXISTS idx_energy_budgets_month_type_status ON energy_budgets(period_month, energy_type_id, status);
CREATE INDEX IF NOT EXISTS idx_energy_budgets_scope_status ON energy_budgets(organization_scope, status);
CREATE INDEX IF NOT EXISTS idx_energy_budgets_batch ON energy_budgets(source_batch_id);`;

// 供应商基础台账建表和索引分离，便于旧库安全重建规范编码键。
const SUPPLIER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code TEXT NOT NULL,
  supplier_code_key TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  address TEXT,
  contact_person TEXT,
  contact_phone TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
);`;
const SUPPLIER_INDEXES_SQL = `CREATE INDEX IF NOT EXISTS idx_suppliers_status_name ON suppliers(status, supplier_name, id);
CREATE INDEX IF NOT EXISTS idx_suppliers_batch ON suppliers(source_batch_id);`;
const SUPPLIER_TABLES_SQL = `${SUPPLIER_TABLE_SQL}\n${SUPPLIER_INDEXES_SQL}`;

const PRODUCTION_TABLES_SQL = `CREATE TABLE IF NOT EXISTS production_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  unit_code TEXT NOT NULL UNIQUE,
  unit_name TEXT NOT NULL,
  organization_unit_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  output_unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS production_output_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  production_unit_id INTEGER NOT NULL,
  normalized_month TEXT NOT NULL CHECK (
    normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  output_value REAL NOT NULL CHECK (output_value > 0),
  output_unit TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (production_unit_id) REFERENCES production_units(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_production_units_org_status ON production_units(organization_unit_id, status);
CREATE INDEX IF NOT EXISTS idx_production_units_product_status ON production_units(product_name, status);
CREATE INDEX IF NOT EXISTS idx_production_units_batch ON production_units(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_production_output_records_unit_month ON production_output_records(production_unit_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_production_output_records_status_month ON production_output_records(record_status, normalized_month);
CREATE UNIQUE INDEX IF NOT EXISTS ux_production_output_records_active_unit_month ON production_output_records(production_unit_id, normalized_month) WHERE record_status = 'active';`;

const GENERATION_RECORDS_TABLE_WITH_UPLOAD_DATA_SOURCE_SQL = `CREATE TABLE generation_records__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  organization_unit_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  normalized_month TEXT NOT NULL CHECK (
    normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  generation_value_kwh REAL NOT NULL CHECK (generation_value_kwh >= 0),
  self_use_value_kwh REAL NOT NULL DEFAULT 0 CHECK (self_use_value_kwh >= 0),
  grid_export_value_kwh REAL NOT NULL DEFAULT 0 CHECK (grid_export_value_kwh >= 0),
  data_source TEXT NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  remark TEXT,
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  CHECK (self_use_value_kwh + grid_export_value_kwh <= generation_value_kwh + 0.000001)
)`;

function buildGenerationRecordsCopySql(existingColumns = []) {
  const sourceBatchExpression = existingColumns.includes('source_batch_id') ? 'source_batch_id' : 'NULL';
  const sourceRowExpression = existingColumns.includes('source_row_number') ? 'source_row_number' : 'NULL';
  return `INSERT INTO generation_records__migration_new (
  id,
  source_batch_id,
  source_row_number,
  organization_unit_id,
  energy_type_id,
  normalized_month,
  generation_value_kwh,
  self_use_value_kwh,
  grid_export_value_kwh,
  data_source,
  record_status,
  remark,
  void_reason,
  voided_at,
  created_at,
  updated_at
)
SELECT
  id,
  ${sourceBatchExpression} AS source_batch_id,
  ${sourceRowExpression} AS source_row_number,
  organization_unit_id,
  energy_type_id,
  normalized_month,
  generation_value_kwh,
  self_use_value_kwh,
  grid_export_value_kwh,
  CASE
    WHEN data_source IN ('manual', 'upload', 'calculation') THEN data_source
    ELSE 'manual'
  END AS data_source,
  record_status,
  remark,
  void_reason,
  voided_at,
  created_at,
  updated_at
FROM generation_records`;
}

const PREDICTION_CONFIGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS prediction_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  name TEXT NOT NULL,
  note TEXT,
  energy_type_id INTEGER,
  organization_unit_id INTEGER,
  meter_device_id INTEGER,
  source_batch_filter_id INTEGER,
  train_start_month TEXT NOT NULL,
  train_end_month TEXT NOT NULL,
  predict_start_month TEXT NOT NULL,
  predict_end_month TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('moving_average', 'linear_trend')),
  window_size INTEGER CHECK (window_size IS NULL OR window_size BETWEEN 2 AND 12),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT,
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  FOREIGN KEY (meter_device_id) REFERENCES meter_devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_prediction_configs_status_updated ON prediction_configs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_configs_energy_month ON prediction_configs(energy_type_id, predict_start_month, predict_end_month);
CREATE INDEX IF NOT EXISTS idx_prediction_configs_batch ON prediction_configs(source_batch_id);`;

const PREDICTION_RUNS_TABLE_WITH_MANAGEMENT_STATUSES_SQL = `CREATE TABLE prediction_runs__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('moving_average', 'linear_trend', 'year_over_year', 'manual_baseline')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'archived')),
  target_energy_type_id INTEGER,
  train_start_month TEXT,
  train_end_month TEXT,
  predict_start_month TEXT,
  predict_end_month TEXT,
  parameters_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  note TEXT,
  FOREIGN KEY (target_energy_type_id) REFERENCES energy_types(id) ON DELETE SET NULL
);`;

const IMPORT_BATCHES_TABLE_WITH_LEDGER_TYPES_SQL = `CREATE TABLE import_batches__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN (${IMPORT_BATCH_TYPES_SQL})),
  original_filename TEXT NOT NULL,
  stored_filename TEXT,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
  file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  audit_phase TEXT CHECK (audit_phase IS NULL OR audit_phase IN ('preview', 'execute')),
  preview_signature TEXT,
  preview_audit_digest TEXT,
  audit_context_json TEXT,
  execute_result_json TEXT,
  backup_json TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  duplicate_strategy TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_strategy = 'skip'),
  field_mapping_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  error_summary TEXT,
  CHECK (
    success_count + failure_count + skipped_count <= total_rows
    OR status IN ('pending', 'processing')
  )
)`;

const IMPORT_BATCHES_COPY_SQL = `INSERT INTO import_batches__migration_new (
  id,
  import_type,
  original_filename,
  stored_filename,
  file_type,
  file_size_bytes,
  file_sha256,
  status,
  audit_phase,
  preview_signature,
  preview_audit_digest,
  audit_context_json,
  execute_result_json,
  backup_json,
  total_rows,
  success_count,
  failure_count,
  skipped_count,
  duplicate_strategy,
  field_mapping_json,
  started_at,
  finished_at,
  created_at,
  updated_at,
  error_summary
)
SELECT
  id,
  COALESCE(import_type, 'energy_record') AS import_type,
  original_filename,
  stored_filename,
  file_type,
  file_size_bytes,
  file_sha256,
  status,
  audit_phase,
  preview_signature,
  preview_audit_digest,
  audit_context_json,
  execute_result_json,
  backup_json,
  total_rows,
  success_count,
  failure_count,
  skipped_count,
  duplicate_strategy,
  field_mapping_json,
  started_at,
  finished_at,
  created_at,
  updated_at,
  error_summary
FROM import_batches`;

const CARBON_EMISSIONS_COPY_SQL = `INSERT INTO carbon_emissions__migration_new (
  id,
  energy_record_id,
  carbon_factor_id,
  calculation_method,
  calculation_basis,
  factor_value,
  activity_value,
  activity_unit,
  emission_value,
  emission_unit,
  status,
  calculated_at,
  note
)
SELECT
  id,
  energy_record_id,
  carbon_factor_id,
  calculation_method,
  calculation_basis,
  factor_value,
  activity_value,
  activity_unit,
  emission_value,
  emission_unit,
  CASE
    WHEN status IN ('calculated', 'factor_missing', 'invalid_record', 'superseded') THEN status
    ELSE 'invalid_record'
  END AS status,
  calculated_at,
  note
FROM carbon_emissions`;

function ensureLocalDataDirectories() {
  [dataDir, uploadsDir, backupsDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
}

function loadDatabaseDriver() {
  return require('better-sqlite3');
}

/**
 * 判断值是否为严格 UTC ISO 时间戳。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isStrictUtcIso(value) {
  if (typeof value !== 'string' || !STRICT_UTC_ISO_PATTERN.test(value)) {
    return false;
  }

  const timeValue = Date.parse(value);
  if (!Number.isFinite(timeValue)) {
    return false;
  }

  const canonicalValue = new Date(timeValue).toISOString();
  return value.includes('.')
    ? canonicalValue === value
    : canonicalValue.replace('.000Z', 'Z') === value;
}

/**
 * 判断值是否为真实存在的严格日历日期。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isStrictIsoDate(value) {
  if (typeof value !== 'string' || !STRICT_ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const dateValue = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(dateValue)
    && new Date(dateValue).toISOString().slice(0, 10) === value;
}

/**
 * 判断值是否为可识别的 IANA 时区。
 * @param {*} value 待验证值。
 * @returns {boolean} 是否有效。
 */
function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || !IANA_TIME_ZONE_PATTERN.test(value)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch (_error) {
    return false;
  }
}

/** 判断 N8 稳定编码是否符合共享的显示值、ASCII 和规范键合同。 */
function isValidEnergyFlowCode(value) {
  const validation = validateAndNormalizeEnergyFlowIdentityCode(value);
  return validation.valid && validation.value === value;
}

/**
 * 判断 UTC 时间戳是否精确落在整分钟边界。
 * @param {*} value 待验证值。
 * @returns {boolean} 秒和毫秒是否均为零。
 */
function isUtcMinuteBoundary(value) {
  if (!isStrictUtcIso(value)) {
    return false;
  }

  return value.slice(17, 19) === '00'
    && (!value.includes('.') || value.slice(20, 23) === '000');
}

/**
 * 判断折标系数版本 JSON 是否只包含非空版本字符串。
 * @param {*} value 待验证 JSON 文本。
 * @returns {boolean} 是否为有效的非空数组或对象。
 */
function isLowercaseSha256Hex(value) {
  return typeof value === 'string' && LOWERCASE_SHA256_HEX_PATTERN.test(value);
}

/**
 * 为迁移中不可信摘要生成不可逆的 canonical 安全替代值。
 * @param {...unknown} identityParts 稳定身份片段。
 * @returns {string} 64 位小写十六进制摘要。
 */
function createMigrationSafetyDigest(...identityParts) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(identityParts))
    .digest('hex');
}

function isValidFactorVersionsJson(value) {
  if (typeof value !== 'string') {
    return false;
  }

  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch (_error) {
    return false;
  }

  if (Array.isArray(parsedValue)) {
    return parsedValue.length > 0
      && parsedValue.every((version) => typeof version === 'string' && version.trim() !== '');
  }

  if (parsedValue === null || typeof parsedValue !== 'object') {
    return false;
  }

  const factorEntries = Object.entries(parsedValue);
  return factorEntries.length > 0
    && factorEntries.every(([factorCode, version]) => (
      factorCode.trim() !== ''
      && typeof version === 'string'
      && version.trim() !== ''
    ));
}

/**
 * 为数据库连接注册能源分析 CHECK 约束使用的确定性函数。
 * @param {object} db SQLite 数据库连接。
 */
function registerEnergyAnalysisSqliteFunctions(db) {
  db.function('is_strict_utc_iso', { deterministic: true }, (value) => (
    isStrictUtcIso(value) ? 1 : 0
  ));
  db.function('is_strict_iso_date', { deterministic: true }, (value) => (
    isStrictIsoDate(value) ? 1 : 0
  ));
  db.function('is_valid_iana_timezone', { deterministic: true }, (value) => (
    isValidIanaTimezone(value) ? 1 : 0
  ));
  db.function('normalize_energy_flow_key', { deterministic: true }, normalizeEnergyFlowKey);
  db.function('is_energy_flow_utc_second', { deterministic: true }, (value) => (
    isEnergyFlowUtcSecond(value) ? 1 : 0
  ));
  db.function(
    'normalize_energy_flow_utc_second',
    { deterministic: true },
    normalizeEnergyFlowUtcSecond
  );
  db.function('is_valid_energy_flow_code', { deterministic: true }, (value) => (
    isValidEnergyFlowCode(value) ? 1 : 0
  ));
  db.function('is_utc_minute_boundary', { deterministic: true }, (value) => (
    isUtcMinuteBoundary(value) ? 1 : 0
  ));
  db.function('is_strict_wall_clock_minute', { deterministic: true }, (value) => (
    isStrictWallClockMinute(value) ? 1 : 0
  ));
  db.function('is_valid_factor_versions_json', { deterministic: true }, (value) => (
    isValidFactorVersionsJson(value) ? 1 : 0
  ));
}

function openDatabase(options = {}) {
  ensureLocalDataDirectories();
  const targetDatabasePath = options.databasePath ? path.resolve(options.databasePath) : databasePath;
  const isOfficialDatabase = path.resolve(targetDatabasePath) === path.resolve(databasePath);
  if (isOfficialDatabase && databasePoisoned) {
    throw createDatabasePoisonedError();
  }
  if (isOfficialDatabase && databaseAdmissionBlocked && options.admissionPermit !== databaseAdmissionPermit) {
    throw createDatabaseAdmissionBlockedError();
  }
  const Database = loadDatabaseDriver();
  const db = new Database(targetDatabasePath);
  registerEnergyAnalysisSqliteFunctions(db);
  db.pragma('foreign_keys = ON');
  if (isOfficialDatabase) {
    activeOfficialDatabaseConnections += 1;
    const originalClose = db.close.bind(db);
    let closed = false;
    db.close = () => {
      if (closed) return undefined;
      const closeResult = originalClose();
      closed = true;
      activeOfficialDatabaseConnections = Math.max(0, activeOfficialDatabaseConnections - 1);
      return closeResult;
    };
  }
  return db;
}

/**
 * 以严格只读方式打开既有 SQLite，不创建 data/uploads/backups，不切换 journal_mode。
 * @param {object} options 只读数据库路径选项。
 * @returns {object} 已注册项目 SQLite 函数的只读连接。
 */
function openReadOnlyDatabase(options = {}) {
  if (!options.databasePath) {
    throw new TypeError('只读数据库打开必须提供明确 databasePath。');
  }
  const targetDatabasePath = path.resolve(options.databasePath);
  const Database = loadDatabaseDriver();
  const db = new Database(targetDatabasePath, { readonly: true, fileMustExist: true });
  registerEnergyAnalysisSqliteFunctions(db);
  db.pragma('foreign_keys = ON');
  return db;
}

/** 阻止正式数据库新连接进入切换窗口，并返回仅限本次屏障内部使用的 permit。 */
function blockDatabaseAdmission() {
  if (databasePoisoned) throw createDatabasePoisonedError();
  if (databaseAdmissionBlocked) throw createDatabaseAdmissionBlockedError();
  databaseAdmissionPermit = Object.freeze({ createdAt: Date.now() });
  databaseAdmissionBlocked = true;
  return databaseAdmissionPermit;
}

/** 正常完成或安全回滚后重新允许正式数据库连接。 */
function unblockDatabaseAdmission(admissionPermit) {
  if (databasePoisoned) return;
  if (databaseAdmissionBlocked && admissionPermit !== databaseAdmissionPermit) {
    throw new Error('正式数据库切换 permit 不匹配。');
  }
  databaseAdmissionBlocked = false;
  databaseAdmissionPermit = null;
}

/** 原子替换回滚失败时永久锁定本进程数据库访问。 */
function poisonDatabaseAdmission() {
  databasePoisoned = true;
  databaseAdmissionBlocked = true;
}

/** 返回正式数据库连接屏障状态，供恢复服务执行归零校验。 */
function getDatabaseAdmissionState() {
  return {
    blocked: databaseAdmissionBlocked,
    poisoned: databasePoisoned,
    activeConnections: activeOfficialDatabaseConnections
  };
}

/** 将非法或不可恢复 marker 状态持久锁定在当前进程。 */
function poisonPendingDatabaseRestore(_message) {
  databasePoisoned = true;
  databaseAdmissionBlocked = true;
  throw createDatabasePoisonedError();
}

/** 在任何文件操作前严格验证 durable restore marker 和同目录文件身份。 */
function parsePendingDatabaseRestoreMarker(markerPath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_error) {
    return null;
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || marker.schema !== DATABASE_RESTORE_MARKER_SCHEMA
    || marker.version !== DATABASE_RESTORE_MARKER_VERSION
    || marker.phase !== DATABASE_RESTORE_MARKER_PHASE
    || typeof marker.operationId !== 'string'
    || !DATABASE_RESTORE_OPERATION_ID_PATTERN.test(marker.operationId)) {
    return null;
  }
  const expectedCandidateName = `.restore-candidate-${marker.operationId}.sqlite`;
  const expectedOldName = `.restore-old-${marker.operationId}.sqlite`;
  if (marker.candidate !== expectedCandidateName || marker.old !== expectedOldName
    || marker.candidate === marker.old
    || path.basename(marker.candidate) !== marker.candidate
    || path.basename(marker.old) !== marker.old) {
    return null;
  }
  const databaseDirectory = path.resolve(path.dirname(databasePath));
  const officialPath = path.resolve(databasePath);
  const resolvedMarkerPath = path.resolve(markerPath);
  const candidatePath = path.resolve(databaseDirectory, marker.candidate);
  const oldPath = path.resolve(databaseDirectory, marker.old);
  const paths = [candidatePath, oldPath];
  if (paths.some((filePath) => path.dirname(filePath) !== databaseDirectory
    || filePath === officialPath
    || filePath === resolvedMarkerPath)
    || candidatePath === oldPath) {
    return null;
  }
  return { candidatePath, oldPath };
}

/** 启动时处理同目录 durable restore marker，禁止 official 缺失时创建空库。 */
function reconcilePendingDatabaseRestore() {
  const markerPath = path.join(path.dirname(databasePath), DATABASE_RESTORE_MARKER_NAME);
  if (!fs.existsSync(markerPath)) return;
  const restorePaths = parsePendingDatabaseRestoreMarker(markerPath);
  if (!restorePaths) {
    poisonPendingDatabaseRestore('检测到非法数据库切换标记，正式数据库已安全锁定。');
  }
  const { candidatePath, oldPath } = restorePaths;
  try {
    if (!fs.existsSync(databasePath) && fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, databasePath);
      fs.rmSync(candidatePath, { force: true });
      fs.rmSync(markerPath, { force: true });
      return;
    }
    if (fs.existsSync(databasePath)) {
      fs.rmSync(oldPath, { force: true });
      fs.rmSync(candidatePath, { force: true });
      fs.rmSync(markerPath, { force: true });
      return;
    }
  } catch (_error) {
    poisonPendingDatabaseRestore('检测到无法恢复的数据库切换标记，正式数据库已安全锁定。');
  }
  poisonPendingDatabaseRestore('数据库切换标记缺少可恢复文件，正式数据库已安全锁定。');
}

/**
 * 从完整 schema 中提取能源分析独立建表片段。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {string} 能源分析建表和索引 SQL。
 */
function extractEnergyAnalysisSchemaSql(schemaText) {
  const startIndex = schemaText.indexOf(ENERGY_ANALYSIS_SCHEMA_START_MARKER);
  const endIndex = schemaText.indexOf(ENERGY_ANALYSIS_SCHEMA_END_MARKER);
  const hasDuplicateMarker = startIndex !== schemaText.lastIndexOf(ENERGY_ANALYSIS_SCHEMA_START_MARKER)
    || endIndex !== schemaText.lastIndexOf(ENERGY_ANALYSIS_SCHEMA_END_MARKER);
  if (startIndex < 0 || endIndex <= startIndex || hasDuplicateMarker) {
    throw new Error('能源分析 schema 迁移片段标记缺失、重复或顺序错误。');
  }
  return schemaText.slice(startIndex + ENERGY_ANALYSIS_SCHEMA_START_MARKER.length, endIndex).trim();
}

/** 返回指定 N8 表挂载的全部触发器名称，顺序固定用于 canonical 校验。 */
function getEnergyFlowTableTriggers(db, tableName) {
  if (!ENERGY_FLOW_TABLES.includes(tableName)) return [];
  return db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(tableName)
    .map((row) => row.name);
}

/** 返回指定表由 CREATE INDEX 显式建立的索引名称，忽略 SQLite 自动唯一索引。 */
function getEnergyFlowExplicitIndexNames(db, tableName) {
  if (!getTableCreateSql(db, tableName)) return [];
  return db.prepare(`PRAGMA index_list(${quoteSqlIdentifier(tableName)})`).all()
    .filter((index) => index.origin === 'c')
    .map((index) => index.name)
    .sort();
}

/** 判断 N8 表的 CREATE、列属性、外键、CHECK、UNIQUE、显式索引和触发器是否完整 canonical。 */
function energyFlowTableIsCanonical(db, tableName, energyAnalysisSql = null, options = {}) {
  if (!ENERGY_FLOW_TABLES.includes(tableName)) return false;
  const createTableSql = getTableCreateSql(db, tableName);
  if (!createTableSql) return false;
  const canonicalSql = energyAnalysisSql || extractEnergyAnalysisSchemaSql(fs.readFileSync(schemaPath, 'utf8'));
  const expectedTableSql = extractNamedCreateStatement(canonicalSql, 'table', tableName);
  if (!expectedTableSql
    || normalizeCanonicalCreateFingerprint(createTableSql) !== normalizeCanonicalCreateFingerprint(expectedTableSql)) {
    return false;
  }

  const triggerNames = getEnergyFlowTableTriggers(db, tableName);
  const expectedTriggerNames = [...(ENERGY_FLOW_EXPECTED_TRIGGERS[tableName] || [])].sort();
  const triggerNamesMatch = JSON.stringify(triggerNames) === JSON.stringify(expectedTriggerNames);
  const mayUpgradeMissingOrWeakSourceTriggers = options.allowImportSourceTriggerUpgrade === true
    && expectedTriggerNames.length > 0
    && (triggerNames.length === 0 || triggerNamesMatch);
  if (!triggerNamesMatch && !mayUpgradeMissingOrWeakSourceTriggers) return false;
  if (triggerNamesMatch && options.allowImportSourceTriggerUpgrade !== true) {
    const expectedStatements = ENERGY_FLOW_IMPORT_SOURCE_TRIGGERS_SQL.match(/CREATE TRIGGER[\s\S]*?END;/g) || [];
    const expectedTriggerSql = new Map(expectedStatements.map((sql) => [
      sql.match(/^CREATE TRIGGER(?: IF NOT EXISTS)?\s+(\S+)/i)?.[1],
      sql
    ]));
    const triggersCanonical = expectedTriggerNames.every((triggerName) => {
      const actualSql = db.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = ? AND tbl_name = ?`).get(triggerName, tableName)?.sql;
      return normalizeTriggerSql(actualSql) === normalizeTriggerSql(expectedTriggerSql.get(triggerName));
    });
    if (!triggersCanonical) return false;
  }

  const expectedIndexNames = [...ENERGY_FLOW_TABLE_INDEXES[tableName]].sort();
  if (JSON.stringify(getEnergyFlowExplicitIndexNames(db, tableName)) !== JSON.stringify(expectedIndexNames)) return false;
  return expectedIndexNames.every((indexName) => {
    const actualIndexSql = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = ? AND tbl_name = ?`).get(indexName, tableName)?.sql;
    const expectedIndexSql = extractNamedCreateStatement(canonicalSql, 'index', indexName);
    return Boolean(actualIndexSql && expectedIndexSql)
      && normalizeCanonicalCreateFingerprint(actualIndexSql) === normalizeCanonicalCreateFingerprint(expectedIndexSql);
  });
}

/** 返回指定精确 v1 profile 的预期建表 SQL；无 provenance profile 只移除已授权的固定片段。 */
function getEnergyFlowLegacyV1ExpectedTableSql(tableName, profile) {
  const expectedTableSql = extractNamedCreateStatement(ENERGY_FLOW_LEGACY_V1_SCHEMA_SQL, 'table', tableName);
  if (!expectedTableSql || profile.edgeRecordProvenance || !['energy_flow_edges', 'energy_flow_records'].includes(tableName)) {
    return expectedTableSql;
  }
  const provenanceColumnsSql = `  source_batch_id INTEGER,\n  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),\n`;
  const provenanceForeignKeySql = '  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,\n';
  const withoutColumns = expectedTableSql.replace(provenanceColumnsSql, '');
  const withoutForeignKey = withoutColumns.replace(provenanceForeignKeySql, '');
  if (withoutForeignKey === expectedTableSql
    || withoutForeignKey.includes('source_batch_id')
    || withoutForeignKey.includes('source_row_number')) {
    throw new Error(`energy-flow 精确 v1 profile 生成失败：${tableName}`);
  }
  return withoutForeignKey;
}

/** 判断当前四张旧表是否精确匹配指定 energy-flow v1 profile。 */
function energyFlowLegacyV1ProfileIsCanonical(db, profile) {
  return ENERGY_FLOW_LEGACY_V1_TABLES.every((tableName) => {
    const actualTableSql = getTableCreateSql(db, tableName);
    const expectedTableSql = getEnergyFlowLegacyV1ExpectedTableSql(tableName, profile);
    if (!actualTableSql || !expectedTableSql
      || normalizeCanonicalCreateFingerprint(actualTableSql) !== normalizeCanonicalCreateFingerprint(expectedTableSql)) {
      return false;
    }
    if (JSON.stringify(getTableColumns(db, tableName)) !== JSON.stringify(profile.columns[tableName])) {
      return false;
    }
    if (getEnergyFlowTableTriggers(db, tableName).length > 0) return false;
    const expectedIndexNames = [...profile.indexes[tableName]].sort();
    if (JSON.stringify(getEnergyFlowExplicitIndexNames(db, tableName)) !== JSON.stringify(expectedIndexNames)) return false;
    return expectedIndexNames.every((indexName) => {
      const actualIndexSql = db.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = ? AND tbl_name = ?`).get(indexName, tableName)?.sql;
      const expectedIndexSql = extractNamedCreateStatement(ENERGY_FLOW_LEGACY_V1_SCHEMA_SQL, 'index', indexName);
      return Boolean(actualIndexSql && expectedIndexSql)
        && normalizeCanonicalCreateFingerprint(actualIndexSql) === normalizeCanonicalCreateFingerprint(expectedIndexSql);
    });
  }) && ENERGY_FLOW_TABLES
    .filter((tableName) => !ENERGY_FLOW_LEGACY_V1_TABLES.includes(tableName))
    .every((tableName) => !getTableCreateSql(db, tableName)
      || Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteSqlIdentifier(tableName)}`).get().total) === 0);
}

/** 返回当前数据库唯一匹配的精确已知 energy-flow v1 profile。 */
function getEnergyFlowLegacyV1Profile(db) {
  return ENERGY_FLOW_LEGACY_V1_PROFILES.find((profile) => energyFlowLegacyV1ProfileIsCanonical(db, profile)) || null;
}

/** 返回 N8 九表作为子表或父表时涉及的全部全库外键违规。 */
function getEnergyFlowForeignKeyViolations(db) {
  return db.prepare('PRAGMA foreign_key_check').all()
    .filter((violation) => (
      ENERGY_FLOW_TABLES.includes(violation.table)
      || ENERGY_FLOW_TABLES.includes(violation.parent)
    ))
    .map((violation) => ({
      childTable: violation.table,
      rowId: violation.rowid,
      parentTable: violation.parent,
      foreignKeyId: violation.fkid
    }));
}

/** 创建不含本机路径、SQL 或原生驱动信息的稳定 N8 迁移错误。 */
function createEnergyFlowMigrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

// v1 迁移摘要只允许下列业务时间发生 `.000Z` 到 `Z` 的无损规范化。
const ENERGY_FLOW_LEGACY_UTC_SECOND_COLUMNS = Object.freeze({
  energy_flow_models: Object.freeze(['effective_start_utc', 'effective_end_utc']),
  energy_flow_records: Object.freeze(['start_utc', 'end_utc', 'voided_at'])
});

/**
 * 为 N8 v1 迁移摘要规范允许等价的零毫秒业务时间，其余字段逐值保留。
 * @param {string} tableName 历史表名。
 * @param {object[]} rows 历史行。
 * @returns {object[]} 摘要行。
 */
function normalizeEnergyFlowLegacySnapshotRows(tableName, rows) {
  const utcColumns = ENERGY_FLOW_LEGACY_UTC_SECOND_COLUMNS[tableName] || [];
  if (utcColumns.length === 0) {
    return rows;
  }
  return rows.map((row) => {
    const normalizedRow = { ...row };
    utcColumns.forEach((columnName) => {
      if (normalizedRow[columnName] !== null && normalizedRow[columnName] !== undefined) {
        normalizedRow[columnName] = normalizeEnergyFlowUtcSecond(normalizedRow[columnName]);
      }
    });
    return normalizedRow;
  });
}

/** 读取表的稳定历史快照摘要，用于迁移前后核对主键、行数和全部 v1 值。 */
function buildEnergyFlowLegacySnapshot(db, tableName, columns = ENERGY_FLOW_LEGACY_V1_COLUMNS[tableName]) {
  const rows = db.prepare(`SELECT ${columns.map(quoteSqlIdentifier).join(', ')}
    FROM ${quoteSqlIdentifier(tableName)} ORDER BY id`).all();
  const snapshotRows = normalizeEnergyFlowLegacySnapshotRows(tableName, rows);
  return {
    rowCount: rows.length,
    primaryKeys: rows.map((row) => row.id),
    digest: crypto.createHash('sha256').update(JSON.stringify(snapshotRows)).digest('hex')
  };
}

/** 在复制前验证 v1 稳定键和新 canonical 上限，冲突时拒绝自动修补或猜测。 */
function assertEnergyFlowLegacyDataCanMigrate(db, profile) {
  const edgeSourceRowValidation = profile.edgeRecordProvenance
    ? " OR (source_row_number IS NOT NULL AND (typeof(source_row_number) <> 'integer' OR source_row_number < 1))"
    : '';
  const recordSourceRowValidation = profile.edgeRecordProvenance
    ? " OR (source_row_number IS NOT NULL AND (typeof(source_row_number) <> 'integer' OR source_row_number < 1))"
    : '';
  const invalidCounts = {
    models: Number(db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_models
      WHERE is_valid_energy_flow_code(model_code) <> 1
        OR length(trim(model_name)) NOT BETWEEN 1 AND 300
        OR length(trim(source)) NOT BETWEEN 1 AND 1000
        OR (document_no IS NOT NULL AND length(trim(document_no)) NOT BETWEEN 1 AND 300)
        OR length(trim(version)) NOT BETWEEN 1 AND 64
        OR normalize_energy_flow_utc_second(effective_start_utc) IS NULL
        OR normalize_energy_flow_utc_second(effective_end_utc) IS NULL
        OR length(trim(source_timezone)) NOT BETWEEN 1 AND 100`).get().total),
    nodes: Number(db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_nodes
      WHERE is_valid_energy_flow_code(node_code) <> 1
        OR length(trim(node_name)) NOT BETWEEN 1 AND 300
        OR abs(x) > 1000000000 OR abs(y) > 1000000000
        OR (source_row_number IS NOT NULL AND (typeof(source_row_number) <> 'integer' OR source_row_number < 1))`).get().total),
    edges: Number(db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_edges
      WHERE is_valid_energy_flow_code(edge_code) <> 1
        OR length(trim(unit)) NOT BETWEEN 1 AND 100${edgeSourceRowValidation}`).get().total),
    records: Number(db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_records
      WHERE length(trim(original_unit)) NOT BETWEEN 1 AND 100
        OR abs(original_value) > 1000000000000000
        OR normalize_energy_flow_utc_second(start_utc) IS NULL
        OR normalize_energy_flow_utc_second(end_utc) IS NULL
        OR (voided_at IS NOT NULL AND normalize_energy_flow_utc_second(voided_at) IS NULL)
        OR length(trim(source_timezone)) NOT BETWEEN 1 AND 100${recordSourceRowValidation}`).get().total)
  };
  const normalizedCollisions = {
    models: Number(db.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT normalize_energy_flow_key(model_code), normalize_energy_flow_key(version)
      FROM energy_flow_models GROUP BY 1, 2 HAVING COUNT(*) > 1
    )`).get().total),
    nodes: Number(db.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT energy_flow_model_id, normalize_energy_flow_key(node_code)
      FROM energy_flow_nodes GROUP BY 1, 2 HAVING COUNT(*) > 1
    )`).get().total),
    edges: Number(db.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT energy_flow_model_id, normalize_energy_flow_key(edge_code)
      FROM energy_flow_edges GROUP BY 1, 2 HAVING COUNT(*) > 1
    )`).get().total)
  };
  if (Object.values(invalidCounts).some((count) => count > 0)
    || Object.values(normalizedCollisions).some((count) => count > 0)) {
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_LEGACY_CONFLICT',
      '能流 v1 历史数据与 canonical v2 稳定约束冲突，拒绝自动修补。',
      { invalidCounts, normalizedCollisions }
    );
  }
}

/** 按外键依赖逆序删除 N8 九表；空骨架和迁移临时重建均使用同一顺序。 */
function dropEnergyFlowTables(db) {
  [
    'energy_flow_loss_evidence',
    'energy_flow_loss_facts',
    'energy_flow_waste_heat_facts',
    'energy_flow_records',
    'energy_flow_edges',
    'energy_flow_nodes',
    'energy_flow_paths',
    'energy_flow_assets',
    'energy_flow_models'
  ].forEach((tableName) => db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`));
}

/** 将已知 v1 四表机械复制到 canonical v2，不推断路径、阶段、资产、记录编码或能源类型。 */
function migrateEnergyFlowLegacyV1Tables(db, energyAnalysisSql, profile) {
  assertEnergyFlowLegacyDataCanMigrate(db, profile);
  const beforeSnapshots = Object.fromEntries(ENERGY_FLOW_LEGACY_V1_TABLES.map((tableName) => (
    [tableName, buildEnergyFlowLegacySnapshot(db, tableName, profile.columns[tableName])]
  )));

  ENERGY_FLOW_LEGACY_V1_TABLES.forEach((tableName) => {
    db.exec(`DROP TABLE IF EXISTS temp.${quoteSqlIdentifier(`${tableName}__n8_v1`)};
      CREATE TEMP TABLE ${quoteSqlIdentifier(`${tableName}__n8_v1`)} AS
      SELECT * FROM main.${quoteSqlIdentifier(tableName)} ORDER BY id;`);
  });
  dropEnergyFlowTables(db);
  db.exec(energyAnalysisSql);

  const edgeSourceProjection = profile.edgeRecordProvenance
    ? 'source_batch_id, source_row_number'
    : 'NULL, NULL';
  const recordSourceProjection = profile.edgeRecordProvenance
    ? 'source_batch_id, source_row_number'
    : 'NULL, NULL';
  db.exec(`INSERT INTO energy_flow_models (
      id, source_batch_id, source_row_number, model_code, model_name, source, document_no, version,
      effective_start_wall_clock, effective_end_wall_clock, effective_start_utc, effective_end_utc,
      source_timezone, classification_status, source_mode, status, created_at, updated_at
    )
    SELECT id, NULL, NULL, model_code, model_name, source, document_no, version,
      NULL, NULL, normalize_energy_flow_utc_second(effective_start_utc),
      normalize_energy_flow_utc_second(effective_end_utc), source_timezone,
      'legacy_unclassified', 'legacy_explicit_sources', status, created_at, updated_at
    FROM temp.energy_flow_models__n8_v1 ORDER BY id;
    INSERT INTO energy_flow_nodes (
      id, source_batch_id, source_row_number, energy_flow_model_id, energy_flow_asset_id,
      node_code, node_name, node_type, stage_code, organization_unit_id, x, y,
      status, created_at, updated_at
    )
    SELECT id, source_batch_id, source_row_number, energy_flow_model_id, NULL,
      node_code, node_name, node_type, NULL, organization_unit_id, x, y,
      status, created_at, updated_at
    FROM temp.energy_flow_nodes__n8_v1 ORDER BY id;
    INSERT INTO energy_flow_edges (
      id, source_batch_id, source_row_number, energy_flow_model_id, energy_flow_path_id,
      path_sequence, edge_code, from_node_id, to_node_id, energy_type_id, unit,
      source_type, source_reference, source_mapping_json, status, created_at, updated_at
    )
    SELECT id, ${edgeSourceProjection}, energy_flow_model_id, NULL,
      NULL, edge_code, from_node_id, to_node_id, energy_type_id, unit,
      source_type, NULL, source_mapping_json, status, created_at, updated_at
    FROM temp.energy_flow_edges__n8_v1 ORDER BY id;
    INSERT INTO energy_flow_records (
      id, source_batch_id, source_row_number, energy_flow_model_id, record_code, record_role,
      energy_flow_edge_id, energy_flow_node_id, energy_flow_path_id, energy_flow_asset_id,
      stage_code, energy_type_id, start_wall_clock, end_wall_clock, start_utc, end_utc,
      source_timezone, original_unit, original_value, source_type, source_reference,
      source_mapping_json, formula_version, record_status, void_reason, voided_at,
      created_at, updated_at
    )
    SELECT id, ${recordSourceProjection}, energy_flow_model_id, NULL, NULL,
      energy_flow_edge_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      normalize_energy_flow_utc_second(start_utc), normalize_energy_flow_utc_second(end_utc),
      source_timezone, original_unit, original_value, source_type, NULL,
      source_mapping_json, formula_version, record_status, void_reason,
      CASE WHEN voided_at IS NULL THEN NULL ELSE normalize_energy_flow_utc_second(voided_at) END,
      created_at, updated_at
    FROM temp.energy_flow_records__n8_v1 ORDER BY id;`);

  const afterSnapshots = Object.fromEntries(ENERGY_FLOW_LEGACY_V1_TABLES.map((tableName) => (
    [tableName, buildEnergyFlowLegacySnapshot(db, tableName, profile.columns[tableName])]
  )));
  const snapshotMismatch = ENERGY_FLOW_LEGACY_V1_TABLES.some((tableName) => (
    JSON.stringify(beforeSnapshots[tableName]) !== JSON.stringify(afterSnapshots[tableName])
  ));
  const legacyClassificationCount = Number(db.prepare(`SELECT COUNT(*) AS total FROM energy_flow_models
    WHERE classification_status <> 'legacy_unclassified' OR source_mode <> 'legacy_explicit_sources'
      OR source_batch_id IS NOT NULL OR source_row_number IS NOT NULL
      OR effective_start_wall_clock IS NOT NULL OR effective_end_wall_clock IS NOT NULL`).get().total);
  const inferredFieldCount = Number(db.prepare(`SELECT
      (SELECT COUNT(*) FROM energy_flow_nodes WHERE energy_flow_asset_id IS NOT NULL OR stage_code IS NOT NULL)
      + (SELECT COUNT(*) FROM energy_flow_edges WHERE energy_flow_path_id IS NOT NULL OR path_sequence IS NOT NULL OR source_reference IS NOT NULL)
      + (SELECT COUNT(*) FROM energy_flow_records WHERE record_code IS NOT NULL OR record_role IS NOT NULL
          OR energy_flow_node_id IS NOT NULL OR energy_flow_path_id IS NOT NULL OR energy_flow_asset_id IS NOT NULL
          OR stage_code IS NOT NULL OR energy_type_id IS NOT NULL OR start_wall_clock IS NOT NULL
          OR end_wall_clock IS NOT NULL OR source_reference IS NOT NULL) AS total`).get().total);
  const unexpectedInstalledProvenanceCount = profile.edgeRecordProvenance
    ? 0
    : Number(db.prepare(`SELECT
        (SELECT COUNT(*) FROM energy_flow_edges WHERE source_batch_id IS NOT NULL OR source_row_number IS NOT NULL)
        + (SELECT COUNT(*) FROM energy_flow_records WHERE source_batch_id IS NOT NULL OR source_row_number IS NOT NULL) AS total`).get().total);
  if (snapshotMismatch || legacyClassificationCount > 0 || inferredFieldCount > 0
    || unexpectedInstalledProvenanceCount > 0) {
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_MIGRATION_VALIDATION_FAILED',
      '能流 v1 迁移后的历史值或 legacy 边界校验失败。'
    );
  }
  ENERGY_FLOW_LEGACY_V1_TABLES.forEach((tableName) => {
    db.exec(`DROP TABLE temp.${quoteSqlIdentifier(`${tableName}__n8_v1`)}`);
  });
  return true;
}

/** 校验既有能流边或显式边值来源没有违反成对可空与正整数约束。 */
function validateEnergyFlowImportSources(db, tableName) {
  const violation = db.prepare(`SELECT id, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM ${quoteSqlIdentifier(tableName)}
    WHERE NOT (
      (source_batch_id IS NULL AND source_row_number IS NULL)
      OR (
        source_batch_id IS NOT NULL
        AND source_row_number IS NOT NULL
        AND typeof(source_row_number) = 'integer'
        AND source_row_number >= 1
      )
    )
    LIMIT 1`).get();
  if (violation) {
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_IMPORT_SOURCE_INVALID',
      `${tableName} 存在不符合 provenance 成对约束的历史记录。`,
      violation
    );
  }
}

/** 校验能流导入来源外键固定指向 import_batches(id) 且禁止删除来源批次。 */
function energyFlowImportSourceForeignKeyIsCanonical(db, tableName) {
  return db.prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(tableName)})`).all()
    .some((foreignKey) => (
      foreignKey.from === 'source_batch_id'
      && foreignKey.table === 'import_batches'
      && foreignKey.to === 'id'
      && String(foreignKey.on_delete || '').toUpperCase() === 'RESTRICT'
    ));
}

/** 严格安装能流来源触发器，同名弱触发器会在数据预检后被规范定义替换。 */
function ensureEnergyFlowImportSourceTriggers(db) {
  const expectedStatements = ENERGY_FLOW_IMPORT_SOURCE_TRIGGERS_SQL.match(/CREATE TRIGGER[\s\S]*?END;/g) || [];
  const expectedByName = new Map(expectedStatements.map((sql) => [
    sql.match(/^CREATE TRIGGER(?: IF NOT EXISTS)?\s+(\S+)/i)?.[1],
    sql
  ]));
  const triggerNames = [...expectedByName.keys()];
  const actualByName = new Map(db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${triggerNames.map(() => '?').join(', ')})`).all(...triggerNames)
    .map((row) => [row.name, row.sql]));
  const isCanonical = triggerNames.length === 4 && triggerNames.every((triggerName) => (
    normalizeTriggerSql(actualByName.get(triggerName)) === normalizeTriggerSql(expectedByName.get(triggerName))
  ));
  if (isCanonical) return false;
  triggerNames.forEach((triggerName) => db.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(triggerName)}`));
  db.exec(ENERGY_FLOW_IMPORT_SOURCE_TRIGGERS_SQL);
  return true;
}

/** 为旧 canonical 能流表幂等补充 provenance 成对约束，并在安装后复核外键。 */
function migrateEnergyFlowImportSources(db) {
  const tableNames = ['energy_flow_edges', 'energy_flow_records'];
  const existingTables = tableNames.filter((tableName) => Boolean(getTableCreateSql(db, tableName)));
  if (existingTables.length === 0) return false;
  if (existingTables.length !== tableNames.length || !getTableCreateSql(db, 'import_batches')) {
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_IMPORT_SOURCE_SCHEMA_INCOMPLETE',
      '能流来源迁移要求 import_batches、energy_flow_edges 和 energy_flow_records 同时存在。'
    );
  }
  tableNames.forEach((tableName) => {
    const columns = getTableColumns(db, tableName);
    if (!columns.includes('source_batch_id') || !columns.includes('source_row_number')) {
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_IMPORT_SOURCE_SCHEMA_INCOMPLETE',
        `${tableName} 缺少 imported provenance 来源列。`
      );
    }
    if (!energyFlowImportSourceForeignKeyIsCanonical(db, tableName)) {
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_IMPORT_SOURCE_FOREIGN_KEY_INVALID',
        `${tableName} 来源批次外键不符合 canonical 合同。`
      );
    }
    validateEnergyFlowImportSources(db, tableName);
  });
  const changed = ensureEnergyFlowImportSourceTriggers(db);
  const violations = db.prepare('PRAGMA foreign_key_check').all()
    .filter((row) => tableNames.includes(row.table));
  if (violations.length > 0) {
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_IMPORT_SOURCE_FOREIGN_KEY_CHECK_FAILED',
      '能流来源迁移后外键检查失败。',
      { foreignKeyViolations: violations }
    );
  }
  return changed;
}

/** 非 canonical N8 结构仅允许空骨架重建或精确 v1 机械迁移，其他历史结构全部 fail-closed。 */
function migrateEnergyFlowTables(db, energyAnalysisSql) {
  const nonCanonicalTables = ENERGY_FLOW_TABLES.filter((tableName) => (
    !energyFlowTableIsCanonical(db, tableName, energyAnalysisSql, {
      allowImportSourceTriggerUpgrade: true
    })
  ));
  if (nonCanonicalTables.length === 0) return false;

  const populatedTables = ENERGY_FLOW_TABLES.filter((tableName) => {
    if (!getTableCreateSql(db, tableName)) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteSqlIdentifier(tableName)}`).get().total) > 0;
  });
  const legacyV1Profile = getEnergyFlowLegacyV1Profile(db);
  if (legacyV1Profile) {
    try {
      return migrateEnergyFlowLegacyV1Tables(db, energyAnalysisSql, legacyV1Profile);
    } catch (error) {
      if (String(error?.code || '').startsWith('N8_ENERGY_FLOW_')) throw error;
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_LEGACY_CONFLICT',
        '能流 v1 历史数据无法无损迁移到 canonical v2。'
      );
    }
  }

  if (populatedTables.length > 0) {
    const unknownTriggers = ENERGY_FLOW_TABLES.flatMap((tableName) => (
      getEnergyFlowTableTriggers(db, tableName).map((triggerName) => ({ tableName, triggerName }))
    ));
    const explicitIndexes = Object.fromEntries(ENERGY_FLOW_TABLES
      .filter((tableName) => getTableCreateSql(db, tableName))
      .map((tableName) => [tableName, getEnergyFlowExplicitIndexNames(db, tableName)]));
    throw createEnergyFlowMigrationError(
      'N8_ENERGY_FLOW_NON_CANONICAL_DATA',
      '能流历史表含业务数据且结构不属于已知 v1 或 canonical v2，拒绝自动迁移。',
      { populatedTables, nonCanonicalTables, unknownTriggers, explicitIndexes }
    );
  }

  dropEnergyFlowTables(db);
  db.exec(energyAnalysisSql);
  return true;
}

/**
 * 在单一事务内幂等创建能源分析表，并安全升级 N8 能流 canonical v2。
 * @param {object} db SQLite 数据库连接。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {boolean} 调用前是否缺少能源分析主表。
 */
function ensureEnergyAnalysisTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'energy_timeseries_records'));
  const energyAnalysisSql = extractEnergyAnalysisSchemaSql(schemaText);
  runForeignKeySafeMigration(db, () => {
    const existingViolations = getEnergyFlowForeignKeyViolations(db);
    if (existingViolations.length > 0) {
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_FOREIGN_KEY_CHECK_FAILED',
        '能流 canonical 迁移前外键检查失败。',
        { foreignKeyViolations: existingViolations }
      );
    }
    migrateEnergyFlowTables(db, energyAnalysisSql);
    migrateEnergyBalanceImportSourceColumns(db);
    db.exec(energyAnalysisSql);
    migrateEnergyFlowImportSources(db);
    const invalidTables = ENERGY_FLOW_TABLES.filter((tableName) => (
      !energyFlowTableIsCanonical(db, tableName, energyAnalysisSql)
    ));
    if (invalidTables.length > 0) {
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_MIGRATION_VALIDATION_FAILED',
        '能流表结构不符合 canonical v2 合同。',
        { invalidTables }
      );
    }
    const foreignKeyViolations = getEnergyFlowForeignKeyViolations(db);
    if (foreignKeyViolations.length > 0) {
      throw createEnergyFlowMigrationError(
        'N8_ENERGY_FLOW_FOREIGN_KEY_CHECK_FAILED',
        '能流 canonical 迁移后外键检查失败。',
        { foreignKeyViolations }
      );
    }
  });
  return !tableExisted;
}

/**
 * 从完整 schema 中提取独立碳活动建表片段。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {string} 独立碳活动建表和索引 SQL。
 */
function extractCarbonActivitySchemaSql(schemaText) {
  const startIndex = schemaText.indexOf(CARBON_ACTIVITY_SCHEMA_START_MARKER);
  const endIndex = schemaText.indexOf(CARBON_ACTIVITY_SCHEMA_END_MARKER);
  const hasDuplicateMarker = startIndex !== schemaText.lastIndexOf(CARBON_ACTIVITY_SCHEMA_START_MARKER)
    || endIndex !== schemaText.lastIndexOf(CARBON_ACTIVITY_SCHEMA_END_MARKER);
  if (startIndex < 0 || endIndex <= startIndex || hasDuplicateMarker) {
    throw new Error('独立碳活动 schema 迁移片段标记缺失、重复或顺序错误。');
  }
  return schemaText.slice(startIndex + CARBON_ACTIVITY_SCHEMA_START_MARKER.length, endIndex).trim();
}

/** 从 schema 片段提取单条 CREATE TABLE/INDEX 语句，保留完整约束用于稳定指纹。 */
function extractNamedCreateStatement(schemaSql, objectType, objectName) {
  const escapedName = String(objectName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const objectTypePattern = objectType === 'index' ? '(?:unique\\s+)?index' : objectType;
  const prefixPattern = new RegExp(
    `create\\s+${objectTypePattern}\\s+(?:if\\s+not\\s+exists\\s+)?${escapedName}\\b`,
    'i'
  );
  const match = prefixPattern.exec(schemaSql);
  if (!match) return '';
  let parenthesisDepth = 0;
  let quoteCharacter = null;
  for (let index = match.index; index < schemaSql.length; index += 1) {
    const character = schemaSql[index];
    if (quoteCharacter) {
      if (character === quoteCharacter) {
        if (schemaSql[index + 1] === quoteCharacter) {
          index += 1;
        } else {
          quoteCharacter = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quoteCharacter = character;
    } else if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;
    } else if (character === ';' && parenthesisDepth === 0) {
      return schemaSql.slice(match.index, index + 1);
    }
  }
  return '';
}

/** 规范化 canonical CREATE 指纹，并忽略 SQLite 对 IF NOT EXISTS 的存储差异。 */
function normalizeCanonicalCreateFingerprint(sql) {
  return normalizeSqlContractText(sql)
    .replace(/^create table if not exists /, 'create table ')
    .replace(/^create index if not exists /, 'create index ')
    .replace(/^create unique index if not exists /, 'create unique index ');
}

/** 验证外键字段、目标表/列和 ON DELETE 行为均与 canonical 结构一致。 */
function carbonAccountingForeignKeysAreCanonical(db, tableName, expectedForeignKeys = []) {
  const actualForeignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(tableName)})`).all()
    .map((foreignKey) => ({
      from: foreignKey.from,
      table: foreignKey.table,
      to: foreignKey.to,
      onDelete: String(foreignKey.on_delete || '').toUpperCase()
    }))
    .sort((left, right) => `${left.from}:${left.table}:${left.to}`.localeCompare(`${right.from}:${right.table}:${right.to}`));
  const normalizedExpected = expectedForeignKeys
    .map((foreignKey) => ({ ...foreignKey, onDelete: String(foreignKey.onDelete).toUpperCase() }))
    .sort((left, right) => `${left.from}:${left.table}:${left.to}`.localeCompare(`${right.from}:${right.table}:${right.to}`));
  return JSON.stringify(actualForeignKeys) === JSON.stringify(normalizedExpected);
}

/** 判断独立核算运行或结果表是否完整匹配 canonical CREATE、外键和索引合同。 */
function carbonAccountingTableIsCanonical(db, tableName, carbonActivitySql = null) {
  const contract = CARBON_ACCOUNTING_TABLE_CONTRACTS[tableName];
  const createTableSql = getTableCreateSql(db, tableName);
  if (!contract || !createTableSql) return false;
  const canonicalSql = carbonActivitySql || extractCarbonActivitySchemaSql(fs.readFileSync(schemaPath, 'utf8'));
  const expectedTableSql = extractNamedCreateStatement(canonicalSql, 'table', tableName);
  if (!expectedTableSql
    || normalizeCanonicalCreateFingerprint(createTableSql) !== normalizeCanonicalCreateFingerprint(expectedTableSql)) {
    return false;
  }
  const columns = getTableColumns(db, tableName);
  if (columns.length !== contract.columns.length
    || columns.some((columnName, index) => columnName !== contract.columns[index])) return false;
  if (!carbonAccountingForeignKeysAreCanonical(db, tableName, contract.foreignKeys)) return false;
  return Object.entries(contract.indexes).every(([indexName, indexContract]) => {
    if (!demoGovernanceIndexIsCanonical(db, tableName, indexName, indexContract)) return false;
    const actualIndexSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName)?.sql;
    const expectedIndexSql = extractNamedCreateStatement(canonicalSql, 'index', indexName);
    return Boolean(actualIndexSql && expectedIndexSql)
      && normalizeCanonicalCreateFingerprint(actualIndexSql) === normalizeCanonicalCreateFingerprint(expectedIndexSql);
  });
}

/**
 * 将无业务数据的 N5-A 非 canonical 骨架替换为最终结构；已有运行或结果时必须安全失败。
 * @param {object} db SQLite 数据库连接。
 * @param {string} carbonActivitySql 独立碳活动完整 schema 片段。
 * @returns {boolean} 是否执行骨架重建。
 */
function migrateCarbonAccountingRunTables(db, carbonActivitySql) {
  const accountingTables = Object.keys(CARBON_ACCOUNTING_TABLE_CONTRACTS);
  const nonCanonicalTables = accountingTables.filter((tableName) => (
    !carbonAccountingTableIsCanonical(db, tableName, carbonActivitySql)
  ));
  if (nonCanonicalTables.length === 0) return false;

  const populatedTables = accountingTables.filter((tableName) => {
    if (!getTableCreateSql(db, tableName)) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteSqlIdentifier(tableName)}`).get().total || 0) > 0;
  });
  if (populatedTables.length > 0) {
    const error = new Error(`独立碳核算旧骨架含历史数据且结构不规范，拒绝自动迁移：${populatedTables.join(', ')}`);
    error.code = 'CARBON_ACCOUNTING_NON_CANONICAL_DATA';
    error.details = { populatedTables };
    throw error;
  }

  db.exec('DROP TABLE IF EXISTS carbon_accounting_results');
  db.exec('DROP TABLE IF EXISTS carbon_calculation_runs');
  db.exec(carbonActivitySql);
  const invalidTables = accountingTables.filter((tableName) => (
    !carbonAccountingTableIsCanonical(db, tableName, carbonActivitySql)
  ));
  if (invalidTables.length > 0) {
    throw new Error(`独立碳核算表结构不符合 canonical contract：${invalidTables.join(', ')}`);
  }
  return true;
}

/**
 * 在单一事务内幂等创建独立碳活动事实，并安全升级空的计算运行与结果骨架。
 * @param {object} db SQLite 数据库连接。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {boolean} 调用前是否缺少独立碳活动主表。
 */
function ensureCarbonActivityTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'carbon_activity_records'));
  const carbonActivitySql = extractCarbonActivitySchemaSql(schemaText);
  db.transaction(() => {
    migrateCarbonAccountingRunTables(db, carbonActivitySql);
    db.exec(carbonActivitySql);
  })();
  return !tableExisted;
}

/** 从完整 schema 中提取碳排放报告五表和索引片段。 */
function extractCarbonEmissionReportSchemaSql(schemaText) {
  const startIndex = schemaText.indexOf(CARBON_EMISSION_REPORT_SCHEMA_START_MARKER);
  const endIndex = schemaText.indexOf(CARBON_EMISSION_REPORT_SCHEMA_END_MARKER);
  const hasDuplicateMarker = startIndex !== schemaText.lastIndexOf(CARBON_EMISSION_REPORT_SCHEMA_START_MARKER)
    || endIndex !== schemaText.lastIndexOf(CARBON_EMISSION_REPORT_SCHEMA_END_MARKER);
  if (startIndex < 0 || endIndex <= startIndex || hasDuplicateMarker) {
    throw new Error('碳排放报告 schema 迁移片段标记缺失、重复或顺序错误。');
  }
  return schemaText.slice(startIndex + CARBON_EMISSION_REPORT_SCHEMA_START_MARKER.length, endIndex).trim();
}

/** 判断碳排放报告表及其显式索引是否完整匹配 canonical CREATE 指纹。 */
function carbonEmissionReportTableIsCanonical(db, tableName, reportSchemaSql = null) {
  if (!CARBON_EMISSION_REPORT_TABLES.includes(tableName)) return false;
  const createTableSql = getTableCreateSql(db, tableName);
  if (!createTableSql) return false;
  const canonicalSql = reportSchemaSql || extractCarbonEmissionReportSchemaSql(fs.readFileSync(schemaPath, 'utf8'));
  const expectedTableSql = extractNamedCreateStatement(canonicalSql, 'table', tableName);
  if (!expectedTableSql
    || normalizeCanonicalCreateFingerprint(createTableSql) !== normalizeCanonicalCreateFingerprint(expectedTableSql)) {
    return false;
  }
  return CARBON_EMISSION_REPORT_TABLE_INDEXES[tableName].every((indexName) => {
    const actualIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?")
      .get(indexName, tableName)?.sql;
    const expectedIndexSql = extractNamedCreateStatement(canonicalSql, 'index', indexName);
    return Boolean(actualIndexSql && expectedIndexSql)
      && normalizeCanonicalCreateFingerprint(actualIndexSql) === normalizeCanonicalCreateFingerprint(expectedIndexSql);
  });
}

/** 非 canonical 报告表仅在全部为空时允许整体重建；任何历史业务行都必须 fail-closed。 */
function migrateCarbonEmissionReportTables(db, reportSchemaSql) {
  const nonCanonicalTables = CARBON_EMISSION_REPORT_TABLES.filter((tableName) => (
    !carbonEmissionReportTableIsCanonical(db, tableName, reportSchemaSql)
  ));
  if (nonCanonicalTables.length === 0) return false;

  const populatedTables = CARBON_EMISSION_REPORT_TABLES.filter((tableName) => {
    if (!getTableCreateSql(db, tableName)) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteSqlIdentifier(tableName)}`).get().total || 0) > 0;
  });
  if (populatedTables.length > 0) {
    const error = new Error(`碳排放报告旧骨架含历史数据且结构不规范，拒绝自动迁移：${populatedTables.join(', ')}`);
    error.code = 'CARBON_EMISSION_REPORT_NON_CANONICAL_DATA';
    error.details = { populatedTables, nonCanonicalTables };
    throw error;
  }

  [
    'carbon_emission_report_summaries',
    'carbon_emission_report_items',
    'carbon_emission_report_evidence',
    'carbon_emission_report_boundaries',
    'carbon_emission_reports'
  ].forEach((tableName) => db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`));
  db.exec(reportSchemaSql);
  const invalidTables = CARBON_EMISSION_REPORT_TABLES.filter((tableName) => (
    !carbonEmissionReportTableIsCanonical(db, tableName, reportSchemaSql)
  ));
  if (invalidTables.length > 0) {
    throw new Error(`碳排放报告表结构不符合 canonical contract：${invalidTables.join(', ')}`);
  }
  return true;
}

/** 返回 N6 五表作为子表或父表时涉及的全部外键违规。 */
function getCarbonEmissionReportForeignKeyViolations(db) {
  return db.prepare('PRAGMA foreign_key_check').all()
    .filter((violation) => (
      CARBON_EMISSION_REPORT_TABLES.includes(violation.table)
      || CARBON_EMISSION_REPORT_TABLES.includes(violation.parent)
    ))
    .map((violation) => ({
      childTable: violation.table,
      rowId: violation.rowid,
      parentTable: violation.parent,
      foreignKeyId: violation.fkid
    }));
}

/** 在单一事务中幂等创建或安全升级碳排放报告五表，并验证全部出向和入向报告外键。 */
function ensureCarbonEmissionReportTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'carbon_emission_reports'));
  const reportSchemaSql = extractCarbonEmissionReportSchemaSql(schemaText);
  db.transaction(() => {
    const existingViolations = getCarbonEmissionReportForeignKeyViolations(db);
    if (existingViolations.length > 0) {
      const error = new Error('碳排放报告表迁移前外键检查失败。');
      error.code = 'CARBON_EMISSION_REPORT_FOREIGN_KEY_CHECK_FAILED';
      error.details = { foreignKeyViolations: existingViolations };
      throw error;
    }
    migrateCarbonEmissionReportTables(db, reportSchemaSql);
    db.exec(reportSchemaSql);
    const foreignKeyViolations = getCarbonEmissionReportForeignKeyViolations(db);
    if (foreignKeyViolations.length > 0) {
      const error = new Error('碳排放报告表迁移后外键检查失败。');
      error.code = 'CARBON_EMISSION_REPORT_FOREIGN_KEY_CHECK_FAILED';
      error.details = { foreignKeyViolations };
      throw error;
    }
  })();
  return !tableExisted;
}

/** 从完整 schema 中提取温室气体报告六表和索引片段。 */
function extractGhgReportSchemaSql(schemaText) {
  const startIndex = schemaText.indexOf(GHG_REPORT_SCHEMA_START_MARKER);
  const endIndex = schemaText.indexOf(GHG_REPORT_SCHEMA_END_MARKER);
  const hasDuplicateMarker = startIndex !== schemaText.lastIndexOf(GHG_REPORT_SCHEMA_START_MARKER)
    || endIndex !== schemaText.lastIndexOf(GHG_REPORT_SCHEMA_END_MARKER);
  if (startIndex < 0 || endIndex <= startIndex || hasDuplicateMarker) {
    throw new Error('温室气体报告 schema 迁移片段标记缺失、重复或顺序错误。');
  }
  return schemaText.slice(startIndex + GHG_REPORT_SCHEMA_START_MARKER.length, endIndex).trim();
}

/** 返回挂载到指定 N7 表的显式触发器名称，canonical contract 预期集合固定为空。 */
function getGhgReportTableTriggers(db, tableName) {
  if (!GHG_REPORT_TABLES.includes(tableName)) return [];
  return db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(tableName)
    .map((row) => row.name);
}

/** 判断温室气体报告表、显式索引及空触发器集合是否完整匹配 canonical CREATE 指纹。 */
function ghgReportTableIsCanonical(db, tableName, reportSchemaSql = null) {
  if (!GHG_REPORT_TABLES.includes(tableName)) return false;
  const createTableSql = getTableCreateSql(db, tableName);
  if (!createTableSql) return false;
  const canonicalSql = reportSchemaSql || extractGhgReportSchemaSql(fs.readFileSync(schemaPath, 'utf8'));
  const expectedTableSql = extractNamedCreateStatement(canonicalSql, 'table', tableName);
  if (!expectedTableSql
    || normalizeCanonicalCreateFingerprint(createTableSql) !== normalizeCanonicalCreateFingerprint(expectedTableSql)) {
    return false;
  }
  const triggers = getGhgReportTableTriggers(db, tableName);
  if (triggers.length !== GHG_REPORT_EXPECTED_TRIGGERS.length
    || triggers.some((triggerName, index) => triggerName !== GHG_REPORT_EXPECTED_TRIGGERS[index])) {
    return false;
  }
  return GHG_REPORT_TABLE_INDEXES[tableName].every((indexName) => {
    const actualIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?")
      .get(indexName, tableName)?.sql;
    const expectedIndexSql = extractNamedCreateStatement(canonicalSql, 'index', indexName);
    return Boolean(actualIndexSql && expectedIndexSql)
      && normalizeCanonicalCreateFingerprint(actualIndexSql) === normalizeCanonicalCreateFingerprint(expectedIndexSql);
  });
}

/** 非 canonical 温室气体报告表仅在全部为空时允许整体重建；任何历史业务行都必须 fail-closed。 */
function migrateGhgReportTables(db, reportSchemaSql) {
  const nonCanonicalTables = GHG_REPORT_TABLES.filter((tableName) => (
    !ghgReportTableIsCanonical(db, tableName, reportSchemaSql)
  ));
  if (nonCanonicalTables.length === 0) return false;

  const populatedTables = GHG_REPORT_TABLES.filter((tableName) => {
    if (!getTableCreateSql(db, tableName)) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteSqlIdentifier(tableName)}`).get().total || 0) > 0;
  });
  if (populatedTables.length > 0) {
    const unknownTriggers = GHG_REPORT_TABLES.flatMap((tableName) => (
      getGhgReportTableTriggers(db, tableName).map((triggerName) => ({ tableName, triggerName }))
    ));
    const error = new Error(`温室气体报告旧骨架含历史数据且结构不规范，拒绝自动迁移：${populatedTables.join(', ')}`);
    error.code = 'GHG_REPORT_NON_CANONICAL_DATA';
    error.details = { populatedTables, nonCanonicalTables, unknownTriggers };
    throw error;
  }

  [
    'ghg_report_summaries',
    'ghg_report_items',
    'ghg_report_evidence',
    'ghg_report_operational_boundaries',
    'ghg_report_organization_boundaries',
    'ghg_reports'
  ].forEach((tableName) => db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`));
  db.exec(reportSchemaSql);
  const invalidTables = GHG_REPORT_TABLES.filter((tableName) => (
    !ghgReportTableIsCanonical(db, tableName, reportSchemaSql)
  ));
  if (invalidTables.length > 0) {
    throw new Error(`温室气体报告表结构不符合 canonical contract：${invalidTables.join(', ')}`);
  }
  return true;
}

/** 返回 N7 六表作为子表或父表时涉及的全部外键违规。 */
function getGhgReportForeignKeyViolations(db) {
  return db.prepare('PRAGMA foreign_key_check').all()
    .filter((violation) => (
      GHG_REPORT_TABLES.includes(violation.table)
      || GHG_REPORT_TABLES.includes(violation.parent)
    ))
    .map((violation) => ({
      childTable: violation.table,
      rowId: violation.rowid,
      parentTable: violation.parent,
      foreignKeyId: violation.fkid
    }));
}

/** 在单一事务中幂等创建或安全升级温室气体报告六表，并验证全部出向和入向报告外键。 */
function ensureGhgReportTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'ghg_reports'));
  const reportSchemaSql = extractGhgReportSchemaSql(schemaText);
  db.transaction(() => {
    const existingViolations = getGhgReportForeignKeyViolations(db);
    if (existingViolations.length > 0) {
      const error = new Error('温室气体报告表迁移前外键检查失败。');
      error.code = 'GHG_REPORT_FOREIGN_KEY_CHECK_FAILED';
      error.details = { foreignKeyViolations: existingViolations };
      throw error;
    }
    migrateGhgReportTables(db, reportSchemaSql);
    db.exec(reportSchemaSql);
    const foreignKeyViolations = getGhgReportForeignKeyViolations(db);
    if (foreignKeyViolations.length > 0) {
      const error = new Error('温室气体报告表迁移后外键检查失败。');
      error.code = 'GHG_REPORT_FOREIGN_KEY_CHECK_FAILED';
      error.details = { foreignKeyViolations };
      throw error;
    }
  })();
  return !tableExisted;
}

/**
 * 从完整 schema 中提取演示治理建表片段。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {string} 演示治理建表、默认设置和索引 SQL。
 */
function extractDemoGovernanceSchemaSql(schemaText) {
  const startIndex = schemaText.indexOf(DEMO_GOVERNANCE_SCHEMA_START_MARKER);
  const endIndex = schemaText.indexOf(DEMO_GOVERNANCE_SCHEMA_END_MARKER);
  const hasDuplicateMarker = startIndex !== schemaText.lastIndexOf(DEMO_GOVERNANCE_SCHEMA_START_MARKER)
    || endIndex !== schemaText.lastIndexOf(DEMO_GOVERNANCE_SCHEMA_END_MARKER);
  if (startIndex < 0 || endIndex <= startIndex || hasDuplicateMarker) {
    throw new Error('演示治理 schema 迁移片段标记缺失、重复或顺序错误。');
  }
  return schemaText.slice(startIndex + DEMO_GOVERNANCE_SCHEMA_START_MARKER.length, endIndex).trim();
}

/**
 * 在单一事务中幂等创建演示治理表；INSERT OR IGNORE 保留已保存的运行期开关。
 * @param {object} db SQLite 数据库连接。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {boolean} 调用前是否缺少演示运行期设置表。
 */
function ensureDemoGovernanceTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'demo_runtime_settings'));
  const demoGovernanceSql = extractDemoGovernanceSchemaSql(schemaText);
  db.exec(demoGovernanceSql);
  assertDemoGovernanceContracts(db);
  return !tableExisted;
}

/**
 * 判断指定治理表是否满足 canonical 字段、约束与索引契约。
 * @param {object} db SQLite 数据库连接。
 * @param {string} tableName 治理表名。
 * @returns {boolean} 是否满足完整契约。
 */
function demoGovernanceTableIsCanonical(db, tableName) {
  const contract = DEMO_GOVERNANCE_CONTRACTS[tableName];
  if (!demoGovernanceTableStructureIsCanonical(db, tableName)) return false;
  const indexesCanonical = Object.entries(contract.indexes || {}).every(([indexName, indexContract]) => (
    demoGovernanceIndexIsCanonical(db, tableName, indexName, indexContract)
  ));
  if (!indexesCanonical) return false;
  return !contract.triggers || demoGovernanceTriggersAreCanonical(db, tableName, contract.triggers);
}

/**
 * 只校验治理表自身的字段和约束，索引可独立安全替换而不触发表重建。
 * @param {object} db SQLite 数据库连接。
 * @param {string} tableName 治理表名。
 * @returns {boolean} 表结构是否 canonical。
 */
function demoGovernanceTableStructureIsCanonical(db, tableName) {
  const contract = DEMO_GOVERNANCE_CONTRACTS[tableName];
  const createTableSql = getTableCreateSql(db, tableName);
  if (!contract || !createTableSql) return false;
  const normalizedSql = normalizeSqlContractText(createTableSql);
  const columns = new Set(getTableColumns(db, tableName));
  return contract.columns.every((columnName) => columns.has(columnName))
    && (contract.sqlTokens || []).every((token) => normalizedSql.includes(normalizeSqlContractText(token)));
}

/**
 * 规范化 schema 契约文本：仅折叠 SQL 语法空白和标识符差异，逐字节保留字符串字面量。
 * @param {string} sql SQL 文本。
 * @returns {string} 规范化 SQL。
 */
function normalizeSqlContractText(sql) {
  const source = String(sql || '');
  const tokens = [];
  const multiCharacterOperators = Object.freeze([
    '->>', '||', '<<', '>>', '<=', '>=', '==', '!=', '<>', '->'
  ]);

  /**
   * 判断字符是否可作为 SQLite 普通标识符首字符。
   * @param {string|undefined} character 待判断字符。
   * @returns {boolean} 是否为标识符首字符。
   */
  function isIdentifierStart(character) {
    return typeof character === 'string' && /^[\p{L}_]$/u.test(character);
  }

  /**
   * 判断字符是否可作为 SQLite 普通标识符后续字符。
   * @param {string|undefined} character 待判断字符。
   * @returns {boolean} 是否为标识符后续字符。
   */
  function isIdentifierPart(character) {
    return typeof character === 'string' && /^[\p{L}\p{N}_$]$/u.test(character);
  }

  /**
   * 把不同 SQLite 标识符引号统一为无引号简单标识符或双引号复杂标识符。
   * @param {string} identifier 标识符内容。
   * @returns {string} canonical 标识符。
   */
  function normalizeQuotedIdentifier(identifier) {
    const normalizedIdentifier = identifier.toLowerCase();
    if (/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(normalizedIdentifier)) {
      return normalizedIdentifier;
    }
    return `"${normalizedIdentifier.replace(/"/g, '""')}"`;
  }

  /**
   * 从指定位置读取单引号字符串，逐字节保留内容和转义。
   * @param {number} startIndex 起始单引号位置。
   * @returns {{token:string,nextIndex:number,terminated:boolean}} 字符串词元、下一位置和闭合状态。
   */
  function readStringLiteral(startIndex) {
    let index = startIndex + 1;
    let literal = "'";
    let terminated = false;
    while (index < source.length) {
      literal += source[index];
      if (source[index] === "'") {
        if (source[index + 1] === "'") {
          literal += source[index + 1];
          index += 2;
          continue;
        }
        index += 1;
        terminated = true;
        break;
      }
      index += 1;
    }
    return { token: literal, nextIndex: index, terminated };
  }

  /**
   * 从指定位置读取 SQLite 数值词元，保留小数点和指数内部边界。
   * @param {number} startIndex 数值起始位置。
   * @returns {{token:string,nextIndex:number}} 数值词元和下一位置。
   */
  function readNumericToken(startIndex) {
    let index = startIndex;
    if (source[index] === '0' && /[xX]/.test(source[index + 1] || '')) {
      index += 2;
      while (index < source.length && /[0-9A-Fa-f_]/.test(source[index])) index += 1;
      return { token: source.slice(startIndex, index).toLowerCase(), nextIndex: index };
    }
    if (source[index] === '.') index += 1;
    while (index < source.length && /[0-9_]/.test(source[index])) index += 1;
    if (source[index] === '.') {
      index += 1;
      while (index < source.length && /[0-9_]/.test(source[index])) index += 1;
    }
    const exponentStart = index;
    if (/[eE]/.test(source[index] || '')) {
      let exponentIndex = index + 1;
      if (source[exponentIndex] === '+' || source[exponentIndex] === '-') exponentIndex += 1;
      const digitStart = exponentIndex;
      while (exponentIndex < source.length && /[0-9_]/.test(source[exponentIndex])) exponentIndex += 1;
      if (exponentIndex > digitStart) index = exponentIndex;
      else index = exponentStart;
    }
    return { token: source.slice(startIndex, index).toLowerCase(), nextIndex: index };
  }

  for (let index = 0; index < source.length;) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && nextCharacter === '-') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if ((character === 'x' || character === 'X') && nextCharacter === "'") {
      const literal = readStringLiteral(index + 1);
      const literalBody = literal.token.endsWith("'")
        ? literal.token.slice(1, -1)
        : null;
      const isValidBlob = literal.terminated
        && literalBody !== null
        && /^[0-9A-Fa-f]*$/.test(literalBody)
        && literalBody.length % 2 === 0;
      if (isValidBlob) {
        tokens.push(`x'${literalBody.toUpperCase()}'`);
      } else {
        // 非法 BLOB 按原始字节保留，避免与合法 BLOB、其他非法写法或普通字符串假等价。
        tokens.push(source.slice(index, literal.nextIndex));
      }
      index = literal.nextIndex;
      continue;
    }
    if (character === "'") {
      const literal = readStringLiteral(index);
      tokens.push(literal.token);
      index = literal.nextIndex;
      continue;
    }
    if (character === '"' || character === '`' || character === '[') {
      const closingCharacter = character === '[' ? ']' : character;
      let identifier = '';
      index += 1;
      while (index < source.length) {
        if (source[index] === closingCharacter) {
          if (source[index + 1] === closingCharacter) {
            identifier += closingCharacter;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        identifier += source[index];
        index += 1;
      }
      tokens.push(normalizeQuotedIdentifier(identifier));
      continue;
    }
    if (/\d/.test(character) || (character === '.' && /\d/.test(nextCharacter || ''))) {
      const numericToken = readNumericToken(index);
      tokens.push(numericToken.token);
      index = numericToken.nextIndex;
      continue;
    }
    if (isIdentifierStart(character)) {
      let identifierEnd = index + 1;
      while (identifierEnd < source.length && isIdentifierPart(source[identifierEnd])) identifierEnd += 1;
      tokens.push(source.slice(index, identifierEnd).toLowerCase());
      index = identifierEnd;
      continue;
    }
    if (character === '?' && /\d/.test(nextCharacter || '')) {
      let parameterEnd = index + 2;
      while (parameterEnd < source.length && /\d/.test(source[parameterEnd])) parameterEnd += 1;
      tokens.push(source.slice(index, parameterEnd));
      index = parameterEnd;
      continue;
    }
    if ([':', '@', '$'].includes(character) && isIdentifierStart(nextCharacter)) {
      let parameterEnd = index + 2;
      while (parameterEnd < source.length && isIdentifierPart(source[parameterEnd])) parameterEnd += 1;
      // 命名参数名在 SQLite 中按原始字节保留，:Name 与 :name 不得假等价。
      tokens.push(`${character}${source.slice(index + 1, parameterEnd)}`);
      index = parameterEnd;
      continue;
    }
    const operator = multiCharacterOperators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    tokens.push(character.toLowerCase());
    index += 1;
  }

  while (tokens[tokens.length - 1] === ';') tokens.pop();
  return tokens.join(' ');
}

/**
 * 校验治理索引的表归属、唯一性、列顺序和部分索引 WHERE 条件。
 * @param {object} db SQLite 数据库连接。
 * @param {string} tableName 表名。
 * @param {string} indexName 索引名。
 * @param {object} contract 索引契约。
 * @returns {boolean} 是否为 canonical 索引。
 */
function demoGovernanceIndexIsCanonical(db, tableName, indexName, contract) {
  const indexRow = db.prepare(`SELECT tbl_name AS tableName, sql FROM sqlite_master
    WHERE type = 'index' AND name = ?`).get(indexName);
  if (!indexRow || indexRow.tableName !== tableName || !indexRow.sql) return false;
  const indexListRow = db.prepare(`PRAGMA index_list(${quoteSqlIdentifier(tableName)})`).all()
    .find((index) => index.name === indexName);
  if (!indexListRow || Boolean(indexListRow.unique) !== Boolean(contract.unique)) return false;
  const indexColumns = db.prepare(`PRAGMA index_info(${quoteSqlIdentifier(indexName)})`).all()
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => column.name);
  if (indexColumns.length !== contract.columns.length
    || indexColumns.some((columnName, index) => columnName !== contract.columns[index])) return false;
  if (Array.isArray(contract.descending)) {
    const descendingFlags = db.prepare(`PRAGMA index_xinfo(${quoteSqlIdentifier(indexName)})`).all()
      .filter((column) => Number(column.key) === 1)
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => Boolean(column.desc));
    if (descendingFlags.length !== contract.descending.length
      || descendingFlags.some((isDescending, index) => isDescending !== contract.descending[index])) return false;
  }
  const normalizedIndexSql = normalizeSqlContractText(indexRow.sql);
  const whereMatch = normalizedIndexSql.match(/\bwhere\b([\s\S]*)$/);
  const actualWhere = whereMatch ? whereMatch[1].trim() : null;
  const expectedWhere = contract.where ? normalizeSqlContractText(contract.where) : null;
  return actualWhere === expectedWhere;
}

/** 校验治理表挂载的显式触发器名称集合及其 canonical SQL，防止同名弱触发器绕过合同。 */
function demoGovernanceTriggersAreCanonical(db, tableName, triggerNames) {
  const actualTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(tableName);
  if (actualTriggers.length !== triggerNames.length
    || actualTriggers.some((trigger) => !triggerNames.includes(trigger.name))) {
    return false;
  }
  const canonicalProfile = buildCanonicalSchemaObjectProfile(fs.readFileSync(schemaPath, 'utf8'));
  return actualTriggers.every((trigger) => {
    const triggerKey = getSchemaObjectProfileKey({
      type: 'trigger',
      name: trigger.name,
      tableName
    });
    const canonicalTrigger = canonicalProfile.get(triggerKey);
    return canonicalTrigger
      && normalizeSchemaObjectProfileSql(trigger.sql)
        === normalizeSchemaObjectProfileSql(canonicalTrigger.sql);
  });
}

/**
 * 删除同名弱索引，使 canonical schema 能在当前事务中重新创建；数据冲突由唯一索引创建明确拒绝。
 * @param {object} db SQLite 数据库连接。
 * @returns {string[]} 已删除的弱索引名。
 */
function rebuildDemoDatasetRunsSha256Contract(db) {
  const createTableSql = getTableCreateSql(db, 'demo_dataset_runs');
  if (!createTableSql || demoGovernanceTableStructureIsCanonical(db, 'demo_dataset_runs')) return false;
  const runColumns = new Set(getTableColumns(db, 'demo_dataset_runs'));
  if (!DEMO_GOVERNANCE_CONTRACTS.demo_dataset_runs.columns.every((columnName) => runColumns.has(columnName))) {
    return false;
  }

  const runRows = db.prepare(`SELECT run_id AS runId, manifest_digest AS manifestDigest
    FROM demo_dataset_runs ORDER BY run_id`).all();
  const replacementDigestByRunId = new Map();
  runRows.forEach((run) => {
    if (!isLowercaseSha256Hex(run.manifestDigest)) {
      replacementDigestByRunId.set(run.runId, createMigrationSafetyDigest(
        'demo-dataset-run-manifest-migration',
        run.runId,
        run.manifestDigest
      ));
    }
  });

  db.exec('DROP INDEX IF EXISTS ux_demo_dataset_runs_active_dataset');
  db.exec('DROP INDEX IF EXISTS idx_demo_dataset_runs_status_created');
  const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name <> 'demo_dataset_runs'
      AND instr(lower(COALESCE(sql, '')), 'demo_dataset_runs') > 0
    ORDER BY name`).all();
  dependentTriggers.forEach((trigger) => db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`));
  db.exec('DROP TABLE IF EXISTS demo_dataset_runs_sha256_new');
  db.exec(DEMO_DATASET_RUNS_TABLE_SQL.replace(
    'CREATE TABLE demo_dataset_runs',
    'CREATE TABLE demo_dataset_runs_sha256_new'
  ));
  const insertRun = db.prepare(`INSERT INTO demo_dataset_runs_sha256_new
    (run_id, dataset_id, manifest_version, manifest_digest, status, created_by, created_at,
      completed_at, cleanup_started_at, cleaned_at, failure_reason)
    SELECT run_id, dataset_id, manifest_version, ?, status, created_by, created_at,
      completed_at, cleanup_started_at, cleaned_at, failure_reason
    FROM demo_dataset_runs WHERE run_id = ?`);
  runRows.forEach((run) => {
    insertRun.run(replacementDigestByRunId.get(run.runId) || run.manifestDigest, run.runId);
  });
  db.exec('DROP TABLE demo_dataset_runs');
  db.exec('ALTER TABLE demo_dataset_runs_sha256_new RENAME TO demo_dataset_runs');
  dependentTriggers.forEach((trigger) => db.exec(trigger.sql));
  db.exec(`CREATE UNIQUE INDEX ux_demo_dataset_runs_active_dataset
    ON demo_dataset_runs(dataset_id)
    WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning')`);
  db.exec('CREATE INDEX idx_demo_dataset_runs_status_created ON demo_dataset_runs(status, created_at DESC)');
  return replacementDigestByRunId;
}

function prepareDemoGovernanceIndexesForMigration(db) {
  const droppedIndexes = [];
  Object.entries(DEMO_GOVERNANCE_CONTRACTS).forEach(([tableName, tableContract]) => {
    if (!getTableCreateSql(db, tableName)) return;
    Object.entries(tableContract.indexes || {}).forEach(([indexName, indexContract]) => {
      const existingIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName);
      if (existingIndex && !demoGovernanceIndexIsCanonical(db, tableName, indexName, indexContract)) {
        db.exec(`DROP INDEX ${quoteSqlIdentifier(indexName)}`);
        droppedIndexes.push(indexName);
      }
    });
  });
  return droppedIndexes;
}

/**
 * 校验全部治理表 canonical contract，禁止缺列、弱 CHECK/FK/UNIQUE 或缺关键索引静默上线。
 * @param {object} db SQLite 数据库连接。
 */
function assertDemoGovernanceContracts(db) {
  const invalidTables = DEMO_GOVERNANCE_TABLES.filter((tableName) => !demoGovernanceTableIsCanonical(db, tableName));
  if (invalidTables.length > 0) {
    throw new Error(`演示治理表结构不符合 canonical contract：${invalidTables.join(', ')}`);
  }
}

/**
 * 预检已有治理数据，任何非法状态、孤儿、唯一冲突或跨 run/artifact 关系都安全失败。
 * @param {object} db SQLite 数据库连接。
 */
function preflightDemoGovernanceData(db) {
  if (getTableCreateSql(db, 'demo_runtime_settings')) {
    const settingsColumns = new Set(getTableColumns(db, 'demo_runtime_settings'));
    const requiredSettingsColumns = ['enabled', 'runtime_epoch', 'revision', 'updated_at', 'change_reason'];
    if (!requiredSettingsColumns.every((columnName) => settingsColumns.has(columnName))) {
      const settingCount = db.prepare('SELECT COUNT(*) AS total FROM demo_runtime_settings').get().total;
      if (settingCount > 0) throw new Error('演示运行期旧表缺少必要字段且包含数据，拒绝迁移。');
    } else {
      const invalidSettings = db.prepare(`SELECT COUNT(*) AS total FROM demo_runtime_settings
        WHERE enabled NOT IN (0, 1) OR runtime_epoch IS NULL OR runtime_epoch < 1
          OR revision IS NULL OR revision < 1 OR updated_at IS NULL OR trim(change_reason) = ''`).get().total;
      const settingCount = db.prepare('SELECT COUNT(*) AS total FROM demo_runtime_settings').get().total;
      if (invalidSettings > 0 || settingCount > 1) throw new Error('演示运行期设置存在非法或多行数据，拒绝迁移。');
    }
  }
  if (getTableCreateSql(db, 'demo_dataset_runs')) {
    const runColumns = new Set(getTableColumns(db, 'demo_dataset_runs'));
    const requiredRunColumns = ['dataset_id', 'status', 'cleaned_at'];
    if (!requiredRunColumns.every((columnName) => runColumns.has(columnName))) {
      const runCount = db.prepare('SELECT COUNT(*) AS total FROM demo_dataset_runs').get().total;
      if (runCount > 0) throw new Error('演示运行旧表缺少必要字段且包含数据，拒绝迁移。');
    } else {
      const invalidRuns = db.prepare(`SELECT COUNT(*) AS total FROM demo_dataset_runs
        WHERE (status = 'cleaned' AND cleaned_at IS NULL)
           OR (status <> 'cleaned' AND cleaned_at IS NOT NULL)`).get().total;
      const duplicateActiveRuns = db.prepare(`SELECT COUNT(*) AS total FROM (
        SELECT dataset_id FROM demo_dataset_runs
        WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning')
        GROUP BY dataset_id HAVING COUNT(*) > 1
      )`).get().total;
      if (invalidRuns > 0 || duplicateActiveRuns > 0) throw new Error('演示数据集运行存在矛盾状态或 active 冲突，拒绝迁移。');
    }
  }
  if (getTableCreateSql(db, 'demo_run_import_batches') && getTableCreateSql(db, 'demo_import_contexts')) {
    const linkColumns = new Set(getTableColumns(db, 'demo_run_import_batches'));
    if (['run_id', 'artifact_key', 'context_id'].every((columnName) => linkColumns.has(columnName))) {
      const invalidLinks = db.prepare(`SELECT COUNT(*) AS total FROM demo_run_import_batches AS link
        LEFT JOIN demo_import_contexts AS context ON context.context_id = link.context_id
        WHERE context.context_id IS NULL OR context.run_id <> link.run_id OR context.artifact_key <> link.artifact_key`).get().total;
      if (invalidLinks > 0) throw new Error('演示批次关系存在跨 run/artifact 或孤儿 context，拒绝迁移。');
    }
    if (['context_id', 'batch_role'].every((columnName) => linkColumns.has(columnName))) {
      const duplicatePrimaryContexts = db.prepare(`SELECT COUNT(*) AS total FROM (
        SELECT context_id FROM demo_run_import_batches
        WHERE batch_role = 'primary'
        GROUP BY context_id HAVING COUNT(*) > 1
      )`).get().total;
      if (duplicatePrimaryContexts > 0) throw new Error('演示批次关系存在 primary context 唯一冲突，拒绝迁移。');
    }
  }
  if (getTableCreateSql(db, 'demo_data_registry')) {
    const registryColumns = new Set(getTableColumns(db, 'demo_data_registry'));
    if (['entity_type', 'entity_pk', 'cleaned_at'].every((columnName) => registryColumns.has(columnName))) {
      const duplicateActiveEntities = db.prepare(`SELECT COUNT(*) AS total FROM (
        SELECT entity_type, entity_pk FROM demo_data_registry
        WHERE cleaned_at IS NULL
        GROUP BY entity_type, entity_pk HAVING COUNT(*) > 1
      )`).get().total;
      if (duplicateActiveEntities > 0) throw new Error('演示 registry 存在 active entity 唯一冲突，拒绝迁移。');
    }
  }
  if (getTableCreateSql(db, 'demo_data_relations') && getTableCreateSql(db, 'demo_data_registry')) {
    const relationColumns = new Set(getTableColumns(db, 'demo_data_relations'));
    if (['run_id', 'from_registry_id', 'to_registry_id'].every((columnName) => relationColumns.has(columnName))) {
      const invalidRelations = db.prepare(`SELECT COUNT(*) AS total FROM demo_data_relations AS relation
        LEFT JOIN demo_data_registry AS source ON source.registry_id = relation.from_registry_id
        LEFT JOIN demo_data_registry AS target ON target.registry_id = relation.to_registry_id
        WHERE source.registry_id IS NULL OR target.registry_id IS NULL
          OR source.run_id <> relation.run_id OR target.run_id <> relation.run_id`).get().total;
      if (invalidRelations > 0) throw new Error('演示 registry 关系存在跨 run 或孤儿端点，拒绝迁移。');
    }
  }
}

/**
 * 为早期阶段 1 库补充 batch_role，并保留已有 run、artifact、context 与批次关联。
 * @param {object} db SQLite 数据库连接。
 * @returns {boolean} 是否执行了表重建迁移。
 */
function migrateDemoRunImportBatchRole(db) {
  const createTableSql = getTableCreateSql(db, 'demo_run_import_batches');
  if (!createTableSql || demoGovernanceTableIsCanonical(db, 'demo_run_import_batches')) return false;
  preflightDemoGovernanceData(db);
  db.exec('ALTER TABLE demo_run_import_batches RENAME TO demo_run_import_batches_legacy');
  db.exec(DEMO_RUN_IMPORT_BATCHES_TABLE_SQL);
  const legacyColumns = new Set(getTableColumns(db, 'demo_run_import_batches_legacy'));
  const batchRoleExpression = legacyColumns.has('batch_role')
    ? "COALESCE(NULLIF(trim(legacy.batch_role), ''), 'primary')"
    : `CASE WHEN legacy.id = (
        SELECT MIN(candidate.id) FROM demo_run_import_batches_legacy AS candidate
        WHERE candidate.context_id = legacy.context_id
      ) THEN 'primary' ELSE 'legacy_batch_' || legacy.id END`;
  db.exec(`INSERT INTO demo_run_import_batches
    (id, run_id, artifact_key, context_id, import_batch_id, batch_role, linked_at)
    SELECT legacy.id, legacy.run_id, legacy.artifact_key, legacy.context_id, legacy.import_batch_id,
      ${batchRoleExpression}, legacy.linked_at
    FROM demo_run_import_batches_legacy AS legacy`);
  db.exec('DROP TABLE demo_run_import_batches_legacy');
  db.exec('CREATE INDEX IF NOT EXISTS idx_demo_run_import_batches_batch ON demo_run_import_batches(import_batch_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_demo_run_import_batches_run_artifact ON demo_run_import_batches(run_id, artifact_key, batch_role)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_run_import_batches_primary_context
    ON demo_run_import_batches(context_id) WHERE batch_role = 'primary'`);
  return true;
}

/**
 * 重建字段完整但 SHA-256 CHECK 较弱的 context 表；任何不可信摘要均撤销上下文并清空上传与预演绑定。
 * @param {object} db SQLite 数据库连接。
 * @param {Set<string>} unsafeRunIds 原 manifest 摘要不可信的运行 ID。
 * @returns {boolean} 是否执行迁移。
 */
function rebuildDemoImportContextsSha256Contract(db, unsafeRunIds = new Set(), options = {}) {
  if (!options.force && demoGovernanceTableStructureIsCanonical(db, 'demo_import_contexts')) return false;
  const legacyColumns = new Set(getTableColumns(db, 'demo_import_contexts'));
  if (!DEMO_GOVERNANCE_CONTRACTS.demo_import_contexts.columns.every((columnName) => legacyColumns.has(columnName))) {
    return false;
  }
  const contextRows = db.prepare(`SELECT context.*, run.manifest_digest AS canonical_run_manifest_digest
    FROM demo_import_contexts AS context
    JOIN demo_dataset_runs AS run ON run.run_id = context.run_id
    ORDER BY context.context_id`).all();
  const contextCount = db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total;
  if (contextRows.length !== contextCount) {
    throw new Error('演示 context 存在孤儿 run，拒绝 SHA-256 约束迁移。');
  }

  const hasBatchTable = Boolean(getTableCreateSql(db, 'demo_run_import_batches'));
  ['ux_demo_import_contexts_reassociated_from', 'ux_demo_import_contexts_replacement',
    'idx_demo_import_contexts_run_artifact', 'idx_demo_import_contexts_user_expiry',
    'idx_demo_import_contexts_handler_status']
    .forEach((indexName) => db.exec(`DROP INDEX IF EXISTS ${indexName}`));
  if (hasBatchTable) {
    ['idx_demo_run_import_batches_batch', 'idx_demo_run_import_batches_run_artifact', 'ux_demo_run_import_batches_primary_context']
      .forEach((indexName) => db.exec(`DROP INDEX IF EXISTS ${indexName}`));
    db.exec('ALTER TABLE demo_run_import_batches RENAME TO demo_run_import_batches_sha256_legacy');
  }
  db.exec('ALTER TABLE demo_import_contexts RENAME TO demo_import_contexts_sha256_legacy');
  db.exec(DEMO_IMPORT_CONTEXTS_V4_TABLE_SQL);

  const migrationTimestamp = new Date().toISOString();
  const insertContext = db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
      artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
      status, issued_at, expires_at, upload_file_sha256, preview_digest, previewed_at,
      executed_at, revoked_at, revoke_reason, reassociated_from_context_id,
      replacement_context_id, reassociated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  contextRows.forEach((context) => {
    const sha256BindingIsTrusted = !unsafeRunIds.has(context.run_id)
      && isLowercaseSha256Hex(context.token_hash)
      && isLowercaseSha256Hex(context.manifest_digest)
      && context.manifest_digest === context.canonical_run_manifest_digest
      && isLowercaseSha256Hex(context.artifact_file_sha256)
      && (context.upload_file_sha256 === null || isLowercaseSha256Hex(context.upload_file_sha256));
    const tokenHash = isLowercaseSha256Hex(context.token_hash)
      ? context.token_hash
      : createMigrationSafetyDigest('demo-context-token-migration', context.context_id, context.token_hash);
    const artifactFileSha256 = isLowercaseSha256Hex(context.artifact_file_sha256)
      ? context.artifact_file_sha256
      : createMigrationSafetyDigest('demo-context-artifact-migration', context.context_id, context.artifact_file_sha256);
    insertContext.run(
      context.context_id,
      tokenHash,
      context.run_id,
      context.dataset_id,
      context.manifest_version,
      context.canonical_run_manifest_digest,
      context.artifact_key,
      context.handler_key,
      artifactFileSha256,
      context.issued_to_user_id,
      context.runtime_epoch,
      sha256BindingIsTrusted ? context.status : 'revoked',
      context.issued_at,
      context.expires_at,
      sha256BindingIsTrusted ? context.upload_file_sha256 : null,
      sha256BindingIsTrusted ? context.preview_digest : null,
      sha256BindingIsTrusted ? context.previewed_at : null,
      context.executed_at,
      sha256BindingIsTrusted ? context.revoked_at : migrationTimestamp,
      sha256BindingIsTrusted ? context.revoke_reason : 'invalid_sha256_migration',
      context.reassociated_from_context_id,
      context.replacement_context_id,
      context.reassociated_at
    );
  });

  if (hasBatchTable) {
    db.exec(DEMO_RUN_IMPORT_BATCHES_TABLE_SQL);
    db.exec(`INSERT INTO demo_run_import_batches
      (id, run_id, artifact_key, context_id, import_batch_id, batch_role, linked_at)
      SELECT id, run_id, artifact_key, context_id, import_batch_id, batch_role, linked_at
      FROM demo_run_import_batches_sha256_legacy`);
    db.exec('DROP TABLE demo_run_import_batches_sha256_legacy');
  }
  db.exec('DROP TABLE demo_import_contexts_sha256_legacy');
  db.exec(`CREATE UNIQUE INDEX ux_demo_import_contexts_reassociated_from
    ON demo_import_contexts(reassociated_from_context_id) WHERE reassociated_from_context_id IS NOT NULL`);
  db.exec(`CREATE UNIQUE INDEX ux_demo_import_contexts_replacement
    ON demo_import_contexts(replacement_context_id) WHERE replacement_context_id IS NOT NULL`);
  db.exec('CREATE INDEX idx_demo_import_contexts_run_artifact ON demo_import_contexts(run_id, artifact_key, status)');
  db.exec('CREATE INDEX idx_demo_import_contexts_user_expiry ON demo_import_contexts(issued_to_user_id, expires_at, status)');
  db.exec('CREATE INDEX idx_demo_import_contexts_handler_status ON demo_import_contexts(handler_key, status, expires_at)');
  if (hasBatchTable) {
    db.exec('CREATE INDEX idx_demo_run_import_batches_batch ON demo_run_import_batches(import_batch_id)');
    db.exec('CREATE INDEX idx_demo_run_import_batches_run_artifact ON demo_run_import_batches(run_id, artifact_key, batch_role)');
    db.exec("CREATE UNIQUE INDEX ux_demo_run_import_batches_primary_context ON demo_run_import_batches(context_id) WHERE batch_role = 'primary'");
  }
  return true;
}

/**
 * 将旧 demo_import_contexts 安全迁移到 v4；旧 token 统一撤销并清空不可验证的 preview 与谱系绑定。
 * @param {object} db SQLite 数据库连接。
 * @param {Set<string>} unsafeRunIds 原 manifest 摘要不可信的运行 ID。
 * @returns {boolean} 是否执行迁移。
 */
function migrateDemoImportContextsV4(db, unsafeRunIds = new Set()) {
  const createTableSql = getTableCreateSql(db, 'demo_import_contexts');
  if (!createTableSql) return false;
  const structureIsCanonical = demoGovernanceTableStructureIsCanonical(db, 'demo_import_contexts');
  if (structureIsCanonical && unsafeRunIds.size === 0) return false;
  const rowCount = db.prepare('SELECT COUNT(*) AS total FROM demo_import_contexts').get().total;
  if (rowCount === 0) return false;
  const legacyColumns = new Set(getTableColumns(db, 'demo_import_contexts'));
  const completeV4Columns = DEMO_GOVERNANCE_CONTRACTS.demo_import_contexts.columns;
  if (completeV4Columns.every((columnName) => legacyColumns.has(columnName))) {
    return rebuildDemoImportContextsSha256Contract(db, unsafeRunIds, { force: structureIsCanonical });
  }
  const requiredV1Columns = ['context_id', 'token_hash', 'run_id', 'artifact_key', 'handler_key', 'issued_to_user_id', 'runtime_epoch', 'status', 'issued_at', 'expires_at'];
  if (!requiredV1Columns.every((columnName) => legacyColumns.has(columnName))) {
    throw new Error('演示 context 旧表不是可识别的 v1 结构，拒绝自动迁移。');
  }
  const invalidRows = db.prepare(`SELECT COUNT(*) AS total FROM demo_import_contexts AS context
    LEFT JOIN demo_dataset_runs AS run ON run.run_id = context.run_id
    LEFT JOIN sys_users AS user ON user.id = context.issued_to_user_id
    WHERE run.run_id IS NULL OR user.id IS NULL
      OR is_strict_utc_iso(context.issued_at) <> 1
      OR is_strict_utc_iso(context.expires_at) <> 1
      OR unixepoch(context.issued_at) >= unixepoch(context.expires_at)`).get().total;
  if (invalidRows > 0) throw new Error('演示 context v1 存在孤儿或非严格 UTC 时间，拒绝迁移。');

  const hasBatchTable = Boolean(getTableCreateSql(db, 'demo_run_import_batches'));
  ['ux_demo_import_contexts_reassociated_from', 'ux_demo_import_contexts_replacement',
    'idx_demo_import_contexts_run_artifact', 'idx_demo_import_contexts_user_expiry',
    'idx_demo_import_contexts_handler_status']
    .forEach((indexName) => db.exec(`DROP INDEX IF EXISTS ${indexName}`));
  if (hasBatchTable) {
    ['idx_demo_run_import_batches_batch', 'idx_demo_run_import_batches_run_artifact', 'ux_demo_run_import_batches_primary_context']
      .forEach((indexName) => db.exec(`DROP INDEX IF EXISTS ${indexName}`));
    db.exec('ALTER TABLE demo_run_import_batches RENAME TO demo_run_import_batches_context_v1');
  }
  db.exec('ALTER TABLE demo_import_contexts RENAME TO demo_import_contexts_v1');
  db.exec(DEMO_IMPORT_CONTEXTS_V4_TABLE_SQL);
  const migrationTimestamp = new Date().toISOString();
  const legacyContexts = db.prepare(`SELECT legacy.*, run.dataset_id AS run_dataset_id,
      run.manifest_version AS run_manifest_version, run.manifest_digest AS run_manifest_digest
    FROM demo_import_contexts_v1 AS legacy
    JOIN demo_dataset_runs AS run ON run.run_id = legacy.run_id
    ORDER BY legacy.context_id`).all();
  const insertLegacyContext = db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest,
      artifact_key, handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch,
      status, issued_at, expires_at, upload_file_sha256, preview_digest, previewed_at,
      executed_at, revoked_at, revoke_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revoked', ?, ?, NULL, NULL, NULL, ?, ?, 'legacy_context_v4_migration')`);
  legacyContexts.forEach((legacy) => {
    const tokenHash = isLowercaseSha256Hex(legacy.token_hash)
      ? legacy.token_hash
      : createMigrationSafetyDigest('demo-context-token-v1-migration', legacy.context_id, legacy.token_hash);
    const legacyUploadSha = legacyColumns.has('upload_file_sha256') ? legacy.upload_file_sha256 : null;
    const artifactFileSha256 = isLowercaseSha256Hex(legacyUploadSha)
      ? legacyUploadSha
      : (isLowercaseSha256Hex(legacy.token_hash)
          ? legacy.token_hash
          : createMigrationSafetyDigest('demo-context-artifact-v1-migration', legacy.context_id, legacyUploadSha));
    insertLegacyContext.run(
      legacy.context_id,
      tokenHash,
      legacy.run_id,
      legacy.run_dataset_id,
      legacy.run_manifest_version,
      legacy.run_manifest_digest,
      legacy.artifact_key,
      legacy.handler_key,
      artifactFileSha256,
      legacy.issued_to_user_id,
      legacy.runtime_epoch,
      legacy.issued_at,
      legacy.expires_at,
      legacyColumns.has('executed_at') ? legacy.executed_at : null,
      migrationTimestamp
    );
  });

  if (hasBatchTable) {
    const batchColumns = new Set(getTableColumns(db, 'demo_run_import_batches_context_v1'));
    db.exec(DEMO_RUN_IMPORT_BATCHES_TABLE_SQL);
    const batchRoleExpression = batchColumns.has('batch_role')
      ? "COALESCE(NULLIF(trim(legacy.batch_role), ''), 'primary')"
      : `CASE WHEN legacy.id = (
          SELECT MIN(candidate.id) FROM demo_run_import_batches_context_v1 AS candidate
          WHERE candidate.context_id = legacy.context_id
        ) THEN 'primary' ELSE 'legacy_batch_' || legacy.id END`;
    db.exec(`INSERT INTO demo_run_import_batches
      (id, run_id, artifact_key, context_id, import_batch_id, batch_role, linked_at)
      SELECT legacy.id, legacy.run_id, legacy.artifact_key, legacy.context_id,
        legacy.import_batch_id, ${batchRoleExpression}, legacy.linked_at
      FROM demo_run_import_batches_context_v1 AS legacy`);
    db.exec('DROP TABLE demo_run_import_batches_context_v1');
  }
  db.exec('DROP TABLE demo_import_contexts_v1');
  db.exec(`CREATE UNIQUE INDEX ux_demo_import_contexts_reassociated_from
    ON demo_import_contexts(reassociated_from_context_id) WHERE reassociated_from_context_id IS NOT NULL`);
  db.exec(`CREATE UNIQUE INDEX ux_demo_import_contexts_replacement
    ON demo_import_contexts(replacement_context_id) WHERE replacement_context_id IS NOT NULL`);
  db.exec('CREATE INDEX idx_demo_import_contexts_run_artifact ON demo_import_contexts(run_id, artifact_key, status)');
  db.exec('CREATE INDEX idx_demo_import_contexts_user_expiry ON demo_import_contexts(issued_to_user_id, expires_at, status)');
  db.exec('CREATE INDEX idx_demo_import_contexts_handler_status ON demo_import_contexts(handler_key, status, expires_at)');
  if (hasBatchTable) {
    db.exec('CREATE INDEX idx_demo_run_import_batches_batch ON demo_run_import_batches(import_batch_id)');
    db.exec('CREATE INDEX idx_demo_run_import_batches_run_artifact ON demo_run_import_batches(run_id, artifact_key, batch_role)');
    db.exec("CREATE UNIQUE INDEX ux_demo_run_import_batches_primary_context ON demo_run_import_batches(context_id) WHERE batch_role = 'primary'");
  }
  return true;
}

/**
 * 空的弱治理表可以安全删除并由 canonical schema 重建；含数据的已知 v1 context 执行专用迁移，未知弱表拒绝自动猜测。
 * @param {object} db SQLite 数据库连接。
 * @returns {string[]} 已删除并等待重建的弱表。
 */
function prepareDemoGovernanceTablesForMigration(db) {
  const unsafeRunDigestMap = rebuildDemoDatasetRunsSha256Contract(db);
  const unsafeRunIds = unsafeRunDigestMap instanceof Map
    ? new Set(unsafeRunDigestMap.keys())
    : new Set();
  migrateDemoImportContextsV4(db, unsafeRunIds);
  preflightDemoGovernanceData(db);
  const structurallyWeakTables = DEMO_GOVERNANCE_TABLES.filter((tableName) => (
    getTableCreateSql(db, tableName) && !demoGovernanceTableStructureIsCanonical(db, tableName)
  ));
  prepareDemoGovernanceIndexesForMigration(db);
  const weakTables = structurallyWeakTables;
  const weakBatchTable = weakTables.includes('demo_run_import_batches');
  const weakBatchRowCount = weakBatchTable
    ? db.prepare('SELECT COUNT(*) AS total FROM demo_run_import_batches').get().total : 0;
  if (weakBatchTable && weakBatchRowCount > 0) {
    if (!demoGovernanceTableIsCanonical(db, 'demo_import_contexts')) {
      throw new Error('演示批次旧表含数据但 context 父表不规范，拒绝自动迁移。');
    }
    migrateDemoRunImportBatchRole(db);
  }
  const remainingWeakTables = weakTables.filter((tableName) => (
    tableName !== 'demo_run_import_batches' || weakBatchRowCount === 0
  ));
  const nonEmptyWeakTables = remainingWeakTables.filter((tableName) => (
    db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total > 0
  ));
  if (nonEmptyWeakTables.length > 0) {
    throw new Error(`演示治理旧表含数据且结构不规范，拒绝自动迁移：${nonEmptyWeakTables.join(', ')}`);
  }
  [...remainingWeakTables].reverse().forEach((tableName) => db.exec(`DROP TABLE ${tableName}`));
  return remainingWeakTables;
}

function getTableCreateSql(db, tableName) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return row ? row.sql || '' : '';
}

function carbonEmissionsStatusCheckAllowsSuperseded(createTableSql) {
  return /status\s+TEXT[\s\S]*CHECK\s*\([\s\S]*status\s+IN\s*\([\s\S]*'superseded'/i.test(createTableSql || '');
}

function importBatchesImportTypeCheckAllowsLedgerTypes(createTableSql) {
  return /import_type\s+TEXT[\s\S]*CHECK\s*\([\s\S]*import_type\s+IN\s*\([\s\S]*'organization_unit'[\s\S]*'meter_device'/i.test(createTableSql || '');
}

function importBatchesImportTypeCheckAllowsAuditTypes(createTableSql) {
  const sql = createTableSql || '';
  return IMPORT_BATCH_TYPES.every((importType) => sql.includes(`'${importType}'`));
}

function importBatchesHasAuditColumns(columns) {
  return [
    'audit_phase',
    'preview_signature',
    'preview_audit_digest',
    'audit_context_json',
    'execute_result_json',
    'backup_json'
  ].every((columnName) => columns.includes(columnName));
}

function generationRecordsDataSourceCheckAllowsUpload(createTableSql) {
  return /data_source\s+TEXT[\s\S]*CHECK\s*\([\s\S]*data_source\s+IN\s*\([\s\S]*'upload'/i.test(createTableSql || '');
}

function importBatchesImportTypeCheckAllowsPredictionConfig(createTableSql) {
  return /import_type\s+TEXT[\s\S]*CHECK\s*\([\s\S]*'prediction_config'/i.test(createTableSql || '');
}

function predictionRunsStatusCheckAllowsManagementStatuses(createTableSql) {
  return /status\s+TEXT[\s\S]*CHECK\s*\([\s\S]*'cancelled'[\s\S]*'archived'/i.test(createTableSql || '');
}

function buildImportBatchesImportTypeMigrationSql() {
  return [
    'DROP TABLE IF EXISTS import_batches__migration_new',
    IMPORT_BATCHES_TABLE_WITH_LEDGER_TYPES_SQL,
    IMPORT_BATCHES_COPY_SQL,
    'DROP TABLE import_batches',
    'ALTER TABLE import_batches__migration_new RENAME TO import_batches',
    'CREATE INDEX IF NOT EXISTS idx_import_batches_type_status_created ON import_batches(import_type, status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_import_batches_status_created ON import_batches(status, created_at DESC)'
  ];
}

function buildGenerationRecordsDataSourceMigrationSql(existingColumns = []) {
  return [
    'DROP TABLE IF EXISTS generation_records__migration_new',
    GENERATION_RECORDS_TABLE_WITH_UPLOAD_DATA_SOURCE_SQL,
    buildGenerationRecordsCopySql(existingColumns),
    'DROP TABLE generation_records',
    'ALTER TABLE generation_records__migration_new RENAME TO generation_records',
    'CREATE INDEX IF NOT EXISTS idx_generation_records_org_month ON generation_records(organization_unit_id, normalized_month)',
    'CREATE INDEX IF NOT EXISTS idx_generation_records_batch ON generation_records(source_batch_id)',
    'CREATE INDEX IF NOT EXISTS idx_generation_records_energy_status ON generation_records(energy_type_id, record_status)',
    'CREATE INDEX IF NOT EXISTS idx_generation_records_status_month ON generation_records(record_status, normalized_month)',
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_active_org_month_energy ON generation_records(organization_unit_id, normalized_month, energy_type_id) WHERE record_status = 'active'"
  ];
}

function buildCarbonEmissionsStatusMigrationSql() {
  return [
    'DROP TABLE IF EXISTS carbon_emissions__migration_new',
    CARBON_EMISSIONS_TABLE_WITH_SUPERSEDED_SQL,
    CARBON_EMISSIONS_COPY_SQL,
    'DROP TABLE carbon_emissions',
    'ALTER TABLE carbon_emissions__migration_new RENAME TO carbon_emissions',
    'CREATE INDEX IF NOT EXISTS idx_carbon_emissions_record ON carbon_emissions(energy_record_id, status)'
  ];
}

function migrateCarbonEmissionsStatusCheck(db) {
  const createTableSql = getTableCreateSql(db, 'carbon_emissions');
  if (!createTableSql || carbonEmissionsStatusCheckAllowsSuperseded(createTableSql)) {
    return false;
  }

  runForeignKeySafeMigration(db, () => {
    buildCarbonEmissionsStatusMigrationSql().forEach((sql) => db.exec(sql));
  });
  return true;
}

/**
 * 运行需要重建外键相关表的迁移；统一初始化事务内直接复用外层事务，独立调用时自行事务化。
 * @param {object} db SQLite 数据库连接。
 * @param {Function} migration 迁移主体。
 */
function runForeignKeySafeMigration(db, migration) {
  if (db.inTransaction) {
    migration();
    return;
  }
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(migration).immediate();
  } finally {
    if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}

function migrateImportBatchesImportTypeCheck(db) {
  const createTableSql = getTableCreateSql(db, 'import_batches');
  if (!createTableSql) {
    return false;
  }

  const columns = getTableColumns(db, 'import_batches');
  const needsImportTypeCheckMigration = !importBatchesImportTypeCheckAllowsAuditTypes(createTableSql);
  const needsAuditColumns = !importBatchesHasAuditColumns(columns);
  if (!needsImportTypeCheckMigration && !needsAuditColumns) {
    return false;
  }

  runForeignKeySafeMigration(db, () => {
    addColumnIfMissing(db, 'import_batches', 'audit_phase', "audit_phase TEXT CHECK (audit_phase IS NULL OR audit_phase IN ('preview', 'execute'))");
    addColumnIfMissing(db, 'import_batches', 'preview_signature', 'preview_signature TEXT');
    addColumnIfMissing(db, 'import_batches', 'preview_audit_digest', 'preview_audit_digest TEXT');
    addColumnIfMissing(db, 'import_batches', 'audit_context_json', 'audit_context_json TEXT');
    addColumnIfMissing(db, 'import_batches', 'execute_result_json', 'execute_result_json TEXT');
    addColumnIfMissing(db, 'import_batches', 'backup_json', 'backup_json TEXT');
    if (needsImportTypeCheckMigration) {
      buildImportBatchesImportTypeMigrationSql().forEach((sql) => db.exec(sql));
    }
  });
  return true;
}

function migrateGenerationRecordsDataSourceCheck(db) {
  const createTableSql = getTableCreateSql(db, 'generation_records');
  if (!createTableSql || generationRecordsDataSourceCheckAllowsUpload(createTableSql)) {
    return false;
  }

  runForeignKeySafeMigration(db, () => {
    buildGenerationRecordsDataSourceMigrationSql(getTableColumns(db, 'generation_records')).forEach((sql) => db.exec(sql));
  });
  return true;
}

function ensurePredictionConfigsTable(db) {
  const existed = Boolean(getTableCreateSql(db, 'prediction_configs'));
  db.exec(PREDICTION_CONFIGS_TABLE_SQL);
  return !existed;
}

function migratePredictionRunsStatusCheck(db) {
  const createTableSql = getTableCreateSql(db, 'prediction_runs');
  if (!createTableSql || predictionRunsStatusCheckAllowsManagementStatuses(createTableSql)) return false;
  runForeignKeySafeMigration(db, () => {
    db.exec('DROP TABLE IF EXISTS prediction_runs__migration_new');
    db.exec(PREDICTION_RUNS_TABLE_WITH_MANAGEMENT_STATUSES_SQL);
    db.exec(`INSERT INTO prediction_runs__migration_new (id, name, algorithm, status, target_energy_type_id, train_start_month, train_end_month, predict_start_month, predict_end_month, parameters_json, created_at, completed_at, note)
      SELECT id, name, algorithm, CASE WHEN status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'archived') THEN status ELSE 'failed' END, target_energy_type_id, train_start_month, train_end_month, predict_start_month, predict_end_month, parameters_json, created_at, completed_at, note FROM prediction_runs`);
    db.exec('DROP TABLE prediction_runs');
    db.exec('ALTER TABLE prediction_runs__migration_new RENAME TO prediction_runs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_prediction_runs_status_created ON prediction_runs(status, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_prediction_results_run_month ON prediction_results(prediction_run_id, target_month)');
  });
  return true;
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function addColumnIfMissing(db, tableName, columnName, columnSql) {
  const columns = getTableColumns(db, tableName);
  if (columns.includes(columnName)) {
    return false;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  return true;
}

/** 校验平衡来源批次外键固定指向 import_batches，并使用 SET NULL。 */
function energyBalanceSourceForeignKeyIsCanonical(db, tableName) {
  return db.prepare(`PRAGMA foreign_key_list(${tableName})`).all().some((foreignKey) => (
    foreignKey.from === 'source_batch_id'
    && foreignKey.table === 'import_batches'
    && foreignKey.to === 'id'
    && String(foreignKey.on_delete || '').toUpperCase() === 'SET NULL'
  ));
}

/** 校验既有平衡来源列没有违反成对可空和正整数约束。 */
function validateEnergyBalanceImportSources(db, tableName) {
  const violation = db.prepare(`SELECT id, source_batch_id AS sourceBatchId,
      source_row_number AS sourceRowNumber
    FROM ${tableName}
    WHERE NOT (
      (source_batch_id IS NULL AND source_row_number IS NULL)
      OR (
        source_batch_id IS NOT NULL
        AND source_row_number IS NOT NULL
        AND typeof(source_row_number) = 'integer'
        AND source_row_number >= 1
      )
    )
    LIMIT 1`).get();
  if (violation) {
    const error = new Error(`${tableName} 存在不符合 provenance 成对约束的历史记录。`);
    error.code = 'ENERGY_BALANCE_IMPORT_SOURCE_INVALID';
    error.details = violation;
    throw error;
  }
}

/** 严格安装平衡来源约束触发器，拒绝保留同名弱触发器。 */
function ensureEnergyBalanceImportSourceTriggers(db) {
  const expectedStatements = ENERGY_BALANCE_IMPORT_SOURCE_TRIGGERS_SQL.match(/CREATE TRIGGER[\s\S]*?END;/g) || [];
  const expectedByName = new Map(expectedStatements.map((sql) => {
    const name = sql.match(/^CREATE TRIGGER\s+(\S+)/i)?.[1];
    return [name, sql];
  }));
  const triggerNames = [...expectedByName.keys()];
  const actualByName = new Map(db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${triggerNames.map(() => '?').join(', ')})`).all(...triggerNames)
    .map((row) => [row.name, row.sql]));
  const isCanonical = triggerNames.length === 5 && triggerNames.every((name) => (
    normalizeTriggerSql(actualByName.get(name)) === normalizeTriggerSql(expectedByName.get(name))
  ));
  if (isCanonical) return false;
  triggerNames.forEach((name) => db.exec(`DROP TRIGGER IF EXISTS ${name}`));
  db.exec(ENERGY_BALANCE_IMPORT_SOURCE_TRIGGERS_SQL);
  return true;
}

/**
 * 为既有平衡边界和项目补充 imported provenance，保留正式手工记录的 NULL/NULL 来源。
 * @param {object} db SQLite 数据库连接。
 * @returns {boolean} 是否修改了旧库结构、索引或触发器。
 */
function migrateEnergyBalanceImportSourceColumns(db) {
  const boundaryExists = Boolean(getTableCreateSql(db, 'energy_balance_boundaries'));
  const itemExists = Boolean(getTableCreateSql(db, 'energy_balance_items'));
  if (!boundaryExists && !itemExists) return false;
  if (!boundaryExists || !itemExists || !getTableCreateSql(db, 'import_batches')) {
    const error = new Error('平衡来源迁移要求 import_batches、energy_balance_boundaries 和 energy_balance_items 同时存在。');
    error.code = 'ENERGY_BALANCE_IMPORT_SOURCE_SCHEMA_INCOMPLETE';
    throw error;
  }

  ['energy_balance_boundaries', 'energy_balance_items'].forEach((tableName) => {
    const columns = getTableColumns(db, tableName);
    if (columns.includes('source_batch_id') && !energyBalanceSourceForeignKeyIsCanonical(db, tableName)) {
      const error = new Error(`${tableName} 已有 source_batch_id，但来源外键不符合 canonical 合同。`);
      error.code = 'ENERGY_BALANCE_IMPORT_SOURCE_FOREIGN_KEY_INVALID';
      throw error;
    }
  });

  let changed = false;
  db.transaction(() => {
    ['energy_balance_boundaries', 'energy_balance_items'].forEach((tableName) => {
      changed = addColumnIfMissing(
        db,
        tableName,
        'source_batch_id',
        'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
      ) || changed;
      changed = addColumnIfMissing(
        db,
        tableName,
        'source_row_number',
        'source_row_number INTEGER'
      ) || changed;
      validateEnergyBalanceImportSources(db, tableName);
      if (!energyBalanceSourceForeignKeyIsCanonical(db, tableName)) {
        throw new Error(`${tableName} 来源批次外键迁移后仍不符合 canonical 合同。`);
      }
    });
    changed = ensureEnergyBalanceImportSourceTriggers(db) || changed;
    const sourceIndexes = [
      ['idx_energy_balance_boundaries_source', 'energy_balance_boundaries'],
      ['idx_energy_balance_items_source', 'energy_balance_items']
    ];
    sourceIndexes.forEach(([indexName, tableName]) => {
      const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName));
      db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(source_batch_id, source_row_number)`);
      changed = !existed || changed;
    });
    const foreignKeyViolations = db.prepare(`PRAGMA foreign_key_check`).all()
      .filter((row) => ['energy_balance_boundaries', 'energy_balance_items'].includes(row.table));
    if (foreignKeyViolations.length > 0) {
      const error = new Error('平衡来源迁移后外键检查失败。');
      error.code = 'ENERGY_BALANCE_IMPORT_SOURCE_FOREIGN_KEY_CHECK_FAILED';
      error.details = foreignKeyViolations;
      throw error;
    }
  })();
  return changed;
}

/**
 * 为既有平衡快照补充一等计算运行身份，并恢复快照、项目和建议的一致绑定。
 * @param {object} db SQLite 数据库连接。
 * @returns {boolean} 是否修改了旧库结构或回填了运行身份。
 */
function migrateEnergyBalanceCalculationRuns(db) {
  if (!getTableCreateSql(db, 'energy_balance_snapshots')) {
    return false;
  }

  let changed = false;
  db.transaction(() => {
    const runTableExisted = Boolean(getTableCreateSql(db, 'energy_balance_calculation_runs'));
    db.exec(ENERGY_BALANCE_CALCULATION_RUNS_TABLE_SQL);
    changed = !runTableExisted || changed;
    changed = addColumnIfMissing(
      db,
      'energy_balance_snapshots',
      'calculation_run_id',
      'calculation_run_id TEXT REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE'
    ) || changed;
    if (getTableCreateSql(db, 'energy_balance_snapshot_items')) {
      changed = addColumnIfMissing(
        db,
        'energy_balance_snapshot_items',
        'calculation_run_id',
        'calculation_run_id TEXT REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE'
      ) || changed;
      changed = addColumnIfMissing(
        db,
        'energy_balance_snapshot_items',
        'item_code',
        'item_code TEXT'
      ) || changed;
      changed = addColumnIfMissing(
        db,
        'energy_balance_snapshot_items',
        'item_name',
        'item_name TEXT'
      ) || changed;
    }
    if (getTableCreateSql(db, 'energy_balance_suggestions')) {
      changed = addColumnIfMissing(
        db,
        'energy_balance_suggestions',
        'calculation_run_id',
        'calculation_run_id TEXT REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE'
      ) || changed;
      changed = addColumnIfMissing(
        db,
        'energy_balance_suggestions',
        'reviewed_by_user_id',
        'reviewed_by_user_id INTEGER REFERENCES sys_users(id) ON DELETE SET NULL'
      ) || changed;
    }

    const snapshots = db.prepare(`SELECT id,
        calculation_run_id AS calculationRunId,
        energy_balance_boundary_id AS boundaryId,
        start_utc AS startUtc,
        end_utc AS endUtc,
        source_timezone AS sourceTimeZone,
        source_data_digest AS sourceDataDigest,
        formula_version AS formulaVersion,
        created_at AS createdAt
      FROM energy_balance_snapshots ORDER BY id`).all();
    const insertRun = db.prepare(`INSERT OR IGNORE INTO energy_balance_calculation_runs (
        calculation_run_id, energy_balance_boundary_id, start_utc, end_utc,
        source_timezone, source_data_digest, formula_version,
        conversion_formula_version, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'standard-coal-conversion:v1', NULL, ?)`);
    const updateSnapshotRun = db.prepare(
      'UPDATE energy_balance_snapshots SET calculation_run_id = ? WHERE id = ? AND calculation_run_id IS NULL'
    );
    snapshots.forEach((snapshot) => {
      const calculationRunId = snapshot.calculationRunId || `legacy-snapshot-${snapshot.id}`;
      const insertResult = insertRun.run(
        calculationRunId,
        snapshot.boundaryId,
        snapshot.startUtc,
        snapshot.endUtc,
        snapshot.sourceTimeZone,
        snapshot.sourceDataDigest,
        snapshot.formulaVersion,
        snapshot.createdAt
      );
      const updateResult = updateSnapshotRun.run(calculationRunId, snapshot.id);
      changed = insertResult.changes > 0 || updateResult.changes > 0 || changed;
    });

    if (getTableCreateSql(db, 'energy_balance_snapshot_items')) {
      const itemUpdate = db.prepare(`UPDATE energy_balance_snapshot_items
        SET calculation_run_id = (
          SELECT snapshot.calculation_run_id FROM energy_balance_snapshots AS snapshot
          WHERE snapshot.id = energy_balance_snapshot_items.energy_balance_snapshot_id
        )
        WHERE calculation_run_id IS NULL`).run();
      changed = itemUpdate.changes > 0 || changed;
      const identityUpdate = db.prepare(`UPDATE energy_balance_snapshot_items
        SET item_code = COALESCE(NULLIF(trim(item_code), ''), (
              SELECT item.item_code FROM energy_balance_items AS item
              WHERE item.id = energy_balance_snapshot_items.energy_balance_item_id
            )),
            item_name = COALESCE(NULLIF(trim(item_name), ''), (
              SELECT item.item_name FROM energy_balance_items AS item
              WHERE item.id = energy_balance_snapshot_items.energy_balance_item_id
            ))
        WHERE item_code IS NULL OR trim(item_code) = ''
           OR item_name IS NULL OR trim(item_name) = ''`).run();
      changed = identityUpdate.changes > 0 || changed;
      const missingIdentity = db.prepare(`SELECT id FROM energy_balance_snapshot_items
        WHERE item_code IS NULL OR trim(item_code) = ''
           OR item_name IS NULL OR trim(item_name) = '' LIMIT 1`).get();
      if (missingIdentity) {
        throw new Error(`无法回填平衡快照项目历史标识：${missingIdentity.id}`);
      }
    }
    if (getTableCreateSql(db, 'energy_balance_suggestions')) {
      const suggestionUpdate = db.prepare(`UPDATE energy_balance_suggestions
        SET calculation_run_id = (
          SELECT snapshot.calculation_run_id FROM energy_balance_snapshots AS snapshot
          WHERE snapshot.id = energy_balance_suggestions.energy_balance_snapshot_id
        )
        WHERE calculation_run_id IS NULL`).run();
      changed = suggestionUpdate.changes > 0 || changed;
    }

    [
      'trg_energy_balance_calculation_runs_immutable_update',
      'trg_energy_balance_snapshots_run_insert',
      'trg_energy_balance_snapshots_run_update',
      'trg_energy_balance_snapshots_metadata_insert',
      'trg_energy_balance_snapshots_metadata_update',
      'trg_energy_balance_snapshot_items_run_insert',
      'trg_energy_balance_snapshot_items_run_update',
      'trg_energy_balance_snapshot_items_identity_insert',
      'trg_energy_balance_snapshot_items_identity_update',
      'trg_energy_balance_suggestions_run_insert',
      'trg_energy_balance_suggestions_run_update'
    ].forEach((triggerName) => db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`));
    db.exec(ENERGY_BALANCE_RUN_BINDING_TRIGGERS_SQL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_balance_runs_boundary_created
      ON energy_balance_calculation_runs(energy_balance_boundary_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_energy_balance_runs_digest
      ON energy_balance_calculation_runs(source_data_digest, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshots_run
      ON energy_balance_snapshots(calculation_run_id, id);`);
    if (getTableCreateSql(db, 'energy_balance_snapshot_items')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshot_items_run
        ON energy_balance_snapshot_items(calculation_run_id, energy_balance_snapshot_id, role);`);
    }
    if (getTableCreateSql(db, 'energy_balance_suggestions')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_balance_suggestions_run_status
        ON energy_balance_suggestions(calculation_run_id, manual_status, priority);`);
    }
  })();

  return changed;
}

/**
 * 为 SQLite 标识符添加双引号转义。
 * @param {string} identifier 标识符。
 * @returns {string} 可安全拼接到内部迁移 SQL 的标识符。
 */
function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * 按顶层逗号拆分 CREATE TABLE 字段和表级约束，保留嵌套 CHECK 内容。
 * @param {string} definitionSql 外层括号内定义。
 * @returns {string[]} 字段和约束片段。
 */
function splitSqlDefinitionClauses(definitionSql) {
  const clauses = [];
  let clauseStart = 0;
  let parenthesisDepth = 0;
  let quoteCharacter = null;

  for (let index = 0; index < definitionSql.length; index += 1) {
    const character = definitionSql[index];
    if (quoteCharacter) {
      if (quoteCharacter === '[' && character === ']') {
        quoteCharacter = null;
      } else if (quoteCharacter !== '[' && character === quoteCharacter) {
        if (definitionSql[index + 1] === quoteCharacter) {
          index += 1;
        } else {
          quoteCharacter = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quoteCharacter = character;
    } else if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;
    } else if (character === ',' && parenthesisDepth === 0) {
      clauses.push(definitionSql.slice(clauseStart, index).trim());
      clauseStart = index + 1;
    }
  }

  clauses.push(definitionSql.slice(clauseStart).trim());
  return clauses.filter(Boolean);
}

/**
 * 判断 CREATE TABLE 片段是否定义指定字段。
 * @param {string} clause 字段或表约束片段。
 * @param {string} columnName 字段名。
 * @returns {boolean} 是否为该字段定义。
 */
function isSqlColumnClause(clause, columnName) {
  const normalizedClause = clause.trim().replace(/^["`\[]|["`\]](?=\s)/g, '');
  return new RegExp(`^${columnName}\\s`, 'i').test(normalizedClause);
}

/**
 * 判断表级约束是否为 source_batch_id 外键。
 * @param {string} clause 字段或表约束片段。
 * @returns {boolean} 是否为来源批次外键。
 */
function isBenchmarkTargetSourceForeignKeyClause(clause) {
  const normalizedClause = clause.replace(/["`\[\]]/g, ' ');
  return /^\s*(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*source_batch_id\s*\)/i.test(normalizedClause);
}

/**
 * 基于旧表 SQL 构造保留全部非来源字段和约束的规范重建 SQL。
 * @param {string} createTableSql benchmark_targets 原建表 SQL。
 * @returns {string} 临时表建表 SQL。
 */
function buildBenchmarkTargetsSourceRebuildCreateSql(createTableSql) {
  const bodyStart = createTableSql.indexOf('(');
  const bodyEnd = createTableSql.lastIndexOf(')');
  if (bodyStart < 0 || bodyEnd <= bodyStart) {
    throw new Error('benchmark_targets 建表 SQL 无法解析，禁止执行来源外键重建。');
  }

  const originalClauses = splitSqlDefinitionClauses(createTableSql.slice(bodyStart + 1, bodyEnd));
  const preservedClauses = originalClauses.filter((clause) => (
    !isSqlColumnClause(clause, 'source_batch_id')
    && !isSqlColumnClause(clause, 'source_row_number')
    && !isBenchmarkTargetSourceForeignKeyClause(clause)
  ));
  const sourceColumnClauses = [
    'source_batch_id INTEGER',
    "source_row_number INTEGER CHECK (source_row_number IS NULL OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1))"
  ];
  const idClauseIndex = preservedClauses.findIndex((clause) => isSqlColumnClause(clause, 'id'));
  preservedClauses.splice(idClauseIndex >= 0 ? idClauseIndex + 1 : 0, 0, ...sourceColumnClauses);
  preservedClauses.push(`CHECK (
    (source_batch_id IS NULL AND source_row_number IS NULL)
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)
  )`);
  preservedClauses.push('FOREIGN KEY (source_batch_id) REFERENCES import_batches(id)');

  const tableSuffix = createTableSql.slice(bodyEnd + 1).trim();
  return `CREATE TABLE benchmark_targets__migration_new (\n  ${preservedClauses.join(',\n  ')}\n)${tableSuffix ? ` ${tableSuffix}` : ''}`;
}

/**
 * 检查来源批次外键是否唯一且符合 import_batches(id) 与受限删除契约。
 * @param {object} db SQLite 数据库连接。
 * @returns {boolean} 外键是否符合契约。
 */
function benchmarkTargetsHasCorrectSourceForeignKey(db) {
  const sourceForeignKeys = db.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
    .filter((foreignKey) => foreignKey.from === 'source_batch_id');
  return sourceForeignKeys.length === 1
    && sourceForeignKeys[0].table === 'import_batches'
    && sourceForeignKeys[0].to === 'id'
    && ['NO ACTION', 'RESTRICT'].includes(String(sourceForeignKeys[0].on_delete || '').toUpperCase());
}

/**
 * 查找所有通过外键引用 benchmark_targets 的非系统表。
 * @param {object} db SQLite 数据库连接。
 * @returns {string[]} 排序后的安全引用表名。
 */
function getBenchmarkTargetsInboundForeignKeyTables(db) {
  const tableNames = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'benchmark_targets'
    ORDER BY name`).all().map((table) => table.name);
  return tableNames.filter((tableName) => db.prepare(
    `PRAGMA foreign_key_list(${quoteSqlIdentifier(tableName)})`
  ).all().some((foreignKey) => String(foreignKey.table || '').toLowerCase() === 'benchmark_targets'));
}

/**
 * 在任何表结构或数据修改前拒绝重建存在未知入向外键的 benchmark_targets。
 * @param {object} db SQLite 数据库连接。
 */
function assertBenchmarkTargetsCanBeSafelyRebuilt(db) {
  const inboundTableNames = getBenchmarkTargetsInboundForeignKeyTables(db);
  if (inboundTableNames.length > 0) {
    throw new Error(`benchmark_targets 存在入向外键引用，禁止自动重建；引用表：${JSON.stringify(inboundTableNames)}`);
  }
}

/**
 * 校验旧库已有来源字段的配对、正整数和无孤儿边界。
 * @param {object} db SQLite 数据库连接。
 */
function validateBenchmarkTargetImportSources(db) {
  const invalidSource = db.prepare(`SELECT id FROM benchmark_targets
    WHERE NOT (
      (source_batch_id IS NULL AND source_row_number IS NULL)
      OR (
        source_batch_id IS NOT NULL
        AND source_row_number IS NOT NULL
        AND typeof(source_row_number) = 'integer'
        AND source_row_number >= 1
      )
    )
    LIMIT 1`).get();
  if (invalidSource) {
    throw new Error(`benchmark_targets 存在不完整或非法导入来源，记录 ID：${invalidSource.id}`);
  }

  const orphanSource = db.prepare(`SELECT target.id
    FROM benchmark_targets AS target
    LEFT JOIN import_batches AS batch ON batch.id = target.source_batch_id
    WHERE target.source_batch_id IS NOT NULL AND batch.id IS NULL
    LIMIT 1`).get();
  if (orphanSource) {
    throw new Error(`benchmark_targets 存在孤儿导入批次引用，记录 ID：${orphanSource.id}`);
  }
}

/**
 * 规范化触发器 SQL，忽略 IF NOT EXISTS、空白和末尾分号差异。
 * @param {string} sql 触发器 SQL。
 * @returns {string} 规范化文本。
 */
function normalizeTriggerSql(sql) {
  return String(sql || '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 严格校验并按需替换两个来源触发器，避免同名弱触发器绕过约束。
 * @param {object} db SQLite 数据库连接。
 * @param {string} triggerSql 待创建的触发器 SQL。
 * @returns {boolean} 是否替换了触发器。
 */
function ensureBenchmarkTargetSourceTriggers(db, triggerSql = BENCHMARK_TARGET_SOURCE_TRIGGERS_SQL) {
  const triggerRows = new Map(db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('trg_benchmark_targets_source_insert', 'trg_benchmark_targets_source_update')`).all()
    .map((trigger) => [trigger.name, trigger.sql]));
  const usesCanonicalSql = triggerSql === BENCHMARK_TARGET_SOURCE_TRIGGERS_SQL;
  const hasCanonicalTriggers = usesCanonicalSql
    && normalizeTriggerSql(triggerRows.get('trg_benchmark_targets_source_insert')) === normalizeTriggerSql(BENCHMARK_TARGET_SOURCE_INSERT_TRIGGER_SQL)
    && normalizeTriggerSql(triggerRows.get('trg_benchmark_targets_source_update')) === normalizeTriggerSql(BENCHMARK_TARGET_SOURCE_UPDATE_TRIGGER_SQL);
  if (hasCanonicalTriggers) {
    return false;
  }

  db.exec('DROP TRIGGER IF EXISTS trg_benchmark_targets_source_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_benchmark_targets_source_update');
  db.exec(triggerSql);
  return true;
}

/**
 * 安全重建 benchmark_targets，保留原字段、约束、显式索引、非来源触发器和全部数据。
 * @param {object} db SQLite 数据库连接。
 * @param {string} createTableSql 原建表 SQL。
 */
function rebuildBenchmarkTargetsSourceForeignKey(db, createTableSql) {
  const existingColumns = getTableColumns(db, 'benchmark_targets');
  const quotedColumns = existingColumns.map(quoteSqlIdentifier).join(', ');
  const explicitIndexes = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'benchmark_targets' AND sql IS NOT NULL
    ORDER BY name`).all()
    .filter((index) => index.name !== 'idx_benchmark_targets_batch');
  const preservedTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'benchmark_targets'
      AND name NOT IN ('trg_benchmark_targets_source_insert', 'trg_benchmark_targets_source_update')
    ORDER BY name`).all();
  // 其他表上的触发器也可能查询 benchmark_targets，重建期间需暂时移除并原样恢复。
  const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name <> 'benchmark_targets'
      AND instr(lower(COALESCE(sql, '')), 'benchmark_targets') > 0
    ORDER BY name`).all();

  db.exec('DROP TABLE IF EXISTS benchmark_targets__migration_new');
  db.exec(buildBenchmarkTargetsSourceRebuildCreateSql(createTableSql));
  db.exec(`INSERT INTO benchmark_targets__migration_new (${quotedColumns})
    SELECT ${quotedColumns} FROM benchmark_targets`);
  dependentTriggers.forEach((trigger) => db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`));
  db.exec('DROP TABLE benchmark_targets');
  db.exec('ALTER TABLE benchmark_targets__migration_new RENAME TO benchmark_targets');
  explicitIndexes.forEach((index) => db.exec(index.sql));
  preservedTriggers.forEach((trigger) => db.exec(trigger.sql));
  dependentTriggers.forEach((trigger) => db.exec(trigger.sql));
}

/**
 * 查找所有通过外键引用 benchmark_definitions 的非系统表。
 * @param {object} db SQLite 数据库连接。
 * @returns {string[]} 排序后的引用表名。
 */
function getBenchmarkDefinitionsInboundForeignKeyTables(db) {
  const tableNames = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'benchmark_definitions'
    ORDER BY name`).all().map((table) => table.name);
  return tableNames.filter((tableName) => db.prepare(
    `PRAGMA foreign_key_list(${quoteSqlIdentifier(tableName)})`
  ).all().some((foreignKey) => String(foreignKey.table || '').toLowerCase() === 'benchmark_definitions'));
}

/**
 * 判断旧定义表是否仍包含外部标准文号必填约束。
 * @param {string} createTableSql 建表 SQL。
 * @returns {boolean} 是否仍有旧约束。
 */
function benchmarkDefinitionsRequireExternalDocumentNo(createTableSql) {
  const normalizedSql = normalizeSqlContractText(createTableSql);
  const legacyConstraintSql = normalizeSqlContractText(
    "benchmark_type <> 'external_standard' OR document_no IS NOT NULL"
  );
  return normalizedSql.includes(legacyConstraintSql);
}

/**
 * 校验内部修订列中的正整数和业务键唯一性，禁止静默改写已迁移结果。
 * @param {object} db SQLite 数据库连接。
 * @param {string} tableName 表名。
 * @param {string} businessKeyColumn 业务键字段。
 */
function validateBenchmarkInternalRevisions(db, tableName, businessKeyColumn) {
  const invalidRow = db.prepare(`SELECT id FROM ${quoteSqlIdentifier(tableName)}
    WHERE typeof(internal_revision) <> 'integer' OR internal_revision < 1 LIMIT 1`).get();
  if (invalidRow) {
    throw new Error(`${tableName} 存在非法内部修订，记录 ID：${invalidRow.id}`);
  }
  const duplicateRow = db.prepare(`SELECT ${quoteSqlIdentifier(businessKeyColumn)} AS businessKey,
      internal_revision AS internalRevision, COUNT(*) AS count
    FROM ${quoteSqlIdentifier(tableName)}
    GROUP BY ${quoteSqlIdentifier(businessKeyColumn)}, internal_revision
    HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicateRow) {
    throw new Error(`${tableName} 存在重复内部修订：${JSON.stringify(duplicateRow)}`);
  }
}

/**
 * 安全重建对标定义表，保留主键、行数、历史文号、历史版本、索引和触发器。
 * @param {object} db SQLite 数据库连接。
 * @param {boolean} hasInternalRevision 旧表是否已有内部修订。
 */
function rebuildBenchmarkDefinitionsForInternalRevision(db, hasInternalRevision) {
  const canonicalColumns = [
    'id', 'source_batch_id', 'source_row_number', 'benchmark_code', 'benchmark_name',
    'benchmark_type', 'metric_code', 'unit', 'period_type', 'scope_type', 'scope_reference',
    'direction', 'source', 'document_no', 'version', 'internal_revision', 'effective_start_utc',
    'effective_end_utc', 'source_timezone', 'status', 'created_at', 'updated_at'
  ];
  const requiredLegacyColumns = canonicalColumns.filter((columnName) => (
    !['source_batch_id', 'source_row_number', 'internal_revision'].includes(columnName)
  ));
  const existingColumns = getTableColumns(db, 'benchmark_definitions');
  const unsupportedColumns = existingColumns.filter((columnName) => !canonicalColumns.includes(columnName));
  const missingRequiredColumns = requiredLegacyColumns.filter((columnName) => !existingColumns.includes(columnName));
  if (unsupportedColumns.length > 0 || missingRequiredColumns.length > 0) {
    throw new Error(`benchmark_definitions 字段集合无法安全重建：${JSON.stringify({ unsupportedColumns, missingRequiredColumns })}`);
  }

  const inboundTables = getBenchmarkDefinitionsInboundForeignKeyTables(db);
  const unsupportedInboundTables = inboundTables.filter((tableName) => tableName !== 'benchmark_targets');
  if (unsupportedInboundTables.length > 0) {
    throw new Error(`benchmark_definitions 存在未知入向外键引用，禁止自动重建；引用表：${JSON.stringify(unsupportedInboundTables)}`);
  }

  const historicalSnapshot = db.prepare(`SELECT id, document_no AS documentNo, version
    FROM benchmark_definitions ORDER BY id`).all();
  const targetSnapshot = getTableCreateSql(db, 'benchmark_targets')
    ? db.prepare('SELECT id, benchmark_definition_id AS benchmarkDefinitionId FROM benchmark_targets ORDER BY id').all()
    : [];
  const explicitIndexes = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'benchmark_definitions' AND sql IS NOT NULL
    ORDER BY name`).all().filter((index) => index.name !== 'ux_benchmark_definitions_internal_revision');
  const tableTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'benchmark_definitions' ORDER BY name`).all();
  const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name <> 'benchmark_definitions'
      AND instr(lower(COALESCE(sql, '')), 'benchmark_definitions') > 0
    ORDER BY name`).all();
  const sourceBatchExpression = existingColumns.includes('source_batch_id') ? 'source_batch_id' : 'NULL';
  const sourceRowExpression = existingColumns.includes('source_row_number') ? 'source_row_number' : 'NULL';
  const revisionExpression = hasInternalRevision
    ? 'internal_revision'
    : `ROW_NUMBER() OVER (
        PARTITION BY benchmark_code ORDER BY created_at, id
      )`;

  db.exec('DROP TABLE IF EXISTS benchmark_definitions__migration_new');
  db.exec(BENCHMARK_DEFINITIONS_INTERNAL_REVISION_TABLE_SQL);
  db.exec(`INSERT INTO benchmark_definitions__migration_new (
    id, source_batch_id, source_row_number, benchmark_code, benchmark_name, benchmark_type,
    metric_code, unit, period_type, scope_type, scope_reference, direction, source, document_no,
    version, internal_revision, effective_start_utc, effective_end_utc, source_timezone, status,
    created_at, updated_at
  ) SELECT
    id, ${sourceBatchExpression}, ${sourceRowExpression}, benchmark_code, benchmark_name, benchmark_type,
    metric_code, unit, period_type, scope_type, scope_reference, direction, source, document_no,
    version, ${revisionExpression}, effective_start_utc, effective_end_utc, source_timezone, status,
    created_at, updated_at
  FROM benchmark_definitions`);
  dependentTriggers.forEach((trigger) => db.exec(`DROP TRIGGER ${quoteSqlIdentifier(trigger.name)}`));
  db.exec('DROP TABLE benchmark_definitions');
  db.exec('ALTER TABLE benchmark_definitions__migration_new RENAME TO benchmark_definitions');
  explicitIndexes.forEach((index) => db.exec(index.sql));
  tableTriggers.forEach((trigger) => db.exec(trigger.sql));
  dependentTriggers.forEach((trigger) => db.exec(trigger.sql));

  const migratedSnapshot = db.prepare(`SELECT id, document_no AS documentNo, version
    FROM benchmark_definitions ORDER BY id`).all();
  if (JSON.stringify(migratedSnapshot) !== JSON.stringify(historicalSnapshot)) {
    throw new Error('benchmark_definitions 重建后主键、历史文号或历史版本校验失败。');
  }
  if (getTableCreateSql(db, 'benchmark_targets')) {
    const migratedTargetSnapshot = db.prepare(`SELECT id, benchmark_definition_id AS benchmarkDefinitionId
      FROM benchmark_targets ORDER BY id`).all();
    if (JSON.stringify(migratedTargetSnapshot) !== JSON.stringify(targetSnapshot)) {
      throw new Error('benchmark_definitions 重建后目标主键或定义外键值发生变化。');
    }
    const definitionForeignKeys = db.prepare('PRAGMA foreign_key_list(benchmark_targets)').all()
      .filter((foreignKey) => foreignKey.from === 'benchmark_definition_id');
    if (definitionForeignKeys.length !== 1
      || definitionForeignKeys[0].table !== 'benchmark_definitions'
      || definitionForeignKeys[0].to !== 'id') {
      throw new Error('benchmark_definitions 重建后 benchmark_targets 定义外键不符合契约。');
    }
  }
}

/**
 * 为历史能效对标数据稳定回填内部修订，并解除外部标准文号必填约束。
 * @param {object} db SQLite 数据库连接。
 * @returns {boolean} 是否修改了表结构或历史修订。
 */
function migrateEnergyBenchmarkInternalRevisions(db) {
  const definitionSql = getTableCreateSql(db, 'benchmark_definitions');
  const targetSql = getTableCreateSql(db, 'benchmark_targets');
  if (!definitionSql && !targetSql) return false;

  let changed = false;
  db.transaction(() => {
    if (definitionSql) {
      const definitionColumns = getTableColumns(db, 'benchmark_definitions');
      const hasDefinitionRevision = definitionColumns.includes('internal_revision');
      if (hasDefinitionRevision) {
        validateBenchmarkInternalRevisions(db, 'benchmark_definitions', 'benchmark_code');
      }
      if (!hasDefinitionRevision || benchmarkDefinitionsRequireExternalDocumentNo(definitionSql)) {
        rebuildBenchmarkDefinitionsForInternalRevision(db, hasDefinitionRevision);
        changed = true;
      }
      validateBenchmarkInternalRevisions(db, 'benchmark_definitions', 'benchmark_code');
    }

    if (targetSql) {
      const targetColumns = getTableColumns(db, 'benchmark_targets');
      if (!targetColumns.includes('internal_revision')) {
        db.exec(`ALTER TABLE benchmark_targets ADD COLUMN internal_revision INTEGER NOT NULL DEFAULT 1
          CHECK (typeof(internal_revision) = 'integer' AND internal_revision >= 1)`);
        db.exec(`WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY benchmark_definition_id ORDER BY created_at, id
          ) AS internal_revision
          FROM benchmark_targets
        )
        UPDATE benchmark_targets SET internal_revision = (
          SELECT ranked.internal_revision FROM ranked WHERE ranked.id = benchmark_targets.id
        )`);
        changed = true;
      }
      validateBenchmarkInternalRevisions(db, 'benchmark_targets', 'benchmark_definition_id');
    }

    if (getTableCreateSql(db, 'benchmark_definitions') && getTableCreateSql(db, 'benchmark_targets')) {
      db.exec(BENCHMARK_INTERNAL_REVISION_INDEXES_SQL);
    }
    const definitionViolations = getTableCreateSql(db, 'benchmark_definitions')
      ? db.prepare('PRAGMA foreign_key_check(benchmark_definitions)').all()
      : [];
    const targetViolations = getTableCreateSql(db, 'benchmark_targets')
      ? db.prepare('PRAGMA foreign_key_check(benchmark_targets)').all()
      : [];
    if (definitionViolations.length > 0 || targetViolations.length > 0) {
      throw new Error(`能效对标内部修订迁移后外键检查失败：${JSON.stringify({ definitionViolations, targetViolations })}`);
    }
  })();
  return changed;
}

/**
 * 为阶段 2 旧库补充或修复对标目标导入来源列、外键、索引和成对约束触发器。
 * @param {object} db SQLite 数据库连接。
 * @param {string} triggerSql 来源一致性触发器 SQL，可用于隔离回滚验证。
 * @returns {boolean} 是否修改了来源字段、外键或触发器。
 */
function migrateBenchmarkTargetsImportSourceColumns(db, triggerSql = BENCHMARK_TARGET_SOURCE_TRIGGERS_SQL) {
  if (!getTableCreateSql(db, 'benchmark_targets')) {
    return false;
  }

  const initialColumns = getTableColumns(db, 'benchmark_targets');
  const requiresTableRebuild = initialColumns.includes('source_batch_id')
    && !benchmarkTargetsHasCorrectSourceForeignKey(db);
  if (requiresTableRebuild) {
    // 未知扩展子表可能使用 CASCADE、SET NULL 或 NO ACTION；统一在任何修改前拒绝自动重建。
    assertBenchmarkTargetsCanBeSafelyRebuilt(db);
  }

  let changed = false;
  db.transaction(() => {
    changed = addColumnIfMissing(
      db,
      'benchmark_targets',
      'source_batch_id',
      'source_batch_id INTEGER REFERENCES import_batches(id)'
    ) || changed;
    changed = addColumnIfMissing(
      db,
      'benchmark_targets',
      'source_row_number',
      "source_row_number INTEGER CHECK (source_row_number IS NULL OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1))"
    ) || changed;
    validateBenchmarkTargetImportSources(db);

    if (!benchmarkTargetsHasCorrectSourceForeignKey(db)) {
      rebuildBenchmarkTargetsSourceForeignKey(db, getTableCreateSql(db, 'benchmark_targets'));
      changed = true;
    }

    changed = ensureBenchmarkTargetSourceTriggers(db, triggerSql) || changed;
    db.exec('CREATE INDEX IF NOT EXISTS idx_benchmark_targets_batch ON benchmark_targets(source_batch_id)');
    if (!benchmarkTargetsHasCorrectSourceForeignKey(db)) {
      throw new Error('benchmark_targets 来源批次外键重建后仍不符合契约。');
    }
    validateBenchmarkTargetImportSources(db);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check(benchmark_targets)').all();
    if (foreignKeyViolations.length > 0) {
      throw new Error('benchmark_targets 来源迁移后外键检查失败。');
    }
  })();

  return changed;
}

/** 检查 suppliers 的规范键是否由单列唯一约束保护。 */
function supplierCodeKeyHasUniqueConstraint(db) {
  return db.prepare("SELECT name, partial FROM pragma_index_list('suppliers') WHERE [unique] = 1").all()
    .some((indexRow) => {
      if (Number(indexRow.partial || 0) !== 0) return false;
      const columns = db.prepare(`SELECT name FROM pragma_index_info('${String(indexRow.name).replace(/'/g, "''")}') ORDER BY seqno`).all();
      return columns.length === 1 && columns[0].name === 'supplier_code_key';
    });
}

/** 计算历史编码规范键并在碰撞时阻断迁移，禁止静默合并供应商。 */
function normalizeHistoricalSupplierCodes(rows) {
  const seenByKey = new Map();
  return rows.map((row) => {
    const supplierCode = normalizeSupplierCodeDisplay(row.supplierCode);
    const supplierCodeKey = buildSupplierCodeKey(supplierCode);
    if (!supplierCodeKey) {
      const error = new Error(`供应商 ${row.id} 的历史编码为空，无法安全升级规范键。`);
      error.code = 'SUPPLIER_CODE_KEY_MIGRATION_INVALID';
      throw error;
    }
    const existing = seenByKey.get(supplierCodeKey);
    if (existing) {
      const error = new Error(`供应商编码规范键迁移冲突：${existing.supplierCode} 与 ${supplierCode}。`);
      error.code = 'SUPPLIER_CODE_KEY_MIGRATION_CONFLICT';
      error.details = {
        supplierCodeKey,
        supplierIds: [existing.id, Number(row.id)],
        supplierCodes: [existing.supplierCode, supplierCode]
      };
      throw error;
    }
    const normalized = {
      ...row,
      id: Number(row.id),
      storedSupplierCode: row.supplierCode,
      supplierCode,
      supplierCodeKey
    };
    seenByKey.set(supplierCodeKey, normalized);
    return normalized;
  });
}

/** 将旧 suppliers 表安全升级为显示编码与服务端规范键双字段结构。 */
function migrateSupplierCodeKeys(db) {
  if (!getTableCreateSql(db, 'suppliers')) {
    db.exec(SUPPLIER_TABLES_SQL);
    return true;
  }

  const columnRows = db.prepare("SELECT name, [notnull] AS isNotNull FROM pragma_table_info('suppliers')").all();
  const columnNames = new Set(columnRows.map((column) => column.name));
  const hasCodeKeyColumn = columnNames.has('supplier_code_key');
  const rows = db.prepare(`SELECT id,
    supplier_code AS supplierCode,
    ${hasCodeKeyColumn ? 'supplier_code_key' : 'NULL'} AS storedSupplierCodeKey,
    supplier_name AS supplierName,
    address,
    contact_person AS contactPerson,
    contact_phone AS contactPhone,
    remarks,
    status,
    source_batch_id AS sourceBatchId,
    source_row_number AS sourceRowNumber,
    created_at AS createdAt,
    updated_at AS updatedAt
    FROM suppliers ORDER BY id`).all();
  const normalizedRows = normalizeHistoricalSupplierCodes(rows);
  const codeKeyColumn = columnRows.find((column) => column.name === 'supplier_code_key');
  const structureRequiresRebuild = !codeKeyColumn
    || Number(codeKeyColumn.isNotNull) !== 1
    || !supplierCodeKeyHasUniqueConstraint(db);
  const dataRequiresRebuild = normalizedRows.some((row) => (
    row.storedSupplierCode !== row.supplierCode
      || row.storedSupplierCodeKey !== row.supplierCodeKey
  ));

  if (!structureRequiresRebuild && !dataRequiresRebuild) {
    db.exec(SUPPLIER_INDEXES_SQL);
    return false;
  }
  if (getTableCreateSql(db, 'suppliers_code_key_legacy')) {
    const error = new Error('检测到未完成的供应商规范键迁移临时表，已阻断自动覆盖。');
    error.code = 'SUPPLIER_CODE_KEY_MIGRATION_TEMP_TABLE_EXISTS';
    throw error;
  }

  db.exec('ALTER TABLE suppliers RENAME TO suppliers_code_key_legacy');
  db.exec(SUPPLIER_TABLE_SQL);
  const insert = db.prepare(`INSERT INTO suppliers
    (id, supplier_code, supplier_code_key, supplier_name, address, contact_person,
     contact_phone, remarks, status, source_batch_id, source_row_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  normalizedRows.forEach((row) => {
    insert.run(
      row.id,
      row.supplierCode,
      row.supplierCodeKey,
      row.supplierName,
      row.address,
      row.contactPerson,
      row.contactPhone,
      row.remarks,
      row.status,
      row.sourceBatchId,
      row.sourceRowNumber,
      row.createdAt,
      row.updatedAt
    );
  });
  db.exec('DROP TABLE suppliers_code_key_legacy');
  db.exec(SUPPLIER_INDEXES_SQL);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check(suppliers)').all();
  if (foreignKeyViolations.length > 0) {
    const error = new Error('供应商规范键迁移后外键检查失败。');
    error.code = 'SUPPLIER_CODE_KEY_MIGRATION_FOREIGN_KEY_INVALID';
    error.details = { violations: foreignKeyViolations };
    throw error;
  }
  return true;
}

function ensureEnergyBudgetsTable(db) {
  const beforeSql = getTableCreateSql(db, 'energy_budgets');
  db.exec(ENERGY_BUDGETS_TABLE_SQL);
  return !beforeSql;
}

function migrateEnergyBudgetImportSourceColumns(db) {
  if (!getTableCreateSql(db, 'energy_budgets')) {
    return false;
  }
  let changed = false;
  changed = addColumnIfMissing(
    db,
    'energy_budgets',
    'source_batch_id',
    'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
  ) || changed;
  changed = addColumnIfMissing(
    db,
    'energy_budgets',
    'source_row_number',
    'source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1)'
  ) || changed;
  db.exec('CREATE INDEX IF NOT EXISTS idx_energy_budgets_batch ON energy_budgets(source_batch_id)');
  return changed;
}

function migrateImportAuditSourceColumns(db) {
  let changed = false;

  if (getTableCreateSql(db, 'production_units')) {
    // 旧库只可空补充产能单元导入来源，不重建台账或改变停用语义。
    changed = addColumnIfMissing(
      db,
      'production_units',
      'source_batch_id',
      'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
    ) || changed;
    changed = addColumnIfMissing(
      db,
      'production_units',
      'source_row_number',
      'source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1)'
    ) || changed;
    db.exec('CREATE INDEX IF NOT EXISTS idx_production_units_batch ON production_units(source_batch_id)');
  }

  if (getTableCreateSql(db, 'production_output_records')) {
    // 旧库用可空补列而非重建业务表，保留既有唯一索引与写入语义；新库 schema 仍声明完整 FK/CHECK。
    changed = addColumnIfMissing(
      db,
      'production_output_records',
      'source_batch_id',
      'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
    ) || changed;
    changed = addColumnIfMissing(
      db,
      'production_output_records',
      'source_row_number',
      'source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1)'
    ) || changed;
    db.exec('CREATE INDEX IF NOT EXISTS idx_production_output_records_batch ON production_output_records(source_batch_id)');
  }

  if (getTableCreateSql(db, 'generation_records')) {
    // 旧库用可空补列而非重建业务表，保留发电记录非联动边界与 active 唯一约束。
    changed = addColumnIfMissing(
      db,
      'generation_records',
      'source_batch_id',
      'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
    ) || changed;
    changed = addColumnIfMissing(
      db,
      'generation_records',
      'source_row_number',
      'source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1)'
    ) || changed;
    db.exec('CREATE INDEX IF NOT EXISTS idx_generation_records_batch ON generation_records(source_batch_id)');
  }

  if (getTableCreateSql(db, 'carbon_factors')) {
    // 碳因子历史数据保留；仅补充导入来源追溯列，不重建或删除既有因子/排放结果。
    changed = addColumnIfMissing(
      db,
      'carbon_factors',
      'source_batch_id',
      'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL'
    ) || changed;
    changed = addColumnIfMissing(
      db,
      'carbon_factors',
      'source_row_number',
      'source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1)'
    ) || changed;
    db.exec('CREATE INDEX IF NOT EXISTS idx_carbon_factors_batch ON carbon_factors(source_batch_id)');
  }

  return changed;
}

// 演示治理权限种入菜单但不自动关联任何既有角色，授权由后续管理员显式配置。
const DEMO_GOVERNANCE_PERMISSION_CODES = new Set([
  'system:demo:view',
  'system:demo:toggle',
  'system:demo:download',
  'system:demo:cleanup:preview',
  'system:demo:cleanup:execute'
]);

// N7 四项权限行必须保持固定按钮合同；同码非 canonical 历史行必须 fail-closed，禁止继承其普通角色授权。
const GHG_REPORT_PERMISSION_MENU_CONTRACTS = Object.freeze([
  Object.freeze({ permissionCode: 'carbon:ghg-reports:view', menuName: '温室气体报告查看', sortOrder: 612 }),
  Object.freeze({ permissionCode: 'carbon:ghg-reports:import:preview', menuName: '温室气体报告导入预演', sortOrder: 613 }),
  Object.freeze({ permissionCode: 'carbon:ghg-reports:import:execute', menuName: '温室气体报告导入执行', sortOrder: 614 }),
  Object.freeze({ permissionCode: 'carbon:ghg-reports:export', menuName: '温室气体报告导出', sortOrder: 615 })
]);

// 每项最后两个值依次为父菜单 route_path、是否在动态菜单可见；普通 user 保持个人资料最小权限。
const RBAC_MENU_SEEDS = [
  ['directory', '系统管理', '/system', null, null, 'Setting', 100, null],
  ['menu', '用户管理', '/system/users', 'system/users/index', 'system:user:view', 'User', 110, '/system'],
  ['menu', '角色管理', '/system/roles', 'system/roles/index', 'system:role:view', 'Avatar', 120, '/system'],
  ['menu', '菜单管理', '/system/menus', 'system/menus/index', 'system:menu:view', 'Menu', 130, '/system'],
  ['menu', '备份恢复', '/system/backups', 'system/backups/index', 'system:backup:view', 'FolderOpened', 140, '/system'],
  ['menu', '演示数据管理', '/system/demo-data', 'system/demo-data/index', 'system:demo:view', 'DataAnalysis', 150, '/system'],
  ['button', '演示开关维护', null, null, 'system:demo:toggle', null, 1501, '/system/demo-data'],
  ['button', '演示文件下载', null, null, 'system:demo:download', null, 1502, '/system/demo-data'],
  ['button', '演示清理预演', null, null, 'system:demo:cleanup:preview', null, 1503, '/system/demo-data'],
  ['button', '演示清理执行', null, null, 'system:demo:cleanup:execute', null, 1504, '/system/demo-data'],
  ['menu', '个人中心', '/profile', 'profile/index', 'system:profile:update', 'UserFilled', 10, null, 0],
  ['menu', '中控', '/dashboard', 'dashboard/index', 'dashboard:view', 'DataBoard', 20, null],
  ['directory', '能耗管理', '/energy', null, null, 'TrendCharts', 40, null],
  ['menu', '能耗统计', '/energy/statistics', 'energy/statistics/index', 'energy:records:view', 'Histogram', 41, '/energy'],
  ['menu', '用能预算', '/energy/budgets', 'energy/budgets/index', 'energy:budget:view', 'Wallet', 42, '/energy'],
  ['menu', '能耗数据导入', '/imports', 'imports/index', 'imports:view', 'UploadFilled', 43, '/energy'],
  ['button', '上传普通能耗', null, null, 'imports:create', null, 1, '/imports'],
  ['button', '删除普通能耗批次', null, null, 'imports:delete', null, 2, '/imports'],
  ['button', '下载导入原文件', null, null, 'imports:download', null, 3, '/imports'],
  ['menu', '能源消费分析', '/energy/analysis', 'energy/analysis/index', 'energy:analysis:view', 'DataAnalysis', 44, '/energy'],
  ['button', '分析配置查看', null, null, 'energy:analysis:config:view', null, 4401, '/energy/analysis'],
  ['button', '排班配置维护', null, null, 'energy:analysis:shift:manage', null, 4402, '/energy/analysis'],
  ['button', '峰谷方案维护', null, null, 'energy:analysis:tou:manage', null, 4403, '/energy/analysis'],
  ['button', '策略规则维护', null, null, 'energy:strategy:rule:manage', null, 4404, '/energy/analysis'],
  ['button', '策略预演', null, null, 'energy:strategy:evaluate', null, 4405, '/energy/analysis'],
  ['button', '策略运行', null, null, 'energy:strategy:run', null, 4406, '/energy/analysis'],
  ['button', '策略复核', null, null, 'energy:strategy:review', null, 4407, '/energy/analysis'],
  ['button', '时序导入预演', null, null, 'energy:analysis:timeseries:preview', null, 4408, '/energy/analysis'],
  ['button', '时序导入执行', null, null, 'energy:analysis:timeseries:execute', null, 4409, '/energy/analysis'],
  ['button', '运营记录导入预演', null, null, 'energy:analysis:operations:preview', null, 4410, '/energy/analysis'],
  ['button', '运营记录导入执行', null, null, 'energy:analysis:operations:execute', null, 4411, '/energy/analysis'],
  ['button', '分析配置导入预演', null, null, 'energy:analysis:config:import:preview', null, 4412, '/energy/analysis'],
  ['button', '分析配置导入执行', null, null, 'energy:analysis:config:import:execute', null, 4413, '/energy/analysis'],
  ['menu', '能效对标', '/energy/benchmarks', 'energy/benchmarks/index', 'energy:benchmarks:view', 'Aim', 45, '/energy'],
  ['button', '对标配置维护', null, null, 'energy:benchmarks:manage', null, 4501, '/energy/benchmarks'],
  ['button', '对标分析', null, null, 'energy:benchmarks:analyze', null, 4502, '/energy/benchmarks'],
  ['button', '对标导出', null, null, 'energy:benchmarks:export', null, 4503, '/energy/benchmarks'],
  ['button', '对标导入预演', null, null, 'energy:benchmarks:import:preview', null, 4504, '/energy/benchmarks'],
  ['button', '对标导入执行', null, null, 'energy:benchmarks:import:execute', null, 4505, '/energy/benchmarks'],
  ['menu', '能流分析', '/energy/flows', 'energy/flows/index', 'energy:flows:view', 'Share', 46, '/energy'],
  ['button', '能流配置维护', null, null, 'energy:flows:manage', null, 4601, '/energy/flows'],
  ['button', '能流导入预演', null, null, 'energy:flows:import:preview', null, 4602, '/energy/flows'],
  ['button', '能流导入执行', null, null, 'energy:flows:import:execute', null, 4603, '/energy/flows'],
  ['menu', '能效平衡与优化', '/energy/balances', 'energy/balances/index', 'energy:balance:view', 'ScaleToOriginal', 47, '/energy'],
  ['button', '平衡配置维护', null, null, 'energy:balance:manage', null, 4701, '/energy/balances'],
  ['button', '平衡快照计算', null, null, 'energy:balance:calculate', null, 4702, '/energy/balances'],
  ['button', '优化建议复核', null, null, 'energy:balance:suggestion:review', null, 4703, '/energy/balances'],
  ['button', '平衡配置导入预演', null, null, 'energy:balance:import:preview', null, 4704, '/energy/balances'],
  ['button', '平衡配置导入执行', null, null, 'energy:balance:import:execute', null, 4705, '/energy/balances'],
  ['directory', '基础台账', '/ledger', null, null, 'Collection', 50, null],
  ['menu', '组织管理', '/ledger/organization', 'ledger/organization/index', 'ledger:units:view', 'OfficeBuilding', 51, '/ledger'],
  ['menu', '计量器具', '/ledger/meters', 'ledger/meters/index', 'ledger:meters:view', 'Monitor', 52, '/ledger'],
  ['menu', '计量抄表', '/ledger/meter-readings', 'ledger/meter-readings/index', 'ledger:readings:view', 'DocumentChecked', 53, '/ledger'],
  ['button', '抄表转能耗预演', null, null, 'ledger:readings:preview', null, 531, '/ledger/meter-readings'],
  ['button', '抄表转能耗执行', null, null, 'ledger:readings:execute', null, 532, '/ledger/meter-readings'],
  ['menu', '生产单元', '/ledger/production-units', 'ledger/production-units/index', 'ledger:production-unit:view', 'Box', 54, '/ledger'],
  ['menu', '月度产量', '/ledger/production-output', 'ledger/production-output/index', 'ledger:production-output:view', 'Tickets', 55, '/ledger'],
  ['menu', '发电自用', '/ledger/generation', 'ledger/generation/index', 'ledger:generation:view', 'Lightning', 56, '/ledger'],
  ['menu', '供应商管理', '/ledger/suppliers', 'ledger/suppliers/index', 'ledger:suppliers:view', 'Van', 57, '/ledger'],
  ['button', '供应商新增', null, null, 'ledger:suppliers:create', null, 571, '/ledger/suppliers'],
  ['button', '供应商编辑', null, null, 'ledger:suppliers:update', null, 572, '/ledger/suppliers'],
  ['button', '供应商合作状态', null, null, 'ledger:suppliers:status', null, 573, '/ledger/suppliers'],
  ['button', '供应商导入预演', null, null, 'ledger:suppliers:import:preview', null, 574, '/ledger/suppliers'],
  ['button', '供应商导入执行', null, null, 'ledger:suppliers:import:execute', null, 575, '/ledger/suppliers'],
  ['button', '供应商导出', null, null, 'ledger:suppliers:export', null, 576, '/ledger/suppliers'],
  ['button', '产能单元模板下载', null, null, 'ledger:production:template', null, 541, '/ledger/production-units'],
  ['button', '产能单元导入', null, null, 'ledger:production:import', null, 542, '/ledger/production-units'],
  ['button', '产能单元导出', null, null, 'ledger:production:export', null, 543, '/ledger/production-units'],
  ['menu', '碳核算', '/carbon', 'carbon/index', 'carbon:emissions:view', 'WindPower', 60, null],
  ['button', '碳因子查看', null, null, 'carbon:factors:view', null, 601, '/carbon'],
  ['button', '旧能耗碳排放导出', null, null, 'carbon:emissions:export', null, 607, '/carbon'],
  ['button', '独立碳活动查看', null, null, 'carbon:activities:view', null, 602, '/carbon'],
  ['button', '独立碳活动导入预演', null, null, 'carbon:activities:import:preview', null, 603, '/carbon'],
  ['button', '独立碳活动导入执行', null, null, 'carbon:activities:import:execute', null, 604, '/carbon'],
  ['button', '独立碳活动计算', null, null, 'carbon:activities:calculate', null, 605, '/carbon'],
  ['button', '独立碳活动导出', null, null, 'carbon:activities:export', null, 606, '/carbon'],
  ['button', '碳排放报告查看', null, null, 'carbon:emission-reports:view', null, 608, '/carbon'],
  ['button', '碳排放报告导入预演', null, null, 'carbon:emission-reports:import:preview', null, 609, '/carbon'],
  ['button', '碳排放报告导入执行', null, null, 'carbon:emission-reports:import:execute', null, 610, '/carbon'],
  ['button', '碳排放报告导出', null, null, 'carbon:emission-reports:export', null, 611, '/carbon'],
  ['button', '温室气体报告查看', null, null, 'carbon:ghg-reports:view', null, 612, '/carbon'],
  ['button', '温室气体报告导入预演', null, null, 'carbon:ghg-reports:import:preview', null, 613, '/carbon'],
  ['button', '温室气体报告导入执行', null, null, 'carbon:ghg-reports:import:execute', null, 614, '/carbon'],
  ['button', '温室气体报告导出', null, null, 'carbon:ghg-reports:export', null, 615, '/carbon'],

  ['menu', '预测管理', '/predictions', 'predictions/index', 'prediction:config:view', 'DataAnalysis', 70, null],
  ['button', '预测配置新增', null, null, 'prediction:config:create', null, 702, '/predictions'],
  ['button', '预测配置编辑', null, null, 'prediction:config:update', null, 703, '/predictions'],
  ['button', '预测配置状态', null, null, 'prediction:config:status', null, 704, '/predictions'],
  ['button', '预测配置导入', null, null, 'prediction:config:import', null, 705, '/predictions'],
  ['button', '预测配置导出', null, null, 'prediction:config:export', null, 706, '/predictions'],
  ['button', '预测配置模板', null, null, 'prediction:config:template', null, 707, '/predictions'],
  ['button', '预测运行创建', null, null, 'prediction:run:create', null, 708, '/predictions'],
  ['button', '预测运行查看', null, null, 'prediction:run:view', null, 709, '/predictions'],
  ['button', '预测运行取消归档', null, null, 'prediction:run:cancel', null, 710, '/predictions'],
  ['button', '预测运行导出', null, null, 'prediction:run:export', null, 711, '/predictions'],
  ['button', '预测结果查看', null, null, 'prediction:result:view', null, 712, '/predictions'],
  ['button', '预测结果导出', null, null, 'prediction:result:export', null, 713, '/predictions'],
  ['button', '用户新增', null, null, 'system:user:create', null, 111, '/system/users'],
  ['button', '用户编辑', null, null, 'system:user:update', null, 112, '/system/users'],
  ['button', '用户启停', null, null, 'system:user:status', null, 113, '/system/users'],
  ['button', '用户分配角色', null, null, 'system:user:assign-role', null, 114, '/system/users'],
  ['button', '用户删除', null, null, 'system:user:delete', null, 115, '/system/users'],
  ['button', '用户重置密码', null, null, 'system:user:reset-password', null, 116, '/system/users'],
  ['button', '角色新增', null, null, 'system:role:create', null, 121, '/system/roles'],
  ['button', '角色编辑', null, null, 'system:role:update', null, 122, '/system/roles'],
  ['button', '角色启停', null, null, 'system:role:status', null, 123, '/system/roles'],
  ['button', '角色分配菜单', null, null, 'system:role:assign-menu', null, 124, '/system/roles'],
  ['button', '角色删除', null, null, 'system:role:delete', null, 125, '/system/roles'],
  ['button', '菜单新增', null, null, 'system:menu:create', null, 131, '/system/menus'],
  ['button', '菜单编辑', null, null, 'system:menu:update', null, 132, '/system/menus'],
  ['button', '菜单启停', null, null, 'system:menu:status', null, 133, '/system/menus'],
  ['button', '菜单删除', null, null, 'system:menu:delete', null, 134, '/system/menus'],
  ['button', '修改密码', null, null, 'system:profile:change-password', null, 11, '/profile']
];

// 旧种子菜单使用页面旧名；升级时永远保留旧菜单 ID 与其角色关联。
// 同名 canonical 行可能来自早期按钮种子，故只合并其授权后删除，不用它覆盖旧页面的路由/组件/可见性。
const RBAC_LEGACY_VIEW_MIGRATIONS = [
  { legacyPermissionCode: 'energy:statistics:view', permissionCode: 'energy:records:view' },
  { legacyPermissionCode: 'ledger:organization:view', permissionCode: 'ledger:units:view' },
  { legacyPermissionCode: 'ledger:meter:view', permissionCode: 'ledger:meters:view' },
  { legacyPermissionCode: 'ledger:meter-reading:view', permissionCode: 'ledger:readings:view' },
  { legacyPermissionCode: 'carbon:view', permissionCode: 'carbon:emissions:view', dependentViewPermissionCodes: ['carbon:factors:view'] },
  { legacyPermissionCode: 'prediction:view', permissionCode: 'prediction:config:view', dependentViewPermissionCodes: ['prediction:run:view', 'prediction:result:view'] }
];

function migrateLegacyViewMenuPermission(db, migration, timestamp = new Date().toISOString()) {
  const legacyMenu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(migration.legacyPermissionCode);
  if (!legacyMenu) return false;

  const canonicalMenu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(migration.permissionCode);
  const grant = db.prepare(`INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at)
    SELECT role_id, ?, created_at FROM sys_role_menus WHERE menu_id = ?`);
  (migration.dependentViewPermissionCodes || []).forEach((permissionCode) => {
    const dependentMenu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
    if (dependentMenu) grant.run(dependentMenu.id, legacyMenu.id);
  });

  if (!canonicalMenu || canonicalMenu.id === legacyMenu.id) {
    db.prepare('UPDATE sys_menus SET permission_code = ?, updated_at = ? WHERE id = ?')
      .run(migration.permissionCode, timestamp, legacyMenu.id);
    return true;
  }

  // 角色原有 canonical 查看授权也归并到保留的旧菜单 ID，避免重复菜单或关联丢失。
  grant.run(legacyMenu.id, canonicalMenu.id);
  // permission_code 唯一约束要求先释放新增种子占用的 canonical 键，再提升保留的旧行。
  db.prepare('UPDATE sys_menus SET permission_code = NULL, updated_at = ? WHERE id = ?').run(timestamp, canonicalMenu.id);
  db.prepare('UPDATE sys_menus SET permission_code = ?, updated_at = ? WHERE id = ?')
    .run(migration.permissionCode, timestamp, legacyMenu.id);
  // 新版细分按钮可能已挂到临时 canonical 页面，删除前必须迁移到保留的旧页面 ID。
  db.prepare('UPDATE sys_menus SET parent_id = ? WHERE parent_id = ?').run(legacyMenu.id, canonicalMenu.id);
  db.prepare('DELETE FROM sys_role_menus WHERE menu_id = ?').run(canonicalMenu.id);
  db.prepare('DELETE FROM sys_menus WHERE id = ?').run(canonicalMenu.id);
  return true;
}

function migrateLegacyViewMenuPermissions(db, timestamp = new Date().toISOString()) {
  return RBAC_LEGACY_VIEW_MIGRATIONS.reduce((changed, migration) => migrateLegacyViewMenuPermission(db, migration, timestamp) || changed, false);
}

/**
 * 将 /carbon 页面导航与 emissions 查看权限拆分：保留最早父菜单 ID，并把历史角色授权复制到独立按钮。
 * @param {object} db SQLite 数据库连接。
 * @param {string} timestamp 迁移时间。
 * @returns {boolean} 是否发生变更。
 */
function migrateCarbonMenuPermissionStructure(db, timestamp = new Date().toISOString()) {
  const carbonMenus = db.prepare(`SELECT id, permission_code AS permissionCode
    FROM sys_menus WHERE route_path = '/carbon' AND menu_type = 'menu' ORDER BY id`).all();
  if (carbonMenus.length === 0) return false;
  const parentMenuId = carbonMenus[0].id;
  let changed = false;
  // 仅迁移拆分前真正由旧 emissions/carbon:view 页面承载的角色；父页面已无权限后不得把后续 activity-only 导航授权扩成 emissions 权限。
  const legacyEmissionsRoleGrants = carbonMenus
    .filter((menu) => ['carbon:view', 'carbon:emissions:view'].includes(menu.permissionCode))
    .flatMap((menu) => db.prepare(`SELECT role_id AS roleId, created_at AS createdAt
      FROM sys_role_menus WHERE menu_id = ?`).all(menu.id));
  const grantFromMenu = db.prepare(`INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at)
    SELECT role_id, ?, created_at FROM sys_role_menus WHERE menu_id = ?`);
  carbonMenus.slice(1).forEach((duplicateMenu) => {
    grantFromMenu.run(parentMenuId, duplicateMenu.id);
    db.prepare('UPDATE sys_menus SET parent_id = ? WHERE parent_id = ?').run(parentMenuId, duplicateMenu.id);
    db.prepare('UPDATE sys_menus SET permission_code = NULL, updated_at = ? WHERE id = ?')
      .run(timestamp, duplicateMenu.id);
    db.prepare('DELETE FROM sys_role_menus WHERE menu_id = ?').run(duplicateMenu.id);
    db.prepare('DELETE FROM sys_menus WHERE id = ?').run(duplicateMenu.id);
    changed = true;
  });

  const parentMenu = db.prepare('SELECT permission_code AS permissionCode FROM sys_menus WHERE id = ?').get(parentMenuId);
  if (parentMenu.permissionCode !== null) {
    db.prepare('UPDATE sys_menus SET permission_code = NULL, updated_at = ? WHERE id = ?')
      .run(timestamp, parentMenuId);
    changed = true;
  }
  let emissionsButton = db.prepare("SELECT id FROM sys_menus WHERE permission_code = 'carbon:emissions:view'").get();
  if (!emissionsButton) {
    emissionsButton = {
      id: db.prepare(`INSERT INTO sys_menus
        (parent_id, menu_type, menu_name, route_path, component, permission_code, icon,
         sort_order, visible, status, is_builtin, created_at, updated_at)
        VALUES (?, 'button', '碳排放查看', NULL, NULL, 'carbon:emissions:view', NULL,
          600, 1, 'active', 1, ?, ?)`).run(parentMenuId, timestamp, timestamp).lastInsertRowid
    };
    changed = true;
  } else {
    const normalizeResult = db.prepare(`UPDATE sys_menus
      SET parent_id = ?, menu_type = 'button', menu_name = '碳排放查看', route_path = NULL,
        component = NULL, icon = NULL, sort_order = 600, visible = 1, status = 'active',
        is_builtin = 1, updated_at = ?
      WHERE id = ? AND (parent_id IS NOT ? OR menu_type <> 'button' OR menu_name <> '碳排放查看'
        OR route_path IS NOT NULL OR component IS NOT NULL OR sort_order <> 600 OR status <> 'active')`)
      .run(parentMenuId, timestamp, emissionsButton.id, parentMenuId);
    changed = normalizeResult.changes > 0 || changed;
  }
  const grantLegacyEmissionsRole = db.prepare(`INSERT OR IGNORE INTO sys_role_menus
    (role_id, menu_id, created_at) VALUES (?, ?, ?)`);
  legacyEmissionsRoleGrants.forEach((roleGrant) => {
    grantLegacyEmissionsRole.run(roleGrant.roleId, emissionsButton.id, roleGrant.createdAt || timestamp);
  });
  return changed;
}

function migrateLegacyImportMenuPermission(db, timestamp = new Date().toISOString()) {
  const legacyMenu = db.prepare("SELECT id FROM sys_menus WHERE permission_code = 'import:view'").get();
  if (!legacyMenu) return false;

  const canonicalMenu = db.prepare("SELECT id FROM sys_menus WHERE permission_code = 'imports:view'").get();
  if (!canonicalMenu) {
    db.prepare("UPDATE sys_menus SET permission_code = 'imports:view', updated_at = ? WHERE id = ?")
      .run(timestamp, legacyMenu.id);
    return true;
  }

  // 极少数人工配置过新版菜单的旧库：将旧授权合并到新版菜单后移除旧键，避免遗留双权限口径。
  db.prepare(`INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at)
    SELECT role_id, ?, created_at FROM sys_role_menus WHERE menu_id = ?`)
    .run(canonicalMenu.id, legacyMenu.id);
  db.prepare('UPDATE sys_menus SET parent_id = ? WHERE parent_id = ?').run(canonicalMenu.id, legacyMenu.id);
  db.prepare('DELETE FROM sys_role_menus WHERE menu_id = ?').run(legacyMenu.id);
  db.prepare('DELETE FROM sys_menus WHERE id = ?').run(legacyMenu.id);
  return true;
}

// 将历史 /dashboard 菜单名称幂等升级为“中控”，只更新名称并保留原菜单身份与授权。
function migrateDashboardMenuName(db, timestamp = new Date().toISOString()) {
  const dashboardResult = db.prepare(`UPDATE sys_menus SET menu_name = '中控', updated_at = ?
    WHERE route_path = '/dashboard' AND menu_name <> '中控'`).run(timestamp);
  return dashboardResult.changes > 0;
}

function migrateNavigationMenuStructure(db, timestamp = new Date().toISOString()) {
  // 中控更名迁移必须先复用旧菜单 ID，避免角色关联或动态路由契约变化。
  const dashboardChanged = migrateDashboardMenuName(db, timestamp);
  // 个人中心保留权限与角色关联，但只能通过固定路由和右上角用户菜单访问。
  const profileResult = db.prepare(`UPDATE sys_menus SET visible = 0, updated_at = ?
    WHERE (route_path = '/profile' OR permission_code = 'system:profile:update') AND visible <> 0`).run(timestamp);
  const energyMenu = db.prepare("SELECT id FROM sys_menus WHERE route_path = '/energy' AND menu_type = 'directory'").get();
  const importMenu = db.prepare("SELECT id FROM sys_menus WHERE route_path = '/imports' OR permission_code = 'imports:view'").get();
  if (!energyMenu || !importMenu) {
    return dashboardChanged || profileResult.changes > 0;
  }

  // 复用既有导入菜单 ID，仅调整层级和展示名称，避免丢失既有角色授权或产生重复菜单。
  const importResult = db.prepare(`UPDATE sys_menus SET parent_id = ?, menu_name = ?, updated_at = ?
    WHERE id = ? AND (parent_id IS NOT ? OR menu_name <> ?)`)
    .run(energyMenu.id, '能耗数据导入', timestamp, importMenu.id, energyMenu.id, '能耗数据导入');
  return dashboardChanged || profileResult.changes > 0 || importResult.changes > 0;
}

// 合并旧版重复创建的内置目录，保留最早 ID、已有角色授权及所有子菜单归属。
function dedupeBuiltinDirectoryMenus(db) {
  const directoryRoutes = RBAC_MENU_SEEDS
    .filter(([menuType]) => menuType === 'directory')
    .map(([, , routePath]) => routePath)
    .filter(Boolean);
  let changed = false;
  const grant = db.prepare(`INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at)
    SELECT role_id, ?, created_at FROM sys_role_menus WHERE menu_id = ?`);
  const moveChildren = db.prepare('UPDATE sys_menus SET parent_id = ? WHERE parent_id = ?');
  const removeGrants = db.prepare('DELETE FROM sys_role_menus WHERE menu_id = ?');
  const removeMenu = db.prepare('DELETE FROM sys_menus WHERE id = ?');

  directoryRoutes.forEach((routePath) => {
    const directories = db.prepare(`SELECT id FROM sys_menus
      WHERE menu_type = 'directory' AND route_path = ? ORDER BY id`).all(routePath);
    if (directories.length < 2) return;
    const canonicalId = directories[0].id;
    directories.slice(1).forEach((directory) => {
      moveChildren.run(canonicalId, directory.id);
      grant.run(canonicalId, directory.id);
      removeGrants.run(directory.id);
      removeMenu.run(directory.id);
      changed = true;
    });
  });

  return changed;
}

/** 补齐缺失的 N7 权限按钮，并对同权限码旧行执行严格 canonical 碰撞校验。 */
function ensureCanonicalGhgReportPermissionMenus(db, timestamp = new Date().toISOString()) {
  const carbonParent = db.prepare(`SELECT id FROM sys_menus
    WHERE route_path = '/carbon' AND menu_type = 'menu' ORDER BY id LIMIT 1`).get();
  if (!carbonParent) {
    const error = new Error('温室气体报告权限种子缺少 canonical /carbon 父菜单。');
    error.code = 'GHG_REPORT_PERMISSION_PARENT_MISSING';
    throw error;
  }
  const insertPermissionMenu = db.prepare(`INSERT INTO sys_menus
    (parent_id, menu_type, menu_name, route_path, component, permission_code, icon,
     sort_order, visible, status, is_builtin, created_at, updated_at)
    VALUES (?, 'button', ?, NULL, NULL, ?, NULL, ?, 1, 'active', 1, ?, ?)`);
  GHG_REPORT_PERMISSION_MENU_CONTRACTS.forEach((contract) => {
    let menu = db.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType,
      menu_name AS menuName, route_path AS routePath, component, icon,
      sort_order AS sortOrder, visible, status, is_builtin AS isBuiltin
      FROM sys_menus WHERE permission_code = ?`).get(contract.permissionCode);
    if (!menu) {
      const result = insertPermissionMenu.run(
        carbonParent.id,
        contract.menuName,
        contract.permissionCode,
        contract.sortOrder,
        timestamp,
        timestamp
      );
      menu = db.prepare(`SELECT id, parent_id AS parentId, menu_type AS menuType,
        menu_name AS menuName, route_path AS routePath, component, icon,
        sort_order AS sortOrder, visible, status, is_builtin AS isBuiltin
        FROM sys_menus WHERE id = ?`).get(result.lastInsertRowid);
    }
    const invalidFields = [];
    if (menu.parentId !== carbonParent.id) invalidFields.push('parent_id');
    if (menu.menuType !== 'button') invalidFields.push('menu_type');
    if (menu.menuName !== contract.menuName) invalidFields.push('menu_name');
    if (menu.routePath !== null) invalidFields.push('route_path');
    if (menu.component !== null) invalidFields.push('component');
    if (menu.icon !== null) invalidFields.push('icon');
    if (menu.sortOrder !== contract.sortOrder) invalidFields.push('sort_order');
    if (menu.visible !== 1) invalidFields.push('visible');
    if (menu.status !== 'active') invalidFields.push('status');
    if (menu.isBuiltin !== 1) invalidFields.push('is_builtin');
    if (invalidFields.length > 0) {
      const error = new Error(`温室气体报告权限码存在非 canonical 历史行：${contract.permissionCode}`);
      error.code = 'GHG_REPORT_PERMISSION_MENU_COLLISION';
      error.details = { permissionCode: contract.permissionCode, invalidFields };
      throw error;
    }
  });
}

function ensureRbacSeedData(db) {
  const bcrypt = require('bcryptjs');
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    migrateLegacyImportMenuPermission(db, now);
    db.prepare(`INSERT OR IGNORE INTO sys_roles (role_code, role_name, description, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 1, ?, ?)`)
      .run('super_admin', '系统管理员', '系统内置管理员角色。', now, now);
    db.prepare(`INSERT OR IGNORE INTO sys_roles (role_code, role_name, description, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 1, ?, ?)`)
      .run('user', '普通用户', '注册用户的最低权限角色。', now, now);

    dedupeBuiltinDirectoryMenus(db);
    const systemMenu = db.prepare(`SELECT id FROM sys_menus
      WHERE menu_type = 'directory' AND permission_code IS NULL AND route_path = ? ORDER BY id LIMIT 1`).get('/system');
    let systemMenuId = systemMenu && systemMenu.id;
    if (!systemMenuId) {
      systemMenuId = db.prepare(`INSERT INTO sys_menus (menu_type, menu_name, route_path, icon, sort_order, visible, status, is_builtin, created_at, updated_at)
        VALUES ('directory', '系统管理', '/system', 'Setting', 100, 1, 'active', 1, ?, ?)`)
        .run(now, now).lastInsertRowid;
    }
    const insertMenu = db.prepare(`INSERT OR IGNORE INTO sys_menus
      (parent_id, menu_type, menu_name, route_path, component, permission_code, icon, sort_order, visible, status, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`);
    const menuIdByRoute = new Map(db.prepare('SELECT id, route_path AS routePath FROM sys_menus WHERE route_path IS NOT NULL').all()
      .map((menu) => [menu.routePath, menu.id]));
    menuIdByRoute.set('/system', systemMenuId);
    RBAC_MENU_SEEDS.slice(1).forEach(([menuType, menuName, routePath, component, permissionCode, icon, sortOrder, parentRoutePath, visible = 1]) => {
      const parentId = parentRoutePath ? menuIdByRoute.get(parentRoutePath) : null;
      if (parentRoutePath && !parentId) {
        throw new Error(`RBAC 菜单种子缺少父菜单：${parentRoutePath}`);
      }
      // directory 没有 permission_code 唯一键；按路由复用既有目录，避免每次初始化新增顶层菜单。
      if (menuType === 'directory' && routePath && menuIdByRoute.has(routePath)) {
        return;
      }
      insertMenu.run(parentId || null, menuType, menuName, routePath, component, permissionCode, icon, sortOrder, visible, now, now);
      if (routePath) {
        const menu = db.prepare('SELECT id FROM sys_menus WHERE route_path = ? ORDER BY id LIMIT 1').get(routePath);
        menuIdByRoute.set(routePath, menu.id);
      }
    });
    migrateLegacyViewMenuPermissions(db, now);
    migrateCarbonMenuPermissionStructure(db, now);
    migrateNavigationMenuStructure(db, now);
    ensureCanonicalGhgReportPermissionMenus(db, now);

    const adminRole = db.prepare("SELECT id FROM sys_roles WHERE role_code = 'super_admin'").get();
    const userRole = db.prepare("SELECT id FROM sys_roles WHERE role_code = 'user'").get();
    const allMenus = db.prepare(`SELECT id, permission_code AS permissionCode
      FROM sys_menus WHERE status = 'active'`).all();
    const profileMenus = db.prepare("SELECT id FROM sys_menus WHERE permission_code IN ('system:profile:update', 'system:profile:change-password')").all();
    const grant = db.prepare('INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    allMenus
      .filter((menu) => !DEMO_GOVERNANCE_PERMISSION_CODES.has(menu.permissionCode))
      .forEach((menu) => grant.run(adminRole.id, menu.id, now));
    profileMenus.forEach((menu) => grant.run(userRole.id, menu.id, now));

    let admin = db.prepare("SELECT id, status FROM sys_users WHERE username = 'admin'").get();
    if (!admin || admin.status !== 'active') {
      const configuredPassword = String(process.env.CHARCOAL_ADMIN_PASSWORD || '');
      if (!configuredPassword) {
        throw new Error('缺少 CHARCOAL_ADMIN_PASSWORD：首次初始化或恢复停用管理员时必须配置管理员密码，服务不会创建默认高权限密码。');
      }
      if (configuredPassword.length < 8) {
        throw new Error('CHARCOAL_ADMIN_PASSWORD 至少需要 8 个字符。');
      }
      const passwordHash = bcrypt.hashSync(configuredPassword, 12);
      if (admin) {
        db.prepare("UPDATE sys_users SET password_hash = ?, status = 'active', is_builtin = 1, updated_at = ? WHERE id = ?")
          .run(passwordHash, now, admin.id);
      } else {
        const result = db.prepare(`INSERT INTO sys_users
          (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
          VALUES ('admin', '系统管理员', ?, 'active', 1, ?, ?)`)
          .run(passwordHash, now, now);
        admin = { id: result.lastInsertRowid };
      }
    }
    db.prepare('INSERT OR IGNORE INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(admin.id, adminRole.id, now);
  });
  transaction();
}

/** 将 seed 行转换为稳定业务键，避免 candidate 校验依赖自增主键。 */
function getStableMenuBusinessKey(menu) {
  if (menu.permissionCode) return `permission:${menu.permissionCode}`;
  if (menu.routePath) return `route:${menu.routePath}`;
  return `name:${menu.menuType}:${menu.menuName}`;
}

/** 读取当前数据库中的稳定 RBAC 与能源 reference seed 合同。 */
function readCanonicalSeedContract(db) {
  const roles = db.prepare(`SELECT role_code AS roleCode, role_name AS roleName, description,
      status, is_builtin AS isBuiltin FROM sys_roles ORDER BY role_code`).all();
  const menuRows = db.prepare(`SELECT m.id, m.parent_id AS parentId, m.menu_type AS menuType,
      m.menu_name AS menuName, m.route_path AS routePath, m.component,
      m.permission_code AS permissionCode, m.icon, m.sort_order AS sortOrder,
      m.visible, m.status, m.is_builtin AS isBuiltin
    FROM sys_menus m ORDER BY m.id`).all();
  const menuKeyById = new Map(menuRows.map((menu) => [menu.id, getStableMenuBusinessKey(menu)]));
  const menus = menuRows.map((menu) => ({
    key: getStableMenuBusinessKey(menu),
    parentKey: menu.parentId === null ? null : menuKeyById.get(menu.parentId) || null,
    menuType: menu.menuType,
    menuName: menu.menuName,
    routePath: menu.routePath,
    component: menu.component,
    permissionCode: menu.permissionCode,
    icon: menu.icon,
    sortOrder: menu.sortOrder,
    visible: menu.visible,
    status: menu.status,
    isBuiltin: menu.isBuiltin
  })).sort((left, right) => left.key.localeCompare(right.key));
  const grants = db.prepare(`SELECT r.role_code AS roleCode, m.id AS menuId,
      m.menu_type AS menuType, m.menu_name AS menuName, m.route_path AS routePath,
      m.permission_code AS permissionCode
    FROM sys_role_menus rm JOIN sys_roles r ON r.id = rm.role_id
    JOIN sys_menus m ON m.id = rm.menu_id ORDER BY r.role_code, m.id`).all()
    .map((grant) => ({
      roleCode: grant.roleCode,
      menuKey: menuKeyById.get(grant.menuId)
        || getStableMenuBusinessKey(grant)
    }))
    .sort((left, right) => left.roleCode.localeCompare(right.roleCode)
      || left.menuKey.localeCompare(right.menuKey));
  const energyTypes = db.prepare(`SELECT code, name, category, default_unit AS defaultUnit,
      standard_unit AS standardUnit, carbon_factor_required AS carbonFactorRequired,
      is_active AS isActive, display_order AS displayOrder
    FROM energy_types ORDER BY code`).all();
  return { roles, menus, grants, energyTypes };
}

/** 从 schema.sql 与当前 RBAC seed 逻辑构造独立内存 reference contract。 */
function getCanonicalSeedContract() {
  const Database = loadDatabaseDriver();
  const referenceDb = new Database(':memory:');
  try {
    registerEnergyAnalysisSqliteFunctions(referenceDb);
    const schemaText = fs.readFileSync(schemaPath, 'utf8');
    referenceDb.exec(schemaText);
    ensureRbacSeedData(referenceDb);
    return readCanonicalSeedContract(referenceDb);
  } finally {
    referenceDb.close();
  }
}

/** 读取初始化前的数据库身份；全部持久 schema 对象为空时才视为全新库。 */
function readExistingSchemaIdentity(db) {
  const userSchemaObjects = db.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name`).all();
  if (userSchemaObjects.length === 0) {
    return { fresh: true, version: null, stage: null, fingerprint: null, fingerprintAlgorithm: null };
  }
  const hasAppMeta = userSchemaObjects.some((row) => row.type === 'table' && row.name === 'app_meta');
  if (!hasAppMeta) {
    const error = new Error('检测到没有 schema 身份的现有 SQLite，正式版本禁止自动升级未知旧库；请按授权边界清空后重建。');
    error.code = 'UNKNOWN_EXISTING_SCHEMA';
    throw error;
  }
  const metadata = Object.fromEntries(db.prepare(`SELECT key, value FROM app_meta
    WHERE key IN ('schema_stage', 'schema_version', 'schema_fingerprint', 'schema_fingerprint_algorithm')`).all()
    .map((row) => [row.key, row.value]));
  const acceptedVersions = new Set([CANONICAL_SCHEMA_VERSION, CANONICAL_SCHEMA_PREDECESSOR_VERSION]);
  if (!acceptedVersions.has(metadata.schema_version)
    || metadata.schema_stage !== CANONICAL_SCHEMA_STAGE) {
    const error = new Error('现有 SQLite 不是当前正式 canonical 版本或唯一已授权 predecessor，已拒绝历史迁移或自动修补。');
    error.code = 'INCOMPATIBLE_EXISTING_SCHEMA';
    error.details = {
      expectedStage: CANONICAL_SCHEMA_STAGE,
      expectedVersion: CANONICAL_SCHEMA_VERSION,
      actualStage: metadata.schema_stage || null,
      actualVersion: metadata.schema_version || null
    };
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(String(metadata.schema_fingerprint || ''))
    || metadata.schema_fingerprint_algorithm !== CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM) {
    const error = new Error('现有正式 SQLite 缺少有效 schema fingerprint，已拒绝继续初始化。');
    error.code = 'SCHEMA_FINGERPRINT_MISSING';
    throw error;
  }
  return {
    fresh: false,
    version: metadata.schema_version,
    stage: metadata.schema_stage,
    fingerprint: metadata.schema_fingerprint,
    fingerprintAlgorithm: metadata.schema_fingerprint_algorithm
  };
}

/** 基于 sqlite_master 的规范 SQL 生成稳定结构指纹，不包含业务数据和 SQLite 自动索引。 */
function calculateSchemaFingerprint(db) {
  const schemaRows = db.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name`).all();
  const canonicalSchema = schemaRows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tableName,
    sql: String(row.sql).replace(/\s+/g, ' ').trim()
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonicalSchema), 'utf8').digest('hex');
}

/** 返回 sqlite_master 对象的稳定 profile 键。 */
function getSchemaObjectProfileKey(schemaObject) {
  return `${schemaObject.type}:${schemaObject.name}:${schemaObject.tableName}`;
}

/** 读取全部显式 schema 对象，供精确旧结构 profile 比对。 */
function readSchemaObjectProfile(db) {
  return new Map(db.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name`).all().map((schemaObject) => (
    [getSchemaObjectProfileKey(schemaObject), schemaObject]
  )));
}

/** 按正式指纹算法计算指定对象 profile，并允许替换已审核对象 SQL。 */
function calculateSchemaObjectProfileFingerprint(schemaProfile, sqlOverrides = new Map()) {
  // profile 指纹对象按 sqlite_master 查询使用的稳定字段顺序排序。
  const canonicalSchema = [...schemaProfile.values()]
    .sort((left, right) => {
      const leftKey = [left.type, left.name, left.tableName].join('|');
      const rightKey = [right.type, right.name, right.tableName].join('|');
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((schemaObject) => {
      // SQL override 来自已审核的 ALTER 物理结构；去除执行分号以匹配 sqlite_master.sql。
      const profileKey = getSchemaObjectProfileKey(schemaObject);
      const profileSql = sqlOverrides.has(profileKey)
        ? String(sqlOverrides.get(profileKey)).replace(/;\s*$/, '')
        : schemaObject.sql;
      return {
        type: schemaObject.type,
        name: schemaObject.name,
        tableName: schemaObject.tableName,
        sql: String(profileSql).replace(/\s+/g, ' ').trim()
      };
    });
  return crypto.createHash('sha256').update(JSON.stringify(canonicalSchema), 'utf8').digest('hex');
}

/** 规范化 schema profile SQL，仅忽略 IF NOT EXISTS、空白和简单标识符引号差异。 */
function normalizeSchemaObjectProfileSql(sql) {
  return normalizeSqlContractText(sql)
    .replace(/^create ((?:unique )?index|table|trigger|view) if not exists /, 'create $1 ');
}

/** 判断 CREATE TABLE 顶层片段是否为平衡来源字段、来源外键或成对约束。 */
function isEnergyBalanceImportSourceClause(clause) {
  if (isSqlColumnClause(clause, 'source_batch_id') || isSqlColumnClause(clause, 'source_row_number')) {
    return true;
  }
  const normalizedClause = normalizeSqlContractText(clause);
  const isSourceForeignKey = normalizedClause.startsWith('foreign key ( source_batch_id )');
  const isSourcePairCheck = normalizedClause.startsWith('check (')
    && normalizedClause.includes('source_batch_id')
    && normalizedClause.includes('source_row_number');
  return isSourceForeignKey || isSourcePairCheck;
}

/** 判断 CREATE TABLE 顶层片段是否为表级约束。 */
function isTableConstraintClause(clause) {
  return /^(?:constraint\b|primary\s+key\b|unique\b|check\b|foreign\s+key\b)/i.test(clause.trim());
}

/**
 * 从当前 schema 精确派生已知旧来源表或 ALTER 补列后的目标表 SQL。
 * @param {string} schemaText 完整事务化 schema 文本。
 * @param {string} tableName 平衡边界或项目表名。
 * @param {boolean} migrated 是否生成 ALTER ADD COLUMN 后的目标结构。
 * @returns {string} 用于 profile 比对的建表 SQL。
 */
function buildEnergyBalanceImportSourceProfileTableSql(schemaText, tableName, migrated) {
  const canonicalTableSql = extractNamedCreateStatement(schemaText, 'table', tableName);
  const bodyStart = canonicalTableSql.indexOf('(');
  const bodyEnd = canonicalTableSql.lastIndexOf(')');
  if (!canonicalTableSql || bodyStart < 0 || bodyEnd <= bodyStart) {
    throw new Error(`无法从 canonical schema 提取平衡来源表：${tableName}`);
  }
  const canonicalClauses = splitSqlDefinitionClauses(canonicalTableSql.slice(bodyStart + 1, bodyEnd));
  const legacyClauses = canonicalClauses.filter((clause) => !isEnergyBalanceImportSourceClause(clause));
  if (legacyClauses.length >= canonicalClauses.length
    || normalizeSqlContractText(legacyClauses.join(',')).includes('source_batch_id')
    || normalizeSqlContractText(legacyClauses.join(',')).includes('source_row_number')) {
    throw new Error(`无法精确派生平衡来源旧表 profile：${tableName}`);
  }
  if (migrated) {
    // SQLite 会把 ALTER ADD COLUMN 字段写在原字段与表级约束之间，必须精确复现该目标 SQL。
    const firstConstraintIndex = legacyClauses.findIndex(isTableConstraintClause);
    const sourceColumnIndex = firstConstraintIndex < 0 ? legacyClauses.length : firstConstraintIndex;
    legacyClauses.splice(
      sourceColumnIndex,
      0,
      'source_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL',
      'source_row_number INTEGER'
    );
  }
  return `CREATE TABLE ${tableName} (\n  ${legacyClauses.join(',\n  ')}\n);`;
}

/** 构造两张平衡表经 ALTER ADD COLUMN 后唯一已审核的 SQL override。 */
function buildEnergyBalanceImportSourceMigratedSqlOverrides(schemaText) {
  return new Map([
    [
      'table:energy_balance_boundaries:energy_balance_boundaries',
      buildEnergyBalanceImportSourceProfileTableSql(schemaText, 'energy_balance_boundaries', true)
    ],
    [
      'table:energy_balance_items:energy_balance_items',
      buildEnergyBalanceImportSourceProfileTableSql(schemaText, 'energy_balance_items', true)
    ]
  ]);
}

/** 判断 CREATE TABLE 顶层片段是否为 strategy_rules provenance 字段或成对约束。 */
function isStrategyRulesProvenanceClause(clause) {
  if (isSqlColumnClause(clause, 'source_batch_id') || isSqlColumnClause(clause, 'source_row_number')) {
    return true;
  }
  const normalizedClause = normalizeSqlContractText(clause);
  return normalizedClause.startsWith('foreign key ( source_batch_id )')
    || (normalizedClause.startsWith('check (')
      && normalizedClause.includes('source_batch_id')
      && normalizedClause.includes('source_row_number'));
}

/** 从当前 schema 精确派生 strategy_rules v2 predecessor 建表 SQL。 */
function buildStrategyRulesPredecessorTableSql(schemaText) {
  const canonicalTableSql = extractNamedCreateStatement(schemaText, 'table', 'strategy_rules');
  const bodyStart = canonicalTableSql.indexOf('(');
  const bodyEnd = canonicalTableSql.lastIndexOf(')');
  if (!canonicalTableSql || bodyStart < 0 || bodyEnd <= bodyStart) {
    throw new Error('无法从 canonical schema 提取 strategy_rules predecessor 建表 SQL。');
  }
  const canonicalClauses = splitSqlDefinitionClauses(canonicalTableSql.slice(bodyStart + 1, bodyEnd));
  const removedClauses = canonicalClauses.filter(isStrategyRulesProvenanceClause);
  const predecessorClauses = canonicalClauses.filter((clause) => !isStrategyRulesProvenanceClause(clause));
  if (removedClauses.length !== 4
    || predecessorClauses.some((clause) => normalizeSqlContractText(clause).includes('source_batch_id')
      || normalizeSqlContractText(clause).includes('source_row_number'))) {
    throw new Error('strategy_rules provenance predecessor profile 无法由 canonical schema 精确派生。');
  }
  return `CREATE TABLE strategy_rules (\n  ${predecessorClauses.join(',\n  ')}\n);`;
}

/** 构造 strategy_rules v2 predecessor 的唯一 SQL override。 */
function buildStrategyRulesPredecessorSqlOverrides(schemaText) {
  return new Map([
    [
      'table:strategy_rules:strategy_rules',
      buildStrategyRulesPredecessorTableSql(schemaText)
    ]
  ]);
}

/** 精确校验 strategy_rules v2 predecessor profile，拒绝 partial 或未知 SQL 漂移。 */
function assertStrategyRulesPredecessorSchemaProfile(
  db,
  schemaText,
  canonicalProfile,
  predecessorOverrides = buildStrategyRulesPredecessorSqlOverrides(schemaText)
) {
  const issues = compareSchemaObjectProfile(
    readSchemaObjectProfile(db),
    canonicalProfile,
    new Set(),
    predecessorOverrides
  );
  if (issues.length > 0) {
    const error = new Error('当前 SQLite 不符合 strategy_rules provenance 已授权 predecessor profile。');
    error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
    error.details = { profileStage: 'strategy-rules-predecessor', issues: issues.slice(0, 20) };
    throw error;
  }
  return predecessorOverrides;
}

/** 迁移 strategy_rules provenance，同时保留业务行、主键、高水位、索引及入向外键。 */
function migrateStrategyRulesProvenance(
  db,
  schemaText,
  canonicalProfile = buildCanonicalSchemaObjectProfile(schemaText),
  predecessorOverrides = buildStrategyRulesPredecessorSqlOverrides(schemaText)
) {
  assertStrategyRulesPredecessorSchemaProfile(
    db,
    schemaText,
    canonicalProfile,
    predecessorOverrides
  );
  const oldColumns = [
    'id', 'rule_code', 'rule_name', 'rule_version', 'formula_version', 'metric_code',
    'threshold_operator', 'threshold_value', 'threshold_min', 'threshold_max',
    'threshold_unit', 'reduction_rate', 'priority', 'evidence_requirements_json',
    'recommendation_text', 'source', 'effective_start_utc', 'effective_end_utc',
    'source_timezone', 'status', 'created_at', 'updated_at'
  ];
  const oldRows = db.prepare(`SELECT ${oldColumns.join(', ')} FROM strategy_rules ORDER BY id`).all();
  const sequenceRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'strategy_rules'").get();
  const oldMaxId = oldRows.reduce((maximum, row) => Math.max(maximum, Number(row.id)), 0);
  const preservedIndexes = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'strategy_rules' AND sql IS NOT NULL ORDER BY name"
  ).all().map((row) => row.sql);
  const preservedTriggers = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'strategy_rules' AND sql IS NOT NULL ORDER BY name"
  ).all().map((row) => row.sql);

  db.exec('DROP TABLE IF EXISTS temp.strategy_rules__migration_backup');
  db.exec('CREATE TEMP TABLE strategy_rules__migration_backup AS SELECT * FROM strategy_rules ORDER BY id');
  db.exec('DROP TABLE strategy_rules');
  db.exec(extractNamedCreateStatement(schemaText, 'table', 'strategy_rules'));
  db.exec(`INSERT INTO strategy_rules (${[
    'id', 'source_batch_id', 'source_row_number', ...oldColumns.slice(1)
  ].join(', ')}) SELECT ${[
    'id', 'NULL', 'NULL', ...oldColumns.slice(1)
  ].join(', ')} FROM temp.strategy_rules__migration_backup ORDER BY id`);
  preservedIndexes.forEach((sql) => db.exec(sql));
  preservedTriggers.forEach((sql) => db.exec(sql));

  const targetSequence = Math.max(
    Number(sequenceRow?.seq || 0),
    oldMaxId
  );
  if (sequenceRow) {
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'strategy_rules'").run(targetSequence);
  } else if (targetSequence > 0) {
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('strategy_rules', ?)").run(targetSequence);
  }
  db.exec('DROP TABLE temp.strategy_rules__migration_backup');

  const newRows = db.prepare(`SELECT ${oldColumns.join(', ')} FROM strategy_rules ORDER BY id`).all();
  if (JSON.stringify(newRows) !== JSON.stringify(oldRows)) {
    const error = new Error('strategy_rules provenance 迁移未逐值保留历史业务行。');
    error.code = 'STRATEGY_RULES_MIGRATION_DATA_LOSS';
    throw error;
  }
  const invalidProvenance = db.prepare(`SELECT id FROM strategy_rules
    WHERE source_batch_id IS NOT NULL OR source_row_number IS NOT NULL LIMIT 1`).get();
  if (invalidProvenance) {
    const error = new Error('历史正式 strategy_rules provenance 必须保持 NULL/NULL。');
    error.code = 'STRATEGY_RULES_MIGRATION_PROVENANCE_INVALID';
    error.details = invalidProvenance;
    throw error;
  }
  return { predecessorOverrides, migrated: true };
}

/** 迁移后精确复核 strategy_rules canonical profile 与历史 NULL/NULL provenance。 */
function assertStrategyRulesMigratedSchemaProfile(
  db,
  schemaText,
  canonicalProfile,
  targetOverrides = new Map()
) {
  const issues = compareSchemaObjectProfile(
    readSchemaObjectProfile(db),
    canonicalProfile,
    new Set(),
    targetOverrides
  );
  if (issues.length > 0) {
    const error = new Error('strategy_rules provenance 迁移后未命中 canonical schema profile。');
    error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
    error.details = { profileStage: 'strategy-rules-migrated', issues: issues.slice(0, 20) };
    throw error;
  }
  const invalidProvenance = db.prepare(`SELECT id FROM strategy_rules
    WHERE source_batch_id IS NOT NULL OR source_row_number IS NOT NULL LIMIT 1`).get();
  if (invalidProvenance) {
    const error = new Error('strategy_rules 历史正式规则不得被回填 provenance。');
    error.code = 'STRATEGY_RULES_MIGRATION_PROVENANCE_INVALID';
    error.details = invalidProvenance;
    throw error;
  }
}

/** 在隔离内存库执行 schema，生成不受业务数据影响的 canonical 对象 profile。 */
function buildCanonicalSchemaObjectProfile(schemaText) {
  const Database = loadDatabaseDriver();
  const referenceDb = new Database(':memory:');
  try {
    registerEnergyAnalysisSqliteFunctions(referenceDb);
    referenceDb.exec(schemaText);
    return readSchemaObjectProfile(referenceDb);
  } finally {
    referenceDb.close();
  }
}

/** 精确生成缺少两张后置动作治理表及其索引的 predecessor profile。 */
function buildLegacyDemoPostActionSchemaProfile(schemaText, sqlOverrides = new Map()) {
  const Database = loadDatabaseDriver();
  const referenceDb = new Database(':memory:');
  try {
    registerEnergyAnalysisSqliteFunctions(referenceDb);
    referenceDb.exec(schemaText);
    referenceDb.exec(`DROP TRIGGER IF EXISTS trg_demo_dataset_runs_post_action_dataset_update;
      DROP TABLE demo_post_action_outputs;
      DROP TABLE demo_post_action_runs;`);
    const profile = readSchemaObjectProfile(referenceDb);
    return {
      profile,
      sqlOverrides,
      fingerprint: calculateSchemaObjectProfileFingerprint(profile, sqlOverrides)
    };
  } finally {
    referenceDb.close();
  }
}

/** 返回新切片治理对象在完整 canonical profile 中的显式对象键。 */
function getDemoPostActionSchemaObjectKeys(canonicalProfile) {
  const postActionTriggerKeys = new Set([
    'trigger:trg_demo_dataset_runs_post_action_dataset_update:demo_dataset_runs'
  ]);
  return new Set([...canonicalProfile.entries()]
    .filter(([key, schemaObject]) => (
      ['demo_post_action_runs', 'demo_post_action_outputs'].includes(schemaObject.tableName)
      || postActionTriggerKeys.has(key)
    ))
    .map(([key]) => key));
}

/** 比较实际对象与指定 canonical profile，返回缺失、额外和 SQL 漂移对象。 */
function compareSchemaObjectProfile(actualProfile, canonicalProfile, omittedKeys, sqlOverrides) {
  const expectedKeys = [...canonicalProfile.keys()].filter((key) => !omittedKeys.has(key)).sort();
  const actualKeys = [...actualProfile.keys()].sort();
  const issues = [];
  expectedKeys.filter((key) => !actualProfile.has(key)).forEach((key) => issues.push(`missing:${key}`));
  actualKeys.filter((key) => !canonicalProfile.has(key) || omittedKeys.has(key))
    .forEach((key) => issues.push(`unexpected:${key}`));
  expectedKeys.filter((key) => actualProfile.has(key)).forEach((key) => {
    const actualSql = actualProfile.get(key).sql;
    const expectedSql = sqlOverrides.get(key) || canonicalProfile.get(key).sql;
    if (normalizeSchemaObjectProfileSql(actualSql) !== normalizeSchemaObjectProfileSql(expectedSql)) {
      issues.push(`changed:${key}`);
    }
  });
  return issues;
}

/**
 * 从全新 canonical 与平衡来源 ALTER 两个已审核 profile 中选择精确匹配项。
 * @returns {object} 迁移后 canonical 复核继续使用的 profile、SQL override 和指纹。
 */
function selectDemoPostActionPredecessorSchemaProfile(db, schemaText, admissionFingerprint) {
  // 实际对象 profile 只读取 sqlite_master，不接触业务数据。
  const actualProfile = readSchemaObjectProfile(db);
  // canonical 候选保持 schema.sql 全新建表物理结构。
  const canonicalCandidate = buildLegacyDemoPostActionSchemaProfile(schemaText);
  canonicalCandidate.profileName = 'canonical';
  // ALTER 候选仅替换两张平衡表 SQL，其他对象仍必须与 canonical 完全一致。
  const alteredCandidate = buildLegacyDemoPostActionSchemaProfile(
    schemaText,
    buildEnergyBalanceImportSourceMigratedSqlOverrides(schemaText)
  );
  alteredCandidate.profileName = 'energy-balance-alter';
  // 候选评估同时要求对象 profile 和正式 fingerprint 精确命中。
  const candidateEvaluations = [canonicalCandidate, alteredCandidate].map((candidate) => ({
    ...candidate,
    issues: compareSchemaObjectProfile(actualProfile, candidate.profile, new Set(), candidate.sqlOverrides)
  }));
  const matchingCandidates = candidateEvaluations.filter((candidate) => (
    candidate.fingerprint === admissionFingerprint && candidate.issues.length === 0
  ));
  if (matchingCandidates.length === 1) return matchingCandidates[0];

  const error = new Error('当前 SQLite 不符合后置动作治理表已授权 predecessor profile。');
  error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
  error.details = {
    profileStage: 'demo-post-action-predecessor',
    actual: admissionFingerprint,
    expectedProfiles: candidateEvaluations.map((candidate) => ({
      profileName: candidate.profileName,
      fingerprint: candidate.fingerprint
    })),
    issues: candidateEvaluations.flatMap((candidate) => (
      candidate.issues.map((issue) => `${candidate.profileName}:${issue}`)
    )).slice(0, 20)
  };
  throw error;
}

/** 基于 schema.sql 和已审核 ALTER 契约生成当前版及唯一 predecessor 的可信 profiles。 */
function buildTrustedCanonicalSchemaProfiles() {
  const schemaText = fs.readFileSync(schemaPath, 'utf8')
    .replace(/^PRAGMA journal_mode = WAL;\s*/i, '')
    .replace(/^PRAGMA foreign_keys = ON;\s*/i, '');
  const canonicalProfile = buildCanonicalSchemaObjectProfile(schemaText);
  const alteredOverrides = buildEnergyBalanceImportSourceMigratedSqlOverrides(schemaText);
  const currentProfiles = [
    {
      profileName: 'canonical',
      profile: canonicalProfile,
      sqlOverrides: new Map(),
      fingerprint: calculateSchemaObjectProfileFingerprint(canonicalProfile)
    },
    {
      profileName: 'energy-balance-alter',
      profile: canonicalProfile,
      sqlOverrides: alteredOverrides,
      fingerprint: calculateSchemaObjectProfileFingerprint(canonicalProfile, alteredOverrides)
    }
  ];
  const strategyPredecessorOverrides = buildStrategyRulesPredecessorSqlOverrides(schemaText);
  const strategyPredecessorProfiles = [
    {
      profileName: 'strategy-rules-predecessor',
      profile: canonicalProfile,
      sqlOverrides: strategyPredecessorOverrides,
      fingerprint: calculateSchemaObjectProfileFingerprint(canonicalProfile, strategyPredecessorOverrides)
    },
    {
      profileName: 'energy-balance-alter-strategy-rules-predecessor',
      profile: canonicalProfile,
      sqlOverrides: new Map([
        ...alteredOverrides.entries(),
        ...strategyPredecessorOverrides.entries()
      ]),
      fingerprint: calculateSchemaObjectProfileFingerprint(canonicalProfile, new Map([
        ...alteredOverrides.entries(),
        ...strategyPredecessorOverrides.entries()
      ]))
    }
  ];
  return new Map([
    [CANONICAL_SCHEMA_VERSION, currentProfiles],
    [CANONICAL_SCHEMA_PREDECESSOR_VERSION, strategyPredecessorProfiles]
  ]);
}

/**
 * 将来源 SQLite 的实际 sqlite_master 与代码控制的可信 profile 精确比对。
 * metadata 只用于选择允许版本，不能自行声明新的可信 fingerprint。
 */
function matchTrustedCanonicalSchemaProfile(db, schemaVersion) {
  const trustedProfiles = buildTrustedCanonicalSchemaProfiles().get(schemaVersion) || [];
  const actualProfile = readSchemaObjectProfile(db);
  const actualFingerprint = calculateSchemaFingerprint(db);
  const evaluations = trustedProfiles.map((candidate) => ({
    ...candidate,
    issues: compareSchemaObjectProfile(actualProfile, candidate.profile, new Set(), candidate.sqlOverrides)
  }));
  const selected = evaluations.find((candidate) => (
    candidate.fingerprint === actualFingerprint && candidate.issues.length === 0
  ));
  if (!selected) {
    const error = new Error('当前 SQLite 未命中代码控制的 canonical schema profile。');
    error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
    error.details = {
      schemaVersion,
      actualFingerprint,
      expectedProfiles: evaluations.map((candidate) => ({
        profileName: candidate.profileName,
        fingerprint: candidate.fingerprint
      })),
      issues: evaluations.flatMap((candidate) => candidate.issues
        .map((issue) => `${candidate.profileName}:${issue}`)).slice(0, 20)
    };
    throw error;
  }
  return {
    profileName: selected.profileName,
    fingerprint: selected.fingerprint,
    schemaVersion,
    profile: selected.profile,
    sqlOverrides: selected.sqlOverrides
  };
}

/** 构造 canonical profile 不匹配错误，统一保持初始化 fail-closed。 */
function createEnergyBalanceImportSourceProfileError(profileStage, issues) {
  const error = new Error('当前 SQLite 不符合已授权的平衡来源 canonical 迁移 profile。');
  error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
  error.details = { profileStage, issues: issues.slice(0, 20) };
  return error;
}

/** 构造后置动作治理表 profile 不匹配错误，避免复用其他领域的错误语义。 */
function createDemoPostActionSchemaProfileError(profileStage, issues) {
  const error = new Error('当前 SQLite 不符合已授权的后置动作治理 canonical 迁移 profile。');
  error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
  error.details = { profileStage, issues: issues.slice(0, 20) };
  return error;
}

/**
 * 在任何结构写入前验证旧库仅缺少已授权的平衡来源对象，并拒绝全部无关漂移。
 * @returns {Map<string, object>} 后续迁移后复核复用的 canonical profile。
 */
function assertEnergyBalanceImportSourceLegacySchemaProfile(
  db,
  schemaText,
  canonicalProfile = buildCanonicalSchemaObjectProfile(schemaText)
) {
  const actualProfile = readSchemaObjectProfile(db);
  const balanceSourceKeys = new Set(ENERGY_BALANCE_IMPORT_SOURCE_SCHEMA_OBJECTS.map(getSchemaObjectProfileKey));
  const flowSourceKeys = ENERGY_FLOW_IMPORT_SOURCE_TRIGGER_SCHEMA_OBJECTS.map(getSchemaObjectProfileKey);
  const presentFlowSourceKeys = flowSourceKeys.filter((key) => actualProfile.has(key));
  if (![0, flowSourceKeys.length].includes(presentFlowSourceKeys.length)) {
    throw createEnergyBalanceImportSourceProfileError('legacy', ['partial:energy-flow-import-source-triggers']);
  }
  if (presentFlowSourceKeys.length === 0) {
    flowSourceKeys.forEach((key) => balanceSourceKeys.add(key));
  }
  const legacySqlOverrides = new Map([
    [
      'table:energy_balance_boundaries:energy_balance_boundaries',
      buildEnergyBalanceImportSourceProfileTableSql(schemaText, 'energy_balance_boundaries', false)
    ],
    [
      'table:energy_balance_items:energy_balance_items',
      buildEnergyBalanceImportSourceProfileTableSql(schemaText, 'energy_balance_items', false)
    ]
  ]);
  const issues = compareSchemaObjectProfile(actualProfile, canonicalProfile, balanceSourceKeys, legacySqlOverrides);
  if (issues.length > 0) {
    throw createEnergyBalanceImportSourceProfileError('legacy', issues);
  }
  return canonicalProfile;
}

/** 迁移后要求对象集合与 canonical 完全一致，仅允许两个表呈现已审核的 ALTER 补列结构。 */
function assertEnergyBalanceImportSourceMigratedSchemaProfile(db, schemaText, canonicalProfile) {
  const migratedSqlOverrides = buildEnergyBalanceImportSourceMigratedSqlOverrides(schemaText);
  const issues = compareSchemaObjectProfile(
    readSchemaObjectProfile(db),
    canonicalProfile,
    new Set(),
    migratedSqlOverrides
  );
  if (issues.length > 0) {
    throw createEnergyBalanceImportSourceProfileError('migrated', issues);
  }
}

/** 提交前复核后置动作跨表数据合同，防止历史弱表中的 dataset 或输出计数漂移进入 canonical。 */
function verifyDemoPostActionDataContracts(db) {
  const datasetMismatch = db.prepare(`SELECT action.action_run_id AS actionRunId,
      action.run_id AS runId, action.dataset_id AS datasetId,
      dataset.dataset_id AS parentDatasetId
    FROM demo_post_action_runs action
    LEFT JOIN demo_dataset_runs dataset ON dataset.run_id = action.run_id
    WHERE dataset.run_id IS NULL OR dataset.dataset_id <> action.dataset_id
    ORDER BY action.action_run_id LIMIT 1`).get();
  if (datasetMismatch) {
    const error = new Error('后置动作运行 dataset_id 与父运行不一致。');
    error.code = 'DEMO_POST_ACTION_DATASET_MISMATCH';
    error.details = datasetMismatch;
    throw error;
  }
  const outputCountMismatch = db.prepare(`SELECT action.action_run_id AS actionRunId,
      action.output_count AS outputCount, COUNT(output.output_id) AS actualOutputCount
    FROM demo_post_action_runs action
    LEFT JOIN demo_post_action_outputs output ON output.action_run_id = action.action_run_id
    GROUP BY action.action_run_id
    HAVING action.output_count <> COUNT(output.output_id)
    ORDER BY action.action_run_id LIMIT 1`).get();
  if (outputCountMismatch) {
    const error = new Error('后置动作运行 output_count 与输出明细行数不一致。');
    error.code = 'DEMO_POST_ACTION_OUTPUT_COUNT_MISMATCH';
    error.details = outputCountMismatch;
    throw error;
  }
}

/** 运行 SQLite 完整性检查，任何非 ok 结果或外键违规都阻断初始化完成。 */
function verifyCanonicalDatabaseIntegrity(db) {
  const quickCheck = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  const integrityCheck = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') {
    const error = new Error('SQLite quick_check 未通过。');
    error.code = 'SQLITE_QUICK_CHECK_FAILED';
    error.details = { quickCheck };
    throw error;
  }
  if (integrityCheck.length !== 1 || integrityCheck[0] !== 'ok') {
    const error = new Error('SQLite integrity_check 未通过。');
    error.code = 'SQLITE_INTEGRITY_CHECK_FAILED';
    error.details = { integrityCheck };
    throw error;
  }
  if (foreignKeyViolations.length > 0) {
    const error = new Error('SQLite foreign_key_check 未通过。');
    error.code = 'SQLITE_FOREIGN_KEY_CHECK_FAILED';
    error.details = { foreignKeyViolations };
    throw error;
  }
  return { quickCheck: 'ok', integrityCheck: 'ok', foreignKeyViolations: [] };
}

function initDatabase(options = {}) {
  const targetDatabasePath = options.databasePath ? path.resolve(options.databasePath) : databasePath;
  const isOfficialDatabase = path.resolve(targetDatabasePath) === path.resolve(databasePath);
  if (isOfficialDatabase && databasePoisoned) {
    throw createDatabasePoisonedError();
  }
  if (isOfficialDatabase) {
    reconcilePendingDatabaseRestore();
  }
  const db = openDatabase({ databasePath: targetDatabasePath, admissionPermit: options.admissionPermit });
  try {
    const existingIdentity = readExistingSchemaIdentity(db);
    // journal_mode 不能在活动事务中切换；正式库只允许当前版本或唯一 predecessor 的精确迁移。
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    if (String(journalMode).toLowerCase() !== 'wal') {
      throw new Error('SQLite 数据库未能进入 WAL 日志模式。');
    }
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const transactionalSchema = schema
      .replace(/^PRAGMA journal_mode = WAL;\s*/i, '')
      .replace(/^PRAGMA foreign_keys = ON;\s*/i, '');
    // canonical v3 仅允许当前版本幂等初始化，或 v2 strategy_rules provenance 唯一 predecessor 迁移。
    let canonicalSchemaMigrated = false;
    let canonicalSchemaProfile = null;
    let strategyRulesProvenanceMigrated = false;
    let strategyRulesCanonicalProfile = null;
    let trustedAdmissionProfile = null;
    const shouldDisableForeignKeys = !existingIdentity.fresh;
    const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
    if (shouldDisableForeignKeys && wasForeignKeysEnabled) {
      // strategy_rules 是 strategy_rule_hits 的父表，必须在同一初始化事务开始前关闭 pragma，
      // 否则 SQLite 会阻止父表重建且无法在活动事务内切换 foreign_keys。
      db.pragma('foreign_keys = OFF');
    }
    try {
      db.transaction(() => {
        if (!existingIdentity.fresh) {
          trustedAdmissionProfile = matchTrustedCanonicalSchemaProfile(
            db,
            existingIdentity.version
          );
          const admissionFingerprint = calculateSchemaFingerprint(db);
          if (admissionFingerprint !== existingIdentity.fingerprint
            || admissionFingerprint !== trustedAdmissionProfile.fingerprint) {
            const error = new Error('当前 SQLite 结构与代码控制的 schema fingerprint 不一致。');
            error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
            error.details = {
              metadataFingerprint: existingIdentity.fingerprint,
              actual: admissionFingerprint,
              trustedFingerprint: trustedAdmissionProfile.fingerprint
            };
            throw error;
          }
          if (existingIdentity.version === CANONICAL_SCHEMA_PREDECESSOR_VERSION) {
            strategyRulesProvenanceMigrated = true;
            strategyRulesCanonicalProfile = buildCanonicalSchemaObjectProfile(transactionalSchema);
          }
        }

      if (!existingIdentity.fresh) {
        const balanceSourceColumnsMissing = ['energy_balance_boundaries', 'energy_balance_items']
          .some((tableName) => {
            const columns = getTableColumns(db, tableName);
            return !columns.includes('source_batch_id') || !columns.includes('source_row_number');
          });
        if (balanceSourceColumnsMissing) {
          // 来源列必须先于 schema 中引用这些列的索引创建，且旧库必须精确匹配已审查 profile。
          canonicalSchemaProfile = buildCanonicalSchemaObjectProfile(transactionalSchema);
          assertEnergyBalanceImportSourceLegacySchemaProfile(db, transactionalSchema, canonicalSchemaProfile);
          canonicalSchemaMigrated = migrateEnergyBalanceImportSourceColumns(db);
        }
        if (strategyRulesProvenanceMigrated) {
          migrateStrategyRulesProvenance(
            db,
            transactionalSchema,
            strategyRulesCanonicalProfile,
            trustedAdmissionProfile?.sqlOverrides
          );
        }
      }
      // schema.sql 是最终新库唯一事实源；已有非 canonical 库在进入这里前已被拒绝。
      db.exec(transactionalSchema);
      assertDemoGovernanceContracts(db);
      verifyDemoPostActionDataContracts(db);
      ensureRbacSeedData(db);
      const fingerprint = calculateSchemaFingerprint(db);
      if (existingIdentity.fresh) {
        // 全新 schema 执行完成后、写入 app_meta 前必须命中代码控制的 current canonical profile。
        trustedAdmissionProfile = matchTrustedCanonicalSchemaProfile(db, CANONICAL_SCHEMA_VERSION);
        if (trustedAdmissionProfile.profileName !== 'canonical'
          || trustedAdmissionProfile.fingerprint !== fingerprint) {
          const error = new Error('全新 SQLite 结构与代码控制的 current canonical fingerprint 不一致。');
          error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
          error.details = {
            actual: fingerprint,
            trustedProfileName: trustedAdmissionProfile.profileName,
            trustedFingerprint: trustedAdmissionProfile.fingerprint
          };
          throw error;
        }
      }
      if (!existingIdentity.fresh && canonicalSchemaMigrated) {
        // 迁移后仍需精确复核目标 profile，任何无关对象漂移都会使事务回滚。
        assertEnergyBalanceImportSourceMigratedSchemaProfile(
          db,
          transactionalSchema,
          canonicalSchemaProfile || buildCanonicalSchemaObjectProfile(transactionalSchema)
        );
      }
      if (!existingIdentity.fresh && strategyRulesProvenanceMigrated) {
        const targetOverrides = new Map(trustedAdmissionProfile?.sqlOverrides || []);
        targetOverrides.delete('table:strategy_rules:strategy_rules');
        assertStrategyRulesMigratedSchemaProfile(
          db,
          transactionalSchema,
          strategyRulesCanonicalProfile || buildCanonicalSchemaObjectProfile(transactionalSchema),
          targetOverrides
        );
      }
      if (!existingIdentity.fresh
        && !canonicalSchemaMigrated
        && !strategyRulesProvenanceMigrated
        && fingerprint !== existingIdentity.fingerprint) {
        const error = new Error('当前 SQLite 结构与已登记 canonical schema fingerprint 不一致。');
        error.code = 'SCHEMA_FINGERPRINT_MISMATCH';
        error.details = { expected: existingIdentity.fingerprint, actual: fingerprint };
        throw error;
      }
      const upsertAppMeta = db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      );
      upsertAppMeta.run('schema_stage', CANONICAL_SCHEMA_STAGE);
      upsertAppMeta.run('schema_version', CANONICAL_SCHEMA_VERSION);
      upsertAppMeta.run('schema_fingerprint_algorithm', CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM);
      upsertAppMeta.run('schema_fingerprint', fingerprint);
      // 完整性检查必须在 canonical DDL、RBAC seed 与 metadata 同一事务提交前完成。
      verifyCanonicalDatabaseIntegrity(db);
    }).immediate();
    } finally {
      if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON');
    }
  } finally {
    db.close();
  }

  return targetDatabasePath;
}

function getDatabaseInfo() {
  return {
    dataDir,
    uploadsDir,
    backupsDir,
    databasePath,
    schemaPath,
    driver: 'better-sqlite3',
    storage: 'local-file'
  };
}

module.exports = {
  dataDir,
  uploadsDir,
  backupsDir,
  databasePath,
  schemaPath,
  CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM,
  CANONICAL_SCHEMA_STAGE,
  CANONICAL_SCHEMA_VERSION,
  IMPORT_BATCH_TYPES,
  blockDatabaseAdmission,
  calculateSchemaFingerprint,
  buildCarbonEmissionsStatusMigrationSql,
  buildGenerationRecordsDataSourceMigrationSql,
  buildImportBatchesImportTypeMigrationSql,
  carbonAccountingTableIsCanonical,
  carbonEmissionReportTableIsCanonical,
  carbonEmissionsStatusCheckAllowsSuperseded,
  energyFlowTableIsCanonical,
  ghgReportTableIsCanonical,
  ensureLocalDataDirectories,
  ensureCarbonActivityTables,
  ensureCarbonEmissionReportTables,
  ensureGhgReportTables,
  ensureEnergyBudgetsTable,
  ensureEnergyAnalysisTables,
  ensureDemoGovernanceTables,
  ensurePredictionConfigsTable,
  ensureRbacSeedData,
  generationRecordsDataSourceCheckAllowsUpload,
  getCanonicalSeedContract,
  readCanonicalSeedContract,
  getDatabaseAdmissionState,
  getDatabaseInfo,
  getTableColumns,
  importBatchesHasAuditColumns,
  importBatchesImportTypeCheckAllowsAuditTypes,
  importBatchesImportTypeCheckAllowsLedgerTypes,
  initDatabase,
  migrateBenchmarkTargetsImportSourceColumns,
  migrateCarbonAccountingRunTables,
  migrateCarbonEmissionReportTables,
  migrateEnergyFlowTables,
  migrateGhgReportTables,
  migrateEnergyBenchmarkInternalRevisions,
  migrateCarbonEmissionsStatusCheck,
  migrateDemoImportContextsV2: migrateDemoImportContextsV4,
  migrateDemoImportContextsV3: migrateDemoImportContextsV4,
  migrateDemoImportContextsV4,
  migrateDemoRunImportBatchRole,
  prepareDemoGovernanceTablesForMigration,
  preflightDemoGovernanceData,
  migrateEnergyBalanceCalculationRuns,
  migrateEnergyBalanceImportSourceColumns,
  migrateStrategyRulesProvenance,
  migrateEnergyBudgetImportSourceColumns,
  migrateGenerationRecordsDataSourceCheck,
  migrateImportAuditSourceColumns,
  migratePredictionRunsStatusCheck,
  migrateImportBatchesImportTypeCheck,
  migrateCarbonMenuPermissionStructure,
  migrateLegacyImportMenuPermission,
  migrateSupplierCodeKeys,
  matchTrustedCanonicalSchemaProfile,
  normalizeSqlContractText,
  openDatabase,
  openReadOnlyDatabase,
  poisonDatabaseAdmission,
  unblockDatabaseAdmission,
  verifyCanonicalDatabaseIntegrity
};
