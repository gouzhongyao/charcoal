const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../../data');
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
const backupsDir = process.env.BACKUPS_DIR || path.join(dataDir, 'backups');
const databasePath = process.env.SQLITE_PATH || path.join(dataDir, 'energy-carbon.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

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
  'energy_flow_record'
]);

// import_batches 重建 SQL 使用统一白名单，避免 schema 与旧库迁移枚举漂移。
const IMPORT_BATCH_TYPES_SQL = IMPORT_BATCH_TYPES.map((importType) => `'${importType}'`).join(', ');

// 能源分析 schema 片段标记用于独立幂等迁移和失败回滚测试。
const ENERGY_ANALYSIS_SCHEMA_START_MARKER = '-- ENERGY_ANALYSIS_SCHEMA_START';
const ENERGY_ANALYSIS_SCHEMA_END_MARKER = '-- ENERGY_ANALYSIS_SCHEMA_END';

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

// 严格 UTC ISO 时间戳格式与阶段 1 契约保持一致。
const STRICT_UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// IANA 来源时区必须包含区域与地点分段。
const IANA_TIME_ZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)+$/;

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
  organization_scope TEXT,
  site TEXT,
  department TEXT,
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
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE SET NULL
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
  db.function('is_utc_minute_boundary', { deterministic: true }, (value) => (
    isUtcMinuteBoundary(value) ? 1 : 0
  ));
  db.function('is_valid_factor_versions_json', { deterministic: true }, (value) => (
    isValidFactorVersionsJson(value) ? 1 : 0
  ));
}

function openDatabase() {
  ensureLocalDataDirectories();
  const Database = loadDatabaseDriver();
  const db = new Database(databasePath);
  registerEnergyAnalysisSqliteFunctions(db);
  db.pragma('foreign_keys = ON');
  return db;
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

/**
 * 在单一事务内幂等创建能源分析表和索引，失败时回滚本次全部 DDL。
 * @param {object} db SQLite 数据库连接。
 * @param {string} schemaText 完整 schema 文本。
 * @returns {boolean} 调用前是否缺少能源分析主表。
 */
function ensureEnergyAnalysisTables(db, schemaText = fs.readFileSync(schemaPath, 'utf8')) {
  const tableExisted = Boolean(getTableCreateSql(db, 'energy_timeseries_records'));
  const energyAnalysisSql = extractEnergyAnalysisSchemaSql(schemaText);
  db.transaction(() => {
    db.exec(energyAnalysisSql);
  })();
  return !tableExisted;
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

  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      buildCarbonEmissionsStatusMigrationSql().forEach((sql) => db.exec(sql));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (wasForeignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }

  return true;
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

  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumnIfMissing(db, 'import_batches', 'audit_phase', "audit_phase TEXT CHECK (audit_phase IS NULL OR audit_phase IN ('preview', 'execute'))");
      addColumnIfMissing(db, 'import_batches', 'preview_signature', 'preview_signature TEXT');
      addColumnIfMissing(db, 'import_batches', 'preview_audit_digest', 'preview_audit_digest TEXT');
      addColumnIfMissing(db, 'import_batches', 'audit_context_json', 'audit_context_json TEXT');
      addColumnIfMissing(db, 'import_batches', 'execute_result_json', 'execute_result_json TEXT');
      addColumnIfMissing(db, 'import_batches', 'backup_json', 'backup_json TEXT');
      if (needsImportTypeCheckMigration) {
        buildImportBatchesImportTypeMigrationSql().forEach((sql) => db.exec(sql));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (wasForeignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }

  return true;
}

function migrateGenerationRecordsDataSourceCheck(db) {
  const createTableSql = getTableCreateSql(db, 'generation_records');
  if (!createTableSql || generationRecordsDataSourceCheckAllowsUpload(createTableSql)) {
    return false;
  }

  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      buildGenerationRecordsDataSourceMigrationSql(getTableColumns(db, 'generation_records')).forEach((sql) => db.exec(sql));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (wasForeignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }

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
  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TABLE IF EXISTS prediction_runs__migration_new');
      db.exec(PREDICTION_RUNS_TABLE_WITH_MANAGEMENT_STATUSES_SQL);
      db.exec(`INSERT INTO prediction_runs__migration_new (id, name, algorithm, status, target_energy_type_id, train_start_month, train_end_month, predict_start_month, predict_end_month, parameters_json, created_at, completed_at, note)
        SELECT id, name, algorithm, CASE WHEN status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'archived') THEN status ELSE 'failed' END, target_energy_type_id, train_start_month, train_end_month, predict_start_month, predict_end_month, parameters_json, created_at, completed_at, note FROM prediction_runs`);
      db.exec('DROP TABLE prediction_runs');
      db.exec('ALTER TABLE prediction_runs__migration_new RENAME TO prediction_runs');
      db.exec('CREATE INDEX IF NOT EXISTS idx_prediction_runs_status_created ON prediction_runs(status, created_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_prediction_results_run_month ON prediction_results(prediction_run_id, target_month)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { if (wasForeignKeysEnabled) db.pragma('foreign_keys = ON'); }
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

function migrateEnergyRecordLedgerColumns(db) {
  const createTableSql = getTableCreateSql(db, 'energy_records');
  if (!createTableSql) {
    return false;
  }

  db.exec(LEDGER_TABLES_SQL);
  db.exec(PRODUCTION_TABLES_SQL);
  const addedImportType = addColumnIfMissing(
    db,
    'import_batches',
    'import_type',
    `import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN (${IMPORT_BATCH_TYPES_SQL}))`
  );
  const addedOrganizationUnit = addColumnIfMissing(
    db,
    'energy_records',
    'organization_unit_id',
    'organization_unit_id INTEGER REFERENCES organization_units(id) ON DELETE SET NULL'
  );
  const addedMeterDevice = addColumnIfMissing(
    db,
    'energy_records',
    'meter_device_id',
    'meter_device_id INTEGER REFERENCES meter_devices(id) ON DELETE SET NULL'
  );
  return addedImportType || addedOrganizationUnit || addedMeterDevice;
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

// 每项最后两个值依次为父菜单 route_path、是否在动态菜单可见；仅超管获得全部种子，普通 user 保持个人资料最小权限。
const RBAC_MENU_SEEDS = [
  ['directory', '系统管理', '/system', null, null, 'Setting', 100, null],
  ['menu', '用户管理', '/system/users', 'system/users/index', 'system:user:view', 'User', 110, '/system'],
  ['menu', '角色管理', '/system/roles', 'system/roles/index', 'system:role:view', 'Avatar', 120, '/system'],
  ['menu', '菜单管理', '/system/menus', 'system/menus/index', 'system:menu:view', 'Menu', 130, '/system'],
  ['menu', '备份恢复', '/system/backups', 'system/backups/index', 'system:backup:view', 'FolderOpened', 140, '/system'],
  ['menu', '个人中心', '/profile', 'profile/index', 'system:profile:update', 'UserFilled', 10, null, 0],
  ['menu', '工作台', '/dashboard', 'dashboard/index', 'dashboard:view', 'DataBoard', 20, null],
  ['directory', '能耗管理', '/energy', null, null, 'TrendCharts', 40, null],
  ['menu', '能耗统计', '/energy/statistics', 'energy/statistics/index', 'energy:records:view', 'Histogram', 41, '/energy'],
  ['menu', '用能预算', '/energy/budgets', 'energy/budgets/index', 'energy:budget:view', 'Wallet', 42, '/energy'],
  ['menu', '能耗数据导入', '/imports', 'imports/index', 'imports:view', 'UploadFilled', 43, '/energy'],
  ['directory', '基础台账', '/ledger', null, null, 'Collection', 50, null],
  ['menu', '组织管理', '/ledger/organization', 'ledger/organization/index', 'ledger:units:view', 'OfficeBuilding', 51, '/ledger'],
  ['menu', '计量器具', '/ledger/meters', 'ledger/meters/index', 'ledger:meters:view', 'Monitor', 52, '/ledger'],
  ['menu', '计量抄表', '/ledger/meter-readings', 'ledger/meter-readings/index', 'ledger:readings:view', 'DocumentChecked', 53, '/ledger'],
  ['menu', '生产单元', '/ledger/production-units', 'ledger/production-units/index', 'ledger:production-unit:view', 'Box', 54, '/ledger'],
  ['menu', '月度产量', '/ledger/production-output', 'ledger/production-output/index', 'ledger:production-output:view', 'Tickets', 55, '/ledger'],
  ['menu', '发电自用', '/ledger/generation', 'ledger/generation/index', 'ledger:generation:view', 'Lightning', 56, '/ledger'],
  ['button', '产能单元模板下载', null, null, 'ledger:production:template', null, 541, '/ledger/production-units'],
  ['button', '产能单元导入', null, null, 'ledger:production:import', null, 542, '/ledger/production-units'],
  ['button', '产能单元导出', null, null, 'ledger:production:export', null, 543, '/ledger/production-units'],
  ['menu', '碳核算', '/carbon', 'carbon/index', 'carbon:emissions:view', 'WindPower', 60, null],
  ['button', '碳因子查看', null, null, 'carbon:factors:view', null, 601, '/carbon'],

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
  db.prepare('DELETE FROM sys_role_menus WHERE menu_id = ?').run(canonicalMenu.id);
  db.prepare('DELETE FROM sys_menus WHERE id = ?').run(canonicalMenu.id);
  return true;
}

function migrateLegacyViewMenuPermissions(db, timestamp = new Date().toISOString()) {
  return RBAC_LEGACY_VIEW_MIGRATIONS.reduce((changed, migration) => migrateLegacyViewMenuPermission(db, migration, timestamp) || changed, false);
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

function migrateNavigationMenuStructure(db, timestamp = new Date().toISOString()) {
  // 个人中心保留权限与角色关联，但只能通过固定路由和右上角用户菜单访问。
  const profileResult = db.prepare(`UPDATE sys_menus SET visible = 0, updated_at = ?
    WHERE (route_path = '/profile' OR permission_code = 'system:profile:update') AND visible <> 0`).run(timestamp);
  const energyMenu = db.prepare("SELECT id FROM sys_menus WHERE route_path = '/energy' AND menu_type = 'directory'").get();
  const importMenu = db.prepare("SELECT id FROM sys_menus WHERE route_path = '/imports' OR permission_code = 'imports:view'").get();
  if (!energyMenu || !importMenu) {
    return profileResult.changes > 0;
  }

  // 复用既有导入菜单 ID，仅调整层级和展示名称，避免丢失既有角色授权或产生重复菜单。
  const importResult = db.prepare(`UPDATE sys_menus SET parent_id = ?, menu_name = ?, updated_at = ?
    WHERE id = ? AND (parent_id IS NOT ? OR menu_name <> ?)`)
    .run(energyMenu.id, '能耗数据导入', timestamp, importMenu.id, energyMenu.id, '能耗数据导入');
  return profileResult.changes > 0 || importResult.changes > 0;
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
    migrateNavigationMenuStructure(db, now);

    const adminRole = db.prepare("SELECT id FROM sys_roles WHERE role_code = 'super_admin'").get();
    const userRole = db.prepare("SELECT id FROM sys_roles WHERE role_code = 'user'").get();
    const allMenus = db.prepare('SELECT id FROM sys_menus WHERE status = \'active\'').all();
    const profileMenus = db.prepare("SELECT id FROM sys_menus WHERE permission_code IN ('system:profile:update', 'system:profile:change-password')").all();
    const grant = db.prepare('INSERT OR IGNORE INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)');
    allMenus.forEach((menu) => grant.run(adminRole.id, menu.id, now));
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

function initDatabase() {
  const db = openDatabase();
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    migrateCarbonEmissionsStatusCheck(db);
    migrateImportAuditSourceColumns(db);
    migrateEnergyRecordLedgerColumns(db);
    migrateImportBatchesImportTypeCheck(db);
    migrateGenerationRecordsDataSourceCheck(db);
    migrateEnergyBudgetImportSourceColumns(db);
    ensureEnergyBudgetsTable(db);
    migratePredictionRunsStatusCheck(db);
    ensurePredictionConfigsTable(db);
    migrateBenchmarkTargetsImportSourceColumns(db);
    ensureEnergyAnalysisTables(db, schema);
    db.exec('DROP INDEX IF EXISTS ux_carbon_emissions_record_method');
    db.exec(schema);
    ensureRbacSeedData(db);
    // 初始化完成后同步阶段和版本，便于隔离升级验证识别当前 schema。
    const upsertAppMeta = db.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );
    upsertAppMeta.run('schema_stage', 'energy-analysis-foundation');
    upsertAppMeta.run('schema_version', '2026-08-06-energy-analysis-foundation');
  } finally {
    db.close();
  }

  return databasePath;
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
  IMPORT_BATCH_TYPES,
  buildCarbonEmissionsStatusMigrationSql,
  buildGenerationRecordsDataSourceMigrationSql,
  buildImportBatchesImportTypeMigrationSql,
  carbonEmissionsStatusCheckAllowsSuperseded,
  ensureLocalDataDirectories,
  ensureEnergyBudgetsTable,
  ensureEnergyAnalysisTables,
  ensurePredictionConfigsTable,
  ensureRbacSeedData,
  generationRecordsDataSourceCheckAllowsUpload,
  getDatabaseInfo,
  getTableColumns,
  importBatchesHasAuditColumns,
  importBatchesImportTypeCheckAllowsAuditTypes,
  importBatchesImportTypeCheckAllowsLedgerTypes,
  initDatabase,
  migrateBenchmarkTargetsImportSourceColumns,
  migrateCarbonEmissionsStatusCheck,
  migrateEnergyRecordLedgerColumns,
  migrateEnergyBudgetImportSourceColumns,
  migrateGenerationRecordsDataSourceCheck,
  migrateImportAuditSourceColumns,
  migratePredictionRunsStatusCheck,
  migrateImportBatchesImportTypeCheck,
  migrateLegacyImportMenuPermission,
  openDatabase
};
