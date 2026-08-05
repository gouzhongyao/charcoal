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

/** Applies a bearer token only to a verified local API base. */
export function applyTrustedAuthorization(config, baseURL, token) {
  const headers = config.headers || (config.headers = {});
  const isRelativeRequest = !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(String(config.url || ''));
  if (token && isTrustedApiBase(baseURL) && isRelativeRequest) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers.delete?.('Authorization');
    headers.delete?.('authorization');
    delete headers.Authorization;
    delete headers.authorization;
  }
  return config;
}

export { FALLBACK, STORAGE_KEY };
