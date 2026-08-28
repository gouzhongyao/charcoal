'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// meter 后置动作测试只使用隔离临时 SQLite，不触碰项目真实业务数据库。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-demo-meter-action-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'meter-action.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';

const { initDatabase, openDatabase } = require('../db/database');
const { toggleDemoRuntime } = require('../services/demoRuntimeService');
const { getOrCreateActiveDemoDatasetRun } = require('../services/demoRunService');
const {
  calculateDemoEntityIdentityDigest,
  calculateDemoEntitySnapshotDigest,
  DEMO_OWNERSHIP_ENTITY_HANDLERS
} = require('../services/demoOwnershipService');
const {
  executeDemoPostAction,
  getDemoPostActionStatus,
  previewDemoPostAction
} = require('../services/demoPostActionService');
const {
  METER_READING_GENERATION_BACKUP_REASON,
  revalidateMeterReadingGenerationBackupEvidence
} = require('../services/meterReadingService');

const FIXED_SHA = crypto.createHash('sha256').update('demo-meter-readings-2026-08', 'utf8').digest('hex');
const FIXED_NOW = '2026-08-28T00:00:00.000Z';

function assertSafe(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  ['handler', 'modulepath', 'sql', 'registryid', 'identitydigest', 'snapshotdigest', 'importbatchid',
    'contextid', 'filesha', 'readingid', 'energyrecordid', 'outputentityid', 'sourcebatchid'].forEach((field) => {
    assert.strictEqual(serialized.includes(`"${field}"`), false, `公共 DTO 不得泄露 ${field}`);
  });
}

function seedMeterEvidence(db, run) {
  const energyTypeId = Number(db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id);
  const organizationUnitId = Number(db.prepare(`INSERT INTO organization_units
    (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at)
    VALUES ('METER-DEMO-UNIT', '抄表隔离单元', '/抄表隔离单元', 'workshop', 'active', ?, ?)`).run(FIXED_NOW, FIXED_NOW).lastInsertRowid);
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status, created_at, updated_at)
    VALUES ('METER-DEMO-01', '抄表隔离表计', 'electricity', ?, ?, 'active', ?, ?)`).run(
    energyTypeId, organizationUnitId, FIXED_NOW, FIXED_NOW
  ).lastInsertRowid);
  const batchId = Number(db.prepare(`INSERT INTO import_batches
    (import_type, original_filename, file_type, file_size_bytes, file_sha256, status, audit_phase,
     total_rows, success_count, failure_count, skipped_count, created_at, updated_at)
    VALUES ('meter_reading', '08-meter-readings-2026-08.xlsx', 'xlsx', 128, ?, 'completed', 'execute', 1, 1, 0, 0, ?, ?)`).run(
    FIXED_SHA, FIXED_NOW, FIXED_NOW
  ).lastInsertRowid);
  const readingId = Number(db.prepare(`INSERT INTO meter_reading_records
    (source_batch_id, meter_device_id, organization_unit_id, energy_type_id, reading_date,
     normalized_month, previous_value, current_value, multiplier, usage_value, original_unit,
     normalized_unit, normalized_usage_value, data_source, record_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2026-08-15', '2026-08', 100, 125, 1, 25, 'kWh', 'kWh', 25,
      'upload', 'active', ?, ?)`).run(
    batchId, meterDeviceId, organizationUnitId, energyTypeId, FIXED_NOW, FIXED_NOW
  ).lastInsertRowid);
  const contextId = 'meter-demo-context-08';
  db.prepare(`INSERT INTO demo_import_contexts
    (context_id, token_hash, run_id, dataset_id, manifest_version, manifest_digest, artifact_key,
     handler_key, artifact_file_sha256, issued_to_user_id, runtime_epoch, status, issued_at,
     expires_at, upload_file_sha256, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, '08-meter-readings-2026-08', 'meter-readings-import', ?, 1, ?,
      'executed', ?, '2026-09-01T00:00:00.000Z', ?, ?)`).run(
    contextId, crypto.createHash('sha256').update('meter-context-token', 'utf8').digest('hex'),
    run.runId, run.datasetId, run.manifestVersion, run.manifestDigest, FIXED_SHA,
    run.runtimeEpoch, FIXED_NOW, FIXED_SHA, FIXED_NOW
  );
  db.prepare(`INSERT INTO demo_run_import_batches
    (run_id, artifact_key, context_id, import_batch_id, batch_role)
    VALUES (?, '08-meter-readings-2026-08', ?, ?, 'primary')`).run(run.runId, contextId, batchId);
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS.meter_reading.readProjection(db, readingId);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
     snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, '08-meter-readings-2026-08', 'meter_reading', ?, 'imported', ?, ?, ?, NULL, 1)`).run(
    run.runId,
    String(readingId),
    calculateDemoEntityIdentityDigest('meter_reading', String(readingId)),
    calculateDemoEntitySnapshotDigest('meter_reading', String(readingId), projection),
    batchId
  );
  return { readingId, batchId, meterDeviceId, organizationUnitId, energyTypeId };
}

function addOwnedMeterReading(db, run, source, suffix, month = '2026-08') {
  const meterDeviceId = Number(db.prepare(`INSERT INTO meter_devices
    (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status, created_at, updated_at)
    VALUES (?, ?, 'electricity', ?, ?, 'active', ?, ?)`).run(
    `METER-DEMO-${suffix}`,
    `抄表隔离表计${suffix}`,
    source.energyTypeId,
    source.organizationUnitId,
    FIXED_NOW,
    FIXED_NOW
  ).lastInsertRowid);
  const readingId = Number(db.prepare(`INSERT INTO meter_reading_records
    (source_batch_id, meter_device_id, organization_unit_id, energy_type_id, reading_date,
     normalized_month, previous_value, current_value, multiplier, usage_value, original_unit,
     normalized_unit, normalized_usage_value, data_source, record_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 200, 230, 1, 30, 'kWh', 'kWh', 30,
      'upload', 'active', ?, ?)`).run(
    source.batchId,
    meterDeviceId,
    source.organizationUnitId,
    source.energyTypeId,
    `${month}-20`,
    month,
    FIXED_NOW,
    FIXED_NOW
  ).lastInsertRowid);
  const projection = DEMO_OWNERSHIP_ENTITY_HANDLERS.meter_reading.readProjection(db, readingId);
  db.prepare(`INSERT INTO demo_data_registry
    (run_id, artifact_key, entity_type, entity_pk, ownership_kind, identity_digest,
     snapshot_digest, source_batch_id, source_row_number, registered_by)
    VALUES (?, '08-meter-readings-2026-08', 'meter_reading', ?, 'imported', ?, ?, ?, NULL, 1)`).run(
    run.runId,
    String(readingId),
    calculateDemoEntityIdentityDigest('meter_reading', String(readingId)),
    calculateDemoEntitySnapshotDigest('meter_reading', String(readingId), projection),
    source.batchId
  );
  db.prepare(`UPDATE import_batches SET total_rows = total_rows + 1,
    success_count = success_count + 1, updated_at = ? WHERE id = ?`).run(FIXED_NOW, source.batchId);
  return { readingId, meterDeviceId };
}

function executeMeterAction(db, preview, clientRequestId, actorUserId = 1) {
  return executeDemoPostAction({
    actionRunId: preview.actionRunId,
    body: {
      clientRequestId,
      previewDigest: preview.previewDigest,
      confirmationText: '确认执行抄表转能耗记录'
    },
    actorUserId,
    db
  });
}

/** 断言失败动作已回滚领域事实、来源回写、派生治理记录、输出和领域审计。 */
function assertMeterActionRolledBack(db, preview, readingId, expectedSourceSnapshotDigest) {
  assert.strictEqual(preview.status, 'failed');
  assert.strictEqual(preview.outputCount, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM energy_records').get().count, 0);
  assert.strictEqual(db.prepare('SELECT generated_energy_record_id AS generatedId FROM meter_reading_records WHERE id = ?').get(readingId).generatedId, null);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE ownership_kind = 'derived'").get().count, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM demo_data_relations WHERE relation_type = 'generated_from'").get().count, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs WHERE action_run_id = ?').get(preview.actionRunId).count, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'ledger.meter-reading.generate-energy-record' AND detail_json LIKE ?").get(`%${preview.actionRunId}%`).count, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sys_operation_logs WHERE operation = 'system.demo.post-action.execute' AND target_id = ?").get(preview.actionRunId).count, 1);
  const currentSourceSnapshotDigest = db.prepare("SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
    .get(String(readingId)).snapshotDigest;
  assert.strictEqual(currentSourceSnapshotDigest, expectedSourceSnapshotDigest);
}

/** 断言 blocked 动作 execute 按 registry 固定确认文本 fail-closed。 */
function assertBlockedMeterExecution(db, preview, clientRequestId, actorUserId = 1) {
  assert.throws(
    () => executeMeterAction(db, preview, clientRequestId, actorUserId),
    (error) => error.code === preview.blocker.code && error.statusCode === 409
  );
}

/** 为真实临时普通文件构造 meter 备份证据。 */
function createMeterBackupEvidence(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    backupName: path.basename(filePath),
    path: filePath,
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    reason: METER_READING_GENERATION_BACKUP_REASON,
    method: 'test-copy',
    databasePath: process.env.SQLITE_PATH
  };
}

/** 断言备份证据以稳定且不泄露绝对路径的业务错误拒绝。 */
function assertMeterBackupEvidenceRejected(evidence, expectedCode, sensitivePaths = []) {
  let caughtError = null;
  try {
    revalidateMeterReadingGenerationBackupEvidence(evidence);
  } catch (error) {
    caughtError = error;
  }
  assert(caughtError, `备份证据应以 ${expectedCode} 拒绝`);
  assert.strictEqual(caughtError.code, expectedCode);
  assert.strictEqual(caughtError.statusCode, 409);
  const serialized = JSON.stringify({
    code: caughtError.code,
    message: caughtError.message,
    details: caughtError.details
  }).toLowerCase();
  sensitivePaths.forEach((sensitivePath) => {
    const absolutePath = path.resolve(sensitivePath);
    const escapedPath = JSON.stringify(absolutePath).slice(1, -1).toLowerCase();
    assert.strictEqual(serialized.includes(escapedPath), false, '备份证据错误不得泄露绝对路径');
  });
}

/** 判断当前平台是否明确阻止创建文件符号链接。 */
function isMeterLinkCapabilityUnavailable(error) {
  return error && ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM', 'UNKNOWN'].includes(error.code);
}

/** 规范测试路径比较值，避免 Windows 大小写差异影响受控注入。 */
function normalizeMeterTestPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 将真实备份目录原子移开并用目录 symlink/junction 替换。 */
function replaceMeterBackupsDirectoryWithLink(backupsPath, parkedPath, outsideDirectory) {
  fs.renameSync(backupsPath, parkedPath);
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outsideDirectory, backupsPath, linkType);
    return linkType;
  } catch (error) {
    fs.renameSync(parkedPath, backupsPath);
    throw error;
  }
}

/** 删除测试目录链接并恢复原始真实备份目录。 */
function restoreMeterBackupsDirectory(backupsPath, parkedPath) {
  if (fs.existsSync(backupsPath)) {
    fs.rmSync(backupsPath, { recursive: true, force: true });
  }
  if (fs.existsSync(parkedPath)) {
    fs.renameSync(parkedPath, backupsPath);
  }
}

/** 在首次目录 lstat 后、realpath 前真实替换目录并断言稳定拒绝。 */
function assertMeterBackupDirectoryReplacementDuringRealpath(backupsPath, payload) {
  const raceName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-base-realpath-race.sqlite`;
  const racePath = path.join(backupsPath, raceName);
  const outsideDirectory = path.join(tmpDir, 'meter-backup-realpath-race-outside');
  const parkedPath = path.join(tmpDir, 'meter-backup-realpath-race-original');
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(racePath, payload);
  fs.writeFileSync(path.join(outsideDirectory, raceName), payload);
  const evidence = createMeterBackupEvidence(racePath);
  const originalRealpathSync = fs.realpathSync;
  let injected = false;
  let linkType = null;
  fs.realpathSync = function injectedMeterBackupRealpath(candidatePath, ...args) {
    if (!injected && normalizeMeterTestPath(candidatePath) === normalizeMeterTestPath(backupsPath)) {
      linkType = replaceMeterBackupsDirectoryWithLink(backupsPath, parkedPath, outsideDirectory);
      injected = true;
    }
    return originalRealpathSync.call(fs, candidatePath, ...args);
  };
  try {
    assertMeterBackupEvidenceRejected(
      evidence,
      'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
      [backupsPath, racePath, outsideDirectory]
    );
  } finally {
    fs.realpathSync = originalRealpathSync;
    restoreMeterBackupsDirectory(backupsPath, parkedPath);
  }
  assert.strictEqual(injected, true, '应在 lstat→realpath 窗口执行目录替换注入');
  assert.strictEqual(linkType, process.platform === 'win32' ? 'junction' : 'dir');
  revalidateMeterReadingGenerationBackupEvidence(evidence);
  console.log(`meter backup directory replacement race executed during realpath via ${linkType}`);
}

/** 在 evidence 打开前真实替换目录，确保打开后的目录身份复验 fail-closed。 */
function assertMeterBackupDirectoryReplacementBeforeOpen(backupsPath, payload) {
  const raceName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-base-open-race.sqlite`;
  const racePath = path.join(backupsPath, raceName);
  const outsideDirectory = path.join(tmpDir, 'meter-backup-open-race-outside');
  const parkedPath = path.join(tmpDir, 'meter-backup-open-race-original');
  const outsideRacePath = path.join(outsideDirectory, raceName);
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(racePath, payload);
  fs.writeFileSync(outsideRacePath, payload);
  const evidence = createMeterBackupEvidence(racePath);
  const originalOpenSync = fs.openSync;
  let injected = false;
  let linkType = null;
  fs.openSync = function injectedMeterBackupOpen(candidatePath, ...args) {
    if (!injected && normalizeMeterTestPath(candidatePath) === normalizeMeterTestPath(racePath)) {
      linkType = replaceMeterBackupsDirectoryWithLink(backupsPath, parkedPath, outsideDirectory);
      injected = true;
    }
    return originalOpenSync.call(fs, candidatePath, ...args);
  };
  try {
    assertMeterBackupEvidenceRejected(
      evidence,
      'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
      [backupsPath, racePath, outsideDirectory]
    );
  } finally {
    fs.openSync = originalOpenSync;
    restoreMeterBackupsDirectory(backupsPath, parkedPath);
  }
  assert.strictEqual(injected, true, '应在 evidence open 前执行目录替换注入');
  assert.strictEqual(linkType, process.platform === 'win32' ? 'junction' : 'dir');
  revalidateMeterReadingGenerationBackupEvidence(evidence);
  console.log(`meter backup directory replacement race executed before open via ${linkType}`);
}

/** 回归真实文件、物理路径边界、符号链接和同句柄内容校验。 */
function assertMeterBackupEvidencePhysicalSafety() {
  const backupsPath = process.env.BACKUPS_DIR;
  fs.mkdirSync(backupsPath, { recursive: true });
  const validName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-valid.sqlite`;
  const validPath = path.join(backupsPath, validName);
  const validPayload = Buffer.from('meter-backup-payload-A', 'utf8');
  const changedPayload = Buffer.from('meter-backup-payload-B', 'utf8');
  assert.strictEqual(validPayload.length, changedPayload.length);
  fs.writeFileSync(validPath, validPayload);
  const validEvidence = createMeterBackupEvidence(validPath);
  const validated = revalidateMeterReadingGenerationBackupEvidence(validEvidence);
  assert.strictEqual(Object.isFrozen(validated), true);
  assert.strictEqual(validated.path, path.resolve(validPath));
  assert.strictEqual(validated.sizeBytes, validPayload.length);
  assert.strictEqual(validated.sha256, validEvidence.sha256);

  assertMeterBackupDirectoryReplacementDuringRealpath(backupsPath, validPayload);
  assertMeterBackupDirectoryReplacementBeforeOpen(backupsPath, validPayload);

  assertMeterBackupEvidenceRejected(
    { ...validEvidence, sizeBytes: validEvidence.sizeBytes + 1 },
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    [backupsPath, validPath]
  );
  assertMeterBackupEvidenceRejected(
    { ...validEvidence, sha256: '0'.repeat(64) },
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    [backupsPath, validPath]
  );
  fs.writeFileSync(validPath, changedPayload);
  assertMeterBackupEvidenceRejected(
    validEvidence,
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    [backupsPath, validPath]
  );

  const missingPath = path.join(
    backupsPath,
    `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-missing.sqlite`
  );
  assertMeterBackupEvidenceRejected(
    { ...validEvidence, backupName: path.basename(missingPath), path: missingPath },
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    [backupsPath, missingPath]
  );

  const directoryEvidencePath = path.join(
    backupsPath,
    `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-directory.sqlite`
  );
  fs.mkdirSync(directoryEvidencePath);
  assertMeterBackupEvidenceRejected(
    { ...validEvidence, backupName: path.basename(directoryEvidencePath), path: directoryEvidencePath },
    'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
    [backupsPath, directoryEvidencePath]
  );

  const outsideName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-outside.sqlite`;
  const outsidePath = path.join(tmpDir, outsideName);
  fs.writeFileSync(outsidePath, validPayload);
  assertMeterBackupEvidenceRejected(
    createMeterBackupEvidence(outsidePath),
    'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
    [backupsPath, outsidePath]
  );

  const fileLinkName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-file-link.sqlite`;
  const fileLinkPath = path.join(backupsPath, fileLinkName);
  try {
    fs.symlinkSync(outsidePath, fileLinkPath, 'file');
    const fileLinkEvidence = {
      ...createMeterBackupEvidence(outsidePath),
      backupName: fileLinkName,
      path: fileLinkPath
    };
    assertMeterBackupEvidenceRejected(
      fileLinkEvidence,
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      [backupsPath, outsidePath, fileLinkPath]
    );
    console.log('meter backup evidence file symlink regression executed');
  } catch (error) {
    if (!isMeterLinkCapabilityUnavailable(error)) throw error;
    console.log(`meter backup evidence file symlink regression skipped: ${error.code}`);
  }

  const outsideDirectory = path.join(tmpDir, 'meter-backup-outside-directory');
  fs.mkdirSync(outsideDirectory);
  const linkedFileName = `energy-carbon-${METER_READING_GENERATION_BACKUP_REASON}-directory-link.sqlite`;
  const outsideLinkedFile = path.join(outsideDirectory, linkedFileName);
  fs.writeFileSync(outsideLinkedFile, validPayload);
  const directoryLinkPath = path.join(backupsPath, 'outside-directory-link');
  let directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(outsideDirectory, directoryLinkPath, directoryLinkType);
  } catch (error) {
    if (process.platform === 'win32' || !isMeterLinkCapabilityUnavailable(error)) throw error;
    console.log(`meter backup evidence directory symlink regression skipped: ${error.code}`);
    directoryLinkType = null;
  }
  if (directoryLinkType) {
    const logicalLinkedFile = path.join(directoryLinkPath, linkedFileName);
    const directoryLinkEvidence = {
      ...createMeterBackupEvidence(outsideLinkedFile),
      path: logicalLinkedFile
    };
    assertMeterBackupEvidenceRejected(
      directoryLinkEvidence,
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      [backupsPath, outsideLinkedFile, logicalLinkedFile]
    );
    console.log(`meter backup evidence directory link regression executed via ${directoryLinkType}`);
  }

  fs.rmSync(backupsPath, { recursive: true, force: true });
  assertMeterBackupEvidenceRejected(
    validEvidence,
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    [backupsPath, validPath]
  );
  fs.writeFileSync(backupsPath, 'not a directory', 'utf8');
  assertMeterBackupEvidenceRejected(
    validEvidence,
    'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
    [backupsPath, validPath]
  );
  fs.rmSync(backupsPath, { force: true });
  fs.mkdirSync(backupsPath, { recursive: true });
}

function runTest() {
  try {
    assertMeterBackupEvidencePhysicalSafety();
    initDatabase();
    toggleDemoRuntime({ enabled: true, actorUserId: 1 });
    const run = getOrCreateActiveDemoDatasetRun({ actorUserId: 1 });
    const db = openDatabase();
    try {
      const source = seedMeterEvidence(db, run);
      const alternateActorUserId = Number(db.prepare(`INSERT INTO sys_users
        (username, display_name, password_hash, status, is_builtin, created_at, updated_at)
        VALUES ('meter-action-alternate', '抄表动作备用操作者', 'test-password-hash', 'active', 0, ?, ?)`).run(
        FIXED_NOW,
        FIXED_NOW
      ).lastInsertRowid);
      const actorBindingBlocked = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-actor-binding-mismatch' },
        actorUserId: alternateActorUserId,
        db
      });
      assert.strictEqual(actorBindingBlocked.status, 'blocked');
      assert.strictEqual(actorBindingBlocked.blocker.code, 'DEMO_METER_BINDING_STALE');
      assertSafe(actorBindingBlocked);
      assertBlockedMeterExecution(db, actorBindingBlocked, 'meter-actor-binding-mismatch', alternateActorUserId);

      const forbiddenPreviewFields = [
        ['readingIds', [source.readingId]],
        ['candidateReadingIds', [source.readingId]],
        ['batchId', source.batchId],
        ['importBatchId', source.batchId],
        ['month', '2026-08'],
        ['months', ['2026-08']],
        ['monthStart', '2026-08'],
        ['monthEnd', '2026-08'],
        ['meterId', source.meterDeviceId],
        ['meterDeviceId', source.meterDeviceId],
        ['organizationUnitId', source.organizationUnitId],
        ['startUtc', '2026-08-01T00:00:00Z'],
        ['endUtc', '2026-09-01T00:00:00Z'],
        ['timeWindow', { start: '2026-08-01', end: '2026-08-31' }],
        ['outputIds', ['1']],
        ['filters', { month: '2026-08' }]
      ];
      forbiddenPreviewFields.forEach(([field, value], index) => {
        const strict = (() => {
          try {
            return previewDemoPostAction({
              runId: run.runId,
              actionKey: 'meter-readings-to-energy-records',
              body: { clientRequestId: `meter-strict-${index + 1}`, [field]: value },
              actorUserId: 1,
              db
            });
          } catch (error) {
            return error;
          }
        })();
        assert.strictEqual(strict.code, 'BAD_REQUEST');
        assert.strictEqual(strict.details.code, 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN');
        assert.deepStrictEqual(strict.details.fields, [field]);
      });

      const preview = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-connected-1' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(preview.status, 'previewed');
      assert.deepStrictEqual(Object.keys(preview.input).sort(), ['months', 'readingCount', 'source'].sort());
      assert.strictEqual(preview.input.readingCount, 1);
      assert.deepStrictEqual(preview.input.months, ['2026-08']);
      assert.strictEqual(preview.outputCount, 0);
      assertSafe(preview);

      const staleDb = openDatabase();
      try {
        staleDb.prepare('UPDATE meter_reading_records SET current_value = current_value + 1, usage_value = usage_value + 1, normalized_usage_value = normalized_usage_value + 1, updated_at = ? WHERE id = ?')
          .run('2026-08-28T00:00:01.000Z', source.readingId);
      } finally {
        staleDb.close();
      }
      assert.throws(
        () => executeDemoPostAction({
          actionRunId: preview.actionRunId,
          body: {
            clientRequestId: 'meter-connected-1',
            previewDigest: preview.previewDigest,
            confirmationText: '确认执行抄表转能耗记录'
          },
          actorUserId: 1,
          db
        }),
        (error) => error.code === 'DEMO_POST_ACTION_INPUT_STALE' && error.statusCode === 409
      );
      assert.throws(
        () => executeMeterAction(db, preview, 'meter-connected-1', 2),
        (error) => error.code === 'NOT_FOUND'
          && error.details.code === 'DEMO_POST_ACTION_RUN_NOT_FOUND'
          && error.statusCode === 404
      );
      db.prepare('UPDATE meter_reading_records SET current_value = 125, usage_value = 25, normalized_usage_value = 25, updated_at = ? WHERE id = ?')
        .run(FIXED_NOW, source.readingId);

      const unownedReadingId = Number(db.prepare(`INSERT INTO meter_reading_records
        (source_batch_id, meter_device_id, organization_unit_id, energy_type_id, reading_date,
         normalized_month, previous_value, current_value, multiplier, usage_value, original_unit,
         normalized_unit, normalized_usage_value, data_source, record_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, '2026-08-16', '2026-08', 125, 130, 1, 5, 'kWh', 'kWh', 5,
          'upload', 'active', ?, ?)`).run(
        source.batchId,
        source.meterDeviceId,
        source.organizationUnitId,
        source.energyTypeId,
        FIXED_NOW,
        FIXED_NOW
      ).lastInsertRowid);
      const setBlocked = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-set-mismatch' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(setBlocked.status, 'blocked');
      assert.strictEqual(setBlocked.blocker.code, 'DEMO_METER_OWNERSHIP_SET_INVALID');
      assertSafe(setBlocked);
      assertBlockedMeterExecution(db, setBlocked, 'meter-set-mismatch');
      db.prepare('DELETE FROM meter_reading_records WHERE id = ?').run(unownedReadingId);

      const extraOwned = addOwnedMeterReading(db, run, source, 'RELATION', '2026-08');
      const sourceRegistryId = db.prepare("SELECT registry_id AS registryId FROM demo_data_registry WHERE run_id = ? AND entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
        .get(run.runId, String(source.readingId)).registryId;
      const extraRegistryId = db.prepare("SELECT registry_id AS registryId FROM demo_data_registry WHERE run_id = ? AND entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
        .get(run.runId, String(extraOwned.readingId)).registryId;
      db.prepare(`INSERT INTO demo_data_relations (run_id, from_registry_id, to_registry_id, relation_type)
        VALUES (?, ?, ?, 'generated_from')`).run(run.runId, sourceRegistryId, extraRegistryId);
      const relationBlocked = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-relation-mismatch' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(relationBlocked.status, 'blocked');
      assert.strictEqual(relationBlocked.blocker.code, 'DEMO_METER_RELATION_CLOSURE_INVALID');
      assertSafe(relationBlocked);
      assertBlockedMeterExecution(db, relationBlocked, 'meter-relation-mismatch');
      db.prepare('DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ? AND to_registry_id = ? AND relation_type = \'generated_from\'')
        .run(run.runId, sourceRegistryId, extraRegistryId);
      db.prepare("DELETE FROM demo_data_registry WHERE run_id = ? AND entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
        .run(run.runId, String(extraOwned.readingId));
      db.prepare('DELETE FROM meter_reading_records WHERE id = ?').run(extraOwned.readingId);
      db.prepare('UPDATE import_batches SET total_rows = total_rows - 1, success_count = success_count - 1, updated_at = ? WHERE id = ?')
        .run(FIXED_NOW, source.batchId);

      const ownershipBefore = db.prepare("SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
        .get(String(source.readingId)).snapshotDigest;
      const backupFailedPreview = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-backup-failure' },
        actorUserId: 1,
        db
      });
      fs.rmSync(process.env.BACKUPS_DIR, { recursive: true, force: true });
      fs.writeFileSync(process.env.BACKUPS_DIR, 'backup directory failure injection', 'utf8');
      const backupFailed = executeMeterAction(db, backupFailedPreview, 'meter-backup-failure');
      assert.strictEqual(backupFailed.failureReason, 'METER_READING_GENERATION_BACKUP_PREPARE_FAILED');
      assertMeterActionRolledBack(db, backupFailed, source.readingId, ownershipBefore);
      fs.rmSync(process.env.BACKUPS_DIR, { force: true });
      fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });

      const outputFailedPreview = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-output-failure' },
        actorUserId: 1,
        db
      });
      db.exec(`CREATE TRIGGER test_fail_meter_post_action_output
        BEFORE INSERT ON demo_post_action_outputs
        BEGIN SELECT RAISE(ABORT, 'test post action output failure'); END`);
      const outputFailed = executeMeterAction(db, outputFailedPreview, 'meter-output-failure');
      assertMeterActionRolledBack(db, outputFailed, source.readingId, ownershipBefore);
      db.exec('DROP TRIGGER test_fail_meter_post_action_output');

      const preview2 = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-ownership-failure' },
        actorUserId: 1,
        db
      });
      db.exec(`CREATE TRIGGER test_fail_meter_derived_ownership
        BEFORE INSERT ON demo_data_registry
        FOR EACH ROW WHEN NEW.ownership_kind = 'derived'
        BEGIN SELECT RAISE(ABORT, 'test derived ownership failure'); END`);
      const ownershipFailed = executeMeterAction(db, preview2, 'meter-ownership-failure');
      assertMeterActionRolledBack(db, ownershipFailed, source.readingId, ownershipBefore);
      db.exec('DROP TRIGGER test_fail_meter_derived_ownership');

      const preview3 = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-connected-2' },
        actorUserId: 1,
        db
      });
      const executed = executeMeterAction(db, preview3, 'meter-connected-2');
      assert.strictEqual(executed.status, 'succeeded');
      assert.strictEqual(executed.outputCount, 1);
      assert.strictEqual(executed.outputs.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(executed.outputs[0], 'outputEntityId'), false);
      assert.strictEqual(executed.result.generated, 1);
      assert.strictEqual(executed.result.summary.wouldGenerate, 1);
      assertSafe(executed);
      const replay = executeDemoPostAction({
        actionRunId: preview3.actionRunId,
        body: {
          clientRequestId: 'meter-connected-2',
          previewDigest: preview3.previewDigest,
          confirmationText: '确认执行抄表转能耗记录'
        },
        actorUserId: 1,
        db
      });
      assert.deepStrictEqual(replay.result, executed.result);
      assert.deepStrictEqual(replay.outputs, executed.outputs);
      const status = getDemoPostActionStatus({ actionRunId: preview3.actionRunId, actorUserId: 1, db });
      assert.strictEqual(status.status, 'succeeded');
      const reading = db.prepare('SELECT generated_energy_record_id AS generatedId FROM meter_reading_records WHERE id = ?').get(source.readingId);
      assert(Number.isSafeInteger(Number(reading.generatedId)) && Number(reading.generatedId) > 0);
      const output = db.prepare('SELECT COUNT(*) AS count FROM demo_post_action_outputs WHERE action_run_id = ?').get(preview3.actionRunId);
      assert.strictEqual(Number(output.count), 1);
      const derived = db.prepare("SELECT COUNT(*) AS count FROM demo_data_registry WHERE run_id = ? AND entity_type = 'energy_record' AND ownership_kind = 'derived' AND cleaned_at IS NULL").get(run.runId);
      assert.strictEqual(Number(derived.count), 1);
      const relation = db.prepare("SELECT COUNT(*) AS count FROM demo_data_relations WHERE run_id = ? AND relation_type = 'generated_from'").get(run.runId);
      assert.strictEqual(Number(relation.count), 1);
      const changedSource = db.prepare("SELECT snapshot_digest AS snapshotDigest FROM demo_data_registry WHERE entity_type = 'meter_reading' AND entity_pk = ? AND cleaned_at IS NULL")
        .get(String(source.readingId)).snapshotDigest;
      assert.notStrictEqual(changedSource, ownershipBefore);
      const energyCount = db.prepare('SELECT COUNT(*) AS count FROM energy_records WHERE meter_device_id = ? AND normalized_month = \'2026-08\'').get(source.meterDeviceId);
      assert.strictEqual(Number(energyCount.count), 1);

      const closurePreview = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-derived-closure-valid' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(closurePreview.status, 'previewed');
      const closureExecuted = executeMeterAction(db, closurePreview, 'meter-derived-closure-valid');
      assert.strictEqual(closureExecuted.status, 'succeeded');
      assert.strictEqual(closureExecuted.outputCount, 0);
      assert.strictEqual(closureExecuted.result.generated, 0);
      assert.strictEqual(closureExecuted.result.skipped, 1);
      assert.strictEqual(closureExecuted.result.summary.alreadyGenerated, 1);
      assertSafe(closureExecuted);

      const derivedRegistry = db.prepare(`SELECT registry_id AS registryId, snapshot_digest AS snapshotDigest
        FROM demo_data_registry WHERE run_id = ? AND entity_type = 'energy_record'
          AND ownership_kind = 'derived' AND cleaned_at IS NULL`).get(run.runId);
      const importedRegistry = db.prepare(`SELECT registry_id AS registryId FROM demo_data_registry
        WHERE run_id = ? AND entity_type = 'meter_reading' AND entity_pk = ?
          AND ownership_kind = 'imported' AND cleaned_at IS NULL`).get(run.runId, String(source.readingId));
      db.prepare('UPDATE demo_data_registry SET snapshot_digest = ? WHERE registry_id = ?')
        .run('0'.repeat(64), derivedRegistry.registryId);
      const derivedSnapshotBlocked = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-derived-snapshot-mismatch' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(derivedSnapshotBlocked.status, 'blocked');
      assert.strictEqual(derivedSnapshotBlocked.blocker.code, 'DEMO_METER_DERIVED_SNAPSHOT_DIGEST_MISMATCH');
      assertSafe(derivedSnapshotBlocked);
      assertBlockedMeterExecution(db, derivedSnapshotBlocked, 'meter-derived-snapshot-mismatch');
      db.prepare('UPDATE demo_data_registry SET snapshot_digest = ? WHERE registry_id = ?')
        .run(derivedRegistry.snapshotDigest, derivedRegistry.registryId);

      db.prepare(`INSERT INTO demo_data_relations
        (run_id, from_registry_id, to_registry_id, relation_type)
        VALUES (?, ?, ?, 'uses_config')`).run(
        run.runId,
        derivedRegistry.registryId,
        importedRegistry.registryId
      );
      const derivedRelationBlocked = previewDemoPostAction({
        runId: run.runId,
        actionKey: 'meter-readings-to-energy-records',
        body: { clientRequestId: 'meter-derived-relation-mismatch' },
        actorUserId: 1,
        db
      });
      assert.strictEqual(derivedRelationBlocked.status, 'blocked');
      assert.strictEqual(derivedRelationBlocked.blocker.code, 'DEMO_METER_RELATION_CLOSURE_INVALID');
      assertSafe(derivedRelationBlocked);
      assertBlockedMeterExecution(db, derivedRelationBlocked, 'meter-derived-relation-mismatch');
      db.prepare(`DELETE FROM demo_data_relations WHERE run_id = ? AND from_registry_id = ?
        AND to_registry_id = ? AND relation_type = 'uses_config'`).run(
        run.runId,
        derivedRegistry.registryId,
        importedRegistry.registryId
      );
      console.log('demoPostActionMeterReadings.test.js passed');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
