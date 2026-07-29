PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device')),
  original_filename TEXT NOT NULL,
  stored_filename TEXT,
  file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'xls', 'csv')),
  file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
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

CREATE TABLE IF NOT EXISTS prediction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('moving_average', 'linear_trend', 'year_over_year', 'manual_baseline')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
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
CREATE INDEX IF NOT EXISTS idx_energy_records_month_type ON energy_records(normalized_month, energy_type_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_batch ON energy_records(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_organization_unit ON energy_records(organization_unit_id);
CREATE INDEX IF NOT EXISTS idx_energy_records_meter_device ON energy_records(meter_device_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_energy_records_active_duplicate_key ON energy_records(duplicate_key) WHERE record_status = 'active';
CREATE INDEX IF NOT EXISTS idx_carbon_factors_match ON carbon_factors(energy_type_id, region, factor_year, unit, is_active);
CREATE INDEX IF NOT EXISTS idx_carbon_emissions_record ON carbon_emissions(energy_record_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_carbon_emissions_record_method ON carbon_emissions(energy_record_id, calculation_method) WHERE status <> 'superseded';
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

INSERT OR IGNORE INTO app_meta (key, value) VALUES
  ('schema_stage', 'ledger-basic'),
  ('schema_version', '2026-07-27-ledger-basic');
