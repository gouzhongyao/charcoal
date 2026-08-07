'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ENERGY_ANALYSIS_IMPORT_AUDIT_DIGEST_PREFIX,
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY,
  ENERGY_ANALYSIS_IMPORT_SIGNATURE_PREFIX,
  ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION,
  ENERGY_ANALYSIS_IMPORT_TEMPLATES,
  authorizeEnergyAnalysisImportExecute,
  buildEnergyAnalysisImportPreviewAuditDigest,
  buildEnergyAnalysisImportPreviewSignature,
  buildEnergyAnalysisImportSignaturePayload,
  buildImportSummary,
  calculateSafeUploadFileSha256,
  createImportIssue,
  normalizeCandidateRows,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  resolveSafeUploadFile,
  stableSerialize,
  validateCandidateWitness,
  validateEnergyFlowBundleMetadata,
  verifyEnergyAnalysisImportPreviewAuditDigest,
  verifyEnergyAnalysisImportPreviewSignature
} = require('../services/energyAnalysisImportCore');

// 测试固定使用的 HMAC 密钥。
const TEST_SECRET = 'energy-analysis-import-test-secret-32-bytes';

// 测试固定使用的原子读取文件内容。
const TEST_FILE_BUFFER = Buffer.from('energy-analysis-import-test-file', 'utf8');

// 测试固定使用的文件摘要。
const TEST_FILE_SHA256 = crypto.createHash('sha256').update(TEST_FILE_BUFFER).digest('hex');

// 八模板关键安全契约独立硬编码，避免测试复述生产常量。
const EXPECTED_TEMPLATES = [
  ['energy-timeseries', 'energy-timeseries-import', 'energy_timeseries', ['energy_timeseries'], '确认导入时序能耗记录', false],
  ['shift-schedules', 'shift-schedule-import', 'shift_schedule', ['shift_schedule'], '确认导入排班记录', false],
  ['device-states', 'device-state-import', 'device_state', ['device_state'], '确认导入设备状态记录', false],
  ['energy-conversion-factors', 'energy-conversion-factor-import', 'energy_conversion_factor', ['energy_conversion_factor'], '确认导入折标系数', false],
  ['energy-benchmark-definitions', 'energy-benchmark-standard-import', 'benchmark_standard', ['energy_benchmark'], '确认导入能效对标标准', false],
  ['energy-benchmark-targets', 'energy-benchmark-target-import', 'benchmark_target', ['energy_benchmark'], '确认导入能效对标目标', false],
  ['energy-flow-nodes', 'energy-flow-node-import', 'energy_flow_node', ['energy_flow_node'], '确认导入能流节点', false],
  ['energy-flow-edges', 'energy-flow-edge-bundle-import', 'energy_flow_edge_record_bundle', ['energy_flow_edge', 'energy_flow_record'], '确认导入能流边及显式边值', true]
];

/**
 * 读取 AppError 中的领域错误码。
 * @param {Error} error 捕获错误。
 * @returns {string|undefined} 领域错误码。
 */
function getDetailCode(error) {
  return error && error.details && error.details.code;
}

/**
 * 断言函数抛出指定领域错误码。
 * @param {Function} callback 待执行函数。
 * @param {string} expectedCode 预期错误码。
 */
function assertThrowsCode(callback, expectedCode) {
  assert.throws(callback, (error) => getDetailCode(error) === expectedCode, `应抛出 ${expectedCode}`);
}

/**
 * 构造可签名的标准候选上下文。
 * @param {object} overrides 覆盖字段。
 * @returns {object} 签名上下文。
 */
function createSignatureInput(overrides = {}) {
  return {
    templateType: 'energy-timeseries',
    fileSha256: TEST_FILE_SHA256,
    candidateRows: [
      { candidateRowId: 'row-10', rowNumber: 10, value: 2, nested: { z: 1, a: true } },
      { candidateRowId: 'row-2', rowNumber: 2, value: 1 }
    ],
    ...overrides
  };
}

/**
 * 构造通过签名和审计摘要绑定的 execute 安全上下文。
 * @param {object[]} candidateRows 服务端重算候选行。
 * @param {object} inputOverrides execute 请求覆盖字段。
 * @param {object} contextOverrides 服务端上下文覆盖字段。
 * @returns {{input:object,serverContext:object}} execute 测试夹具。
 */
function createExecuteFixture(candidateRows, inputOverrides = {}, contextOverrides = {}) {
  const normalizedRows = normalizeCandidateRows(candidateRows);
  const previewAudit = {
    summary: { totalRows: normalizedRows.length, wouldImport: normalizedRows.length, skipped: 0, blocked: 0 },
    candidateRows: normalizedRows
  };
  const previewSignature = buildEnergyAnalysisImportPreviewSignature({
    templateType: 'energy-timeseries',
    fileSha256: TEST_FILE_SHA256,
    candidateRows: normalizedRows
  }, TEST_SECRET);
  const previewAuditDigest = buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, TEST_SECRET);
  const input = {
    templateType: 'energy-timeseries',
    operation: 'energy-timeseries-import',
    recordKind: 'energy_timeseries',
    importTypes: ['energy_timeseries'],
    confirmText: '确认导入时序能耗记录',
    backupReason: 'energy-analysis-import',
    duplicateStrategy: 'skip',
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: TEST_FILE_SHA256,
    previewSignature,
    previewAuditDigest,
    expectedWouldImport: normalizedRows.length,
    candidateRowIds: normalizedRows.map((row) => row.candidateRowId),
    candidateRows: normalizedRows,
    expectedBatchId: 101,
    batch: {
      id: 101,
      status: 'completed',
      auditPhase: 'preview',
      templateType: 'energy-timeseries',
      operation: 'energy-timeseries-import',
      recordKind: 'energy_timeseries',
      importType: 'energy_timeseries',
      importTypes: ['energy_timeseries'],
      fileSha256: TEST_FILE_SHA256,
      previewSignature,
      previewAuditDigest
    },
    ...inputOverrides
  };
  return {
    input,
    serverContext: {
      secret: TEST_SECRET,
      fileBuffer: TEST_FILE_BUFFER,
      recomputedCandidateRows: normalizedRows,
      previewAudit,
      ...contextOverrides
    }
  };
}

/**
 * 运行八模板映射与冻结性测试。
 */
function testTemplateContracts() {
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_BACKUP_REASON, 'energy-analysis-import');
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_SIGNATURE_VERSION, 'energy-analysis-import-preview:v1');
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_SIGNATURE_PREFIX, 'hmac-sha256:v1');
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_AUDIT_DIGEST_PREFIX, 'hmac-sha256:v1:audit');
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_TEMPLATES.length, 8);
  assert.deepStrictEqual(
    ENERGY_ANALYSIS_IMPORT_TEMPLATES.map((template) => [
      template.id,
      template.operation,
      template.recordKind,
      template.importTypes,
      template.confirmText,
      template.xlsxOnly
    ]),
    EXPECTED_TEMPLATES
  );
  ENERGY_ANALYSIS_IMPORT_TEMPLATES.forEach((template) => {
    assert.strictEqual(template.id, template.templateType);
    assert.strictEqual(template.backupReason, 'energy-analysis-import');
    assert.strictEqual(Object.isFrozen(template), true);
    assert.strictEqual(Object.isFrozen(template.importTypes), true);
    assert.strictEqual(Object.isFrozen(template.targetTables), true);
  });
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_TEMPLATES[4].importTypes[0], 'energy_benchmark');
  assert.strictEqual(ENERGY_ANALYSIS_IMPORT_TEMPLATES[5].importTypes[0], 'energy_benchmark');
  assert.notStrictEqual(ENERGY_ANALYSIS_IMPORT_TEMPLATES[4].operation, ENERGY_ANALYSIS_IMPORT_TEMPLATES[5].operation);
  assert.notStrictEqual(ENERGY_ANALYSIS_IMPORT_TEMPLATES[4].recordKind, ENERGY_ANALYSIS_IMPORT_TEMPLATES[5].recordKind);
}

/**
 * 运行稳定递归序列化测试。
 */
function testStableSerialization() {
  const left = { z: [3, { b: 2, a: 1 }], a: true, date: new Date('2026-08-06T01:02:03.004Z') };
  const right = { date: new Date('2026-08-06T01:02:03.004Z'), a: true, z: [3, { a: 1, b: 2 }] };
  assert.strictEqual(stableSerialize(left), stableSerialize(right));
  assert.strictEqual(stableSerialize({ values: [1, 2] }), '{"values":[1,2]}');
  assert.notStrictEqual(stableSerialize({ values: [1, 2] }), stableSerialize({ values: [2, 1] }));
  assert.strictEqual(stableSerialize({ date: new Date('2026-08-06T01:02:03.004Z') }), '{"date":"2026-08-06T01:02:03.004Z"}');
  assert.strictEqual(stableSerialize(JSON.parse('{"__proto__":{"polluted":true},"safe":1}')), '{"__proto__":{"polluted":true},"safe":1}');
  assert.strictEqual({}.polluted, undefined);
  assertThrowsCode(() => stableSerialize({ value: undefined }), 'STABLE_SERIALIZE_UNSUPPORTED_TYPE');
  assertThrowsCode(() => stableSerialize({ value: () => true }), 'STABLE_SERIALIZE_UNSUPPORTED_TYPE');
  assertThrowsCode(() => stableSerialize({ value: Symbol('x') }), 'STABLE_SERIALIZE_UNSUPPORTED_TYPE');
  assertThrowsCode(() => stableSerialize({ value: Number.NaN }), 'STABLE_SERIALIZE_NON_FINITE_NUMBER');
  assertThrowsCode(() => stableSerialize({ value: Number.POSITIVE_INFINITY }), 'STABLE_SERIALIZE_NON_FINITE_NUMBER');
  assertThrowsCode(() => stableSerialize({ value: new Date('invalid') }), 'STABLE_SERIALIZE_INVALID_DATE');
  const circular = {};
  circular.self = circular;
  assertThrowsCode(() => stableSerialize(circular), 'STABLE_SERIALIZE_CIRCULAR_REFERENCE');
  const symbolKeyObject = { safe: true };
  symbolKeyObject[Symbol('hidden')] = 'secret';
  assertThrowsCode(() => stableSerialize(symbolKeyObject), 'STABLE_SERIALIZE_SYMBOL_KEY');
}

/**
 * 运行 HMAC 签名、域隔离、篡改和 timing-safe 测试。
 */
function testSigningAndDomainSeparation() {
  const input = createSignatureInput();
  const payload = buildEnergyAnalysisImportSignaturePayload(input);
  assert.deepStrictEqual(Object.keys(payload), [
    'version',
    'operation',
    'templateType',
    'recordKind',
    'importTypes',
    'fileSha256',
    'duplicateStrategy',
    'targetTables',
    'confirmText',
    'requireBackup',
    'backupReason',
    'candidateRowIds',
    'candidateRows'
  ]);
  assert.strictEqual(payload.requireBackup, true);
  assert.strictEqual(payload.backupReason, 'energy-analysis-import');
  assert.deepStrictEqual(payload.candidateRowIds, ['row-10', 'row-2']);

  const signature = buildEnergyAnalysisImportPreviewSignature(input, TEST_SECRET);
  const audit = { summary: { totalRows: 2, wouldImport: 2 }, items: input.candidateRows };
  const digest = buildEnergyAnalysisImportPreviewAuditDigest(audit, TEST_SECRET);
  assert.match(signature, /^hmac-sha256:v1:[a-f0-9]{64}$/);
  assert.match(digest, /^hmac-sha256:v1:audit:[a-f0-9]{64}$/);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewSignature(input, signature, TEST_SECRET), true);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewAuditDigest(audit, digest, TEST_SECRET), true);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewSignature(input, digest, TEST_SECRET), false);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewAuditDigest(audit, signature, TEST_SECRET), false);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewSignature(createSignatureInput({ fileSha256: 'b'.repeat(64) }), signature, TEST_SECRET), false);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewSignature(createSignatureInput({ candidateRows: [{ candidateRowId: 'row-2', rowNumber: 2, value: 999 }] }), signature, TEST_SECRET), false);
  assert.strictEqual(verifyEnergyAnalysisImportPreviewAuditDigest({ ...audit, summary: { totalRows: 3 } }, digest, TEST_SECRET), false);

  const originalTimingSafeEqual = crypto.timingSafeEqual;
  let timingSafeEqualCalls = 0;
  crypto.timingSafeEqual = (...args) => {
    timingSafeEqualCalls += 1;
    return originalTimingSafeEqual(...args);
  };
  try {
    assert.strictEqual(verifyEnergyAnalysisImportPreviewSignature(input, signature, TEST_SECRET), true);
    assert.strictEqual(timingSafeEqualCalls, 1);
  } finally {
    crypto.timingSafeEqual = originalTimingSafeEqual;
  }
}

/**
 * 运行安装级密钥优先级、随机持久化与秘密不泄露测试。
 */
function testSecretResolutionAndNonDisclosure() {
  const noMeta = () => null;
  assert.strictEqual(resolveEnergyAnalysisImportHmacSecret({
    env: {
      ENERGY_ANALYSIS_IMPORT_HMAC_SECRET: 'specific-secret',
      CHARCOAL_HMAC_SECRET: 'charcoal-secret',
      APP_SECRET: 'app-secret'
    },
    readAppMeta: noMeta
  }), 'specific-secret');
  assert.strictEqual(resolveEnergyAnalysisImportHmacSecret({
    env: { CHARCOAL_HMAC_SECRET: 'charcoal-secret', APP_SECRET: 'app-secret' },
    readAppMeta: noMeta
  }), 'charcoal-secret');
  assert.strictEqual(resolveEnergyAnalysisImportHmacSecret({
    env: { APP_SECRET: 'app-secret' },
    readAppMeta: noMeta
  }), 'app-secret');
  assert.strictEqual(resolveEnergyAnalysisImportHmacSecret({
    env: {},
    readAppMeta: (key) => ({ key, value: 'app-meta-secret' })
  }), 'app-meta-secret');

  let persistedKey = null;
  let persistedGeneratedSecret = null;
  const generatedResult = resolveEnergyAnalysisImportHmacSecret({
    env: {},
    readAppMeta: () => null,
    randomBytes: (size) => {
      assert.strictEqual(size, 32);
      return Buffer.alloc(32, 0x5a);
    },
    persistAppMeta: (key, value) => {
      persistedKey = key;
      persistedGeneratedSecret = value;
      return 'concurrent-persisted-winner';
    }
  });
  assert.strictEqual(persistedKey, 'energy_analysis_import_hmac_secret');
  assert.strictEqual(persistedKey, ENERGY_ANALYSIS_IMPORT_HMAC_SECRET_META_KEY);
  assert.strictEqual(persistedGeneratedSecret, '5a'.repeat(32));
  assert.strictEqual(generatedResult, 'concurrent-persisted-winner');
  assertThrowsCode(
    () => resolveEnergyAnalysisImportHmacSecret({ env: {}, readAppMeta: () => null }),
    'ENERGY_ANALYSIS_HMAC_SECRET_PERSISTENCE_REQUIRED'
  );
  assertThrowsCode(
    () => resolveEnergyAnalysisImportHmacSecret({
      env: {},
      readAppMeta: () => null,
      persistAppMeta: () => undefined,
      randomBytes: () => Buffer.alloc(32, 0x33)
    }),
    'ENERGY_ANALYSIS_IMPORT_SECRET_PERSIST_FAILED'
  );
  let readCount = 0;
  assert.strictEqual(resolveEnergyAnalysisImportHmacSecret({
    env: {},
    readAppMeta: () => {
      readCount += 1;
      return readCount === 1 ? null : 'reread-concurrent-winner';
    },
    persistAppMeta: () => undefined,
    randomBytes: () => Buffer.alloc(32, 0x44)
  }), 'reread-concurrent-winner');

  const payload = buildEnergyAnalysisImportSignaturePayload(createSignatureInput());
  const signature = buildEnergyAnalysisImportPreviewSignature(createSignatureInput(), TEST_SECRET);
  const digest = buildEnergyAnalysisImportPreviewAuditDigest({ summary: { totalRows: 2 } }, TEST_SECRET);
  const publicObjects = JSON.stringify({ payload, signature, digest, summary: buildImportSummary([]) });
  assert.strictEqual(publicObjects.includes(TEST_SECRET), false);
  assert.strictEqual(publicObjects.includes('HMAC_SECRET'), false);
}

/**
 * 运行安全上传路径、符号链接、文件大小和 SHA 测试。
 */
function testSafeUploadPathAndSha() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-analysis-import-core-'));
  const uploadRoot = path.join(tempRoot, 'uploads');
  const nestedDir = path.join(uploadRoot, 'group-a');
  const outsideDir = path.join(tempRoot, 'outside');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'source.xlsx'), 'abc');
  fs.writeFileSync(path.join(outsideDir, 'outside.xlsx'), 'outside');
  try {
    const resolved = resolveSafeUploadFile(uploadRoot, path.join('group-a', 'source.xlsx'), { expectedSizeBytes: 3, maxSizeBytes: 3 });
    assert.strictEqual(resolved.sizeBytes, 3);
    assert.strictEqual(path.basename(resolved.filePath), 'source.xlsx');
    assert.strictEqual(resolved.buffer.toString('utf8'), 'abc');
    const digest = calculateSafeUploadFileSha256(uploadRoot, path.join('group-a', 'source.xlsx'), { expectedSizeBytes: 3 });
    assert.strictEqual(digest.fileSha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(digest.buffer.toString('utf8'), 'abc');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, path.join(nestedDir, 'source.xlsx')), 'ENERGY_ANALYSIS_UPLOAD_ABSOLUTE_PATH_REJECTED');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, '../outside/outside.xlsx'), 'ENERGY_ANALYSIS_UPLOAD_PARENT_PATH_REJECTED');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, path.join('group-a', 'missing.xlsx')), 'ENERGY_ANALYSIS_UPLOAD_FILE_UNAVAILABLE');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, 'group-a'), 'ENERGY_ANALYSIS_UPLOAD_NOT_REGULAR_FILE');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, path.join('group-a', 'source.xlsx'), { expectedSizeBytes: 4 }), 'ENERGY_ANALYSIS_UPLOAD_FILE_SIZE_MISMATCH');

    const sourcePath = path.join(nestedDir, 'source.xlsx');
    const openedPath = path.join(nestedDir, 'opened-original.xlsx');
    const replacementPath = path.join(nestedDir, 'replacement.xlsx');
    fs.writeFileSync(replacementPath, 'xyz');
    const atomicRead = readSafeUploadFile(uploadRoot, path.join('group-a', 'source.xlsx'), {
      expectedSizeBytes: 3,
      afterFileOpen: () => {
        fs.renameSync(sourcePath, openedPath);
        fs.renameSync(replacementPath, sourcePath);
      }
    });
    assert.strictEqual(atomicRead.buffer.toString('utf8'), 'abc', '返回内容必须来自同一已打开文件');
    assert.strictEqual(atomicRead.sizeBytes, 3);
    assert.strictEqual(atomicRead.fileSha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), 'xyz', '替换后的路径内容不得混入已打开文件');

    const linkPath = path.join(uploadRoot, 'outside-link');
    fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    assertThrowsCode(() => resolveSafeUploadFile(uploadRoot, path.join('outside-link', 'outside.xlsx')), 'ENERGY_ANALYSIS_UPLOAD_SYMLINK_REJECTED');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 运行候选规范化、唯一性和完整见证测试。
 */
function testCandidateWitness() {
  const recomputedRows = [
    { candidateRowId: 'row-b', rowNumber: 3, value: 20, detail: { z: 2, a: 1 } },
    { candidateRowId: 'row-a', rowNumber: 2, value: 10 }
  ];
  const normalized = normalizeCandidateRows(recomputedRows);
  assert.deepStrictEqual(normalized.map((row) => row.candidateRowId), ['row-a', 'row-b']);
  assertThrowsCode(
    () => normalizeCandidateRows([{ candidateRowId: 'same' }, { candidateRowId: 'same' }]),
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_ID_DUPLICATE'
  );

  const valid = validateCandidateWitness(recomputedRows, {
    expectedWouldImport: 2,
    candidateRowIds: ['row-b', 'row-a'],
    candidateRows: [
      { value: 10, rowNumber: 2, candidateRowId: 'row-a' },
      { detail: { a: 1, z: 2 }, value: 20, candidateRowId: 'row-b', rowNumber: 3 }
    ]
  });
  assert.strictEqual(valid.valid, true);
  assert.deepStrictEqual(valid.errors, []);

  const invalid = validateCandidateWitness(recomputedRows, {
    expectedWouldImport: 1,
    candidateRowIds: ['row-a'],
    candidateRows: [{ candidateRowId: 'row-a', rowNumber: 2, value: 999 }]
  });
  assert.strictEqual(invalid.valid, false);
  assert.deepStrictEqual(invalid.errors.map((error) => error.code), [
    'ENERGY_ANALYSIS_IMPORT_EXPECTED_WOULD_IMPORT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROW_IDS_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'
  ]);
}

/**
 * 运行 execute 唯一总门槛、密码学验签和单批次强绑定测试。
 */
function testExecuteAndBatchValidation() {
  const candidateRows = [{ candidateRowId: 'row-1', rowNumber: 2, value: 1 }];
  const validFixture = createExecuteFixture(candidateRows);
  const valid = authorizeEnergyAnalysisImportExecute(validFixture.input, validFixture.serverContext);
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.signatureVerified, true);
  assert.strictEqual(valid.auditDigestVerified, true);
  assert.strictEqual(valid.expectedWouldImport, 1);

  const oldPartialCall = authorizeEnergyAnalysisImportExecute(validFixture.input, candidateRows);
  assert.strictEqual(oldPartialCall.valid, false, '仅传候选行的局部校验不得被误认为 execute 已授权');
  assert.deepStrictEqual(oldPartialCall.errors.map((error) => error.code), [
    'ENERGY_ANALYSIS_IMPORT_SERVER_CONTEXT_REQUIRED'
  ]);

  const missingSecurityFixture = createExecuteFixture(candidateRows, {
    fileSha256: '',
    previewSignature: '',
    previewAuditDigest: ''
  }, {
    fileBuffer: null
  });
  const missingSecurity = authorizeEnergyAnalysisImportExecute(missingSecurityFixture.input, missingSecurityFixture.serverContext);
  assert.strictEqual(missingSecurity.valid, false);
  assert(missingSecurity.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_FILE_BUFFER_REQUIRED'));
  assert(missingSecurity.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_FILE_SHA256_INVALID'));
  assert(missingSecurity.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_REQUIRED'));
  assert(missingSecurity.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_PREVIEW_AUDIT_DIGEST_REQUIRED'));

  const emptyFixture = createExecuteFixture([]);
  const empty = authorizeEnergyAnalysisImportExecute(emptyFixture.input, emptyFixture.serverContext);
  assert.strictEqual(empty.valid, false);
  assert(empty.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_EMPTY_CANDIDATES_REJECTED'));

  const tamperedFileFixture = createExecuteFixture(candidateRows, { fileSha256: 'b'.repeat(64) });
  const tamperedFile = authorizeEnergyAnalysisImportExecute(tamperedFileFixture.input, tamperedFileFixture.serverContext);
  assert.strictEqual(tamperedFile.valid, false);
  assert(tamperedFile.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_CURRENT_FILE_SHA256_MISMATCH'));

  const tamperedCandidatesFixture = createExecuteFixture(candidateRows, {}, {
    recomputedCandidateRows: [{ candidateRowId: 'row-1', rowNumber: 2, value: 999 }]
  });
  const tamperedCandidates = authorizeEnergyAnalysisImportExecute(tamperedCandidatesFixture.input, tamperedCandidatesFixture.serverContext);
  assert.strictEqual(tamperedCandidates.valid, false);
  assert(tamperedCandidates.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_CANDIDATE_ROWS_MISMATCH'));
  assert(tamperedCandidates.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_PREVIEW_SIGNATURE_INVALID'));

  const invalidControlFixture = createExecuteFixture(candidateRows, {
    confirmText: '我确认',
    requireBackup: false,
    acknowledgeSkippedRisks: false,
    operation: 'wrong-operation',
    recordKind: 'wrong-kind',
    importTypes: ['energy_benchmark']
  });
  const invalidControl = authorizeEnergyAnalysisImportExecute(invalidControlFixture.input, invalidControlFixture.serverContext);
  assert.strictEqual(invalidControl.valid, false);
  [
    'ENERGY_ANALYSIS_IMPORT_CONFIRM_TEXT_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BACKUP_REQUIRED',
    'ENERGY_ANALYSIS_IMPORT_SKIPPED_RISKS_ACK_REQUIRED',
    'ENERGY_ANALYSIS_IMPORT_OPERATION_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_RECORD_KIND_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_IMPORT_TYPES_MISMATCH'
  ].forEach((code) => assert(invalidControl.errors.some((error) => error.code === code), `缺少 ${code}`));

  const invalidBatchFixture = createExecuteFixture(candidateRows);
  invalidBatchFixture.input.expectedBatchId = 202;
  invalidBatchFixture.input.batch = {
    ...invalidBatchFixture.input.batch,
    id: 999,
    status: 'processing',
    auditPhase: 'execute',
    templateType: 'energy-benchmark-targets',
    operation: 'wrong-operation',
    recordKind: 'wrong-kind',
    importType: 'energy_benchmark',
    importTypes: ['energy_benchmark'],
    fileSha256: 'c'.repeat(64),
    previewSignature: 'x',
    previewAuditDigest: 'x'
  };
  const invalidBatch = authorizeEnergyAnalysisImportExecute(invalidBatchFixture.input, invalidBatchFixture.serverContext);
  assert.strictEqual(invalidBatch.valid, false);
  [
    'ENERGY_ANALYSIS_IMPORT_BATCH_ID_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID',
    'ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_TEMPLATE_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_OPERATION_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_RECORD_KIND_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_IMPORT_TYPES_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_IMPORT_TYPE_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_FILE_SHA256_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_SIGNATURE_MISMATCH',
    'ENERGY_ANALYSIS_IMPORT_BATCH_PREVIEW_AUDIT_DIGEST_MISMATCH'
  ].forEach((code) => assert(invalidBatch.errors.some((error) => error.code === code), `缺少 ${code}`));

  const missingBatchIdFixture = createExecuteFixture(candidateRows, { expectedBatchId: undefined });
  const missingBatchId = authorizeEnergyAnalysisImportExecute(missingBatchIdFixture.input, missingBatchIdFixture.serverContext);
  assert(missingBatchId.errors.some((error) => error.code === 'ENERGY_ANALYSIS_IMPORT_EXPECTED_BATCH_ID_INVALID'));
}

/**
 * 运行统一 issue 与 summary 严重级别测试。
 */
function testIssueAndSummary() {
  const warning = createImportIssue({
    rowNumber: 2,
    fieldName: 'duplicateKey',
    rawValue: { month: '2026-07', code: 'A' },
    code: 'DUPLICATE_SKIPPED',
    message: '重复记录按 skip 策略跳过。',
    severity: 'warning'
  });
  const error = createImportIssue({
    rowNumber: 3,
    fieldName: 'value',
    rawValue: 'bad',
    code: 'INVALID_VALUE',
    message: '数值不合法。',
    severity: 'error'
  });
  assert.strictEqual(warning.severity, 'warning');
  assert.strictEqual(error.severity, 'error');
  const summary = buildImportSummary([
    { status: 'wouldImport', issues: [] },
    { status: 'skipped', issues: [warning], reasons: [warning] },
    { status: 'blocked', issues: [], reasons: [error] }
  ]);
  assert.deepStrictEqual(summary, {
    totalRows: 3,
    wouldImport: 1,
    skipped: 1,
    blocked: 1,
    warnings: 1,
    errors: 1
  });
  assert.strictEqual(summary.errors, 1, 'warning 不得计入 errors');
  assertThrowsCode(() => buildImportSummary([
    { status: 'wouldImport', issues: [error] }
  ]), 'ENERGY_ANALYSIS_IMPORT_WOULD_IMPORT_HAS_ERROR');
  assertThrowsCode(() => buildImportSummary([
    { status: 'blocked', issues: [warning] }
  ]), 'ENERGY_ANALYSIS_IMPORT_BLOCKED_ERROR_REQUIRED');
  assertThrowsCode(() => buildImportSummary([
    { status: 'skipped', issues: [{ ...warning, severity: 'notice' }] }
  ]), 'ENERGY_ANALYSIS_IMPORT_ISSUE_SEVERITY_INVALID');
  assertThrowsCode(() => buildImportSummary([
    { status: 'skipped', issues: {}, reasons: [] }
  ]), 'ENERGY_ANALYSIS_IMPORT_ITEM_ISSUES_INVALID');
}

/**
 * 运行能流边与显式边值双批次 bundle 强绑定测试。
 */
function testEnergyFlowBundleMetadata() {
  const candidateRows = [{ candidateRowId: 'edge-row-1', rowNumber: 2, value: 10 }];
  const previewAudit = { summary: { totalRows: 1, wouldImport: 1 }, candidateRows };
  const signature = buildEnergyAnalysisImportPreviewSignature({
    templateType: 'energy-flow-edges',
    fileSha256: TEST_FILE_SHA256,
    candidateRows
  }, TEST_SECRET);
  const auditDigest = buildEnergyAnalysisImportPreviewAuditDigest(previewAudit, TEST_SECRET);
  const expected = {
    fileSha256: TEST_FILE_SHA256,
    previewSignature: signature,
    previewAuditDigest: auditDigest
  };
  const validBundle = {
    edgeBatchId: 101,
    recordBatchId: 102,
    uploadGroupId: 'upload-group-1',
    edgeBatch: {
      id: 101,
      status: 'completed',
      auditPhase: 'preview',
      importType: 'energy_flow_edge',
      uploadGroupId: 'upload-group-1',
      fileSha256: TEST_FILE_SHA256,
      previewSignature: signature,
      previewAuditDigest: auditDigest
    },
    recordBatch: {
      id: 102,
      status: 'completed_with_errors',
      auditPhase: 'preview',
      importType: 'energy_flow_record',
      uploadGroupId: 'upload-group-1',
      fileSha256: TEST_FILE_SHA256,
      previewSignature: signature,
      previewAuditDigest: auditDigest
    }
  };
  const valid = validateEnergyFlowBundleMetadata(validBundle, expected);
  assert.strictEqual(valid.metadataValid, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(valid, 'valid'), false, '局部 bundle helper 不得返回总门槛 valid');
  assert.strictEqual(valid.fileSha256, TEST_FILE_SHA256);

  const executeInput = {
    templateType: 'energy-flow-edges',
    operation: 'energy-flow-edge-bundle-import',
    recordKind: 'energy_flow_edge_record_bundle',
    importTypes: ['energy_flow_edge', 'energy_flow_record'],
    confirmText: '确认导入能流边及显式边值',
    backupReason: 'energy-analysis-import',
    duplicateStrategy: 'skip',
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    fileSha256: TEST_FILE_SHA256,
    previewSignature: signature,
    previewAuditDigest: auditDigest,
    expectedWouldImport: 1,
    candidateRowIds: ['edge-row-1'],
    candidateRows,
    bundle: validBundle
  };
  const authorized = authorizeEnergyAnalysisImportExecute(executeInput, {
    secret: TEST_SECRET,
    fileBuffer: TEST_FILE_BUFFER,
    recomputedCandidateRows: candidateRows,
    previewAudit
  });
  assert.strictEqual(authorized.valid, true);

  const forgedBundle = {
    ...validBundle,
    edgeBatch: { ...validBundle.edgeBatch, previewSignature: 'x', previewAuditDigest: 'x' },
    recordBatch: { ...validBundle.recordBatch, previewSignature: 'x', previewAuditDigest: 'x' }
  };
  const forged = validateEnergyFlowBundleMetadata(forgedBundle, {
    fileSha256: TEST_FILE_SHA256,
    previewSignature: 'x',
    previewAuditDigest: 'x'
  });
  assert.strictEqual(forged.metadataValid, false);
  assert(forged.errors.some((error) => error.code === 'ENERGY_FLOW_BUNDLE_PREVIEW_SIGNATURE_REQUIRED'));
  assert(forged.errors.some((error) => error.code === 'ENERGY_FLOW_BUNDLE_PREVIEW_AUDIT_DIGEST_REQUIRED'));

  const invalid = validateEnergyFlowBundleMetadata({
    ...validBundle,
    recordBatchId: 101,
    edgeBatch: {
      ...validBundle.edgeBatch,
      status: 'processing',
      auditPhase: 'execute'
    },
    recordBatch: {
      ...validBundle.recordBatch,
      id: 999,
      importType: 'energy_flow_edge',
      uploadGroupId: 'other-group',
      fileSha256: 'c'.repeat(64),
      previewSignature: 'hmac-sha256:v1:' + 'd'.repeat(64),
      previewAuditDigest: 'hmac-sha256:v1:audit:' + 'e'.repeat(64)
    }
  }, expected);
  assert.strictEqual(invalid.metadataValid, false);
  [
    'ENERGY_FLOW_BUNDLE_BATCH_IDS_MUST_DIFFER',
    'ENERGY_FLOW_BUNDLE_RECORD_BATCH_ID_MISMATCH',
    'ENERGY_FLOW_BUNDLE_EDGE_BATCH_STATUS_INVALID',
    'ENERGY_FLOW_BUNDLE_EDGE_BATCH_PHASE_MISMATCH',
    'ENERGY_FLOW_BUNDLE_RECORD_IMPORT_TYPE_MISMATCH',
    'ENERGY_FLOW_BUNDLE_UPLOAD_GROUP_MISMATCH',
    'ENERGY_FLOW_BUNDLE_FILE_SHA256_MISMATCH',
    'ENERGY_FLOW_BUNDLE_CURRENT_FILE_SHA256_MISMATCH',
    'ENERGY_FLOW_BUNDLE_PREVIEW_SIGNATURE_MISMATCH',
    'ENERGY_FLOW_BUNDLE_CURRENT_PREVIEW_SIGNATURE_MISMATCH',
    'ENERGY_FLOW_BUNDLE_PREVIEW_AUDIT_DIGEST_MISMATCH',
    'ENERGY_FLOW_BUNDLE_CURRENT_PREVIEW_AUDIT_DIGEST_MISMATCH'
  ].forEach((code) => assert(invalid.errors.some((error) => error.code === code), `缺少 ${code}`));
}

/**
 * 顺序运行能源分析受控导入安全核心测试。
 */
function run() {
  testTemplateContracts();
  testStableSerialization();
  testSigningAndDomainSeparation();
  testSecretResolutionAndNonDisclosure();
  testSafeUploadPathAndSha();
  testCandidateWitness();
  testExecuteAndBatchValidation();
  testIssueAndSummary();
  testEnergyFlowBundleMetadata();
  console.log('energy analysis import core tests passed');
}

run();
