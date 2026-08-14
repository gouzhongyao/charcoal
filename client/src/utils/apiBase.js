const STORAGE_KEY = 'charcoal.apiBase';
const FALLBACK = '/api';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Returns a canonical trusted API base, or null. Only same-origin /api and
 * loopback http(s) origins are valid; this keeps bearer tokens local.
 */
export function toTrustedApiBase(value) {
  const input = String(value || '').trim();
  if (/^\/api\/?$/.test(input)) return FALLBACK;
  if (!input || input.startsWith('//')) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !LOCAL_HOSTS.has(url.hostname)) return null;
  if (!['/', '/api', '/api/'].includes(url.pathname) || url.search || url.hash) return null;
  return `${url.origin}${FALLBACK}`;
}

export function isTrustedApiBase(value) { return toTrustedApiBase(value) !== null; }
export function normalizeApiBase(value) { return toTrustedApiBase(value) || FALLBACK; }

function storageValue(storage) {
  try { return storage?.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}
function clearStoredApiBase(storage) {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* local storage can be unavailable */ }
}

export function resolveApiBase() {
  const storage = typeof window === 'undefined' ? null : window.localStorage;
  const stored = storageValue(storage);
  if (stored && !isTrustedApiBase(stored)) clearStoredApiBase(storage);
  const query = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const queryValue = query?.get('apiBase') ?? query?.get('api_base');
  const storedTrusted = stored && isTrustedApiBase(stored) ? stored : '';
  const candidate = queryValue !== null ? queryValue : (storedTrusted || import.meta.env?.VITE_API_BASE_URL || import.meta.env?.VITE_API_BASE || FALLBACK);
  return normalizeApiBase(candidate);
}

/** 判断请求 URL 是否为可信 API base 下的相对请求。 */
export function isTrustedRelativeApiRequest(config, baseURL) {
  const requestUrl = String(config?.url || '');
  const isRelativeRequest = requestUrl.startsWith('/')
    && !requestUrl.startsWith('//')
    && !requestUrl.includes('\\')
    && !/^[a-z][a-z\d+.-]*:/i.test(requestUrl);
  return isTrustedApiBase(baseURL) && isRelativeRequest;
}

/** Applies a bearer token only to a verified local API base. */
export function applyTrustedAuthorization(config, baseURL, token) {
  const headers = config.headers || (config.headers = {});
  if (token && isTrustedRelativeApiRequest(config, baseURL)) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers.delete?.('Authorization');
    headers.delete?.('authorization');
    delete headers.Authorization;
    delete headers.authorization;
  }
  return config;
}

/** 仅在可信相对 API 且请求显式声明 artifact/handler/token 时附加演示 context。 */
export function applyTrustedDemoContext(config, baseURL) {
  const headers = config.headers || (config.headers = {});
  const demo = config.demoContext;
  const validDeclaration = demo
    && typeof demo.artifactKey === 'string' && demo.artifactKey.trim()
    && typeof demo.handlerKey === 'string' && demo.handlerKey.trim()
    && typeof demo.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(demo.token);
  if (validDeclaration && isTrustedRelativeApiRequest(config, baseURL)) {
    headers['X-Demo-Context'] = demo.token;
  } else {
    headers.delete?.('X-Demo-Context');
    headers.delete?.('x-demo-context');
    delete headers['X-Demo-Context'];
    delete headers['x-demo-context'];
  }
  delete config.demoContext;
  return config;
}

export { FALLBACK, STORAGE_KEY };
