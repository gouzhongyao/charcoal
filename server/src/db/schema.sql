PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_unit', 'production_output', 'generation_record', 'energy_budget', 'carbon_factor', 'prediction_config', 'energy_timeseries', 'shift_schedule', 'device_state', 'energy_conversion_factor', 'energy_benchmark', 'energy_flow_node', 'energy_flow_edge', 'energy_flow_record', 'shift_definition', 'tou_scheme', 'strategy_rule', 'energy_flow_model', 'energy_balance_boundary', 'energy_balance_item', 'energy_flow_workbook', 'supplier', 'carbon_activity', 'carbon_emission_report', 'ghg_report')),
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
  -- 当前仅正式启用 skip；overwrite / append 为未来待启用策略，启用前需同步迁移约束和导入事务语义。
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
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number >= 1),
  field_name TEXT,
  raw_value TEXT,
  error_code TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS energy_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'energy' CHECK (category IN ('energy', 'water', 'heat', 'other')),
  default_unit TEXT NOT NULL,
  standard_unit TEXT NOT NULL,
  carbon_factor_required INTEGER NOT NULL DEFAULT 1 CHECK (carbon_factor_required IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS carbon_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_type_id INTEGER NOT NULL,
  region TEXT NOT NULL DEFAULT 'default',
  factor_year INTEGER CHECK (factor_year IS NULL OR factor_year BETWEEN 1900 AND 2200),
  unit TEXT NOT NULL,
  factor_value REAL NOT NULL CHECK (factor_value > 0),
  factor_unit TEXT NOT NULL DEFAULT 'kgCO2e',
  source TEXT NOT NULL,
  source_url TEXT,
  effective_from TEXT,
  effective_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (energy_type_id, region, factor_year, unit, source)
);

CREATE TABLE IF NOT EXISTS organization_units (
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
);

-- 供应商基础台账以服务端规范键保证编码唯一，并独立保存合作状态和导入来源。
CREATE TABLE IF NOT EXISTS suppliers (
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
);

CREATE INDEX IF NOT EXISTS idx_suppliers_status_name ON suppliers(status, supplier_name, id);
CREATE INDEX IF NOT EXISTS idx_suppliers_batch ON suppliers(source_batch_id);

CREATE TABLE IF NOT EXISTS production_units (
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

CREATE TABLE IF NOT EXISTS energy_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_type_id INTEGER NOT NULL,
  organization_unit_id INTEGER,
  meter_device_id INTEGER,
  original_month TEXT NOT NULL,
  normalized_month TEXT NOT NULL CHECK (
    normalized_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(normalized_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  original_unit TEXT NOT NULL,
  original_value REAL NOT NULL CHECK (original_value >= 0),
  normalized_unit TEXT NOT NULL,
  normalized_value REAL NOT NULL CHECK (normalized_value >= 0),
  organization TEXT,
  site TEXT,
  department TEXT,
  production_line TEXT,
  meter_code TEXT,
  business_dimension TEXT,
  remark TEXT,
  duplicate_key TEXT NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'skipped_duplicate', 'overwritten', 'void')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  FOREIGN KEY (meter_device_id) REFERENCES meter_devices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS generation_records (
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
);

CREATE TABLE IF NOT EXISTS energy_budgets (
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

CREATE TABLE IF NOT EXISTS carbon_emissions (
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
);

-- CARBON_ACTIVITY_SCHEMA_START
-- 独立碳活动事实与旧能耗驱动活动使用统一来源类型，但不修改或依赖旧 carbon_emissions 结果。
CREATE TABLE IF NOT EXISTS carbon_activity_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL DEFAULT 'independent_activity'
    CHECK (source_type IN ('independent_activity', 'energy_record')),
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  energy_record_id INTEGER,
  activity_code TEXT NOT NULL,
  activity_code_key TEXT NOT NULL UNIQUE,
  supersedes_activity_id INTEGER,
  superseded_by_activity_id INTEGER,
  emission_scope TEXT NOT NULL CHECK (emission_scope IN ('scope_1', 'scope_2', 'scope_3')),
  activity_category TEXT NOT NULL,
  activity_category_key TEXT NOT NULL,
  organization_unit_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  start_wall_clock TEXT NOT NULL CHECK (is_strict_wall_clock_minute(start_wall_clock) = 1),
  end_wall_clock TEXT NOT NULL CHECK (is_strict_wall_clock_minute(end_wall_clock) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1 AND is_utc_minute_boundary(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1 AND is_utc_minute_boundary(end_utc) = 1),
  activity_value REAL NOT NULL CHECK (activity_value >= 0 AND activity_value <= 1000000000000000),
  activity_unit TEXT NOT NULL,
  factor_region TEXT NOT NULL DEFAULT 'default',
  source_reference TEXT NOT NULL,
  evidence_reference TEXT,
  note TEXT,
  duplicate_key TEXT NOT NULL CHECK (length(duplicate_key) = 64 AND duplicate_key NOT GLOB '*[^a-f0-9]*'),
  record_status TEXT NOT NULL DEFAULT 'active'
    CHECK (record_status IN ('active', 'superseded', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  voided_by INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_record_id) REFERENCES energy_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_activity_id) REFERENCES carbon_activity_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by_activity_id) REFERENCES carbon_activity_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (voided_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK ((source_type = 'energy_record' AND energy_record_id IS NOT NULL)
    OR (source_type = 'independent_activity' AND energy_record_id IS NULL)),
  CHECK ((source_batch_id IS NULL AND source_row_number IS NULL)
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)),
  CHECK ((record_status = 'active' AND superseded_by_activity_id IS NULL AND void_reason IS NULL AND voided_at IS NULL AND voided_by IS NULL)
    OR (record_status = 'superseded' AND superseded_by_activity_id IS NOT NULL AND void_reason IS NULL AND voided_at IS NULL AND voided_by IS NULL)
    OR (record_status = 'void' AND superseded_by_activity_id IS NULL AND void_reason IS NOT NULL AND voided_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_carbon_activity_records_active_duplicate
  ON carbon_activity_records(duplicate_key) WHERE record_status = 'active';
CREATE INDEX IF NOT EXISTS idx_carbon_activity_records_scope_range
  ON carbon_activity_records(emission_scope, start_utc, end_utc, record_status);
CREATE INDEX IF NOT EXISTS idx_carbon_activity_records_org_energy_range
  ON carbon_activity_records(organization_unit_id, energy_type_id, start_utc, end_utc, record_status);
CREATE INDEX IF NOT EXISTS idx_carbon_activity_records_batch
  ON carbon_activity_records(source_batch_id, source_row_number);
CREATE INDEX IF NOT EXISTS idx_carbon_activity_records_supersedes
  ON carbon_activity_records(supersedes_activity_id, superseded_by_activity_id);

-- 独立碳活动计算运行只保存 completed 事实；失败事务不持久化半成品运行。
CREATE TABLE IF NOT EXISTS carbon_calculation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_code TEXT NOT NULL UNIQUE CHECK (length(trim(run_code)) BETWEEN 1 AND 128),
  snapshot_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_schema_version = 1),
  source_type TEXT NOT NULL DEFAULT 'independent_activity'
    CHECK (source_type = 'independent_activity'),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  calculation_method TEXT NOT NULL DEFAULT 'standard-factor'
    CHECK (calculation_method = 'standard-factor'),
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1 AND instr(start_utc, '.') = 0),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1 AND instr(end_utc, '.') = 0),
  activity_filter_json TEXT NOT NULL
    CHECK (json_valid(activity_filter_json) = 1 AND json_extract(activity_filter_json, '$.version') = 1),
  actor_snapshot_json TEXT NOT NULL
    CHECK (json_valid(actor_snapshot_json) = 1 AND json_extract(actor_snapshot_json, '$.version') = 1),
  activity_snapshot_digest TEXT NOT NULL CHECK (
    length(activity_snapshot_digest) = 64
    AND activity_snapshot_digest NOT GLOB '*[^a-f0-9]*'
  ),
  activity_count INTEGER NOT NULL CHECK (activity_count BETWEEN 0 AND 5000),
  result_count INTEGER NOT NULL CHECK (result_count = activity_count),
  calculated_count INTEGER NOT NULL CHECK (calculated_count BETWEEN 0 AND result_count),
  factor_missing_count INTEGER NOT NULL CHECK (factor_missing_count BETWEEN 0 AND result_count),
  emission_totals_json TEXT NOT NULL
    CHECK (json_valid(emission_totals_json) = 1 AND json_extract(emission_totals_json, '$.version') = 1),
  created_by INTEGER,
  started_at TEXT NOT NULL CHECK (is_strict_utc_iso(started_at) = 1),
  completed_at TEXT NOT NULL CHECK (is_strict_utc_iso(completed_at) = 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (calculated_count + factor_missing_count = result_count),
  CHECK (unixepoch(started_at) <= unixepoch(completed_at))
);

CREATE INDEX IF NOT EXISTS idx_carbon_calculation_runs_status_created
  ON carbon_calculation_runs(source_type, status, completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_carbon_calculation_runs_period
  ON carbon_calculation_runs(start_utc, end_utc, completed_at DESC);

-- 核算结果以筛选列加受版本约束 JSON 冻结完整历史，不依赖活动、组织、能源类型或因子的当前状态。
CREATE TABLE IF NOT EXISTS carbon_accounting_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calculation_run_id INTEGER NOT NULL,
  snapshot_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_schema_version = 1),
  source_type TEXT NOT NULL DEFAULT 'independent_activity'
    CHECK (source_type = 'independent_activity'),
  activity_record_id INTEGER NOT NULL CHECK (activity_record_id > 0),
  carbon_factor_id INTEGER CHECK (carbon_factor_id IS NULL OR carbon_factor_id > 0),
  emission_scope TEXT NOT NULL CHECK (emission_scope IN ('scope_1', 'scope_2', 'scope_3')),
  activity_category TEXT NOT NULL,
  organization_unit_id INTEGER NOT NULL CHECK (organization_unit_id > 0),
  energy_type_id INTEGER NOT NULL CHECK (energy_type_id > 0),
  activity_start_wall_clock TEXT NOT NULL,
  activity_end_wall_clock TEXT NOT NULL,
  activity_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(activity_start_utc) = 1),
  activity_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(activity_end_utc) = 1),
  activity_value REAL NOT NULL CHECK (activity_value >= 0 AND activity_value <= 1000000000000000),
  activity_unit TEXT NOT NULL,
  requested_region TEXT NOT NULL,
  factor_year INTEGER NOT NULL CHECK (factor_year BETWEEN 1 AND 9999),
  factor_value REAL CHECK (factor_value IS NULL OR factor_value > 0),
  factor_unit TEXT,
  emission_value REAL CHECK (emission_value IS NULL OR emission_value >= 0),
  emission_unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('calculated', 'factor_missing')),
  missing_reason TEXT,
  calculation_basis TEXT NOT NULL DEFAULT 'activity_value * factor_value',
  match_priority INTEGER CHECK (match_priority IS NULL OR match_priority BETWEEN 1 AND 4),
  activity_snapshot_json TEXT NOT NULL
    CHECK (json_valid(activity_snapshot_json) = 1 AND json_extract(activity_snapshot_json, '$.version') = 1),
  organization_snapshot_json TEXT NOT NULL
    CHECK (json_valid(organization_snapshot_json) = 1 AND json_extract(organization_snapshot_json, '$.version') = 1),
  energy_type_snapshot_json TEXT NOT NULL
    CHECK (json_valid(energy_type_snapshot_json) = 1 AND json_extract(energy_type_snapshot_json, '$.version') = 1),
  factor_snapshot_json TEXT
    CHECK (factor_snapshot_json IS NULL OR (json_valid(factor_snapshot_json) = 1 AND json_extract(factor_snapshot_json, '$.version') = 1)),
  matching_snapshot_json TEXT NOT NULL
    CHECK (json_valid(matching_snapshot_json) = 1 AND json_extract(matching_snapshot_json, '$.version') = 1),
  formula_snapshot_json TEXT NOT NULL
    CHECK (json_valid(formula_snapshot_json) = 1 AND json_extract(formula_snapshot_json, '$.version') = 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calculation_run_id) REFERENCES carbon_calculation_runs(id) ON DELETE CASCADE,
  UNIQUE (calculation_run_id, activity_record_id),
  CHECK (unixepoch(activity_start_utc) < unixepoch(activity_end_utc)),
  CHECK ((status = 'calculated'
      AND carbon_factor_id IS NOT NULL
      AND factor_value IS NOT NULL
      AND factor_unit IS NOT NULL
      AND emission_value IS NOT NULL
      AND emission_unit IS NOT NULL
      AND missing_reason IS NULL
      AND match_priority IS NOT NULL
      AND factor_snapshot_json IS NOT NULL)
    OR (status = 'factor_missing'
      AND carbon_factor_id IS NULL
      AND factor_value IS NULL
      AND factor_unit IS NULL
      AND emission_value IS NULL
      AND emission_unit IS NULL
      AND missing_reason IS NOT NULL
      AND match_priority IS NULL
      AND factor_snapshot_json IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_carbon_accounting_results_activity
  ON carbon_accounting_results(activity_record_id, calculation_run_id);
CREATE INDEX IF NOT EXISTS idx_carbon_accounting_results_run_status
  ON carbon_accounting_results(calculation_run_id, status, id);
CREATE INDEX IF NOT EXISTS idx_carbon_accounting_results_filters
  ON carbon_accounting_results(calculation_run_id, emission_scope, organization_unit_id, energy_type_id, status);
-- CARBON_ACTIVITY_SCHEMA_END

-- CARBON_EMISSION_REPORT_SCHEMA_START
-- 碳排放报告是独立只读报告事实，不触发或反写碳活动、核算运行、核算结果、旧排放结果和碳因子。
CREATE TABLE IF NOT EXISTS carbon_emission_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_code TEXT NOT NULL CHECK (length(trim(report_code)) BETWEEN 1 AND 128),
  report_code_key TEXT NOT NULL UNIQUE CHECK (length(trim(report_code_key)) BETWEEN 1 AND 128),
  report_name TEXT NOT NULL CHECK (length(trim(report_name)) BETWEEN 1 AND 300),
  report_organization TEXT NOT NULL CHECK (length(trim(report_organization)) BETWEEN 1 AND 300),
  period_start TEXT NOT NULL CHECK (is_strict_iso_date(period_start) = 1),
  period_end TEXT NOT NULL CHECK (is_strict_iso_date(period_end) = 1),
  template_id TEXT NOT NULL DEFAULT 'carbon-emission-report' CHECK (template_id = 'carbon-emission-report'),
  template_version TEXT NOT NULL DEFAULT '1.0' CHECK (template_version = '1.0'),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_batch_id INTEGER NOT NULL UNIQUE,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (julianday(period_start) <= julianday(period_end))
);

CREATE TABLE IF NOT EXISTS carbon_emission_report_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  boundary_type TEXT NOT NULL CHECK (boundary_type IN ('organization', 'accounting')),
  boundary_name TEXT NOT NULL CHECK (length(trim(boundary_name)) BETWEEN 1 AND 500),
  boundary_description TEXT NOT NULL CHECK (length(trim(boundary_description)) BETWEEN 1 AND 4000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES carbon_emission_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, boundary_type)
);

CREATE TABLE IF NOT EXISTS carbon_emission_report_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  evidence_code TEXT NOT NULL CHECK (length(trim(evidence_code)) BETWEEN 1 AND 128),
  evidence_code_key TEXT NOT NULL CHECK (length(trim(evidence_code_key)) BETWEEN 1 AND 128),
  evidence_name TEXT NOT NULL CHECK (length(trim(evidence_name)) BETWEEN 1 AND 500),
  evidence_type TEXT NOT NULL CHECK (length(trim(evidence_type)) BETWEEN 1 AND 100),
  evidence_description TEXT NOT NULL CHECK (length(trim(evidence_description)) BETWEEN 1 AND 4000),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES carbon_emission_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, evidence_code_key),
  UNIQUE (report_id, id)
);

CREATE TABLE IF NOT EXISTS carbon_emission_report_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  item_code TEXT NOT NULL CHECK (length(trim(item_code)) BETWEEN 1 AND 128),
  item_code_key TEXT NOT NULL CHECK (length(trim(item_code_key)) BETWEEN 1 AND 128),
  emission_scope TEXT NOT NULL CHECK (emission_scope IN ('scope_1', 'scope_2', 'scope_3')),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 300),
  emission_source TEXT NOT NULL CHECK (length(trim(emission_source)) BETWEEN 1 AND 500),
  activity_value REAL NOT NULL CHECK (activity_value >= 0 AND activity_value <= 1000000000000000),
  activity_unit TEXT NOT NULL CHECK (length(trim(activity_unit)) BETWEEN 1 AND 100),
  factor_value REAL NOT NULL CHECK (factor_value > 0 AND factor_value <= 1000000000000000),
  factor_unit TEXT NOT NULL CHECK (length(trim(factor_unit)) BETWEEN 1 AND 200),
  emission_value REAL NOT NULL CHECK (emission_value >= 0 AND emission_value <= 1000000000000000),
  co2e_unit TEXT NOT NULL CHECK (length(trim(co2e_unit)) BETWEEN 1 AND 100),
  evidence_id INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES carbon_emission_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id, evidence_id) REFERENCES carbon_emission_report_evidence(report_id, id) ON DELETE RESTRICT,
  UNIQUE (report_id, item_code_key)
);

CREATE TABLE IF NOT EXISTS carbon_emission_report_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  summary_code TEXT NOT NULL CHECK (length(trim(summary_code)) BETWEEN 1 AND 128),
  summary_code_key TEXT NOT NULL CHECK (length(trim(summary_code_key)) BETWEEN 1 AND 128),
  summary_dimension TEXT NOT NULL CHECK (summary_dimension IN ('total', 'scope', 'category')),
  summary_value TEXT NOT NULL CHECK (length(trim(summary_value)) BETWEEN 1 AND 300),
  emission_value REAL NOT NULL CHECK (emission_value >= 0 AND emission_value <= 1000000000000000),
  co2e_unit TEXT NOT NULL CHECK (length(trim(co2e_unit)) BETWEEN 1 AND 100),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES carbon_emission_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, summary_code_key),
  UNIQUE (report_id, summary_dimension, summary_value)
);

CREATE INDEX IF NOT EXISTS idx_carbon_emission_reports_period
  ON carbon_emission_reports(period_start, period_end, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_reports_organization
  ON carbon_emission_reports(report_organization, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_reports_batch
  ON carbon_emission_reports(source_batch_id, id);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_report_boundaries_report
  ON carbon_emission_report_boundaries(report_id, boundary_type, id);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_report_evidence_report
  ON carbon_emission_report_evidence(report_id, evidence_code_key, id);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_report_items_filters
  ON carbon_emission_report_items(report_id, emission_scope, category, id);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_report_items_evidence
  ON carbon_emission_report_items(evidence_id, report_id, id);
CREATE INDEX IF NOT EXISTS idx_carbon_emission_report_summaries_report
  ON carbon_emission_report_summaries(report_id, summary_dimension, id);
-- CARBON_EMISSION_REPORT_SCHEMA_END

-- GHG_REPORT_SCHEMA_START
-- 温室气体报告是独立六部分报告事实，不与碳排放报告、碳活动、核算运行、核算结果、旧排放或碳因子混用。
CREATE TABLE IF NOT EXISTS ghg_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_code TEXT NOT NULL CHECK (length(trim(report_code)) BETWEEN 1 AND 128),
  report_code_key TEXT NOT NULL UNIQUE CHECK (length(trim(report_code_key)) BETWEEN 1 AND 128),
  report_name TEXT NOT NULL CHECK (length(trim(report_name)) BETWEEN 1 AND 300),
  report_organization TEXT NOT NULL CHECK (length(trim(report_organization)) BETWEEN 1 AND 300),
  period_start TEXT NOT NULL CHECK (is_strict_iso_date(period_start) = 1),
  period_end TEXT NOT NULL CHECK (is_strict_iso_date(period_end) = 1),
  template_id TEXT NOT NULL DEFAULT 'ghg-report' CHECK (template_id = 'ghg-report'),
  template_version TEXT NOT NULL DEFAULT '1.0' CHECK (template_version = '1.0'),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_batch_id INTEGER NOT NULL UNIQUE,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (julianday(period_start) <= julianday(period_end))
);

CREATE TABLE IF NOT EXISTS ghg_report_organization_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  boundary_code TEXT NOT NULL CHECK (length(trim(boundary_code)) BETWEEN 1 AND 128),
  boundary_code_key TEXT NOT NULL CHECK (length(trim(boundary_code_key)) BETWEEN 1 AND 128),
  organization_unit TEXT NOT NULL CHECK (length(trim(organization_unit)) BETWEEN 1 AND 500),
  inclusion_method TEXT NOT NULL CHECK (length(trim(inclusion_method)) BETWEEN 1 AND 300),
  boundary_description TEXT NOT NULL CHECK (length(trim(boundary_description)) BETWEEN 1 AND 4000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, boundary_code_key)
);

CREATE TABLE IF NOT EXISTS ghg_report_operational_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  emission_scope TEXT NOT NULL CHECK (emission_scope IN ('scope_1', 'scope_2', 'scope_3')),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 300),
  category_key TEXT NOT NULL CHECK (length(trim(category_key)) BETWEEN 1 AND 300),
  boundary_description TEXT NOT NULL CHECK (length(trim(boundary_description)) BETWEEN 1 AND 4000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, emission_scope, category_key)
);

CREATE TABLE IF NOT EXISTS ghg_report_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  evidence_code TEXT NOT NULL CHECK (length(trim(evidence_code)) BETWEEN 1 AND 128),
  evidence_code_key TEXT NOT NULL CHECK (length(trim(evidence_code_key)) BETWEEN 1 AND 128),
  evidence_name TEXT NOT NULL CHECK (length(trim(evidence_name)) BETWEEN 1 AND 500),
  evidence_type TEXT NOT NULL CHECK (length(trim(evidence_type)) BETWEEN 1 AND 100),
  evidence_description TEXT NOT NULL CHECK (length(trim(evidence_description)) BETWEEN 1 AND 4000),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, evidence_code_key),
  UNIQUE (report_id, id)
);

CREATE TABLE IF NOT EXISTS ghg_report_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  item_code TEXT NOT NULL CHECK (length(trim(item_code)) BETWEEN 1 AND 128),
  item_code_key TEXT NOT NULL CHECK (length(trim(item_code_key)) BETWEEN 1 AND 128),
  record_type TEXT NOT NULL CHECK (record_type IN ('emission', 'removal')),
  emission_scope TEXT NOT NULL CHECK (emission_scope IN ('scope_1', 'scope_2', 'scope_3')),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 300),
  greenhouse_gas TEXT NOT NULL CHECK (length(trim(greenhouse_gas)) BETWEEN 1 AND 100),
  source_or_sink TEXT NOT NULL CHECK (length(trim(source_or_sink)) BETWEEN 1 AND 500),
  activity_value REAL NOT NULL CHECK (activity_value >= 0 AND activity_value <= 1000000000000000),
  activity_unit TEXT NOT NULL CHECK (length(trim(activity_unit)) BETWEEN 1 AND 100),
  gas_amount REAL NOT NULL CHECK (gas_amount >= 0 AND gas_amount <= 1000000000000000),
  gwp REAL NOT NULL CHECK (gwp > 0 AND gwp <= 1000000000000000),
  co2e_value REAL NOT NULL CHECK (co2e_value >= 0 AND co2e_value <= 1000000000000000),
  co2e_unit TEXT NOT NULL CHECK (length(trim(co2e_unit)) BETWEEN 1 AND 100),
  accounting_method TEXT NOT NULL CHECK (length(trim(accounting_method)) BETWEEN 1 AND 1000),
  evidence_id INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id, evidence_id) REFERENCES ghg_report_evidence(report_id, id) ON DELETE RESTRICT,
  UNIQUE (report_id, item_code_key)
);

CREATE TABLE IF NOT EXISTS ghg_report_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  summary_code TEXT NOT NULL CHECK (length(trim(summary_code)) BETWEEN 1 AND 128),
  summary_code_key TEXT NOT NULL CHECK (length(trim(summary_code_key)) BETWEEN 1 AND 128),
  summary_dimension TEXT NOT NULL CHECK (summary_dimension IN ('total', 'scope', 'category', 'gas', 'record_type')),
  summary_value TEXT NOT NULL CHECK (length(trim(summary_value)) BETWEEN 1 AND 300),
  emission_co2e REAL NOT NULL CHECK (emission_co2e >= 0 AND emission_co2e <= 1000000000000000),
  removal_co2e REAL NOT NULL CHECK (removal_co2e >= 0 AND removal_co2e <= 1000000000000000),
  net_co2e REAL NOT NULL CHECK (net_co2e >= -1000000000000000 AND net_co2e <= 1000000000000000),
  co2e_unit TEXT NOT NULL CHECK (length(trim(co2e_unit)) BETWEEN 1 AND 100),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  FOREIGN KEY (report_id) REFERENCES ghg_reports(id) ON DELETE CASCADE,
  UNIQUE (report_id, summary_code_key),
  UNIQUE (report_id, summary_dimension, summary_value)
);

CREATE INDEX IF NOT EXISTS idx_ghg_reports_period
  ON ghg_reports(period_start, period_end, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ghg_reports_organization
  ON ghg_reports(report_organization, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ghg_reports_batch
  ON ghg_reports(source_batch_id, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_organization_boundaries_report
  ON ghg_report_organization_boundaries(report_id, boundary_code_key, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_operational_boundaries_report
  ON ghg_report_operational_boundaries(report_id, emission_scope, category_key, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_evidence_report
  ON ghg_report_evidence(report_id, evidence_code_key, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_items_filters
  ON ghg_report_items(report_id, record_type, emission_scope, category, greenhouse_gas, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_items_evidence
  ON ghg_report_items(evidence_id, report_id, id);
CREATE INDEX IF NOT EXISTS idx_ghg_report_summaries_report
  ON ghg_report_summaries(report_id, summary_dimension, id);
-- GHG_REPORT_SCHEMA_END

CREATE TABLE IF NOT EXISTS prediction_configs (
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

CREATE TABLE IF NOT EXISTS prediction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('moving_average', 'linear_trend', 'year_over_year', 'manual_baseline')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'archived')),
  target_energy_type_id INTEGER,
  train_start_month TEXT CHECK (
    train_start_month IS NULL
    OR (
      train_start_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      AND CAST(substr(train_start_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    )
  ),
  train_end_month TEXT CHECK (
    train_end_month IS NULL
    OR (
      train_end_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      AND CAST(substr(train_end_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    )
  ),
  predict_start_month TEXT CHECK (
    predict_start_month IS NULL
    OR (
      predict_start_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      AND CAST(substr(predict_start_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    )
  ),
  predict_end_month TEXT CHECK (
    predict_end_month IS NULL
    OR (
      predict_end_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
      AND CAST(substr(predict_end_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    )
  ),
  parameters_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  note TEXT,
  FOREIGN KEY (target_energy_type_id) REFERENCES energy_types(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS prediction_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_run_id INTEGER NOT NULL,
  energy_type_id INTEGER,
  target_month TEXT NOT NULL CHECK (
    target_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    AND CAST(substr(target_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  ),
  predicted_value REAL NOT NULL CHECK (predicted_value >= 0),
  predicted_unit TEXT NOT NULL,
  confidence_low REAL CHECK (confidence_low IS NULL OR confidence_low >= 0),
  confidence_high REAL CHECK (confidence_high IS NULL OR confidence_high >= 0),
  method_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (prediction_run_id) REFERENCES prediction_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE SET NULL,
  UNIQUE (prediction_run_id, energy_type_id, target_month)
);

-- ENERGY_ANALYSIS_SCHEMA_START
-- 能源分析时序事实、排班和设备状态均保留 UTC 区间、来源时区与作废审计。
CREATE TABLE IF NOT EXISTS energy_timeseries_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  organization_unit_id INTEGER,
  meter_device_id INTEGER,
  energy_type_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  granularity_minutes INTEGER NOT NULL CHECK (granularity_minutes IN (15, 30, 60)),
  original_unit TEXT NOT NULL,
  original_value REAL NOT NULL CHECK (original_value >= 0),
  normalized_unit TEXT NOT NULL,
  normalized_value REAL NOT NULL CHECK (normalized_value >= 0),
  source_reference TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'upload' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  FOREIGN KEY (meter_device_id) REFERENCES meter_devices(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (is_utc_minute_boundary(start_utc) = 1 AND is_utc_minute_boundary(end_utc) = 1),
  CHECK (unixepoch(end_utc) - unixepoch(start_utc) = granularity_minutes * 60),
  CHECK (
    (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
    OR (
      record_status = 'void'
      AND trim(COALESCE(void_reason, '')) <> ''
      AND is_strict_utc_iso(voided_at) = 1
    )
  )
);

CREATE TABLE IF NOT EXISTS shift_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  shift_code TEXT NOT NULL,
  shift_name TEXT NOT NULL,
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  crosses_midnight INTEGER NOT NULL DEFAULT 0 CHECK (crosses_midnight IN (0, 1)),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  UNIQUE (shift_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc)),
  CHECK ((crosses_midnight = 0 AND start_minute < end_minute) OR (crosses_midnight = 1 AND start_minute > end_minute))
);

CREATE TABLE IF NOT EXISTS shift_schedule_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  shift_definition_id INTEGER NOT NULL,
  organization_unit_id INTEGER,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  source_reference TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'upload' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (shift_definition_id) REFERENCES shift_definitions(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (
    (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
    OR (
      record_status = 'void'
      AND trim(COALESCE(void_reason, '')) <> ''
      AND is_strict_utc_iso(voided_at) = 1
    )
  )
);

CREATE TABLE IF NOT EXISTS device_state_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  meter_device_id INTEGER NOT NULL,
  organization_unit_id INTEGER,
  device_state TEXT NOT NULL CHECK (device_state IN ('running', 'idle', 'stopped', 'offline', 'unknown')),
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  source_reference TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'upload' CHECK (data_source IN ('manual', 'upload', 'calculation')),
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (meter_device_id) REFERENCES meter_devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (
    (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
    OR (
      record_status = 'void'
      AND trim(COALESCE(void_reason, '')) <> ''
      AND is_strict_utc_iso(voided_at) = 1
    )
  )
);

CREATE TABLE IF NOT EXISTS tou_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_code TEXT NOT NULL,
  scheme_name TEXT NOT NULL,
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  source TEXT NOT NULL,
  document_no TEXT,
  version TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (scheme_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
);

CREATE TABLE IF NOT EXISTS tou_period_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tou_scheme_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  period_type TEXT NOT NULL CHECK (period_type IN ('peak', 'flat', 'valley')),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tou_scheme_id) REFERENCES tou_schemes(id) ON DELETE CASCADE,
  UNIQUE (tou_scheme_id, day_of_week, start_minute, end_minute),
  CHECK (start_minute < end_minute)
);

CREATE TABLE IF NOT EXISTS energy_conversion_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  factor_code TEXT NOT NULL,
  energy_type_id INTEGER NOT NULL,
  source_unit TEXT NOT NULL,
  factor_value REAL NOT NULL CHECK (factor_value > 0),
  target_unit TEXT NOT NULL DEFAULT 'kgce' CHECK (target_unit = 'kgce'),
  display_unit TEXT NOT NULL DEFAULT 'tce' CHECK (display_unit = 'tce'),
  display_divisor REAL NOT NULL DEFAULT 1000 CHECK (display_divisor = 1000),
  source TEXT NOT NULL,
  document_no TEXT NOT NULL,
  version TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (factor_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
);

CREATE TABLE IF NOT EXISTS strategy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  metric_code TEXT NOT NULL,
  threshold_operator TEXT NOT NULL CHECK (threshold_operator IN ('gt', 'gte', 'lt', 'lte', 'between')),
  threshold_value REAL,
  threshold_min REAL,
  threshold_max REAL,
  threshold_unit TEXT NOT NULL,
  reduction_rate REAL CHECK (reduction_rate IS NULL OR (reduction_rate > 0 AND reduction_rate <= 1)),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  evidence_requirements_json TEXT NOT NULL,
  recommendation_text TEXT NOT NULL,
  source TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (rule_code, rule_version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc)),
  CHECK (
    (threshold_operator = 'between' AND threshold_min IS NOT NULL AND threshold_max IS NOT NULL AND threshold_min <= threshold_max AND threshold_value IS NULL)
    OR (threshold_operator <> 'between' AND threshold_value IS NOT NULL AND threshold_min IS NULL AND threshold_max IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS strategy_evaluation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_code TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL,
  scope_reference TEXT NOT NULL,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  formula_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  reason_codes_json TEXT,
  started_at TEXT CHECK (started_at IS NULL OR is_strict_utc_iso(started_at) = 1),
  completed_at TEXT CHECK (completed_at IS NULL OR is_strict_utc_iso(completed_at) = 1),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (unixepoch(start_utc) < unixepoch(end_utc))
);

CREATE TABLE IF NOT EXISTS strategy_rule_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_run_id INTEGER NOT NULL,
  strategy_rule_id INTEGER NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'not_matched', 'not_evaluable')),
  manual_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (manual_status IN ('unconfirmed', 'accepted', 'rejected', 'resolved')),
  actual_value REAL,
  threshold_snapshot_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reason_codes_json TEXT,
  coverage_rate REAL NOT NULL CHECK (coverage_rate BETWEEN 0 AND 1),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  estimated_saving REAL CHECK (estimated_saving IS NULL OR estimated_saving >= 0),
  estimated_saving_unit TEXT,
  data_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(data_start_utc) = 1),
  data_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(data_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR is_strict_utc_iso(reviewed_at) = 1),
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (evaluation_run_id) REFERENCES strategy_evaluation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_rule_id) REFERENCES strategy_rules(id) ON DELETE RESTRICT,
  UNIQUE (evaluation_run_id, strategy_rule_id),
  CHECK (unixepoch(data_start_utc) < unixepoch(data_end_utc)),
  CHECK ((match_status = 'not_evaluable' AND actual_value IS NULL AND estimated_saving IS NULL) OR (match_status <> 'not_evaluable' AND actual_value IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS benchmark_definitions (
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
);

CREATE TABLE IF NOT EXISTS benchmark_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (
    source_row_number IS NULL
    OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1)
  ),
  benchmark_definition_id INTEGER NOT NULL,
  target_value REAL,
  lower_bound REAL,
  upper_bound REAL,
  reference_start_utc TEXT CHECK (reference_start_utc IS NULL OR is_strict_utc_iso(reference_start_utc) = 1),
  reference_end_utc TEXT CHECK (reference_end_utc IS NULL OR is_strict_utc_iso(reference_end_utc) = 1),
  frozen_value REAL,
  frozen_at TEXT CHECK (frozen_at IS NULL OR is_strict_utc_iso(frozen_at) = 1),
  sample_count INTEGER CHECK (sample_count IS NULL OR sample_count > 0),
  production_summary_json TEXT,
  source_data_digest TEXT,
  is_frozen INTEGER NOT NULL DEFAULT 0 CHECK (is_frozen IN (0, 1)),
  auto_refresh INTEGER NOT NULL DEFAULT 0 CHECK (auto_refresh IN (0, 1)),
  version TEXT NOT NULL,
  internal_revision INTEGER NOT NULL CHECK (
    typeof(internal_revision) = 'integer' AND internal_revision >= 1
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id),
  FOREIGN KEY (benchmark_definition_id) REFERENCES benchmark_definitions(id) ON DELETE CASCADE,
  UNIQUE (benchmark_definition_id, version),
  CHECK (
    (source_batch_id IS NULL AND source_row_number IS NULL)
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)
  ),
  CHECK ((target_value IS NOT NULL AND lower_bound IS NULL AND upper_bound IS NULL) OR (target_value IS NULL AND lower_bound IS NOT NULL AND upper_bound IS NOT NULL AND lower_bound <= upper_bound)),
  CHECK (
    (reference_start_utc IS NULL AND reference_end_utc IS NULL)
    OR (
      reference_start_utc IS NOT NULL
      AND reference_end_utc IS NOT NULL
      AND unixepoch(reference_start_utc) < unixepoch(reference_end_utc)
    )
  ),
  CHECK (is_frozen = 0 OR (frozen_value IS NOT NULL AND frozen_at IS NOT NULL AND source_data_digest IS NOT NULL AND auto_refresh = 0))
);

-- N8 canonical v2 以规范比较键、显式来源分面和受保护工作簿追溯保存模型。
CREATE TABLE IF NOT EXISTS energy_flow_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER,
  model_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(model_code) = 1),
  model_name TEXT NOT NULL CHECK (length(trim(model_name)) BETWEEN 1 AND 300),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 1000),
  document_no TEXT CHECK (document_no IS NULL OR length(trim(document_no)) BETWEEN 1 AND 300),
  version TEXT NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 64),
  effective_start_wall_clock TEXT CHECK (effective_start_wall_clock IS NULL OR is_strict_wall_clock_minute(effective_start_wall_clock) = 1),
  effective_end_wall_clock TEXT CHECK (effective_end_wall_clock IS NULL OR is_strict_wall_clock_minute(effective_end_wall_clock) = 1),
  effective_start_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (length(trim(source_timezone)) BETWEEN 1 AND 100 AND is_valid_iana_timezone(source_timezone) = 1),
  classification_status TEXT NOT NULL DEFAULT 'legacy_unclassified' CHECK (classification_status IN ('legacy_unclassified', 'workbook_facts')),
  source_mode TEXT NOT NULL DEFAULT 'legacy_explicit_sources' CHECK (source_mode IN ('legacy_explicit_sources', 'workbook_facts_only')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  CHECK (
    (source_batch_id IS NULL AND source_row_number IS NULL)
    OR (
      source_batch_id IS NOT NULL
      AND typeof(source_row_number) = 'integer'
      AND source_row_number >= 1
    )
  ),
  CHECK (
    (effective_start_wall_clock IS NULL AND effective_end_wall_clock IS NULL)
    OR (
      effective_start_wall_clock IS NOT NULL
      AND effective_end_wall_clock IS NOT NULL
      AND effective_start_wall_clock < effective_end_wall_clock
    )
  ),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc)),
  CHECK (
    (classification_status = 'legacy_unclassified' AND source_mode = 'legacy_explicit_sources')
    OR (classification_status = 'workbook_facts' AND source_mode = 'workbook_facts_only')
  ),
  CHECK (
    classification_status <> 'workbook_facts'
    OR (
      source_batch_id IS NOT NULL
      AND source_row_number IS NOT NULL
      AND effective_start_wall_clock IS NOT NULL
      AND effective_end_wall_clock IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS energy_flow_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (typeof(source_row_number) = 'integer' AND source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  asset_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(asset_code) = 1),
  asset_name TEXT NOT NULL CHECK (length(trim(asset_name)) BETWEEN 1 AND 300),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('production_device', 'distribution_device', 'storage_device', 'recovery_device', 'measurement_device', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  UNIQUE (energy_flow_model_id, id)
);

CREATE TABLE IF NOT EXISTS energy_flow_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (typeof(source_row_number) = 'integer' AND source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  path_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(path_code) = 1),
  path_name TEXT NOT NULL CHECK (length(trim(path_name)) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  UNIQUE (energy_flow_model_id, id)
);

CREATE TABLE IF NOT EXISTS energy_flow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER,
  energy_flow_model_id INTEGER NOT NULL,
  energy_flow_asset_id INTEGER,
  node_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(node_code) = 1),
  node_name TEXT NOT NULL CHECK (length(trim(node_name)) BETWEEN 1 AND 300),
  node_type TEXT NOT NULL CHECK (node_type IN ('source', 'process', 'storage', 'sink', 'loss', 'boundary')),
  stage_code TEXT CHECK (stage_code IS NULL OR stage_code IN ('plant_entry', 'distribution', 'device_input', 'useful_output', 'waste_heat', 'loss', 'boundary')),
  organization_unit_id INTEGER,
  x REAL,
  y REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, energy_flow_asset_id) REFERENCES energy_flow_assets(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  UNIQUE (energy_flow_model_id, id),
  CHECK (source_row_number IS NULL OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1)),
  CHECK (
    (stage_code IS NULL AND energy_flow_asset_id IS NULL)
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)
  ),
  CHECK (
    (x IS NULL AND y IS NULL)
    OR (
      x IS NOT NULL AND y IS NOT NULL
      AND typeof(x) IN ('integer', 'real') AND typeof(y) IN ('integer', 'real')
      AND abs(x) <= 1000000000 AND abs(y) <= 1000000000
    )
  )
);

CREATE TABLE IF NOT EXISTS energy_flow_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER,
  energy_flow_model_id INTEGER NOT NULL,
  energy_flow_path_id INTEGER,
  path_sequence INTEGER,
  edge_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(edge_code) = 1),
  from_node_id INTEGER NOT NULL,
  to_node_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 100),
  source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'workbook_fact')),
  source_reference TEXT CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  source_mapping_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, energy_flow_path_id) REFERENCES energy_flow_paths(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, from_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, to_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (energy_flow_model_id, id),
  UNIQUE (energy_flow_model_id, id, energy_flow_path_id),
  UNIQUE (energy_flow_model_id, id, energy_flow_path_id, energy_type_id, unit),
  CHECK (source_row_number IS NULL OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1)),
  CHECK (
    (energy_flow_path_id IS NULL AND path_sequence IS NULL)
    OR (
      energy_flow_path_id IS NOT NULL
      AND typeof(path_sequence) = 'integer'
      AND path_sequence BETWEEN 1 AND 9007199254740991
    )
  ),
  CHECK (from_node_id <> to_node_id),
  CHECK (
    source_type <> 'workbook_fact'
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)
  ),
  CHECK (
    source_mapping_json IS NULL
    OR CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  ),
  CHECK (
    source_type = 'workbook_fact'
    OR source_mapping_json IS NOT NULL
  ),
  CHECK (source_type <> 'workbook_fact' OR energy_flow_path_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS energy_flow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER,
  source_row_number INTEGER,
  energy_flow_model_id INTEGER NOT NULL,
  record_code TEXT CHECK (record_code IS NULL OR is_valid_energy_flow_code(record_code) = 1),
  record_role TEXT CHECK (record_role IS NULL OR record_role IN ('edge_flow', 'storage_change')),
  energy_flow_edge_id INTEGER,
  energy_flow_node_id INTEGER,
  energy_flow_path_id INTEGER,
  energy_flow_asset_id INTEGER,
  stage_code TEXT CHECK (stage_code IS NULL OR stage_code IN ('plant_entry', 'distribution', 'device_input', 'useful_output', 'waste_heat', 'loss', 'boundary')),
  energy_type_id INTEGER,
  start_wall_clock TEXT CHECK (start_wall_clock IS NULL OR is_strict_wall_clock_minute(start_wall_clock) = 1),
  end_wall_clock TEXT CHECK (end_wall_clock IS NULL OR is_strict_wall_clock_minute(end_wall_clock) = 1),
  start_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (length(trim(source_timezone)) BETWEEN 1 AND 100 AND is_valid_iana_timezone(source_timezone) = 1),
  original_unit TEXT NOT NULL CHECK (length(trim(original_unit)) BETWEEN 1 AND 100),
  original_value REAL NOT NULL CHECK (typeof(original_value) IN ('integer', 'real') AND abs(original_value) <= 1000000000000000),
  source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'workbook_fact')),
  source_reference TEXT CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  source_mapping_json TEXT,
  formula_version TEXT,
  record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'void')),
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_edge_id) REFERENCES energy_flow_edges(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_edge_id, energy_flow_path_id) REFERENCES energy_flow_edges(energy_flow_model_id, id, energy_flow_path_id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_edge_id, energy_flow_path_id, energy_type_id, original_unit) REFERENCES energy_flow_edges(energy_flow_model_id, id, energy_flow_path_id, energy_type_id, unit) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_node_id) REFERENCES energy_flow_nodes(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_path_id) REFERENCES energy_flow_paths(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id, energy_flow_asset_id) REFERENCES energy_flow_assets(energy_flow_model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (energy_flow_model_id, id),
  CHECK (source_row_number IS NULL OR (typeof(source_row_number) = 'integer' AND source_row_number >= 1)),
  CHECK (
    (start_wall_clock IS NULL AND end_wall_clock IS NULL)
    OR (
      start_wall_clock IS NOT NULL
      AND end_wall_clock IS NOT NULL
      AND start_wall_clock < end_wall_clock
    )
  ),
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (
    record_role IS NULL
    OR (source_batch_id IS NOT NULL AND source_row_number IS NOT NULL)
  ),
  CHECK (
    source_mapping_json IS NULL
    OR CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  ),
  CHECK (record_role IS NULL OR source_type = 'workbook_fact'),
  CHECK (
    record_role IS NOT NULL
    OR (
      original_value >= 0
      AND source_mapping_json IS NOT NULL
      AND formula_version IS NOT NULL
    )
  ),
  CHECK (
    (record_role IS NULL
      AND record_code IS NULL
      AND energy_flow_edge_id IS NOT NULL
      AND energy_flow_node_id IS NULL
      AND energy_flow_path_id IS NULL
      AND energy_flow_asset_id IS NULL
      AND stage_code IS NULL
      AND energy_type_id IS NULL
      AND start_wall_clock IS NULL
      AND end_wall_clock IS NULL
      AND source_reference IS NULL)
    OR (record_role = 'edge_flow'
      AND record_code IS NOT NULL
      AND energy_flow_edge_id IS NOT NULL
      AND energy_flow_node_id IS NULL
      AND energy_flow_path_id IS NOT NULL
      AND stage_code IS NOT NULL
      AND energy_type_id IS NOT NULL
      AND start_wall_clock IS NOT NULL
      AND end_wall_clock IS NOT NULL
      AND source_reference IS NOT NULL
      AND original_value >= 0)
    OR (record_role = 'storage_change'
      AND record_code IS NOT NULL
      AND energy_flow_edge_id IS NULL
      AND energy_flow_node_id IS NOT NULL
      AND energy_flow_path_id IS NULL
      AND stage_code IS NOT NULL
      AND energy_type_id IS NOT NULL
      AND start_wall_clock IS NOT NULL
      AND end_wall_clock IS NOT NULL
      AND source_reference IS NOT NULL)
  ),
  CHECK (
    stage_code NOT IN ('device_input', 'useful_output')
    OR energy_flow_asset_id IS NOT NULL
  ),
  CHECK (
    (record_status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
    OR (
      record_status = 'void'
      AND trim(COALESCE(void_reason, '')) <> ''
      AND is_energy_flow_utc_second(voided_at) = 1
    )
  )
);

CREATE TABLE IF NOT EXISTS energy_flow_waste_heat_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (typeof(source_row_number) = 'integer' AND source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  waste_heat_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(waste_heat_code) = 1),
  energy_flow_record_id INTEGER NOT NULL,
  waste_heat_role TEXT NOT NULL CHECK (waste_heat_role IN ('generation', 'recovery', 'utilization', 'discharge')),
  source_reference TEXT CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, energy_flow_record_id) REFERENCES energy_flow_records(energy_flow_model_id, id) ON DELETE RESTRICT,
  UNIQUE (energy_flow_model_id, id)
);

CREATE TABLE IF NOT EXISTS energy_flow_loss_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (typeof(source_row_number) = 'integer' AND source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  loss_fact_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(loss_fact_code) = 1),
  energy_flow_record_id INTEGER NOT NULL,
  loss_fact_role TEXT NOT NULL CHECK (loss_fact_role IN ('distribution_loss', 'conversion_loss', 'storage_loss', 'device_loss', 'other_loss')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, energy_flow_record_id) REFERENCES energy_flow_records(energy_flow_model_id, id) ON DELETE RESTRICT,
  UNIQUE (energy_flow_model_id, id)
);

CREATE TABLE IF NOT EXISTS energy_flow_loss_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_batch_id INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (typeof(source_row_number) = 'integer' AND source_row_number >= 1),
  energy_flow_model_id INTEGER NOT NULL,
  energy_flow_loss_fact_id INTEGER NOT NULL,
  evidence_code TEXT NOT NULL CHECK (is_valid_energy_flow_code(evidence_code) = 1),
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('fact_evidence', 'benchmark')),
  evidence_name TEXT NOT NULL CHECK (length(trim(evidence_name)) BETWEEN 1 AND 300),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('meter_record', 'calculation_sheet', 'inspection_report', 'test_report', 'standard', 'other')),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 1000),
  evidence_start_wall_clock TEXT NOT NULL CHECK (is_strict_wall_clock_minute(evidence_start_wall_clock) = 1),
  evidence_end_wall_clock TEXT NOT NULL CHECK (is_strict_wall_clock_minute(evidence_end_wall_clock) = 1),
  evidence_start_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(evidence_start_utc) = 1),
  evidence_end_utc TEXT NOT NULL CHECK (is_energy_flow_utc_second(evidence_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (length(trim(source_timezone)) BETWEEN 1 AND 100 AND is_valid_iana_timezone(source_timezone) = 1),
  benchmark_loss_value REAL,
  benchmark_loss_unit TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_flow_model_id) REFERENCES energy_flow_models(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_flow_model_id, energy_flow_loss_fact_id) REFERENCES energy_flow_loss_facts(energy_flow_model_id, id) ON DELETE RESTRICT,
  CHECK (evidence_start_wall_clock < evidence_end_wall_clock),
  CHECK (unixepoch(evidence_start_utc) < unixepoch(evidence_end_utc)),
  CHECK (
    (evidence_role = 'benchmark'
      AND typeof(benchmark_loss_value) IN ('integer', 'real')
      AND benchmark_loss_value BETWEEN 0 AND 1000000000000000
      AND length(trim(benchmark_loss_unit)) BETWEEN 1 AND 100)
    OR (evidence_role = 'fact_evidence'
      AND benchmark_loss_value IS NULL
      AND benchmark_loss_unit IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS energy_balance_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boundary_code TEXT NOT NULL,
  boundary_name TEXT NOT NULL,
  organization_unit_id INTEGER,
  source TEXT NOT NULL,
  document_no TEXT,
  version TEXT NOT NULL,
  effective_start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_start_utc) = 1),
  effective_end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(effective_end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  generation_boundary_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (generation_boundary_confirmed IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE SET NULL,
  UNIQUE (boundary_code, version),
  CHECK (unixepoch(effective_start_utc) < unixepoch(effective_end_utc))
);

CREATE TABLE IF NOT EXISTS energy_balance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  energy_balance_boundary_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('input', 'self_generation', 'inventory_decrease', 'adjustment_increase', 'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease')),
  energy_type_id INTEGER NOT NULL,
  original_unit TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('timeseries', 'monthly_energy', 'generation', 'explicit_edge_value', 'explicit_balance_value')),
  source_mapping_json TEXT NOT NULL,
  generation_anti_double_count_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (energy_balance_boundary_id) REFERENCES energy_balance_boundaries(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  UNIQUE (energy_balance_boundary_id, item_code),
  CHECK (
    CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  )
);

CREATE TABLE IF NOT EXISTS energy_balance_calculation_runs (
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
);

CREATE TABLE IF NOT EXISTS energy_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calculation_run_id TEXT NOT NULL,
  energy_balance_boundary_id INTEGER NOT NULL,
  energy_type_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL CHECK (is_strict_utc_iso(start_utc) = 1),
  end_utc TEXT NOT NULL CHECK (is_strict_utc_iso(end_utc) = 1),
  source_timezone TEXT NOT NULL CHECK (is_valid_iana_timezone(source_timezone) = 1),
  original_unit TEXT NOT NULL,
  input_total_original REAL NOT NULL CHECK (input_total_original >= 0),
  output_total_original REAL NOT NULL CHECK (output_total_original >= 0),
  unexplained_original REAL NOT NULL,
  input_total_kgce REAL CHECK (input_total_kgce IS NULL OR input_total_kgce >= 0),
  output_total_kgce REAL CHECK (output_total_kgce IS NULL OR output_total_kgce >= 0),
  unexplained_kgce REAL,
  actual_factor_versions_json TEXT,
  formula_version TEXT NOT NULL,
  utilization_rate REAL CHECK (utilization_rate IS NULL OR utilization_rate BETWEEN 0 AND 1),
  loss_rate REAL CHECK (loss_rate IS NULL OR loss_rate BETWEEN 0 AND 1),
  completeness_rate REAL NOT NULL CHECK (completeness_rate BETWEEN 0 AND 1),
  confirmation_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation_status IN ('unconfirmed', 'accepted', 'rejected', 'resolved')),
  reason_codes_json TEXT,
  source_data_digest TEXT NOT NULL,
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR is_strict_utc_iso(confirmed_at) = 1),
  confirmation_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calculation_run_id) REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE,
  FOREIGN KEY (energy_balance_boundary_id) REFERENCES energy_balance_boundaries(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  CHECK (unixepoch(start_utc) < unixepoch(end_utc)),
  CHECK (
    actual_factor_versions_json IS NULL
    OR is_valid_factor_versions_json(actual_factor_versions_json) = 1
  ),
  CHECK (
    (input_total_kgce IS NULL AND output_total_kgce IS NULL AND unexplained_kgce IS NULL)
    OR is_valid_factor_versions_json(actual_factor_versions_json) = 1
  )
);

CREATE TABLE IF NOT EXISTS energy_balance_snapshot_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calculation_run_id TEXT NOT NULL,
  energy_balance_snapshot_id INTEGER NOT NULL,
  energy_balance_item_id INTEGER NOT NULL,
  item_code TEXT NOT NULL CHECK (length(trim(item_code)) BETWEEN 1 AND 100),
  item_name TEXT NOT NULL CHECK (length(trim(item_name)) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (role IN ('input', 'self_generation', 'inventory_decrease', 'adjustment_increase', 'output', 'useful_utilization', 'known_loss', 'inventory_increase', 'adjustment_decrease')),
  energy_type_id INTEGER NOT NULL,
  original_unit TEXT NOT NULL,
  original_value REAL NOT NULL CHECK (original_value >= 0),
  conversion_factor_id INTEGER,
  actual_factor_version TEXT,
  actual_factor_value REAL CHECK (actual_factor_value IS NULL OR actual_factor_value > 0),
  kgce_value REAL CHECK (kgce_value IS NULL OR kgce_value >= 0),
  formula_version TEXT NOT NULL,
  source_mapping_json TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calculation_run_id) REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE,
  FOREIGN KEY (energy_balance_snapshot_id) REFERENCES energy_balance_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (energy_balance_item_id) REFERENCES energy_balance_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (energy_type_id) REFERENCES energy_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (conversion_factor_id) REFERENCES energy_conversion_factors(id) ON DELETE SET NULL,
  UNIQUE (energy_balance_snapshot_id, energy_balance_item_id),
  CHECK (
    kgce_value IS NULL
    OR (
      trim(COALESCE(actual_factor_version, '')) <> ''
      AND actual_factor_value IS NOT NULL
      AND actual_factor_value > 0
    )
  ),
  CHECK (
    CASE WHEN json_valid(source_mapping_json) = 1 THEN
      json_type(source_mapping_json) = 'object'
      AND typeof(json_extract(source_mapping_json, '$.reference')) = 'text'
      AND trim(json_extract(source_mapping_json, '$.reference')) <> ''
    ELSE 0 END
  )
);

CREATE TABLE IF NOT EXISTS energy_balance_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calculation_run_id TEXT NOT NULL,
  energy_balance_snapshot_id INTEGER NOT NULL,
  strategy_rule_hit_id INTEGER,
  suggestion_code TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  threshold_json TEXT,
  evidence_json TEXT NOT NULL,
  estimated_saving REAL CHECK (estimated_saving IS NULL OR estimated_saving >= 0),
  estimated_saving_unit TEXT,
  manual_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (manual_status IN ('unconfirmed', 'accepted', 'rejected', 'resolved')),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR is_strict_utc_iso(reviewed_at) = 1),
  reviewed_by_user_id INTEGER,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calculation_run_id) REFERENCES energy_balance_calculation_runs(calculation_run_id) ON DELETE CASCADE,
  FOREIGN KEY (energy_balance_snapshot_id) REFERENCES energy_balance_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_rule_hit_id) REFERENCES strategy_rule_hits(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES sys_users(id) ON DELETE SET NULL,
  UNIQUE (energy_balance_snapshot_id, suggestion_code)
);

-- 计算运行的一等身份、来源窗口和公式元数据创建后不可修改。
CREATE TRIGGER IF NOT EXISTS trg_energy_balance_calculation_runs_immutable_update
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

-- 快照运行身份创建后不可改变，避免既有项目和建议在快照换绑后跨运行混入。
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

-- 快照项目必须与所属快照绑定到同一个计算运行，避免跨运行混入历史明细。
-- 快照的边界、时间窗、来源时区、摘要和公式版本必须与所属计算运行完全一致。
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

-- 快照项目编码和名称在计算时冻结，后续主项目变更不得改写历史标识。
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

-- 优化建议必须与所属快照绑定到同一个计算运行，内容摘要不得承担运行身份。
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
END;

-- 对标目标的导入批次与原始行号必须成对存在，且行号必须为正整数；触发器兼容旧库补列后的约束语义。
CREATE TRIGGER IF NOT EXISTS trg_benchmark_targets_source_insert
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
END;

-- 更新对标目标来源时继续维持批次与行号的成对、正整数约束。
CREATE TRIGGER IF NOT EXISTS trg_benchmark_targets_source_update
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
END;

-- 内部历史基准必须在首次写入时固化完整参考期、摘要、数值和来源摘要。
CREATE TRIGGER IF NOT EXISTS trg_benchmark_targets_internal_insert
BEFORE INSERT ON benchmark_targets
FOR EACH ROW
WHEN (
  SELECT benchmark_type
  FROM benchmark_definitions
  WHERE id = NEW.benchmark_definition_id
) = 'internal_history_baseline'
AND (
  NEW.is_frozen <> 1
  OR NEW.auto_refresh <> 0
  OR NEW.reference_start_utc IS NULL
  OR NEW.reference_end_utc IS NULL
  OR NEW.frozen_at IS NULL
  OR NEW.target_value IS NULL
  OR NEW.frozen_value IS NULL
  OR NEW.target_value <> NEW.frozen_value
  OR trim(COALESCE(NEW.source_data_digest, '')) = ''
  OR NEW.production_summary_json IS NULL
  OR CASE WHEN json_valid(NEW.production_summary_json) = 1 THEN
    json_type(NEW.production_summary_json) <> 'object'
    OR json(NEW.production_summary_json) = '{}'
  ELSE 1 END
)
BEGIN
  SELECT RAISE(ABORT, 'internal history baseline target must be frozen and complete');
END;

-- 内部历史基准更新后仍须保持固化快照约束。
CREATE TRIGGER IF NOT EXISTS trg_benchmark_targets_internal_update
BEFORE UPDATE ON benchmark_targets
FOR EACH ROW
WHEN (
  SELECT benchmark_type
  FROM benchmark_definitions
  WHERE id = NEW.benchmark_definition_id
) = 'internal_history_baseline'
AND (
  NEW.is_frozen <> 1
  OR NEW.auto_refresh <> 0
  OR NEW.reference_start_utc IS NULL
  OR NEW.reference_end_utc IS NULL
  OR NEW.frozen_at IS NULL
  OR NEW.target_value IS NULL
  OR NEW.frozen_value IS NULL
  OR NEW.target_value <> NEW.frozen_value
  OR trim(COALESCE(NEW.source_data_digest, '')) = ''
  OR NEW.production_summary_json IS NULL
  OR CASE WHEN json_valid(NEW.production_summary_json) = 1 THEN
    json_type(NEW.production_summary_json) <> 'object'
    OR json(NEW.production_summary_json) = '{}'
  ELSE 1 END
)
BEGIN
  SELECT RAISE(ABORT, 'internal history baseline target must remain frozen and complete');
END;

-- 基准定义改为内部历史类型前，拒绝保留任何未固化的已有目标。
CREATE TRIGGER IF NOT EXISTS trg_benchmark_definitions_internal_update
BEFORE UPDATE OF benchmark_type ON benchmark_definitions
FOR EACH ROW
WHEN NEW.benchmark_type = 'internal_history_baseline'
AND EXISTS (
  SELECT 1
  FROM benchmark_targets AS target
  WHERE target.benchmark_definition_id = NEW.id
    AND (
      target.is_frozen <> 1
      OR target.auto_refresh <> 0
      OR target.reference_start_utc IS NULL
      OR target.reference_end_utc IS NULL
      OR target.frozen_at IS NULL
      OR target.target_value IS NULL
      OR target.frozen_value IS NULL
      OR target.target_value <> target.frozen_value
      OR trim(COALESCE(target.source_data_digest, '')) = ''
      OR target.production_summary_json IS NULL
      OR CASE WHEN json_valid(target.production_summary_json) = 1 THEN
        json_type(target.production_summary_json) <> 'object'
        OR json(target.production_summary_json) = '{}'
      ELSE 1 END
    )
)
BEGIN
  SELECT RAISE(ABORT, 'existing targets must be frozen before changing benchmark type');
END;

-- 重叠事实由后续服务事务校验；以下索引用于同数据流区间候选查询与 active/void 过滤。
CREATE INDEX IF NOT EXISTS idx_energy_timeseries_stream_range ON energy_timeseries_records(energy_type_id, meter_device_id, organization_unit_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_timeseries_batch ON energy_timeseries_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_shift_definitions_effective ON shift_definitions(status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_shift_schedule_scope_range ON shift_schedule_records(organization_unit_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_shift_schedule_batch ON shift_schedule_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_device_state_meter_range ON device_state_records(meter_device_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_device_state_batch ON device_state_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_tou_schemes_effective ON tou_schemes(status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_tou_period_rules_scheme_day ON tou_period_rules(tou_scheme_id, day_of_week, start_minute);
CREATE INDEX IF NOT EXISTS idx_conversion_factors_match ON energy_conversion_factors(energy_type_id, source_unit, status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_conversion_factors_batch ON energy_conversion_factors(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_strategy_rules_status_metric ON strategy_rules(status, metric_code, rule_code);
CREATE INDEX IF NOT EXISTS idx_strategy_runs_scope_range ON strategy_evaluation_runs(scope_type, scope_reference, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_strategy_hits_run_status ON strategy_rule_hits(evaluation_run_id, match_status, manual_status);
CREATE INDEX IF NOT EXISTS idx_benchmark_definitions_match ON benchmark_definitions(metric_code, unit, period_type, direction, status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_benchmark_definitions_batch ON benchmark_definitions(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_benchmark_definitions_internal_revision ON benchmark_definitions(benchmark_code, internal_revision);
CREATE INDEX IF NOT EXISTS idx_benchmark_targets_definition_status ON benchmark_targets(benchmark_definition_id, status);
CREATE INDEX IF NOT EXISTS idx_benchmark_targets_batch ON benchmark_targets(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_benchmark_targets_internal_revision ON benchmark_targets(benchmark_definition_id, internal_revision);
-- N8 canonical v2 显式索引同时承担规范业务键、来源追溯和确定性查询候选过滤。
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_models_business_key ON energy_flow_models(normalize_energy_flow_key(model_code), normalize_energy_flow_key(version));
CREATE INDEX IF NOT EXISTS idx_energy_flow_models_effective ON energy_flow_models(classification_status, source_mode, status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_models_batch ON energy_flow_models(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_assets_code ON energy_flow_assets(energy_flow_model_id, normalize_energy_flow_key(asset_code));
CREATE INDEX IF NOT EXISTS idx_energy_flow_assets_model_type ON energy_flow_assets(energy_flow_model_id, asset_type, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_assets_batch ON energy_flow_assets(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_paths_code ON energy_flow_paths(energy_flow_model_id, normalize_energy_flow_key(path_code));
CREATE INDEX IF NOT EXISTS idx_energy_flow_paths_model_status ON energy_flow_paths(energy_flow_model_id, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_paths_batch ON energy_flow_paths(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_nodes_code ON energy_flow_nodes(energy_flow_model_id, normalize_energy_flow_key(node_code));
CREATE INDEX IF NOT EXISTS idx_energy_flow_nodes_model_type ON energy_flow_nodes(energy_flow_model_id, node_type, stage_code, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_nodes_asset ON energy_flow_nodes(energy_flow_model_id, energy_flow_asset_id, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_nodes_batch ON energy_flow_nodes(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_edges_code ON energy_flow_edges(energy_flow_model_id, normalize_energy_flow_key(edge_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_edges_path_sequence ON energy_flow_edges(energy_flow_model_id, energy_flow_path_id, path_sequence) WHERE energy_flow_path_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_energy_flow_edges_model_type ON energy_flow_edges(energy_flow_model_id, source_type, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_edges_path ON energy_flow_edges(energy_flow_model_id, energy_flow_path_id, path_sequence, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_edges_batch ON energy_flow_edges(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_records_code ON energy_flow_records(energy_flow_model_id, normalize_energy_flow_key(record_code)) WHERE record_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_edge_range ON energy_flow_records(energy_flow_edge_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_node_range ON energy_flow_records(energy_flow_node_id, energy_type_id, original_unit, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_model_stage ON energy_flow_records(energy_flow_model_id, record_role, stage_code, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_path ON energy_flow_records(energy_flow_model_id, energy_flow_path_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_asset ON energy_flow_records(energy_flow_model_id, energy_flow_asset_id, record_status, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_flow_records_batch ON energy_flow_records(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_waste_heat_code ON energy_flow_waste_heat_facts(energy_flow_model_id, normalize_energy_flow_key(waste_heat_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_waste_heat_active_record ON energy_flow_waste_heat_facts(energy_flow_record_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_energy_flow_waste_heat_model_role ON energy_flow_waste_heat_facts(energy_flow_model_id, waste_heat_role, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_waste_heat_batch ON energy_flow_waste_heat_facts(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_loss_facts_code ON energy_flow_loss_facts(energy_flow_model_id, normalize_energy_flow_key(loss_fact_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_loss_facts_active_record ON energy_flow_loss_facts(energy_flow_record_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_energy_flow_loss_facts_model_role ON energy_flow_loss_facts(energy_flow_model_id, loss_fact_role, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_loss_facts_batch ON energy_flow_loss_facts(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_loss_evidence_code ON energy_flow_loss_evidence(energy_flow_model_id, normalize_energy_flow_key(evidence_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_flow_loss_evidence_active_benchmark ON energy_flow_loss_evidence(energy_flow_loss_fact_id) WHERE evidence_role = 'benchmark' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_energy_flow_loss_evidence_fact_role ON energy_flow_loss_evidence(energy_flow_loss_fact_id, evidence_role, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_loss_evidence_range ON energy_flow_loss_evidence(energy_flow_model_id, evidence_start_utc, evidence_end_utc, status);
CREATE INDEX IF NOT EXISTS idx_energy_flow_loss_evidence_batch ON energy_flow_loss_evidence(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_energy_balance_boundaries_effective ON energy_balance_boundaries(status, effective_start_utc, effective_end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_balance_items_boundary_role ON energy_balance_items(energy_balance_boundary_id, role, status);
CREATE INDEX IF NOT EXISTS idx_energy_balance_runs_boundary_created ON energy_balance_calculation_runs(energy_balance_boundary_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_energy_balance_runs_digest ON energy_balance_calculation_runs(source_data_digest, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshots_run ON energy_balance_snapshots(calculation_run_id, id);
CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshots_boundary_range ON energy_balance_snapshots(energy_balance_boundary_id, energy_type_id, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshots_confirmation ON energy_balance_snapshots(confirmation_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshot_items_run ON energy_balance_snapshot_items(calculation_run_id, energy_balance_snapshot_id, role);
CREATE INDEX IF NOT EXISTS idx_energy_balance_snapshot_items_snapshot ON energy_balance_snapshot_items(energy_balance_snapshot_id, role);
CREATE INDEX IF NOT EXISTS idx_energy_balance_suggestions_run_status ON energy_balance_suggestions(calculation_run_id, manual_status, priority);
CREATE INDEX IF NOT EXISTS idx_energy_balance_suggestions_snapshot_status ON energy_balance_suggestions(energy_balance_snapshot_id, manual_status, priority);
-- ENERGY_ANALYSIS_SCHEMA_END

CREATE INDEX IF NOT EXISTS idx_import_batches_type_status_created ON import_batches(import_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_status_created ON import_batches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_errors_batch_row ON import_errors(batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_energy_types_active_order ON energy_types(is_active, display_order, code);
CREATE INDEX IF NOT EXISTS idx_organization_units_parent_status ON organization_units(parent_id, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_organization_units_path ON organization_units(unit_path);
CREATE INDEX IF NOT EXISTS idx_organization_units_type_status ON organization_units(unit_type, status);
CREATE INDEX IF NOT EXISTS idx_meter_devices_org_status ON meter_devices(organization_unit_id, status);
CREATE INDEX IF NOT EXISTS idx_meter_devices_energy_status ON meter_devices(energy_type_id, status);
CREATE INDEX IF NOT EXISTS idx_meter_devices_name_org ON meter_devices(organization_unit_id, meter_name);
CREATE INDEX IF NOT EXISTS idx_meter_reading_records_upload_duplicate ON meter_reading_records(meter_device_id, reading_date, data_source, record_status);
CREATE INDEX IF NOT EXISTS idx_meter_reading_records_meter_date ON meter_reading_records(meter_device_id, reading_date DESC);
CREATE INDEX IF NOT EXISTS idx_meter_reading_records_org_month ON meter_reading_records(organization_unit_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_meter_reading_records_energy_month ON meter_reading_records(energy_type_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_meter_reading_records_status_month ON meter_reading_records(record_status, normalized_month);
CREATE INDEX IF NOT EXISTS idx_production_units_org_status ON production_units(organization_unit_id, status);
CREATE INDEX IF NOT EXISTS idx_production_units_product_status ON production_units(product_name, status);
CREATE INDEX IF NOT EXISTS idx_production_units_batch ON production_units(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_production_output_records_unit_month ON production_output_records(production_unit_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_production_output_records_status_month ON production_output_records(record_status, normalized_month);
CREATE INDEX IF NOT EXISTS idx_production_output_records_batch ON production_output_records(source_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_production_output_records_active_unit_month ON production_output_records(production_unit_id, normalized_month) WHERE record_status = 'active';
CREATE INDEX IF NOT EXISTS idx_energy_records_month_type ON energy_records(normalized_month, energy_type_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_batch ON energy_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_organization_unit ON energy_records(organization_unit_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_meter_device ON energy_records(meter_device_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_records_active_duplicate_key ON energy_records(duplicate_key) WHERE record_status = 'active';
CREATE INDEX IF NOT EXISTS idx_generation_records_org_month ON generation_records(organization_unit_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_generation_records_batch ON generation_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_generation_records_energy_status ON generation_records(energy_type_id, record_status);
CREATE INDEX IF NOT EXISTS idx_generation_records_status_month ON generation_records(record_status, normalized_month);
CREATE UNIQUE INDEX IF NOT EXISTS ux_generation_records_active_org_month_energy ON generation_records(organization_unit_id, normalized_month, energy_type_id) WHERE record_status = 'active';
CREATE INDEX IF NOT EXISTS idx_energy_budgets_month_type_status ON energy_budgets(period_month, energy_type_id, status);
CREATE INDEX IF NOT EXISTS idx_energy_budgets_scope_status ON energy_budgets(organization_scope, status);
CREATE INDEX IF NOT EXISTS idx_energy_budgets_batch ON energy_budgets(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_carbon_factors_match ON carbon_factors(energy_type_id, region, factor_year, unit, is_active);
CREATE INDEX IF NOT EXISTS idx_carbon_factors_batch ON carbon_factors(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_carbon_emissions_record ON carbon_emissions(energy_record_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_carbon_emissions_record_method ON carbon_emissions(energy_record_id, calculation_method) WHERE status <> 'superseded';
CREATE INDEX IF NOT EXISTS idx_prediction_configs_status_updated ON prediction_configs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_configs_energy_month ON prediction_configs(energy_type_id, predict_start_month, predict_end_month);
CREATE INDEX IF NOT EXISTS idx_prediction_configs_batch ON prediction_configs(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_status_created ON prediction_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_results_run_month ON prediction_results(prediction_run_id, target_month);

INSERT OR IGNORE INTO energy_types (code, name, category, default_unit, standard_unit, carbon_factor_required, display_order) VALUES
  ('electricity', '电力', 'energy', 'kWh', 'kWh', 1, 10),
  ('photovoltaic', '光伏', 'energy', 'kWh', 'kWh', 1, 15),
  ('natural_gas', '天然气', 'energy', 'm3', 'm3', 1, 20),
  ('gasoline', '汽油', 'energy', 'L', 'L', 1, 30),
  ('diesel', '柴油', 'energy', 'L', 'L', 1, 40),
  ('oil', '油', 'energy', 't', 't', 1, 45),
  ('coal', '煤炭', 'energy', 't', 't', 1, 50),
  ('heat', '热力', 'heat', 'MJ', 'MJ', 1, 60),
  ('steam', '蒸汽', 'heat', 't', 't', 1, 70),
  ('water', '水', 'water', 'm3', 'm3', 0, 80);

UPDATE energy_types
SET default_unit = 't',
    standard_unit = 't',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE code = 'coal'
  AND (default_unit <> 't' OR standard_unit <> 't');

UPDATE energy_types
SET default_unit = 'MJ',
    standard_unit = 'MJ',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE code = 'heat'
  AND (default_unit <> 'MJ' OR standard_unit <> 'MJ');

CREATE TABLE IF NOT EXISTS sys_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sys_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sys_user_roles (
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES sys_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sys_menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  menu_type TEXT NOT NULL DEFAULT 'menu' CHECK (menu_type IN ('directory', 'menu', 'button')),
  menu_name TEXT NOT NULL,
  route_path TEXT,
  component TEXT,
  permission_code TEXT UNIQUE,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (parent_id) REFERENCES sys_menus(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sys_role_menus (
  role_id INTEGER NOT NULL,
  menu_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (role_id, menu_id),
  FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (menu_id) REFERENCES sys_menus(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sys_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  FOREIGN KEY (user_id) REFERENCES sys_users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sys_login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  reason TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES sys_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sys_operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  operation TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES sys_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sys_users_status_username ON sys_users(status, username);
CREATE INDEX IF NOT EXISTS idx_sys_roles_status_code ON sys_roles(status, role_code);
CREATE INDEX IF NOT EXISTS idx_sys_user_roles_role ON sys_user_roles(role_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sys_menus_parent_order ON sys_menus(parent_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_sys_role_menus_menu ON sys_role_menus(menu_id, role_id);
CREATE INDEX IF NOT EXISTS idx_sys_sessions_token_active ON sys_sessions(token_hash, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sys_sessions_user_active ON sys_sessions(user_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sys_login_logs_username_created ON sys_login_logs(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_operation_logs_user_created ON sys_operation_logs(user_id, created_at DESC);

-- DEMO_GOVERNANCE_SCHEMA_START
-- 演示运行期开关保持单行持久化；普通初始化仅补默认行，不覆盖已保存状态。
CREATE TABLE IF NOT EXISTS demo_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  runtime_epoch INTEGER NOT NULL DEFAULT 1 CHECK (runtime_epoch >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  change_reason TEXT NOT NULL DEFAULT 'schema_default' CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
  FOREIGN KEY (updated_by) REFERENCES sys_users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO demo_runtime_settings
  (id, enabled, runtime_epoch, revision, updated_by, change_reason)
VALUES (1, 0, 1, 1, NULL, 'schema_default');

-- 演示数据集运行只保存治理状态，不在本阶段创建或推进实际运行。
CREATE TABLE IF NOT EXISTS demo_dataset_runs (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_dataset_runs_active_dataset
  ON demo_dataset_runs(dataset_id)
  WHERE status IN ('active', 'completed', 'cleanup_pending', 'cleaning');
CREATE INDEX IF NOT EXISTS idx_demo_dataset_runs_status_created
  ON demo_dataset_runs(status, created_at DESC);

-- 演示导入上下文 v4 只保存令牌哈希，并冻结独立摘要、完整预演摘要、重新关联谱系及全部授权绑定。
CREATE TABLE IF NOT EXISTS demo_import_contexts (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_import_contexts_reassociated_from
  ON demo_import_contexts(reassociated_from_context_id)
  WHERE reassociated_from_context_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_import_contexts_replacement
  ON demo_import_contexts(replacement_context_id)
  WHERE replacement_context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demo_import_contexts_run_artifact
  ON demo_import_contexts(run_id, artifact_key, status);
CREATE INDEX IF NOT EXISTS idx_demo_import_contexts_user_expiry
  ON demo_import_contexts(issued_to_user_id, expires_at, status);
CREATE INDEX IF NOT EXISTS idx_demo_import_contexts_handler_status
  ON demo_import_contexts(handler_key, status, expires_at);

-- 历史纳管运行仅预留强证据、锁内计划和执行审计所需字段。
CREATE TABLE IF NOT EXISTS demo_legacy_claim_runs (
  claim_run_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  preview_expires_at TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  blocker_summary_json TEXT,
  confirmation_text TEXT,
  requested_by INTEGER,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'executing', 'succeeded', 'blocked', 'failed', 'expired')),
  claimed_count INTEGER NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  executed_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY (requested_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (length(trim(claim_run_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(dataset_id)) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_demo_legacy_claim_runs_status_created
  ON demo_legacy_claim_runs(status, created_at DESC);

-- 清理运行保留预演防陈旧、幂等请求、备份白名单元数据和最终结果。
CREATE TABLE IF NOT EXISTS demo_cleanup_runs (
  cleanup_run_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  preview_digest TEXT NOT NULL CHECK (length(preview_digest) = 64),
  preview_expires_at TEXT NOT NULL,
  runtime_revision INTEGER NOT NULL CHECK (runtime_revision >= 1),
  registry_watermark TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  summary_json TEXT,
  confirmation_text TEXT,
  requested_by INTEGER,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'executing', 'succeeded', 'blocked', 'failed', 'expired', 'noop')),
  backup_metadata_json TEXT,
  deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  already_missing_count INTEGER NOT NULL DEFAULT 0 CHECK (already_missing_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY (requested_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  CHECK (length(trim(cleanup_run_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(client_request_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(registry_watermark)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS idx_demo_cleanup_runs_status_created
  ON demo_cleanup_runs(status, created_at DESC);

-- 所有权注册表只允许服务端白名单实体写入；部分唯一索引防止多个未清理 run 接管同一业务记录。
CREATE TABLE IF NOT EXISTS demo_data_registry (
  registry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_pk TEXT NOT NULL,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('imported', 'derived', 'legacy_claimed')),
  identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 64),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  source_batch_id INTEGER,
  source_row_number INTEGER CHECK (source_row_number IS NULL OR source_row_number >= 1),
  legacy_claim_run_id TEXT,
  registered_by INTEGER,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cleaned_at TEXT,
  cleanup_run_id TEXT,
  cleanup_result TEXT CHECK (cleanup_result IS NULL OR cleanup_result IN ('deleted', 'already_missing')),
  FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (legacy_claim_run_id) REFERENCES demo_legacy_claim_runs(claim_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (registered_by) REFERENCES sys_users(id) ON DELETE SET NULL,
  FOREIGN KEY (cleanup_run_id) REFERENCES demo_cleanup_runs(cleanup_run_id) ON DELETE RESTRICT,
  UNIQUE (registry_id, run_id),
  CHECK (length(trim(artifact_key)) BETWEEN 1 AND 128),
  CHECK (length(trim(entity_type)) BETWEEN 1 AND 128),
  CHECK (length(trim(entity_pk)) BETWEEN 1 AND 256),
  CHECK ((cleaned_at IS NULL AND cleanup_run_id IS NULL AND cleanup_result IS NULL)
    OR (cleaned_at IS NOT NULL AND cleanup_run_id IS NOT NULL AND cleanup_result IS NOT NULL)),
  CHECK ((ownership_kind = 'legacy_claimed' AND legacy_claim_run_id IS NOT NULL)
    OR (ownership_kind <> 'legacy_claimed' AND legacy_claim_run_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_data_registry_active_entity
  ON demo_data_registry(entity_type, entity_pk)
  WHERE cleaned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_demo_data_registry_run_artifact
  ON demo_data_registry(run_id, artifact_key, cleaned_at);
CREATE INDEX IF NOT EXISTS idx_demo_data_registry_batch
  ON demo_data_registry(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_demo_data_registry_cleanup
  ON demo_data_registry(cleanup_run_id, cleanup_result);

-- 注册表关系使用受控类型表达来源和配置依赖，后续阶段不得由客户端传入动态 SQL。
CREATE TABLE IF NOT EXISTS demo_data_relations (
  relation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  from_registry_id INTEGER NOT NULL,
  to_registry_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('contains', 'generated_from', 'uses_config', 'uses_factor')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES demo_dataset_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_registry_id, run_id) REFERENCES demo_data_registry(registry_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_registry_id, run_id) REFERENCES demo_data_registry(registry_id, run_id) ON DELETE RESTRICT,
  UNIQUE (from_registry_id, to_registry_id, relation_type),
  CHECK (from_registry_id <> to_registry_id)
);

CREATE INDEX IF NOT EXISTS idx_demo_data_relations_run_type
  ON demo_data_relations(run_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_demo_data_relations_target
  ON demo_data_relations(to_registry_id, relation_type);

-- 运行、artifact、上下文与真实导入批次保持多批次可追溯关系，不改变原导入审计生命周期。
CREATE TABLE IF NOT EXISTS demo_run_import_batches (
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
);

CREATE INDEX IF NOT EXISTS idx_demo_run_import_batches_batch
  ON demo_run_import_batches(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_demo_run_import_batches_run_artifact
  ON demo_run_import_batches(run_id, artifact_key, batch_role);
CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_run_import_batches_primary_context
  ON demo_run_import_batches(context_id)
  WHERE batch_role = 'primary';
-- DEMO_GOVERNANCE_SCHEMA_END
