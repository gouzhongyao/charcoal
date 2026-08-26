const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
  validateTunnelApiBase,
  normalizeTunnelTransportProtocol,
  buildCloudflaredTunnelArguments,
  normalizeQuickTunnelOrigin,
  createQuickTunnelLogCapture,
  parseQuickTunnelMetricsPayload,
  normalizeMetricsOrigin,
  buildQuickTunnelMetricsUrl,
  buildCloudflaredReadyUrl,
  buildShareUrls,
  isHealthyJsonResponse,
  normalizeContentType,
  isJsonContentType,
  evaluateHealthyJsonResponse,
  evaluateCloudflaredReadyResponse,
  extractSafeErrorMetadata,
  createRequestErrorObservation,
  formatRedactedReadinessDiagnostic,
  runTunnelReadinessStages,
  createPrefixedLineBuffer,
  sortOwnedProcessEntries
} = require('../dev-cloudflare-core');
const launcherModule = require('../dev-cloudflare');
const {
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
} = launcherModule;

// 启动器导出边界测试模块：仅保留纯逻辑测试和生命周期竞态测试必需入口。
function testLauncherModuleExports() {
  assert.deepStrictEqual(Object.keys(launcherModule).sort(), [
    'assertNoDefaultCloudflaredConfigConflict',
    'buildDefaultCloudflaredConfigCandidates',
    'buildHandledSignalNames',
    'createLifecycleController',
    'enforceTunnelApiBaseEnvironment',
    'fetchTextWithTimeout',
    'findDefaultCloudflaredConfigConflicts',
    'resolveCloudflaredCommand',
    'runDevelopmentStartupSequence',
    'verifyCloudflaredCli',
    'waitForQuickTunnelOrigin',
    'waitForReadiness'
  ]);
}

// 环境模板静态契约测试模块：三个关键变量必须各赋值一次，并由 dotenv 解析为安全默认值。
function testEnvironmentExampleSecurityContract() {
  // 环境模板路径模块：只读取可提交模板，不访问被忽略的本机 .env。
  const environmentExamplePath = path.resolve(__dirname, '..', '..', '.env.example');
  const environmentExampleText = fs.readFileSync(environmentExamplePath, 'utf8');
  // 环境模板解析模块：复用项目现有 dotenv 语义验证最终值，不自行重写解析规则。
  const parsedEnvironmentExample = dotenv.parse(environmentExampleText);
  // 关键变量契约模块：管理员密码为空，Tunnel 默认 auto，前端 API 保持同源 /api。
  const expectedEnvironmentValues = Object.freeze({
    CHARCOAL_ADMIN_PASSWORD: '',
    TUNNEL_TRANSPORT_PROTOCOL: 'auto',
    VITE_API_BASE_URL: '/api'
  });
  Object.entries(expectedEnvironmentValues).forEach(([environmentKey, expectedValue]) => {
    // 语义赋值计数模块：忽略注释，只接受可被 dotenv 识别的可选 export 和等号赋值行。
    const escapedEnvironmentKey = environmentKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const assignmentPattern = new RegExp(`^\\s*(?:export\\s+)?${escapedEnvironmentKey}\\s*=`, 'u');
    const assignmentCount = environmentExampleText
      .split(/\r?\n/u)
      .filter((lineText) => assignmentPattern.test(lineText))
      .length;
    assert.strictEqual(assignmentCount, 1, `${environmentKey} 必须且只能赋值一次。`);
    assert.strictEqual(parsedEnvironmentExample[environmentKey], expectedValue);
  });
}

// API Base 测试模块：Tunnel 模式只允许同源 /api 的空白或等价形式。
function testTunnelApiBaseValidation() {
  const acceptedCases = [undefined, null, '', '   ', '/api', ' /api ', '/api/', ' /api/ '];
  acceptedCases.forEach((value) => {
    assert.strictEqual(validateTunnelApiBase(value), '/api');
  });

  const rejectedCases = ['/', '/API', '/api/v1', '/api?x=1', '//example.com/api', 'https://example.com/api', 'http://127.0.0.1:3002/api'];
  rejectedCases.forEach((value) => {
    assert.throws(() => validateTunnelApiBase(value), /只能留空或设置为 \/api/);
  });
}

// API Base 环境覆盖测试模块：主变量和兼容别名都先严格校验，再统一写成同源 /api。
function testTunnelApiBaseEnvironmentEnforcement() {
  const acceptedEnvironment = {
    VITE_API_BASE_URL: ' /api/ ',
    VITE_API_BASE: '   '
  };
  assert.strictEqual(enforceTunnelApiBaseEnvironment(acceptedEnvironment), '/api');
  assert.deepStrictEqual(acceptedEnvironment, {
    VITE_API_BASE_URL: '/api',
    VITE_API_BASE: '/api'
  });

  assert.throws(() => enforceTunnelApiBaseEnvironment({
    VITE_API_BASE_URL: 'https://external.example.com/api',
    VITE_API_BASE: '/api'
  }), /只能留空或设置为 \/api/);
  assert.throws(() => enforceTunnelApiBaseEnvironment({
    VITE_API_BASE_URL: '/api',
    VITE_API_BASE: '//external.example.com/api'
  }), /只能留空或设置为 \/api/);
}

// Tunnel 传输协议测试模块：空值默认 auto，合法值规范化，非法值不得回显原始内容。
function testTunnelTransportProtocolValidation() {
  [undefined, null, '', '   '].forEach((value) => {
    assert.strictEqual(normalizeTunnelTransportProtocol(value), 'auto');
  });
  assert.strictEqual(normalizeTunnelTransportProtocol('auto'), 'auto');
  assert.strictEqual(normalizeTunnelTransportProtocol(' quic '), 'quic');
  assert.strictEqual(normalizeTunnelTransportProtocol('http2'), 'http2');

  ['AUTO', 'HTTP2'].forEach((invalidCaseVariant) => {
    assert.throws(
      () => normalizeTunnelTransportProtocol(invalidCaseVariant),
      (error) => !error.message.includes(invalidCaseVariant)
    );
  });
  const sensitiveInvalidProtocol = 'secret-invalid-protocol-value';
  assert.throws(
    () => normalizeTunnelTransportProtocol(sensitiveInvalidProtocol),
    (error) => error.message.includes('auto、quic 或 http2')
      && error.projectCode === 'CHARCOAL_TUNNEL_PROTOCOL_INVALID'
      && !error.message.includes(sensitiveInvalidProtocol)
  );
}

// cloudflared 完整 argv 测试模块：受控参数必须显式且仅包含一组 --protocol。
function testCloudflaredTunnelArguments() {
  const tunnelArguments = buildCloudflaredTunnelArguments({
    protocol: 'http2',
    metricsOrigin: 'http://127.0.0.1:49321',
    tunnelTargetOrigin: 'http://127.0.0.1:7777',
    httpHostHeader: '127.0.0.1:7777'
  });
  assert.deepStrictEqual(tunnelArguments, [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--protocol',
    'http2',
    '--metrics',
    '127.0.0.1:49321',
    '--url',
    'http://127.0.0.1:7777',
    '--http-host-header',
    '127.0.0.1:7777'
  ]);
  assert.strictEqual(tunnelArguments.filter((argument) => argument === '--protocol').length, 1);
  assert.strictEqual(tunnelArguments[tunnelArguments.indexOf('--protocol') + 1], 'http2');
  assert.throws(() => buildCloudflaredTunnelArguments({
    protocol: 'auto',
    metricsOrigin: 'http://127.0.0.1:49321',
    tunnelTargetOrigin: 'https://external.example.com',
    httpHostHeader: 'external.example.com'
  }), /只能使用 http|回环主机/);
  assert.throws(() => buildCloudflaredTunnelArguments({
    protocol: 'quic',
    metricsOrigin: 'http://127.0.0.1:49321',
    tunnelTargetOrigin: 'http://127.0.0.1:7777',
    httpHostHeader: 'localhost:7777'
  }), /必须与受控回环目标一致/);
}

// cloudflared 命令解析测试模块：显式配置必须是平台绝对路径，空值才允许使用 PATH。
function testCloudflaredCommandResolution() {
  assert.deepStrictEqual(resolveCloudflaredCommand(undefined, 'win32'), {
    commandPath: 'cloudflared',
    configured: false
  });
  assert.deepStrictEqual(resolveCloudflaredCommand('   ', 'linux'), {
    commandPath: 'cloudflared',
    configured: false
  });
  assert.deepStrictEqual(resolveCloudflaredCommand(
    ' C:\\Program Files\\cloudflared\\cloudflared.exe ',
    'win32'
  ), {
    commandPath: 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    configured: true
  });
  assert.deepStrictEqual(resolveCloudflaredCommand(
    '\\\\server\\tools\\cloudflared.exe',
    'win32'
  ), {
    commandPath: '\\\\server\\tools\\cloudflared.exe',
    configured: true
  });
  assert.deepStrictEqual(resolveCloudflaredCommand('/usr/local/bin/cloudflared', 'linux'), {
    commandPath: '/usr/local/bin/cloudflared',
    configured: true
  });
  assert.deepStrictEqual(resolveCloudflaredCommand('/opt/cloudflared', 'darwin'), {
    commandPath: '/opt/cloudflared',
    configured: true
  });

  const invalidWindowsPaths = [
    'cloudflared.exe',
    '.\\cloudflared.exe',
    '..\\tools\\cloudflared.exe',
    'C:tools\\cloudflared.exe',
    '\\tools\\cloudflared.exe',
    '/tools/cloudflared.exe'
  ];
  invalidWindowsPaths.forEach((configuredPath) => {
    assert.throws(
      () => resolveCloudflaredCommand(configuredPath, 'win32'),
      /必须填写当前平台可识别的 cloudflared 可执行文件完整绝对路径/
    );
  });

  const invalidPosixPaths = [
    'cloudflared',
    './cloudflared',
    '../bin/cloudflared',
    'C:\\tools\\cloudflared.exe'
  ];
  invalidPosixPaths.forEach((configuredPath) => {
    assert.throws(
      () => resolveCloudflaredCommand(configuredPath, 'linux'),
      /如需从 PATH 查找 cloudflared，请将 CLOUDFLARED_BIN 留空/
    );
  });

  const sensitiveRelativePath = 'private-relative-location/cloudflared';
  assert.throws(
    () => resolveCloudflaredCommand(sensitiveRelativePath, 'linux'),
    (error) => error.message.includes('完整绝对路径')
      && error.message.includes('前后端服务尚未启动')
      && !error.message.includes(sensitiveRelativePath)
  );
}

// cloudflared 预检脱敏断言模块：验证错误保留稳定诊断，同时移除路径、主机、共享名和原始进程消息。
async function assertCloudflaredPreflightFailureIsRedacted(testCase) {
  let versionCommandCallCount = 0;
  await assert.rejects(
    () => verifyCloudflaredCli({
      configuredValue: testCase.configuredValue,
      targetPlatform: testCase.targetPlatform,
      versionCommandRunner: async (commandPath) => {
        versionCommandCallCount += 1;
        assert.strictEqual(commandPath, testCase.expectedCommandPath);
        return testCase.runVersion(commandPath);
      },
      logVersion: () => {
        throw new Error('预检失败时不应输出版本成功日志。');
      }
    }),
    (error) => testCase.expectedMessage.test(error.message)
      && error.message.includes('前后端服务尚未启动')
      && testCase.forbiddenValues.every((forbiddenValue) => !error.message.includes(forbiddenValue))
  );
  assert.strictEqual(versionCommandCallCount, 1, '预检失败后不得回退或重试其他 cloudflared 候选。');
}

// cloudflared 预检脱敏测试模块：通过注入版本执行器覆盖启动失败、超时、非零退出、输出不匹配和 PATH 缺失。
async function testCloudflaredPreflightFailureRedaction() {
  const sensitiveWindowsUncPath = '\\\\secret-host\\private-share\\cloudflared.exe';
  const windowsSpawnError = new Error(`spawn ${sensitiveWindowsUncPath} ENOENT raw-spawn-secret`);
  windowsSpawnError.code = 'ENOENT';
  await assertCloudflaredPreflightFailureIsRedacted({
    configuredValue: sensitiveWindowsUncPath,
    targetPlatform: 'win32',
    expectedCommandPath: sensitiveWindowsUncPath,
    runVersion: async () => Promise.reject(windowsSpawnError),
    expectedMessage: /无法启动显式配置的 cloudflared 可执行文件/,
    forbiddenValues: [sensitiveWindowsUncPath, 'secret-host', 'private-share', 'raw-spawn-secret']
  });

  const sensitivePosixPath = '/srv/private-user/bin/cloudflared';
  const posixTimeoutError = new Error(`执行 ${sensitivePosixPath} --version timed out raw-timeout-secret`);
  posixTimeoutError.code = 'ETIMEDOUT';
  await assertCloudflaredPreflightFailureIsRedacted({
    configuredValue: sensitivePosixPath,
    targetPlatform: 'linux',
    expectedCommandPath: sensitivePosixPath,
    runVersion: async () => Promise.reject(posixTimeoutError),
    expectedMessage: /显式配置的 cloudflared --version 预检超时/,
    forbiddenValues: [sensitivePosixPath, 'private-user', 'raw-timeout-secret']
  });

  const sensitiveWindowsDrivePath = 'C:\\Users\\Sensitive-Account\\tools\\cloudflared.exe';
  const windowsExitError = new Error(`stderr disclosed ${sensitiveWindowsDrivePath} raw-exit-secret`);
  windowsExitError.exitCode = 7;
  await assertCloudflaredPreflightFailureIsRedacted({
    configuredValue: sensitiveWindowsDrivePath,
    targetPlatform: 'win32',
    expectedCommandPath: sensitiveWindowsDrivePath,
    runVersion: async () => Promise.reject(windowsExitError),
    expectedMessage: /显式配置的 cloudflared --version 返回非零退出状态/,
    forbiddenValues: [sensitiveWindowsDrivePath, 'Sensitive-Account', 'raw-exit-secret']
  });

  const sensitiveOutputPath = '/home/private-account/cloudflared';
  await assertCloudflaredPreflightFailureIsRedacted({
    configuredValue: sensitiveOutputPath,
    targetPlatform: 'linux',
    expectedCommandPath: sensitiveOutputPath,
    runVersion: async () => `unexpected output ${sensitiveOutputPath} raw-output-secret`,
    expectedMessage: /版本输出未识别为官方 cloudflared/,
    forbiddenValues: [sensitiveOutputPath, 'private-account', 'raw-output-secret']
  });

  const pathMissingError = new Error('spawn cloudflared ENOENT raw-path-spawn-message');
  pathMissingError.code = 'ENOENT';
  await assertCloudflaredPreflightFailureIsRedacted({
    configuredValue: '',
    targetPlatform: 'win32',
    expectedCommandPath: 'cloudflared',
    runVersion: async () => Promise.reject(pathMissingError),
    expectedMessage: /PATH 中未找到 cloudflared 命令/,
    forbiddenValues: ['raw-path-spawn-message', 'spawn cloudflared ENOENT']
  });
}

// Quick Tunnel Origin 测试模块：接受官方合法子域并拒绝所有越界 URL 组成。
function testQuickTunnelOriginValidation() {
  assert.strictEqual(
    normalizeQuickTunnelOrigin(' https://Alpha-1.trycloudflare.com '),
    'https://alpha-1.trycloudflare.com'
  );
  assert.strictEqual(
    normalizeQuickTunnelOrigin('https://one.two.trycloudflare.com/'),
    'https://one.two.trycloudflare.com'
  );

  const rejectedCases = [
    'http://alpha.trycloudflare.com',
    'https://trycloudflare.com',
    'https://alpha.example.com',
    'https://user@alpha.trycloudflare.com',
    'https://user:pass@alpha.trycloudflare.com',
    'https://alpha.trycloudflare.com:443',
    'https://alpha.trycloudflare.com:8443',
    'https://alpha.trycloudflare.com/path',
    'https://alpha.trycloudflare.com/.',
    'https://alpha.trycloudflare.com/..',
    'https://alpha.trycloudflare.com/a/..',
    'https://alpha.trycloudflare.com/%2e',
    'https://alpha.trycloudflare.com/%2e%2e',
    'https://alpha.trycloudflare.com\\path',
    'https:\\alpha.trycloudflare.com',
    'https://alpha.trycloudflare.com/?x=1',
    'https://alpha.trycloudflare.com/#fragment',
    'https://-alpha.trycloudflare.com',
    'https://alpha-.trycloudflare.com',
    'https://alpha..trycloudflare.com',
    'not-a-url'
  ];
  rejectedCases.forEach((value) => {
    assert.throws(() => normalizeQuickTunnelOrigin(value));
  });
}

// 日志捕获测试模块：覆盖完整 URL、跨 chunk、stdout/stderr 和同域名去重。
function testQuickTunnelLogCapture() {
  const callbackResults = [];
  const capture = createQuickTunnelLogCapture({
    onOrigin: (result) => callbackResults.push(result)
  });

  const stdoutResults = capture.feed('INF Your quick Tunnel has been created! (https://first-one.trycloudflare.com)\n', 'stdout');
  assert.deepStrictEqual(stdoutResults, [{ origin: 'https://first-one.trycloudflare.com', source: 'stdout' }]);
  assert.deepStrictEqual(capture.feed('duplicate https://first-one.trycloudflare.com\n', 'stderr'), []);

  assert.deepStrictEqual(capture.feed('INF https://cross-chunk.trycloud', 'stderr'), []);
  const crossChunkResults = capture.feed('flare.com\r\n', 'stderr');
  assert.deepStrictEqual(crossChunkResults, [{ origin: 'https://cross-chunk.trycloudflare.com', source: 'stderr' }]);

  assert.deepStrictEqual(capture.feed('partial https://must-not-cross.trycloud', 'stdout'), []);
  const independentStreamResults = capture.feed('https://stderr-only.trycloudflare.com\n', 'stderr');
  assert.deepStrictEqual(independentStreamResults, [{ origin: 'https://stderr-only.trycloudflare.com', source: 'stderr' }]);

  assert.deepStrictEqual(capture.feed('reject https://outside.example.com and https://user@bad.trycloudflare.com\n', 'stdout'), []);
  assert.deepStrictEqual(capture.getOrigins(), [
    'https://first-one.trycloudflare.com',
    'https://cross-chunk.trycloudflare.com',
    'https://stderr-only.trycloudflare.com'
  ]);
  assert.deepStrictEqual(callbackResults, [
    { origin: 'https://first-one.trycloudflare.com', source: 'stdout' },
    { origin: 'https://cross-chunk.trycloudflare.com', source: 'stderr' },
    { origin: 'https://stderr-only.trycloudflare.com', source: 'stderr' }
  ]);

  const pathBoundaryCapture = createQuickTunnelLogCapture();
  assert.deepStrictEqual(pathBoundaryCapture.feed('https://path-boundary.trycloudflare.com', 'stdout'), []);
  assert.deepStrictEqual(pathBoundaryCapture.feed('/not-root\n', 'stdout'), []);
  [
    '/.', '/..', '/a/..', '/%2e', '/%2e%2e', '\\path', '/.。', '/...', '/%2e.'
  ].forEach((remainder) => {
    assert.deepStrictEqual(
      pathBoundaryCapture.feed(`reject https://log-path.trycloudflare.com${remainder}\n`, 'stdout'),
      []
    );
  });

  const sentencePunctuationCapture = createQuickTunnelLogCapture();
  assert.deepStrictEqual(
    sentencePunctuationCapture.feed('ready https://english-period.trycloudflare.com.\n', 'stdout'),
    [{ origin: 'https://english-period.trycloudflare.com', source: 'stdout' }]
  );
  assert.deepStrictEqual(
    sentencePunctuationCapture.feed('就绪 https://chinese-period.trycloudflare.com。\n', 'stderr'),
    [{ origin: 'https://chinese-period.trycloudflare.com', source: 'stderr' }]
  );
  assert.deepStrictEqual(
    sentencePunctuationCapture.feed('ready https://split-period.trycloudflare.com', 'stdout'),
    []
  );
  assert.deepStrictEqual(
    sentencePunctuationCapture.feed('.\n', 'stdout'),
    [{ origin: 'https://split-period.trycloudflare.com', source: 'stdout' }]
  );

  const dangerousCrossChunkCapture = createQuickTunnelLogCapture();
  assert.deepStrictEqual(dangerousCrossChunkCapture.feed('reject https://split-path.trycloudflare.com', 'stdout'), []);
  assert.deepStrictEqual(dangerousCrossChunkCapture.feed('/.', 'stdout'), []);
  assert.deepStrictEqual(dangerousCrossChunkCapture.feed('\n', 'stdout'), []);
  assert.deepStrictEqual(dangerousCrossChunkCapture.feed('reject https://split-encoded.trycloudflare.com/%2', 'stderr'), []);
  assert.deepStrictEqual(dangerousCrossChunkCapture.feed('e。\n', 'stderr'), []);
  assert.deepStrictEqual(dangerousCrossChunkCapture.getOrigins(), []);
}

// Metrics 地址测试模块：只允许显式端口的 HTTP 回环地址，阻断外部主机 SSRF。
function testMetricsOriginValidation() {
  assert.strictEqual(normalizeMetricsOrigin('http://127.0.0.1:49321'), 'http://127.0.0.1:49321');
  assert.strictEqual(normalizeMetricsOrigin('http://127.10.20.30:80/'), 'http://127.10.20.30:80');
  assert.strictEqual(normalizeMetricsOrigin('http://localhost:9090'), 'http://localhost:9090');
  assert.strictEqual(normalizeMetricsOrigin('http://[::1]:8080'), 'http://[::1]:8080');
  assert.strictEqual(buildQuickTunnelMetricsUrl('http://127.0.0.1:49321'), 'http://127.0.0.1:49321/quicktunnel');
  assert.strictEqual(buildCloudflaredReadyUrl('http://127.0.0.1:49321'), 'http://127.0.0.1:49321/ready');

  const rejectedCases = [
    'https://127.0.0.1:49321',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://192.168.1.10:49321',
    'http://2130706433:49321',
    'http://0x7f000001:49321',
    'http://127.1:49321',
    'http://example.com:49321',
    'http://user@127.0.0.1:49321',
    'http://127.0.0.1:49321/metrics',
    'http://127.0.0.1:49321?target=external',
    'not-a-url'
  ];
  rejectedCases.forEach((value) => {
    assert.throws(() => normalizeMetricsOrigin(value));
    assert.throws(() => buildCloudflaredReadyUrl(value));
  });
}

// /quicktunnel JSON 测试模块：hostname/url 都要经过严格校验且双字段必须一致。
function testQuickTunnelMetricsPayload() {
  assert.strictEqual(
    parseQuickTunnelMetricsPayload('{"hostname":"metrics-host.trycloudflare.com"}'),
    'https://metrics-host.trycloudflare.com'
  );
  assert.strictEqual(
    parseQuickTunnelMetricsPayload({ hostname: 'https://metrics-origin.trycloudflare.com' }),
    'https://metrics-origin.trycloudflare.com'
  );
  assert.strictEqual(
    parseQuickTunnelMetricsPayload({ url: 'https://metrics-url.trycloudflare.com/' }),
    'https://metrics-url.trycloudflare.com'
  );
  assert.strictEqual(
    parseQuickTunnelMetricsPayload({
      hostname: 'same-host.trycloudflare.com',
      url: 'https://same-host.trycloudflare.com'
    }),
    'https://same-host.trycloudflare.com'
  );

  assert.throws(() => parseQuickTunnelMetricsPayload('{}'), /缺少 hostname 或 url/);
  assert.throws(() => parseQuickTunnelMetricsPayload('not-json'), /合法 JSON/);
  assert.throws(() => parseQuickTunnelMetricsPayload({ hostname: 'outside.example.com' }));
  assert.throws(() => parseQuickTunnelMetricsPayload({ url: 'https://user@bad.trycloudflare.com' }));
  assert.throws(() => parseQuickTunnelMetricsPayload({ url: 'https://bad.trycloudflare.com/path' }));
  assert.throws(() => parseQuickTunnelMetricsPayload({
    hostname: 'one.trycloudflare.com',
    url: 'https://two.trycloudflare.com'
  }), /不一致/);
}

// 分享地址测试模块：分享查询和健康路径必须固定为同源 /api。
function testShareUrlGeneration() {
  assert.deepStrictEqual(buildShareUrls('https://share-host.trycloudflare.com'), {
    origin: 'https://share-host.trycloudflare.com',
    shareUrl: 'https://share-host.trycloudflare.com/?apiBase=%2Fapi',
    healthUrl: 'https://share-host.trycloudflare.com/api/health'
  });
}

// 健康响应测试模块：只接受 2xx 和现有 success/data.status 契约。
function testHealthyJsonResponse() {
  assert.strictEqual(isHealthyJsonResponse(200, { success: true, data: { status: 'ok' } }), true);
  assert.strictEqual(isHealthyJsonResponse(299, { success: true, data: { status: 'ok' } }), true);
  assert.strictEqual(isHealthyJsonResponse(300, { success: true, data: { status: 'ok' } }), false);
  assert.strictEqual(isHealthyJsonResponse(200, { success: false, data: { status: 'ok' } }), false);
  assert.strictEqual(isHealthyJsonResponse(200, { success: true, data: { status: 'down' } }), false);
  assert.strictEqual(isHealthyJsonResponse(200, { success: true }), false);
  assert.strictEqual(isHealthyJsonResponse('200', { success: true, data: { status: 'ok' } }), false);
}

// Content-Type 与结构化健康响应测试模块：覆盖状态、类型、JSON 解析和健康契约分类。
function testStructuredHealthResponseEvaluation() {
  assert.strictEqual(normalizeContentType(' Application/JSON ; charset=UTF-8 '), 'application/json');
  assert.strictEqual(normalizeContentType('text/html; charset=utf-8'), 'text/html');
  assert.strictEqual(normalizeContentType('invalid secret content type'), '');
  assert.strictEqual(isJsonContentType('application/json; charset=utf-8'), true);
  assert.strictEqual(isJsonContentType('application/problem+json'), true);
  assert.strictEqual(isJsonContentType('text/json'), false);

  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    text: '{"success":true,"data":{"status":"ok"}}'
  }), {
    ready: true,
    kind: 'healthy',
    status: 200,
    contentType: 'application/json'
  });
  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 530,
    contentType: 'text/html',
    text: 'secret-530-body'
  }), {
    ready: false,
    kind: 'http-status',
    status: 530,
    contentType: 'text/html'
  });
  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 502,
    contentType: 'application/json',
    text: '{"secret":"must-not-leak"}'
  }), {
    ready: false,
    kind: 'http-status',
    status: 502,
    contentType: 'application/json'
  });
  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    text: '{"success":true,"data":{"status":"ok"}}'
  }), {
    ready: false,
    kind: 'content-type',
    status: 200,
    contentType: 'text/html'
  });
  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 200,
    contentType: 'application/json',
    text: '{not-valid-json secret-body}'
  }), {
    ready: false,
    kind: 'invalid-json',
    status: 200,
    contentType: 'application/json'
  });
  assert.deepStrictEqual(evaluateHealthyJsonResponse({
    status: 200,
    contentType: 'application/json',
    text: '{"success":true,"data":{"status":"down"},"secret":"hidden"}'
  }), {
    ready: false,
    kind: 'contract-mismatch',
    status: 200,
    contentType: 'application/json'
  });

  assert.deepStrictEqual(evaluateCloudflaredReadyResponse({ status: 200, contentType: 'text/plain' }), {
    ready: true,
    kind: 'ready',
    status: 200,
    contentType: 'text/plain'
  });
  [199, 201, 204, 503, 530].forEach((status) => {
    const readinessObservation = evaluateCloudflaredReadyResponse({ status, contentType: 'text/plain' });
    assert.strictEqual(readinessObservation.ready, false);
    assert.strictEqual(readinessObservation.kind, 'http-status');
    assert.strictEqual(readinessObservation.status, status);
  });
}

// 安全诊断测试模块：仅保留 Error/cause 名称和错误码，并保护循环、深度与敏感自由文本。
function testRedactedDiagnosticMetadata() {
  const rootError = new Error('root-message secret-root https://hidden.example.com 10.0.0.1');
  rootError.name = 'TypeError';
  rootError.code = 'UND_ERR_CONNECT_TIMEOUT';
  rootError.stack = 'secret-stack';
  rootError.url = 'https://random.trycloudflare.com/api/health';
  rootError.headers = { authorization: 'Bearer secret-token' };
  const causeError = new Error('cause-message secret-cause socket=127.0.0.1');
  causeError.name = 'ConnectTimeoutError';
  causeError.code = 'ETIMEDOUT';
  causeError.projectCode = 'CHARCOAL_REQUEST_TIMEOUT';
  rootError.cause = causeError;
  causeError.cause = rootError;

  assert.deepStrictEqual(extractSafeErrorMetadata(rootError), [
    { name: 'TypeError', code: 'UND_ERR_CONNECT_TIMEOUT' },
    { name: 'ConnectTimeoutError', code: 'ETIMEDOUT', projectCode: 'CHARCOAL_REQUEST_TIMEOUT' }
  ]);
  const requestObservation = createRequestErrorObservation(rootError);
  const diagnostic = formatRedactedReadinessDiagnostic(requestObservation);
  assert.match(diagnostic, /TypeError\/UND_ERR_CONNECT_TIMEOUT/);
  assert.match(diagnostic, /ConnectTimeoutError\/ETIMEDOUT\/CHARCOAL_REQUEST_TIMEOUT/);
  [
    'root-message',
    'secret-root',
    'hidden.example.com',
    '10.0.0.1',
    'secret-stack',
    'random.trycloudflare.com',
    'authorization',
    'secret-token',
    'cause-message',
    'secret-cause',
    '127.0.0.1'
  ].forEach((forbiddenValue) => {
    assert.strictEqual(JSON.stringify(requestObservation).includes(forbiddenValue), false);
    assert.strictEqual(diagnostic.includes(forbiddenValue), false);
  });

  const deepErrorOne = Object.assign(new Error('one'), { name: 'ErrorOne', code: 'EONE' });
  const deepErrorTwo = Object.assign(new Error('two'), { name: 'ErrorTwo', code: 'ETWO' });
  const deepErrorThree = Object.assign(new Error('three'), { name: 'ErrorThree', code: 'ETHREE' });
  const deepErrorFour = Object.assign(new Error('four'), { name: 'ErrorFour', code: 'EFOUR' });
  const deepErrorFive = Object.assign(new Error('five'), { name: 'ErrorFive', code: 'EFIVE' });
  deepErrorOne.cause = deepErrorTwo;
  deepErrorTwo.cause = deepErrorThree;
  deepErrorThree.cause = deepErrorFour;
  deepErrorFour.cause = deepErrorFive;
  assert.strictEqual(extractSafeErrorMetadata(deepErrorOne).length, 4);
  assert.strictEqual(JSON.stringify(extractSafeErrorMetadata(deepErrorOne)).includes('ErrorFive'), false);
}

// 前缀行缓冲测试模块：覆盖 CRLF 跨 chunk、空行和无尾换行 flush。
function testPrefixedLineBuffer() {
  const output = [];
  const lineBuffer = createPrefixedLineBuffer('[vite] ', (text) => output.push(text));
  lineBuffer.push('first line\r');
  lineBuffer.push('\nsecond');
  lineBuffer.push(' line\n\nlast line');
  lineBuffer.flush();
  assert.deepStrictEqual(output, [
    '[vite] first line\n',
    '[vite] second line\n',
    '[vite] \n',
    '[vite] last line\n'
  ]);
}

// 清理顺序测试模块：Tunnel 必须先于 Vite，Vite 必须先于 Express。
function testCleanupOrder() {
  const sortedEntries = sortOwnedProcessEntries([
    { key: 'express' },
    { key: 'unknown' },
    { key: 'tunnel' },
    { key: 'vite' }
  ]);
  assert.deepStrictEqual(sortedEntries.map((entry) => entry.key), ['tunnel', 'vite', 'express', 'unknown']);
}

// 生命周期测试数据模块：创建不启动真实子进程的最小拥有进程登记对象。
function createLifecycleTestEntry(key, label, pid) {
  return {
    key,
    label,
    child: { exitCode: null, signalCode: null, once: () => {} },
    pid,
    spawnError: null,
    detachedGroup: false
  };
}

// 生命周期竞态测试模块：精确覆盖已完成初始清理后的同轮微任务晚登记、连续新增和失败合并。
async function testLifecycleLateRegistrationGate() {
  let releaseLateCleanup;
  let releaseFinalLateCleanup;
  let resolveFinalRegistration;
  const initialCleanupPromise = Promise.resolve();
  const lateCleanupGate = new Promise((resolve) => {
    releaseLateCleanup = resolve;
  });
  const finalLateCleanupGate = new Promise((resolve) => {
    releaseFinalLateCleanup = resolve;
  });
  const finalRegistrationPromise = new Promise((resolve) => {
    resolveFinalRegistration = resolve;
  });
  const stoppedEntryKeys = [];
  const lifecycle = createLifecycleController({
    cleanupOwnedEntries: (entries) => {
      assert.deepStrictEqual(entries, []);
      return initialCleanupPromise;
    },
    stopOwnedEntry: async (entry) => {
      stoppedEntryKeys.push(entry.key);
      if (entry.key === 'tunnel') {
        await lateCleanupGate;
      }
      if (entry.key === 'vite') {
        throw new Error('连续晚登记清理失败');
      }
      if (entry.key === 'express') {
        await finalLateCleanupGate;
      }
    }
  });

  const shutdownPromise = lifecycle.requestShutdown(new Error('主流程失败'), 'SIGTERM');
  assert.strictEqual(lifecycle.requestShutdown(), shutdownPromise);
  const lateRegistrationPromise = initialCleanupPromise.then(() => {
    const lateEntry = lifecycle.register(
      createLifecycleTestEntry('tunnel', '晚登记 Tunnel', 43210)
    );
    Promise.resolve().then(() => Promise.resolve().then(() => {
      const finalLateEntry = lifecycle.register(
        createLifecycleTestEntry('express', '嵌套微任务晚登记 Express', 43212)
      );
      resolveFinalRegistration(finalLateEntry);
    }));
    return lateEntry;
  });
  let shutdownSettled = false;
  shutdownPromise.then(() => {
    shutdownSettled = true;
  });

  const lateEntry = await lateRegistrationPromise;
  const finalLateEntry = await finalRegistrationPromise;
  assert.strictEqual(lateEntry.registrationRejected, true);
  assert.strictEqual(finalLateEntry.registrationRejected, true);
  assert.strictEqual(lifecycle.entries.includes(lateEntry), false);
  assert.strictEqual(lifecycle.entries.includes(finalLateEntry), false);
  assert.deepStrictEqual(stoppedEntryKeys, ['tunnel', 'express']);
  assert.throws(() => lifecycle.assertCanContinue(), /SIGTERM/);
  const chainedRegistrationPromise = lateEntry.lateCleanupPromise.then(() => {
    const chainedEntry = lifecycle.register(
      createLifecycleTestEntry('vite', '连续晚登记 Vite', 43211)
    );
    return chainedEntry.lateCleanupPromise;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(shutdownSettled, false);
  releaseLateCleanup();
  await chainedRegistrationPromise;
  assert.strictEqual(shutdownSettled, false);
  assert.deepStrictEqual(stoppedEntryKeys, ['tunnel', 'express', 'vite']);
  releaseFinalLateCleanup();
  const shutdownOutcome = await shutdownPromise;
  assert.strictEqual(shutdownSettled, true);
  assert.strictEqual(shutdownOutcome.signalName, 'SIGTERM');
  assert.match(shutdownOutcome.fatalError.message, /^主流程失败\n子进程清理失败：连续晚登记清理失败$/);
  assert.deepStrictEqual(stoppedEntryKeys, ['tunnel', 'express', 'vite']);

  const postShutdownEntry = lifecycle.register(
    createLifecycleTestEntry('post-shutdown', '关停后登记', 43213)
  );
  assert.strictEqual(postShutdownEntry.registrationRejected, true);
  await postShutdownEntry.lateCleanupPromise;
  assert.deepStrictEqual(stoppedEntryKeys, ['tunnel', 'express', 'vite', 'post-shutdown']);
}

// 生命周期稳定完成测试模块：没有晚登记时最终屏障必须在有限时间内结束，避免关停死锁。
async function testLifecycleStableShutdownCompletes() {
  const lifecycle = createLifecycleController({
    cleanupOwnedEntries: async (entries) => {
      assert.deepStrictEqual(entries, []);
    }
  });
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('生命周期稳定屏障未在限定时间内完成。')), 2000);
  });
  try {
    const shutdownOutcome = await Promise.race([
      lifecycle.requestShutdown(null, 'SIGQUIT'),
      timeoutPromise
    ]);
    assert.strictEqual(shutdownOutcome.signalName, 'SIGQUIT');
    assert.strictEqual(shutdownOutcome.fatalError, null);
  } finally {
    clearTimeout(timeoutId);
  }
}

// 长期子进程 spawn 脱敏测试模块：伪造路径、URL 和 Token 消息不得进入最终生命周期错误。
async function testLifecycleSpawnErrorRedaction() {
  // 子进程事件替身模块：只记录 error/exit 监听器，不启动任何真实进程。
  const childListeners = {};
  const lifecycle = createLifecycleController({
    cleanupOwnedEntries: async () => {}
  });
  const processEntry = lifecycle.register({
    key: 'tunnel',
    label: 'cloudflared Tunnel',
    child: {
      exitCode: null,
      signalCode: null,
      once: (eventName, eventHandler) => {
        childListeners[eventName] = eventHandler;
      }
    },
    pid: 43215,
    spawnError: null,
    detachedGroup: false
  });
  const sensitiveSpawnError = new Error(
    'spawn C:\\Users\\SecretUser\\cloudflared.exe https://hidden.example.com Bearer secret-token'
  );
  sensitiveSpawnError.name = 'SystemError';
  sensitiveSpawnError.code = 'ENOENT';
  sensitiveSpawnError.cause = Object.assign(new Error('secret UNC \\\\host\\share'), {
    name: 'Error',
    code: 'EACCES'
  });
  childListeners.error(sensitiveSpawnError);

  const shutdownOutcome = await lifecycle.stopPromise;
  assert.strictEqual(shutdownOutcome.fatalError.projectCode, 'CHARCOAL_PROCESS_SPAWN_FAILED');
  assert.match(shutdownOutcome.fatalError.message, /^cloudflared Tunnel 启动失败：请求失败/);
  assert.match(shutdownOutcome.fatalError.message, /SystemError\/ENOENT/);
  assert.match(shutdownOutcome.fatalError.message, /Error\/EACCES/);
  [
    'SecretUser',
    'cloudflared.exe',
    'hidden.example.com',
    'Bearer',
    'secret-token',
    'host',
    'share'
  ].forEach((forbiddenValue) => {
    assert.strictEqual(shutdownOutcome.fatalError.message.includes(forbiddenValue), false);
  });
  assert.throws(() => lifecycle.assertCanContinue(processEntry), (error) => {
    assert.strictEqual(error.message, shutdownOutcome.fatalError.message);
    return true;
  });
}

// 默认配置候选测试模块：覆盖 Windows、Linux、macOS 用户目录和 POSIX 系统目录，不读取真实用户文件。
function testDefaultCloudflaredConfigDetection() {
  assert.deepStrictEqual(buildDefaultCloudflaredConfigCandidates({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\tester'
  }), [
    'C:\\Users\\tester\\.cloudflared\\config.yml',
    'C:\\Users\\tester\\.cloudflared\\config.yaml',
    'C:\\Users\\tester\\.cloudflare-warp\\config.yml',
    'C:\\Users\\tester\\.cloudflare-warp\\config.yaml',
    'C:\\Users\\tester\\cloudflare-warp\\config.yml',
    'C:\\Users\\tester\\cloudflare-warp\\config.yaml'
  ]);
  const expectedPosixCandidates = [
    '/home/tester/.cloudflared/config.yml',
    '/home/tester/.cloudflared/config.yaml',
    '/home/tester/.cloudflare-warp/config.yml',
    '/home/tester/.cloudflare-warp/config.yaml',
    '/home/tester/cloudflare-warp/config.yml',
    '/home/tester/cloudflare-warp/config.yaml',
    '/etc/cloudflared/config.yml',
    '/etc/cloudflared/config.yaml',
    '/usr/local/etc/cloudflared/config.yml',
    '/usr/local/etc/cloudflared/config.yaml'
  ];
  assert.deepStrictEqual(buildDefaultCloudflaredConfigCandidates({
    platform: 'linux',
    homeDirectory: '/home/tester'
  }), expectedPosixCandidates);
  assert.deepStrictEqual(buildDefaultCloudflaredConfigCandidates({
    platform: 'darwin',
    homeDirectory: '/Users/tester'
  }), expectedPosixCandidates.map((candidatePath) => candidatePath.startsWith('/home/tester/')
    ? candidatePath.replace('/home/tester/', '/Users/tester/')
    : candidatePath));

  const candidatePaths = ['C:\\temp\\config.yml', 'C:\\temp\\config.yaml'];
  const conflicts = findDefaultCloudflaredConfigConflicts({
    candidatePaths,
    pathExists: (candidatePath) => candidatePath.endsWith('config.yaml')
  });
  assert.deepStrictEqual(conflicts, ['C:\\temp\\config.yaml']);
  assert.doesNotThrow(() => assertNoDefaultCloudflaredConfigConflict({
    candidatePaths,
    pathExists: () => false
  }));
  assert.throws(() => assertNoDefaultCloudflaredConfigConflict({
    candidatePaths,
    pathExists: (candidatePath) => candidatePath.endsWith('config.yml')
  }), (error) => {
    assert.match(error.message, /默认配置文件/);
    assert.match(error.message, /不会修改、移动或重命名/);
    assert.match(error.message, /前后端服务尚未启动/);
    assert.match(error.message, /C:\\temp\\config.yml/);
    return true;
  });
}

// 信号列表测试模块：POSIX 与 Windows 只注册各自可处理信号，不声称覆盖不可捕获终止。
function testHandledSignalNames() {
  assert.deepStrictEqual(buildHandledSignalNames('linux'), ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
  assert.deepStrictEqual(buildHandledSignalNames('darwin'), ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
  assert.deepStrictEqual(buildHandledSignalNames('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK']);
  assert.strictEqual(buildHandledSignalNames('linux').includes('SIGKILL'), false);
}

// 流式响应替身模块：按给定字节块构造不访问网络的最小 fetch Response。
function createChunkedResponse(status, chunks, options = {}) {
  let chunkIndex = 0;
  let cancelled = false;
  return {
    response: {
      status,
      headers: {
        get: (headerName) => {
          const normalizedHeaderName = headerName.toLowerCase();
          if (normalizedHeaderName === 'content-length') {
            return options.contentLength || null;
          }
          if (normalizedHeaderName === 'content-type') {
            return options.contentType || null;
          }
          return null;
        }
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (options.neverFinish) {
              return new Promise(() => {});
            }
            if (chunkIndex >= chunks.length) {
              return { done: true, value: undefined };
            }
            const value = Buffer.from(chunks[chunkIndex]);
            chunkIndex += 1;
            return { done: false, value };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {}
        })
      }
    },
    wasCancelled: () => cancelled
  };
}

// fetch 失败诊断断言模块：稳定项目错误码必须贯穿 fetch 到 readiness，原始消息和 URL 不得传播。
async function assertFetchFailureDiagnostic(testCase) {
  let currentTime = 0;
  const lifecycle = { assertCanContinue: () => {} };
  await assert.rejects(() => waitForReadiness({
    lifecycle,
    entry: null,
    timeoutMs: 1,
    label: '请求失败专项检查',
    now: () => currentTime,
    delay: async (milliseconds) => {
      currentTime += milliseconds;
    },
    pollingIntervalMs: 1,
    attempt: (attemptOptions) => fetchTextWithTimeout(
      'https://secret-random.trycloudflare.com/private-path',
      {
        timeoutMs: attemptOptions.timeoutMs,
        maxBytes: testCase.maxBytes,
        fetchImplementation: testCase.fetchImplementation
      }
    )
  }), (error) => {
    assert.match(error.message, new RegExp(testCase.projectCode));
    assert.doesNotMatch(error.message, /secret-random|private-path|请求完整响应超时|响应体超过|合法 HTTP 响应/);
    return true;
  });
}

// 完整响应与稳定错误码测试模块：覆盖成功、超时、超限、非法响应及 readiness 脱敏传播。
async function testFetchTextWithTimeout() {
  const successResponse = createChunkedResponse(200, ['hello ', 'world'], {
    contentType: 'Text/Plain; charset=utf-8'
  });
  assert.deepStrictEqual(await fetchTextWithTimeout('http://127.0.0.1:1/success', {
    timeoutMs: 100,
    maxBytes: 32,
    fetchImplementation: async () => successResponse.response
  }), { status: 200, contentType: 'text/plain', text: 'hello world' });

  const oversizedResponse = createChunkedResponse(200, ['12345678', '123456789']);
  await assert.rejects(() => fetchTextWithTimeout('http://127.0.0.1:1/oversized', {
    timeoutMs: 100,
    maxBytes: 16,
    fetchImplementation: async () => oversizedResponse.response
  }), (error) => error.projectCode === 'CHARCOAL_RESPONSE_TOO_LARGE'
    && error.code === 'ERR_RESPONSE_TOO_LARGE'
    && /超过最大允许大小 16 字节/.test(error.message));
  assert.strictEqual(oversizedResponse.wasCancelled(), true);

  const stalledResponse = createChunkedResponse(200, [], { neverFinish: true });
  await assert.rejects(() => fetchTextWithTimeout('http://127.0.0.1:1/stalled', {
    timeoutMs: 20,
    maxBytes: 16,
    fetchImplementation: async () => stalledResponse.response
  }), (error) => error.projectCode === 'CHARCOAL_REQUEST_TIMEOUT'
    && error.code === 'ETIMEDOUT'
    && /请求完整响应超时/.test(error.message));
  assert.strictEqual(stalledResponse.wasCancelled(), true);

  await assert.rejects(() => fetchTextWithTimeout('http://127.0.0.1:1/invalid', {
    timeoutMs: 100,
    maxBytes: 16,
    fetchImplementation: async () => ({ status: '200' })
  }), (error) => error.projectCode === 'CHARCOAL_INVALID_HTTP_RESPONSE'
    && error.code === 'ERR_INVALID_HTTP_RESPONSE');

  await assertFetchFailureDiagnostic({
    projectCode: 'CHARCOAL_REQUEST_TIMEOUT',
    maxBytes: 16,
    fetchImplementation: async () => createChunkedResponse(200, [], { neverFinish: true }).response
  });
  await assertFetchFailureDiagnostic({
    projectCode: 'CHARCOAL_RESPONSE_TOO_LARGE',
    maxBytes: 4,
    fetchImplementation: async () => createChunkedResponse(200, ['secret-body']).response
  });
  await assertFetchFailureDiagnostic({
    projectCode: 'CHARCOAL_INVALID_HTTP_RESPONSE',
    maxBytes: 16,
    fetchImplementation: async () => ({ status: null, secret: 'secret-response-object' })
  });
}

// 轮询最后观察测试模块：后一次 HTTP 或请求错误必须覆盖前一次结果，避免陈旧诊断。
async function testWaitForReadinessLastObservation() {
  // 轮询生命周期模块：专项测试不启动进程，仅保留继续执行断言入口。
  const lifecycle = { assertCanContinue: () => {} };
  let currentTime = 0;
  let firstAttemptCount = 0;
  await assert.rejects(() => waitForReadiness({
    lifecycle,
    entry: null,
    timeoutMs: 2,
    label: '专项健康检查',
    now: () => currentTime,
    delay: async () => {
      currentTime += 1;
    },
    pollingIntervalMs: 0,
    attempt: async () => {
      firstAttemptCount += 1;
      if (firstAttemptCount === 1) {
        const requestError = new Error('secret-first-fetch-message https://hidden.example.com');
        requestError.cause = Object.assign(new Error('secret-cause-message'), {
          name: 'ConnectTimeoutError',
          code: 'UND_ERR_CONNECT_TIMEOUT'
        });
        throw requestError;
      }
      return evaluateHealthyJsonResponse({
        status: 530,
        contentType: 'text/html',
        text: 'secret-last-body'
      });
    }
  }), (error) => {
    assert.strictEqual(error.projectCode, 'CHARCOAL_READINESS_TIMEOUT');
    assert.match(error.message, /HTTP 状态未就绪/);
    assert.match(error.message, /status=530/);
    assert.doesNotMatch(error.message, /fetch|hidden\.example|secret-first|secret-last-body/);
    return true;
  });

  currentTime = 0;
  let secondAttemptCount = 0;
  await assert.rejects(() => waitForReadiness({
    lifecycle,
    entry: null,
    timeoutMs: 2,
    label: '反向专项健康检查',
    now: () => currentTime,
    delay: async () => {
      currentTime += 1;
    },
    pollingIntervalMs: 0,
    attempt: async () => {
      secondAttemptCount += 1;
      if (secondAttemptCount === 1) {
        return evaluateHealthyJsonResponse({
          status: 502,
          contentType: 'application/json',
          text: '{"secret":"hidden"}'
        });
      }
      const timeoutError = new Error('secret-last-timeout-message');
      timeoutError.name = 'TypeError';
      timeoutError.cause = Object.assign(new Error('secret-connect-cause'), {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT'
      });
      throw timeoutError;
    }
  }), (error) => {
    assert.match(error.message, /请求失败/);
    assert.match(error.message, /TypeError/);
    assert.match(error.message, /ConnectTimeoutError\/UND_ERR_CONNECT_TIMEOUT/);
    assert.doesNotMatch(error.message, /status=502|secret-last-timeout|secret-connect-cause/);
    return true;
  });
}

// 硬 deadline 测试模块：迟到成功不得被接受，请求与延时必须受剩余预算约束。
async function testReadinessHardDeadline() {
  const lifecycle = { assertCanContinue: () => {} };
  let currentTime = 0;
  const requestBudgets = [];
  const delayBudgets = [];
  let attemptCount = 0;
  await assert.rejects(() => waitForReadiness({
    lifecycle,
    entry: null,
    timeoutMs: 5,
    requestTimeoutMs: 3,
    pollingIntervalMs: 4,
    label: '硬截止专项检查',
    now: () => currentTime,
    delay: async (milliseconds) => {
      delayBudgets.push(milliseconds);
      currentTime += milliseconds;
    },
    attempt: async (attemptOptions) => {
      requestBudgets.push(attemptOptions.timeoutMs);
      attemptCount += 1;
      if (attemptCount === 2) {
        currentTime += 1;
        return { ready: true, kind: 'healthy', status: 200, contentType: 'application/json' };
      }
      return { ready: false, kind: 'http-status', status: 503, contentType: 'text/plain' };
    }
  }), (error) => {
    assert.strictEqual(error.projectCode, 'CHARCOAL_READINESS_TIMEOUT');
    assert.match(error.message, /健康响应符合契约/);
    return true;
  });
  assert.deepStrictEqual(requestBudgets, [3, 1]);
  assert.deepStrictEqual(delayBudgets, [4]);

  currentTime = 0;
  const originRequestBudgets = [];
  const originDelayBudgets = [];
  let originAttemptCount = 0;
  await assert.rejects(() => waitForQuickTunnelOrigin({
    lifecycle,
    entry: null,
    capture: { getOrigins: () => [] },
    metricsUrl: 'http://127.0.0.1:49321/quicktunnel',
    timeoutMs: 5,
    requestTimeoutMs: 3,
    pollingIntervalMs: 4,
    now: () => currentTime,
    delay: async (milliseconds) => {
      originDelayBudgets.push(milliseconds);
      currentTime += milliseconds;
    },
    fetchText: async (url, fetchOptions) => {
      assert.strictEqual(url, 'http://127.0.0.1:49321/quicktunnel');
      originRequestBudgets.push(fetchOptions.timeoutMs);
      originAttemptCount += 1;
      if (originAttemptCount === 1) {
        return { status: 503, contentType: 'text/plain', text: 'not ready' };
      }
      currentTime += 1;
      return {
        status: 200,
        contentType: 'application/json',
        text: '{"hostname":"late-success.trycloudflare.com"}'
      };
    }
  }), (error) => {
    assert.strictEqual(error.projectCode, 'CHARCOAL_TUNNEL_ORIGIN_TIMEOUT');
    assert.doesNotMatch(error.message, /late-success/);
    return true;
  });
  assert.deepStrictEqual(originRequestBudgets, [3, 1]);
  assert.deepStrictEqual(originDelayBudgets, [4]);

  currentTime = 0;
  await assert.rejects(() => waitForQuickTunnelOrigin({
    lifecycle,
    entry: null,
    timeoutMs: 5,
    now: () => currentTime,
    capture: {
      getOrigins: () => {
        currentTime = 5;
        return ['https://late-log.trycloudflare.com'];
      }
    },
    metricsUrl: 'http://127.0.0.1:49321/quicktunnel',
    fetchText: async () => {
      throw new Error('截止后不应请求 metrics。');
    }
  }), (error) => {
    assert.strictEqual(error.projectCode, 'CHARCOAL_TUNNEL_ORIGIN_TIMEOUT');
    assert.doesNotMatch(error.message, /late-log/);
    return true;
  });

  // 健康零预算模块：while 条件通过后时钟抵达 deadline 时，不得再调用 attempt。
  const readinessClockValues = [0, 4, 5];
  let readinessClockIndex = 0;
  let zeroBudgetAttemptCount = 0;
  await assert.rejects(() => waitForReadiness({
    lifecycle,
    entry: null,
    timeoutMs: 5,
    label: '零预算健康检查',
    now: () => readinessClockValues[Math.min(readinessClockIndex++, readinessClockValues.length - 1)],
    attempt: async () => {
      zeroBudgetAttemptCount += 1;
      return { ready: true, kind: 'healthy', status: 200, contentType: 'application/json' };
    }
  }), (error) => error.projectCode === 'CHARCOAL_READINESS_TIMEOUT');
  assert.strictEqual(zeroBudgetAttemptCount, 0, '剩余健康预算为 0 时不得调用 attempt。');

  // Origin 零预算模块：捕获结果为空且时钟抵达 deadline 时，不得再调用 metrics fetch。
  const originClockValues = [0, 4, 5];
  let originClockIndex = 0;
  let zeroBudgetFetchCount = 0;
  await assert.rejects(() => waitForQuickTunnelOrigin({
    lifecycle,
    entry: null,
    timeoutMs: 5,
    capture: { getOrigins: () => [] },
    metricsUrl: 'http://127.0.0.1:49321/quicktunnel',
    now: () => originClockValues[Math.min(originClockIndex++, originClockValues.length - 1)],
    fetchText: async () => {
      zeroBudgetFetchCount += 1;
      return {
        status: 200,
        contentType: 'application/json',
        text: '{"hostname":"must-not-fetch.trycloudflare.com"}'
      };
    }
  }), (error) => error.projectCode === 'CHARCOAL_TUNNEL_ORIGIN_TIMEOUT');
  assert.strictEqual(zeroBudgetFetchCount, 0, '剩余 Origin 预算为 0 时不得调用 fetch。');
}

// Tunnel 三阶段编排测试模块：验证严格顺序，以及 readiness/公网健康失败后的短路边界。
async function testTunnelReadinessStageOrdering() {
  const successEvents = [];
  const successShareUrls = await runTunnelReadinessStages({
    metricsOrigin: 'http://127.0.0.1:49321',
    discoverOrigin: async () => {
      successEvents.push('discover-origin');
      return 'https://stage-success.trycloudflare.com';
    },
    waitForReady: async (readyUrl) => {
      successEvents.push(`ready:${readyUrl}`);
    },
    waitForPublicHealth: async (healthUrl) => {
      successEvents.push(`public:${healthUrl}`);
    },
    onStage: (stageName) => successEvents.push(`stage:${stageName}`)
  });
  assert.deepStrictEqual(successEvents, [
    'discover-origin',
    'stage:origin-discovered',
    'ready:http://127.0.0.1:49321/ready',
    'stage:edge-ready',
    'public:https://stage-success.trycloudflare.com/api/health',
    'stage:public-ready'
  ]);
  assert.deepStrictEqual(successShareUrls, {
    origin: 'https://stage-success.trycloudflare.com',
    shareUrl: 'https://stage-success.trycloudflare.com/?apiBase=%2Fapi',
    healthUrl: 'https://stage-success.trycloudflare.com/api/health'
  });

  const readyFailureEvents = [];
  await assert.rejects(() => runTunnelReadinessStages({
    metricsOrigin: 'http://127.0.0.1:49322',
    discoverOrigin: async () => {
      readyFailureEvents.push('discover-origin');
      return 'https://stage-ready-failure.trycloudflare.com';
    },
    waitForReady: async () => {
      readyFailureEvents.push('ready');
      throw new Error('readiness failed');
    },
    waitForPublicHealth: async () => {
      readyFailureEvents.push('public');
    },
    onStage: (stageName) => readyFailureEvents.push(`stage:${stageName}`)
  }), /readiness failed/);
  assert.deepStrictEqual(readyFailureEvents, [
    'discover-origin',
    'stage:origin-discovered',
    'ready'
  ]);

  const publicFailureEvents = [];
  let publicFailureResult = null;
  try {
    publicFailureResult = await runTunnelReadinessStages({
      metricsOrigin: 'http://127.0.0.1:49323',
      discoverOrigin: async () => {
        publicFailureEvents.push('discover-origin');
        return 'https://stage-public-failure.trycloudflare.com';
      },
      waitForReady: async () => {
        publicFailureEvents.push('ready');
      },
      waitForPublicHealth: async () => {
        publicFailureEvents.push('public');
        throw new Error('public health failed');
      },
      onStage: (stageName) => publicFailureEvents.push(`stage:${stageName}`)
    });
    assert.fail('公网健康失败时不应返回分享地址。');
  } catch (error) {
    assert.match(error.message, /public health failed/);
  }
  assert.strictEqual(publicFailureResult, null);
  assert.deepStrictEqual(publicFailureEvents, [
    'discover-origin',
    'stage:origin-discovered',
    'ready',
    'stage:edge-ready',
    'public'
  ]);
}

// 函数源码提取模块：按花括号层级限定静态接线检查范围，避免跨函数宽泛正则假阳性。
function extractDeclaredFunctionSource(sourceText, functionName) {
  // 函数签名模块：同时兼容普通和 async function 声明。
  const signatureIndex = sourceText.indexOf(`function ${functionName}(`);
  assert.notStrictEqual(signatureIndex, -1, `未找到函数 ${functionName}。`);
  // 函数起始模块：从签名后的首个左花括号开始累计层级。
  const openingBraceIndex = sourceText.indexOf('{', signatureIndex);
  assert.notStrictEqual(openingBraceIndex, -1, `函数 ${functionName} 缺少函数体。`);
  // 花括号层级模块：归零位置限定为当前声明函数的结尾。
  let braceDepth = 0;
  for (let characterIndex = openingBraceIndex; characterIndex < sourceText.length; characterIndex += 1) {
    const currentCharacter = sourceText[characterIndex];
    if (currentCharacter === '{') {
      braceDepth += 1;
    } else if (currentCharacter === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return sourceText.slice(signatureIndex, characterIndex + 1);
      }
    }
  }
  assert.fail(`函数 ${functionName} 缺少闭合花括号。`);
}

// 主启动接线测试模块：覆盖完整顺序、Vite 短路和 readiness 失败后的分享门槛。
async function testDevelopmentStartupSequenceWiring() {
  // 主入口调用关系模块：只在真实 runDevelopmentCloudflare 函数区间内检查生产接线。
  const launcherSourcePath = path.resolve(__dirname, '..', 'dev-cloudflare.js');
  const launcherSourceText = fs.readFileSync(launcherSourcePath, 'utf8');
  const productionEntrySource = extractDeclaredFunctionSource(
    launcherSourceText,
    'runDevelopmentCloudflare'
  );
  const startupSequenceCalls = productionEntrySource.match(/\brunDevelopmentStartupSequence\s*\(/g) || [];
  assert.strictEqual(startupSequenceCalls.length, 1, '生产主入口必须且只能调用一次启动接线编排器。');
  assert.match(productionEntrySource, /await\s+runDevelopmentStartupSequence\s*\(\{/);
  const successEvents = [];
  const successResult = await runDevelopmentStartupSequence({
    startExpress: async () => {
      successEvents.push('express-start');
      return { key: 'express' };
    },
    waitForExpress: async () => successEvents.push('express-health'),
    startVite: async () => {
      successEvents.push('vite-start');
      return { key: 'vite' };
    },
    waitForVitePage: async () => successEvents.push('vite-page'),
    waitForViteProxy: async () => successEvents.push('vite-proxy'),
    startTunnel: async () => {
      successEvents.push('tunnel-start');
      return { metricsOrigin: 'http://127.0.0.1:49324' };
    },
    waitForTunnel: (tunnelContext) => runTunnelReadinessStages({
      metricsOrigin: tunnelContext.metricsOrigin,
      discoverOrigin: async () => {
        successEvents.push('origin');
        return 'https://startup-wiring.trycloudflare.com';
      },
      waitForReady: async () => successEvents.push('ready'),
      waitForPublicHealth: async () => successEvents.push('public-health')
    }),
    publishShare: async () => successEvents.push('share')
  });
  assert.deepStrictEqual(successEvents, [
    'express-start',
    'express-health',
    'vite-start',
    'vite-page',
    'vite-proxy',
    'tunnel-start',
    'origin',
    'ready',
    'public-health',
    'share'
  ]);
  assert.strictEqual(successResult.shareUrls.origin, 'https://startup-wiring.trycloudflare.com');

  const viteFailureEvents = [];
  await assert.rejects(() => runDevelopmentStartupSequence({
    startExpress: async () => viteFailureEvents.push('express-start'),
    waitForExpress: async () => viteFailureEvents.push('express-health'),
    startVite: async () => viteFailureEvents.push('vite-start'),
    waitForVitePage: async () => viteFailureEvents.push('vite-page'),
    waitForViteProxy: async () => {
      viteFailureEvents.push('vite-proxy');
      throw new Error('vite proxy failed');
    },
    startTunnel: async () => viteFailureEvents.push('tunnel-start'),
    waitForTunnel: async () => viteFailureEvents.push('public-health'),
    publishShare: async () => viteFailureEvents.push('share')
  }), /vite proxy failed/);
  assert.deepStrictEqual(viteFailureEvents, [
    'express-start',
    'express-health',
    'vite-start',
    'vite-page',
    'vite-proxy'
  ]);

  const readyFailureEvents = [];
  await assert.rejects(() => runDevelopmentStartupSequence({
    startExpress: async () => readyFailureEvents.push('express-start'),
    waitForExpress: async () => readyFailureEvents.push('express-health'),
    startVite: async () => readyFailureEvents.push('vite-start'),
    waitForVitePage: async () => readyFailureEvents.push('vite-page'),
    waitForViteProxy: async () => readyFailureEvents.push('vite-proxy'),
    startTunnel: async () => {
      readyFailureEvents.push('tunnel-start');
      return { metricsOrigin: 'http://127.0.0.1:49325' };
    },
    waitForTunnel: (tunnelContext) => runTunnelReadinessStages({
      metricsOrigin: tunnelContext.metricsOrigin,
      discoverOrigin: async () => {
        readyFailureEvents.push('origin');
        return 'https://startup-ready-failure.trycloudflare.com';
      },
      waitForReady: async () => {
        readyFailureEvents.push('ready');
        throw new Error('ready failed');
      },
      waitForPublicHealth: async () => readyFailureEvents.push('public-health')
    }),
    publishShare: async () => readyFailureEvents.push('share')
  }), /ready failed/);
  assert.deepStrictEqual(readyFailureEvents, [
    'express-start',
    'express-health',
    'vite-start',
    'vite-page',
    'vite-proxy',
    'tunnel-start',
    'origin',
    'ready'
  ]);
}

// 测试入口模块：顺序执行全部纯逻辑断言，不启动服务、Tunnel 或业务 SQLite。
async function main() {
  testLauncherModuleExports();
  testEnvironmentExampleSecurityContract();
  testTunnelApiBaseValidation();
  testTunnelApiBaseEnvironmentEnforcement();
  testTunnelTransportProtocolValidation();
  testCloudflaredTunnelArguments();
  testCloudflaredCommandResolution();
  await testCloudflaredPreflightFailureRedaction();
  testQuickTunnelOriginValidation();
  testQuickTunnelLogCapture();
  testMetricsOriginValidation();
  testQuickTunnelMetricsPayload();
  testShareUrlGeneration();
  testHealthyJsonResponse();
  testStructuredHealthResponseEvaluation();
  testRedactedDiagnosticMetadata();
  testPrefixedLineBuffer();
  testCleanupOrder();
  await testLifecycleLateRegistrationGate();
  await testLifecycleStableShutdownCompletes();
  await testLifecycleSpawnErrorRedaction();
  testDefaultCloudflaredConfigDetection();
  testHandledSignalNames();
  await testFetchTextWithTimeout();
  await testWaitForReadinessLastObservation();
  await testReadinessHardDeadline();
  await testTunnelReadinessStageOrdering();
  await testDevelopmentStartupSequenceWiring();
  console.log('dev cloudflare core tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
