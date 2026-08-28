#!/usr/bin/env node
'use strict';

/**
 * 默认 SQLite 整库格式化工具。
 *
 * 生产入口只接受项目解析后的默认 data 路径；隔离测试必须同时满足
 * NODE_ENV=test 与显式 CHARCOAL_FORMAT_TEST_ISOLATION_ROOT。默认行为和
 * --check 只读，--execute 需要固定确认文本，--verify 只诊断残留状态。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadRuntimeEnvironment } = require('../config/runtimeEnvironment');

const projectRoot = path.resolve(__dirname, '..');
const CONFIRM_TEXT = 'FORMAT data/energy-carbon.sqlite; CLEAR data/uploads; KEEP data/backups';
const MARKER_NAME = '.format-default-database-in-progress.json';
const MARKER_SCHEMA = 'charcoal-format-default-database-marker';
const MARKER_VERSION = 1;
const MARKER_TEMP_PREFIX = `${MARKER_NAME}.tmp-`;
const MARKER_PREFIXES = Object.freeze([
  '.format-candidate-',
  '.format-old-',
  '.format-uploads-',
  '.restore-candidate-',
  '.restore-old-',
  '.restore-uploads-',
  MARKER_TEMP_PREFIX
]);
const RESTORE_MARKER_NAME = '.restore-in-progress.json';
// database.js 必须在运行环境解析后加载；current/stage/algorithm 直接复用其可信导出。
const canonicalDatabase = (() => {
  if (process.env.NODE_ENV !== 'test') loadRuntimeEnvironment();
  return require('../server/src/db/database');
})();
const CANONICAL_STAGE = canonicalDatabase.CANONICAL_SCHEMA_STAGE;
const CANONICAL_VERSION = canonicalDatabase.CANONICAL_SCHEMA_VERSION;
// database.js 当前未导出 predecessor 常量；此处保留唯一同步值，实际物理 profile 仍由 database.js 严格匹配。
const PREDECESSOR_VERSION = '2026-08-27-formal-canonical-v2';
const FINGERPRINT_ALGORITHM = canonicalDatabase.CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM;
const ADMITTED_SCHEMA_VERSIONS = Object.freeze([CANONICAL_VERSION, PREDECESSOR_VERSION]);
const ALLOWED_SEED_TABLES = new Set([
  'app_meta',
  'energy_types',
  'sys_users',
  'sys_roles',
  'sys_user_roles',
  'sys_menus',
  'sys_role_menus',
  'demo_runtime_settings'
]);
const EMPTY_CANDIDATE_TABLES = Object.freeze([
  'import_batches', 'import_errors', 'carbon_factors', 'organization_units', 'meter_devices',
  'meter_reading_records', 'suppliers', 'production_units', 'production_output_records',
  'energy_records', 'generation_records', 'energy_budgets', 'carbon_emissions',
  'carbon_activity_records', 'carbon_calculation_runs', 'carbon_accounting_results',
  'carbon_emission_reports', 'carbon_emission_report_boundaries', 'carbon_emission_report_evidence',
  'carbon_emission_report_items', 'carbon_emission_report_summaries', 'ghg_reports',
  'ghg_report_organization_boundaries', 'ghg_report_operational_boundaries', 'ghg_report_evidence',
  'ghg_report_items', 'ghg_report_summaries', 'prediction_configs', 'prediction_runs',
  'prediction_results', 'energy_timeseries_records', 'shift_definitions', 'shift_schedule_records',
  'device_state_records', 'tou_schemes', 'tou_period_rules', 'energy_conversion_factors',
  'strategy_rules', 'strategy_evaluation_runs', 'strategy_rule_hits', 'benchmark_definitions',
  'benchmark_targets', 'energy_flow_models', 'energy_flow_assets', 'energy_flow_paths',
  'energy_flow_nodes', 'energy_flow_edges', 'energy_flow_records', 'energy_flow_waste_heat_facts',
  'energy_flow_loss_facts', 'energy_flow_loss_evidence', 'energy_balance_boundaries',
  'energy_balance_items', 'energy_balance_calculation_runs', 'energy_balance_snapshots',
  'energy_balance_snapshot_items', 'energy_balance_suggestions', 'sys_sessions', 'sys_login_logs',
  'sys_operation_logs', 'demo_dataset_runs', 'demo_import_contexts', 'demo_legacy_claim_runs',
  'demo_cleanup_runs', 'demo_data_registry', 'demo_data_relations', 'demo_run_import_batches',
  'demo_post_action_runs', 'demo_post_action_outputs'
]);

class FormatError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FormatError';
    this.code = code;
    this.details = details;
  }
}

/** 将路径规范化为可跨平台比较的绝对路径。 */
function normalizePathForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 返回只含项目相对路径的安全诊断值。 */
function relativeProjectPath(targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : '[project-outside]';
}

/** 解析 CLI 参数，不允许 force、skip 或任何未知开关。 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length === 0) return { mode: 'check' };
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' };
  if (args.length === 1 && args[0] === '--verify') return { mode: 'verify' };
  if (args.length === 2 && args[0] === '--execute') {
    return { mode: 'execute', confirmation: args[1] };
  }
  throw new FormatError('INVALID_ARGUMENTS', '参数无效。仅支持默认只读、--check、--verify 或带固定确认文本的 --execute。');
}

/** 创建一次性错误，避免把底层异常、环境变量或密码带入输出。 */
function fail(code, message, details = {}) {
  throw new FormatError(code, message, details);
}

/** 使用 lstat 判断目录项是否存在，避免 dangling symlink 被 existsSync 隐藏。 */
function pathEntryExists(targetPath, fileOperations = fs) {
  try {
    fileOperations.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

/** 同步计算小型控制文件或备份文件摘要，供清单比对使用。 */
function sha256FileSync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 对目录中的普通文件建立大小和摘要基线，拒绝链接和越界对象。 */
function snapshotTree(rootPath) {
  const result = [];
  const walk = (currentPath) => {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      fail('LINK_NOT_ALLOWED', '目标目录或其内容不能是符号链接、联接或重解析点。');
    }
    if (stat.isDirectory()) {
      fs.readdirSync(currentPath, { withFileTypes: true }).forEach((entry) => walk(path.join(currentPath, entry.name)));
      return;
    }
    if (!stat.isFile()) fail('UNSUPPORTED_FILE', '目标目录包含不支持的文件类型。');
    const relative = path.relative(rootPath, currentPath).split(path.sep).join('/');
    result.push({ relative, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256FileSync(currentPath) });
  };
  walk(rootPath);
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

/** 读取真实 Stats 或测试描述对象上的类型标记。 */
function readStatFlag(stat, flagName) {
  if (stat && typeof stat[flagName] === 'function') return Boolean(stat[flagName]());
  return Boolean(stat && stat[flagName] === true);
}

/** 纯校验 lstat 结果，确定性拒绝 symlink、reparse point、硬链接和异常类型。 */
function assertOrdinaryStat(stat, expectedType, label) {
  if (!stat || typeof stat !== 'object') fail('PATH_STAT_INVALID', `${label}的 lstat 结果无效。`);
  const isSymbolicLink = readStatFlag(stat, 'isSymbolicLink');
  const isReparsePoint = readStatFlag(stat, 'isReparsePoint');
  if (isSymbolicLink || isReparsePoint) {
    fail('LINK_NOT_ALLOWED', `${label}不能是符号链接、联接或重解析点。`);
  }
  const isFile = readStatFlag(stat, 'isFile');
  const isDirectory = readStatFlag(stat, 'isDirectory');
  if ((expectedType === 'file' && !isFile) || (expectedType === 'directory' && !isDirectory)) {
    fail('PATH_TYPE_INVALID', `${label}类型不正确。`);
  }
  if (expectedType === 'file' && stat.nlink !== 1) fail('HARDLINK_NOT_ALLOWED', `${label}不能是硬链接。`);
  return stat;
}

/** 检查目录或文件是真实普通对象，并确认 realpath 与解析路径一致。 */
function assertOrdinaryPath(targetPath, expectedType, label) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (_error) {
    fail('PATH_MISSING', `${label}不存在。`, { path: relativeProjectPath(targetPath) });
  }
  assertOrdinaryStat(stat, expectedType, label);
  let realPath;
  try {
    realPath = fs.realpathSync.native(targetPath);
  } catch (_error) {
    fail('REALPATH_UNAVAILABLE', `无法确认${label}的 realpath。`);
  }
  if (normalizePathForCompare(realPath) !== normalizePathForCompare(targetPath)) {
    fail('REALPATH_MISMATCH', `${label}的 realpath 与默认目标不一致。`);
  }
  return stat;
}

/** 确认目标 realpath 位于指定普通目录内，拒绝重解析点越界。 */
function assertRealPathContained(targetPath, rootPath, label) {
  assertOrdinaryPath(rootPath, 'directory', '数据目录');
  let targetRealPath;
  let rootRealPath;
  try {
    targetRealPath = fs.realpathSync.native(targetPath);
    rootRealPath = fs.realpathSync.native(rootPath);
  } catch (_error) {
    fail('REALPATH_UNAVAILABLE', `无法确认${label}的 realpath containment。`);
  }
  const relative = path.relative(rootRealPath, targetRealPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('PATH_OUTSIDE_DATA_DIR', `${label}必须位于默认 data 目录内。`);
  }
}

/** 对指定 SQLite 及存在的 WAL/SHM 执行普通文件、realpath、containment 和硬链接检查。 */
function assertSqliteSidecarsSafe(sqlitePath, rootPath, labelPrefix = 'SQLite') {
  [`${sqlitePath}-wal`, `${sqlitePath}-shm`].forEach((sidecarPath) => {
    if (!pathEntryExists(sidecarPath)) return;
    assertOrdinaryPath(sidecarPath, 'file', `${labelPrefix} sidecar ${path.basename(sidecarPath)}`);
    assertRealPathContained(sidecarPath, rootPath, `${labelPrefix} sidecar ${path.basename(sidecarPath)}`);
  });
}

/** 对主库及存在的 WAL/SHM 执行普通文件、realpath、containment 和硬链接检查。 */
function assertDatabaseFileSetSafe(paths) {
  assertOrdinaryPath(paths.databasePath, 'file', '默认 SQLite');
  assertRealPathContained(paths.databasePath, paths.dataDir, '默认 SQLite');
  assertSqliteSidecarsSafe(paths.databasePath, paths.dataDir);
}

/** 读取单个路径及其后代的存在性、mtime、大小和文件摘要。 */
function snapshotPathBoundary(targetPath) {
  if (!pathEntryExists(targetPath)) return { exists: false };
  const walk = (currentPath, relative = '.') => {
    const stat = fs.lstatSync(currentPath);
    const item = {
      relative,
      type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      nlink: stat.nlink
    };
    if (stat.isFile()) item.sha256 = sha256FileSync(currentPath);
    const rows = [item];
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.readdirSync(currentPath).sort().forEach((name) => {
        rows.push(...walk(path.join(currentPath, name), relative === '.' ? name : `${relative}/${name}`));
      });
    }
    return rows;
  };
  return { exists: true, entries: walk(targetPath) };
}

/** 建立 check/verify 目标边界快照，一次递归覆盖整个 data 目录及所有受控残留。 */
function snapshotReadOnlyBoundary(paths) {
  return {
    dataTree: snapshotPathBoundary(paths.dataDir)
  };
}

/** 确认只读命令结束时全部受控路径仍与入口快照完全一致。 */
function assertReadOnlyBoundaryUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail('READ_ONLY_STATE_CHANGED', '只读检查期间 data、SQLite sidecar、uploads 或 backups 状态发生变化，已拒绝返回过期诊断。');
  }
}

/** 在完整前后快照保护下执行 check/verify，并在异常路径同样核对零 mutation。 */
async function runWithReadOnlyBoundary(paths, operation) {
  const before = snapshotReadOnlyBoundary(paths);
  try {
    const result = await operation();
    const after = snapshotReadOnlyBoundary(paths);
    assertReadOnlyBoundaryUnchanged(before, after);
    return result;
  } catch (error) {
    const after = snapshotReadOnlyBoundary(paths);
    assertReadOnlyBoundaryUnchanged(before, after);
    throw error;
  }
}

/** 检查数据目录顶层残留，执行前任何未解释的 marker/staging 都阻断。 */
function inspectResiduals(dataDir) {
  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  const residuals = entries
    .filter((entry) => entry.name === MARKER_NAME
      || entry.name === RESTORE_MARKER_NAME
      || entry.name.startsWith(MARKER_TEMP_PREFIX)
      || MARKER_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => entry.name)
    .sort();
  return residuals;
}

/** 将残留按 candidate、旧库和 uploads staging 分类，供 --verify 精确诊断。 */
function classifyResiduals(residuals) {
  return {
    marker: residuals.filter((name) => name === MARKER_NAME || name === RESTORE_MARKER_NAME),
    markerTemps: residuals.filter((name) => name.startsWith(MARKER_TEMP_PREFIX)),
    candidates: residuals.filter((name) => name.startsWith('.format-candidate-') || name.startsWith('.restore-candidate-')),
    oldDatabases: residuals.filter((name) => name.startsWith('.format-old-') || name.startsWith('.restore-old-')),
    uploadsStaging: residuals.filter((name) => name.startsWith('.format-uploads-') || name.startsWith('.restore-uploads-'))
  };
}

/** 确认测试路径同时受 NODE_ENV 和明确隔离根目录两道门保护。 */
function assertTestIsolationRoot(testIsolationRoot, paths) {
  if (process.env.NODE_ENV !== 'test') fail('TEST_GATE_REQUIRED', '隔离测试路径仅允许 NODE_ENV=test。');
  const root = testIsolationRoot && path.resolve(testIsolationRoot);
  if (!root || !path.isAbsolute(root)) fail('TEST_ROOT_REQUIRED', '隔离测试必须提供明确绝对路径。');
  let tempRoot;
  try { tempRoot = fs.realpathSync.native(os.tmpdir()); } catch (_error) { fail('TEMP_ROOT_UNAVAILABLE', '无法确认系统临时目录。'); }
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch (_error) { fail('TEST_ROOT_UNAVAILABLE', '无法确认隔离根目录。'); }
  const relative = path.relative(tempRoot, realRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('TEST_ROOT_OUTSIDE_TEMP', '隔离根目录必须位于系统临时目录内。');
  }
  if (normalizePathForCompare(realRoot) === normalizePathForCompare(projectRoot)) fail('TEST_ROOT_PROJECT', '隔离根目录不能是项目目录。');
  const expected = {
    dataDir: path.join(realRoot, 'data'),
    databasePath: path.join(realRoot, 'data', 'energy-carbon.sqlite'),
    uploadsDir: path.join(realRoot, 'data', 'uploads'),
    backupsDir: path.join(realRoot, 'data', 'backups')
  };
  Object.entries(expected).forEach(([key, value]) => {
    if (normalizePathForCompare(paths[key]) !== normalizePathForCompare(value)) fail('TEST_PATH_NOT_ISOLATED', `隔离测试${key}不是隔离根目录下的默认路径。`);
  });
  return realRoot;
}

/**
 * 将 formatter 的唯一同步身份与 database.js 导出合同交叉校验，并返回允许版本集合。
 * @param {object} database 数据库基础模块。
 * @returns {string[]} 仅含 current v3 与 predecessor v2 的允许版本。
 */
function assertCanonicalAdmissionContract(database) {
  if (!database
    || database.CANONICAL_SCHEMA_STAGE !== CANONICAL_STAGE
    || database.CANONICAL_SCHEMA_VERSION !== CANONICAL_VERSION
    || database.CANONICAL_SCHEMA_FINGERPRINT_ALGORITHM !== FINGERPRINT_ALGORITHM
    || typeof database.matchTrustedCanonicalSchemaProfile !== 'function') {
    fail('CANONICAL_CONTRACT_MISMATCH', '格式化工具与数据库模块的 canonical admission 合同不一致。');
  }
  return ADMITTED_SCHEMA_VERSIONS;
}

/** 先加载环境，再读取 database 模块的模块级默认路径。 */
function loadModules() {
  // 该函数只在环境加载完成后调用，避免 database.js/backupService.js 绑定错误路径。
  // eslint 不在本项目中启用，显式保留局部模块加载边界。
  if (process.env.NODE_ENV !== 'test') loadRuntimeEnvironment();
  const database = canonicalDatabase;
  const backupService = require('../server/src/services/backupService');
  assertCanonicalAdmissionContract(database);
  return { database, backupService };
}

/** 校验生产默认路径，生产 CLI 绝不接受任意自定义路径。 */
function resolveContext(options = {}) {
  const { database } = loadModules();
  const paths = database.getDatabaseInfo();
  const resolvedPaths = Object.fromEntries(Object.entries(paths).map(([key, value]) => (
    typeof value === 'string' ? [key, path.resolve(value)] : [key, value]
  )));
  const testRoot = options.testIsolationRoot
    || (process.env.NODE_ENV === 'test' ? process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT : null);
  if (process.env.NODE_ENV === 'test') {
    if (!testRoot) fail('TEST_ROOT_REQUIRED', '隔离测试必须提供明确隔离根目录。');
    assertTestIsolationRoot(testRoot, resolvedPaths);
  } else if (testRoot) {
    assertTestIsolationRoot(testRoot, resolvedPaths);
  } else {
    const expected = {
      dataDir: path.resolve(projectRoot, 'data'),
      databasePath: path.resolve(projectRoot, 'data', 'energy-carbon.sqlite'),
      uploadsDir: path.resolve(projectRoot, 'data', 'uploads'),
      backupsDir: path.resolve(projectRoot, 'data', 'backups')
    };
    ['dataDir', 'databasePath', 'uploadsDir', 'backupsDir'].forEach((key) => {
      if (normalizePathForCompare(resolvedPaths[key]) !== normalizePathForCompare(expected[key])) fail('DEFAULT_PATH_REQUIRED', `${key}必须解析为项目默认路径。`);
    });
  }
  return { ...resolvedPaths, testIsolationRoot: testRoot ? path.resolve(testRoot) : null };
}

/** 检查管理员环境变量的布尔门禁，不返回或记录其值、长度和摘要。 */
function assertAdminPasswordConfigured() {
  const password = String(process.env.CHARCOAL_ADMIN_PASSWORD || '');
  if (!password) fail('ADMIN_PASSWORD_REQUIRED', '未设置可用的 CHARCOAL_ADMIN_PASSWORD。');
  if (password.length < 8) fail('ADMIN_PASSWORD_REQUIRED', 'CHARCOAL_ADMIN_PASSWORD 未通过最小安全门禁。');
  return { configured: true };
}

/** 严格解析 PowerShell writer 检查结果，缺字段、错误类型和畸形元素均 fail-closed。 */
function parseWriterInspectionPayload(rawPayload) {
  let result;
  try {
    result = typeof rawPayload === 'string' || Buffer.isBuffer(rawPayload)
      ? JSON.parse(String(rawPayload).trim())
      : rawPayload;
  } catch (_error) {
    fail('WRITER_CHECK_UNAVAILABLE', 'Windows writer 检查返回了无法解析的 JSON。');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('WRITER_CHECK_UNAVAILABLE', 'Windows writer 检查结果必须是对象。');
  }
  const requiredFields = ['locked', 'listeners', 'projectProcesses'];
  requiredFields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(result, field) || !Array.isArray(result[field])) {
      fail('WRITER_CHECK_UNAVAILABLE', 'Windows writer 检查结果字段缺失或类型无效。');
    }
  });
  if (result.locked.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('WRITER_CHECK_UNAVAILABLE', 'Windows writer 检查 locked 元素结构无效。');
  }
  const validatePidArray = (items) => items.every((item) => Number.isSafeInteger(item) && item > 0);
  if (!validatePidArray(result.listeners) || !validatePidArray(result.projectProcesses)) {
    fail('WRITER_CHECK_UNAVAILABLE', 'Windows writer 检查 PID 元素结构无效。');
  }
  return {
    lockedFiles: result.locked.slice(),
    listeningPids: result.listeners.slice(),
    projectPids: result.projectProcesses.slice()
  };
}

/** 构造 PowerShell writer 检查请求，端口来自当前运行环境而非固定值。 */
function buildWriterInspectionRequest(paths, runtimeEnvironment) {
  const ports = [...new Set([runtimeEnvironment.backendPort, runtimeEnvironment.frontendPort])]
    .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535);
  if (ports.length !== 2) fail('WRITER_CHECK_UNAVAILABLE', '无法从当前运行环境解析后端和前端监听端口。');
  return {
    files: [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`].filter((targetPath) => pathEntryExists(targetPath)),
    ports,
    projectRoot,
    projectRootName: path.basename(projectRoot)
  };
}

/** 将正则安全编码为 PowerShell 单引号字面量。 */
function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 构造 PowerShell writer 检查脚本，包含绝对和相对项目启动命令识别。 */
function buildWriterInspectionScript(request) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const relativeServerPattern = String.raw`(?i)(^|[\s"'])(?:node(?:\.exe)?\s+)?(?:\.?[\\/])?server[\\/]src[\\/]index\.js(?:\s|$)`;
  const npmDevPattern = String.raw`(?i)(^|[\s"'])npm(?:\.cmd)?\s+run\s+dev:(?:server|client)(?:\s|$)`;
  const vitePattern = String.raw`(?i)(^|[\s"'])vite(?:\.cmd)?(?:\s|$)`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$inputObject = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHARCOAL_FORMAT_TARGETS)))',
    `$relativeServerPattern = ${quotePowerShellLiteral(relativeServerPattern)}`,
    `$npmDevPattern = ${quotePowerShellLiteral(npmDevPattern)}`,
    `$vitePattern = ${quotePowerShellLiteral(vitePattern)}`,
    '$locked = @()',
    'foreach ($target in $inputObject.files) { try { $handle = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $handle.Dispose() } catch { $locked += [string]$target } }',
    '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $inputObject.ports -contains [int]$_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [int]$_ })',
    '$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (($_.CommandLine -match [Regex]::Escape($inputObject.projectRoot)) -or ($_.CommandLine -match $relativeServerPattern) -or ($_.CommandLine -match $npmDevPattern) -or ($_.CommandLine -match $vitePattern)) } | Select-Object -ExpandProperty ProcessId | ForEach-Object { [int]$_ })',
    '[pscustomobject]@{ locked = @($locked); listeners = @($listeners); projectProcesses = @($processes) } | ConvertTo-Json -Compress'
  ].join('; ');
  return { payload, script };
}

/** 执行 PowerShell writer 检查；测试可注入 runner，但生产不停止任何进程。 */
function runWriterInspection(request, runner = execFileSync) {
  const { payload, script } = buildWriterInspectionScript(request);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CHARCOAL_FORMAT_TARGETS: payload },
    maxBuffer: 1024 * 1024
  });
}

/** 在 Windows 上使用独占打开和监听 PID 检查写入者；无法确认时 fail-closed。 */
function inspectWindowsWriters(paths, options = {}) {
  try {
    const runtimeEnvironment = options.runtimeEnvironment || loadRuntimeEnvironment();
    const request = buildWriterInspectionRequest(paths, runtimeEnvironment);
    const rawPayload = options.runWriterInspection
      ? options.runWriterInspection(request)
      : runWriterInspection(request);
    const result = parseWriterInspectionPayload(rawPayload);
    if (result.lockedFiles.length || result.listeningPids.length || result.projectPids.length) {
      fail('WRITERS_PRESENT', '检测到数据库文件占用者或项目监听进程；请调用者先精确停止服务后重试。', {
        lockedFiles: result.lockedFiles.map(relativeProjectPath),
        listeningPids: result.listeningPids,
        projectPids: result.projectPids
      });
    }
    return { checked: true, lockedFiles: [], listeningPids: [], projectPids: [] };
  } catch (error) {
    if (error instanceof FormatError) throw error;
    fail('WRITER_CHECK_UNAVAILABLE', '无法安全确认数据库写入者和项目监听进程。');
  }
}

/** 跨平台写入者检查；测试通过 hook 注入，不触碰真实进程。 */
function inspectWriters(paths) {
  if (process.platform === 'win32') return inspectWindowsWriters(paths);
  fail('WRITER_CHECK_UNAVAILABLE', '当前平台无法安全确认数据库文件占用者和项目进程。');
}

/** 只读计算所需容量，至少覆盖备份、candidate、sidecar 和 staging 安全余量。 */
function assertDiskSpace(paths) {
  let dbSize = 0;
  [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`].forEach((target) => {
    try { dbSize += fs.statSync(target).size; } catch (_error) { /* sidecar 可以不存在 */ }
  });
  const required = Math.max(64 * 1024 * 1024, dbSize * 4 + 16 * 1024 * 1024);
  let available;
  try {
    const stat = fs.statfsSync(paths.dataDir);
    available = Number(stat.bavail) * Number(stat.bsize);
  } catch (_error) {
    fail('DISK_SPACE_UNAVAILABLE', '无法确认默认数据目录可用磁盘空间。');
  }
  if (!Number.isFinite(available) || available < required) fail('DISK_SPACE_INSUFFICIENT', '默认数据目录可用磁盘空间不足。');
  return { requiredBytes: required, availableBytes: available };
}

/** 将 candidate 的角色、菜单授权和 energy_types 与数据库模块可信 seed contract 逐项比对。 */
function assertCandidateSeedContract(database, candidateDb) {
  if (typeof database.getCanonicalSeedContract !== 'function' || typeof database.readCanonicalSeedContract !== 'function') {
    fail('CANDIDATE_SEED_CONTRACT_UNAVAILABLE', '数据库模块缺少可信 seed contract。');
  }
  const expected = database.getCanonicalSeedContract();
  const actual = database.readCanonicalSeedContract(candidateDb);
  if (JSON.stringify(actual.roles) !== JSON.stringify(expected.roles)) {
    fail('CANDIDATE_RBAC_INVALID', 'candidate 内置角色 seed 不符合可信合同。');
  }
  if (JSON.stringify(actual.menus) !== JSON.stringify(expected.menus)) {
    fail('CANDIDATE_MENU_INVALID', 'candidate 菜单 permission、route、component 或父子关系不符合可信合同。');
  }
  if (JSON.stringify(actual.grants) !== JSON.stringify(expected.grants)) {
    fail('CANDIDATE_RBAC_INVALID', 'candidate super_admin 或普通用户授权集合不符合可信合同。');
  }
  if (JSON.stringify(actual.energyTypes) !== JSON.stringify(expected.energyTypes)) {
    fail('CANDIDATE_REFERENCE_INVALID', 'candidate energy_types code/name/unit/reference 内容不符合可信合同。');
  }
}

/** 用当前代码控制的 trusted profile 和严格只读 SQLite 连接验证结构及完整性。 */
function validateDatabaseFile(database, targetPath, expectedVersion, expectedStage = CANONICAL_STAGE, options = {}) {
  let db;
  try {
    const admittedVersions = assertCanonicalAdmissionContract(database);
    const expectedVersions = Array.isArray(expectedVersion) ? expectedVersion : [expectedVersion];
    if (expectedVersions.length === 0 || expectedVersions.some((version) => !admittedVersions.includes(version))) {
      fail('SCHEMA_IDENTITY_INVALID', '请求的 SQLite schema 版本不属于 current 或唯一 predecessor。');
    }
    if (typeof database.openReadOnlyDatabase !== 'function') fail('SQLITE_READONLY_UNAVAILABLE', '缺少严格只读 SQLite 打开能力。');
    db = database.openReadOnlyDatabase({ databasePath: targetPath });
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM app_meta WHERE key IN ('schema_stage','schema_version','schema_fingerprint','schema_fingerprint_algorithm')").all().map((row) => [row.key, row.value]));
    if (metadata.schema_stage !== expectedStage || !expectedVersions.includes(metadata.schema_version)
      || metadata.schema_fingerprint_algorithm !== FINGERPRINT_ALGORITHM) {
      fail('SCHEMA_IDENTITY_INVALID', 'SQLite schema identity 与代码控制的 canonical profile 不一致。');
    }
    if (typeof database.matchTrustedCanonicalSchemaProfile !== 'function') {
      fail('SCHEMA_PROFILE_UNAVAILABLE', '数据库模块缺少可信 schema profile 比对能力。');
    }
    let trustedProfile;
    try {
      trustedProfile = database.matchTrustedCanonicalSchemaProfile(db, metadata.schema_version);
    } catch (_error) {
      fail('SCHEMA_FINGERPRINT_INVALID', 'SQLite schema 未命中代码控制的可信 profile。');
    }
    const fingerprint = database.calculateSchemaFingerprint(db);
    if (fingerprint !== trustedProfile.fingerprint || fingerprint !== metadata.schema_fingerprint) {
      fail('SCHEMA_FINGERPRINT_INVALID', 'SQLite schema fingerprint 未通过可信 profile 复算。');
    }
    const integrity = database.verifyCanonicalDatabaseIntegrity(db);
    const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    if (journalMode !== 'wal') fail('JOURNAL_MODE_INVALID', 'SQLite 未处于 WAL 模式。');
    return { metadata, fingerprint, integrity, journalMode, trustedProfile: { version: trustedProfile.version, algorithm: trustedProfile.algorithm } };
  } catch (error) {
    if (error instanceof FormatError) throw error;
    fail('SQLITE_VALIDATION_FAILED', 'SQLite 只读完整性验证失败。');
  } finally {
    if (db) db.close();
  }
}

/** 在系统临时目录验证静态副本，避免 --check 在正式 WAL 库旁创建 SHM/WAL。 */
function validateReadOnlySnapshot(database, sourcePath, expectedVersion, rootPath = path.dirname(sourcePath)) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-format-check-'));
  const snapshotPath = path.join(temporaryDirectory, 'energy-carbon.sqlite');
  try {
    assertOrdinaryPath(sourcePath, 'file', 'SQLite 来源文件');
    assertRealPathContained(sourcePath, rootPath, 'SQLite 来源文件');
    assertSqliteSidecarsSafe(sourcePath, rootPath);
    const sourceSidecars = [`${sourcePath}-wal`, `${sourcePath}-shm`].filter((targetPath) => pathEntryExists(targetPath));
    fs.copyFileSync(sourcePath, snapshotPath);
    sourceSidecars.forEach((sourceSidecar) => {
      const suffix = sourceSidecar.slice(sourcePath.length);
      fs.copyFileSync(sourceSidecar, `${snapshotPath}${suffix}`);
    });
    return validateDatabaseFile(database, snapshotPath, expectedVersion);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** 校验 candidate 的管理员、RBAC seed、runtime 默认和业务表清空合同。 */
function validateCandidate(database, candidatePath) {
  const validated = validateDatabaseFile(database, candidatePath, CANONICAL_VERSION);
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(candidatePath, { readonly: true, fileMustExist: true });
    const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    const appMeta = db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
    if (appMeta.length !== 4 || appMeta.some((row) => !['schema_fingerprint', 'schema_fingerprint_algorithm', 'schema_stage', 'schema_version'].includes(row.key))) fail('CANDIDATE_SEED_INVALID', 'candidate app_meta seed 不完整。');
    const users = db.prepare('SELECT id, username, status, is_builtin FROM sys_users').all();
    if (users.length !== 1 || users[0].username !== 'admin' || users[0].status !== 'active' || users[0].is_builtin !== 1) fail('CANDIDATE_ADMIN_INVALID', 'candidate 未形成唯一 active 内置管理员。');
    const roles = db.prepare('SELECT id, role_code, status, is_builtin FROM sys_roles ORDER BY role_code').all();
    if (roles.length !== 2 || roles.some((row) => row.status !== 'active' || row.is_builtin !== 1) || !roles.some((row) => row.role_code === 'super_admin')) fail('CANDIDATE_RBAC_INVALID', 'candidate 内置角色 seed 不完整。');
    const adminRoleRows = db.prepare(`SELECT r.role_code AS roleCode FROM sys_user_roles ur JOIN sys_users u ON u.id=ur.user_id JOIN sys_roles r ON r.id=ur.role_id WHERE u.username='admin' AND u.status='active' AND r.status='active'`).all();
    if (adminRoleRows.length !== 1 || adminRoleRows[0].roleCode !== 'super_admin') fail('CANDIDATE_RBAC_INVALID', 'candidate 管理员未唯一关联 active super_admin。');
    const menus = db.prepare('SELECT id, menu_type AS menuType, menu_name AS menuName, status, is_builtin AS isBuiltin FROM sys_menus').all();
    if (menus.length < 20 || menus.some((row) => row.status !== 'active' || row.isBuiltin !== 1 || !row.menuName)) fail('CANDIDATE_MENU_INVALID', 'candidate 内置菜单 seed 不完整。');
    assertCandidateSeedContract(database, db);
    const roleMenuCount = db.prepare('SELECT COUNT(*) AS count FROM sys_role_menus').get().count;
    const ungrantedRoleCount = db.prepare(`SELECT COUNT(*) AS count FROM sys_roles r
      WHERE r.status='active' AND NOT EXISTS (SELECT 1 FROM sys_role_menus rm WHERE rm.role_id=r.id)`).get().count;
    const orphanRoleMenuCount = db.prepare(`SELECT COUNT(*) AS count FROM sys_role_menus rm
      LEFT JOIN sys_roles r ON r.id=rm.role_id LEFT JOIN sys_menus m ON m.id=rm.menu_id
      WHERE r.id IS NULL OR m.id IS NULL`).get().count;
    if (roleMenuCount < 1 || ungrantedRoleCount !== 0 || orphanRoleMenuCount !== 0) fail('CANDIDATE_RBAC_INVALID', 'candidate 角色菜单 seed 不完整。');
    const runtime = db.prepare('SELECT id, enabled, runtime_epoch AS runtimeEpoch, revision, updated_by AS updatedBy, change_reason AS changeReason FROM demo_runtime_settings').get();
    if (!runtime || runtime.id !== 1 || runtime.enabled !== 0 || runtime.runtimeEpoch !== 1 || runtime.revision !== 1 || runtime.updatedBy !== null || runtime.changeReason !== 'schema_default') fail('CANDIDATE_RUNTIME_INVALID', 'candidate demo runtime 未保持安全关闭默认值。');
    if (db.prepare("SELECT COUNT(*) AS count FROM demo_dataset_runs WHERE status IN ('active','completed','cleanup_pending','cleaning')").get().count !== 0) fail('CANDIDATE_DEMO_HISTORY_INVALID', 'candidate 存在旧 demo run。');
    EMPTY_CANDIDATE_TABLES.forEach((tableName) => {
      if (!tableNames.has(tableName)) fail('CANDIDATE_SCHEMA_INVALID', 'candidate 缺少当前 schema 表。');
      const count = db.prepare(`SELECT COUNT(*) AS count FROM "${tableName.replace(/"/g, '""')}"`).get().count;
      if (count !== 0) fail('CANDIDATE_NOT_EMPTY', 'candidate 存在不允许保留的业务、导入、审计或演示历史数据。');
    });
    const energyTypeCount = db.prepare('SELECT COUNT(*) AS count FROM energy_types').get().count;
    if (energyTypeCount !== 10) fail('CANDIDATE_REFERENCE_INVALID', 'candidate 能源类型 reference seed 不完整。');
    for (const tableName of tableNames) {
      if (!ALLOWED_SEED_TABLES.has(tableName) && !EMPTY_CANDIDATE_TABLES.includes(tableName)) fail('CANDIDATE_UNKNOWN_DATA', 'candidate 存在未授权的非空表。');
    }
    return { ...validated, rowContract: { userCount: users.length, roleCount: roles.length, menuCount: menus.length, energyTypeCount } };
  } catch (error) {
    if (error instanceof FormatError) throw error;
    fail('CANDIDATE_VALIDATION_FAILED', 'candidate 内容验证失败。');
  } finally {
    if (db) db.close();
  }
}

/** 读取备份目录清单，禁止符号链接和目录逃逸。 */
function snapshotBackups(paths) {
  assertOrdinaryPath(paths.backupsDir, 'directory', 'backups 目录');
  return snapshotTree(paths.backupsDir);
}

/** 确认新 manual backup 是默认 backups 目录直属的普通文件。 */
function assertManualBackupPath(paths, backupPath) {
  const resolvedBackupPath = path.resolve(backupPath);
  const relative = path.relative(paths.backupsDir, resolvedBackupPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(resolvedBackupPath) !== paths.backupsDir) {
    fail('BACKUP_PATH_INVALID', 'manual backup 必须位于默认 backups 目录直属路径。');
  }
  assertOrdinaryPath(resolvedBackupPath, 'file', 'manual backup');
  return relative.split(path.sep).join('/');
}

/** 比较备份清单并返回新增、缺失和被修改的相对路径。 */
function describeBackupChanges(before, after) {
  const beforeMap = new Map(before.map((item) => [item.relative, item]));
  const afterMap = new Map(after.map((item) => [item.relative, item]));
  return {
    added: after.filter((item) => !beforeMap.has(item.relative)).map((item) => item.relative),
    missing: before.filter((item) => !afterMap.has(item.relative)).map((item) => item.relative),
    modified: before.filter((item) => {
      const current = afterMap.get(item.relative);
      return current && (current.size !== item.size || current.sha256 !== item.sha256);
    }).map((item) => item.relative)
  };
}

/** 比较既有备份清单，新增项只允许本次验证过的 manual backup。 */
function assertBackupsUnchanged(before, after, verifiedBackupRelative) {
  const changes = describeBackupChanges(before, after);
  if (changes.missing.length || changes.modified.length) fail('BACKUPS_CHANGED', '既有 backups 文件大小或 SHA-256 已变化。', changes);
  if (changes.added.length !== 1 || changes.added[0] !== verifiedBackupRelative) fail('BACKUPS_UNEXPECTED_CHANGE', 'backups 只允许新增本次已验证的 manual backup。', { additions: changes.added, expected: verifiedBackupRelative });
}

/** 判断目录打开或 fsync 错误是否属于平台明确不支持的可安全 fallback 情形。 */
function isUnsupportedDirectoryFsyncError(error, stage = 'fsync') {
  if (!error || typeof error.code !== 'string') return false;
  if (stage === 'open') return ['ENOTSUP', 'ENOSYS', 'EISDIR'].includes(error.code);
  if (stage !== 'fsync') return false;
  if (['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR'].includes(error.code)) return true;
  return process.platform === 'win32'
    && error.code === 'EPERM'
    && (!error.syscall || error.syscall === 'fsync');
}

/** 在平台支持时将父目录目录项同步到持久介质，非预期错误必须 fail-closed。 */
function fsyncParentDirectory(targetPath, fileOperations = fs) {
  let descriptor;
  let operationError = null;
  let operationStage = 'open';
  let closeError = null;
  try {
    descriptor = fileOperations.openSync(path.dirname(targetPath), 'r');
    operationStage = 'fsync';
    fileOperations.fsyncSync(descriptor);
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fileOperations.closeSync(descriptor);
      } catch (error) {
        closeError = error;
      }
    }
  }
  if (closeError) {
    fail('PARENT_DIRECTORY_FSYNC_FAILED', '无法安全关闭 marker 父目录句柄，已拒绝继续。', { reason: 'close_failed' });
  }
  if (operationError) {
    if (isUnsupportedDirectoryFsyncError(operationError, operationStage)) {
      return { supported: false, fallback: 'directory_fsync_unsupported', stage: operationStage };
    }
    fail('PARENT_DIRECTORY_FSYNC_FAILED', 'marker 父目录持久化失败，已拒绝继续。', {
      reason: 'unexpected_error',
      stage: operationStage
    });
  }
  return { supported: true, fallback: null };
}

/** 将 marker 原子写入并 fsync，记录恢复所需的非敏感路径和阶段。 */
function writeMarker(markerPath, marker, options = {}) {
  const fileOperations = options.fileOperations || fs;
  const syncParentDirectory = options.fsyncParentDirectory || fsyncParentDirectory;
  const temporaryPath = `${markerPath}.tmp-${process.pid}`;
  const content = `${JSON.stringify(marker)}\n`;
  const descriptor = fileOperations.openSync(temporaryPath, 'w');
  try {
    fileOperations.writeFileSync(descriptor, content, 'utf8');
    fileOperations.fsyncSync(descriptor);
  } finally {
    fileOperations.closeSync(descriptor);
  }
  fileOperations.renameSync(temporaryPath, markerPath);
  syncParentDirectory(markerPath, fileOperations);
}

/** 安全读取 marker；格式不明时不尝试猜测性恢复。 */
function readMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return null;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_error) { fail('MARKER_INVALID', '格式化 marker 无法解析，必须人工按恢复流程处理。'); }
  if (!marker || marker.schema !== MARKER_SCHEMA || marker.version !== MARKER_VERSION || typeof marker.phase !== 'string') fail('MARKER_INVALID', '格式化 marker 协议不受支持。');
  return marker;
}

/** 删除 SQLite sidecar，candidate 不得混入旧正式库 WAL/SHM。 */
function removeSidecars(sqlitePath, fileOperations = fs) {
  [`${sqlitePath}-wal`, `${sqlitePath}-shm`].forEach((target) => {
    if (fileOperations.existsSync(target)) fileOperations.rmSync(target, { force: true });
  });
}

/** 只清理本次生成且尚未验证通过的 manual backup，绝不碰既有 backups。 */
function removeUnverifiedBackup(backup, paths, fileOperations = fs) {
  if (!backup || typeof backup.path !== 'string') return;
  const backupPath = path.resolve(backup.path);
  const relative = path.relative(paths.backupsDir, backupPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('BACKUP_PATH_INVALID', '未验证备份路径不在默认 backups 目录内。');
  }
  if (fileOperations.existsSync(backupPath)) fileOperations.rmSync(backupPath, { force: true });
  removeSidecars(backupPath, fileOperations);
}

/** 将旧正式库主文件及 sidecar 分别移到同卷 staging。 */
function stageOfficialDatabase(paths, staging, fileOperations = fs) {
  const mapping = [];
  const targets = [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`];
  const stagingTargets = [staging.oldDatabasePath, staging.oldWalPath, staging.oldShmPath];
  targets.forEach((source, index) => {
    if (fileOperations.existsSync(source)) {
      fileOperations.renameSync(source, stagingTargets[index]);
      mapping.push({ source, target: stagingTargets[index] });
    }
  });
  return mapping;
}

/** 回滚旧数据库 staging；按主文件和 sidecar 分项恢复，避免删除尚未 staging 的旧 sidecar。 */
function restoreOfficialDatabase(paths, staging, fileOperations = fs, options = {}) {
  const pairs = [
    [staging.oldDatabasePath, paths.databasePath],
    [staging.oldWalPath, `${paths.databasePath}-wal`],
    [staging.oldShmPath, `${paths.databasePath}-shm`]
  ];
  const hasOldDatabase = fileOperations.existsSync(staging.oldDatabasePath);
  const hasAnyStagedFile = pairs.some(([source]) => fileOperations.existsSync(source));
  if (!hasAnyStagedFile) {
    if (options.dbInstalled) fail('ROLLBACK_SOURCE_MISSING', '旧数据库 staging 缺失，不能安全回滚。');
    return;
  }
  if (!hasOldDatabase) fail('ROLLBACK_SOURCE_MISSING', '旧数据库主文件 staging 缺失，不能安全回滚。');
  pairs.forEach(([source, target], index) => {
    if (fileOperations.existsSync(source)) {
      if (fileOperations.existsSync(target)) fileOperations.rmSync(target, { force: true });
      fileOperations.renameSync(source, target);
      return;
    }
    // candidate 重新打开可能生成新 sidecar；旧库原本无该 sidecar 时必须恢复为不存在。
    if (options.dbInstalled && index > 0 && fileOperations.existsSync(target)) {
      fileOperations.rmSync(target, { force: true });
    }
  });
}

/** 预检只读路径、环境、完整性、空间、进程和残留，不修改目标 DB/uploads/backups。 */
async function check(options = {}) {
  const paths = resolveContext(options);
  return runWithReadOnlyBoundary(paths, async () => {
    assertAdminPasswordConfigured();
    ['dataDir', 'uploadsDir', 'backupsDir'].forEach((key) => assertOrdinaryPath(paths[key], 'directory', key));
    assertDatabaseFileSetSafe(paths);
    const residuals = inspectResiduals(paths.dataDir);
    if (residuals.length) fail('RESIDUAL_STATE', '发现未完成的格式化或恢复残留，请先使用 --verify 诊断。', { residuals });
    const { database } = loadModules();
    const writerState = options.hooks && options.hooks.inspectWriters ? await options.hooks.inspectWriters(paths) : inspectWriters(paths);
    const validation = validateReadOnlySnapshot(database, paths.databasePath, ADMITTED_SCHEMA_VERSIONS);
    // predecessor v2 是正式格式化的唯一允许来源；执行 candidate 始终由 initDatabase 生成当前 v3。
    const sourceVersion = validation.metadata.schema_version;
    if (!ADMITTED_SCHEMA_VERSIONS.includes(sourceVersion)) fail('SCHEMA_IDENTITY_INVALID', '现有 SQLite 不是当前 canonical 或唯一 predecessor。');
    const disk = options.hooks && options.hooks.assertDiskSpace
      ? await options.hooks.assertDiskSpace(paths)
      : assertDiskSpace(paths);
    return {
      mode: 'check',
      paths: { data: relativeProjectPath(paths.dataDir), database: relativeProjectPath(paths.databasePath), uploads: relativeProjectPath(paths.uploadsDir), backups: relativeProjectPath(paths.backupsDir) },
      schemaVersion: sourceVersion,
      schemaStage: validation.metadata.schema_stage,
      schemaFingerprint: validation.fingerprint,
      disk: { requiredBytes: disk.requiredBytes, availableBytes: disk.availableBytes },
      writers: writerState,
      backups: snapshotBackups(paths).length,
      uploads: snapshotTree(paths.uploadsDir).length,
      filesystemState: 'unchanged'
    };
  });
}

/** 只读诊断 marker、candidate、staging、正式库和 uploads 状态。 */
async function verify(options = {}) {
  const paths = resolveContext(options);
  return runWithReadOnlyBoundary(paths, async () => {
    ['dataDir', 'backupsDir'].forEach((key) => assertOrdinaryPath(paths[key], 'directory', key));
    const markerPath = path.join(paths.dataDir, MARKER_NAME);
    const marker = readMarker(markerPath);
    const residuals = inspectResiduals(paths.dataDir);
    const residualDetails = classifyResiduals(residuals);
    const currentBackups = snapshotBackups(paths);
    const backupChanges = marker && Array.isArray(marker.backupsBefore)
      ? describeBackupChanges(marker.backupsBefore, currentBackups)
      : null;
    let uploadsState = 'missing';
    let uploadsCount = null;
    if (pathEntryExists(paths.uploadsDir)) {
      assertOrdinaryPath(paths.uploadsDir, 'directory', 'uploadsDir');
      uploadsCount = snapshotTree(paths.uploadsDir).length;
      uploadsState = uploadsCount === 0 ? 'empty' : 'nonempty';
    }
    let databaseState = 'missing';
    let databaseValidation = null;
    if (pathEntryExists(paths.databasePath) || pathEntryExists(`${paths.databasePath}-wal`) || pathEntryExists(`${paths.databasePath}-shm`)) {
      try {
        assertDatabaseFileSetSafe(paths);
        if (!pathEntryExists(paths.databasePath)) fail('SQLITE_SIDECAR_WITHOUT_DATABASE', 'SQLite sidecar 存在但主数据库缺失。');
        const { database } = loadModules();
        const validation = validateReadOnlySnapshot(database, paths.databasePath, ADMITTED_SCHEMA_VERSIONS);
        databaseState = 'valid';
        databaseValidation = {
          schemaStage: validation.metadata.schema_stage,
          schemaVersion: validation.metadata.schema_version,
          fingerprint: validation.fingerprint,
          journalMode: validation.journalMode
        };
      } catch (error) {
        databaseState = 'invalid';
        databaseValidation = { code: error && error.code ? error.code : 'SQLITE_VALIDATION_FAILED' };
      }
    }
    let nextAction = '未发现格式化 marker。';
    if (marker && marker.phase === 'cleanup_pending') {
      nextAction = '保持服务停止；uploads 永久清理已中断，按 marker 保留项人工复核后收尾。';
    } else if (marker && marker.phase === 'rollback_failed') {
      nextAction = '保持服务停止；自动回滚失败，按 marker 恢复 old database、sidecar 和 uploads staging。';
    } else if (marker) {
      nextAction = '保持服务停止；按 marker 阶段检查 candidate、old database、sidecar 和 uploads staging。';
    } else if (residuals.length) {
      nextAction = '禁止 execute；先清理并确认 candidate、old database、uploads staging 或其他残留来源。';
    } else if (uploadsState === 'missing') {
      nextAction = 'uploads 目录缺失；禁止 execute，先人工确认是否存在未记录的 staging 或异常删除。';
    }
    return {
      mode: 'verify',
      marker: marker ? { phase: marker.phase, operationId: marker.operationId, databaseState: marker.databaseState, uploadsState: marker.uploadsState } : null,
      residuals,
      residualDetails,
      artifacts: {
        marker: pathEntryExists(markerPath),
        markerTemps: residualDetails.markerTemps,
        candidates: residualDetails.candidates,
        oldDatabases: residualDetails.oldDatabases,
        uploadsStaging: residualDetails.uploadsStaging
      },
      databaseState,
      databaseValidation,
      uploadsState,
      uploadsCount,
      backupCount: currentBackups.length,
      backupChanges,
      filesystemState: 'unchanged',
      nextAction
    };
  });
}

/** 创建同卷 staging 名称，避免复用旧 candidate 或旧恢复对象。 */
function buildStaging(paths) {
  const operationId = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    operationId,
    markerPath: path.join(paths.dataDir, MARKER_NAME),
    candidatePath: path.join(paths.dataDir, `.format-candidate-${operationId}.sqlite`),
    oldDatabasePath: path.join(paths.dataDir, `.format-old-${operationId}.sqlite`),
    oldWalPath: path.join(paths.dataDir, `.format-old-${operationId}.sqlite-wal`),
    oldShmPath: path.join(paths.dataDir, `.format-old-${operationId}.sqlite-shm`),
    uploadsStagingPath: path.join(paths.dataDir, `.format-uploads-${operationId}`)
  };
}

/** 清理本次仍可逆的临时对象；不触碰 backups 既有文件。 */
function cleanupStaging(staging, fileOperations = fs) {
  [staging.candidatePath, `${staging.candidatePath}-wal`, `${staging.candidatePath}-shm`, staging.oldDatabasePath, staging.oldWalPath, staging.oldShmPath].forEach((target) => {
    if (fileOperations.existsSync(target)) fileOperations.rmSync(target, { force: true });
  });
  if (fileOperations.existsSync(staging.uploadsStagingPath)) fileOperations.rmSync(staging.uploadsStagingPath, { recursive: true, force: true });
}

/** 执行整库格式化；uploads 进入永久删除阶段后不再伪造数据库回滚。 */
async function execute(options = {}) {
  if (options.confirmation !== CONFIRM_TEXT) fail('CONFIRMATION_REQUIRED', '必须提供精确确认文本。');
  const paths = resolveContext(options);
  assertAdminPasswordConfigured();
  ['dataDir', 'uploadsDir', 'backupsDir'].forEach((key) => assertOrdinaryPath(paths[key], 'directory', key));
  assertDatabaseFileSetSafe(paths);
  const residuals = inspectResiduals(paths.dataDir);
  if (residuals.length) fail('RESIDUAL_STATE', '发现并发或残留 marker/staging，已拒绝执行。', { residuals });
  const hooks = options.hooks || {};
  const fileOperations = options.fileOperations || fs;
  const { database, backupService } = loadModules();
  const writerState = hooks.inspectWriters ? await hooks.inspectWriters(paths) : inspectWriters(paths);
  const disk = hooks.assertDiskSpace ? await hooks.assertDiskSpace(paths) : assertDiskSpace(paths);
  // 先对临时副本验证来源，避免正式 WAL 库旁的只读检查产生 sidecar。
  const sourceValidation = validateReadOnlySnapshot(database, paths.databasePath, ADMITTED_SCHEMA_VERSIONS);
  const beforeBackups = snapshotBackups(paths);
  const staging = buildStaging(paths);
  let permit = null;
  let backup = null;
  let backupVerified = false;
  let oldStaged = false;
  let dbInstalled = false;
  let uploadsStaged = false;
  let uploadsCleanupStarted = false;
  const marker = {
    schema: MARKER_SCHEMA, version: MARKER_VERSION, operationId: staging.operationId,
    phase: 'prepared', databaseState: 'old', uploadsState: 'original',
    databasePath: relativeProjectPath(paths.databasePath), uploadsPath: relativeProjectPath(paths.uploadsDir),
    candidatePath: relativeProjectPath(staging.candidatePath), oldDatabasePath: relativeProjectPath(staging.oldDatabasePath),
    oldWalPath: relativeProjectPath(staging.oldWalPath), oldShmPath: relativeProjectPath(staging.oldShmPath),
    uploadsStagingPath: relativeProjectPath(staging.uploadsStagingPath),
    sourceSchemaVersion: sourceValidation.metadata.schema_version,
    targetSchemaVersion: CANONICAL_VERSION, backupsBefore: beforeBackups, createdAt: new Date().toISOString()
  };
  try {
    permit = database.blockDatabaseAdmission();
    await (hooks.waitForDrain ? hooks.waitForDrain(permit) : backupService._test.waitForOfficialDatabaseDrain());
    if (hooks.inspectWriters) await hooks.inspectWriters(paths); else inspectWriters(paths);
    assertDatabaseFileSetSafe(paths);
    if (hooks.checkpointOfficial) await hooks.checkpointOfficial(permit); else backupService._test.checkpointDatabase({ admissionPermit: permit });
    assertDatabaseFileSetSafe(paths);
    marker.phase = 'backup_pending';
    writeMarker(staging.markerPath, marker);
    backup = await backupService.createBackup({ reason: 'manual', admissionPermit: permit, skipCheckpoint: true });
    if (hooks.afterBackupCreated) await hooks.afterBackupCreated({ backup, permit });
    const backupRelative = assertManualBackupPath(paths, backup.path);
    assertSqliteSidecarsSafe(backup.path, paths.backupsDir, 'manual backup');
    assertDatabaseFileSetSafe(paths);
    const backupValidation = validateDatabaseFile(database, backup.path, ADMITTED_SCHEMA_VERSIONS);
    if (backupValidation.metadata.schema_version !== sourceValidation.metadata.schema_version
      || backupValidation.fingerprint !== sourceValidation.fingerprint) {
      fail('BACKUP_IDENTITY_MISMATCH', 'manual backup 与格式化来源 schema identity 不一致。');
    }
    removeSidecars(backup.path, fileOperations);
    // createBackup 已经使用 better-sqlite3 backup API；这里追加三类 PRAGMA、canonical 和 fingerprint 校验。
    marker.manualBackup = { relative: backupRelative, sha256: sha256FileSync(backup.path), size: fs.statSync(backup.path).size, method: backup.method, schemaVersion: backupValidation.metadata.schema_version, fingerprint: backupValidation.fingerprint };
    backupVerified = true;
    marker.phase = 'backup_verified';
    writeMarker(staging.markerPath, marker);
    if (hooks.afterBackupValidated) await hooks.afterBackupValidated({ backup, marker, permit });
    const initializeCandidate = hooks.initializeCandidate || ((candidatePath) => database.initDatabase({ databasePath: candidatePath }));
    initializeCandidate(staging.candidatePath);
    removeSidecars(staging.candidatePath, fileOperations);
    const candidateValidation = hooks.validateCandidate ? await hooks.validateCandidate(staging.candidatePath) : validateCandidate(database, staging.candidatePath);
    removeSidecars(staging.candidatePath, fileOperations);
    marker.candidate = { schemaVersion: candidateValidation.metadata.schema_version, fingerprint: candidateValidation.fingerprint, rowContract: candidateValidation.rowContract || null };
    marker.phase = 'candidate_verified';
    writeMarker(staging.markerPath, marker);
    assertBackupsUnchanged(beforeBackups, snapshotBackups(paths), backupRelative);
    if (hooks.inspectWriters) await hooks.inspectWriters(paths); else inspectWriters(paths);
    assertDatabaseFileSetSafe(paths);
    if (hooks.checkpointOfficial) await hooks.checkpointOfficial(permit); else backupService._test.checkpointDatabase({ admissionPermit: permit });
    assertDatabaseFileSetSafe(paths);
    if (hooks.closeBeforeInstall) await hooks.closeBeforeInstall();
    assertDatabaseFileSetSafe(paths);
    oldStaged = true;
    const stagedFiles = stageOfficialDatabase(paths, staging, fileOperations);
    marker.phase = 'db_old_staged';
    marker.stagedFiles = stagedFiles.map((item) => ({ source: relativeProjectPath(item.source), target: relativeProjectPath(item.target) }));
    marker.databaseState = 'old_staged';
    writeMarker(staging.markerPath, marker);
    if (hooks.installCandidate) await hooks.installCandidate(staging.candidatePath, paths.databasePath, fileOperations);
    else fileOperations.renameSync(staging.candidatePath, paths.databasePath);
    dbInstalled = true;
    marker.phase = 'db_installed';
    marker.databaseState = 'candidate_installed';
    writeMarker(staging.markerPath, marker);
    const installedValidation = hooks.verifyInstalled ? await hooks.verifyInstalled(paths.databasePath) : validateDatabaseFile(database, paths.databasePath, CANONICAL_VERSION, CANONICAL_STAGE, { admissionPermit: permit });
    marker.installed = { schemaVersion: installedValidation.metadata.schema_version, fingerprint: installedValidation.fingerprint };
    marker.phase = 'db_verified';
    marker.databaseState = 'candidate_verified';
    writeMarker(staging.markerPath, marker);
    if (hooks.inspectWriters) await hooks.inspectWriters(paths); else inspectWriters(paths);
    assertBackupsUnchanged(beforeBackups, snapshotBackups(paths), backupRelative);
    if (fileOperations.existsSync(paths.uploadsDir)) fileOperations.renameSync(paths.uploadsDir, staging.uploadsStagingPath);
    uploadsStaged = true;
    fileOperations.mkdirSync(paths.uploadsDir, { recursive: false });
    assertOrdinaryPath(paths.uploadsDir, 'directory', '新 uploads 目录');
    if (snapshotTree(paths.uploadsDir).length !== 0) fail('UPLOADS_NOT_EMPTY', '新 uploads 目录未为空。');
    assertOrdinaryPath(staging.uploadsStagingPath, 'directory', 'uploads staging');
    marker.phase = 'uploads_staged';
    marker.uploadsState = 'staged_for_delete';
    writeMarker(staging.markerPath, marker);
    assertBackupsUnchanged(beforeBackups, snapshotBackups(paths), backupRelative);
    if (snapshotTree(paths.uploadsDir).length !== 0) fail('UPLOADS_NOT_EMPTY', '新 uploads 目录在永久清理前不为空。');
    uploadsCleanupStarted = true;
    marker.phase = 'uploads_cleanup_started';
    marker.uploadsState = 'permanent_delete_started';
    writeMarker(staging.markerPath, marker);
    if (hooks.removeUploadsStaging) await hooks.removeUploadsStaging(staging.uploadsStagingPath); else fileOperations.rmSync(staging.uploadsStagingPath, { recursive: true, force: false });
    marker.phase = 'committed';
    marker.uploadsState = 'empty';
    writeMarker(staging.markerPath, marker);
    const afterBackups = snapshotBackups(paths);
    assertBackupsUnchanged(beforeBackups, afterBackups, backupRelative);
    if (snapshotTree(paths.uploadsDir).length !== 0) fail('UPLOADS_NOT_EMPTY', '新 uploads 目录未为空。');
    cleanupStaging(staging, fileOperations);
    fileOperations.rmSync(staging.markerPath, { force: true });
    database.unblockDatabaseAdmission(permit);
    return { mode: 'execute', status: 'completed', schemaVersion: CANONICAL_VERSION, manualBackup: marker.manualBackup, backupsBefore: beforeBackups.length, backupsAfter: afterBackups.length, uploadsCleared: true, writers: writerState, disk: { requiredBytes: disk.requiredBytes, availableBytes: disk.availableBytes } };
  } catch (error) {
    if (uploadsCleanupStarted) {
      marker.phase = 'cleanup_pending';
      marker.databaseState = dbInstalled ? 'candidate_verified' : marker.databaseState;
      marker.uploadsState = 'permanent_delete_interrupted';
      try { writeMarker(staging.markerPath, marker); } catch (_markerError) { /* 保留原始故障，--verify 仍报告文件残留 */ }
      if (permit) database.unblockDatabaseAdmission(permit);
      if (error instanceof FormatError) throw error;
      fail('UPLOADS_CLEANUP_INTERRUPTED', 'uploads 永久清理中断；数据库保持新库，服务必须保持停止并按 --verify 处理。');
    }
    try {
      if (backup && !backupVerified) removeUnverifiedBackup(backup, paths, fileOperations);
      if (uploadsStaged && fileOperations.existsSync(staging.uploadsStagingPath)) {
        if (fileOperations.existsSync(paths.uploadsDir)) fileOperations.rmSync(paths.uploadsDir, { recursive: true, force: true });
        fileOperations.renameSync(staging.uploadsStagingPath, paths.uploadsDir);
      }
      if (dbInstalled || oldStaged) {
        if (hooks.restoreOfficial) await hooks.restoreOfficial(paths, staging, fileOperations);
        else restoreOfficialDatabase(paths, staging, fileOperations, { dbInstalled });
      }
      cleanupStaging(staging, fileOperations);
      if (fs.existsSync(staging.markerPath)) fileOperations.rmSync(staging.markerPath, { force: true });
      if (permit) database.unblockDatabaseAdmission(permit);
    } catch (_rollbackError) {
      // 失败时释放本进程内 admission 状态；不启动服务，调用者仍必须保持服务停止并人工恢复。
      try { if (permit) database.unblockDatabaseAdmission(permit); } catch (_admissionError) { /* 进程退出后状态自然消失 */ }
      try { writeMarker(staging.markerPath, { ...marker, phase: 'rollback_failed', databaseState: dbInstalled ? 'unknown' : marker.databaseState, uploadsState: uploadsStaged ? 'unknown' : marker.uploadsState }); } catch (_writeError) { /* fail-closed */ }
      fail('ROLLBACK_FAILED', '格式化失败且自动回滚无法完成；必须保持服务停止并按 --verify 诊断。');
    }
    if (error instanceof FormatError) throw error;
    fail('FORMAT_FAILED', '格式化失败，旧数据库和 uploads 已回滚。');
  }
}

/** 统一 CLI 输出，不输出管理员密码、长度、哈希或完整环境变量。 */
function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** CLI 主入口；异常只输出稳定错误码和非敏感中文信息。 */
async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    const options = { mode: parsed.mode, confirmation: parsed.confirmation, testIsolationRoot: process.env.NODE_ENV === 'test' ? process.env.CHARCOAL_FORMAT_TEST_ISOLATION_ROOT : null };
    const result = parsed.mode === 'verify' ? await verify(options) : (parsed.mode === 'execute' ? await execute(options) : await check(options));
    printResult(result);
    return 0;
  } catch (error) {
    const safe = error instanceof FormatError ? error : new FormatError('FORMAT_FAILED', '格式化工具未能安全完成。');
    process.stderr.write(`${JSON.stringify({ success: false, code: safe.code, message: safe.message, details: safe.details || {} })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  CONFIRM_TEXT,
  MARKER_NAME,
  CANONICAL_VERSION,
  PREDECESSOR_VERSION,
  parseArgs,
  resolveContext,
  check,
  verify,
  execute,
  validateDatabaseFile,
  validateCandidate,
  snapshotTree,
  snapshotBackups,
  _test: {
    FormatError,
    assertOrdinaryStat,
    assertOrdinaryPath,
    assertDatabaseFileSetSafe,
    assertDiskSpace,
    inspectResiduals,
    classifyResiduals,
    buildStaging,
    writeMarker,
    fsyncParentDirectory,
    isUnsupportedDirectoryFsyncError,
    cleanupStaging,
    assertBackupsUnchanged,
    removeUnverifiedBackup,
    snapshotReadOnlyBoundary,
    runWithReadOnlyBoundary,
    parseWriterInspectionPayload,
    buildWriterInspectionRequest,
    runWriterInspection,
    buildWriterInspectionScript,
    inspectWindowsWriters
  }
};
