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

const IMPORT_BATCHES_TABLE_WITH_LEDGER_TYPES_SQL = `CREATE TABLE import_batches__migration_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_output', 'generation_record')),
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

function importBatchesImportTypeCheckAllowsAuditTypes(createTableSql) {
  const sql = createTableSql || '';
  return /import_type\s+TEXT[\s\S]*CHECK\s*\([\s\S]*import_type\s+IN\s*\([\s\S]*'organization_unit'[\s\S]*'meter_device'[\s\S]*'production_output'[\s\S]*'generation_record'/i.test(sql);
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
    "import_type TEXT NOT NULL DEFAULT 'energy_record' CHECK (import_type IN ('energy_record', 'meter_reading', 'organization_unit', 'meter_device', 'production_output', 'generation_record'))"
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

function migrateImportAuditSourceColumns(db) {
  let changed = false;

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

  return changed;
}

function initDatabase() {
  const db = openDatabase();
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    migrateCarbonEmissionsStatusCheck(db);
    migrateEnergyRecordLedgerColumns(db);
    migrateImportBatchesImportTypeCheck(db);
    migrateGenerationRecordsDataSourceCheck(db);
    migrateImportAuditSourceColumns(db);
    db.exec('DROP INDEX IF EXISTS ux_carbon_emissions_record_method');
    db.exec(schema);
    db.prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run('schema_stage', 'generation-basic');
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
  buildGenerationRecordsDataSourceMigrationSql,
  buildImportBatchesImportTypeMigrationSql,
  carbonEmissionsStatusCheckAllowsSuperseded,
  ensureLocalDataDirectories,
  generationRecordsDataSourceCheckAllowsUpload,
  getDatabaseInfo,
  getTableColumns,
  importBatchesHasAuditColumns,
  importBatchesImportTypeCheckAllowsAuditTypes,
  importBatchesImportTypeCheckAllowsLedgerTypes,
  initDatabase,
  migrateCarbonEmissionsStatusCheck,
  migrateEnergyRecordLedgerColumns,
  migrateGenerationRecordsDataSourceCheck,
  migrateImportAuditSourceColumns,
  migrateImportBatchesImportTypeCheck,
  openDatabase
};
