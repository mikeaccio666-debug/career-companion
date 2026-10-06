import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApplicationReferenceServer } from '../src/server.ts';
import type { Server } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  server = await createApplicationReferenceServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
});

test('protected legacy routes remain unavailable, including GET runtime authority', async () => {
  for (const pathname of [
    '/api/v1/ext/execution-runtime-bundle',
    '/api/v1/agent/execution-intents/claim',
    '/api/v1/agent/missions/anything/execution-intents',
    '/api/v1/agent/missions/anything/receipts',
    '/auth/extension-handoffs',
  ]) {
    const result = await fetch(`${base}${pathname}`, { method: 'POST' });
    assert.equal(result.status, 404, pathname);
  }
  assert.equal((await fetch(`${base}/api/v1/ext/execution-runtime-bundle`)).status, 404);
});

test('rules source inspection cannot activate execution', async () => {
  const result = await fetch(`${base}/api/v1/automation/rules-release`);
  assert.equal(result.status, 200);
  const reference = await result.json();
  assert.equal(reference.referenceOnly, true);
  assert.equal(reference.executionEnabled, false);
  assert.ok(reference.rules.rulesets.length >= 12);
  assert.ok(!Object.hasOwn(reference, 'policy'));
  assert.ok(!Object.hasOwn(reference, 'runtimeBundleVersion'));
  assert.ok(!Object.hasOwn(reference, 'executionIntent'));
  const etag = result.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(`${base}/api/v1/automation/rules-release`, {
    headers: { 'If-None-Match': etag },
  })).status, 304);
});

test('query input and mutating methods are rejected on reference routes', async () => {
  assert.equal((await fetch(`${base}/api/v1/automation/rules-release?enable=true`)).status, 400);
  const result = await fetch(`${base}/api/v1/automation/rules-release`, {
    method: 'POST', body: JSON.stringify({ enabled: true }),
  });
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('allow'), 'GET');
});

test('health explicitly reports the reference service boundary', async () => {
  const result = await fetch(`${base}/health`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'ok', referenceOnly: true, executionEnabled: false });
});
