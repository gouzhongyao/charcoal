const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../../data');
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
const backupsDir = process.env.BACKUPS_DIR || path.join(dataDir, 'backups');
const databasePath = process.env.SQLITE_PATH || path.join(dataDir, 'energy-carbon.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

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

const PRODUCTION_TABLES_SQL = `CREATE TABLE IF NOT EXISTS production_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_code TEXT NOT NULL UNIQUE,
  unit_name TEXT NOT NULL,
  organization_unit_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  output_unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (organization_unit_id) REFERENCES organization_units(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS production_output_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  FOREIGN KEY (production_unit_id) REFERENCES production_units(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_production_units_org_status ON production_units(organization_unit_id, status);
CREATE INDEX IF NOT EXISTS idx_production_units_product_status ON production_units(product_name, status);
CREATE INDEX IF NOT EXISTS idx_production_output_records_unit_month ON production_output_records(production_unit_id, normalized_month);
CREATE INDEX IF NOT EXISTS idx_production_output_records_status_month ON production_output_records(record_status, normalized_month);
CREATE UNIQUE INDEX IF NOT EXISTS ux_production_output_records_active_unit_month ON production_output_records(production_unit_id, normalized_month) WHERE record_status = 'active';`;

const IMPORT_BATCHES_TABLE_WITH_LEDGER_TYPES_SQL = `CREATE TABLE import_batches__migration_new (
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

function openDatabase() {
  ensureLocalDataDirectories();
  const Database = loadDatabaseDriver();
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  return db;
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

function buildImportBatchesImportTypeMigrationSql() {
  return [
    'DROP TABLE IF EXISTS import_batches__migration_new',
    IMPORT_BATCHES_TABLE_WITH_LEDGER_TYPES_SQL,
    IMPORT_BATCHES_COPY_SQL,
    'DROP TABLE import_batches',
    'ALTER TABLE import_batches__migration_new RENAME TO import_batches'
  ];
}

function buildCarbonEmissionsStatusMigrationSql() {
  return [
    'DROP TABLE IF EXISTS carbon_emissions__migration_new',
    CARBON_EMISSIONS_TABLE_WITH_SUPERSEDED_SQL,
    CARBON_EMISSIONS_COPY_SQL,
    'DROP TABLE carbon_emissions',
    'ALTER TABLE carbon_emissions__migration_new RENAME TO carbon_emissions'
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
  if (!createTableSql || importBatchesImportTypeCheckAllowsLedgerTypes(createTableSql)) {
    return false;
  }

  const wasForeignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      buildImportBatchesImportTypeMigrationSql().forEach((sql) => db.exec(sql));
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
    "import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device'))"
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

function initDatabase() {
  const db = openDatabase();
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    migrateCarbonEmissionsStatusCheck(db);
    migrateEnergyRecordLedgerColumns(db);
    migrateImportBatchesImportTypeCheck(db);
    db.exec('DROP INDEX IF EXISTS ux_carbon_emissions_record_method');
    db.exec(schema);
    db.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run('schema_stage', 'production-basic');
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
  buildCarbonEmissionsStatusMigrationSql,
  buildImportBatchesImportTypeMigrationSql,
  carbonEmissionsStatusCheckAllowsSuperseded,
  ensureLocalDataDirectories,
  getDatabaseInfo,
  getTableColumns,
  importBatchesImportTypeCheckAllowsLedgerTypes,
  initDatabase,
  migrateCarbonEmissionsStatusCheck,
  migrateEnergyRecordLedgerColumns,
  migrateImportBatchesImportTypeCheck,
  openDatabase
};
