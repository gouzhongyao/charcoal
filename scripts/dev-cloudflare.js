const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { loadRuntimeEnvironment } = require('../config/runtimeEnvironment');
const {
  validateTunnelApiBase,
  normalizeTunnelTransportProtocol,
  buildCloudflaredTunnelArguments,
  createQuickTunnelLogCapture,
  parseQuickTunnelMetricsPayload,
  normalizeMetricsOrigin,
  buildQuickTunnelMetricsUrl,
  normalizeContentType,
  evaluateHealthyJsonResponse,
  evaluateCloudflaredReadyResponse,
  createRequestErrorObservation,
  formatRedactedReadinessDiagnostic,
  runTunnelReadinessStages,
  createPrefixedLineBuffer,
  sortOwnedProcessEntries
} = require('./dev-cloudflare-core');

// 项目路径模块：所有子进程固定在项目根运行，并通过绝对路径定位入口。
const projectRoot = path.resolve(__dirname, '..');
const expressEntryPath = path.join(projectRoot, 'server', 'src', 'index.js');
const viteConfigPath = path.join(projectRoot, 'client', 'vite.config.js');
// 启动超时模块：本地服务、Tunnel 发现、Edge readiness 和公网链路分别设置有限等待时间。
const localHealthTimeoutMs = 30000;
const tunnelDiscoveryTimeoutMs = 60000;
const metricsReadyTimeoutMs = 90000;
const publicHealthTimeoutMs = 90000;
const singleRequestTimeoutMs = 3000;
const healthResponseMaxBytes = 64 * 1024;
const metricsResponseMaxBytes = 64 * 1024;
const pageResponseMaxBytes = 1024 * 1024;
const cliVersionTimeoutMs = 10000;
// 清理超时模块：先正常终止，超时后只强制清理本脚本记录的 PID。
const gracefulStopTimeoutMs = 4000;
const forcedStopTimeoutMs = 5000;
// 轮询节奏模块：避免服务启动期高频占用 CPU。
const pollingIntervalMs = 250;
// 就绪观察类型模块：只允许核心定义的稳定分类进入轮询诊断。
const readinessObservationKinds = new Set([
  'healthy',
  'ready',
  'http-status',
  'content-type',
  'invalid-json',
  'contract-mismatch',
  'not-ready'
]);
// cloudflared 安装模块：CLI 缺失时输出官方安装入口。
const cloudflaredInstallUrl = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

// 正常中断模块：区分用户信号退出和真正启动失败。
class GracefulShutdownError extends Error {
  // 正常中断构造模块：仅在清理流程内部使用，不对用户报告为错误。
  constructor(signalName) {
    const normalizedSignalName = signalName || '退出信号';
    super(`收到 ${normalizedSignalName}，正在停止本地分享链路。`);
    this.name = 'GracefulShutdownError';
    this.signalName = normalizedSignalName;
  }
}

// 异步等待模块：轮询间隔统一使用 Promise 延时。
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 错误标准化模块：把拒绝原因和非 Error 异常统一为可读 Error。
function normalizeError(errorValue) {
  if (errorValue instanceof Error) {
    return errorValue;
  }
  return new Error(String(errorValue ?? '未知错误'));
}

// Tunnel API Base 环境模块：校验后覆盖两个兼容变量，防止 Vite 环境文件改写同源规则。
function enforceTunnelApiBaseEnvironment(targetEnvironment = process.env) {
  validateTunnelApiBase(targetEnvironment.VITE_API_BASE_URL);
  validateTunnelApiBase(targetEnvironment.VITE_API_BASE);
  targetEnvironment.VITE_API_BASE_URL = '/api';
  targetEnvironment.VITE_API_BASE = '/api';
  return '/api';
}

// cloudflared 默认配置候选模块：按平台生成 Quick Tunnel 会自动搜索的常见配置路径。
function buildDefaultCloudflaredConfigCandidates(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const homeDirectory = options.homeDirectory || os.homedir();
  const platformPath = targetPlatform === 'win32' ? path.win32 : path.posix;
  const userConfigDirectories = ['.cloudflared', '.cloudflare-warp', 'cloudflare-warp'];
  const candidatePaths = userConfigDirectories.flatMap((configDirectory) => [
    platformPath.join(homeDirectory, configDirectory, 'config.yml'),
    platformPath.join(homeDirectory, configDirectory, 'config.yaml')
  ]);
  if (targetPlatform !== 'win32') {
    candidatePaths.push(
      '/etc/cloudflared/config.yml',
      '/etc/cloudflared/config.yaml',
      '/usr/local/etc/cloudflared/config.yml',
      '/usr/local/etc/cloudflared/config.yaml'
    );
  }
  return Array.from(new Set(candidatePaths));
}

// cloudflared 默认配置检测模块：允许测试注入候选路径和文件存在函数，避免读取真实用户配置。
function findDefaultCloudflaredConfigConflicts(options = {}) {
  const candidatePaths = Array.isArray(options.candidatePaths)
    ? options.candidatePaths.map((candidatePath) => String(candidatePath))
    : buildDefaultCloudflaredConfigCandidates(options);
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : fs.existsSync;
  return candidatePaths.filter((candidatePath) => pathExists(candidatePath));
}

// cloudflared 默认配置预检模块：发现冲突只报错，不修改、移动或重命名用户文件。
function assertNoDefaultCloudflaredConfigConflict(options = {}) {
  const conflictPaths = findDefaultCloudflaredConfigConflicts(options);
  if (conflictPaths.length === 0) {
    return;
  }
  throw new Error([
    '检测到 cloudflared 默认配置文件，与无配置 Quick Tunnel 模式冲突：',
    ...conflictPaths.map((conflictPath) => `- ${conflictPath}`),
    '启动器不会修改、移动或重命名这些文件；请先由用户自行处理默认配置冲突后重试。',
    '前后端服务尚未启动。'
  ].join('\n'));
}

// 端口占用预检模块：只尝试绑定并关闭，不终止任何未知进程。
async function assertPortAvailable(host, port, label) {
  await new Promise((resolve, reject) => {
    // 临时监听模块：成功监听即证明当前时刻端口可用，关闭后交给真实服务。
    const probeServer = net.createServer();
    probeServer.unref();
    probeServer.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`${label} ${host}:${port} 已被占用；请释放端口后重试。本脚本不会终止未知进程。`));
        return;
      }
      reject(new Error(`${label} ${host}:${port} 可用性检查失败：${error.message}`));
    });
    probeServer.listen(port, host, () => {
      probeServer.close((error) => {
        if (error) {
          reject(new Error(`${label} ${host}:${port} 预检关闭失败：${error.message}`));
          return;
        }
        resolve();
      });
    });
  });
}

// 动态回环端口模块：让操作系统选择空闲 cloudflared metrics 端口。
async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    // 临时监听模块：端口选择完成后立即释放，仅供随后启动 cloudflared 使用。
    const probeServer = net.createServer();
    probeServer.unref();
    probeServer.once('error', reject);
    probeServer.listen(0, '127.0.0.1', () => {
      const address = probeServer.address();
      const selectedPort = address && typeof address === 'object' ? address.port : null;
      probeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
          reject(new Error('未能为 cloudflared metrics 选择有效回环端口。'));
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}

// Vite CLI 路径模块：从已安装 vite/package.json 的 bin 字段解析官方入口。
function resolveViteCliPath() {
  // Vite 包信息模块：不依赖 node_modules 固定层级，兼容包管理器解析结果。
  const vitePackagePath = require.resolve('vite/package.json');
  const vitePackage = require(vitePackagePath);
  const viteBinPath = typeof vitePackage.bin === 'string' ? vitePackage.bin : vitePackage.bin?.vite;
  if (!viteBinPath || typeof viteBinPath !== 'string') {
    throw new Error('无法从 vite/package.json 解析 Vite CLI bin。');
  }
  return path.resolve(path.dirname(vitePackagePath), viteBinPath);
}

// cloudflared 预检失败模块：用稳定类型传递失败原因，不把命令路径或原始进程错误带到用户输出。
function createCloudflaredPreflightFailure(failureKind, message, details = {}) {
  const preflightError = new Error(message);
  preflightError.cloudflaredPreflightKind = failureKind;
  if (details.code) {
    preflightError.code = details.code;
  }
  if (Number.isInteger(details.exitCode)) {
    preflightError.exitCode = details.exitCode;
  }
  if (details.signalName) {
    preflightError.signalName = details.signalName;
  }
  return preflightError;
}

// 短命令执行模块：用于启动任何长期服务前验证 cloudflared --version。
function runVersionCommand(commandPath) {
  return new Promise((resolve, reject) => {
    // 版本进程模块：shell=false，显式路径失败时不会经过 shell 或自动回退。
    const versionProcess = spawn(commandPath, ['--version'], {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let stdoutText = '';
    let stderrText = '';

    // 版本输出模块：限制缓冲大小，避免异常 CLI 输出占用过多内存。
    versionProcess.stdout.on('data', (chunk) => {
      stdoutText = `${stdoutText}${String(chunk)}`.slice(-8192);
    });
    versionProcess.stderr.on('data', (chunk) => {
      stderrText = `${stderrText}${String(chunk)}`.slice(-8192);
    });

    // 版本超时模块：短预检超过上限时终止其 PID，并按失败处理。
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      // 版本超时清理模块：复用拥有 PID 的受控清理，不遗留卡住的预检进程。
      const versionEntry = {
        key: 'cloudflared-version',
        label: 'cloudflared 版本预检',
        child: versionProcess,
        pid: versionProcess.pid || null,
        spawnError: null,
        detachedGroup: false
      };
      stopOwnedProcess(versionEntry)
        .catch(() => {})
        .finally(() => reject(createCloudflaredPreflightFailure(
          'timeout',
          'cloudflared --version 预检超时。'
        )));
    }, cliVersionTimeoutMs);
    timeout.unref();

    // 版本启动错误模块：包括 PATH 缺失、显式路径不存在和不可执行。
    versionProcess.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(createCloudflaredPreflightFailure(
        error?.code === 'ENOENT' ? 'missing' : 'spawn',
        'cloudflared --version 进程启动失败。',
        { code: error?.code }
      ));
    });

    // 版本退出模块：只有退出码 0 才视为 CLI 可用。
    versionProcess.once('close', (exitCode, signalName) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(createCloudflaredPreflightFailure(
          'nonzero-exit',
          'cloudflared --version 返回非零退出状态。',
          { exitCode, signalName }
        ));
        return;
      }
      resolve(`${stdoutText}\n${stderrText}`.trim());
    });
  });
}

// cloudflared 命令解析模块：显式配置只接受当前平台可识别的完整绝对路径，空值才使用 PATH。
function resolveCloudflaredCommand(configuredValue = process.env.CLOUDFLARED_BIN, targetPlatform = process.platform) {
  const configuredBin = String(configuredValue ?? '').trim();
  if (!configuredBin) {
    return Object.freeze({ commandPath: 'cloudflared', configured: false });
  }

  const isWindowsPlatform = targetPlatform === 'win32';
  const isWindowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(configuredBin);
  const isWindowsUncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(configuredBin);
  const isRecognizedAbsolutePath = isWindowsPlatform
    ? isWindowsDriveAbsolute || isWindowsUncAbsolute
    : path.posix.isAbsolute(configuredBin);
  if (!isRecognizedAbsolutePath) {
    throw new Error([
      'CLOUDFLARED_BIN 非空时必须填写当前平台可识别的 cloudflared 可执行文件完整绝对路径。',
      'Windows 请使用盘符绝对路径或 UNC 路径；POSIX 请使用以 / 开头的绝对路径。',
      '如需从 PATH 查找 cloudflared，请将 CLOUDFLARED_BIN 留空。',
      '前后端服务尚未启动。'
    ].join('\n'));
  }

  return Object.freeze({ commandPath: configuredBin, configured: true });
}

// cloudflared 预检分类模块：只读取错误类型和稳定元数据，不拼接原始消息。
function classifyCloudflaredPreflightFailure(errorValue) {
  const preflightError = normalizeError(errorValue);
  if (preflightError.cloudflaredPreflightKind) {
    return preflightError.cloudflaredPreflightKind;
  }
  if (preflightError.code === 'ENOENT') {
    return 'missing';
  }
  if (preflightError.code === 'ETIMEDOUT' || /超时|timed?\s*out/i.test(preflightError.message)) {
    return 'timeout';
  }
  if (Number.isInteger(preflightError.exitCode) || preflightError.signalName) {
    return 'nonzero-exit';
  }
  return 'unknown';
}

// cloudflared 预检错误模块：显式路径失败完全脱敏，PATH 模式提供稳定可诊断提示。
function buildCloudflaredPreflightFailureMessage(errorValue, configured) {
  const failureKind = classifyCloudflaredPreflightFailure(errorValue);
  if (configured) {
    const configuredFailureMessages = {
      spawn: '无法启动显式配置的 cloudflared 可执行文件。',
      missing: '无法启动显式配置的 cloudflared 可执行文件。',
      timeout: '显式配置的 cloudflared --version 预检超时。',
      'nonzero-exit': '显式配置的 cloudflared --version 返回非零退出状态。',
      'output-mismatch': '显式配置的可执行文件版本输出未识别为官方 cloudflared。'
    };
    return configuredFailureMessages[failureKind] || '显式配置的 cloudflared 预检失败。';
  }

  const pathFailureMessages = {
    spawn: 'PATH 中的 cloudflared 命令无法启动。',
    missing: 'PATH 中未找到 cloudflared 命令。',
    timeout: 'PATH 中的 cloudflared --version 预检超时。',
    'nonzero-exit': 'PATH 中的 cloudflared --version 返回非零退出状态。',
    'output-mismatch': 'PATH 中找到的可执行文件版本输出未识别为官方 cloudflared。'
  };
  return pathFailureMessages[failureKind] || 'PATH 中的 cloudflared 预检失败。';
}

// cloudflared 预检模块：显式 CLOUDFLARED_BIN 失败时绝不回退 PATH，并允许纯逻辑测试注入版本执行器。
async function verifyCloudflaredCli(options = {}) {
  // CLI 来源模块：严格解析显式绝对路径，空值才交给 PATH 自然解析 cloudflared.exe。
  const hasConfiguredValue = Object.prototype.hasOwnProperty.call(options, 'configuredValue');
  const configuredValue = hasConfiguredValue ? options.configuredValue : process.env.CLOUDFLARED_BIN;
  const targetPlatform = options.targetPlatform || process.platform;
  const versionCommandRunner = typeof options.versionCommandRunner === 'function'
    ? options.versionCommandRunner
    : runVersionCommand;
  const logVersion = typeof options.logVersion === 'function' ? options.logVersion : console.log;
  const cloudflaredCommand = resolveCloudflaredCommand(configuredValue, targetPlatform);
  const { commandPath, configured } = cloudflaredCommand;
  try {
    const versionOutput = await versionCommandRunner(commandPath);
    if (!/cloudflared\s+version/i.test(versionOutput)) {
      throw createCloudflaredPreflightFailure(
        'output-mismatch',
        '`--version` 输出未识别为官方 cloudflared。'
      );
    }
    const versionLine = versionOutput.split(/\r?\n/).find(Boolean) || '版本检查通过';
    logVersion(`[launcher] ${versionLine}`);
    return Object.freeze({ commandPath, configured, versionOutput });
  } catch (error) {
    const sourceHint = configured
      ? '当前已设置 CLOUDFLARED_BIN，按安全约定不会回退 PATH；请修正该可执行文件完整绝对路径。'
      : '当前未设置 CLOUDFLARED_BIN，将从 PATH 查找 cloudflared（Windows 会自然解析 cloudflared.exe）。';
    const failureMessage = buildCloudflaredPreflightFailureMessage(error, configured);
    throw new Error([
      `无法执行官方 cloudflared CLI：${failureMessage}`,
      sourceHint,
      `安装说明：${cloudflaredInstallUrl}`,
      '也可在项目根 .env 中设置 CLOUDFLARED_BIN=<cloudflared 可执行文件完整路径>。',
      '前后端服务尚未启动。'
    ].join('\n'));
  }
}

// 子进程存活模块：退出码和信号都为空时才视为仍在运行。
function isOwnedProcessRunning(entry) {
  return Boolean(entry?.child)
    && entry.child.exitCode === null
    && entry.child.signalCode === null
    && !entry.spawnError;
}

// 子进程 spawn 失败模块：只保留进程标签和 Error/cause 白名单元数据，不传播原始消息。
function buildOwnedProcessSpawnError(entry, errorValue) {
  // spawn 观察模块：复用安全错误投影，绝对路径、UNC、URL 和 Token 不进入最终错误。
  const spawnObservation = createRequestErrorObservation(errorValue);
  const spawnError = new Error(
    `${entry.label} 启动失败：${formatRedactedReadinessDiagnostic(spawnObservation)}`
  );
  spawnError.projectCode = 'CHARCOAL_PROCESS_SPAWN_FAILED';
  return spawnError;
}

// 子进程退出描述模块：为异常联动退出提供稳定中文错误。
function buildOwnedProcessExitError(entry, exitCode, signalName) {
  return new Error(`${entry.label} 进程提前退出，exitCode=${exitCode ?? 'null'}，signal=${signalName || 'none'}。`);
}

// POSIX 进程组存活模块：独立进程组可在父进程退出后继续检查其剩余子进程。
function isOwnedProcessGroupRunning(entry) {
  if (process.platform === 'win32' || !entry.detachedGroup || !entry.pid) {
    return false;
  }
  try {
    process.kill(-entry.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// 清理目标存活模块：Windows 检查记录父 PID，POSIX 同时检查本脚本创建的独立进程组。
function isOwnedTerminationTargetRunning(entry) {
  return isOwnedProcessRunning(entry) || isOwnedProcessGroupRunning(entry);
}

// 子进程退出等待模块：轮询记录 PID/进程组，避免父进程先退而后代仍残留。
async function waitForOwnedProcessExit(entry, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isOwnedTerminationTargetRunning(entry)) {
      return true;
    }
    await delay(50);
  }
  return !isOwnedTerminationTargetRunning(entry);
}

// Windows 进程树模块：仅对本脚本记录的 PID 使用 taskkill，强制阶段才追加 /F。
async function killWindowsProcessTree(entry, force) {
  if (!entry.pid || !isOwnedTerminationTargetRunning(entry)) {
    return;
  }
  await new Promise((resolve) => {
    // taskkill 参数模块：不通过 shell，不按名称或端口扩大清理范围。
    const taskkillArguments = ['/PID', String(entry.pid), '/T'];
    if (force) {
      taskkillArguments.push('/F');
    }
    const killerProcess = spawn('taskkill', taskkillArguments, {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    let settled = false;
    // taskkill 收尾模块：限制辅助进程等待时间，避免清理流程自身无限挂起。
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      try {
        killerProcess.kill('SIGKILL');
      } catch (error) {
        // taskkill 可能已退出，直接完成当前强制清理尝试。
      }
      finish();
    }, forcedStopTimeoutMs);
    timeout.unref();
    killerProcess.once('error', finish);
    killerProcess.once('close', finish);
  });
}

// 拥有进程信号模块：POSIX 长期服务使用独立进程组，Windows 先向记录 PID 发送正常信号。
function signalOwnedProcess(entry, signalName) {
  if (process.platform !== 'win32' && entry.detachedGroup && entry.pid) {
    process.kill(-entry.pid, signalName);
    return;
  }
  entry.child.kill(signalName);
}

// 单进程清理模块：先请求正常终止，超时后才对记录 PID 或进程组强制结束。
async function stopOwnedProcess(entry) {
  if (!isOwnedTerminationTargetRunning(entry)) {
    return;
  }
  console.log(`[cleanup] 正在停止 ${entry.label}（PID ${entry.pid}）...`);
  try {
    if (process.platform === 'win32') {
      await killWindowsProcessTree(entry, false);
    } else {
      signalOwnedProcess(entry, 'SIGTERM');
    }
  } catch (error) {
    // 进程或进程树可能刚好退出，随后仍以实际存活状态决定是否强制清理。
  }
  if (await waitForOwnedProcessExit(entry, gracefulStopTimeoutMs)) {
    return;
  }

  console.warn(`[cleanup] ${entry.label} 未在超时内退出，正在强制结束本脚本拥有的 PID ${entry.pid}。`);
  if (process.platform === 'win32') {
    await killWindowsProcessTree(entry, true);
  } else if (isOwnedTerminationTargetRunning(entry)) {
    try {
      signalOwnedProcess(entry, 'SIGKILL');
    } catch (error) {
      // 进程或进程组可能在强制信号发出前退出，无需扩大清理范围。
    }
  }
  const didExit = await waitForOwnedProcessExit(entry, forcedStopTimeoutMs);
  if (!didExit && isOwnedTerminationTargetRunning(entry)) {
    throw new Error(`${entry.label}（PID ${entry.pid}）强制清理后仍未确认退出。`);
  }
}

// 全量清理模块：固定按照 Tunnel、Vite、Express 顺序串行执行。
async function cleanupOwnedProcesses(entries) {
  const cleanupEntries = sortOwnedProcessEntries(entries);
  const cleanupErrors = [];
  for (const entry of cleanupEntries) {
    try {
      await stopOwnedProcess(entry);
    } catch (error) {
      cleanupErrors.push(normalizeError(error));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.map((error) => error.message).join('；'));
  }
}

// 生命周期模块：集中记录子进程、异常原因、信号和幂等清理 Promise。
function createLifecycleController(options = {}) {
  // 生命周期状态模块：stopPromise 让就绪后的主流程持续等待退出原因。
  const entries = [];
  const lateCleanupPromises = new Set();
  const lateCleanupErrors = [];
  const cleanupInitialOwnedEntries = typeof options.cleanupOwnedEntries === 'function'
    ? options.cleanupOwnedEntries
    : cleanupOwnedProcesses;
  const stopLateOwnedEntry = typeof options.stopOwnedEntry === 'function'
    ? options.stopOwnedEntry
    : stopOwnedProcess;
  let fatalError = null;
  let signalName = '';
  let shutdownStarted = false;
  let shutdownPhase = 'running'; // 关停阶段用于区分动态清理、稳定确认、结果合并和最终完成。
  let lateCleanupGeneration = 0; // 晚登记代数用于识别集合短暂为空期间发生过的新登记。
  let shutdownPromise = null;
  let resolveStop;
  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });

  // 清理错误记录模块：初始快照和晚登记进程的清理错误统一合并到最终结果。
  function recordCleanupError(cleanupError) {
    lateCleanupErrors.push(normalizeError(cleanupError));
  }

  // 晚登记清理模块：关停门禁关闭后仍到达 register 的拥有进程必须立即进入受控终止。
  function scheduleLateEntryCleanup(entry) {
    entry.registrationRejected = true;
    lateCleanupGeneration += 1;
    if (shutdownPhase === 'stabilizing') {
      shutdownPhase = 'cleaning';
    }
    let cleanupOperation;
    try {
      cleanupOperation = stopLateOwnedEntry(entry);
    } catch (cleanupError) {
      cleanupOperation = Promise.reject(cleanupError);
    }
    const cleanupPromise = Promise.resolve(cleanupOperation)
      .catch((cleanupError) => {
        recordCleanupError(cleanupError);
      })
      .finally(() => {
        lateCleanupPromises.delete(cleanupPromise);
      });
    lateCleanupPromises.add(cleanupPromise);
    entry.lateCleanupPromise = cleanupPromise;
  }

  // 关停稳定屏障模块：等待动态清理集合，并跨过当前微任务队列确认没有连续晚登记。
  async function waitForLateEntryCleanup() {
    while (true) {
      if (lateCleanupPromises.size > 0) {
        shutdownPhase = 'cleaning';
        await Promise.all(Array.from(lateCleanupPromises));
        continue;
      }

      const observedGeneration = lateCleanupGeneration;
      shutdownPhase = 'stabilizing';
      const isStable = await new Promise((resolve) => {
        setImmediate(() => {
          const hasStableGeneration = lateCleanupGeneration === observedGeneration;
          const hasNoPendingCleanup = lateCleanupPromises.size === 0;
          if (hasStableGeneration && hasNoPendingCleanup) {
            shutdownPhase = 'finalizing';
          }
          resolve(hasStableGeneration && hasNoPendingCleanup);
        });
      });
      if (isStable) {
        return;
      }
    }
  }

  // 生命周期清理模块：首次调用关闭登记门禁并触发清理，后续调用复用同一 Promise。
  function requestShutdown(errorValue = null, requestedSignal = '') {
    if (errorValue && !fatalError) {
      fatalError = normalizeError(errorValue);
    }
    if (requestedSignal && !signalName) {
      signalName = requestedSignal;
    }
    shutdownStarted = true;
    if (shutdownPhase === 'running') {
      shutdownPhase = 'cleaning';
    }
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        try {
          await cleanupInitialOwnedEntries(entries);
        } catch (cleanupError) {
          recordCleanupError(cleanupError);
        }
        await waitForLateEntryCleanup();
        if (lateCleanupErrors.length > 0) {
          const cleanupMessage = lateCleanupErrors.map((cleanupError) => cleanupError.message).join('；');
          fatalError = fatalError
            ? new Error(`${fatalError.message}\n子进程清理失败：${cleanupMessage}`)
            : new Error(`子进程清理失败：${cleanupMessage}`);
        }
        const outcome = Object.freeze({ fatalError, signalName });
        shutdownPhase = 'settled';
        resolveStop(outcome);
        return outcome;
      })();
    }
    return shutdownPromise;
  }

  // 子进程登记模块：任何长期服务异常退出都会请求联动清理，关停后的晚登记会立即终止。
  function register(entry) {
    entry.registrationRejected = false;
    entry.lateCleanupPromise = null;
    entry.child.once('error', (error) => {
      entry.spawnError = error;
      if (!shutdownStarted) {
        requestShutdown(buildOwnedProcessSpawnError(entry, error));
      }
    });
    entry.child.once('exit', (exitCode, childSignal) => {
      entry.observedExitCode = exitCode;
      entry.observedSignal = childSignal || '';
      if (!shutdownStarted) {
        requestShutdown(buildOwnedProcessExitError(entry, exitCode, childSignal));
      }
    });
    if (shutdownStarted) {
      scheduleLateEntryCleanup(entry);
      return entry;
    }

    entries.push(entry);
    return entry;
  }

  // 生命周期断言模块：轮询及每次 spawn 前及时识别关停门禁、统一异常和指定子进程退出。
  function assertCanContinue(entry = null) {
    if (signalName) {
      throw new GracefulShutdownError(signalName);
    }
    if (fatalError) {
      throw fatalError;
    }
    if (shutdownStarted) {
      throw new GracefulShutdownError('关停请求');
    }
    if (entry?.spawnError) {
      throw buildOwnedProcessSpawnError(entry, entry.spawnError);
    }
    if (entry && !isOwnedProcessRunning(entry)) {
      throw buildOwnedProcessExitError(entry, entry.child.exitCode, entry.child.signalCode);
    }
  }

  return Object.freeze({ entries, stopPromise, requestShutdown, register, assertCanContinue });
}

// 前缀日志转发模块：stdout/stderr 各自保留跨 chunk 半行，并可同步交给 Tunnel URL 捕获器。
function attachPrefixedOutput(entry, onChunk = null) {
  // 输出流模块：保持 stdout/stderr 目标不变，不写日志文件。
  const streamConfigs = [
    { name: 'stdout', stream: entry.child.stdout, target: process.stdout },
    { name: 'stderr', stream: entry.child.stderr, target: process.stderr }
  ];
  for (const streamConfig of streamConfigs) {
    const lineBuffer = createPrefixedLineBuffer(`[${entry.key}] `, (text) => streamConfig.target.write(text));
    streamConfig.stream.on('data', (chunk) => {
      if (typeof onChunk === 'function') {
        onChunk(chunk, streamConfig.name);
      }
      lineBuffer.push(chunk);
    });
    streamConfig.stream.once('end', () => lineBuffer.flush());
  }
}

// 长期子进程启动模块：统一 cwd、shell=false、当前环境和管道输出。
function spawnOwnedProcess(lifecycle, processConfig) {
  // 关停门禁模块：任何 spawn 调用前都必须确认生命周期仍允许新增拥有进程。
  lifecycle.assertCanContinue();
  // 子进程模块：command/args 均由入口脚本构造，不拼接 shell 命令。
  const detachedGroup = process.platform !== 'win32';
  const child = spawn(processConfig.command, processConfig.args, {
    cwd: projectRoot,
    env: process.env,
    shell: false,
    detached: detachedGroup,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const entry = lifecycle.register({
    key: processConfig.key,
    label: processConfig.label,
    child,
    pid: child.pid || null,
    spawnError: null,
    detachedGroup,
    observedExitCode: null,
    observedSignal: ''
  });
  lifecycle.assertCanContinue(entry);
  attachPrefixedOutput(entry, processConfig.onChunk);
  return entry;
}

// 启动器请求错误模块：为自产生的请求失败附加稳定 name/code/项目错误码。
function createLauncherRequestError(options) {
  // 请求错误元数据模块：message 只供直接调用方理解，readiness 诊断仅投影稳定白名单字段。
  const requestError = new Error(options.message);
  requestError.name = options.name;
  requestError.code = options.code;
  requestError.projectCode = options.projectCode;
  return requestError;
}

// 请求超时错误模块：连接、响应头和完整响应体共用同一稳定错误码。
function createRequestTimeoutError(timeoutMs) {
  return createLauncherRequestError({
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
    projectCode: 'CHARCOAL_REQUEST_TIMEOUT',
    message: `请求完整响应超时（${timeoutMs}ms）。`
  });
}

// 响应体超限错误模块：正文和 Content-Length 两条路径统一为相同稳定错误码。
function createResponseTooLargeError(maxBytes) {
  return createLauncherRequestError({
    name: 'RangeError',
    code: 'ERR_RESPONSE_TOO_LARGE',
    projectCode: 'CHARCOAL_RESPONSE_TOO_LARGE',
    message: `响应体超过最大允许大小 ${maxBytes} 字节。`
  });
}

// 非法 HTTP 响应错误模块：缺少整数状态码时使用稳定错误码，不传播响应对象内容。
function createInvalidHttpResponseError() {
  return createLauncherRequestError({
    name: 'TypeError',
    code: 'ERR_INVALID_HTTP_RESPONSE',
    projectCode: 'CHARCOAL_INVALID_HTTP_RESPONSE',
    message: '请求未返回合法 HTTP 响应。'
  });
}

// 响应体读取模块：流式累计字节并在超限时取消读取，避免无限响应占用内存。
async function readResponseTextWithLimit(response, options) {
  const maxBytes = options.maxBytes;
  const contentLengthValue = response.headers?.get?.('content-length');
  if (contentLengthValue && /^\d+$/.test(contentLengthValue) && Number(contentLengthValue) > maxBytes) {
    options.abortController.abort();
    throw createResponseTooLargeError(maxBytes);
  }

  // Web Stream 模块：Node.js fetch 的响应体按 Uint8Array 分块读取并在结束后统一解码。
  if (response.body && typeof response.body.getReader === 'function') {
    const responseReader = response.body.getReader();
    options.setActiveReader(responseReader);
    const responseChunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const readResult = await responseReader.read();
        if (options.isTimedOut()) {
          throw createRequestTimeoutError(options.timeoutMs);
        }
        if (readResult.done) {
          break;
        }
        const chunkBuffer = Buffer.from(readResult.value);
        totalBytes += chunkBuffer.length;
        if (totalBytes > maxBytes) {
          options.abortController.abort();
          await responseReader.cancel('响应体超过最大允许大小。').catch(() => {});
          throw createResponseTooLargeError(maxBytes);
        }
        responseChunks.push(chunkBuffer);
      }
      return Buffer.concat(responseChunks, totalBytes).toString('utf8');
    } finally {
      options.setActiveReader(null);
      try {
        responseReader.releaseLock();
      } catch (error) {
        // 响应流可能已因超时或超限取消，释放失败不覆盖原始错误。
      }
    }
  }

  // 兼容响应模块：测试替身或旧实现没有 Web Stream 时仍执行读取后的字节上限检查。
  const responseText = typeof response.text === 'function' ? await response.text() : '';
  if (Buffer.byteLength(responseText, 'utf8') > maxBytes) {
    options.abortController.abort();
    throw createResponseTooLargeError(maxBytes);
  }
  return responseText;
}

// 有限 fetch 模块：同一超时覆盖连接、响应头与完整响应体，并禁止自动重定向。
async function fetchTextWithTimeout(url, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : singleRequestTimeoutMs;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : healthResponseMaxBytes;
  const fetchImplementation = typeof options.fetchImplementation === 'function'
    ? options.fetchImplementation
    : fetch;
  const abortController = new AbortController();
  let activeReader = null;
  let timedOut = false;
  let timeoutHandle = null;

  // 完整请求模块：只有响应体全部读取且未超限后才返回 status/text。
  const requestPromise = (async () => {
    const response = await fetchImplementation(url, {
      signal: abortController.signal,
      redirect: 'manual'
    });
    if (!response || !Number.isInteger(response.status)) {
      throw createInvalidHttpResponseError();
    }
    const text = await readResponseTextWithLimit(response, {
      maxBytes,
      timeoutMs,
      abortController,
      isTimedOut: () => timedOut,
      setActiveReader: (reader) => {
        activeReader = reader;
      }
    });
    if (timedOut) {
      throw createRequestTimeoutError(timeoutMs);
    }
    // 响应 Content-Type 模块：只返回规范化 media type，避免 header 参数和其他响应头进入诊断。
    const contentType = normalizeContentType(response.headers?.get?.('content-type'));
    return Object.freeze({ status: response.status, contentType, text });
  })();

  // 共享超时模块：触发时既中止 fetch，也取消正在等待的响应体 reader。
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      if (activeReader) {
        try {
          Promise.resolve(activeReader.cancel('请求完整响应超时。')).catch(() => {});
        } catch (error) {
          // reader 可能已在超时触发前结束，取消失败不影响超时结论。
        }
      }
      reject(createRequestTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw createRequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// 健康 JSON 请求模块：返回不含正文的结构化观察结果，并接受轮询传入的剩余请求预算。
async function requestHealthyJson(url, options = {}) {
  const response = await fetchTextWithTimeout(url, {
    maxBytes: healthResponseMaxBytes,
    timeoutMs: options.timeoutMs
  });
  return evaluateHealthyJsonResponse(response);
}

// cloudflared readiness 请求模块：回环 /ready 只有严格 HTTP 200 才返回就绪。
async function requestCloudflaredReady(url, options = {}) {
  const response = await fetchTextWithTimeout(url, {
    maxBytes: metricsResponseMaxBytes,
    timeoutMs: options.timeoutMs
  });
  return evaluateCloudflaredReadyResponse(response);
}

// Vite 页面请求模块：只接受页面自身 2xx，并接受轮询传入的剩余请求预算。
async function requestHealthyPage(url, options = {}) {
  const response = await fetchTextWithTimeout(url, {
    maxBytes: pageResponseMaxBytes,
    timeoutMs: options.timeoutMs
  });
  const isReady = response.status >= 200 && response.status < 300;
  return Object.freeze({
    ready: isReady,
    kind: isReady ? 'healthy' : 'http-status',
    status: response.status,
    contentType: response.contentType
  });
}

// 就绪观察标准化模块：只投影稳定分类、状态和规范 Content-Type，拒绝正文与任意自由字段。
function normalizeReadinessObservation(observationValue) {
  if (observationValue && typeof observationValue === 'object') {
    // 观察分类模块：未知 kind 收敛为 not-ready，不允许调用方注入任意诊断类型。
    const kind = readinessObservationKinds.has(observationValue.kind)
      ? observationValue.kind
      : 'not-ready';
    const status = Number.isInteger(observationValue.status) ? observationValue.status : null;
    const contentType = normalizeContentType(observationValue.contentType);
    return Object.freeze({
      ready: observationValue.ready === true,
      kind,
      status,
      contentType
    });
  }
  return Object.freeze({
    ready: observationValue === true,
    kind: observationValue === true ? 'ready' : 'not-ready',
    status: null,
    contentType: ''
  });
}

// 通用就绪轮询模块：使用绝对 deadline、剩余请求预算和结构化脱敏诊断报告超时。
async function waitForReadiness(options) {
  // 轮询依赖模块：生产环境使用真实时钟和固定节奏，测试可注入无等待实现。
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const wait = typeof options.delay === 'function' ? options.delay : delay;
  const intervalMs = Number.isInteger(options.pollingIntervalMs) && options.pollingIntervalMs >= 0
    ? options.pollingIntervalMs
    : pollingIntervalMs;
  const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : singleRequestTimeoutMs;
  // 绝对截止模块：所有请求、响应处理和轮询延时共用同一个总预算。
  const deadline = now() + options.timeoutMs;
  let lastObservation = Object.freeze({ ready: false, kind: 'not-ready' });
  while (now() < deadline) {
    options.lifecycle.assertCanContinue(options.entry);
    // 单次预算模块：每次请求不得超过单请求上限或当前剩余总预算。
    const remainingBeforeAttemptMs = deadline - now();
    if (remainingBeforeAttemptMs <= 0) {
      break;
    }
    const attemptTimeoutMs = Math.min(requestTimeoutMs, remainingBeforeAttemptMs);
    try {
      const attemptObservation = await options.attempt(Object.freeze({
        timeoutMs: attemptTimeoutMs,
        remainingMs: remainingBeforeAttemptMs,
        deadline
      }));
      options.lifecycle.assertCanContinue(options.entry);
      lastObservation = normalizeReadinessObservation(attemptObservation);
      if (now() >= deadline) {
        break;
      }
      if (lastObservation.ready) {
        return lastObservation;
      }
    } catch (error) {
      options.lifecycle.assertCanContinue(options.entry);
      lastObservation = createRequestErrorObservation(error);
      if (now() >= deadline) {
        break;
      }
    }
    // 轮询延时模块：延时不得超过剩余总预算，超出后由下一次 deadline 检查结束。
    const remainingBeforeDelayMs = deadline - now();
    if (remainingBeforeDelayMs <= 0) {
      break;
    }
    await wait(Math.min(intervalMs, remainingBeforeDelayMs));
    options.lifecycle.assertCanContinue(options.entry);
  }
  options.lifecycle.assertCanContinue(options.entry);
  // 超时错误模块：只拼接结构化白名单诊断，不传播 Error message、URL 或响应正文。
  const readinessError = new Error(
    `等待${options.label}超时，最后观察：${formatRedactedReadinessDiagnostic(lastObservation)}`
  );
  readinessError.projectCode = 'CHARCOAL_READINESS_TIMEOUT';
  throw readinessError;
}

// Metrics Tunnel 发现模块：优先消费日志结果，并用绝对 deadline 轮询受控回环 /quicktunnel。
async function waitForQuickTunnelOrigin(options) {
  // Origin 轮询依赖模块：生产使用真实 fetch/时钟，测试可注入稳定替身。
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const wait = typeof options.delay === 'function' ? options.delay : delay;
  const fetchText = typeof options.fetchText === 'function' ? options.fetchText : fetchTextWithTimeout;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : tunnelDiscoveryTimeoutMs;
  const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : singleRequestTimeoutMs;
  const intervalMs = Number.isInteger(options.pollingIntervalMs) && options.pollingIntervalMs >= 0
    ? options.pollingIntervalMs
    : pollingIntervalMs;
  // Origin 绝对截止模块：日志发现、metrics 请求和延时共享同一总预算。
  const deadline = now() + timeoutMs;
  let lastObservation = Object.freeze({ ready: false, kind: 'not-ready' });
  while (now() < deadline) {
    options.lifecycle.assertCanContinue(options.entry);
    const capturedOrigins = options.capture.getOrigins();
    if (capturedOrigins.length > 0) {
      if (now() >= deadline) {
        break;
      }
      return capturedOrigins[0];
    }
    try {
      // Origin 单次预算模块：metrics 请求不得超过 3 秒上限或当前剩余预算。
      const remainingBeforeRequestMs = deadline - now();
      if (remainingBeforeRequestMs <= 0) {
        break;
      }
      const response = await fetchText(options.metricsUrl, {
        maxBytes: metricsResponseMaxBytes,
        timeoutMs: Math.min(requestTimeoutMs, remainingBeforeRequestMs)
      });
      options.lifecycle.assertCanContinue(options.entry);
      lastObservation = Object.freeze({
        ready: false,
        kind: 'http-status',
        status: response.status,
        contentType: response.contentType
      });
      if (now() >= deadline) {
        break;
      }
      if (response.status >= 200 && response.status < 300) {
        const parsedOrigin = parseQuickTunnelMetricsPayload(response.text);
        if (now() >= deadline) {
          break;
        }
        return parsedOrigin;
      }
    } catch (error) {
      options.lifecycle.assertCanContinue(options.entry);
      lastObservation = createRequestErrorObservation(error);
      if (now() >= deadline) {
        break;
      }
    }
    // Origin 延时模块：不得睡过 deadline，截止后不会接受迟到的域名结果。
    const remainingBeforeDelayMs = deadline - now();
    if (remainingBeforeDelayMs <= 0) {
      break;
    }
    await wait(Math.min(intervalMs, remainingBeforeDelayMs));
    options.lifecycle.assertCanContinue(options.entry);
  }
  options.lifecycle.assertCanContinue(options.entry);
  // Origin 超时诊断模块：不拼接 metrics URL、响应正文或原始异常消息。
  const discoveryError = new Error(
    `等待 cloudflared Quick Tunnel 公网域名超时，最后观察：${formatRedactedReadinessDiagnostic(lastObservation)}`
  );
  discoveryError.projectCode = 'CHARCOAL_TUNNEL_ORIGIN_TIMEOUT';
  throw discoveryError;
}

// 平台信号列表模块：POSIX 增加挂断/退出信号，Windows 增加控制台 SIGBREAK。
function buildHandledSignalNames(targetPlatform = process.platform) {
  return targetPlatform === 'win32'
    ? Object.freeze(['SIGINT', 'SIGTERM', 'SIGBREAK'])
    : Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
}

// 进程事件安装模块：可处理信号、未捕获异常和拒绝统一触发幂等清理。
function installProcessHandlers(lifecycle) {
  // 信号处理模块：信号退出不报告为启动失败，但必须等待清理顺序完成。
  const signalHandlers = new Map();
  buildHandledSignalNames().forEach((signalName) => {
    const signalHandler = () => {
      console.log(`[launcher] 收到 ${signalName}，正在清理分享链路...`);
      lifecycle.requestShutdown(null, signalName).catch(() => {});
    };
    signalHandlers.set(signalName, signalHandler);
    process.on(signalName, signalHandler);
  });

  // 未捕获错误模块：保存首个真实错误并触发相同清理流程。
  const handleUncaughtException = (error) => {
    lifecycle.requestShutdown(normalizeError(error)).catch(() => {});
  };
  const handleUnhandledRejection = (reason) => {
    lifecycle.requestShutdown(normalizeError(reason)).catch(() => {});
  };

  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);

  // 事件卸载模块：启动器结束后恢复调用方原有进程事件环境。
  return () => {
    signalHandlers.forEach((signalHandler, signalName) => {
      process.removeListener(signalName, signalHandler);
    });
    process.removeListener('uncaughtException', handleUncaughtException);
    process.removeListener('unhandledRejection', handleUnhandledRejection);
  };
}

// 开发启动接线模块：以可注入步骤保证 Express、Vite、Tunnel 和分享门槛的严格顺序与短路。
async function runDevelopmentStartupSequence(options = {}) {
  // 启动步骤依赖模块：缺少任一关键步骤时立即失败，避免产生部分启动链路。
  const requiredStepNames = [
    'startExpress',
    'waitForExpress',
    'startVite',
    'waitForVitePage',
    'waitForViteProxy',
    'startTunnel',
    'waitForTunnel',
    'publishShare'
  ];
  requiredStepNames.forEach((stepName) => {
    if (typeof options[stepName] !== 'function') {
      throw new Error(`开发启动接线缺少必要步骤：${stepName}。`);
    }
  });

  // Express 阶段模块：后端未健康时不得启动 Vite。
  const expressEntry = await options.startExpress();
  await options.waitForExpress(expressEntry);
  // Vite 阶段模块：页面与同源代理必须依次通过，失败时不得启动 Tunnel。
  const viteEntry = await options.startVite(expressEntry);
  await options.waitForVitePage(viteEntry);
  await options.waitForViteProxy(viteEntry);
  // Tunnel 阶段模块：完整 Tunnel 三阶段通过前不得发布分享地址。
  const tunnelContext = await options.startTunnel(viteEntry);
  const shareUrls = await options.waitForTunnel(tunnelContext);
  await options.publishShare(shareUrls);
  return Object.freeze({ expressEntry, viteEntry, tunnelContext, shareUrls });
}

// 一键启动主模块：预检后依次启动 Express、Vite、Quick Tunnel，并等待联动退出。
async function runDevelopmentCloudflare() {
  // 运行环境模块：复用根 .env 集中加载，不读取、返回或打印密码。
  const runtimeEnvironment = loadRuntimeEnvironment();
  // Tunnel 协议模块：必须在端口检查和任何 spawn 前失败，且非法错误不回显原值。
  const tunnelTransportProtocol = normalizeTunnelTransportProtocol(process.env.TUNNEL_TRANSPORT_PROTOCOL);
  enforceTunnelApiBaseEnvironment(process.env);
  assertNoDefaultCloudflaredConfigConflict();
  if (runtimeEnvironment.backendPort === runtimeEnvironment.frontendPort) {
    throw new Error(`后端 PORT 不能与 Vite 固定端口 ${runtimeEnvironment.frontendPort} 相同。`);
  }

  // 端口预检模块：任何长期服务启动前确认后端和 Vite 端口当前可用。
  await assertPortAvailable(runtimeEnvironment.backendHost, runtimeEnvironment.backendPort, 'Express 端口');
  await assertPortAvailable(runtimeEnvironment.frontendHost, runtimeEnvironment.frontendPort, 'Vite 端口');
  // CLI 预检模块：cloudflared 缺失或显式路径错误时在启动服务前失败。
  const cloudflaredCli = await verifyCloudflaredCli();
  const viteCliPath = resolveViteCliPath();
  console.log(`[launcher] cloudflared 传输协议：${tunnelTransportProtocol}`);

  // 生命周期模块：从第一个长期进程开始接管信号、异常退出和清理。
  const lifecycle = createLifecycleController();
  const removeProcessHandlers = installProcessHandlers(lifecycle);
  try {
    // 完整启动接线模块：生产步骤通过同一可测试编排器串联，任一失败自动短路后续阶段。
    await runDevelopmentStartupSequence({
      // Express 启动模块：直接使用 process.execPath，复用当前环境和动态后端 PORT。
      startExpress: () => spawnOwnedProcess(lifecycle, {
        key: 'express',
        label: 'Express',
        command: process.execPath,
        args: [expressEntryPath]
      }),
      waitForExpress: async (expressEntry) => {
        await waitForReadiness({
          lifecycle,
          entry: expressEntry,
          timeoutMs: localHealthTimeoutMs,
          label: 'Express 健康检查',
          attempt: (attemptOptions) => requestHealthyJson(
            `${runtimeEnvironment.backendOrigin}/api/health`,
            attemptOptions
          )
        });
        lifecycle.assertCanContinue(expressEntry);
        console.log(`[launcher] Express 已就绪：${runtimeEnvironment.backendOrigin}`);
      },
      // Vite 启动模块：从 vite/package.json bin 解析 CLI，再由 process.execPath 直接执行。
      startVite: (expressEntry) => {
        lifecycle.assertCanContinue(expressEntry);
        return spawnOwnedProcess(lifecycle, {
          key: 'vite',
          label: 'Vite',
          command: process.execPath,
          args: [viteCliPath, '--config', viteConfigPath]
        });
      },
      waitForVitePage: (viteEntry) => waitForReadiness({
        lifecycle,
        entry: viteEntry,
        timeoutMs: localHealthTimeoutMs,
        label: 'Vite 页面',
        attempt: (attemptOptions) => requestHealthyPage(
          runtimeEnvironment.developmentOrigin,
          attemptOptions
        )
      }),
      waitForViteProxy: async (viteEntry) => {
        lifecycle.assertCanContinue(viteEntry);
        await waitForReadiness({
          lifecycle,
          entry: viteEntry,
          timeoutMs: localHealthTimeoutMs,
          label: 'Vite 同源代理健康检查',
          attempt: (attemptOptions) => requestHealthyJson(
            `${runtimeEnvironment.developmentOrigin}/api/health`,
            attemptOptions
          )
        });
        lifecycle.assertCanContinue(viteEntry);
        console.log(`[launcher] Vite 与同源 /api 代理已就绪：${runtimeEnvironment.developmentOrigin}`);
      },
      // Tunnel 启动模块：受控回环 metrics、完整 argv 和日志捕获一起形成后续三阶段上下文。
      startTunnel: async (viteEntry) => {
        const metricsPort = await findFreeLoopbackPort();
        lifecycle.assertCanContinue(viteEntry);
        const metricsOrigin = normalizeMetricsOrigin(`http://127.0.0.1:${metricsPort}`);
        const metricsUrl = buildQuickTunnelMetricsUrl(metricsOrigin);
        const tunnelCapture = createQuickTunnelLogCapture();
        const tunnelArguments = buildCloudflaredTunnelArguments({
          protocol: tunnelTransportProtocol,
          metricsOrigin,
          tunnelTargetOrigin: runtimeEnvironment.developmentOrigin,
          httpHostHeader: `${runtimeEnvironment.frontendHost}:${runtimeEnvironment.frontendPort}`
        });
        lifecycle.assertCanContinue(viteEntry);
        const tunnelEntry = spawnOwnedProcess(lifecycle, {
          key: 'tunnel',
          label: 'cloudflared Tunnel',
          command: cloudflaredCli.commandPath,
          args: tunnelArguments,
          onChunk: (chunk, source) => tunnelCapture.feed(chunk, source)
        });
        return Object.freeze({ tunnelEntry, metricsOrigin, metricsUrl, tunnelCapture });
      },
      // Tunnel 三阶段模块：Origin、Edge readiness、公网健康严格串行，任一失败立即短路。
      waitForTunnel: (tunnelContext) => runTunnelReadinessStages({
        metricsOrigin: tunnelContext.metricsOrigin,
        discoverOrigin: () => waitForQuickTunnelOrigin({
          lifecycle,
          entry: tunnelContext.tunnelEntry,
          capture: tunnelContext.tunnelCapture,
          metricsUrl: tunnelContext.metricsUrl
        }),
        waitForReady: (readyUrl) => waitForReadiness({
          lifecycle,
          entry: tunnelContext.tunnelEntry,
          timeoutMs: metricsReadyTimeoutMs,
          label: 'cloudflared Edge 连接 readiness',
          attempt: (attemptOptions) => requestCloudflaredReady(readyUrl, attemptOptions)
        }),
        waitForPublicHealth: (healthUrl) => waitForReadiness({
          lifecycle,
          entry: tunnelContext.tunnelEntry,
          timeoutMs: publicHealthTimeoutMs,
          label: '公网健康检查',
          attempt: (attemptOptions) => requestHealthyJson(healthUrl, attemptOptions)
        }),
        onStage: (stageName) => {
          // 阶段日志模块：正式分享前不输出随机 Quick Tunnel 域名或公网 URL。
          const stageMessages = {
            'origin-discovered': '[launcher] 公网域名已发现，正在等待 Edge 连接就绪...',
            'edge-ready': '[launcher] Edge 连接已就绪，正在验证公网健康链路...',
            'public-ready': '[launcher] 公网链路已就绪，准备输出分享地址...'
          };
          console.log(stageMessages[stageName]);
        }
      }),
      // 分享发布模块：只有完整 Tunnel 三阶段返回后才输出随机公网地址。
      publishShare: async (shareUrls) => {
        console.log(`[share] 公网 Origin：${shareUrls.origin}`);
        console.log(`[share] 完整分享 URL：${shareUrls.shareUrl}`);
        console.log(`[share] 公网健康地址：${shareUrls.healthUrl}`);
        console.log('[share] 公网链路已就绪');
      }
    });

    // 常驻等待模块：就绪后等待用户信号或任一长期子进程退出。
    const outcome = await lifecycle.stopPromise;
    if (outcome.fatalError) {
      throw outcome.fatalError;
    }
    return outcome;
  } catch (error) {
    if (error instanceof GracefulShutdownError) {
      const outcome = await lifecycle.requestShutdown(null, error.signalName);
      return outcome;
    }
    const outcome = await lifecycle.requestShutdown(error);
    throw outcome.fatalError || normalizeError(error);
  } finally {
    removeProcessHandlers();
  }
}

// CLI 入口模块：作为脚本执行时设置退出码，作为模块加载时不自动启动服务。
if (require.main === module) {
  runDevelopmentCloudflare().catch((error) => {
    console.error(`[launcher] 启动失败：${normalizeError(error).message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  enforceTunnelApiBaseEnvironment,
  resolveCloudflaredCommand,
  verifyCloudflaredCli,
  buildDefaultCloudflaredConfigCandidates,
  findDefaultCloudflaredConfigConflicts,
  assertNoDefaultCloudflaredConfigConflict,
  createLifecycleController,
  runDevelopmentStartupSequence,
  fetchTextWithTimeout,
  waitForReadiness,
  waitForQuickTunnelOrigin,
  buildHandledSignalNames
};
