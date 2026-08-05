import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const sourcePath = path.resolve('client/src/utils/apiBase.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { applyTrustedAuthorization, isTrustedApiBase, normalizeApiBase } = await import(moduleUrl);

for (const value of [
  'https://example.com/api',
  'https://token@example.com/api',
  'https://user:password@localhost:3002/api',
  'file:///tmp/api',
  'javascript:alert(1)',
  'http://localhost:3002/other',
  '//example.com/api'
]) assert.equal(isTrustedApiBase(value), false, `${value} must be rejected`);
for (const value of ['/api', 'http://127.0.0.1:3002/api', 'https://localhost/api', 'http://[::1]:3002/api']) {
  assert.equal(isTrustedApiBase(value), true, `${value} must be trusted`);
}
assert.equal(normalizeApiBase('https://example.com/api'), '/api');

const rejected = { url: '/auth/profile', headers: { Authorization: 'Bearer stale-token' } };
applyTrustedAuthorization(rejected, 'https://example.com/api', 'session-token');
assert.equal(rejected.headers.Authorization, undefined, 'untrusted base must not receive a bearer token');
const absoluteRemote = { url: 'https://example.com/api/auth/profile', headers: { Authorization: 'Bearer stale-token' } };
applyTrustedAuthorization(absoluteRemote, '/api', 'session-token');
assert.equal(absoluteRemote.headers.Authorization, undefined, 'absolute remote request must not receive a bearer token');
const trusted = { url: '/auth/profile', headers: {} };
applyTrustedAuthorization(trusted, 'http://127.0.0.1:3002/api', 'session-token');
assert.equal(trusted.headers.Authorization, 'Bearer session-token');

console.log('api base security tests passed');
