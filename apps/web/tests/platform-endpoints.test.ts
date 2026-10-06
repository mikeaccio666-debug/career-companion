import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';

const artifact = '/api/platform/artifacts/12345678-1234-1234-1234-123456789abc';
const upload = '/api/platform/uploads/abcdef12-3456-7890-abcd-123456789abc';

test('the default routes stay relative while an explicit deployment origin routes every API and private file', () => {
  for (const setting of [undefined, '']) {
    const endpoints = createPlatformEndpoints(setting);
    assert.equal(endpoints.origin, undefined);
    assert.equal(endpoints.apiUrl('/auth/me'), '/api/platform/auth/me');
    assert.equal(endpoints.privateFileUrl(artifact), artifact);
    assert.equal(endpoints.privateFileUrl(upload, { download: true }), `${upload}?download=1`);
    assert.ok(Object.isFrozen(endpoints));
  }
  for (const origin of ['https://api.example.test', 'https://api.example.test:8443', 'http://localhost:4320', 'http://127.0.0.1:4320', 'http://[::1]:4320']) {
    const endpoints = createPlatformEndpoints(origin);
    assert.equal(endpoints.origin, origin);
    assert.equal(endpoints.apiUrl('/voice/records?conversationId=fictional'), `${origin}/api/platform/voice/records?conversationId=fictional`);
    assert.equal(endpoints.privateFileUrl(artifact), `${origin}${artifact}`);
    assert.equal(endpoints.privateFileUrl(upload, { download: true }), `${origin}${upload}?download=1`);
  }
});

test('an origin is exact and deployment-owned: reject insecure remote addresses, credentials and URL suffixes', () => {
  for (const origin of [null, 123, {}, ' ', 'https://api.example.test/', 'https://api.example.test/path', 'https://api.example.test?', 'https://api.example.test#', 'https://api.example.test?key=fictional-secret', 'https://user:fictional-secret@api.example.test', '//api.example.test', 'http://api.example.test', 'http://127.0.0.2:4320', 'http://2130706433:4320', 'http://127.1:4320', 'http://localhost.evil.test', 'ftp://127.0.0.1', 'https://*.example.test', 'https://api.example.test\n', 'HTTPS://api.example.test', 'https://api.example.test:443']) {
    assert.throws(() => createPlatformEndpoints(origin), error => error instanceof Error && /API 地址配置无效/.test(error.message) && !error.message.includes('fictional-secret'));
  }
});

test('source URLs cannot choose a host, API path, query or escaped file route even when matching the configured origin', () => {
  const endpoints = createPlatformEndpoints('https://api.example.test');
  for (const source of [undefined, null, {}, 3, '', 'https://attacker.example.test/private', `https://api.example.test${artifact}`, `//api.example.test${artifact}`, 'data:image/png;base64,AA', 'blob:https://api.example.test/fake', 'javascript:alert(1)', '/api/platform/capabilities', '/api/platform/uploads/not-a-uuid', '/api/platform/artifacts/../../auth/me', `${artifact}?download=1`, `${artifact}#fragment`, `${artifact}\n`, `${artifact}/`, artifact.replace('/artifacts/', '/%61rtifacts/'), artifact.replace('/artifacts/', '/artifacts%2f'), artifact.replace('/artifacts/', '\\artifacts\\')]) {
    assert.equal(endpoints.privateFileUrl(source), undefined, `source must not select a credential destination: ${String(source)}`);
  }
  assert.equal(endpoints.privateFileUrl(artifact), `https://api.example.test${artifact}`);
});

test('internal API suffixes cannot escape the fixed API prefix or hide traversal in encoding', () => {
  const endpoints = createPlatformEndpoints('https://api.example.test');
  for (const path of ['https://attacker.example.test', '//attacker.example.test', '/../../auth', '/auth/../me', '/auth/./me', '/auth/%2e%2e/me', '/auth/%252e%252e/me', '/auth%2fme', '/auth%5cme', '/auth\\me', '/auth#hash', '/auth\n', '/auth/%00', '/auth/%', '/auth//me']) {
    assert.throws(() => endpoints.apiUrl(path), /请求路径无效/);
  }
  assert.equal(endpoints.apiUrl('/jobs?filter=completed'), 'https://api.example.test/api/platform/jobs?filter=completed');
});
