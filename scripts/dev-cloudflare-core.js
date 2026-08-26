// Tunnel API Base 模块：公网模式只允许浏览器继续使用同源 /api。
const allowedTunnelApiBases = new Set(['', '/api', '/api/']);
// Quick Tunnel 域名模块：仅接受合法 ASCII 子域和官方 trycloudflare.com 后缀。
const quickTunnelHostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+trycloudflare\.com$/i;
// Tunnel 日志 URL 模块：从日志文本中提取待严格校验的 HTTPS 候选值。
const quickTunnelUrlCandidatePattern = /https:\/\/[^\s"'<>|]+/gi;
// ANSI 日志模块：移除终端颜色控制符，避免其干扰 URL 捕获。
const ansiEscapePattern = /\[[0-?]*[ -/]*[@-~]/g;
// Metrics 回环模块：允许标准 localhost、IPv6 回环和 127.0.0.0/8 地址。
const ipv4LoopbackPattern = /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/;
// 子进程清理顺序模块：数值越大越先清理。
const cleanupPriority = Object.freeze({ tunnel: 3, vite: 2, express: 1 });
// Tunnel 传输协议模块：只允许 cloudflared 官方支持的受控协议值。
const allowedTunnelTransportProtocols = new Set(['auto', 'quic', 'http2']);
// 安全错误元数据模块：只保留有界、稳定且不含自由文本的名称与错误码。
const safeErrorMetadataValuePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
// 项目稳定错误码模块：项目自定义诊断码必须使用 CHARCOAL_ 前缀。
const stableProjectErrorCodePattern = /^CHARCOAL_[A-Z0-9_]{1,55}$/;
// 错误 cause 深度模块：限制错误链遍历深度并配合循环引用保护。
const maxSafeErrorCauseDepth = 4;

// Tunnel API Base 校验模块：空白值和 /api 两种同源形式统一为 /api。
function validateTunnelApiBase(rawValue) {
  // 原始配置模块：只做字符串化和首尾空白清理，不接受外部绝对地址。
  const normalizedValue = String(rawValue ?? '').trim();
  if (!allowedTunnelApiBases.has(normalizedValue)) {
    throw new Error('Tunnel 模式下 VITE_API_BASE_URL 只能留空或设置为 /api。');
  }
  return '/api';
}

// Tunnel 传输协议标准化模块：空值默认 auto，非法值使用不回显原值的稳定错误。
function normalizeTunnelTransportProtocol(rawValue) {
  // 协议输入模块：只清理首尾空白，合法值严格限定为官方小写枚举。
  const normalizedProtocol = String(rawValue ?? '').trim() || 'auto';
  if (!allowedTunnelTransportProtocols.has(normalizedProtocol)) {
    const protocolError = new Error('TUNNEL_TRANSPORT_PROTOCOL 只能设置为 auto、quic 或 http2。');
    protocolError.projectCode = 'CHARCOAL_TUNNEL_PROTOCOL_INVALID';
    throw protocolError;
  }
  return normalizedProtocol;
}

// cloudflared Tunnel 参数模块：集中生成完整 argv，并确保协议参数只出现一组。
function buildCloudflaredTunnelArguments(options = {}) {
  // Tunnel 参数输入模块：协议和 metrics 地址先经过受控标准化。
  const protocol = normalizeTunnelTransportProtocol(options.protocol);
  const metricsOrigin = normalizeMetricsOrigin(options.metricsOrigin);
  const tunnelTargetOrigin = normalizeMetricsOrigin(options.tunnelTargetOrigin);
  const expectedHttpHostHeader = new URL(tunnelTargetOrigin).host;
  const httpHostHeader = String(options.httpHostHeader ?? '').trim();
  if (httpHostHeader !== expectedHttpHostHeader) {
    throw new Error('cloudflared Tunnel Host Header 必须与受控回环目标一致。');
  }

  // Metrics CLI 地址模块：cloudflared 参数只使用已校验回环 Origin 的 host:port。
  const metricsAddress = new URL(metricsOrigin).host;
  return Object.freeze([
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--protocol',
    protocol,
    '--metrics',
    metricsAddress,
    '--url',
    tunnelTargetOrigin,
    '--http-host-header',
    httpHostHeader
  ]);
}

// Quick Tunnel Origin 标准化模块：拒绝凭据、端口、路径、查询、片段和非官方域名。
function normalizeQuickTunnelOrigin(rawValue) {
  // Origin 输入模块：空值在 URL 解析前直接失败，避免返回模糊错误。
  const normalizedValue = String(rawValue ?? '').trim();
  if (!normalizedValue) {
    throw new Error('Quick Tunnel Origin 不能为空。');
  }
  if (normalizedValue.includes('\\')) {
    throw new Error('Quick Tunnel Origin 不允许包含反斜杠。');
  }

  // 原始 remainder 模块：URL 标准化前只允许 authority 后为空或单个根路径斜杠。
  const rawOriginMatch = normalizedValue.match(/^https:\/\/([^/?#]+)([\s\S]*)$/i);
  if (!rawOriginMatch) {
    throw new Error('Quick Tunnel Origin 必须是合法 HTTPS URL。');
  }
  const rawRemainder = rawOriginMatch[2];
  if (rawRemainder !== '' && rawRemainder !== '/') {
    throw new Error('Quick Tunnel Origin 不允许包含非根原始路径、查询或片段。');
  }

  // URL 解析模块：原始组成通过后再执行标准 URL 语义校验。
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedValue);
  } catch (error) {
    throw new Error('Quick Tunnel Origin 必须是合法 HTTPS URL。');
  }

  // 显式端口模块：Quick Tunnel 公网 Origin 不接受任何自定义端口。
  const authorityValue = rawOriginMatch[1];
  const authorityWithoutCredentials = authorityValue.slice(authorityValue.lastIndexOf('@') + 1);
  const hasExplicitPort = /:\d+$/.test(authorityWithoutCredentials);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Quick Tunnel Origin 必须使用 https。');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Quick Tunnel Origin 不允许包含凭据。');
  }
  if (hasExplicitPort || parsedUrl.port) {
    throw new Error('Quick Tunnel Origin 不允许包含端口。');
  }
  if (!quickTunnelHostnamePattern.test(parsedUrl.hostname) || parsedUrl.hostname.length > 253) {
    throw new Error('Quick Tunnel Origin 必须是 trycloudflare.com 的合法子域。');
  }
  if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    throw new Error('Quick Tunnel Origin 不允许包含非根路径、查询或片段。');
  }
  return parsedUrl.origin;
}

// 日志句末标点模块：仅当标点前是无路径的严格 Origin 时清理，避免把危险路径剥离成根地址。
function normalizeQuickTunnelLogCandidate(rawCandidate) {
  const candidateValue = String(rawCandidate ?? '');
  try {
    return normalizeQuickTunnelOrigin(candidateValue);
  } catch (error) {
    // 原候选不是严格 Origin 时，仅尝试识别无路径 Origin 后的自然语言句末标点。
  }

  const sentencePunctuation = new Set([')', ',', ';', '!', '?', '}', ']', '.', '。']);
  let punctuationStartIndex = candidateValue.length;
  while (punctuationStartIndex > 0 && sentencePunctuation.has(candidateValue[punctuationStartIndex - 1])) {
    punctuationStartIndex -= 1;
  }
  if (punctuationStartIndex === candidateValue.length) {
    throw new Error('Quick Tunnel 日志候选不是合法 Origin。');
  }

  const originCandidate = candidateValue.slice(0, punctuationStartIndex);
  const rawAuthorityMatch = originCandidate.match(/^https:\/\/([^/?#]+)$/i);
  if (!rawAuthorityMatch) {
    throw new Error('Quick Tunnel 日志候选的句末标点前不允许包含路径。');
  }
  return normalizeQuickTunnelOrigin(originCandidate);
}

// Quick Tunnel 日志捕获模块：分别滚动缓存 stdout/stderr，支持跨 chunk 并对同一 Origin 去重。
function createQuickTunnelLogCapture(options = {}) {
  // 捕获配置模块：回调只接收首次出现的严格 Origin 和对应输出来源。
  const onOrigin = typeof options.onOrigin === 'function' ? options.onOrigin : () => {};
  const maxBufferLength = Number.isInteger(options.maxBufferLength) && options.maxBufferLength >= 512
    ? options.maxBufferLength
    : 8192;
  // 捕获状态模块：不同输出流不能跨流拼接，同一域名只产生一次结果。
  const streamBuffers = new Map();
  const seenOrigins = new Set();

  // 日志输入模块：解析当前流的滚动文本并返回本次新增的有效 Origin。
  function feed(chunk, source = 'stdout') {
    const sourceName = String(source || 'stdout');
    const chunkText = String(chunk ?? '').replace(ansiEscapePattern, '');
    const combinedText = `${streamBuffers.get(sourceName) || ''}${chunkText}`;
    const capturedResults = [];

    quickTunnelUrlCandidatePattern.lastIndex = 0;
    for (const match of combinedText.matchAll(quickTunnelUrlCandidatePattern)) {
      // Chunk 边界模块：候选恰好位于当前缓冲末尾时延后判断，避免下一 chunk 追加路径后被误接受。
      if ((match.index || 0) + match[0].length === combinedText.length) {
        continue;
      }
      // URL 候选模块：只清理无路径 Origin 后的句末标点，危险路径不得通过截断变成合法地址。
      let origin;
      try {
        origin = normalizeQuickTunnelLogCandidate(match[0]);
      } catch (error) {
        continue;
      }
      if (seenOrigins.has(origin)) {
        continue;
      }
      seenOrigins.add(origin);
      const capturedResult = Object.freeze({ origin, source: sourceName });
      capturedResults.push(capturedResult);
      onOrigin(capturedResult);
    }

    streamBuffers.set(sourceName, combinedText.slice(-maxBufferLength));
    return capturedResults;
  }

  // 捕获状态读取模块：测试和入口脚本可读取已确认的 Origin，不暴露可变集合。
  function getOrigins() {
    return Array.from(seenOrigins);
  }

  return Object.freeze({ feed, getOrigins });
}

// Quick Tunnel Metrics JSON 模块：hostname/url 任一字段都需严格校验，双字段必须指向同一 Origin。
function parseQuickTunnelMetricsPayload(rawPayload) {
  // Metrics 载荷模块：支持 fetch 后的对象或原始 JSON 文本。
  let payload = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      payload = JSON.parse(rawPayload);
    } catch (error) {
      throw new Error('/quicktunnel 响应必须是合法 JSON。');
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('/quicktunnel 响应必须是 JSON 对象。');
  }

  // Metrics Origin 模块：存在的 hostname 和 url 字段分别进行严格标准化。
  const origins = [];
  if (Object.prototype.hasOwnProperty.call(payload, 'hostname')) {
    const hostname = String(payload.hostname ?? '').trim();
    if (!hostname) {
      throw new Error('/quicktunnel hostname 必须是官方域名。');
    }
    const hostnameUrl = hostname.includes('://') ? hostname : `https://${hostname}`;
    origins.push(normalizeQuickTunnelOrigin(hostnameUrl));
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'url')) {
    origins.push(normalizeQuickTunnelOrigin(payload.url));
  }
  if (origins.length === 0) {
    throw new Error('/quicktunnel 响应缺少 hostname 或 url。');
  }
  if (new Set(origins).size !== 1) {
    throw new Error('/quicktunnel hostname 与 url 不一致。');
  }
  return origins[0];
}

// IPv4 回环判定模块：只接受完整四段 127.0.0.0/8 十进制写法和有效字节。
function isIpv4LoopbackHostname(hostname) {
  if (!ipv4LoopbackPattern.test(hostname)) {
    return false;
  }
  return hostname.split('.').every((segment) => Number(segment) >= 0 && Number(segment) <= 255);
}

// Metrics 回环地址标准化模块：只允许显式端口的本机 HTTP 地址，防止轮询被用于 SSRF。
function normalizeMetricsOrigin(rawValue) {
  // Metrics 地址模块：URL 解析负责拒绝畸形输入，原始 authority 负责拒绝替代主机编码。
  const normalizedValue = String(rawValue ?? '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedValue);
  } catch (error) {
    throw new Error('cloudflared metrics 地址必须是合法 URL。');
  }
  if (parsedUrl.protocol !== 'http:') {
    throw new Error('cloudflared metrics 地址只能使用 http。');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('cloudflared metrics 地址不允许包含凭据。');
  }
  if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    throw new Error('cloudflared metrics 地址不允许包含路径、查询或片段。');
  }

  // Metrics authority 模块：只接受 localhost、[::1] 或完整 127.x.x.x 加显式十进制端口。
  const authorityValue = normalizedValue.match(/^http:\/\/([^/?#]+)/i)?.[1] || '';
  const ipv6AuthorityMatch = authorityValue.match(/^(\[::1\]):(\d+)$/i);
  const hostPortMatch = ipv6AuthorityMatch || authorityValue.match(/^([^:]+):(\d+)$/);
  if (!hostPortMatch) {
    throw new Error('cloudflared metrics 地址必须包含回环主机和有效端口。');
  }
  const hostname = hostPortMatch[1].toLowerCase();
  const port = Number(hostPortMatch[2]);
  const isLoopbackHostname = hostname === 'localhost'
    || hostname === '[::1]'
    || isIpv4LoopbackHostname(hostname);
  if (!isLoopbackHostname) {
    throw new Error('cloudflared metrics 地址必须使用回环主机。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('cloudflared metrics 地址必须包含 1—65535 的有效端口。');
  }

  // Metrics 规范地址模块：保留显式端口，供入口脚本固定轮询 /quicktunnel。
  return `http://${hostname}:${port}`;
}

// Metrics Quick Tunnel 地址生成模块：先校验回环 Origin，再追加固定受控路径。
function buildQuickTunnelMetricsUrl(metricsOrigin) {
  return `${normalizeMetricsOrigin(metricsOrigin)}/quicktunnel`;
}

// Metrics readiness 地址生成模块：先校验回环 Origin，再固定追加 /ready 防止路径注入和 SSRF。
function buildCloudflaredReadyUrl(metricsOrigin) {
  return `${normalizeMetricsOrigin(metricsOrigin)}/ready`;
}

// 公网分享地址生成模块：始终使用同源 /api 查询值和固定健康检查路径。
function buildShareUrls(rawOrigin) {
  const origin = normalizeQuickTunnelOrigin(rawOrigin);
  return Object.freeze({
    origin,
    shareUrl: `${origin}/?apiBase=%2Fapi`,
    healthUrl: `${origin}/api/health`
  });
}

// 健康响应判定模块：只接受 2xx、success=true 且 data.status=ok 的现有接口格式。
function isHealthyJsonResponse(statusCode, body) {
  return Number.isInteger(statusCode)
    && statusCode >= 200
    && statusCode < 300
    && Boolean(body)
    && body.success === true
    && Boolean(body.data)
    && body.data.status === 'ok';
}

// Content-Type 规范化模块：只保留小写 media type，参数和非法自由文本不会进入诊断。
function normalizeContentType(rawValue) {
  // Content-Type 输入模块：分号后的 charset 等参数不参与 JSON 类型判断。
  const mediaType = String(rawValue ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    return '';
  }
  return mediaType;
}

// JSON media type 判定模块：接受 application/json 和标准 +json 后缀类型。
function isJsonContentType(rawValue) {
  const mediaType = normalizeContentType(rawValue);
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

// 结构化健康响应判定模块：按状态、类型、JSON 和既有健康契约顺序给出稳定观察结果。
function evaluateHealthyJsonResponse(response = {}) {
  // 健康响应元数据模块：响应正文只在函数内部解析，绝不写入返回观察结果。
  const status = Number.isInteger(response.status) ? response.status : null;
  const contentType = normalizeContentType(response.contentType);
  if (status === null || status < 200 || status >= 300) {
    return Object.freeze({ ready: false, kind: 'http-status', status, contentType });
  }
  if (!isJsonContentType(contentType)) {
    return Object.freeze({ ready: false, kind: 'content-type', status, contentType });
  }

  // 健康 JSON 解析模块：解析失败只返回稳定分类，不保留正文或解析错误消息。
  let body;
  try {
    body = response.text ? JSON.parse(response.text) : null;
  } catch (error) {
    return Object.freeze({ ready: false, kind: 'invalid-json', status, contentType });
  }
  if (!isHealthyJsonResponse(status, body)) {
    return Object.freeze({ ready: false, kind: 'contract-mismatch', status, contentType });
  }
  return Object.freeze({ ready: true, kind: 'healthy', status, contentType });
}

// Metrics readiness 响应判定模块：cloudflared /ready 严格只有 HTTP 200 才算 Edge 就绪。
function evaluateCloudflaredReadyResponse(response = {}) {
  // readiness 元数据模块：Content-Type 仅用于失败诊断，不参与 200-only 判定。
  const status = Number.isInteger(response.status) ? response.status : null;
  const contentType = normalizeContentType(response.contentType);
  return Object.freeze({
    ready: status === 200,
    kind: status === 200 ? 'ready' : 'http-status',
    status,
    contentType
  });
}

// 安全错误字段模块：仅接受短小稳定标识符，拒绝自由文本、路径和 URL。
function normalizeSafeErrorMetadataValue(rawValue) {
  const normalizedValue = typeof rawValue === 'string' ? rawValue.trim() : '';
  return safeErrorMetadataValuePattern.test(normalizedValue) ? normalizedValue : '';
}

// 安全错误元数据提取模块：有界遍历 Error/cause，并阻断循环引用和敏感自由文本传播。
function extractSafeErrorMetadata(errorValue) {
  // 错误链状态模块：WeakSet 防止 cause 循环，固定深度防止恶意超长链。
  const seenErrors = new WeakSet();
  const errorChain = [];
  let currentError = errorValue;
  let currentDepth = 0;
  while (currentError && typeof currentError === 'object' && currentDepth < maxSafeErrorCauseDepth) {
    if (seenErrors.has(currentError)) {
      break;
    }
    seenErrors.add(currentError);

    // 单层错误元数据模块：只投影 name/code/稳定项目码，不复制 message、stack 或其他字段。
    const errorMetadata = {};
    const errorName = normalizeSafeErrorMetadataValue(currentError.name);
    const errorCode = normalizeSafeErrorMetadataValue(currentError.code);
    const projectCode = typeof currentError.projectCode === 'string'
      && stableProjectErrorCodePattern.test(currentError.projectCode)
      ? currentError.projectCode
      : '';
    if (errorName) {
      errorMetadata.name = errorName;
    }
    if (errorCode) {
      errorMetadata.code = errorCode;
    }
    if (projectCode) {
      errorMetadata.projectCode = projectCode;
    }
    if (Object.keys(errorMetadata).length > 0) {
      errorChain.push(Object.freeze(errorMetadata));
    }
    currentError = currentError.cause;
    currentDepth += 1;
  }
  return Object.freeze(errorChain);
}

// 请求错误观察模块：把任意异常收敛为不含正文、消息、堆栈、地址或请求头的结构化结果。
function createRequestErrorObservation(errorValue) {
  return Object.freeze({
    ready: false,
    kind: 'request-error',
    errors: extractSafeErrorMetadata(errorValue)
  });
}

// 脱敏诊断格式化模块：只格式化结构化白名单字段，禁止拼接原始响应或 Error 文本。
function formatRedactedReadinessDiagnostic(observation = {}) {
  // HTTP 诊断模块：状态与规范化 Content-Type 是唯一允许的响应元数据。
  const statusText = Number.isInteger(observation.status) ? `status=${observation.status}` : 'status=unknown';
  const contentType = normalizeContentType(observation.contentType);
  const contentTypeText = contentType ? `，content-type=${contentType}` : '';
  if (observation.kind === 'healthy') {
    return `健康响应符合契约（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'ready') {
    return `Edge readiness 已就绪（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'http-status') {
    return `HTTP 状态未就绪（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'content-type') {
    return `健康响应 Content-Type 不是 JSON（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'invalid-json') {
    return `健康响应不是合法 JSON（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'contract-mismatch') {
    return `健康响应不符合契约（${statusText}${contentTypeText}）`;
  }
  if (observation.kind === 'request-error') {
    // 错误链诊断模块：重新执行白名单投影，避免调用方伪造自由文本观察对象。
    const projectedErrorChain = Array.isArray(observation.errors)
      ? observation.errors.slice(0, maxSafeErrorCauseDepth).map((errorMetadata) => {
        const projectedMetadata = {};
        const errorName = normalizeSafeErrorMetadataValue(errorMetadata?.name);
        const errorCode = normalizeSafeErrorMetadataValue(errorMetadata?.code);
        const projectCode = typeof errorMetadata?.projectCode === 'string'
          && stableProjectErrorCodePattern.test(errorMetadata.projectCode)
          ? errorMetadata.projectCode
          : '';
        if (errorName) {
          projectedMetadata.name = errorName;
        }
        if (errorCode) {
          projectedMetadata.code = errorCode;
        }
        if (projectCode) {
          projectedMetadata.projectCode = projectCode;
        }
        return projectedMetadata;
      }).filter((errorMetadata) => Object.keys(errorMetadata).length > 0)
      : [];
    const errorText = projectedErrorChain.length > 0
      ? projectedErrorChain.map((errorMetadata) => [
        errorMetadata.name,
        errorMetadata.code,
        errorMetadata.projectCode
      ].filter(Boolean).join('/')).join(' -> ')
      : 'metadata=unavailable';
    return `请求失败（${errorText}）`;
  }
  return '未获得有效就绪观察结果';
}

// Tunnel 三阶段编排模块：严格按 Origin、Edge readiness、公网健康顺序执行并在全部通过后返回分享地址。
async function runTunnelReadinessStages(options = {}) {
  // 阶段依赖模块：所有 I/O 都由入口脚本注入，核心只负责顺序和短路边界。
  const discoverOrigin = options.discoverOrigin;
  const waitForReady = options.waitForReady;
  const waitForPublicHealth = options.waitForPublicHealth;
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  if (typeof discoverOrigin !== 'function' || typeof waitForReady !== 'function' || typeof waitForPublicHealth !== 'function') {
    throw new Error('Tunnel 三阶段编排缺少必要执行函数。');
  }

  // Origin 阶段模块：域名只有通过既有严格校验后才进入后续 readiness。
  const origin = normalizeQuickTunnelOrigin(await discoverOrigin());
  onStage('origin-discovered');
  // Edge readiness 阶段模块：固定使用受控回环 /ready，失败时不会调用公网健康。
  const readyUrl = buildCloudflaredReadyUrl(options.metricsOrigin);
  await waitForReady(readyUrl);
  onStage('edge-ready');
  // 公网健康阶段模块：分享地址只在健康硬门槛通过后返回。
  const shareUrls = buildShareUrls(origin);
  await waitForPublicHealth(shareUrls.healthUrl);
  onStage('public-ready');
  return shareUrls;
}

// 前缀行缓冲模块：跨 chunk 保留半行，为每个完整日志行添加稳定前缀。
function createPrefixedLineBuffer(prefix, write) {
  // 日志输出模块：入口脚本注入 stdout/stderr writer，测试可注入数组收集器。
  const normalizedPrefix = String(prefix ?? '');
  const writeOutput = typeof write === 'function' ? write : () => {};
  let pendingText = '';

  // 日志追加模块：只立即输出完整行，半行留待后续 chunk 或 flush。
  function push(chunk) {
    pendingText += String(chunk ?? '');
    let newlineIndex = pendingText.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = pendingText.slice(0, newlineIndex);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      writeOutput(`${normalizedPrefix}${line}\n`);
      pendingText = pendingText.slice(newlineIndex + 1);
      newlineIndex = pendingText.indexOf('\n');
    }
  }

  // 日志收尾模块：子进程退出时输出最后一个没有换行符的半行。
  function flush() {
    if (!pendingText) {
      return;
    }
    const finalText = pendingText.endsWith('\r') ? pendingText.slice(0, -1) : pendingText;
    pendingText = '';
    writeOutput(`${normalizedPrefix}${finalText}\n`);
  }

  return Object.freeze({ push, flush });
}

// 清理排序模块：严格按 Tunnel、Vite、Express 排序，未知项最后处理。
function sortOwnedProcessEntries(entries) {
  return Array.from(entries || []).sort((left, right) => {
    const rightPriority = cleanupPriority[right?.key] || 0;
    const leftPriority = cleanupPriority[left?.key] || 0;
    return rightPriority - leftPriority;
  });
}

module.exports = {
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
};
